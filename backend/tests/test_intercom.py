"""Intercom connector against an in-memory Intercom API, and runs through the executor."""

import copy
import json

import httpx
import pytest
from connector_runs import ceiling, refusal

from connectors import registry
from connectors.base import OperationError
from connectors.intercom import client as client_module
from connectors.intercom import html
from connectors.intercom.client import IntercomClient
from connectors.intercom.connector import IntercomConnector
from permissions.models import Grant

SECRET = "SECRET merger"
ADMIN = "991"
SUPPORT = "1"
BILLING = "2"
T0 = 1790000000
TOKEN = "WzE3OTAw+/="


def _author(kind: str, author_id: str, name: str, email: str | None = None) -> dict:
    return {"type": kind, "id": author_id, "name": name, "email": email}


def _part(part_id: str, part_type: str, author: dict, body: str | None, **fields) -> dict:
    return {
        "type": "conversation_part",
        "id": part_id,
        "part_type": part_type,
        "body": body,
        "created_at": T0 + 100 * (int(part_id) - 199),
        "author": author,
        "attachments": [],
        "redacted": False,
    } | fields


def _conversation(
    conversation_id: str, team: int | None, title: str, body: str, *parts: dict, **fields
) -> dict:
    return {
        "type": "conversation",
        "id": conversation_id,
        "title": title,
        "created_at": T0,
        "updated_at": T0 + 3600,
        "waiting_since": None,
        "state": "open",
        "priority": "not_priority",
        "team_assignee_id": team,
        "admin_assignee_id": None,
        "source": {
            "type": "conversation",
            "id": f"s{conversation_id}",
            "delivered_as": "customer_initiated",
            "subject": "",
            "body": body,
            "author": _author("user", "u1", "Carol", "carol@example.com"),
            "attachments": [],
            "redacted": False,
        },
        "conversation_parts": {
            "type": "conversation_part.list",
            "conversation_parts": list(parts),
            "total_count": len(parts),
        },
    } | fields


CAROL = _author("user", "u1", "Carol", "carol@example.com")
ADA = _author("admin", ADMIN, "Ada", "ada@example.com")


class FakeIntercom:
    """Intercom's REST API, served through httpx.MockTransport.

    The workspace has teams Support (1) and Billing (2, whose name is secret). Conversation 100 is in
    Support and links to 101, which is in Billing; 102 has no team, and 103 is assigned only to a teammate.
    """

    def __init__(self) -> None:
        self.me = {
            "type": "admin",
            "id": ADMIN,
            "name": "Ada",
            "email": "ada@example.com",
            "app": {"type": "app", "id_code": "abc123", "name": "Acme", "region": "Europe"},
        }
        self.teams = [
            {"type": "team", "id": SUPPORT, "name": "Support", "admin_ids": [991, 992]},
            {"type": "team", "id": BILLING, "name": SECRET, "admin_ids": []},
        ]
        body = (
            '<p>Hi, see <a href="https://app.intercom.com/a/inbox/abc123/inbox/conversation/101">'
            + SECRET
            + '</a> and <a href="https://example.com/docs">docs</a></p>'
            '<p><img src="https://downloads.intercomcdn.com/i/1.png"></p>'
        )
        self.conversations: dict[str, dict] = {
            "100": _conversation(
                "100",
                1,
                "Login issue",
                body,
                _part("200", "comment", CAROL, "<p>Still broken</p>"),
                _part("201", "assignment", ADA, f"<p>{SECRET}</p>", assigned_to={"type": "team", "id": "2"}),
                _part("202", "note", ADA, "<p>Checking &amp; <b>logs</b></p>"),
                _part("203", "comment", _author("team", BILLING, SECRET), "<p>From the team</p>"),
                _part("204", "close", ADA, None),
                _part("205", "comment", CAROL, f"<p>{SECRET}</p>", redacted=True),
                _part(
                    "206",
                    "comment",
                    _author("bot", "b1", "Fin"),
                    "<p>Bot</p>",
                    attachments=[{"name": "log.txt"}],
                ),
            ),
            "101": _conversation("101", 2, SECRET, f"<p>{SECRET}</p>"),
            "102": _conversation("102", 0, "Refund", "<p>Refund please</p>", state="closed"),
            "103": _conversation("103", None, "Invoice", "<p>Invoice copy</p>", admin_assignee_id=991),
        }
        # Ids search returns from an index that lags behind reassignments: {id: team the index shows}.
        self.stale: dict[str, int] = {}
        self.requests: list[httpx.Request] = []
        self.searches: list[dict] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _error(status: int, code: str) -> httpx.Response:
        return httpx.Response(
            status, json={"type": "error.list", "errors": [{"code": code, "message": SECRET}]}
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == "api.intercom.io"
        assert request.headers["Intercom-Version"] == "2.16"
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        if self.hook is not None and (response := self.hook(request.method, path, body)) is not None:
            return response
        parts = path.strip("/").split("/")
        match request.method, parts:
            case "GET", ["me"]:
                return httpx.Response(200, json=self.me)
            case "GET", ["teams"]:
                return httpx.Response(200, json={"type": "team.list", "teams": self.teams})
            case "GET", ["conversations", conversation_id]:
                found = self.conversations.get(conversation_id)
                return httpx.Response(200, json=found) if found else self._error(404, "not_found")
            case "POST", ["conversations", "search"]:
                return self._search(body)
            case "POST", ["conversations", conversation_id, "reply"]:
                self.writes.append((conversation_id, body))
                found = self.conversations.get(conversation_id)
                if found is None:
                    return self._error(404, "not_found")
                listed = found["conversation_parts"]["conversation_parts"]
                author = _author("admin", body["admin_id"], "Ada", "ada@example.com")
                listed.append(_part(str(300 + len(self.writes)), body["message_type"], author, body["body"]))
                return httpx.Response(200, json=found)
        raise AssertionError(path)

    def _search(self, body: dict) -> httpx.Response:
        self.searches.append(body)
        query = body["query"]
        assert query["operator"] == "AND"

        def matches(conversation: dict) -> bool:
            for f in query["value"]:
                field, value = f["field"], f["value"]
                if field == "team_assignee_id":
                    team = self.stale.get(conversation["id"], conversation["team_assignee_id"])
                    if (team or 0) != value:
                        return False
                elif field == "state":
                    if conversation["state"] != value:
                        return False
                elif field == "updated_at":
                    assert f["operator"] == ">"
                    if conversation["updated_at"] < value:
                        return False
                elif field == "source.body":
                    assert f["operator"] == "~"
                    if value.casefold() not in conversation["source"]["body"].casefold():
                        return False
                else:
                    raise AssertionError(field)
            return True

        ids = [i for i, c in self.conversations.items() if matches(c)]
        ids += [i for i in self.stale if i not in self.conversations]
        per_page = body["pagination"]["per_page"]
        start = 0
        if "starting_after" in body["pagination"]:
            after = body["pagination"]["starting_after"]
            if not after.startswith(TOKEN):
                return self._error(400, "parameter_invalid")
            start = int(after.removeprefix(TOKEN))
        end = start + per_page
        page = {
            "type": "conversation.list",
            "conversations": [{"type": "conversation", "id": i, "title": SECRET} for i in ids[start:end]],
            "total_count": len(ids),
            "pages": {"type": "pages", "page": 1, "per_page": per_page},
        }
        if end < len(ids):
            page["pages"]["next"] = {"per_page": per_page, "starting_after": f"{TOKEN}{end}"}
        return httpx.Response(200, json=page)

    def reads(self, suffix: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path.endswith(suffix)]

    def client(self) -> IntercomClient:
        return IntercomClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def intercom() -> FakeIntercom:
    return FakeIntercom()


@pytest.fixture
def start(connector_run, intercom, monkeypatch):
    """Starts a run with the user's Intercom connection, holding `grants` ({inbox: actions})."""
    monkeypatch.setattr(IntercomConnector, "client", lambda self, token: intercom.client())

    def start_(grants: dict[str, tuple[str, ...]]):
        inboxes = {("inbox", inbox): actions for inbox, actions in grants.items()}
        return connector_run(
            "intercom", inboxes, label="Ada (ada@example.com) · Acme", external_account_id="abc123:991"
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


# Connecting and discovery


async def test_the_account_is_one_teammate_in_one_workspace(intercom):
    connector = IntercomConnector()
    account = await connector.account(intercom.client())
    assert (account.id, account.label) == ("abc123:991", "Ada (ada@example.com) · Acme")
    del intercom.me["app"]
    with pytest.raises(OperationError) as caught:
        await connector.account(intercom.client())
    assert caught.value.code == "PROVIDER_FAILED"
    intercom.me = {"id": "x1", "app": {"id_code": "abc123"}}
    with pytest.raises(OperationError) as caught:
        await connector.account(intercom.client())
    assert caught.value.code == "PROVIDER_FAILED"


async def test_inboxes_are_the_teams_and_no_team(intercom):
    connector = IntercomConnector()
    client = intercom.client()
    page = await connector.discover(client, "inbox", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (SUPPORT, "Support"),
        (BILLING, SECRET),
        ("none", "No team"),
    ]
    assert page.next_cursor is None
    page = await connector.discover(client, "inbox", query="sup", cursor=None)
    assert [i.id for i in page.items] == [SUPPORT]
    with pytest.raises(OperationError) as caught:
        await connector.discover(client, "inbox", query=None, cursor="x")
    assert caught.value.code == "INVALID_CURSOR"
    described = await connector.describe(client, "inbox", [SUPPORT, "none", "3", "01", "x"])
    assert described == {SUPPORT: "Support", "none": "No team"}
    assert await connector.describe(client, "inbox", ["x"]) == {}


async def test_ids_with_a_final_newline_are_refused(intercom):
    intercom.teams[1]["id"] = BILLING + "\n"
    page = await IntercomConnector().discover(intercom.client(), "inbox", query=None, cursor=None)
    assert [i.id for i in page.items] == [SUPPORT, "none"]


def test_intercom_has_no_scopes_to_ask_for():
    connector = registry.get("intercom")
    assert connector.auth.scopes == () and connector.auth.pkce is False
    assert all(not op.consent for op in connector.operations)


def test_errors_are_named_without_intercoms_message():
    def classified(status: int, content: bytes) -> OperationError | None:
        return client_module.classify("Intercom", httpx.Response(status, content=content))

    plan = classified(403, b'{"type":"error.list","errors":[{"code":"api_plan_restricted","message":"x"}]}')
    assert (plan.code, plan.message) == (
        "PROVIDER_FORBIDDEN",
        "This Intercom workspace's plan does not include this.",
    )
    other = classified(403, b'{"errors":[{"code":"forbidden","message":"SECRET"}]}')
    assert other.code == "PROVIDER_FORBIDDEN" and "SECRET" not in other.message
    assert classified(403, b"[1]").code == "PROVIDER_FORBIDDEN"
    assert classified(403, b"not json").code == "PROVIDER_FORBIDDEN"
    assert classified(404, b"{}") is None


def test_cursors_are_checked():
    assert client_module.cursor(TOKEN) == TOKEN
    for value in ("", "a b", "é", "a" * 901):
        with pytest.raises(OperationError) as caught:
            client_module.cursor(value)
        assert caught.value.code == "INVALID_CURSOR"


# Reading


@pytest.mark.django_db(transaction=True)
async def test_inbox_grants_decide_what_is_listed_and_read(start, intercom):
    executor = await start({SUPPORT: ("read",), "none": ("read",)})
    outcome = await executor.invoke("intercom_list_inboxes", {})
    assert _items(outcome) == [
        {"id": SUPPORT, "name": "Support", "teammates": 2},
        {"id": "none", "name": "No team", "teammates": None},
    ]
    assert SECRET not in json.dumps(outcome.result)
    for conversation in ("100", "102", "103"):
        found = _items(await executor.invoke("intercom_get_conversation", {"conversation": conversation}))
        assert found[0]["id"] == conversation
    assert found[0]["inbox"] == "none"
    # Another inbox, and conversations the account cannot see, are refused alike.
    for conversation in ("101", "404"):
        assert (
            await refusal(executor, "intercom_get_conversation", {"conversation": conversation})
            == "POLICY_DENIED"
        )
    for conversation in ("0100", "x", "1 OR 1", "1" * 21):
        args = {"conversation": conversation}
        assert await refusal(executor, "intercom_get_conversation", args) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_workspace_grant_holds_denies_inside_it(start, intercom):
    await start({})
    await ceiling("intercom", "inbox", BILLING, Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    assert [i["id"] for i in _items(await executor.invoke("intercom_list_inboxes", {}))] == [SUPPORT, "none"]
    assert await refusal(executor, "intercom_get_conversation", {"conversation": "101"}) == "POLICY_DENIED"
    assert await refusal(executor, "intercom_search_conversations", {"inbox": BILLING}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_a_conversation_shows_its_messages_without_other_inboxes(start, intercom):
    executor = await start({SUPPORT: ("read",)})
    outcome = await executor.invoke("intercom_get_conversation", {"conversation": "100"})
    assert SECRET not in json.dumps(outcome.result)
    [conversation] = _items(outcome)
    assert {k: v for k, v in conversation.items() if k != "messages"} == {
        "id": "100",
        "inbox": SUPPORT,
        "title": "Login issue",
        "subject": None,
        "state": "open",
        "priority": "not_priority",
        "created": "2026-09-21T14:13:20Z",
        "updated": "2026-09-21T15:13:20Z",
        "waiting_since": None,
        "contact": {"name": "Carol", "email": "carol@example.com"},
        "more_messages": False,
    }
    messages = conversation["messages"]
    assert [(m["id"], m["type"], m["author"]["type"], m["text"]) for m in messages] == [
        ("s100", "first", "user", "Hi, see [Intercom link] and docs (https://example.com/docs)\n[image]"),
        ("200", "comment", "user", "Still broken"),
        ("202", "note", "admin", "Checking & logs"),
        ("203", "comment", "other", "From the team"),
        ("205", "comment", "user", "[redacted]"),
        ("206", "comment", "bot", "Bot"),
    ]
    assert messages[3]["author"] == {"type": "other", "name": None, "email": None}
    assert messages[1]["created"] == "2026-09-21T14:15:00Z"
    assert messages[5]["attachments"] == ["log.txt"]
    # One read decides where the conversation is and what is shown.
    assert len(intercom.reads("/conversations/100")) == 1


@pytest.mark.django_db(transaction=True)
async def test_long_conversations_show_their_latest_messages(start, intercom, monkeypatch):
    from connectors.intercom import reads

    monkeypatch.setattr(reads, "MAX_MESSAGES", 2)
    executor = await start({SUPPORT: ("read",)})
    [conversation] = _items(await executor.invoke("intercom_get_conversation", {"conversation": "100"}))
    assert [m["id"] for m in conversation["messages"]] == ["s100", "205", "206"]
    assert conversation["more_messages"] is True
    monkeypatch.setattr(reads, "MAX_MESSAGES", 50)
    intercom.conversations["100"]["conversation_parts"]["total_count"] = 600
    [conversation] = _items(await executor.invoke("intercom_get_conversation", {"conversation": "100"}))
    assert conversation["more_messages"] is True


@pytest.mark.django_db(transaction=True)
async def test_a_conversation_without_its_team_field_is_not_guessed_at(start, intercom):
    executor = await start({"*": ("read",)})
    del intercom.conversations["102"]["team_assignee_id"]
    assert await refusal(executor, "intercom_get_conversation", {"conversation": "102"}) == "PROVIDER_FAILED"
    intercom.conversations["102"]["team_assignee_id"] = -1
    assert await refusal(executor, "intercom_get_conversation", {"conversation": "102"}) == "PROVIDER_FAILED"
    intercom.conversations["102"]["team_assignee_id"] = 0
    intercom.conversations["102"]["id"] = "100"
    assert await refusal(executor, "intercom_get_conversation", {"conversation": "102"}) == "PROVIDER_FAILED"


@pytest.mark.django_db(transaction=True)
async def test_search_names_one_inbox_and_reads_results_again(start, intercom):
    intercom.stale = {"101": 1, "999": 1}
    executor = await start({SUPPORT: ("read",)})
    args = {
        "inbox": SUPPORT,
        "state": "open",
        "text": 'see "docs" x',
        "updated_after": "2026-09-21T15:13:20+00:00",
    }
    outcome = await executor.invoke("intercom_search_conversations", args)
    assert [c["id"] for c in _items(outcome)] == ["100"]
    assert intercom.searches[-1] == {
        "query": {
            "operator": "AND",
            "value": [
                {"field": "team_assignee_id", "operator": "=", "value": 1},
                {"field": "state", "operator": "=", "value": "open"},
                {"field": "updated_at", "operator": ">", "value": T0 + 3600},
                {"field": "source.body", "operator": "~", "value": "see"},
                {"field": "source.body", "operator": "~", "value": "docs"},
                {"field": "source.body", "operator": "~", "value": "x"},
            ],
        },
        "pagination": {"per_page": 10},
    }
    # 101 is in Billing now, though the index still has it in Support; 999 is gone.
    outcome = await executor.invoke("intercom_search_conversations", {"inbox": SUPPORT})
    assert [c["id"] for c in _items(outcome)] == ["100"]
    assert SECRET not in json.dumps(outcome.result)
    assert (
        _items(outcome)[0]["preview"]
        == "Hi, see [Intercom link] and docs (https://example.com/docs)\n[image]"
    )
    assert intercom.reads("/conversations/101") and intercom.reads("/conversations/999")
    # Teams the workspace does not have are refused like ungranted ones; names are refused before asking.
    assert await refusal(executor, "intercom_search_conversations", {"inbox": "3"}) == "POLICY_DENIED"
    for inbox in ("Support", "01", "None"):
        assert (
            await refusal(executor, "intercom_search_conversations", {"inbox": inbox}) == "INVALID_ARGUMENTS"
        )
    for extra in ({"text": "?!"}, {"updated_after": "yesterday"}, {"updated_after": "1900-01-01"}):
        args = {"inbox": SUPPORT} | extra
        assert await refusal(executor, "intercom_search_conversations", args) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_search_words_must_be_in_the_message_as_shown(start, intercom):
    """Intercom matches the raw body, where 100 holds a hidden link label."""
    executor = await start({SUPPORT: ("read",)})
    outcome = await executor.invoke("intercom_search_conversations", {"inbox": SUPPORT, "text": "merger"})
    assert intercom.searches and _items(outcome) == []
    outcome = await executor.invoke("intercom_search_conversations", {"inbox": SUPPORT, "text": "DOCS"})
    assert [c["id"] for c in _items(outcome)] == ["100"]


@pytest.mark.django_db(transaction=True)
async def test_a_conversation_too_large_to_read_is_refused_like_an_unseen_one(start, intercom):
    executor = await start({SUPPORT: ("read",)})

    def huge(method: str, path: str, body: dict | None):
        if method == "GET" and path == "/conversations/100":
            return httpx.Response(200, content=b"x" * (client_module.MAX_RESPONSE + 1))
        return None

    intercom.hook = huge
    assert await refusal(executor, "intercom_get_conversation", {"conversation": "100"}) == "POLICY_DENIED"
    outcome = await executor.invoke("intercom_search_conversations", {"inbox": SUPPORT})
    assert _items(outcome) == []


@pytest.mark.django_db(transaction=True)
async def test_the_no_team_inbox_searches_for_team_zero(start, intercom):
    executor = await start({"none": ("read",)})
    outcome = await executor.invoke(
        "intercom_search_conversations", {"inbox": "none", "updated_after": "2026-09-21"}
    )
    assert [c["id"] for c in _items(outcome)] == ["102", "103"]
    # A date without a zone is midnight UTC.
    assert intercom.searches[-1]["query"]["value"] == [
        {"field": "team_assignee_id", "operator": "=", "value": 0},
        {"field": "updated_at", "operator": ">", "value": 1789948800},
    ]
    assert _items(outcome)[0]["state"] == "closed"


@pytest.mark.django_db(transaction=True)
async def test_search_pages_are_run_bound(start, intercom):
    for n in range(104, 108):
        intercom.conversations[str(n)] = _conversation(str(n), 1, f"Case {n}", "<p>case</p>")
    executor = await start({SUPPORT: ("read",)})
    first = await executor.invoke("intercom_search_conversations", {"inbox": SUPPORT, "limit": 3})
    assert [c["id"] for c in _items(first)] == ["100", "104", "105"]
    args = {"inbox": SUPPORT, "limit": 3, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("intercom_search_conversations", args)
    assert [c["id"] for c in _items(second)] == ["106", "107"] and "next_cursor" not in second.result
    assert intercom.searches[-1]["pagination"] == {"per_page": 3, "starting_after": f"{TOKEN}3"}
    other = args | {"state": "open"}
    assert await refusal(executor, "intercom_search_conversations", other) == "INVALID_CURSOR"

    # A cursor Intercom no longer takes.
    def rejected(method: str, path: str, body: dict | None):
        if path.endswith("/search") and "starting_after" in body["pagination"]:
            return FakeIntercom._error(400, "parameter_invalid")
        return None

    intercom.hook = rejected
    assert await refusal(executor, "intercom_search_conversations", args) == "INVALID_CURSOR"
    intercom.hook = lambda method, path, body: (
        FakeIntercom._error(400, "parameter_invalid") if path.endswith("/search") else None
    )
    assert await refusal(executor, "intercom_search_conversations", {"inbox": SUPPORT}) == "INVALID_ARGUMENTS"


async def test_search_answers_are_checked(intercom):
    def answer(page: dict):
        intercom.hook = lambda method, path, body: (
            httpx.Response(200, json=page) if path.endswith("/search") else None
        )

    client = intercom.client()
    answer({"conversations": [{"id": "1"}], "pages": {"next": {"starting_after": "a b"}}})
    with pytest.raises(OperationError) as caught:
        await client.search({}, per_page=1, starting_after=None)
    assert caught.value.code == "PROVIDER_LIMIT"
    answer({"conversations": [{"id": "../me"}]})
    with pytest.raises(OperationError) as caught:
        await client.search({}, per_page=1, starting_after=None)
    assert caught.value.code == "PROVIDER_FAILED"


# Writing


@pytest.mark.django_db(transaction=True)
async def test_notes_and_replies_are_escaped_and_sent_as_the_teammate(start, intercom):
    executor = await start({SUPPORT: ("read", "note", "reply")})
    outcome = await executor.invoke(
        "intercom_add_note",
        {"conversation": "100", "text": "Looked at <b>logs</b>.\nAll fine.\n\nNext: deploy"},
    )
    assert _items(outcome) == [
        {
            "written": True,
            "conversation_id": "100",
            "inbox": SUPPORT,
            "part_id": "301",
            "created": "2026-09-21T17:03:20Z",
        }
    ]
    outcome = await executor.invoke("intercom_reply", {"conversation": "100", "text": "Fixed, thanks!"})
    assert _items(outcome)[0]["part_id"] == "302"
    assert intercom.writes == [
        (
            "100",
            {
                "message_type": "note",
                "type": "admin",
                "admin_id": ADMIN,
                "body": "<p>Looked at &lt;b&gt;logs&lt;/b&gt;.<br>All fine.</p><p>Next: deploy</p>",
            },
        ),
        (
            "100",
            {"message_type": "comment", "type": "admin", "admin_id": ADMIN, "body": "<p>Fixed, thanks!</p>"},
        ),
    ]
    for text in (
        "see https://app.intercom.com/a/inbox/x/conversation/101",
        "APP%2EINTERCOM%2ECOM/x",
        "intercom:x",
        "bell \x07",
    ):
        args = {"conversation": "100", "text": text}
        assert await refusal(executor, "intercom_reply", args) == "INVALID_ARGUMENTS"
    assert (
        await refusal(executor, "intercom_add_note", {"conversation": "101", "text": "x"}) == "POLICY_DENIED"
    )
    assert len(intercom.writes) == 2


@pytest.mark.django_db(transaction=True)
async def test_replying_and_noting_are_separate_permissions(start, intercom):
    executor = await start({SUPPORT: ("read", "note"), "none": ("read", "reply")})
    assert {t for t in executor.context.tools if t.startswith("intercom_")} == {
        "intercom_list_inboxes",
        "intercom_search_conversations",
        "intercom_get_conversation",
        "intercom_add_note",
        "intercom_reply",
    }
    assert await refusal(executor, "intercom_reply", {"conversation": "100", "text": "x"}) == "POLICY_DENIED"
    assert (
        await refusal(executor, "intercom_add_note", {"conversation": "102", "text": "x"}) == "POLICY_DENIED"
    )
    await executor.invoke("intercom_add_note", {"conversation": "100", "text": "x"})
    await executor.invoke("intercom_reply", {"conversation": "102", "text": "x"})
    assert [(conversation, body["message_type"]) for conversation, body in intercom.writes] == [
        ("100", "note"),
        ("102", "comment"),
    ]


@pytest.mark.django_db(transaction=True)
async def test_a_conversation_reassigned_after_authorizing_is_refused(start, intercom):
    executor = await start({SUPPORT: ("read", "note", "reply")})
    conversation = intercom.conversations["100"]

    def move(method: str, path: str, body: dict | None):
        # Intercom answers the read that authorizes, then the conversation moves to Billing.
        if method == "GET" and path.endswith("/conversations/100") and conversation["team_assignee_id"] == 1:
            response = httpx.Response(200, json=copy.deepcopy(conversation))
            conversation["team_assignee_id"] = 2
            return response
        return None

    intercom.hook = move
    assert (
        await refusal(executor, "intercom_reply", {"conversation": "100", "text": "x"})
        == "CONVERSATION_MOVED"
    )
    conversation["team_assignee_id"] = 1

    authorized: list[bool] = []

    def lost(method: str, path: str, body: dict | None):
        # Intercom answers the read that authorizes, then access to the conversation is lost.
        if method == "GET" and path.endswith("/conversations/100"):
            if authorized:
                return FakeIntercom._error(403, "forbidden")
            authorized.append(True)
        return None

    intercom.hook = lost
    assert (
        await refusal(executor, "intercom_add_note", {"conversation": "100", "text": "x"})
        == "CONVERSATION_MOVED"
    )
    assert not intercom.writes


@pytest.mark.django_db(transaction=True)
async def test_a_write_names_the_inbox_the_conversation_is_in_afterwards(start, intercom):
    executor = await start({SUPPORT: ("read", "note")})

    def reassigned(method: str, path: str, body: dict | None):
        # An assignment rule moves the conversation to Billing as the note lands.
        if method == "POST" and path.endswith("/reply"):
            intercom.writes.append(("100", body))
            moved = copy.deepcopy(intercom.conversations["100"]) | {"team_assignee_id": 2, "title": SECRET}
            return httpx.Response(200, json=moved)
        return None

    intercom.hook = reassigned
    outcome = await executor.invoke("intercom_add_note", {"conversation": "100", "text": "x"})
    assert _items(outcome) == [] and SECRET not in json.dumps(outcome.result)
    assert len(intercom.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_a_reply_without_the_new_part_still_counts(start, intercom):
    executor = await start({SUPPORT: ("read", "reply")})

    def bare(method: str, path: str, body: dict | None):
        if method == "POST" and path.endswith("/reply"):
            intercom.writes.append(("100", body))
            found = copy.deepcopy(intercom.conversations["100"])
            found["conversation_parts"] = {"conversation_parts": [], "total_count": 0}
            return httpx.Response(200, json=found)
        return None

    intercom.hook = bare
    outcome = await executor.invoke("intercom_reply", {"conversation": "100", "text": "x"})
    assert _items(outcome)[0]["part_id"] is None

    def broken(method: str, path: str, body: dict | None):
        if method == "POST" and path.endswith("/reply"):
            intercom.writes.append(("100", body))
            return httpx.Response(200, json={"type": "conversation"})
        return None

    intercom.hook = broken
    outcome = await executor.invoke("intercom_reply", {"conversation": "100", "text": "y"})
    assert outcome.result["outcome"] == "applied_without_result"


@pytest.mark.django_db(transaction=True)
async def test_an_earlier_part_is_not_taken_for_the_one_written(start, intercom):
    """Intercom answers with parts from before the write only: Ada's earlier note 202 is not the new one."""
    executor = await start({SUPPORT: ("read", "note")})

    def unchanged(method: str, path: str, body: dict | None):
        if method == "POST" and path.endswith("/reply"):
            intercom.writes.append(("100", body))
            return httpx.Response(200, json=intercom.conversations["100"])
        return None

    intercom.hook = unchanged
    outcome = await executor.invoke("intercom_add_note", {"conversation": "100", "text": "x"})
    assert _items(outcome)[0]["part_id"] is None and _items(outcome)[0]["created"] is None

    def twice(method: str, path: str, body: dict | None):
        if method == "POST" and path.endswith("/reply"):
            intercom.writes.append(("100", body))
            found = copy.deepcopy(intercom.conversations["100"])
            listed = found["conversation_parts"]["conversation_parts"]
            listed += [_part("310", "note", ADA, "<p>x</p>"), _part("311", "note", ADA, "<p>other</p>")]
            return httpx.Response(200, json=found)
        return None

    intercom.hook = twice
    outcome = await executor.invoke("intercom_add_note", {"conversation": "100", "text": "y"})
    assert _items(outcome)[0]["part_id"] is None


# Text


def test_html_is_read_as_text_without_links_to_intercom():
    assert (
        html.read('<a href="https://www.intercom.com/x">a <b>label</b></a> after') == "[Intercom link] after"
    )
    assert (
        html.read('<a href="https://example.com" href="https://app.intercom.com">x</a>') == "[Intercom link]"
    )
    assert html.read('<a href="https://intercom-attachments-1.com/f">f</a>') == "[Intercom link]"
    assert html.read("<p>one</p><ul><li>two</li><li>three</li></ul>") == "one\n- two\n- three"
    assert html.read("<p>see app.intercom.com/a/x</p>") == "see [Intercom link]"
    assert html.read(f"<p>open</p><script>{SECRET}") == "open"
    assert html.read(f"<svg><svg></svg>{SECRET}</svg>shown") == "shown"
    assert html.read('<a href="https://example.com">https://example.com</a>') == "https://example.com"
    for host in (
        "intercomassets.com",
        "static.intercomassets.eu",
        "x.intercomcdn.eu",
        "intercomusercontent.com",
        "intercom-attachments.eu",
    ):
        assert html.read(f'<a href="https://{host}/f">{SECRET}</a>') == "[Intercom link]"
    # Relative links resolve against Intercom's own pages.
    for href in (
        "/a/inbox/abc123/conversation/101",
        "conversation/101",
        "//app.intercom.com/x",
        "java\tscript:x",
    ):
        assert html.read(f'<a href="{href}">{SECRET}</a>') == "[Intercom link]"
    assert html.read(f'<a href="mailto:a@example.com">{SECRET}</a>') != "[Intercom link]"
    assert html.read(f'<a href="">{SECRET}</a>') == html.read(f"<a href>{SECRET}</a>") == "[Intercom link]"
    assert html.read("<a>plain</a>") == "plain"
    assert html.read(None) == ""
    assert html.written("a & b\r\n\r\n\r\nc") == "<p>a &amp; b</p><p>c</p>"
