"""Notion connector against an in-memory Notion API, and runs through the executor."""

import json
from uuid import UUID, uuid4

import httpx
import pytest
from asgiref.sync import sync_to_async

from agents.models import Agent
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.executor import Executor, RunContext
from connectors.notion import markdown as page_text
from connectors.notion import pages
from connectors.notion.client import NotionClient
from connectors.notion.connector import NotionConnector
from connectors.notion.pages import canonical
from connectors.notion.properties import check_filter, readable, writable
from conversations.models import Conversation
from permissions.models import Grant, PermissionLayer
from permissions.services import GrantChange, apply_grant_changes
from runs import services
from workspaces.tenancy import workspace_scope

NAMES = [
    "workspace",
    "home",
    "private",
    "projects",
    "source",
    "row1",
    "row2",
    "column_list",
    "column",
    "in_column",
    "orphan",
    "ghost",
    "linked",
    "synced",
    "stray",
]
ID = {name: str(UUID(int=i + 1)) for i, name in enumerate(NAMES)}
NAME = {v: k for k, v in ID.items()}
BOT = str(UUID(int=999))


def _url(name: str) -> str:
    return f"https://www.notion.so/{name}-{ID[name].replace('-', '')}"


def _text(value: str) -> list[dict]:
    return [{"type": "text", "plain_text": value, "text": {"content": value}}]


def _title(value: str) -> dict:
    return {"title": {"id": "title", "type": "title", "title": _text(value)}}


def _page(name: str, parent: dict, title: str, **properties) -> dict:
    return {
        "object": "page",
        "id": ID[name],
        "parent": parent,
        "url": _url(name),
        "in_trash": False,
        "created_time": "2026-09-01T00:00:00.000Z",
        "last_edited_time": "2026-09-02T00:00:00.000Z",
        "properties": {"Name" if properties else "title": _title(title)["title"], **properties},
    }


def _in_page(name: str) -> dict:
    return {"type": "page_id", "page_id": ID[name]}


IN_SOURCE = {"type": "data_source_id", "data_source_id": ID["source"], "database_id": ID["projects"]}
SCHEMA = {
    "Name": {"id": "title", "type": "title", "title": {}},
    "Status": {
        "id": "st",
        "type": "status",
        "status": {"options": [{"name": "Todo"}, {"name": "Done"}]},
    },
    "Tags": {"id": "tg", "type": "multi_select", "multi_select": {"options": [{"name": "a"}, {"name": "b"}]}},
    "Due": {"id": "du", "type": "date", "date": {}},
    "Budget": {"id": "bu", "type": "formula", "formula": {"expression": "secret"}},
    "Owner": {"id": "pp", "type": "people", "people": {}},
    "Related": {"id": "rl", "type": "relation", "relation": {}},
}


def _row(name: str, title: str, status: str) -> dict:
    return _page(
        name,
        IN_SOURCE,
        title,
        Status={"id": "st", "type": "status", "status": {"name": status}},
        Budget={"id": "bu", "type": "formula", "formula": {"type": "number", "number": 1000}},
        Owner={"id": "pp", "type": "people", "people": [{"id": "u1", "name": "Grace"}]},
    )


class FakeNotion:
    """The Notion API, served through httpx.MockTransport.

    Workspace: Home (Private, Projects database with rows row1 and row2, a column holding in_column, a
    linked view of Projects, and a page showing synced content). Shared without its parent: orphan.
    """

    def __init__(self) -> None:
        home_md = "\n".join(
            [
                "# Home",
                "Intro line",
                f'<page url="{_url("private")}">Private plans</page>',
                f'<database url="{_url("projects")}">Projects</database>',
                "Repeated",
                "middle",
                "Repeated",
                "End",
            ]
        )
        self.pages = {
            ID["home"]: _page("home", {"type": "workspace", "workspace": True}, "Home"),
            ID["private"]: _page("private", _in_page("home"), "Private plans"),
            ID["row1"]: _row("row1", "Launch", "Todo"),
            ID["row2"]: _row("row2", "Secret launch", "Done"),
            ID["in_column"]: _page("in_column", {"type": "block_id", "block_id": ID["column"]}, "In column"),
            ID["orphan"]: _page("orphan", _in_page("ghost"), "Orphan"),
            ID["synced"]: _page("synced", _in_page("home"), "Synced"),
        }
        self.databases = {
            ID["projects"]: {
                "object": "database",
                "id": ID["projects"],
                "parent": _in_page("home"),
                "title": _text("Projects"),
                "url": _url("projects"),
                "data_sources": [{"id": ID["source"], "name": "Projects"}],
            },
            ID["linked"]: {
                "object": "database",
                "id": ID["linked"],
                "parent": _in_page("home"),
                "title": _text("Linked projects"),
                "url": _url("linked"),
                "data_sources": [{"id": ID["source"], "name": "Projects"}],
            },
        }
        self.sources = {
            ID["source"]: {
                "object": "data_source",
                "id": ID["source"],
                "parent": {"type": "database_id", "database_id": ID["projects"]},
                "title": _text("Projects"),
                "properties": SCHEMA,
            }
        }
        self.blocks = {
            ID["column"]: {
                "object": "block",
                "id": ID["column"],
                "parent": {"type": "block_id", "block_id": ID["column_list"]},
            },
            ID["column_list"]: {"object": "block", "id": ID["column_list"], "parent": _in_page("home")},
        }
        self.markdown = {
            ID["home"]: home_md,
            ID["private"]: "Top secret",
            ID["row1"]: "Row body",
            ID["row2"]: "Secret row body",
            ID["in_column"]: "Column text",
            ID["orphan"]: "Orphan text",
            ID[
                "synced"
            ]: f'Before\n<synced_block_reference url="{_url("private")}">\nTop secret\n</synced_block_reference>\nAfter',
        }
        self.comments = [
            {
                "id": "c1",
                "discussion_id": "d1",
                "parent": _in_page("home"),
                "rich_text": _text("Nice"),
                "created_by": {"id": "u1"},
            },
            {
                "id": "c2",
                "discussion_id": "d2",
                "parent": {"type": "block_id", "block_id": ID["column"]},
                "rich_text": _text("On a block"),
            },
        ]
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, str, dict]] = []
        self.hook = None
        self.created = 0

    def _error(self, status: int, code: str) -> httpx.Response:
        return httpx.Response(
            status, json={"object": "error", "status": status, "code": code, "message": "x"}
        )

    def _search(self, body: dict) -> list[dict]:
        query = (body.get("query") or "").casefold()
        found = [
            p
            for p in self.pages.values()
            if query
            in p["properties"].get("Name", p["properties"].get("title"))["title"][0]["plain_text"].casefold()
        ]
        found += [s for s in self.sources.values() if query in s["title"][0]["plain_text"].casefold()]
        return found

    def _paged(self, items: list[dict], body: dict) -> httpx.Response:
        start = int((body.get("start_cursor") or "c0").removeprefix("c"))
        end = start + body["page_size"]
        more = end < len(items)
        return httpx.Response(
            200,
            json={"results": items[start:end], "has_more": more, "next_cursor": f"c{end}" if more else None},
        )

    def _create(self, body: dict) -> httpx.Response:
        self.created += 1
        for value in body["properties"].values():
            for item in value.get("title", []):
                item["plain_text"] = item["text"]["content"]
        new_id = str(UUID(int=500 + self.created))
        parent = body["parent"]
        if "data_source_id" in parent:
            source = self.sources[parent["data_source_id"]]
            parent = {**parent, "type": "data_source_id", "database_id": source["parent"]["database_id"]}
        else:
            parent = {"type": "page_id", **parent}
        page = {
            "object": "page",
            "id": new_id,
            "parent": parent,
            "url": f"https://www.notion.so/{new_id.replace('-', '')}",
            "properties": {
                name: {"type": next(k for k in value if k != "id"), **value}
                for name, value in body["properties"].items()
            },
        }
        self.pages[new_id] = page
        self.markdown[new_id] = body.get("markdown", "")
        return httpx.Response(200, json=page)

    def _update_markdown(self, page_id: str, body: dict) -> httpx.Response:
        text = self.markdown[page_id]
        if body["type"] == "insert_content":
            text += "\n" + body["insert_content"]["content"]
        else:
            for update in body["update_content"]["content_updates"]:
                if text.count(update["old_str"]) != 1:
                    return self._error(400, "validation_error")
                text = text.replace(update["old_str"], update["new_str"])
        self.markdown[page_id] = text
        return httpx.Response(200, json={"object": "page_markdown", "id": page_id, "markdown": text})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.hook:
            self.hook(request)
        assert request.headers["Notion-Version"] == "2026-03-11"
        body = json.loads(request.content) if request.content else {}
        if request.method in {"PATCH", "POST"} and not request.url.path.endswith(("/search", "/query")):
            self.writes.append((request.method, request.url.path, json.loads(request.content)))
        match (request.method, request.url.path.split("/")[2:]):
            case ("GET", ["users", "me"]):
                bot = {"workspace_id": ID["workspace"], "workspace_name": "Acme"}
                return httpx.Response(200, json={"object": "user", "id": BOT, "type": "bot", "bot": bot})
            case ("GET", ["pages", object_id]):
                if object_id in self.databases:
                    return self._error(400, "validation_error")
                if object_id in self.pages:
                    return httpx.Response(200, json=self.pages[object_id])
            case ("GET", ["pages", object_id, "markdown"]) if object_id in self.markdown:
                return httpx.Response(
                    200,
                    json={"object": "page_markdown", "id": object_id, "markdown": self.markdown[object_id]},
                )
            case ("PATCH", ["pages", object_id, "markdown"]) if object_id in self.markdown:
                return self._update_markdown(object_id, body)
            case ("PATCH", ["pages", object_id]) if object_id in self.pages:
                page = self.pages[object_id]
                for name, value in body["properties"].items():
                    page["properties"][name] = {**page["properties"].get(name, {}), **value}
                return httpx.Response(200, json=page)
            case ("POST", ["pages"]):
                return self._create(body)
            case ("GET", ["databases", object_id]):
                if object_id in self.pages:
                    return self._error(400, "validation_error")
                if object_id in self.databases:
                    return httpx.Response(200, json=self.databases[object_id])
            case ("GET", ["data_sources", object_id]) if object_id in self.sources:
                return httpx.Response(200, json=self.sources[object_id])
            case ("POST", ["data_sources", object_id, "query"]) if object_id in self.sources:
                # Everything with a data source parent, so the connector must pick out its own rows.
                rows = [p for p in self.pages.values() if "data_source_id" in p["parent"]]
                return self._paged(rows, body)
            case ("GET", ["blocks", object_id]) if object_id in self.blocks:
                return httpx.Response(200, json=self.blocks[object_id])
            case ("POST", ["search"]):
                return self._paged(self._search(body), body)
            case ("GET", ["comments"]):
                return httpx.Response(200, json={"results": self.comments, "has_more": False})
            case ("POST", ["comments"]):
                comment = {
                    "id": "c9",
                    "discussion_id": "d9",
                    "parent": {"type": "page_id", **body["parent"]},
                    "rich_text": _text(body["markdown"]),
                }
                return httpx.Response(200, json=comment)
        return self._error(404, "object_not_found")

    def client(self) -> NotionClient:
        return NotionClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def notion() -> FakeNotion:
    return FakeNotion()


@pytest.fixture
def start(scoped, user, notion, monkeypatch):
    """Starts a run for an agent with the user's Notion connection, holding `grants`."""
    monkeypatch.setattr(NotionConnector, "client", lambda self, token: notion.client())

    def start_(grants: dict[str, tuple[str, ...]]) -> Executor:
        with workspace_scope(scoped.id):
            connection = Connection.objects.filter(provider="notion").first() or Connection(
                provider="notion", owner=user, label="Acme", external_account_id=ID["workspace"]
            )
            connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": []})
            connection.save()
            Grant.objects.filter(connection=connection, layer__level=PermissionLayer.Level.USER).delete()
            changes = [GrantChange("page", ID.get(name, name), actions) for name, actions in grants.items()]
            if changes:
                apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})
            agent = Agent.objects.get()
            agent.connections.set([connection])
            conversation = Conversation.objects.create(agent=agent, user=user)
            _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
        services.claim_queued(10)
        run.refresh_from_db()
        return Executor(RunContext.from_run(run))

    return sync_to_async(start_)


def _ceiling(name: str, effect: str, actions=("read",)):
    def create() -> None:
        Grant.objects.create(
            layer=PermissionLayer.unscoped.get(level=PermissionLayer.Level.CEILING),
            connection=Connection.unscoped.get(provider="notion"),
            resource_kind="page",
            resource_id=ID[name],
            actions=list(actions),
            effect=effect,
        )

    return sync_to_async(create)


def _names(outcome) -> list[str]:
    return [NAME.get(item["id"], item["id"]) for item in outcome.result["items"]]


async def _refused(executor, tool, args) -> str:
    with pytest.raises(OperationError) as caught:
        await executor.invoke(tool, args)
    return caught.value.code


# Ids and links


def test_ids_are_canonical_and_links_are_parsed():
    plain = "0000000000000000000000000000000a"
    assert canonical(plain) == "00000000-0000-0000-0000-00000000000a"
    assert canonical(plain.upper()) == canonical(plain)
    assert canonical("nope") is None
    for value in (
        plain,
        f"https://www.notion.so/acme/Plan-{plain}",
        f"https://notion.so/Plan-{plain}?pvs=4",
        f"https://acme.notion.site/{plain}",
    ):
        assert pages._object_id(value) == canonical(plain)
    for value in (
        "https://evil.example/" + plain,
        "http://www.notion.so/" + plain,
        "https://www.notion.so/x",
    ):
        with pytest.raises(ValueError):
            pages._object_id(value)


def test_markdown_hides_other_pages():
    notion = FakeNotion()
    shown = page_text.redact(notion.markdown[ID["home"]])
    assert "Private plans" not in shown and "Projects" not in shown
    # Notion addresses carry the page's title; they are shortened to its id.
    assert f'<page url="https://www.notion.so/{ID["private"].replace("-", "")}"></page>' in shown
    assert page_text.redact("[x](https://acme.notion.site/Secret-deal-" + "a" * 32 + "?pvs=4)") == (
        "[x](https://www.notion.so/" + "a" * 32 + ")"
    )
    synced = page_text.redact(notion.markdown[ID["synced"]])
    assert "Top secret" not in synced and page_text.SYNCED_HIDDEN in synced
    assert page_text.redact("<synced_block_reference url='x'>\nleft open") == (
        f"<synced_block_reference>{page_text.SYNCED_HIDDEN}</synced_block_reference>"
    )
    assert page_text.redact('a <mention-page url="u">Secret</mention-page> b') == (
        'a <mention-page url="u"></mention-page> b'
    )


def test_redaction_fails_closed():
    long_title = "x" * 5000
    assert page_text.redact(f'<page url="u">{long_title}</page> after') == '<page url="u"></page> after'
    assert page_text.redact('<mention-page url="u" title="Secret">\nSecret\n</mention-page>') == (
        '<mention-page url="u"></mention-page>'
    )
    # A tag left open hides the rest of the page.
    assert page_text.redact("a <page>Secret\nmore") == "a <page></page>"
    # Synced content may contain its own closing tag as text.
    synced = (
        "Mine\n<synced_block_reference url='x'>\n```xml\n</synced_block_reference>\n```\n"
        "Secret acquisition plan\n</synced_block_reference>\nAfter"
    )
    shown = page_text.redact(synced)
    assert "Secret" not in shown and shown.startswith("Mine\n") and shown.endswith("\nAfter")


@pytest.mark.parametrize(
    "text",
    [
        "![x](https://evil.example/p.png)",
        '<page url="https://www.notion.so/x">Moved</page>',
        "<DATABASE>x</DATABASE>",
        '<synced_block_reference url="https://www.notion.so/x"></synced_block_reference>',
        '<mention-user url="user://1"/>',
        '<video src="https://evil.example/v.mp4"></video>',
        '<callout icon="x" src="https://evil.example/">hi</callout>',
        '<mention-page url="https://evil.example/x">t</mention-page>',
        "<embed>x</embed>",
    ],
)
def test_written_text_may_only_add_words(text):
    with pytest.raises(ValueError):
        page_text.check_written(text)


def test_written_text_allows_plain_markdown_and_notion_mentions():
    for text in (
        "# Title\n- [link](https://example.com)\n<callout>Note</callout>",
        '<mention-page url="https://www.notion.so/x-0000000000000000000000000000000a"/>',
        "a < b and c > d",
    ):
        assert page_text.check_written(text) == text


def test_edits_are_anchored_to_whole_visible_lines():
    markdown = FakeNotion().markdown[ID["home"]]
    [update] = page_text.plan_edits(markdown, [("Intro", "Opening")])
    assert update == {"old_str": "\nIntro line\n", "new_str": "\nOpening line\n"}
    # "Repeated" is twice in the page: an edit there widens until its lines are unique.
    with pytest.raises(OperationError) as twice:
        page_text.plan_edits(markdown, [("Repeated", "x")])
    assert twice.value.code == "EDIT_NOT_APPLIED"
    [widened] = page_text.plan_edits(markdown, [("Repeated\nEnd", "Done\nEnd")])
    assert widened["old_str"] == "\nRepeated\nEnd" and widened["new_str"] == "\nDone\nEnd"
    # Titles the agent was not shown never match, and lines linking to child pages are not edited.
    for old in ("Private plans", "Projects</database>", "</page>"):
        with pytest.raises(OperationError) as hidden:
            page_text.plan_edits(markdown, [(old, "x")])
        assert hidden.value.code == "EDIT_NOT_APPLIED"
    # Edits apply in order.
    _, second = page_text.plan_edits(markdown, [("Intro", "Opening"), ("Opening", "Start")])
    assert second["old_str"] == "\nOpening line\n"


@pytest.mark.parametrize(
    ("markdown", "old", "new"),
    [
        # Joining the agent's text with the page's into an image.
        ("Start\nX[caption](https://evil.example/p.png)\nEnd", "X", "!"),
        # A tag the page shows as text, completed on the next line.
        ("Start\nA\nsrc=https://evil.example/p.png>\nEnd", "A", "<img"),
        # Removing a code fence turns what it shows as code into markup.
        ('Start\n```xml\n<img src="https://evil.example/p.png">\n```\nEnd', "```xml", "Code:"),
        # Unpairing backticks.
        ("Start\nsee `a\nb` here\nEnd", "see `a", "see a"),
        # Lines that already hold content Minerva does not write.
        ("Start\nText ![i](https://example.com/i.png)\nEnd", "Text", "Words"),
    ],
)
def test_edits_cannot_make_markup_from_page_text(markdown, old, new):
    with pytest.raises(OperationError) as refused:
        page_text.plan_edits(markdown, [(old, new)])
    assert refused.value.code == "EDIT_NOT_APPLIED"


def test_edits_may_write_inline_code_and_keep_fences():
    markdown = "Start\n```py\nx = 1\n```\nEnd"
    [update] = page_text.plan_edits(markdown, [("x = 1", "x = 2")])
    assert update["new_str"] == "\nx = 2\n"
    [update] = page_text.plan_edits(markdown, [("End", "Use `x` here")])
    assert update["new_str"] == "\nUse `x` here"


def test_property_values_are_checked_against_the_schema():
    converted = writable(SCHEMA, {"Name": "x", "Status": "Done", "Tags": ["a"], "Due": "2026-10-01"})
    assert converted["Status"] == {"status": {"name": "Done"}}
    assert converted["Due"] == {"date": {"start": "2026-10-01"}}
    for values in (
        {"Status": "Shipped"},
        {"Tags": ["a", "a"]},
        {"Due": "tomorrow"},
        {"Owner": ["u1"]},
        {"Related": []},
        {"Budget": 1},
        {"Missing": 1},
        {"Name": 3},
    ):
        with pytest.raises(OperationError) as caught:
            writable(SCHEMA, values)
        assert caught.value.code == "INVALID_ARGUMENTS", values
    # Notion reads property keys as names or ids, so a name that is another property's id is refused.
    tricky = {**SCHEMA, "bu": {"id": "zz", "type": "number", "number": {}}}
    with pytest.raises(OperationError):
        writable(tricky, {"bu": 1})


def test_malformed_properties_are_skipped_and_truncation_is_shown():
    assert readable({"X": {"type": []}, "Y": [], 1: {"type": "number"}}) == {}
    assert writable({"Name": {"id": [], "type": "title"}}, {"Name": "x"}) == {
        "Name": {"title": [{"type": "text", "text": {"content": "x"}}]}
    }
    related = {"Related": {"type": "relation", "relation": [{"id": "a"}], "has_more": True}}
    assert readable(related) == {"Related": {"items": ["a"], "more": True}}
    # A row's editor may not be allowed to read its database, which lists the options.
    with pytest.raises(OperationError) as refused:
        writable(SCHEMA, {"Status": "Shipped"})
    assert "Todo" not in refused.value.message


def test_filters_use_only_readable_properties():
    check_filter(SCHEMA, {"and": [{"property": "Status", "status": {"equals": "Done"}}, {"property": "tg"}]})
    check_filter(SCHEMA, [{"timestamp": "created_time", "direction": "descending"}])
    for value in (
        {"property": "Budget", "formula": {"number": {"greater_than": 10}}},
        {"or": [{"property": "bu"}]},
        {"property": "Missing"},
        [{"property": "Budget", "direction": "ascending"}],
    ):
        with pytest.raises(OperationError):
            check_filter(SCHEMA, value)
    nested: dict = {"property": "Status"}
    for _ in range(10):
        nested = {"and": [nested]}
    with pytest.raises(OperationError):
        check_filter(SCHEMA, nested)


# Connecting


async def test_account_discovery_and_names(notion):
    connector = NotionConnector()
    client = notion.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (ID["workspace"], "Acme")
    found = await connector.discover(client, "page", query="launch", cursor=None)
    assert [(NAME[i.id], i.name) for i in found.items] == [("row1", "Launch"), ("row2", "Secret launch")]
    found = await connector.discover(client, "page", query="projects", cursor=None)
    assert [(NAME[i.id], i.name) for i in found.items] == [("projects", "Projects (database)")]
    with pytest.raises(OperationError) as bad:
        await connector.discover(client, "page", query=None, cursor="../x")
    assert bad.value.code == "INVALID_CURSOR"
    names = await connector.describe(client, "page", [ID["home"], ID["projects"], ID["ghost"], "*"])
    assert names == {ID["home"]: "Home", ID["projects"]: "Projects (database)"}


FLOW = {"client_id": "id", "verifier": "v"}


@pytest.fixture
def token_endpoint(monkeypatch):
    sent: list[dict] = []
    responses: list[httpx.Response] = []
    creds = ClientCredentials("id", "secret", "https://x/cb")
    monkeypatch.setattr(connection_oauth, "client_credentials", lambda connector: creds)
    monkeypatch.setattr(connection_oauth, "issuing_client", lambda connector, client_id: creds)

    def post(url, **kwargs):
        sent.append({"url": url, **kwargs})
        return responses.pop(0)

    monkeypatch.setattr(connection_oauth.httpx, "post", post)
    return sent, responses


def test_notion_token_requests_use_basic_auth_and_json(token_endpoint):
    sent, responses = token_endpoint
    connector = registry.get("notion")
    responses.append(httpx.Response(200, json={"access_token": "a", "refresh_token": "r", "bot_id": "b"}))
    tokens = connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    assert (tokens["access_token"], tokens["refresh_token"]) == ("a", "r")
    [request] = sent
    assert request["url"] == "https://api.notion.com/v1/oauth/token"
    assert request["json"] == {
        "code": "c",
        "redirect_uri": "https://x/cb",
        "grant_type": "authorization_code",
    }
    assert "data" not in request
    auth = request["auth"]
    assert isinstance(auth, httpx.BasicAuth)
    built = next(auth.auth_flow(httpx.Request("POST", "https://x")))
    assert built.headers["Authorization"].startswith("Basic ")


def test_notion_authorization_url_has_no_scope_or_pkce(monkeypatch):
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    session: dict = {}
    url = connection_oauth.authorization_url(session, workspace_id=uuid4(), provider="notion")
    params = httpx.URL(url).params
    assert url.startswith("https://api.notion.com/v1/oauth/authorize?")
    assert params["owner"] == "user" and params["response_type"] == "code"
    assert "scope" not in params and "code_challenge" not in params


# Runs


@pytest.mark.django_db(transaction=True)
async def test_a_grant_on_a_page_covers_what_is_inside_it(start, notion):
    executor = await start({"home": ("read",)})
    for name in ("home", "private", "row1", "in_column"):
        outcome = await executor.invoke("notion_get_page", {"page_id": ID[name]})
        assert _names(outcome) == [name]
    column = await executor.invoke("notion_get_page", {"page_id": ID["in_column"]})
    assert column.result["items"][0]["parent_id"] == ID["home"]
    # A link works as well as an id.
    outcome = await executor.invoke("notion_read_page", {"page_id": _url("private")})
    assert outcome.result["items"][0]["text"] == "Top secret"
    # The orphan's parent cannot be seen; a missing page looks like one without a grant.
    for page_id in (ID["orphan"], ID["ghost"]):
        assert await _refused(executor, "notion_get_page", {"page_id": page_id}) == "POLICY_DENIED"

    executor = await start({"private": ("read",)})
    assert await _refused(executor, "notion_read_page", {"page_id": ID["home"]}) == "POLICY_DENIED"
    assert not [r for r in notion.requests if r.url.path.endswith(f"{ID['home']}/markdown")]


@pytest.mark.django_db(transaction=True)
async def test_reading_hides_titles_and_synced_content(start, notion):
    executor = await start({"home": ("read",)})
    [home] = (await executor.invoke("notion_read_page", {"page_id": ID["home"]})).result["items"]
    assert "Private plans" not in home["text"] and "Intro line" in home["text"]
    assert home["title"] == "Home" and home["truncated"] is False
    [synced] = (await executor.invoke("notion_read_page", {"page_id": ID["synced"]})).result["items"]
    assert "Top secret" not in synced["text"]
    [part] = (
        await executor.invoke("notion_read_page", {"page_id": ID["home"], "offset": 2, "max_chars": 4})
    ).result["items"]
    assert (part["text"], part["truncated"]) == ("Home", True)
    assert await _refused(executor, "notion_read_page", {"page_id": ID["projects"]}) == "NOT_FOUND"


@pytest.mark.django_db(transaction=True)
async def test_search_is_filtered_by_where_pages_sit(start, notion):
    executor = await start({"projects": ("read",)})
    assert set(_names(await executor.invoke("notion_search", {"text": "launch"}))) == {"row1", "row2"}
    assert _names(await executor.invoke("notion_search", {"text": "home"})) == []

    await _ceiling("row2", Grant.Effect.DENY)()
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("notion_search", {"text": ""})
    # The orphan might sit under the denied row, so it is left out too.
    names = _names(outcome)
    assert "row2" not in names and "orphan" not in names
    assert {"home", "private", "row1", "in_column", "synced", "projects"} <= set(names)


@pytest.mark.django_db(transaction=True)
async def test_too_many_lookups_leave_ancestry_partial(start, monkeypatch):
    monkeypatch.setattr(pages, "MAX_LOOKUPS", 0)
    executor = await start({"home": ("read",)})
    # Private sits directly in Home, which needs no lookup; in_column needs its blocks looked up.
    names = _names(await executor.invoke("notion_search", {"text": ""}))
    assert "private" in names and "in_column" not in names


@pytest.mark.django_db(transaction=True)
async def test_databases_show_only_readable_properties(start, notion):
    executor = await start({"projects": ("read",)})
    [database] = (await executor.invoke("notion_get_database", {"database_id": ID["projects"]})).result[
        "items"
    ]
    [source] = database["data_sources"]
    assert source["properties"]["Status"]["options"] == ["Todo", "Done"]
    assert source["properties"]["Budget"] == {"type": "formula", "hidden": True}
    rows = await executor.invoke("notion_query_database", {"database_id": ID["projects"]})
    assert _names(rows) == ["row1", "row2"]
    assert rows.result["items"][0]["properties"] == {
        "Name": "Launch",
        "Status": "Todo",
        "Owner": ["Grace"],
    }
    query = json.loads(notion.requests[-1].content)
    assert query == {"page_size": 25, "result_type": "page"}
    filtered = {"property": "Status", "status": {"equals": "Done"}}
    await executor.invoke("notion_query_database", {"database_id": ID["projects"], "filter": filtered})
    assert json.loads(notion.requests[-1].content)["filter"] == filtered

    before = len(notion.requests)
    hidden = {"property": "Budget", "formula": {"number": {"greater_than": 10}}}
    code = await _refused(
        executor, "notion_query_database", {"database_id": ID["projects"], "filter": hidden}
    )
    assert code == "INVALID_ARGUMENTS"
    assert not [r for r in notion.requests[before:] if r.url.path.endswith("/query")]
    assert await _refused(executor, "notion_get_page", {"page_id": ID["home"]}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_a_deny_on_a_row_hides_it_and_stray_rows_are_dropped(start, notion):
    await start({})
    await _ceiling("row2", Grant.Effect.DENY)()
    other = {"type": "data_source_id", "data_source_id": ID["ghost"], "database_id": ID["ghost"]}
    notion.pages[ID["stray"]] = _page("stray", other, "Stray")
    # A row of this data source that Notion places in another database: the source was moved.
    moved = {**IN_SOURCE, "database_id": ID["ghost"]}
    notion.pages[ID["orphan"]] = _page("orphan", moved, "Moved")
    executor = await start({"projects": ("read",)})
    assert _names(await executor.invoke("notion_query_database", {"database_id": ID["projects"]})) == ["row1"]


@pytest.mark.django_db(transaction=True)
async def test_filters_cannot_probe_titles_of_mentioned_pages(start, notion):
    mention = {
        "type": "mention",
        "plain_text": "Private plans",
        "mention": {"type": "page", "page": {"id": ID["private"]}},
    }
    notion.pages[ID["row1"]]["properties"]["Name"]["title"] = [mention]
    executor = await start({"projects": ("read",)})
    unfiltered = await executor.invoke("notion_query_database", {"database_id": ID["projects"]})
    assert _names(unfiltered) == ["row1", "row2"]
    by_name = {"property": "Name", "title": {"contains": "Private"}}
    filtered = await executor.invoke(
        "notion_query_database", {"database_id": ID["projects"], "filter": by_name}
    )
    assert _names(filtered) == ["row2"]
    sorted_ = await executor.invoke(
        "notion_query_database", {"database_id": ID["projects"], "sorts": [{"property": "Name"}]}
    )
    assert _names(sorted_) == ["row2"]


@pytest.mark.django_db(transaction=True)
async def test_linked_databases_are_not_queried(start, notion):
    executor = await start({"linked": ("read",)})
    [database] = (await executor.invoke("notion_get_database", {"database_id": ID["linked"]})).result["items"]
    assert database["data_sources"] == [{"id": ID["source"], "linked_from_elsewhere": True}]
    code = await _refused(executor, "notion_query_database", {"database_id": ID["linked"]})
    assert code == "UNSUPPORTED_DATABASE"
    assert not [r for r in notion.requests if r.url.path.endswith("/query")]


@pytest.mark.django_db(transaction=True)
async def test_comments_on_the_page_itself(start, notion):
    executor = await start({"home": ("read", "comment")})
    outcome = await executor.invoke("notion_list_comments", {"page_id": ID["home"]})
    assert [c["text"] for c in outcome.result["items"]] == ["Nice"]
    added = await executor.invoke("notion_add_comment", {"page_id": ID["private"], "text": "Looks good"})
    assert added.result["items"][0]["text"] == "Looks good"
    assert notion.writes[-1] == (
        "POST",
        "/v1/comments",
        {"parent": {"page_id": ID["private"]}, "markdown": "Looks good"},
    )


@pytest.mark.django_db(transaction=True)
async def test_creating_pages_and_rows(start, notion):
    executor = await start({"home": ("read",)})
    assert "notion_create_page" not in executor.context.tools

    executor = await start({"home": ("read", "create")})
    outcome = await executor.invoke(
        "notion_create_page", {"parent_page_id": ID["home"], "title": "Notes", "markdown": "Hello"}
    )
    [created] = outcome.result["items"]
    assert (created["title"], created["parent_id"]) == ("Notes", ID["home"])
    assert notion.writes[-1][2] == {
        "parent": {"page_id": ID["home"]},
        "properties": {"title": {"title": [{"type": "text", "text": {"content": "Notes"}}]}},
        "markdown": "Hello",
    }
    row = await executor.invoke(
        "notion_create_database_row",
        {"database_id": ID["projects"], "properties": {"Name": "Ship", "Status": "Done", "Tags": ["b"]}},
    )
    assert row.result["items"][0]["parent_id"] == ID["projects"]
    assert notion.writes[-1][2]["parent"] == {"data_source_id": ID["source"]}
    assert notion.writes[-1][2]["properties"]["Tags"] == {"multi_select": [{"name": "b"}]}

    writes = len(notion.writes)
    for args in (
        {"database_id": ID["projects"], "properties": {"Owner": ["u1"]}},
        {"database_id": ID["projects"], "properties": {"Status": "New option"}},
        {"database_id": ID["projects"], "properties": {"Name": "x"}, "markdown": "![a](https://e.x/p)"},
    ):
        assert await _refused(executor, "notion_create_database_row", args) == "INVALID_ARGUMENTS"
    for args in (
        {
            "parent_page_id": ID["private"],
            "title": "x",
            "markdown": f'<page url="{_url("home")}">Home</page>',
        },
        {"parent_page_id": ID["private"], "title": "bad\ntitle"},
        {"parent_page_id": "not an id", "title": "x"},
        {"parent_page_id": f"https://evil.example/{ID['home'].replace('-', '')}", "title": "x"},
    ):
        assert await _refused(executor, "notion_create_page", args) == "INVALID_ARGUMENTS"
    assert len(notion.writes) == writes

    executor = await start({"private": ("read", "create")})
    code = await _refused(executor, "notion_create_page", {"parent_page_id": ID["home"], "title": "x"})
    assert code == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_updating_properties(start, notion):
    executor = await start({"projects": ("read", "edit")})
    outcome = await executor.invoke(
        "notion_update_page_properties", {"page_id": ID["row1"], "properties": {"Status": "Done"}}
    )
    assert outcome.result["items"][0]["properties"]["Status"] == "Done"
    assert notion.writes[-1] == (
        "PATCH",
        f"/v1/pages/{ID['row1']}",
        {"properties": {"Status": {"status": {"name": "Done"}}}},
    )
    code = await _refused(
        executor, "notion_update_page_properties", {"page_id": ID["row1"], "properties": {"Budget": 5}}
    )
    assert code == "INVALID_ARGUMENTS"

    executor = await start({"home": ("read", "edit")})
    await executor.invoke(
        "notion_update_page_properties", {"page_id": ID["private"], "properties": {"title": "Plans"}}
    )
    code = await _refused(
        executor,
        "notion_update_page_properties",
        {"page_id": ID["private"], "properties": {"Status": "Done"}},
    )
    assert code == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_editing_page_text(start, notion):
    executor = await start({"home": ("read", "edit")})
    await executor.invoke(
        "notion_edit_page", {"page_id": ID["home"], "edits": [{"old": "Intro", "new": "Opening"}]}
    )
    method, path, body = notion.writes[-1]
    assert (method, path) == ("PATCH", f"/v1/pages/{ID['home']}/markdown")
    assert body == {
        "type": "update_content",
        "update_content": {
            "content_updates": [{"old_str": "\nIntro line\n", "new_str": "\nOpening line\n"}],
            "allow_deleting_content": False,
        },
    }
    assert "Private plans" in notion.markdown[ID["home"]]
    await executor.invoke("notion_append_to_page", {"page_id": ID["home"], "markdown": "- [ ] follow up"})
    assert notion.writes[-1][2] == {
        "type": "insert_content",
        "insert_content": {"content": "- [ ] follow up", "position": {"type": "end"}},
    }

    writes = len(notion.writes)
    for edits in ([{"old": "Private plans", "new": "x"}], [{"old": "Repeated", "new": "x"}]):
        code = await _refused(executor, "notion_edit_page", {"page_id": ID["home"], "edits": edits})
        assert code == "EDIT_NOT_APPLIED"
    code = await _refused(
        executor, "notion_edit_page", {"page_id": ID["synced"], "edits": [{"old": "Before", "new": "x"}]}
    )
    assert code == "UNSUPPORTED_PAGE"
    assert len(notion.writes) == writes


@pytest.mark.django_db(transaction=True)
async def test_an_edit_notion_refuses_is_reported(start, notion):
    executor = await start({"home": ("read", "edit")})
    notion.hook = lambda request: (
        notion.markdown.update({ID["home"]: notion.markdown[ID["home"]].replace("Intro line", "Changed")})
        if request.method == "PATCH"
        else None
    )
    code = await _refused(
        executor, "notion_edit_page", {"page_id": ID["home"], "edits": [{"old": "Intro", "new": "x"}]}
    )
    assert code == "EDIT_NOT_APPLIED"


def _move_on_second_fetch(notion, name, parent):
    """Moves the page into `parent` just before Notion answers the second request for it."""
    fetches = []

    def hook(request):
        if request.method == "GET" and request.url.path.endswith(
            (f"/pages/{ID[name]}", f"/databases/{ID[name]}")
        ):
            fetches.append(request)
            if len(fetches) == 2:
                target = notion.pages.get(ID[name]) or notion.databases[ID[name]]
                target["parent"] = _in_page(parent)

    notion.hook = hook


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("tool", "args", "moved"),
    [
        ("notion_read_page", {"page_id": ID["row1"]}, "row1"),
        ("notion_edit_page", {"page_id": ID["row1"], "edits": [{"old": "Row", "new": "x"}]}, "row1"),
        ("notion_create_page", {"parent_page_id": ID["in_column"], "title": "x"}, "in_column"),
        ("notion_query_database", {"database_id": ID["projects"]}, "projects"),
    ],
)
async def test_a_page_moved_while_the_call_runs_is_refused(start, notion, tool, args, moved):
    await start({})
    await _ceiling("private", Grant.Effect.DENY, actions=("read", "create", "edit"))()
    executor = await start({"*": ("read", "create", "edit")})
    _move_on_second_fetch(notion, moved, "private")
    assert await _refused(executor, tool, args) == "PAGE_MOVED"
    assert not [r for r in notion.requests if r.url.path.endswith(("/markdown", "/query"))]
    assert notion.writes == []


@pytest.mark.django_db(transaction=True)
async def test_cycles_are_partial(start, notion):
    notion.blocks[ID["column"]]["parent"] = {"type": "block_id", "block_id": ID["column"]}
    await start({})
    await _ceiling("private", Grant.Effect.DENY)()
    executor = await start({"*": ("read",)})
    assert await _refused(executor, "notion_get_page", {"page_id": ID["in_column"]}) == "POLICY_DENIED"
    assert _names(await executor.invoke("notion_get_page", {"page_id": ID["row1"]})) == ["row1"]


@pytest.mark.django_db(transaction=True)
async def test_a_missing_capability_is_explained(start, notion):
    executor = await start({"home": ("read", "comment")})
    notion.hook = None
    original = notion.handler

    def forbidden(request):
        if request.method == "POST" and request.url.path.endswith("/comments"):
            return httpx.Response(403, json={"object": "error", "status": 403, "code": "restricted_resource"})
        return original(request)

    notion.handler = forbidden
    with pytest.raises(OperationError) as caught:
        await executor.invoke("notion_add_comment", {"page_id": ID["home"], "text": "hi"})
    assert caught.value.code == "PROVIDER_FORBIDDEN"
    assert "capabilities" in caught.value.message
