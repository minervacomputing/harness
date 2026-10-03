"""Gmail connector against an in-memory Gmail API, and runs through the executor."""

import base64
import json
import time
from email import message_from_bytes
from email.policy import default as default_policy
from uuid import uuid4

import httpx
import pytest
from connector_runs import FLOW, ceiling, refusal

from connections import oauth as connection_oauth
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.gmail import mime
from connectors.gmail.client import GmailClient, Part, classify, page_token
from connectors.gmail.connector import GmailConnector
from connectors.gmail.mailbox import COMPOSE_SCOPE, MODIFY_SCOPE, READONLY_SCOPE, SEND_SCOPE
from permissions.models import Grant

SECRET = "SECRET merger"
ME, ALIAS = "me@example.org", "alias@example.org"
WORK, PROJECTS, PRIVATE = "Label_1", "Label_2", "Label_3"
GRACE, LIST, HIDDEN, ARCHIVED, MINE, DRAFT, CHAT, UNKNOWN, FROM_ALIAS = (
    "18f0000000000001",
    "18f0000000000002",
    "18f0000000000003",
    "18f0000000000004",
    "18f0000000000005",
    "18f0000000000006",
    "18f0000000000007",
    "18f0000000000008",
    "18f0000000000009",
)
THREAD = "18f00000000000a1"


def _b64(text: str, charset: str = "utf-8") -> str:
    return base64.urlsafe_b64encode(text.encode(charset)).decode().rstrip("=")


def _text(text: str, mime_type: str = "text/plain", charset: str = "utf-8") -> dict:
    data = _b64(text, charset)
    return {
        "mimeType": mime_type,
        "headers": [{"name": "Content-Type", "value": f"{mime_type}; charset={charset}"}],
        "body": {"size": len(text), "data": data},
    }


def _message(message_id: str, labels: list[str], sender: str, *, thread: str | None = None, **fields):
    headers = {
        "From": sender,
        "To": ME,
        "Subject": f"About {message_id}",
        "Date": "Wed, 30 Sep 2026 10:00:00 +0000",
        "Message-ID": f"<{message_id}@mail.example.com>",
        **fields.pop("headers", {}),
    }
    payload = fields.pop("payload", _text("Hello there"))
    pairs = headers.items() if isinstance(headers, dict) else headers
    return {
        "id": message_id,
        "threadId": thread or f"t{message_id}",
        "labelIds": labels,
        "snippet": "Hello &amp; welcome",
        "internalDate": fields.pop("internal_date", "1790000000000"),
        "payload": {
            **payload,
            "headers": [*({"name": k, "value": v} for k, v in pairs if v is not None), *payload["headers"]],
        },
        **fields,
    }


def _label(label_id: str, name: str, kind: str = "user") -> dict:
    return {"id": label_id, "name": name, "type": kind}


class FakeGmail:
    """The Gmail API v1 for one mailbox, and Google's userinfo endpoint, served through httpx.MockTransport.

    User labels: Work, Work/Projects (under Work) and Private, besides the system labels.
    """

    def __init__(self) -> None:
        system = [
            "INBOX",
            "SENT",
            "DRAFT",
            "SPAM",
            "TRASH",
            "UNREAD",
            "STARRED",
            "IMPORTANT",
            "CHAT",
            "CATEGORY_PERSONAL",
            "CATEGORY_UPDATES",
        ]
        self.labels = [
            *(_label(label_id, label_id, "system") for label_id in system),
            _label(WORK, "Work"),
            _label(PROJECTS, "work/Projects"),
            _label(PRIVATE, "Private"),
        ]
        self.messages = {
            GRACE: _message(
                GRACE, ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], "Grace <Grace@Example.com>", thread=THREAD
            ),
            LIST: _message(
                LIST,
                [PROJECTS],
                "ada@partner.org",
                headers={"Reply-To": "Ada's list <list@partner.org>", "Subject": "Re: plans"},
            ),
            HIDDEN: _message(
                HIDDEN,
                ["INBOX", PRIVATE],
                "ada@partner.org",
                thread=THREAD,
                headers={"Subject": SECRET},
                internal_date="1790000001000",
            ),
            ARCHIVED: _message(ARCHIVED, [], "grace@example.com"),
            MINE: _message(MINE, ["SENT"], ME, headers={"To": "grace@example.com"}),
            DRAFT: _message(DRAFT, ["DRAFT"], ME),
            CHAT: _message(CHAT, ["CHAT"], "grace@example.com"),
            UNKNOWN: _message(UNKNOWN, ["INBOX", "Label_99"], "grace@example.com"),
            FROM_ALIAS: _message(FROM_ALIAS, ["INBOX"], f"Me <{ALIAS.upper()}>"),
        }
        self.user = {"sub": "1234567890", "email": ME, "name": "Me"}
        self.send_as = [ME, ALIAS]
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _not_found() -> httpx.Response:
        return httpx.Response(
            404, json={"error": {"code": 404, "message": SECRET, "errors": [{"reason": "notFound"}]}}
        )

    def _view(self, message: dict, params: httpx.QueryParams) -> dict:
        form = params.get("format", "full")
        if form == "minimal":
            return {k: v for k, v in message.items() if k != "payload"}
        if form == "metadata":
            wanted = {name.lower() for name in params.get_list("metadataHeaders")}
            headers = [h for h in message["payload"]["headers"] if h["name"].lower() in wanted]
            return {**message, "payload": {"mimeType": message["payload"]["mimeType"], "headers": headers}}
        return message

    def _list(self, params: httpx.QueryParams) -> dict:
        label = params.get("labelIds")
        spam_trash = params.get("includeSpamTrash") == "true"
        found = [
            {"id": m["id"], "threadId": m["threadId"]}
            for m in self.messages.values()
            if (label is None or label in m["labelIds"])
            and (spam_trash or not {"SPAM", "TRASH"} & set(m["labelIds"]))
        ]
        size = int(params["maxResults"])
        start = int(params.get("pageToken", "p0").removeprefix("p"))
        body: dict = {"messages": found[start : start + size]}
        if start + size < len(found):
            body["nextPageToken"] = f"p{start + size}"
        return body

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json=self.user)
        path = request.url.path.removeprefix("/gmail/v1/users/me")
        params = request.url.params
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        if request.method == "POST":
            body = json.loads(request.content)
            self.writes.append((path, body))
            if path == "/messages/send":
                return httpx.Response(
                    200, json={"id": "18f00000000000f1", "threadId": body.get("threadId", "tn")}
                )
            if path == "/drafts":
                thread = body["message"].get("threadId", "tn")
                return httpx.Response(
                    200, json={"id": "r-1", "message": {"id": "18f00000000000f2", "threadId": thread}}
                )
            raise AssertionError(path)
        match path.strip("/").split("/"):
            case ["labels"]:
                return httpx.Response(200, json={"labels": self.labels})
            case ["messages"]:
                return httpx.Response(200, json=self._list(params))
            case ["messages", message_id]:
                message = self.messages.get(message_id)
                return httpx.Response(200, json=self._view(message, params)) if message else self._not_found()
            case ["threads", thread_id]:
                messages = [m for m in self.messages.values() if m["threadId"] == thread_id]
                if not messages:
                    return self._not_found()
                return httpx.Response(200, json={"id": thread_id, "messages": messages})
            case ["profile"]:
                return httpx.Response(200, json={"emailAddress": ME, "messagesTotal": 9})
            case ["settings", "sendAs"]:
                return httpx.Response(200, json={"sendAs": [{"sendAsEmail": a} for a in self.send_as]})
        raise AssertionError(path)

    def paths(self) -> list[str]:
        return [request.url.path.removeprefix("/gmail/v1/users/me") for request in self.requests]

    def sent(self, index: int = -1) -> tuple[str, dict, object]:
        """A write: its path, its body, and the raw message it carried, parsed."""
        path, body = self.writes[index]
        raw = (body.get("message") or body)["raw"]
        return path, body, message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)

    def client(self) -> GmailClient:
        return GmailClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def gmail() -> FakeGmail:
    return FakeGmail()


SCOPES = ["openid", "email", READONLY_SCOPE, SEND_SCOPE, COMPOSE_SCOPE]


@pytest.fixture
def start(connector_run, gmail, monkeypatch):
    """Starts a run for an agent with the user's Gmail connection, holding `grants` keyed by kind and id."""
    monkeypatch.setattr(GmailConnector, "client", lambda self, token: gmail.client())

    def start_(grants: dict[tuple[str, str], tuple[str, ...]], scopes: list[str] = SCOPES):
        return connector_run("gmail", grants, scopes=scopes, label=ME, external_account_id=gmail.user["sub"])

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


def label(resource: str, actions=("read",)):
    return {("label", resource): actions}


def recipient(resource: str, actions=("send",)):
    return {("recipient", resource): actions}


DRAFTS = {("account", "connection"): ("draft",)}


# MIME


def _part(mime_type: str, *parts: dict, **fields) -> Part:
    return Part.model_validate({"mimeType": mime_type, "headers": [], "parts": list(parts), **fields})


def test_plain_text_is_preferred_and_html_is_flattened():
    alternative = _part(
        "multipart/alternative",
        _text("Plain\r\nversion"),
        _text("<p>Rich <b>version</b></p>", "text/html"),
    )
    assert mime.content(alternative).text == "Plain\nversion"
    html = _text(
        '<p>Hi <a href="https://example.com/x">there</a> <a href="/rel">rel</a></p>'
        '<img src="https://tracker.example/p.gif"><script>alert(1)</script>',
        "text/html",
    )
    found = mime.content(_part("multipart/alternative", html)).text
    assert "Hi" in found and "https://example.com/x" in found
    assert "/rel" not in found and "tracker" not in found and "alert" not in found
    latin = _text("Grüße", charset="iso-8859-1")
    assert mime.content(Part.model_validate(latin)).text == "Grüße"
    unknown = {**_text("Hello"), "headers": [{"name": "Content-Type", "value": "text/plain; charset=x-nope"}]}
    assert mime.content(Part.model_validate(unknown)).text == "Hello"
    strict = {**_text("Hello"), "headers": [{"name": "Content-Type", "value": "text/plain; charset=idna"}]}
    assert mime.content(Part.model_validate(strict)).text == "Hello"


def test_attachments_are_named_never_read():
    attached = {
        "mimeType": "application/pdf",
        "filename": "Plän\r\n.pdf",
        "headers": [{"name": "Content-Disposition", "value": 'attachment; filename="plan.pdf"'}],
        "body": {"size": 10, "attachmentId": "ANGjdJ"},
    }
    forwarded = {
        "mimeType": "message/rfc822",
        "headers": [],
        "body": {"size": 20},
        "parts": [_text(SECRET)],
    }
    text_attachment = {
        **_text(SECRET),
        "filename": "notes.txt",
    }
    mixed = _part("multipart/mixed", _text("See attached"), attached, forwarded, text_attachment)
    found = mime.content(mixed)
    assert found.text == "See attached" and not found.unavailable
    assert SECRET not in found.text
    assert found.attachments == [
        {"filename": "Plän .pdf", "mime_type": "application/pdf", "size": 10},
        {"filename": None, "mime_type": "message/rfc822", "size": 20},
        {"filename": "notes.txt", "mime_type": "text/plain", "size": len(SECRET)},
    ]


def test_attached_multiparts_and_related_resources_are_not_read():
    attached = {
        "mimeType": "multipart/mixed",
        "headers": [{"name": "Content-Disposition", "value": "attachment"}],
        "parts": [_text(SECRET)],
    }
    found = mime.content(_part("multipart/mixed", _text("Body"), attached))
    assert found.text == "Body"
    assert found.attachments == [{"filename": None, "mime_type": "multipart/mixed", "size": None}]
    resource = {**_text(SECRET), "headers": [{"name": "Content-ID", "value": "<res@x>"}]}
    root = {**_text("<p>Root</p>", "text/html"), "headers": [{"name": "Content-ID", "value": "<root@x>"}]}
    started = {"name": "Content-Type", "value": 'multipart/related; start="<root@x>"'}
    assert mime.content(_part("multipart/related", resource, root, headers=[started])).text == "Root"
    assert mime.content(_part("multipart/related", root, resource)).text == "Root"


def test_bodies_gmail_keeps_apart_or_cannot_decode_are_unavailable():
    apart = Part.model_validate({"mimeType": "text/plain", "body": {"size": 900_000, "attachmentId": "A1"}})
    found = mime.content(_part("multipart/mixed", _text("Start"), apart.model_dump(by_alias=True)))
    assert found.text == "Start" and found.unavailable
    broken = Part.model_validate({"mimeType": "text/plain", "body": {"size": 4, "data": "!!!!"}})
    assert mime.content(broken).unavailable
    empty = Part.model_validate({"mimeType": "text/plain", "body": {"size": 0}})
    found = mime.content(empty)
    assert found.text == "" and not found.unavailable
    nested = _text("deep")
    for _ in range(12):
        nested = {"mimeType": "multipart/mixed", "headers": [], "parts": [nested]}
    found = mime.content(Part.model_validate(nested))
    assert found.text == "" and found.unavailable
    many = _part("multipart/mixed", *[_text("x") for _ in range(250)])
    assert mime.content(many).unavailable


@pytest.mark.parametrize(
    ("values", "found"),
    [
        (["Grace <Grace@Example.com>"], ["grace@example.com"]),
        (["a@example.com, B <b@example.com>, a@example.com"], ["a@example.com", "b@example.com"]),
        (['"a@b.com" <evil@x.com>'], ["evil@x.com"]),
        (["=?utf-8?q?Gr=C3=A4ce?= <grace@example.com>"], ["grace@example.com"]),
        (["Team: a@example.com, b@example.com;"], ["a@example.com", "b@example.com"]),
        ([], None),
        (["a@example.com", "b@example.com"], None),
        (["a@b.com <c@d.com>"], None),
        (["Grace <grace@example.com"], None),
        (["undisclosed-recipients:;"], None),
        (["grace@localhost"], None),
        (["grace"], None),
        (["a@example.com, bad"], None),
        (["<>"], None),
    ],
)
def test_reply_addresses_are_read_strictly(values, found):
    assert mime.mailboxes(values) == found


def test_replies_thread_by_well_formed_ids():
    references = ["<a@x> junk <b@x> <orig@x>"]
    assert mime.threading(["<orig@x>"], references) == ("<orig@x>", "<a@x> <b@x> <orig@x>")
    assert mime.threading([" <orig@x> "], []) == ("<orig@x>", "<orig@x>")
    long = [" ".join(f"<r{n}@x>" for n in range(30))]
    _, chain = mime.threading(["<orig@x>"], long)
    assert chain.split() == [*(f"<r{n}@x>" for n in range(11, 30)), "<orig@x>"]
    assert mime.threading(["<orig@x>"], references * 2) == ("<orig@x>", "<orig@x>")
    assert mime.threading(["<orig@x>"], ["<a> <b@x>"]) == ("<orig@x>", "<b@x> <orig@x>")
    for ids in (
        [],
        ["<a@x>", "<b@x>"],
        ["orig@x"],
        ["<a b@x>"],
        ["<a@x>\r\nBcc: e@x"],
        ["<orig>"],
        ["<a@b@x>"],
    ):
        assert mime.threading(ids, references) is None
    assert mime.reply_subject("Plans") == "Re: Plans"
    assert mime.reply_subject("RE: Plans") == "RE: Plans"
    assert mime.reply_subject(None) == "Re: "
    assert mime.reply_subject("a\r\nBcc: e@x") == "Re: a Bcc: e@x"


def test_raw_messages_have_no_sender_and_keep_bcc():
    raw = mime.raw(
        to=["grace@example.com"],
        bcc=["ada@partner.org"],
        subject="Grüße",
        body="Line one\nLíne two",
        in_reply_to=("<orig@x>", "<a@x> <orig@x>"),
    )
    parsed = message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)
    assert parsed["From"] is None
    assert (parsed["To"], parsed["Bcc"], parsed["Subject"]) == (
        "grace@example.com",
        "ada@partner.org",
        "Grüße",
    )
    assert (parsed["In-Reply-To"], parsed["References"]) == ("<orig@x>", "<a@x> <orig@x>")
    assert parsed.get_content_type() == "text/plain"
    assert parsed["Content-Transfer-Encoding"] == "quoted-printable"
    assert parsed.get_content() == "Line one\r\nLíne two\r\n"


# Gmail


def test_page_tokens_and_errors():
    assert page_token(None) is None
    assert page_token("CAEQAA-_x") == "CAEQAA-_x"
    for token in ("a b", "a/b", "", "a" * 201, 42):
        with pytest.raises(OperationError) as refused:
            page_token(token)
        assert refused.value.code == "PROVIDER_LIMIT"
    precondition = {"error": {"code": 400, "message": SECRET, "errors": [{"reason": "failedPrecondition"}]}}
    assert classify("Gmail", httpx.Response(400, json=precondition)).code == "UNSUPPORTED_ACCOUNT"
    assert classify("Gmail", httpx.Response(400, json={"error": {"errors": [{"reason": "invalid"}]}})) is None
    assert classify("Gmail", httpx.Response(400, content=b"<html>")) is None


# Connecting


async def test_account_discovery_and_names(gmail):
    connector = GmailConnector()
    account = await connector.account(gmail.client())
    assert (account.id, account.label) == ("1234567890", ME)
    found = await connector.discover(gmail.client(), "label", query=None, cursor=None)
    assert [(item.id, item.name) for item in found.items] == [
        ("INBOX", "Inbox"),
        ("SENT", "Sent"),
        ("DRAFT", "Drafts"),
        ("SPAM", "Spam"),
        ("TRASH", "Trash"),
        ("CATEGORY_PERSONAL", "Category: Primary"),
        ("CATEGORY_UPDATES", "Category: Updates"),
        (WORK, "Work"),
        (PROJECTS, "work/Projects"),
        (PRIVATE, "Private"),
    ]
    found = await connector.discover(gmail.client(), "label", query="PROJ", cursor=None)
    assert [item.id for item in found.items] == [PROJECTS]
    found = await connector.discover(gmail.client(), "recipient", query="Ada@Partner.org", cursor=None)
    assert [(item.id, item.name) for item in found.items] == [
        ("ada@partner.org", "ada@partner.org"),
        ("*@partner.org", "Everyone at partner.org"),
    ]
    names = await connector.describe(
        gmail.client(), "label", [PROJECTS, "INBOX", "UNREAD", "CHAT", "Label_99", "inbox", "*"]
    )
    assert names == {PROJECTS: "work/Projects", "INBOX": "Inbox"}
    names = await connector.describe(gmail.client(), "recipient", ["*@partner.org", "Ada@x.com"])
    assert names == {"*@partner.org": "Everyone at partner.org"}


def test_gmail_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("gmail")
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    base = ["openid", "email", READONLY_SCOPE]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    assert connection_oauth.requested_scopes(connector, {"read", "send"}) == [*base, SEND_SCOPE]
    assert connection_oauth.requested_scopes(connector, {"draft"}) == [*base, COMPOSE_SCOPE]
    requested = connection_oauth.requested_scopes(connector, {"read", "send", "draft"})
    assert requested == [*base, COMPOSE_SCOPE, SEND_SCOPE]
    url = connection_oauth.authorization_url({}, workspace_id=uuid4(), provider="gmail", scopes=requested)
    params = httpx.URL(url).params
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert params["scope"] == " ".join(requested)
    assert params["include_granted_scopes"] == "true" and params["access_type"] == "offline"
    needed = connection_oauth.consent_needed
    granted = frozenset({"openid", "email", READONLY_SCOPE})
    assert needed(connector, granted, {"read", "send", "draft"}) == ["send", "draft"]
    assert needed(connector, granted | {SEND_SCOPE}, {"read", "send", "draft"}) == ["draft"]
    # Compose also sends; modify and full access cover everything.
    assert needed(connector, granted | {COMPOSE_SCOPE}, {"read", "send", "draft"}) == []
    assert needed(connector, frozenset({MODIFY_SCOPE}), {"read", "send", "draft"}) == []
    assert needed(connector, frozenset({"https://mail.google.com/"}), {"read", "send", "draft"}) == []
    assert needed(connector, frozenset({SEND_SCOPE}), {"read"}) == ["read"]


def test_gmail_tokens_carry_their_scopes(token_endpoint):
    sent, responses = token_endpoint
    scope = f"openid {READONLY_SCOPE} https://www.googleapis.com/auth/userinfo.email"
    responses.append(
        httpx.Response(
            200,
            json={
                "access_token": "a",
                "refresh_token": "r",
                "expires_in": 3599,
                "token_type": "Bearer",
                "scope": scope,
            },
        )
    )
    tokens = connection_oauth.exchange_code(registry.get("gmail"), code="c", flow=FLOW)
    assert READONLY_SCOPE in tokens["scopes"]
    assert tokens["expires_at"] > time.time()
    [request] = sent
    assert request["url"] == "https://oauth2.googleapis.com/token"


# Reading


@pytest.mark.django_db(transaction=True)
async def test_labels_nest_by_name_and_only_readable_ones_are_listed(start, gmail):
    executor = await start(label("*"))
    listed = {item["id"]: item for item in _items(await executor.invoke("gmail_list_labels", {}))}
    assert set(listed) == {
        "INBOX",
        "SENT",
        "DRAFT",
        "SPAM",
        "TRASH",
        "CATEGORY_PERSONAL",
        "CATEGORY_UPDATES",
        WORK,
        PROJECTS,
        PRIVATE,
    }
    # Below its parent, so that a label never names a parent the agent may not read.
    assert listed[PROJECTS] == {"id": PROJECTS, "name": "Projects", "type": "user", "parent_id": WORK}
    assert listed["INBOX"] == {"id": "INBOX", "name": "Inbox", "type": "system", "parent_id": None}

    executor = await start(label(WORK))
    assert _ids(await executor.invoke("gmail_list_labels", {})) == [WORK, PROJECTS]
    # A grant on a parent covers the mail under its children.
    assert _ids(await executor.invoke("gmail_list_messages", {"label": PROJECTS})) == [LIST]
    for name in ("INBOX", "inbox", PRIVATE, "UNREAD", "CHAT", "Label_99", "Work"):
        assert await refusal(executor, "gmail_list_messages", {"label": name}) == "POLICY_DENIED"
    for name in ("../x", "a b", "Work/Projects"):
        assert await refusal(executor, "gmail_list_messages", {"label": name}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_message_is_read_through_any_label_and_hidden_by_any_deny(start, gmail):
    executor = await start(label("INBOX"))
    assert _ids(await executor.invoke("gmail_list_messages", {"label": "INBOX"})) == [
        GRACE,
        HIDDEN,
        UNKNOWN,
        FROM_ALIAS,
    ]
    [read] = _items(await executor.invoke("gmail_read_message", {"message": GRACE}))
    assert read["from"] == "Grace <Grace@Example.com>" and read["body"] == "Hello there"
    assert read["snippet"] == "Hello & welcome" and read["unread"] is True
    assert read["label_ids"] == ["INBOX", "UNREAD", "CATEGORY_PERSONAL"]

    await ceiling("gmail", "label", PRIVATE, Grant.Effect.DENY)
    executor = await start(label("INBOX"))
    # Hidden by the deny on Private; a message with a label Minerva does not know hides behind any deny.
    assert _ids(await executor.invoke("gmail_list_messages", {"label": "INBOX"})) == [GRACE, FROM_ALIAS]
    for message in (HIDDEN, UNKNOWN):
        assert await refusal(executor, "gmail_read_message", {"message": message}) == "POLICY_DENIED"
    found = _items(await executor.invoke("gmail_read_thread", {"thread": THREAD}))
    assert [item["id"] for item in found] == [GRACE]
    assert SECRET not in json.dumps(found)


@pytest.mark.django_db(transaction=True)
async def test_archived_mail_needs_every_label_and_chats_are_refused(start, gmail):
    executor = await start({**label("INBOX"), **label(PROJECTS)})
    for message in (ARCHIVED, MINE, CHAT, "18f00000000000ff"):
        assert await refusal(executor, "gmail_read_message", {"message": message}) == "POLICY_DENIED"
    for message in ("../labels", "a b", "x" * 65):
        assert await refusal(executor, "gmail_read_message", {"message": message}) == "INVALID_ARGUMENTS"
    # Nothing but labels was asked for the refused messages.
    assert not any(request.url.params.get("format") == "full" for request in gmail.requests)

    executor = await start(label("*"))
    [read] = _items(await executor.invoke("gmail_read_message", {"message": ARCHIVED}))
    assert read["id"] == ARCHIVED
    assert await refusal(executor, "gmail_read_message", {"message": CHAT}) == "POLICY_DENIED"
    assert CHAT not in _ids(await executor.invoke("gmail_list_messages", {}))


@pytest.mark.django_db(transaction=True)
async def test_spam_and_trash_are_listed_only_on_their_own(start, gmail):
    gmail.messages[GRACE]["labelIds"] = ["SPAM"]
    executor = await start(label("*"))
    assert GRACE not in _ids(await executor.invoke("gmail_list_messages", {"query": "from:grace"}))
    assert _ids(await executor.invoke("gmail_list_messages", {"label": "spam"})) == [GRACE]
    listed, spam = [r for r in gmail.requests if r.url.path.endswith("/messages")]
    assert spam.url.params["includeSpamTrash"] == "true" and spam.url.params["labelIds"] == "SPAM"
    assert listed.url.params["q"] == "from:grace" and "labelIds" not in listed.url.params
    assert await refusal(executor, "gmail_list_messages", {"query": "a\nb"}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_message_lists_page_with_run_bound_cursors(start, gmail):
    executor = await start(label("INBOX"))
    first = await executor.invoke("gmail_list_messages", {"label": "INBOX", "limit": 3})
    assert _ids(first) == [GRACE, HIDDEN, UNKNOWN]
    cursor = first.result["next_cursor"]
    assert cursor != "p3"
    second = await executor.invoke("gmail_list_messages", {"label": "INBOX", "limit": 3, "cursor": cursor})
    assert _ids(second) == [FROM_ALIAS] and "next_cursor" not in second.result
    assert [r.url.params.get("pageToken") for r in gmail.requests if r.url.path.endswith("/messages")] == [
        None,
        "p3",
    ]
    args = {"label": "INBOX", "limit": 2, "cursor": cursor}
    assert await refusal(executor, "gmail_list_messages", args) == "INVALID_CURSOR"


@pytest.mark.django_db(transaction=True)
async def test_a_label_renamed_after_authorization_is_refused(start, gmail):
    executor = await start(label(WORK))
    calls = []

    def rename(method, path, params):
        if path == "/labels":
            calls.append(path)
            if len(calls) == 2:
                gmail.labels[-2]["name"] = "Elsewhere/Projects"
        return None

    gmail.hook = rename
    assert await refusal(executor, "gmail_list_messages", {"label": PROJECTS}) == "MAIL_MOVED"


@pytest.mark.django_db(transaction=True)
async def test_a_label_renamed_while_mail_is_fetched_is_seen(start, gmail):
    # Labels are fetched after the mail they place, so a rename during the fetch is never missed.
    executor = await start(label(WORK))

    def rename(method, path, params):
        if path.startswith(("/messages/", "/threads/")) and params.get("format") != "minimal":
            gmail.labels[-2]["name"] = "Elsewhere/Projects"
        return None

    gmail.hook = rename
    assert await refusal(executor, "gmail_read_message", {"message": LIST}) == "MAIL_MOVED"
    gmail.labels[-2]["name"] = "work/Projects"
    assert _ids(await executor.invoke("gmail_read_thread", {"thread": f"t{LIST}"})) == []


@pytest.mark.django_db(transaction=True)
async def test_a_message_relabelled_after_authorization_is_refused(start, gmail):
    executor = await start(label("INBOX"))

    def relabel(method, path, params):
        if params.get("format") == "full":
            gmail.messages[GRACE]["labelIds"] = ["INBOX", PRIVATE]
        return None

    gmail.hook = relabel
    assert await refusal(executor, "gmail_read_message", {"message": GRACE}) == "MAIL_MOVED"


@pytest.mark.django_db(transaction=True)
async def test_messages_with_too_many_labels_are_refused(start, gmail):
    many = [f"Label_{n}" for n in range(100, 166)]
    gmail.labels += [_label(label_id, f"Many {label_id}") for label_id in many]
    gmail.messages[GRACE]["labelIds"] = many
    executor = await start(label("*"))
    assert await refusal(executor, "gmail_read_message", {"message": GRACE}) == "POLICY_DENIED"
    assert GRACE not in _ids(await executor.invoke("gmail_list_messages", {}))


@pytest.mark.django_db(transaction=True)
async def test_long_messages_are_read_in_slices(start, gmail):
    body = "".join(f"{n:04d} " for n in range(400))
    gmail.messages[GRACE]["payload"] = {**_text(body), "headers": gmail.messages[GRACE]["payload"]["headers"]}
    executor = await start(label("INBOX"))
    [first] = _items(await executor.invoke("gmail_read_message", {"message": GRACE, "max_chars": 1000}))
    assert first["body"] == body.strip()[:1000] and first["next_offset"] == 1000
    assert first["total_chars"] == len(body.strip())
    args = {"message": GRACE, "max_chars": 1000, "offset": 1000}
    [second] = _items(await executor.invoke("gmail_read_message", args))
    assert second["body"] == body.strip()[1000:2000]
    [item, _] = _items(
        await executor.invoke("gmail_read_thread", {"thread": THREAD, "max_chars_per_message": 200})
    )
    assert item["id"] == GRACE and item["body_truncated"] is True and len(item["body"]) == 200


@pytest.mark.django_db(transaction=True)
async def test_threads_that_do_not_exist_read_as_empty(start, gmail):
    executor = await start(label("*"))
    assert _items(await executor.invoke("gmail_read_thread", {"thread": "18f00000000000ee"})) == []
    found = _items(await executor.invoke("gmail_read_thread", {"thread": THREAD}))
    assert [item["id"] for item in found] == [GRACE, HIDDEN]


@pytest.mark.django_db(transaction=True)
async def test_an_account_without_gmail_is_named(start, gmail):
    executor = await start(label("*"))
    precondition = {"error": {"code": 400, "message": SECRET, "errors": [{"reason": "failedPrecondition"}]}}
    gmail.hook = lambda method, path, params: httpx.Response(400, json=precondition)
    assert await refusal(executor, "gmail_list_labels", {}) == "UNSUPPORTED_ACCOUNT"
    assert await refusal(executor, "gmail_read_message", {"message": GRACE}) == "UNSUPPORTED_ACCOUNT"


# Sending


@pytest.mark.django_db(transaction=True)
async def test_sending_needs_every_recipient(start, gmail):
    executor = await start({**recipient("*@example.com"), **recipient("ada@partner.org")})
    args = {
        "to": ["Grace@Example.com"],
        "cc": ["ada@partner.org"],
        "bcc": ["bob@example.com"],
        "subject": "Plans",
        "body": "Hi Grace\n\tthanks",
    }
    [sent] = _items(await executor.invoke("gmail_send_message", args))
    assert sent == {
        "sent": True,
        "id": "18f00000000000f1",
        "thread_id": "tn",
        "to": ["grace@example.com"],
        "cc": ["ada@partner.org"],
        "bcc": ["bob@example.com"],
        "subject": "Plans",
    }
    path, body, raw = gmail.sent()
    assert path == "/messages/send" and "threadId" not in body
    assert (raw["To"], raw["Cc"], raw["Bcc"], raw["From"]) == (
        "grace@example.com",
        "ada@partner.org",
        "bob@example.com",
        None,
    )
    assert raw.get_content() == "Hi Grace\r\n\tthanks\r\n"

    send = {"to": ["grace@example.com"], "subject": "x", "body": "x"}
    for change in (
        {"bcc": ["bob@partner.org"]},
        {"cc": ["grace@mail.example.com"]},
        {"to": ["grace@example.com.evil.org"]},
    ):
        assert await refusal(executor, "gmail_send_message", {**send, **change}) == "POLICY_DENIED"
    for change in (
        {"cc": ["Grace@example.com"]},
        {"to": []},
        {"to": ["Grace <grace@example.com>"]},
        {"to": [f"p{n}@example.com" for n in range(6)], "cc": [f"q{n}@example.com" for n in range(5)]},
        {"subject": "a\r\nBcc: x@evil.org"},
        {"body": "bell\x07"},
        {"from": "ceo@example.com"},
    ):
        assert await refusal(executor, "gmail_send_message", {**send, **change}) == "INVALID_ARGUMENTS"
    assert len(gmail.writes) == 1

    executor = await start(recipient("*@example.com"), scopes=["openid", "email", READONLY_SCOPE])
    # Without Google's consent to sending, the tool is not offered.
    assert await refusal(executor, "gmail_send_message", send) == "UNKNOWN_OPERATION"
    assert len(gmail.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_replies_go_to_exactly_the_authorized_addresses_in_the_thread(start, gmail):
    gmail.messages[GRACE]["payload"]["headers"].append(
        {"name": "References", "value": "<first@mail.example.com>"}
    )
    executor = await start({**label("INBOX"), **recipient("grace@example.com")})
    [replied] = _items(await executor.invoke("gmail_reply", {"message": GRACE, "body": "Thanks"}))
    assert replied == {
        "replied": True,
        "id": "18f00000000000f1",
        "thread_id": THREAD,
        "to": ["grace@example.com"],
    }
    path, body, raw = gmail.sent()
    assert path == "/messages/send" and body["threadId"] == THREAD
    assert (raw["To"], raw["Cc"], raw["Bcc"]) == ("grace@example.com", None, None)
    assert raw["Subject"] == f"Re: About {GRACE}"
    assert raw["In-Reply-To"] == f"<{GRACE}@mail.example.com>"
    assert raw["References"] == f"<first@mail.example.com> <{GRACE}@mail.example.com>"
    # The reply was read with only the headers it needs.
    assert {r.url.params["format"] for r in gmail.requests if r.url.path.endswith(GRACE)} == {"metadata"}

    # Replies go to Reply-To, not the sender.
    executor = await start({**label(WORK), **recipient("ada@partner.org")})
    assert await refusal(executor, "gmail_reply", {"message": LIST, "body": "x"}) == "POLICY_DENIED"
    executor = await start({**label(WORK), **recipient("*@partner.org")})
    [replied] = _items(await executor.invoke("gmail_reply", {"message": LIST, "body": "x"}))
    assert replied["to"] == ["list@partner.org"]
    assert gmail.sent()[2]["Subject"] == "Re: plans"

    # Read on the original and Send on each address are both needed.
    executor = await start({**label("INBOX"), **recipient("*@partner.org")})
    assert await refusal(executor, "gmail_reply", {"message": LIST, "body": "x"}) == "POLICY_DENIED"
    executor = await start(label(WORK))
    assert await refusal(executor, "gmail_reply", {"message": LIST, "body": "x"}) == "UNKNOWN_OPERATION"
    assert len(gmail.writes) == 2


@pytest.mark.django_db(transaction=True)
async def test_no_replies_to_own_mail_drafts_or_unreadable_headers(start, gmail):
    executor = await start({**label("*"), **recipient("*@example.org"), **recipient("grace@example.com")})
    for message in (MINE, DRAFT, FROM_ALIAS):
        assert (
            await refusal(executor, "gmail_reply", {"message": message, "body": "x"}) == "UNSUPPORTED_MESSAGE"
        )
    # Sent by the account on someone's behalf.
    gmail.messages[ARCHIVED]["payload"]["headers"].append({"name": "Sender", "value": ME})
    assert await refusal(executor, "gmail_reply", {"message": ARCHIVED, "body": "x"}) == "UNSUPPORTED_MESSAGE"

    # A From that appears twice is never guessed at; only a grant on every recipient gets that far.
    gmail.messages[UNKNOWN]["payload"]["headers"].append({"name": "From", "value": "grace@example.com"})
    assert await refusal(executor, "gmail_reply", {"message": UNKNOWN, "body": "x"}) == "POLICY_DENIED"
    executor = await start({**label("*"), **recipient("*")})
    code = await refusal(executor, "gmail_reply", {"message": UNKNOWN, "body": "x"})
    assert code == "UNSUPPORTED_RECIPIENT"
    assert gmail.writes == []


@pytest.mark.django_db(transaction=True)
async def test_a_reply_address_changed_after_authorization_is_refused(start, gmail):
    executor = await start({**label("INBOX"), **recipient("*@example.com")})
    fetched = []

    def redirect(method, path, params):
        if path == f"/messages/{GRACE}":
            fetched.append(path)
            if len(fetched) == 2:
                gmail.messages[GRACE]["payload"]["headers"].append(
                    {"name": "Reply-To", "value": "x@example.com"}
                )
        return None

    gmail.hook = redirect
    assert await refusal(executor, "gmail_reply", {"message": GRACE, "body": "x"}) == "MESSAGE_CHANGED"
    assert gmail.writes == []


@pytest.mark.django_db(transaction=True)
async def test_drafts_need_only_the_account(start, gmail):
    executor = await start(DRAFTS)
    args = {"to": ["anyone@elsewhere.net"], "bcc": ["ada@partner.org"], "subject": "Plans", "body": "Draft"}
    [drafted] = _items(await executor.invoke("gmail_create_draft", args))
    assert drafted["draft_id"] == "r-1" and drafted["to"] == ["anyone@elsewhere.net"]
    path, body, raw = gmail.sent()
    assert path == "/drafts" and "threadId" not in body["message"]
    assert (raw["To"], raw["Bcc"]) == ("anyone@elsewhere.net", "ada@partner.org")
    assert await refusal(executor, "gmail_send_message", args) == "UNKNOWN_OPERATION"
    # A reply draft also reads the original.
    executor = await start({**DRAFTS, **label(WORK)})
    assert (
        await refusal(executor, "gmail_create_reply_draft", {"message": GRACE, "body": "x"})
        == "POLICY_DENIED"
    )

    executor = await start({**DRAFTS, **label("INBOX")})
    [drafted] = _items(await executor.invoke("gmail_create_reply_draft", {"message": GRACE, "body": "Sure"}))
    assert drafted == {
        "draft_id": "r-1",
        "id": "18f00000000000f2",
        "thread_id": THREAD,
        "in_reply_to": GRACE,
        "to": ["grace@example.com"],
    }
    path, body, raw = gmail.sent()
    assert path == "/drafts" and body["message"]["threadId"] == THREAD
    assert raw["To"] == "grace@example.com" and raw["In-Reply-To"] == f"<{GRACE}@mail.example.com>"
    assert (
        await refusal(executor, "gmail_create_reply_draft", {"message": MINE, "body": "x"}) == "POLICY_DENIED"
    )
    executor = await start({**DRAFTS, **label("SENT")})
    code = await refusal(executor, "gmail_create_reply_draft", {"message": MINE, "body": "x"})
    assert code == "UNSUPPORTED_MESSAGE"

    executor = await start(DRAFTS, scopes=["openid", "email", READONLY_SCOPE, SEND_SCOPE])
    assert await refusal(executor, "gmail_create_draft", {**args, "body": "y"}) == "UNKNOWN_OPERATION"
    assert len(gmail.writes) == 2
