"""Slack connector against an in-memory Slack Web API, and runs through the executor."""

import json
import time
from uuid import uuid4

import httpx
import pytest
from connector_runs import refusal

from connections import credentials as connection_credentials
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials, ConnectionFlowError
from connectors import registry
from connectors.base import OperationError
from connectors.http import Effect
from connectors.slack import mrkdwn as text
from connectors.slack.client import SlackClient, judge
from connectors.slack.connector import SlackConnector

SECRET = "SECRET plans"
GENERAL, RANDOM, PRIVATE, HIDDEN, PARTNER, OLD = (
    "C0GENERAL1",
    "C0RANDOM01",
    "G0PRIVATE1",
    "C0HIDDEN01",
    "C0PARTNER1",
    "C0ARCHIVE1",
)
THREAD = "1727780000.000100"
REPLY = "1727780050.000300"


def _channel(channel_id: str, name: str, **flags) -> dict:
    private = channel_id.startswith("G") or flags.get("is_private", False)
    return {
        "id": channel_id,
        "name": name,
        "is_channel": not channel_id.startswith("G"),
        "is_group": channel_id.startswith("G"),
        "is_im": False,
        "is_mpim": False,
        "is_private": private,
        "is_archived": False,
        "is_member": True,
        "is_ext_shared": False,
        "topic": {"value": ""},
        "purpose": {"value": ""},
        "num_members": 3,
        **flags,
    }


class FakeSlack:
    """Slack's Web API, served through httpx.MockTransport.

    Channels: #general and #random (public; the app is only in #general), #private (private, the app is
    in it), #hidden (private, the app is not in it, so it does not exist for the app), #partner (shared
    with another organization) and #old (archived).
    """

    def __init__(self) -> None:
        self.channels = {
            GENERAL: _channel(GENERAL, "general", topic={"value": f"Plans: <#{PRIVATE}|{SECRET}>"}),
            RANDOM: _channel(RANDOM, "random", is_member=False),
            PRIVATE: _channel(PRIVATE, "private"),
            HIDDEN: _channel(HIDDEN, "hidden", is_private=True, is_member=False),
            PARTNER: _channel(PARTNER, "partner", is_ext_shared=True),
            OLD: _channel(OLD, "old", is_archived=True),
        }
        self.messages = {
            GENERAL: [
                {
                    "type": "message",
                    "ts": THREAD,
                    "thread_ts": THREAD,
                    "reply_count": 1,
                    "user": "U0ADA",
                    "text": (
                        f"See <#{PRIVATE}|{SECRET}>, <https://acme.slack.com/archives/{PRIVATE}/p1|{SECRET}> "
                        "and <https://example.com|the docs>; cc <@U0GRACE>"
                    ),
                },
                {
                    "type": "message",
                    "ts": REPLY,
                    "thread_ts": THREAD,
                    "user": "U0GRACE",
                    "text": "On it &amp; more",
                },
                {
                    "type": "message",
                    "ts": "1727780100.000200",
                    "subtype": "bot_message",
                    "bot_id": "B0BOT",
                    "username": "helper",
                    "text": "",
                    "attachments": [{"is_share": True, "text": SECRET, "channel_id": PRIVATE}],
                    "files": [
                        {
                            "id": "F0FILE",
                            "name": "plan.pdf",
                            "title": "Plan",
                            "mimetype": "application/pdf",
                            "size": 10,
                            "channels": [PRIVATE],
                            "preview": SECRET,
                        }
                    ],
                },
            ],
            PRIVATE: [{"type": "message", "ts": "1727780000.000900", "user": "U0ADA", "text": SECRET}],
            PARTNER: [{"type": "message", "ts": "1727780000.000500", "user": "U0ADA", "text": "hello"}],
            OLD: [],
            RANDOM: [{"type": "message", "ts": "1727780000.000700", "user": "U0ADA", "text": "random"}],
            HIDDEN: [],
        }
        self.users = {
            "U0ADA": {
                "id": "U0ADA",
                "name": "ada",
                "real_name": "Ada Lovelace",
                "profile": {"display_name": "ada"},
            },
            "U0GRACE": {"id": "U0GRACE", "name": "grace", "real_name": "Grace Hopper", "profile": {}},
        }
        self.ops: list[tuple[str, dict]] = []
        self.writes: list[dict] = []
        self.hook = None
        self.token = "xoxb-token"
        self.identity = {
            "ok": True,
            "team_id": "T0ACME",
            "team": "Acme",
            "user_id": "U0BOT",
            "user": "minerva",
            "bot_id": "B0MINERVA",
            "is_enterprise_install": False,
        }

    def _visible(self, channel_id: str) -> dict | None:
        channel = self.channels.get(channel_id)
        if channel is None or (channel["is_private"] and not channel["is_member"]):
            return None
        return channel

    @staticmethod
    def _page(items: list, params: dict, key: str) -> dict:
        limit = int(params.get("limit", 100))
        start = int(params["cursor"][1:]) if params.get("cursor") else 0
        more = start + limit < len(items)
        return {
            "ok": True,
            key: items[start : start + limit],
            "response_metadata": {"next_cursor": f"p{start + limit}" if more else ""},
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.removeprefix("/api/")
        params = dict(request.url.params)
        if request.method == "POST":
            params = json.loads(request.content)
        self.ops.append((method, params))
        if self.hook is not None and (response := self.hook(method, params)) is not None:
            return response
        return httpx.Response(200, json=self._answer(method, params))

    def _answer(self, method: str, params: dict) -> dict:
        not_found = {"ok": False, "error": "channel_not_found"}
        match method:
            case "auth.test":
                return self.identity
            case "conversations.info":
                channel = self._visible(params["channel"])
                return {"ok": True, "channel": channel} if channel else not_found
            case "conversations.list":
                channels = [c for c in self.channels.values() if self._visible(c["id"])]
                return self._page(channels, params, "channels")
            case "users.conversations":
                channels = [
                    {k: v for k, v in c.items() if k != "is_member"}
                    for c in self.channels.values()
                    if c["is_member"] and not c["is_archived"]
                ]
                return self._page(channels, params, "channels")
            case "conversations.history":
                channel = self._visible(params["channel"])
                if channel is None:
                    return not_found
                if not channel["is_member"]:
                    return {"ok": False, "error": "not_in_channel"}
                top = [m for m in self.messages[channel["id"]] if m.get("thread_ts") in (None, m["ts"])]
                return self._page(list(reversed(top)), params, "messages")
            case "conversations.replies":
                channel = self._visible(params["channel"])
                if channel is None:
                    return not_found
                messages = self.messages[channel["id"]]
                found = next((m for m in messages if m["ts"] == params["ts"]), None)
                if found is None:
                    return {"ok": False, "error": "thread_not_found"}
                root = found.get("thread_ts") or found["ts"]
                thread = [m for m in messages if m["ts"] == root or m.get("thread_ts") == root]
                return self._page(thread, params, "messages")
            case "users.info":
                user = self.users.get(params["user"])
                return {"ok": True, "user": user} if user else {"ok": False, "error": "user_not_found"}
            case "chat.postMessage":
                self.writes.append(params)
                return {"ok": True, "channel": params["channel"], "ts": "1727790000.000001", "message": {}}
        raise AssertionError(method)

    def names(self) -> list[str]:
        return [name for name, _ in self.ops]

    def client(self) -> SlackClient:
        return SlackClient(self.token, transport=httpx.MockTransport(self.handler))


@pytest.fixture
def slack() -> FakeSlack:
    return FakeSlack()


@pytest.fixture
def start(connector_run, slack, monkeypatch):
    """Starts a run for an agent with the user's Slack connection, holding `grants` on channels."""
    monkeypatch.setattr(SlackConnector, "client", lambda self, token: slack.client())
    scopes = ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"]

    def start_(grants: dict[str, tuple[str, ...]]):
        channels = {("channel", channel): actions for channel, actions in grants.items()}
        return connector_run(
            "slack",
            channels,
            scopes=[*scopes, "chat:write"],
            access_token="xoxb-t",
            label="Acme",
            external_account_id="T0ACME:U0BOT",
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


# Text


def test_read_text_hides_names_of_linked_channels():
    shown = text.redact(
        f"<#{PRIVATE}|{SECRET}> <https://acme.slack.com/archives/{PRIVATE}/p1|{SECRET}> "
        f"<https://acme%2Eslack.com/x|{SECRET}> <https://acme.slack-gov.com/archives/{PRIVATE}/p1|{SECRET}> "
        f"<slack://channel?team=T0ACME&id={PRIVATE}|{SECRET}> "
        f"<https://example.com|docs> <@U0ADA|ada> <#{GENERAL}>"
    )
    assert SECRET not in shown
    assert f"<#{PRIVATE}>" in shown and f"<https://acme.slack.com/archives/{PRIVATE}/p1>" in shown
    assert "<https://example.com|docs>" in shown and "<@U0ADA|ada>" in shown and f"<#{GENERAL}>" in shown


@pytest.mark.parametrize(
    "written",
    [
        "see https://acme.slack.com/archives/C0GENERAL1/p1727780000000100",
        "slack.com/archives/C1",
        "acme.slack%2Ecom/archives",
        "acme.slack&#46;com/archives",
        "acme.slack\uff0ecom/archives",
        "acme.slack\u200b.com",
        "acme.slack\\.com",
        "files.slack-files.com/x",
        "https://acme.slack-gov.com/archives/C0PRIVATE1/p1",
        "slack://channel?team=T0ACME&id=C0PRIVATE1",
        "bell\x07",
    ],
)
def test_written_text_may_not_link_to_slack(written):
    with pytest.raises(ValueError):
        text.check_written(written)


def test_written_text_is_escaped():
    assert text.check_written("*Done* & <!channel> <@U0ADA> <https://x|y>\n- next")
    assert text.escape("a & <!here> <@U0ADA>") == "a &amp; &lt;!here&gt; &lt;@U0ADA&gt;"


def test_judge_claims_only_what_slack_confirms():
    def response(status, body):
        return httpx.Response(status, content=body if isinstance(body, bytes) else json.dumps(body).encode())

    assert judge(response(200, {"ok": True, "ts": "1.2"})) == Effect.APPLIED
    for error in (
        "not_in_channel",
        "is_archived",
        "ratelimited",
        "invalid_auth",
        "msg_too_long",
        "accesslimited",
    ):
        assert judge(response(200, {"ok": False, "error": error})) == Effect.NOT_APPLIED
    for error in ("internal_error", "fatal_error", "request_timeout", "something_new", None):
        assert judge(response(200, {"ok": False, "error": error})) == Effect.UNKNOWN
    assert judge(response(200, b"<html>")) == Effect.UNKNOWN
    assert judge(response(200, [1])) == Effect.UNKNOWN
    # Slack answers with 200; any other success status is judged by its body all the same.
    assert judge(response(201, {"ok": False, "error": "not_in_channel"})) == Effect.NOT_APPLIED
    assert judge(response(204, b"")) == Effect.UNKNOWN
    assert judge(response(429, {"ok": False, "error": "ratelimited"})) is None
    assert judge(response(500, b"")) is None


# Connecting


async def test_account_discovery_and_names(slack):
    connector = SlackConnector()
    account = await connector.account(slack.client())
    assert (account.id, account.label) == ("T0ACME:U0BOT", "minerva (Acme)")
    found = await connector.discover(slack.client(), "channel", query=None, cursor=None)
    assert [item.name for item in found.items] == [
        "#general",
        "#random (app not added)",
        "#private",
        "#partner",
        "#old",
    ]
    found = await connector.discover(slack.client(), "channel", query="#PRIV", cursor=None)
    assert [(item.id, item.name) for item in found.items] == [(PRIVATE, "#private")]
    with pytest.raises(OperationError) as bad:
        await connector.discover(slack.client(), "channel", query=None, cursor="not a cursor")
    assert bad.value.code == "INVALID_CURSOR"
    names = await connector.describe(slack.client(), "channel", [GENERAL, HIDDEN, "*", "general"])
    assert names == {GENERAL: "#general"}


@pytest.mark.parametrize(
    "change",
    [
        {"is_enterprise_install": True},
        "user token",
    ],
)
async def test_only_workspace_bot_installs_connect(slack, change):
    if change == "user token":
        slack.token = "xoxp-token"
    else:
        slack.identity.update(change)
    with pytest.raises(OperationError) as refused:
        await SlackConnector().account(slack.client())
    assert refused.value.code == "UNSUPPORTED_ACCOUNT"


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


def test_slack_tokens_carry_their_scopes(token_endpoint):
    sent, responses = token_endpoint
    connector = registry.get("slack")
    responses.append(
        httpx.Response(
            200,
            json={
                "ok": True,
                "access_token": "xoxb-a",
                "token_type": "bot",
                "scope": "channels:read,chat:write",
                "team": {"id": "T0ACME", "name": "Acme"},
            },
        )
    )
    tokens = connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    assert tokens["access_token"] == "xoxb-a" and tokens["scopes"] == ["channels:read", "chat:write"]
    assert "expires_at" not in tokens
    [request] = sent
    assert request["url"] == "https://slack.com/api/oauth.v2.access"
    assert isinstance(request["auth"], httpx.BasicAuth) and "client_secret" not in request["data"]
    assert "code_verifier" not in request["data"]
    # Slack reports refusals with HTTP 200.
    responses.append(httpx.Response(200, json={"ok": False, "error": "invalid_code"}))
    with pytest.raises(ConnectionFlowError):
        connection_oauth.exchange_code(connector, code="c", flow=FLOW)


def test_slack_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("slack")
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    base = ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    requested = connection_oauth.requested_scopes(connector, {"read", "reply"})
    assert requested == [*base, "chat:write"]
    url = connection_oauth.authorization_url({}, workspace_id=uuid4(), provider="slack", scopes=requested)
    params = httpx.URL(url).params
    assert url.startswith("https://slack.com/oauth/v2/authorize?")
    assert params["scope"] == ",".join(requested)
    assert "code_challenge" not in params
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset(base), {"read", "reply", "post"}) == ["reply", "post"]
    assert needed(connector, frozenset([*base, "chat:write"]), {"read", "reply", "post"}) == []


# Runs


@pytest.mark.django_db(transaction=True)
async def test_channels_without_a_grant_or_out_of_reach_look_alike(start, slack):
    executor = await start({GENERAL: ("read",)})
    [general] = _items(await executor.invoke("slack_list_channels", {}))
    assert general["name"] == "general" and SECRET not in json.dumps(general)
    assert general["topic"] == f"Plans: <#{PRIVATE}>"
    assert _items(await executor.invoke("slack_read_channel", {"channel": "#General"}))
    assert _items(await executor.invoke("slack_read_channel", {"channel": GENERAL}))

    slack.ops.clear()
    for channel in ("#random", "#hidden", PRIVATE, HIDDEN, "#nope", "C0NOPE0000", "private", "D0DIRECT01"):
        assert await refusal(executor, "slack_read_channel", {"channel": channel}) == "POLICY_DENIED"
    # Nothing but where the channel is was asked for.
    assert set(slack.names()) <= {"conversations.list", "conversations.info"}
    for channel in ("a.b", "general channel", "<#C0GENERAL1>", "#"):
        assert await refusal(executor, "slack_read_channel", {"channel": channel}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_wildcard_reaches_only_channels_the_app_is_in(start, slack):
    executor = await start({"*": ("read",)})
    channels = _items(await executor.invoke("slack_list_channels", {}))
    assert [c["name"] for c in channels] == ["general", "private", "partner"]
    assert [c["shared_with_other_organizations"] for c in channels] == [False, False, True]
    [secret] = _items(await executor.invoke("slack_read_channel", {"channel": "#private"}))
    assert secret["text"] == SECRET
    assert await refusal(executor, "slack_read_channel", {"channel": "#random"}) == "NOT_IN_CHANNEL"
    assert await refusal(executor, "slack_read_channel", {"channel": "#hidden"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_reading_hides_other_channels(start, slack):
    executor = await start({GENERAL: ("read",)})
    messages = _items(await executor.invoke("slack_read_channel", {"channel": "#general"}))
    assert SECRET not in json.dumps(messages)
    assert [m["ts"] for m in messages] == ["1727780100.000200", THREAD]
    shared, first = messages
    assert shared["attachments_not_shown"] == 1 and shared["author"] == "helper"
    assert shared["files"] == [
        {"id": "F0FILE", "name": "plan.pdf", "title": "Plan", "mimetype": "application/pdf", "size": 10}
    ]
    assert first["author"] == "ada" and first["mentioned"] == {"U0GRACE": "Grace Hopper"}
    assert first["text"].startswith(f"See <#{PRIVATE}>, <https://acme.slack.com/archives/{PRIVATE}/p1> and ")
    assert first["time"] == "2024-10-01T10:53:20.000100Z" and first["reply_count"] == 1

    thread = _items(await executor.invoke("slack_read_thread", {"channel": "#general", "thread": REPLY}))
    assert [m["ts"] for m in thread] == [THREAD, REPLY]
    assert thread[1]["text"] == "On it &amp; more" and thread[1]["author"] == "Grace Hopper"

    page = await executor.invoke("slack_read_channel", {"channel": "#general", "limit": 1})
    assert [m["ts"] for m in _items(page)] == ["1727780100.000200"]
    slack.ops.clear()
    await executor.invoke(
        "slack_read_channel",
        {"channel": "#general", "after": "2024-10-01T10:50:00Z", "before": "2024-10-01T12:00:00+02:00"},
    )
    [(_, params)] = [op for op in slack.ops if op[0] == "conversations.history"]
    assert (params["oldest"], params["latest"]) == ("1727779800.000000", "1727776800.000000")


@pytest.mark.django_db(transaction=True)
async def test_posting_and_replying(start, slack):
    executor = await start(
        {GENERAL: ("read", "post"), PARTNER: ("read", "post", "reply"), OLD: ("read", "post")}
    )
    [posted] = _items(
        await executor.invoke(
            "slack_post_message", {"channel": "#general", "text": "Hi <!channel> & <@U0ADA>"}
        )
    )
    assert posted == {
        "written": True,
        "channel": GENERAL,
        "ts": "1727790000.000001",
        "time": "2024-10-01T13:40:00.000001Z",
        "thread_ts": None,
    }
    [sent] = slack.writes
    assert sent["text"] == "Hi &lt;!channel&gt; &amp; &lt;@U0ADA&gt;"
    assert sent["channel"] == GENERAL and "thread_ts" not in sent
    assert (sent["parse"], sent["link_names"], sent["unfurl_links"], sent["unfurl_media"]) == (
        "none",
        False,
        False,
        False,
    )
    # Replying is its own action.
    reply = {"channel": "#general", "thread": THREAD, "text": "ok"}
    assert await refusal(executor, "slack_reply", reply) == "POLICY_DENIED"
    assert (
        await refusal(executor, "slack_post_message", {"channel": "#partner", "text": "x"})
        == "EXTERNAL_CHANNEL"
    )
    assert (
        await refusal(executor, "slack_post_message", {"channel": "#old", "text": "x"}) == "CHANNEL_ARCHIVED"
    )
    assert (
        await refusal(
            executor, "slack_post_message", {"channel": "#general", "text": "https://acme.slack.com/x"}
        )
        == "INVALID_ARGUMENTS"
    )
    assert len(slack.writes) == 1

    slack.writes.clear()
    executor = await start({GENERAL: ("read", "reply"), RANDOM: ("read", "reply")})
    [replied] = _items(
        await executor.invoke("slack_reply", {"channel": "#general", "thread": REPLY, "text": "ok"})
    )
    assert replied["thread_ts"] == THREAD
    [sent] = slack.writes
    assert sent["thread_ts"] == THREAD and sent["reply_broadcast"] is False
    # No channel allows posting, so the tool is not offered.
    assert (
        await refusal(executor, "slack_post_message", {"channel": "#general", "text": "x"})
        == "UNKNOWN_OPERATION"
    )
    elsewhere = {"channel": "#general", "thread": "1727780000.000900", "text": "x"}
    assert await refusal(executor, "slack_reply", elsewhere) == "INVALID_ARGUMENTS"
    assert (
        await refusal(
            executor, "slack_reply", {"channel": "#random", "thread": "1727780000.000700", "text": "x"}
        )
        == "NOT_IN_CHANNEL"
    )
    assert len(slack.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_a_channel_that_changed_before_the_write_is_refused(start, slack):
    executor = await start({GENERAL: ("read", "reply")})
    args = {"channel": GENERAL, "thread": THREAD, "text": "x"}

    def changed_after_resolving(**change):
        infos = 0

        def hook(method, params):
            nonlocal infos
            if method != "conversations.info":
                return None
            infos += 1
            channel = slack.channels[GENERAL] if infos == 1 else {**slack.channels[GENERAL], **change}
            return httpx.Response(200, json={"ok": True, "channel": channel})

        slack.hook = hook

    changed_after_resolving(is_ext_shared=True)
    assert await refusal(executor, "slack_reply", args) == "EXTERNAL_CHANNEL"
    changed_after_resolving(is_pending_ext_shared=True)
    assert await refusal(executor, "slack_reply", {**args, "text": "y"}) == "EXTERNAL_CHANNEL"
    changed_after_resolving(id="C0OTHER000")
    assert await refusal(executor, "slack_reply", {**args, "text": "z"}) == "CHANNEL_MOVED"
    changed_after_resolving(is_member=False)
    assert await refusal(executor, "slack_reply", {**args, "text": "w"}) == "NOT_IN_CHANNEL"
    assert slack.writes == []


@pytest.mark.django_db(transaction=True)
async def test_write_outcomes_follow_what_slack_confirmed(start, slack):
    executor = await start({GENERAL: ("read", "post")})
    args = {"channel": "#general", "text": "hi"}

    def answer(body, status=200):
        slack.hook = lambda method, params: (
            httpx.Response(status, json=body) if method == "chat.postMessage" else None
        )

    answer({"ok": False, "error": "ratelimited"}, 429)
    assert await refusal(executor, "slack_post_message", {**args, "text": "a"}) == "PROVIDER_RATE_LIMITED"
    answer({"ok": False, "error": "restricted_action"})
    assert await refusal(executor, "slack_post_message", {**args, "text": "b"}) == "PROVIDER_FORBIDDEN"
    # Confirmed without the message: applied, with nothing more to show.
    answer({"ok": True})
    [written] = _items(await executor.invoke("slack_post_message", {**args, "text": "c"}))
    assert written["written"] is True and written["ts"] is None
    # An error after the post may have gone through: unknown, and further writes pause.
    answer({"ok": False, "error": "internal_error"})
    assert await refusal(executor, "slack_post_message", {**args, "text": "d"}) == "WRITE_UNCERTAIN"
    slack.hook = None
    assert await refusal(executor, "slack_post_message", {**args, "text": "e"}) == "WRITE_UNCERTAIN"


@pytest.mark.django_db(transaction=True)
async def test_reads_with_errors_or_too_much_data_are_refused(start, slack):
    executor = await start({GENERAL: ("read",)})
    slack.hook = lambda method, params: (
        httpx.Response(200, json={"ok": False, "error": "missing_scope"})
        if method == "conversations.history"
        else None
    )
    assert await refusal(executor, "slack_read_channel", {"channel": GENERAL}) == "PROVIDER_FORBIDDEN"
    huge = {"ok": True, "messages": [{"ts": THREAD, "text": "x" * (5 * 1024 * 1024)}]}
    slack.hook = lambda method, params: (
        httpx.Response(200, json=huge) if method == "conversations.history" else None
    )
    assert await refusal(executor, "slack_read_channel", {"channel": GENERAL}) == "RESPONSE_TOO_LARGE"
    slack.hook = lambda method, params: (
        httpx.Response(200, json={"ok": False, "error": "token_revoked"})
        if method == "conversations.info"
        else None
    )
    assert await refusal(executor, "slack_read_channel", {"channel": GENERAL}) == "CONNECTION_UNAUTHORIZED"


def test_a_refused_slack_refresh_needs_reconnecting(scoped, user, token_endpoint):
    _, responses = token_endpoint
    connection = Connection(provider="slack", owner=user, label="Acme", external_account_id="T0ACME:U0BOT")
    credentials = {"kind": "oauth2", "access_token": "xoxe.xoxb-old", "refresh_token": "xoxe-1-r1"}
    connection.set_credentials({**credentials, "expires_at": int(time.time()), "scopes": []})
    connection.save()
    # Slack refuses with HTTP 200.
    responses.append(httpx.Response(200, json={"ok": False, "error": "invalid_refresh_token"}))
    with pytest.raises(OperationError) as caught:
        connection_credentials.access_secret(connection.id)
    assert caught.value.code == "CONNECTION_UNAUTHORIZED"


@pytest.mark.django_db(transaction=True)
async def test_a_name_scan_cut_short_reveals_nothing(start, slack, monkeypatch):
    from connectors.slack import connector as slack_module

    monkeypatch.setattr(slack_module, "RESOLVE_PAGE", 1)
    monkeypatch.setattr(slack_module, "MAX_RESOLVE_PAGES", 2)
    executor = await start({"*": ("read",)})
    # #general and #random are on the pages read, #private is not; all are refused alike.
    for channel in ("#general", "#random", "#private", "#nope"):
        assert await refusal(executor, "slack_read_channel", {"channel": channel}) == "PROVIDER_LIMIT"
    [general] = _items(await executor.invoke("slack_read_channel", {"channel": GENERAL, "limit": 1}))
    assert general["ts"] == "1727780100.000200"
