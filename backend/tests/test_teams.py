"""Microsoft Teams connector against an in-memory Microsoft Graph, and runs through the executor."""

import json
from urllib.parse import quote

import httpx
import pytest
from connector_runs import ceiling, refusal

from connections import oauth as connection_oauth
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.teams import client as client_module
from connectors.teams import connector as teams_module
from connectors.teams import html
from connectors.teams.client import Mention, TeamsClient
from connectors.teams.connector import TeamsConnector
from permissions.models import Grant

SECRET = "SECRET merger"
USER_ID = "00000000-0000-0000-0000-00000000c0c0"
ENG = "aaaaaaaa-0000-0000-0000-000000000001"
FIN = "bbbbbbbb-0000-0000-0000-000000000002"
GENERAL = "19:general0001@thread.tacv2"
PRIVATE = "19:private0001@thread.tacv2"
SHARED = "19:shared00001@thread.tacv2"
BUDGET = "19:budget00001@thread.tacv2"
SCOPES = ["ChannelMessage.Read.All", "ChannelMessage.Send", "User.Read", "openid", "profile"]
# Teams' skiptokens are not always URL-safe.
TOKEN = '{"page":2,"x":"a+b/c"}'


def _message(message_id: str, channel: str, content: str, team: str = ENG, **fields) -> dict:
    return {
        "id": message_id,
        "replyToId": None,
        "messageType": "message",
        "createdDateTime": "2026-10-01T09:00:00Z",
        "lastEditedDateTime": None,
        "deletedDateTime": None,
        "subject": None,
        "importance": "normal",
        "webUrl": f"https://teams.microsoft.com/l/message/{message_id}",
        "from": {"user": {"id": USER_ID, "displayName": "Ada"}, "application": None},
        "body": {"contentType": "html", "content": content},
        "channelIdentity": {"teamId": team.upper(), "channelId": channel},
        "attachments": [],
        "mentions": [],
        "reactions": [],
    } | fields


class FakeGraph:
    """Microsoft Graph's Teams API, served through httpx.MockTransport.

    Engineering hosts General, Private (private) and Shared (shared); Finance hosts Budget. Graph spells
    Engineering's id in upper case in some answers.
    """

    def __init__(self) -> None:
        self.user = {"id": USER_ID, "displayName": "Me", "mail": "me@contoso.com"}
        self.teams = [
            {"id": FIN, "displayName": "Finance", "description": None, "isArchived": False},
            {"id": ENG.upper(), "displayName": "Engineering", "description": "Builds", "isArchived": False},
        ]
        self.channels = {
            ENG: [
                {"id": GENERAL, "displayName": "General", "membershipType": "standard"},
                {"id": PRIVATE, "displayName": "Private", "membershipType": "private"},
                {"id": SHARED, "displayName": "Shared", "membershipType": "shared"},
            ],
            FIN: [{"id": BUDGET, "displayName": SECRET, "membershipType": "standard"}],
        }
        self.messages: dict[str, list[dict]] = {
            GENERAL: [
                _message("1001", GENERAL, "<p>Hello <b>team</b></p>"),
                _message("1002", GENERAL, "", messageType="systemEventMessage"),
                # Graph returns a message of another channel: it is dropped.
                _message("1003", BUDGET, SECRET, team=FIN),
                _message("1004", GENERAL, SECRET, deletedDateTime="2026-10-01T10:00:00Z", subject=SECRET),
            ],
            PRIVATE: [_message("2001", PRIVATE, "private news")],
            SHARED: [_message("3001", SHARED, "shared news")],
            BUDGET: [_message("4001", BUDGET, SECRET, team=FIN)],
        }
        self.replies: dict[str, list[dict]] = {
            "1001": [
                _message("1101", GENERAL, "first reply", replyToId="1001"),
                _message("1102", GENERAL, SECRET, replyToId="9999"),
                _message("1103", BUDGET, SECRET, team=FIN, replyToId="1001"),
                _message("1104", GENERAL, "second reply", replyToId="1001"),
            ]
        }
        self.page_size: int | None = None
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _not_found() -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "NotFound", "message": SECRET}})

    def _page(self, path: str, items: list, params: dict) -> dict:
        top = self.page_size or int(params.get("$top", 100))
        start = 0
        if "$skiptoken" in params:
            assert params["$skiptoken"].startswith(TOKEN)
            start = int(params["$skiptoken"].removeprefix(TOKEN))
        body: dict = {"value": items[start : start + top]}
        if start + top < len(items):
            token = quote(f"{TOKEN}{start + top}", safe="")
            body["@odata.nextLink"] = f"https://graph.microsoft.com/v1.0{quote(path)}?$skiptoken={token}"
        return body

    def _find(self, channel_id: str, message_id: str) -> dict | None:
        everything = [*self.messages.get(channel_id, []), *self.replies.get(message_id, [])]
        everything += [r for replies in self.replies.values() for r in replies]
        return next((m for m in everything if m["id"] == message_id), None)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/v1.0")
        params = dict(request.url.params)
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        parts = path.strip("/").split("/")
        if len(parts) > 1 and parts[0] == "teams":
            parts[1] = parts[1].lower()
            if parts[1] not in self.channels:
                return self._not_found()
        if request.method == "POST":
            sent = json.loads(request.content)
            self.writes.append((path, sent))
            match parts:
                case ["teams", team, "channels", channel, "messages"]:
                    return httpx.Response(201, json=_message("5001", channel, sent["body"]["content"], team))
                case ["teams", team, "channels", channel, "messages", root, "replies"]:
                    created = _message("5002", channel, sent["body"]["content"], team, replyToId=root)
                    return httpx.Response(201, json=created)
            raise AssertionError(path)
        match parts:
            case ["me"]:
                return httpx.Response(200, json=self.user)
            case ["me", "joinedTeams"]:
                return httpx.Response(200, json={"value": self.teams})
            case ["teams", team, "channels"]:
                assert params["$select"] == client_module.CHANNEL_FIELDS
                return httpx.Response(200, json=self._page(path, self.channels[team], params))
            case ["teams", team, "channels", channel, "messages"]:
                if channel not in self.messages:
                    return self._not_found()
                return httpx.Response(200, json=self._page(path, self.messages[channel], params))
            case ["teams", team, "channels", channel, "messages", message_id]:
                found = self._find(channel, message_id)
                return httpx.Response(200, json=found) if found else self._not_found()
            case ["teams", team, "channels", channel, "messages", message_id, "replies"]:
                if message_id not in self.replies:
                    return self._not_found()
                return httpx.Response(200, json=self._page(path, self.replies[message_id], params))
        raise AssertionError(path)

    def reads(self, suffix: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path.endswith(suffix)]

    def client(self) -> TeamsClient:
        return TeamsClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


@pytest.fixture
def start(connector_run, graph, monkeypatch):
    """Starts a run with the user's Teams connection, holding `grants` ({team or channel: actions})."""
    monkeypatch.setattr(TeamsConnector, "client", lambda self, token: graph.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = SCOPES):
        channels = {("channel", resource_id): actions for resource_id, actions in grants.items()}
        return connector_run(
            "teams", channels, scopes=scopes, label="me@contoso.com", external_account_id=USER_ID
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


# Connecting and discovery


async def test_only_work_and_school_accounts_connect(graph):
    connector = TeamsConnector()
    account = await connector.account(graph.client())
    assert (account.id, account.label) == (USER_ID, "me@contoso.com")
    graph.user["id"] = "abcdef0123456789"
    with pytest.raises(OperationError) as caught:
        await connector.account(graph.client())
    assert caught.value.code == "UNSUPPORTED_ACCOUNT"


async def test_discovery_lists_whole_teams_and_names_only_canonical_ids(graph, monkeypatch):
    connector = TeamsConnector()
    client = graph.client()
    page = await connector.discover(client, "channel", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (ENG, "Engineering"),
        (GENERAL, "Engineering / General"),
        (PRIVATE, "Engineering / Private"),
        (SHARED, "Engineering / Shared"),
        (FIN, "Finance"),
        (BUDGET, f"Finance / {SECRET}"),
    ]
    assert page.next_cursor is None
    found = await connector.discover(client, "channel", query="priv", cursor=None)
    assert [i.id for i in found.items] == [PRIVATE]
    described = await connector.describe(
        client, "channel", [ENG, ENG.upper(), GENERAL, GENERAL.upper(), "19:nosuch@thread.tacv2", "x"]
    )
    assert described == {ENG: "Engineering", GENERAL: "Engineering / General"}
    monkeypatch.setattr(teams_module, "DISCOVERY_PAGE", 1)
    first = await connector.discover(client, "channel", query=None, cursor=None)
    assert [i.id for i in first.items] == [ENG, GENERAL, PRIVATE, SHARED]
    second = await connector.discover(client, "channel", query=None, cursor=first.next_cursor)
    assert ([i.id for i in second.items], second.next_cursor) == ([FIN, BUDGET], None)
    # A search scans on until something matches, and stops there.
    found = await connector.discover(client, "channel", query="general", cursor=None)
    assert ([i.id for i in found.items], found.next_cursor) == ([GENERAL], "1")
    # A team's channels are found under its name too.
    found = await connector.discover(client, "channel", query="fin", cursor=None)
    assert ([i.id for i in found.items], found.next_cursor) == ([FIN, BUDGET], None)
    found = await connector.discover(client, "channel", query="nothing", cursor=None)
    assert ([i.id for i in found.items], found.next_cursor) == ([], None)
    for cursor in ("x", "-1", "99999"):
        with pytest.raises(OperationError) as caught:
            await connector.discover(client, "channel", query=None, cursor=cursor)
        assert caught.value.code == "INVALID_CURSOR"


async def test_channel_listings_follow_teams_page_tokens_up_to_a_cap(graph, monkeypatch):
    graph.page_size = 2
    page = await TeamsConnector().discover(graph.client(), "channel", query=None, cursor=None)
    assert SHARED in [i.id for i in page.items]
    assert [r.url.params.get("$skiptoken") for r in graph.reads(f"/teams/{ENG}/channels")] == [
        None,
        f"{TOKEN}2",
    ]
    monkeypatch.setattr(client_module, "MAX_PAGES", 1)
    with pytest.raises(OperationError) as caught:
        await TeamsConnector().discover(graph.client(), "channel", query=None, cursor=None)
    assert caught.value.code == "PROVIDER_LIMIT"


def test_cursors_are_checked():
    assert client_module.page_params("t:" + TOKEN) == {"$skiptoken": TOKEN}
    for cursor in ("token:abc", "t:", "t:a b", "t:" + "a" * 991, "t:é"):
        with pytest.raises(OperationError) as caught:
            client_module.page_params(cursor)
        assert caught.value.code == "INVALID_CURSOR"
    assert client_module.next_cursor(None) is None
    for link in ("https://graph.microsoft.com/v1.0/x?$skip=2", "https://x/?$skiptoken=a%20b", 5):
        with pytest.raises(OperationError) as caught:
            client_module.next_cursor(link)
        assert caught.value.code == "PROVIDER_LIMIT"


def test_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("teams")
    monkeypatch.setattr(
        connection_oauth, "client_credentials", lambda connector: ClientCredentials("id", "s", "https://x/cb")
    )
    base = ["offline_access", "User.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All"]
    assert connection_oauth.requested_scopes(connector, {"read"}) == [*base, "ChannelMessage.Read.All"]
    assert connection_oauth.requested_scopes(connector, {"read", "reply"}) == [
        *base,
        "ChannelMessage.Read.All",
        "ChannelMessage.Send",
    ]
    needed = connection_oauth.consent_needed
    granted = frozenset({"https://graph.microsoft.com/channelmessage.read.all", "ChannelMessage.Send"})
    assert needed(connector, granted, {"read", "reply", "post"}) == []
    # Replying reads the message replied to.
    assert needed(connector, frozenset({"ChannelMessage.Send"}), {"reply", "post"}) == ["reply"]


# Reading


@pytest.mark.django_db(transaction=True)
async def test_a_team_grant_covers_its_channels(start, graph):
    executor = await start({ENG: ("read",)})
    assert _ids(await executor.invoke("teams_list_teams", {})) == [ENG]
    channels = _items(await executor.invoke("teams_list_channels", {}))
    assert [c["id"] for c in channels] == [GENERAL, PRIVATE, SHARED]
    assert channels[0] == {
        "id": GENERAL,
        "team_id": ENG,
        "name": "General",
        "description": None,
        "membership": "standard",
        "link": None,
    }
    assert _ids(await executor.invoke("teams_list_channels", {"team_id": FIN})) == []
    assert _ids(await executor.invoke("teams_list_channels", {"team_id": ENG.upper()})) == [
        GENERAL,
        PRIVATE,
        SHARED,
    ]
    outcome = await executor.invoke("teams_read_channel", {"team_id": ENG.upper(), "channel_id": PRIVATE})
    assert _ids(outcome) == ["2001"]
    args = {"team_id": FIN, "channel_id": BUDGET}
    assert await refusal(executor, "teams_read_channel", args) == "POLICY_DENIED"
    assert not graph.reads("/messages")[1:]
    for team_id, channel_id in (
        ("cccccccc-0000-0000-0000-000000000003", GENERAL),
        (ENG, "19:nosuch0001@thread.tacv2"),
        (ENG, GENERAL.replace("general", "GENERAL")),
    ):
        args = {"team_id": team_id, "channel_id": channel_id}
        assert await refusal(executor, "teams_read_channel", args) == "POLICY_DENIED"
    for args in ({"team_id": "eng", "channel_id": GENERAL}, {"team_id": ENG, "channel_id": "General"}):
        assert await refusal(executor, "teams_read_channel", args) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_channel_is_reached_only_through_the_team_hosting_it(start, graph):
    executor = await start({"*": ("read",)})
    # Graph would answer for a channel under any team; Minerva asks only teams that host it.
    args = {"team_id": FIN, "channel_id": GENERAL}
    assert await refusal(executor, "teams_read_channel", args) == "POLICY_DENIED"
    assert not graph.reads("/messages")


@pytest.mark.django_db(transaction=True)
async def test_denies_hold_inside_an_allowed_team_and_under_any_case(start, graph):
    await start({})
    await ceiling("teams", "channel", PRIVATE, Grant.Effect.DENY)
    await ceiling("teams", "channel", FIN, Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    assert _ids(await executor.invoke("teams_list_teams", {})) == [ENG]
    assert [c["id"] for c in _items(await executor.invoke("teams_list_channels", {}))] == [GENERAL, SHARED]
    for team_id, channel_id in ((ENG, PRIVATE), (FIN, BUDGET), (FIN.upper(), BUDGET)):
        args = {"team_id": team_id, "channel_id": channel_id}
        assert await refusal(executor, "teams_read_channel", args) == "POLICY_DENIED"
    assert not graph.reads("/messages")


@pytest.mark.django_db(transaction=True)
async def test_messages_leave_out_events_strays_and_deleted_text(start, graph):
    graph.messages[GENERAL][0]["attachments"] = [
        {"contentType": "reference", "name": "plan.docx", "contentUrl": SECRET},
        {"contentType": "messageReference", "name": None, "content": SECRET},
    ]
    graph.messages[GENERAL][0]["reactions"] = [{"reactionType": "like"}, {"reactionType": "like"}]
    graph.messages[GENERAL][0]["subject"] = "Plans"
    executor = await start({ENG: ("read",)})
    outcome = await executor.invoke("teams_read_channel", {"team_id": ENG, "channel_id": GENERAL})
    assert SECRET not in json.dumps(outcome.result)
    first, deleted = _items(outcome)
    assert first == {
        "id": "1001",
        "team_id": ENG,
        "channel_id": GENERAL,
        "reply_to_id": None,
        "created_time": "2026-10-01T09:00:00Z",
        "edited_time": None,
        "deleted": False,
        "author": "Ada",
        "author_id": USER_ID,
        "importance": "normal",
        "link": "https://teams.microsoft.com/l/message/1001",
        "subject": "Plans",
        "text": "Hello team",
        "text_truncated": False,
        "reactions": [{"type": "like", "count": 2}],
        "files": [{"name": "plan.docx"}],
        "attachments_not_shown": 1,
    }
    assert (deleted["id"], deleted["deleted"], deleted["text"], deleted["subject"]) == (
        "1004",
        True,
        "",
        None,
    )
    assert graph.reads("/messages")[-1].url.params["$top"] == "20"


@pytest.mark.django_db(transaction=True)
async def test_channel_pages_are_run_bound(start, graph):
    graph.page_size = 1
    executor = await start({ENG: ("read",)})
    args = {"team_id": ENG, "channel_id": GENERAL}
    first = await executor.invoke("teams_read_channel", args)
    assert _ids(first) == ["1001"]
    second = await executor.invoke("teams_read_channel", {**args, "cursor": first.result["next_cursor"]})
    assert second.result["items"] == []
    assert graph.reads(f"{GENERAL}/messages")[-1].url.params["$skiptoken"] == f"{TOKEN}1"
    other = {"team_id": ENG, "channel_id": PRIVATE, "cursor": first.result["next_cursor"]}
    assert await refusal(executor, "teams_read_channel", other) == "INVALID_CURSOR"


@pytest.mark.django_db(transaction=True)
async def test_threads_start_with_their_root_and_keep_only_its_replies(start, graph):
    executor = await start({ENG: ("read",)})
    args = {"team_id": ENG, "channel_id": GENERAL, "message_id": "1001"}
    outcome = await executor.invoke("teams_read_thread", args)
    assert _ids(outcome) == ["1001", "1101", "1104"]
    assert SECRET not in json.dumps(outcome.result)
    graph.page_size = 1
    first = await executor.invoke("teams_read_thread", {**args, "limit": 1})
    assert _ids(first) == ["1001", "1101"]
    second = await executor.invoke(
        "teams_read_thread", {**args, "limit": 1, "cursor": first.result["next_cursor"]}
    )
    assert _ids(second) == []
    for message_id in ("1101", "4001", "77"):
        args = {"team_id": ENG, "channel_id": GENERAL, "message_id": message_id}
        assert await refusal(executor, "teams_read_thread", args) == "INVALID_ARGUMENTS"


def _mentions(*mentions: tuple[int, dict]) -> list[Mention]:
    return [Mention.model_validate({"id": i, "mentioned": m}) for i, m in mentions]


def test_text_hides_channels_teams_links_and_quotes():
    mentions = _mentions(
        (0, {"user": {"id": "u", "displayName": "Ada"}}),
        (1, {"conversation": {"id": "19:x@thread.tacv2", "displayName": SECRET}}),
        (2, {"tag": {"id": "t", "displayName": "Oncall"}}),
    )
    content = (
        '<div><p>Hi <at id="0">Ada</at> and <at id="2">Oncall</at>, see <at id="1">' + SECRET + "</at>.</p>"
        f'<p><a href="https://teams.microsoft.com/l/channel/19%3ax/{SECRET}">{SECRET}</a> '
        f'<a href="https://teams%2Emicrosoft.com/x">{SECRET}</a> <a href="https://example.com/a">docs</a> '
        '<a href="https://example.com/b">https://example.com/b</a></p>'
        '<blockquote itemtype="http://schema.skype.com/Reply" itemid="1101"><strong>Bob</strong>'
        f"<blockquote>{SECRET}</blockquote></blockquote>"
        '<ul><li>one</li><li>two&nbsp;&amp; three</li></ul><img src="x"> <emoji alt="😀">:)</emoji>'
        f'<attachment id="a1">{SECRET}</attachment><script>{SECRET}</script>'
        "<p>a<br>b</p><p>&lt;b&gt;</p></div>"
    )
    assert html.read(content, "html", mentions) == (
        "Hi @Ada and @Oncall, see @[channel].\n"
        "[Teams link] [Teams link] docs (https://example.com/a) https://example.com/b\n"
        "[quoted message]\n"
        "- one\n"
        "- two & three\n"
        "[image] 😀\n"
        "a\nb\n"
        "<b>"
    )
    assert html.read("  plain <b>text</b> ", "text", []) == "plain <b>text</b>"
    assert html.read(None, "html", []) == ""


def test_hidden_elements_hide_what_they_nest_and_what_is_never_closed():
    nested = f'<a href="https://teams.microsoft.com/x"><a href="https://example.com">{SECRET}</a>{SECRET}</a> after'
    assert html.read(nested, "html", []) == "[Teams link] after"
    assert html.read(f'before <at id="9">{SECRET}', "html", []) == "before @[channel]"
    assert html.read(f'<at id="0">x</at><at id="0"><at>{SECRET}</at></at>', "html", _mentions((0, {}))) == (
        "@[channel]@[channel]"
    )
    quote_ = f'start <blockquote itemid="5">{SECRET}<p>{SECRET}'
    assert html.read(quote_, "html", []) == "start\n[quoted message]"
    assert html.read('<a href="https://example.com">open', "html", []) == "open"


def test_text_hides_repeated_attributes_plain_quotes_and_bare_teams_addresses():
    shown = _mentions((0, {"user": {"id": "u", "displayName": "Ada"}}))
    # Readers disagree on which of two values counts, so neither does.
    assert html.read(f'<at id="0" id="1">{SECRET}</at>', "html", shown) == "@[channel]"
    twice = f'<a href="https://example.com" href="https://teams.microsoft.com/x">{SECRET}</a>'
    assert html.read(twice, "html", []) == "[Teams link]"
    assert html.read(f"<p>said</p><blockquote>{SECRET}</blockquote>", "html", []) == (
        "said\n[quoted message]"
    )
    # A mention id the list also gives to a channel is a channel's.
    both = _mentions((0, {"user": {"id": "u"}}), (0, {"conversation": {"id": "19:x@thread.tacv2"}}))
    assert html.read(f'<at id="0">{SECRET}</at>', "html", both) == "@[channel]"
    # Browsers read these as open elements.
    for opened in ("<blockquote/>", '<at id="9"/>', '<a href="https://teams.microsoft.com/x"/>', "<script/>"):
        assert SECRET not in html.read(f"{opened}{SECRET}</x> after", "html", shown)
    assert html.read('a <emoji alt="😀"/> b<br/>c', "html", []) == "a 😀 b\nc"
    # Browsers drop tabs and newlines inside addresses.
    for href in (
        "https://teams.micro&#10;soft.com/l/x",
        "ms&#9;teams:/l/x",
        "https://teams%2Emicro%0Dsoft.com/x",
    ):
        assert html.read(f'<a href="{href}">{SECRET}</a>', "html", []) == "[Teams link]"
    for address in (
        "https://teams.microsoft.com/l/channel/x",
        "teams%2Emicrosoft%2Ecom/x",
        "https://teams.microsoftonline.cn/l/x",
        "https://dod.teams.microsoft.us/l/x",
        "msteams://x",
    ):
        assert html.read(f"<p>see {address}, ok</p>", "html", []) == "see [Teams link] ok"
        assert html.read(f"see {address}", "text", []) == "see [Teams link]"


# Writing


@pytest.mark.django_db(transaction=True)
async def test_posts_are_escaped_and_never_mention_or_link_to_teams(start, graph):
    executor = await start({ENG: ("read", "post", "reply")})
    outcome = await executor.invoke(
        "teams_post_message",
        {"team_id": ENG, "channel_id": GENERAL, "text": '<at id="0">x</at> & <b>bold</b>\nnext'},
    )
    assert _items(outcome) == [
        {
            "written": True,
            "id": "5001",
            "team_id": ENG,
            "channel_id": GENERAL,
            "reply_to_id": None,
            "created_time": "2026-10-01T09:00:00Z",
            "link": "https://teams.microsoft.com/l/message/5001",
        }
    ]
    assert graph.writes == [
        (
            f"/teams/{ENG}/channels/{GENERAL}/messages",
            {
                "body": {
                    "contentType": "html",
                    "content": "&lt;at id=&quot;0&quot;&gt;x&lt;/at&gt; &amp; &lt;b&gt;bold&lt;/b&gt;<br>next",
                }
            },
        )
    ]
    for text in (
        "see https://teams.microsoft.com/l/channel/x",
        "see https%3A%2F%2Fteams%2Emicrosoft%2Ecom/x",
        "open msteams://x",
        "TEAMS.LIVE.COM/x",
        "bell \x07",
    ):
        args = {"team_id": ENG, "channel_id": GENERAL, "text": text}
        assert await refusal(executor, "teams_post_message", args) == "INVALID_ARGUMENTS"
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_replies_go_only_to_live_thread_roots_in_the_channel(start, graph):
    executor = await start({ENG: ("read", "reply")})
    args = {"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "text": "thanks"}
    outcome = await executor.invoke("teams_reply", args)
    assert _items(outcome)[0]["reply_to_id"] == "1001"
    assert graph.writes == [
        (
            f"/teams/{ENG}/channels/{GENERAL}/messages/1001/replies",
            {"body": {"contentType": "html", "content": "thanks"}},
        )
    ]
    # A reply, a deleted message, an event, a message of another channel, and an unknown id.
    for message_id in ("1101", "1004", "1002", "4001", "123"):
        attempt = {**args, "message_id": message_id, "text": f"to {message_id}"}
        assert await refusal(executor, "teams_reply", attempt) == "INVALID_ARGUMENTS"
    # Replying does not allow posting: the tool is not offered.
    post = {"team_id": ENG, "channel_id": GENERAL, "text": "new"}
    assert await refusal(executor, "teams_post_message", post) == "UNKNOWN_OPERATION"
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_tools_are_offered_with_their_consent(start, graph):
    executor = await start({ENG: ("read", "post", "reply")}, scopes=["ChannelMessage.Send", "User.Read"])
    # Reading and replying need ChannelMessage.Read.All; listing and posting do not.
    assert {"teams_list_teams", "teams_list_channels", "teams_post_message"} == {
        tool for tool in executor.context.tools if tool.startswith("teams_")
    }
    await executor.invoke("teams_post_message", {"team_id": ENG, "channel_id": GENERAL, "text": "hello"})
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_shared_and_unknown_channels_are_not_written_to(start, graph):
    executor = await start({ENG: ("read", "post", "reply")})
    args = {"team_id": ENG, "channel_id": SHARED, "text": "hello"}
    assert await refusal(executor, "teams_post_message", args) == "EXTERNAL_CHANNEL"
    graph.channels[ENG][0]["membershipType"] = "unknownFutureValue"
    args = {"team_id": ENG, "channel_id": GENERAL, "text": "hello"}
    assert await refusal(executor, "teams_post_message", args) == "EXTERNAL_CHANNEL"
    del graph.channels[ENG][0]["membershipType"]
    reply = {"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "text": "hi"}
    assert await refusal(executor, "teams_reply", reply) == "EXTERNAL_CHANNEL"
    assert not graph.writes


@pytest.mark.django_db(transaction=True)
async def test_channels_are_checked_again_just_before_writing(start, graph):
    executor = await start({ENG: ("read", "post", "reply")})
    listings = 0

    def change(update):
        def hook(method: str, path: str, params: dict):
            nonlocal listings
            if method == "GET" and path.lower() == f"/teams/{ENG}/channels":
                listings += 1
                # The first listing authorizes the call; the second is the check before the write.
                if listings % 2 == 0:
                    update()
            return None

        return hook

    def to_shared():
        graph.channels[ENG][0]["membershipType"] = "shared"

    graph.hook = change(to_shared)
    args = {"team_id": ENG, "channel_id": GENERAL, "text": "hello"}
    assert await refusal(executor, "teams_post_message", args) == "EXTERNAL_CHANNEL"
    graph.channels[ENG][0]["membershipType"] = "standard"

    def moved():
        graph.channels[ENG] = graph.channels[ENG][1:]

    graph.hook = change(moved)
    reply = {"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "text": "hi"}
    assert await refusal(executor, "teams_reply", reply) == "CHANNEL_MOVED"
    assert not graph.writes


@pytest.mark.django_db(transaction=True)
async def test_a_channel_denied_read_is_not_written_to(start, graph):
    await start({})
    await ceiling("teams", "channel", GENERAL, Grant.Effect.DENY, ("read",))
    executor = await start({ENG: ("read", "post", "reply")})
    assert _ids(await executor.invoke("teams_list_channels", {})) == [PRIVATE, SHARED]
    # Posting and replying require read on the same channel.
    args = {"team_id": ENG, "channel_id": GENERAL, "text": "hello"}
    assert await refusal(executor, "teams_post_message", args) == "POLICY_DENIED"
    reply = args | {"message_id": "1001"}
    assert await refusal(executor, "teams_reply", reply) == "POLICY_DENIED"
    assert not graph.writes


@pytest.mark.django_db(transaction=True)
async def test_a_post_graph_places_elsewhere_counts_without_a_result(start, graph):
    executor = await start({ENG: ("read", "post")})

    def misplaced(method: str, path: str, params: dict):
        if method == "POST":
            graph.writes.append((path, {}))
            return httpx.Response(201, json=_message("5001", BUDGET, "x", FIN))
        return None

    graph.hook = misplaced
    outcome = await executor.invoke(
        "teams_post_message", {"team_id": ENG, "channel_id": GENERAL, "text": "a"}
    )
    assert outcome.result["outcome"] == "applied_without_result" and _items(outcome) == []
    assert len(graph.writes) == 1
