"""Outlook connector against an in-memory Microsoft Graph, and runs through the executor."""

import json
import time
from uuid import uuid4

import httpx
import pytest
from connector_runs import FLOW, ceiling, refusal

from connections import credentials as connection_credentials
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.outlook import addresses
from connectors.outlook.client import GraphClient, classify, next_cursor, page_param
from connectors.outlook.connector import OutlookConnector
from permissions.models import Grant

SECRET = "SECRET merger"
ROOT, INBOX, PROJECTS, PRIVATE, SENT, DRAFTS = (
    "ROOTFOLDER00",
    "INBOXFOLDER0",
    "PROJECTS0000",
    "PRIVATEFOLD0",
    "SENTFOLDER00",
    "DRAFTSFOLD00",
)
# A search folder hangs off a hidden root, outside the tree of folders under msgfolderroot.
HIDDEN_ROOT, SEARCH = "HIDDENROOT00", "SEARCHFOLD00"
WELL_KNOWN = {"msgfolderroot": ROOT, "inbox": INBOX, "sentitems": SENT, "drafts": DRAFTS}
FROM_GRACE, FROM_LIST, FROM_PRIVATE, FROM_ME, DRAFT, LEGACY = (
    "MSGGRACE0001",
    "MSGLIST00001",
    "MSGPRIVATE01",
    "MSGSENT00001",
    "MSGDRAFT0001",
    "MSGLEGACY001",
)


def _folder(folder_id: str, name: str, parent: str | None) -> dict:
    return {
        "id": folder_id,
        "displayName": name,
        "parentFolderId": parent,
        "childFolderCount": 0,
        "unreadItemCount": 1,
        "totalItemCount": 2,
    }


def _person(address: str, name: str | None = None) -> dict:
    return {"emailAddress": {"name": name or address, "address": address}}


def _message(message_id: str, folder: str, sender: str, **fields) -> dict:
    return {
        "id": message_id,
        "conversationId": f"conv-{message_id}",
        "parentFolderId": folder,
        "subject": f"About {message_id}",
        "from": _person(sender),
        "toRecipients": [_person("me@contoso.com")],
        "ccRecipients": [],
        "bccRecipients": [],
        "replyTo": [],
        "receivedDateTime": "2026-09-30T10:00:00Z",
        "sentDateTime": "2026-09-30T09:59:00Z",
        "isRead": False,
        "isDraft": False,
        "hasAttachments": False,
        "importance": "normal",
        "bodyPreview": "Hello",
        "categories": [],
        "body": {"contentType": "text", "content": "Hello there"},
        **fields,
    }


class FakeGraph:
    """Microsoft Graph's mail API, served through httpx.MockTransport.

    Folders: Inbox (with Projects and Private under it), Sent Items and Drafts, under msgfolderroot; and a
    search folder outside that tree, which collects the mail in Private.
    """

    def __init__(self) -> None:
        self.folders = {
            ROOT: _folder(ROOT, "Top of Information Store", HIDDEN_ROOT),
            HIDDEN_ROOT: _folder(HIDDEN_ROOT, "Root", None),
            INBOX: {**_folder(INBOX, "Inbox", ROOT), "childFolderCount": 2},
            PROJECTS: _folder(PROJECTS, "Projects", INBOX),
            PRIVATE: _folder(PRIVATE, "Private", INBOX),
            SENT: _folder(SENT, "Sent Items", ROOT),
            DRAFTS: _folder(DRAFTS, "Drafts", ROOT),
            SEARCH: _folder(SEARCH, "Everything private", HIDDEN_ROOT),
        }
        self.messages = {
            FROM_GRACE: _message(FROM_GRACE, INBOX, "Grace@Example.com", hasAttachments=True),
            FROM_LIST: _message(
                FROM_LIST, PROJECTS, "ada@partner.org", replyTo=[_person("list@partner.org")]
            ),
            FROM_PRIVATE: _message(FROM_PRIVATE, PRIVATE, "ada@partner.org", subject=SECRET),
            FROM_ME: _message(FROM_ME, SENT, "me@contoso.com", toRecipients=[_person("grace@example.com")]),
            DRAFT: _message(DRAFT, DRAFTS, "grace@example.com", isDraft=True),
            LEGACY: _message(LEGACY, INBOX, "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=ADA"),
        }
        self.user = {
            "id": "00000000-0000-0000-0000-00000000a0a0",
            "displayName": "Me",
            "mail": "me@contoso.com",
            "userPrincipalName": "me@contoso.onmicrosoft.com",
        }
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _not_found() -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "ErrorItemNotFound", "message": SECRET}})

    def _page(self, path: str, items: list, params: dict) -> dict:
        top = int(params.get("$top", 10))
        start = int(params.get("$skip", 0))
        if "$skiptoken" in params:
            start = int(params["$skiptoken"].removeprefix("p"))
        body: dict = {"value": items[start : start + top]}
        if start + top < len(items):
            body["@odata.nextLink"] = f"https://graph.microsoft.com/v1.0{path}?$skiptoken=p{start + top}"
        return body

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/v1.0")
        params = dict(request.url.params)
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        parts = path.strip("/").split("/")
        if request.method == "POST":
            self.writes.append((path, json.loads(request.content)))
            if path == "/me/sendMail" or (parts[:2] == ["me", "messages"] and parts[3:] == ["reply"]):
                return httpx.Response(202)
            raise AssertionError(path)
        match parts:
            case ["me"]:
                return httpx.Response(200, json=self.user)
            case ["me", "mailFolders"]:
                top = [f for f in self.folders.values() if f["parentFolderId"] == ROOT]
                return httpx.Response(200, json=self._page(path, top, params))
            case ["me", "mailFolders", name]:
                folder = self.folders.get(WELL_KNOWN.get(name.lower(), name))
                return httpx.Response(200, json=folder) if folder else self._not_found()
            case ["me", "mailFolders", folder_id, "childFolders"]:
                if folder_id not in self.folders:
                    return self._not_found()
                children = [f for f in self.folders.values() if f["parentFolderId"] == folder_id]
                return httpx.Response(200, json=self._page(path, children, params))
            case ["me", "mailFolders", folder_id, "messages"]:
                if folder_id not in self.folders:
                    return self._not_found()
                source = PRIVATE if folder_id == SEARCH else folder_id
                found = [m for m in self.messages.values() if m["parentFolderId"] == source]
                return httpx.Response(200, json=self._page(path, found, params))
            case ["me", "messages", message_id]:
                message = self.messages.get(message_id)
                return httpx.Response(200, json=message) if message else self._not_found()
            case ["me", "messages", message_id, "attachments"]:
                attachment = {
                    "id": "ATT1",
                    "name": "plan.pdf",
                    "contentType": "application/pdf",
                    "size": 10,
                    "isInline": False,
                    "contentBytes": "U0VDUkVU",
                }
                return httpx.Response(200, json={"value": [attachment]})
        raise AssertionError(path)

    def paths(self) -> list[str]:
        return [request.url.path.removeprefix("/v1.0") for request in self.requests]

    def client(self) -> GraphClient:
        return GraphClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


SCOPES = ["Mail.Read", "Mail.Send", "User.Read", "email", "openid", "profile"]


@pytest.fixture
def start(connector_run, graph, monkeypatch):
    """Starts a run for an agent with the user's Outlook connection, holding `grants` keyed by kind and id."""
    monkeypatch.setattr(OutlookConnector, "client", lambda self, token: graph.client())

    def start_(grants: dict[tuple[str, str], tuple[str, ...]], scopes: list[str] = SCOPES):
        return connector_run(
            "outlook", grants, scopes=scopes, label="me@contoso.com", external_account_id=graph.user["id"]
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


def folder(resource: str, actions=("read",)):
    return {("folder", resource): actions}


def recipient(resource: str, actions=("send",)):
    return {("recipient", resource): actions}


# Addresses


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        ("Ada@Example.COM", "ada@example.com"),
        (" ada.lovelace+notes@mail.example.com ", "ada.lovelace+notes@mail.example.com"),
        ("o'brien@bücher.de", "o'brien@xn--bcher-kva.de"),
    ],
)
def test_addresses_are_canonical(raw, canonical):
    assert addresses.parse(raw) == canonical
    assert addresses.valid_id(canonical)


@pytest.mark.parametrize(
    "raw",
    [
        "ada",
        "ada@",
        "@example.com",
        "ada@@example.com",
        "a@b@example.com",
        '"ada"@example.com',
        "ada lovelace@example.com",
        ".ada@example.com",
        "ada.@example.com",
        "a..b@example.com",
        "ada@localhost",
        "ada@127.0.0.1",
        "ada@co.uk",
        "ada@com",
        "Ada <ada@example.com>",
        "ädä@example.com",
        "ada@exa\nmple.com",
        "a" * 65 + "@example.com",
    ],
)
def test_odd_addresses_are_refused(raw):
    with pytest.raises(OperationError) as refused:
        addresses.parse(raw)
    assert refused.value.code == "INVALID_ADDRESS"


def test_address_patterns_cover_one_domain():
    assert addresses.ancestors("ada@mail.example.com") == ("*@mail.example.com",)
    assert addresses.choices("Ada@Example.com") == ["ada@example.com", "*@example.com"]
    assert addresses.choices("example.com") == addresses.choices("@example.com") == ["*@example.com"]
    assert addresses.choices("*@Example.com") == ["*@example.com"]
    assert addresses.name("*@example.com") == "Everyone at example.com"
    for resource in ("*@co.uk", "*@*.example.com", "*@Example.com", "Ada@example.com", "*", "unsupported"):
        assert not addresses.valid_id(resource)
    for query in ("co.uk", "ada@co.uk", "*.example.com"):
        with pytest.raises(OperationError):
            addresses.choices(query)


# Graph


def test_cursors_come_only_from_checked_paging_parameters():
    base = "https://graph.microsoft.com/v1.0/me/mailFolders/X/messages"
    assert next_cursor(None) is None
    assert next_cursor(f"{base}?%24skiptoken=abc%3D%3D&%24top=5") == "token:abc=="
    assert next_cursor(f"{base}?$skip=40") == "skip:40"
    # Where the link points does not matter: it is never requested.
    assert next_cursor("https://attacker.example/?$skip=40") == "skip:40"
    for link in (
        f"{base}?$skip=40&$skiptoken=abc",
        f"{base}?$skip=1&$skip=2",
        f"{base}?$skip=-1",
        f"{base}?$skiptoken=a b",
        f"{base}?$skiptoken=" + "a" * 881,
        f"{base}?$top=5",
        base,
        42,
        "x" * 4001,
    ):
        with pytest.raises(OperationError) as refused:
            next_cursor(link)
        assert refused.value.code == "PROVIDER_LIMIT"
    assert page_param("skip:40") == {"$skip": "40"}
    assert page_param("token:abc==") == {"$skiptoken": "abc=="}
    for cursor in ("skip:x", "token:", "token:a&b", "page:1", "40"):
        with pytest.raises(OperationError) as refused:
            page_param(cursor)
        assert refused.value.code == "INVALID_CURSOR"


def test_graph_errors_are_named_without_graphs_text():
    unsupported = httpx.Response(404, json={"error": {"code": "MailboxNotEnabledForRESTAPI"}})
    assert classify("Outlook", unsupported).code == "UNSUPPORTED_ACCOUNT"
    assert classify("Outlook", httpx.Response(503, content=b"")).code == "PROVIDER_RATE_LIMITED"
    assert classify("Outlook", httpx.Response(404, json={"error": {"code": "ErrorItemNotFound"}})) is None
    assert classify("Outlook", httpx.Response(400, content=b"<html>")) is None


# Connecting


async def test_account_discovery_and_names(graph):
    connector = OutlookConnector()
    account = await connector.account(graph.client())
    assert (account.id, account.label) == (graph.user["id"], "me@contoso.com")
    found = await connector.discover(graph.client(), "folder", query=None, cursor=None)
    assert [(item.id, item.name) for item in found.items] == [
        (INBOX, "Inbox"),
        (SENT, "Sent Items"),
        (DRAFTS, "Drafts"),
        (PROJECTS, "Inbox/Projects"),
        (PRIVATE, "Inbox/Private"),
    ]
    found = await connector.discover(graph.client(), "folder", query="inbox/PRO", cursor=None)
    assert [item.id for item in found.items] == [PROJECTS]
    found = await connector.discover(graph.client(), "recipient", query="Ada@Partner.org", cursor=None)
    assert [(item.id, item.name) for item in found.items] == [
        ("ada@partner.org", "ada@partner.org"),
        ("*@partner.org", "Everyone at partner.org"),
    ]
    names = await connector.describe(
        graph.client(), "folder", [PROJECTS, INBOX, SEARCH, ROOT, HIDDEN_ROOT, "NOSUCHFOLDER", "inbox", "*"]
    )
    assert names == {PROJECTS: "Inbox/Projects", INBOX: "Inbox"}
    names = await connector.describe(graph.client(), "recipient", ["*@partner.org", "Ada@x.com", "*@co.uk"])
    assert names == {"*@partner.org": "Everyone at partner.org"}


def test_outlook_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("outlook")
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    base = ["offline_access", "User.Read", "Mail.Read"]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    requested = connection_oauth.requested_scopes(connector, {"read", "send"})
    assert requested == [*base, "Mail.Send"]
    url = connection_oauth.authorization_url({}, workspace_id=uuid4(), provider="outlook", scopes=requested)
    params = httpx.URL(url).params
    assert url.startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    assert params["scope"] == " ".join(requested)
    assert params["prompt"] == "select_account" and params["code_challenge_method"] == "S256"
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset({"User.Read", "Mail.Read"}), {"read", "send"}) == ["send"]
    # Microsoft may report scopes with Graph's URL in front, and in lowercase.
    granted = frozenset({"https://graph.microsoft.com/mail.read", "https://graph.microsoft.com/Mail.Send"})
    assert needed(connector, granted, {"read", "send"}) == []
    assert needed(connector, frozenset({"mail.readwrite", "mail.send"}), {"read", "send"}) == []
    assert needed(connector, frozenset({"Mail.ReadBasic"}), {"read"}) == ["read"]


def test_outlook_tokens_carry_their_scopes(token_endpoint):
    sent, responses = token_endpoint
    responses.append(
        httpx.Response(
            200,
            json={
                "access_token": "a",
                "refresh_token": "r",
                "expires_in": 3599,
                "token_type": "Bearer",
                "scope": "Mail.Read Mail.Send User.Read profile openid email",
            },
        )
    )
    tokens = connection_oauth.exchange_code(registry.get("outlook"), code="c", flow=FLOW)
    assert tokens["scopes"] == ["Mail.Read", "Mail.Send", "User.Read", "email", "openid", "profile"]
    assert tokens["expires_at"] > time.time()
    [request] = sent
    assert request["url"] == "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    assert request["data"]["client_secret"] == "secret" and request["data"]["code_verifier"] == "v"


def test_a_refused_outlook_refresh_needs_reconnecting(scoped, user, token_endpoint):
    _, responses = token_endpoint
    connection = Connection(provider="outlook", owner=user, label="me", external_account_id="u1")
    credentials = {"kind": "oauth2", "access_token": "old", "refresh_token": "r1", "scopes": SCOPES}
    connection.set_credentials({**credentials, "expires_at": int(time.time())})
    connection.save()
    responses.append(httpx.Response(400, json={"error": "invalid_grant", "error_description": "AADSTS70043"}))
    with pytest.raises(OperationError) as caught:
        connection_credentials.access_secret(connection.id)
    assert caught.value.code == "CONNECTION_UNAUTHORIZED"


# Reading


@pytest.mark.django_db(transaction=True)
async def test_folders_without_a_grant_or_out_of_reach_look_alike(start, graph):
    executor = await start(folder(PROJECTS))
    [listed] = _items(await executor.invoke("outlook_list_messages", {"folder": PROJECTS}))
    assert listed["id"] == FROM_LIST and listed["folder_id"] == PROJECTS
    assert listed["from"] == {"name": "ada@partner.org", "address": "ada@partner.org"}

    graph.requests.clear()
    for name in (INBOX, PRIVATE, "inbox", "Inbox", "sentitems", SEARCH, ROOT, HIDDEN_ROOT, "NOSUCHFOLDER"):
        assert await refusal(executor, "outlook_list_messages", {"folder": name}) == "POLICY_DENIED"
    for message in (FROM_GRACE, FROM_PRIVATE, "NOSUCHMESSAGE"):
        assert await refusal(executor, "outlook_read_message", {"message": message}) == "POLICY_DENIED"
    # Nothing but where the folder or message is was asked for.
    assert not any(path.endswith(("/messages", "/attachments")) for path in graph.paths())
    for name in ("Projects", "inbox/projects", "../me", "short"):
        assert await refusal(executor, "outlook_list_messages", {"folder": name}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_grant_on_a_folder_covers_its_subfolders_and_a_deny_holds(start, graph):
    await start({})
    await ceiling("outlook", "folder", PRIVATE, Grant.Effect.DENY)
    executor = await start(folder(INBOX))
    assert _ids(await executor.invoke("outlook_list_messages", {"folder": "inbox"})) == [FROM_GRACE, LEGACY]
    assert _ids(await executor.invoke("outlook_list_messages", {"folder": PROJECTS})) == [FROM_LIST]
    assert await refusal(executor, "outlook_list_messages", {"folder": PRIVATE}) == "POLICY_DENIED"
    assert await refusal(executor, "outlook_read_message", {"message": FROM_PRIVATE}) == "POLICY_DENIED"
    children = _items(await executor.invoke("outlook_list_folders", {"parent": "inbox"}))
    assert [(c["id"], c["name"], c["parent_id"]) for c in children] == [(PROJECTS, "Projects", INBOX)]
    assert _ids(await executor.invoke("outlook_list_folders", {})) == [INBOX]


@pytest.mark.django_db(transaction=True)
async def test_folders_outside_the_mailbox_tree_are_refused_even_with_every_folder(start, graph):
    executor = await start(folder("*"))
    assert _ids(await executor.invoke("outlook_list_folders", {})) == [INBOX, SENT, DRAFTS]
    for name in (SEARCH, ROOT, HIDDEN_ROOT):
        assert await refusal(executor, "outlook_list_messages", {"folder": name}) == "POLICY_DENIED"
        assert await refusal(executor, "outlook_list_folders", {"parent": name}) == "POLICY_DENIED"

    # A folder whose chain loops never reaches the root.
    graph.folders[PROJECTS]["parentFolderId"] = PRIVATE
    graph.folders[PRIVATE]["parentFolderId"] = PROJECTS
    assert await refusal(executor, "outlook_list_messages", {"folder": PROJECTS}) == "POLICY_DENIED"


SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD, HIDDEN_MAIL = (
    "INBOXSEARCH0",
    "HIDDENFOLD00",
    "HIDDENCHILD0",
    "MSGHIDDEN001",
)


@pytest.mark.django_db(transaction=True)
async def test_search_and_hidden_folders_are_refused_wherever_they_sit(start, graph):
    # Graph lets a search folder sit in any folder, and a hidden folder too; both can be reached by id.
    graph.folders[SEARCH_IN_INBOX] = {
        **_folder(SEARCH_IN_INBOX, "Everything private", INBOX),
        "@odata.type": "#microsoft.graph.mailSearchFolder",
    }
    graph.folders[HIDDEN] = {**_folder(HIDDEN, "Hidden", INBOX), "isHidden": True}
    graph.folders[HIDDEN_CHILD] = _folder(HIDDEN_CHILD, "Below hidden", HIDDEN)
    graph.messages[HIDDEN_MAIL] = _message(HIDDEN_MAIL, HIDDEN_CHILD, "grace@example.com", subject=SECRET)
    graph.folders[PROJECTS]["@odata.type"] = "#microsoft.graph.mailFolder"
    executor = await start(folder(INBOX))

    for name in (SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD):
        assert await refusal(executor, "outlook_list_messages", {"folder": name}) == "POLICY_DENIED"
        assert await refusal(executor, "outlook_list_folders", {"parent": name}) == "POLICY_DENIED"
    assert await refusal(executor, "outlook_read_message", {"message": HIDDEN_MAIL}) == "POLICY_DENIED"
    children = _items(await executor.invoke("outlook_list_folders", {"parent": INBOX}))
    assert [c["id"] for c in children] == [PROJECTS, PRIVATE] and SECRET not in json.dumps(children)

    connector = OutlookConnector()
    found = await connector.discover(graph.client(), "folder", query=None, cursor=None)
    assert {SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD}.isdisjoint(item.id for item in found.items)
    names = await connector.describe(
        graph.client(), "folder", [SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD, PROJECTS]
    )
    assert names == {PROJECTS: "Inbox/Projects"}


@pytest.mark.django_db(transaction=True)
async def test_listings_leave_out_what_lives_elsewhere(start, graph):
    executor = await start(folder(INBOX))

    def hook(method, path, params):
        if path == f"/me/mailFolders/{INBOX}/messages":
            return httpx.Response(
                200, json={"value": [graph.messages[FROM_GRACE], graph.messages[FROM_PRIVATE]]}
            )
        if path == f"/me/mailFolders/{INBOX}/childFolders":
            stray = _folder("STRAYFOLDER0", "Stray", SENT)
            return httpx.Response(200, json={"value": [graph.folders[PROJECTS], stray]})
        if path == "/me/mailFolders":
            return httpx.Response(200, json={"value": [graph.folders[INBOX], graph.folders[SEARCH]]})
        return None

    graph.hook = hook
    messages = _items(await executor.invoke("outlook_list_messages", {"folder": INBOX}))
    assert [m["id"] for m in messages] == [FROM_GRACE] and SECRET not in json.dumps(messages)
    assert _ids(await executor.invoke("outlook_list_folders", {"parent": INBOX})) == [PROJECTS]
    executor = await start(folder("*"))
    assert _ids(await executor.invoke("outlook_list_folders", {})) == [INBOX]


@pytest.mark.django_db(transaction=True)
async def test_filters_and_search(start, graph):
    executor = await start(folder(INBOX))

    def sent_params():
        [request] = [r for r in graph.requests if r.url.path.endswith("/messages")]
        graph.requests.clear()
        return dict(request.url.params)

    await executor.invoke(
        "outlook_list_messages",
        {
            "folder": INBOX,
            "unread_only": True,
            "after": "2026-09-01T02:00:00+02:00",
            "before": "2026-10-01",
        },
    )
    params = sent_params()
    assert params["$filter"] == (
        "receivedDateTime ge 2026-09-01T00:00:00Z and receivedDateTime lt 2026-10-01T00:00:00Z "
        "and isRead eq false"
    )
    assert params["$orderby"] == "receivedDateTime desc" and "$search" not in params
    await executor.invoke("outlook_list_messages", {"folder": INBOX, "unread_only": True})
    assert sent_params()["$filter"] == "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false"
    await executor.invoke("outlook_list_messages", {"folder": INBOX, "query": "budget 2026"})
    params = sent_params()
    assert params["$search"] == '"budget 2026"' and "$filter" not in params and "$orderby" not in params

    for args in (
        {"query": "budget", "unread_only": True},
        {"query": 'budget" OR from:x'},
        {"query": "back\\slash"},
        {"after": "yesterday"},
        {"after": "2026-09-01T00:00:00Z' or true"},
    ):
        assert await refusal(executor, "outlook_list_messages", {"folder": INBOX, **args}) == (
            "INVALID_ARGUMENTS"
        )


@pytest.mark.django_db(transaction=True)
async def test_pages_follow_graphs_links_only_through_their_parameters(start, graph):
    executor = await start(folder(INBOX))
    first = await executor.invoke("outlook_list_messages", {"folder": INBOX, "limit": 1})
    assert _ids(first) == [FROM_GRACE]
    cursor = first.result["next_cursor"]
    assert "skiptoken" not in cursor and "graph" not in cursor
    graph.requests.clear()
    second = await executor.invoke("outlook_list_messages", {"folder": INBOX, "limit": 1, "cursor": cursor})
    assert _ids(second) == [LEGACY]
    [request] = [r for r in graph.requests if r.url.path.endswith("/messages")]
    assert request.url.host == "graph.microsoft.com" and request.url.params["$skiptoken"] == "p1"

    def hook(method, path, params):
        if path.endswith("/messages"):
            link = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=a%26b%20c"
            return httpx.Response(200, json={"value": [], "@odata.nextLink": link})
        return None

    graph.hook = hook
    assert await refusal(executor, "outlook_list_messages", {"folder": INBOX}) == "PROVIDER_LIMIT"


@pytest.mark.django_db(transaction=True)
async def test_reading_a_message(start, graph):
    graph.messages[FROM_GRACE]["body"]["content"] = "x" * 600 + "end"
    graph.messages[FROM_GRACE]["replyTo"] = [_person("desk@example.com")]
    executor = await start(folder(INBOX))
    [message] = _items(
        await executor.invoke("outlook_read_message", {"message": FROM_GRACE, "max_chars": 500})
    )
    assert message["body"] == "x" * 500 and message["total_chars"] == 603 and message["next_offset"] == 500
    assert message["reply_to"] == [{"name": "desk@example.com", "address": "desk@example.com"}]
    assert message["attachments"] == [
        {"name": "plan.pdf", "content_type": "application/pdf", "size": 10, "inline": False}
    ]
    [read] = [
        r for r in graph.requests if r.url.path.endswith(FROM_GRACE) and "body" in r.url.params["$select"]
    ]
    assert read.headers["Prefer"] == 'IdType="ImmutableId", outlook.body-content-type="text"'
    [rest] = _items(
        await executor.invoke(
            "outlook_read_message", {"message": FROM_GRACE, "max_chars": 500, "offset": 500}
        )
    )
    assert rest["body"] == "x" * 100 + "end" and rest["next_offset"] is None


@pytest.mark.django_db(transaction=True)
async def test_mail_moved_while_the_call_runs_is_refused(start, graph):
    executor = await start(folder(INBOX))

    def moved_after_resolving(record: dict, **change):
        seen = 0

        def hook(method, path, params):
            nonlocal seen
            if path.rsplit("/", 1)[-1] != record["id"]:
                return None
            seen += 1
            return httpx.Response(200, json=record if seen == 1 else {**record, **change})

        graph.hook = hook

    # The message moved to a folder without a grant.
    moved_after_resolving(graph.messages[FROM_GRACE], parentFolderId=PRIVATE)
    assert await refusal(executor, "outlook_read_message", {"message": FROM_GRACE}) == "MAIL_MOVED"
    # The folder moved out from under the granted one.
    moved_after_resolving(graph.folders[PROJECTS], parentFolderId=SENT)
    assert await refusal(executor, "outlook_list_messages", {"folder": PROJECTS}) == "MAIL_MOVED"
    moved_after_resolving(graph.folders[PROJECTS], parentFolderId=SENT)
    assert await refusal(executor, "outlook_read_message", {"message": FROM_LIST}) == "MAIL_MOVED"
    moved_after_resolving(graph.folders[PROJECTS], parentFolderId=SENT)
    assert await refusal(executor, "outlook_list_folders", {"parent": PROJECTS}) == "MAIL_MOVED"


@pytest.mark.django_db(transaction=True)
async def test_reads_with_errors_or_too_much_data_are_refused(start, graph):
    executor = await start(folder(INBOX))
    graph.hook = lambda method, path, params: (
        httpx.Response(200, json={"value": [{"id": "x" * 5 * 1024 * 1024}]})
        if path.endswith("/messages")
        else None
    )
    assert await refusal(executor, "outlook_list_messages", {"folder": INBOX}) == "RESPONSE_TOO_LARGE"
    graph.hook = lambda method, path, params: httpx.Response(
        404, json={"error": {"code": "MailboxNotEnabledForRESTAPI"}}
    )
    assert await refusal(executor, "outlook_read_message", {"message": FROM_GRACE}) == "UNSUPPORTED_ACCOUNT"
    graph.hook = lambda method, path, params: httpx.Response(503, headers={"Retry-After": "5"})
    assert await refusal(executor, "outlook_list_messages", {"folder": INBOX}) == "PROVIDER_RATE_LIMITED"
    # Last: the connection is then marked as needing reconnecting.
    graph.hook = lambda method, path, params: httpx.Response(
        401, json={"error": {"code": "InvalidAuthenticationToken"}}
    )
    assert await refusal(executor, "outlook_list_messages", {"folder": INBOX}) == "CONNECTION_UNAUTHORIZED"


# Sending


@pytest.mark.django_db(transaction=True)
async def test_sending_needs_every_recipient(start, graph):
    executor = await start({**recipient("*@example.com"), **recipient("ada@partner.org")})
    [sent] = _items(
        await executor.invoke(
            "outlook_send_message",
            {
                "to": ["Grace@Example.com"],
                "cc": ["ada@partner.org"],
                "subject": "Plans",
                "body": "Hi <b>Grace</b>\n\tthanks",
            },
        )
    )
    assert sent == {
        "sent": True,
        "to": ["grace@example.com"],
        "cc": ["ada@partner.org"],
        "bcc": [],
        "subject": "Plans",
    }
    [(path, payload)] = graph.writes
    assert path == "/me/sendMail" and payload["saveToSentItems"] is True
    assert payload["message"] == {
        "subject": "Plans",
        "body": {"contentType": "Text", "content": "Hi <b>Grace</b>\n\tthanks"},
        "toRecipients": [{"emailAddress": {"address": "grace@example.com"}}],
        "ccRecipients": [{"emailAddress": {"address": "ada@partner.org"}}],
        "bccRecipients": [],
    }

    send = {"to": ["grace@example.com"], "subject": "x", "body": "x"}
    for change in (
        {"bcc": ["bob@partner.org"]},
        {"cc": ["grace@mail.example.com"]},
        {"to": ["grace@example.com.evil.org"]},
    ):
        assert await refusal(executor, "outlook_send_message", {**send, **change}) == "POLICY_DENIED"
    for change in (
        {"cc": ["Grace@example.com"]},
        {"to": []},
        {"to": ["Grace <grace@example.com>"]},
        {"to": [f"p{n}@example.com" for n in range(6)], "cc": [f"q{n}@example.com" for n in range(5)]},
        {"subject": "a\r\nBcc: x@evil.org"},
        {"body": "bell\x07"},
        {"from": "ceo@example.com"},
    ):
        assert await refusal(executor, "outlook_send_message", {**send, **change}) == "INVALID_ARGUMENTS"
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_write_outcomes_follow_graphs_status(start, graph):
    executor = await start(recipient("*@example.com"))
    send = {"to": ["grace@example.com"], "subject": "x", "body": "x"}

    def answer(status: int):
        graph.hook = lambda method, path, params: (
            httpx.Response(status, json={"error": {"code": "x", "message": SECRET}})
            if method == "POST"
            else None
        )

    answer(400)
    assert await refusal(executor, "outlook_send_message", send) == "PROVIDER_REJECTED"
    answer(403)
    assert await refusal(executor, "outlook_send_message", {**send, "body": "y"}) == "PROVIDER_FORBIDDEN"
    # A refusal before sending leaves writes open; an error that may follow a send pauses them.
    answer(500)
    assert await refusal(executor, "outlook_send_message", {**send, "body": "z"}) == "WRITE_UNCERTAIN"
    graph.hook = None
    assert await refusal(executor, "outlook_send_message", {**send, "body": "w"}) == "WRITE_UNCERTAIN"


@pytest.mark.django_db(transaction=True)
async def test_replying_goes_to_exactly_the_authorized_addresses(start, graph):
    executor = await start({**folder(INBOX), **recipient("grace@example.com")})
    [replied] = _items(await executor.invoke("outlook_reply", {"message": FROM_GRACE, "body": "Thanks"}))
    assert replied == {"replied": True, "message": FROM_GRACE, "to": ["grace@example.com"]}
    [(path, payload)] = graph.writes
    assert path == f"/me/messages/{FROM_GRACE}/reply"
    assert payload == {
        "message": {
            "toRecipients": [{"emailAddress": {"address": "grace@example.com"}}],
            "ccRecipients": [],
            "bccRecipients": [],
            "body": {"contentType": "Text", "content": "Thanks"},
        }
    }
    # Replies go to the reply-to address, not the sender.
    assert await refusal(executor, "outlook_reply", {"message": FROM_LIST, "body": "x"}) == "POLICY_DENIED"

    graph.writes.clear()
    executor = await start({**folder(PROJECTS), **recipient("ada@partner.org")})
    assert await refusal(executor, "outlook_reply", {"message": FROM_LIST, "body": "x"}) == "POLICY_DENIED"
    executor = await start({**folder(PROJECTS), **recipient("*@partner.org")})
    [replied] = _items(await executor.invoke("outlook_reply", {"message": FROM_LIST, "body": "x"}))
    assert replied["to"] == ["list@partner.org"]
    # Sending alone does not let an agent reply to mail it may not read.
    executor = await start({**folder(SENT), **recipient("*")})
    for message in (FROM_GRACE, FROM_PRIVATE, "NOSUCHMESSAGE"):
        assert await refusal(executor, "outlook_reply", {"message": message, "body": "x"}) == "POLICY_DENIED"
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_replies_whose_recipients_are_unclear_are_refused(start, graph):
    executor = await start({**folder("*"), **recipient("grace@example.com"), **recipient("*@contoso.com")})
    # An address Minerva cannot read is refused like one without a grant...
    assert await refusal(executor, "outlook_reply", {"message": LEGACY, "body": "x"}) == "POLICY_DENIED"
    executor = await start({**folder("*"), **recipient("*")})
    # ...and, with every recipient allowed, refused for what it is.
    assert (
        await refusal(executor, "outlook_reply", {"message": LEGACY, "body": "x"}) == "UNSUPPORTED_RECIPIENT"
    )
    assert await refusal(executor, "outlook_reply", {"message": DRAFT, "body": "x"}) == "UNSUPPORTED_MESSAGE"
    assert (
        await refusal(executor, "outlook_reply", {"message": FROM_ME, "body": "x"}) == "UNSUPPORTED_MESSAGE"
    )
    graph.messages[FROM_ME]["from"] = _person("ME@contoso.onmicrosoft.com")
    assert (
        await refusal(executor, "outlook_reply", {"message": FROM_ME, "body": "x"}) == "UNSUPPORTED_MESSAGE"
    )

    def changed_after_resolving(**change):
        seen = 0

        def hook(method, path, params):
            nonlocal seen
            if not path.endswith(FROM_GRACE):
                return None
            seen += 1
            message = graph.messages[FROM_GRACE]
            return httpx.Response(200, json=message if seen == 1 else {**message, **change})

        graph.hook = hook

    changed_after_resolving(replyTo=[_person("attacker@evil.org")])
    assert await refusal(executor, "outlook_reply", {"message": FROM_GRACE, "body": "x"}) == "MESSAGE_CHANGED"
    changed_after_resolving(isDraft=True)
    assert (
        await refusal(executor, "outlook_reply", {"message": FROM_GRACE, "body": "x"})
        == "UNSUPPORTED_MESSAGE"
    )
    assert graph.writes == []


@pytest.mark.django_db(transaction=True)
async def test_replies_to_the_accounts_own_mail_are_refused_however_it_was_sent(start, graph):
    executor = await start({**folder("*"), **recipient("*")})

    def refused_reply(**change) -> str:
        graph.messages[FROM_GRACE] = {**graph.messages[FROM_GRACE], **change}
        return refusal(executor, "outlook_reply", {"message": FROM_GRACE, "body": "x"})

    original = graph.messages[FROM_GRACE]
    # From one of the account's aliases.
    graph.user["proxyAddresses"] = ["SMTP:me@contoso.com", "smtp:Alias@Contoso.com", "X500:/o=contoso/cn=me"]
    assert await refused_reply(**{"from": _person("alias@contoso.com")}) == "UNSUPPORTED_MESSAGE"
    # Sent by the account on behalf of someone else.
    assert (
        await refused_reply(**{"from": _person("boss@contoso.com"), "sender": _person("alias@contoso.com")})
        == "UNSUPPORTED_MESSAGE"
    )
    # Kept in Sent Items, whoever it names as its sender.
    graph.messages[FROM_GRACE] = original
    graph.messages[FROM_GRACE]["parentFolderId"] = SENT
    assert await refused_reply() == "UNSUPPORTED_MESSAGE"

    # An account that will not name its aliases is still checked against its own addresses.
    graph.messages[FROM_GRACE] = {**original, "from": _person("me@contoso.com")}
    graph.hook = lambda method, path, params: (
        httpx.Response(400, json={"error": {"code": "BadRequest"}})
        if path == "/me" and "proxyAddresses" in params.get("$select", "")
        else None
    )
    assert await refused_reply() == "UNSUPPORTED_MESSAGE"
    assert graph.writes == []


@pytest.mark.django_db(transaction=True)
async def test_a_reply_confirms_its_message_last_before_writing(start, graph):
    executor = await start({**folder(INBOX), **recipient("grace@example.com")})

    def hook(method, path, params):
        # The message moves out of the granted folder while Minerva looks up the account.
        if path == "/me":
            graph.messages[FROM_GRACE]["parentFolderId"] = SENT
        return None

    graph.hook = hook
    assert await refusal(executor, "outlook_reply", {"message": FROM_GRACE, "body": "x"}) == "MAIL_MOVED"
    assert graph.writes == []
