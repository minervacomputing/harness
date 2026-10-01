"""Slack's Web API, with a bot token.

Slack answers most failed requests with HTTP 200 and `{"ok": false, "error": "<code>"}`. Reads fail
closed: any such answer refuses the call. A post counts as applied only when Slack answers `ok: true`, and
as not applied only for the errors Slack raises when it refused the request before posting; anything else
(`internal_error`, an unknown code, a response that is not JSON) leaves its outcome unknown, which pauses
further writes. Slack's own error texts never reach the model.
"""

import json
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from connectors.base import OperationError
from connectors.http import Effect, ProviderHTTP

API_URL = "https://slack.com/api"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
BOT_TOKEN_PREFIXES = ("xoxb-", "xoxe.xoxb-")

UNAUTHORIZED = frozenset(
    {"invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "org_login_required"}
)
RATE_LIMITED = frozenset({"ratelimited", "rate_limited", "message_limit_exceeded"})
FORBIDDEN = frozenset(
    {
        "missing_scope",
        "no_permission",
        "app_access_restricted",
        "accesslimited",
        "access_denied",
        "not_allowed_token_type",
        "ekm_access_denied",
        "team_access_not_granted",
        "enterprise_is_restricted",
        "two_factor_setup_required",
        "restricted_action",
        "restricted_action_read_only_channel",
        "restricted_action_thread_only_channel",
        "restricted_action_non_threadable_channel",
        "restricted_action_thread_locked",
    }
)
NOT_FOUND = frozenset({"channel_not_found", "thread_not_found", "message_not_found", "user_not_found"})
REJECTED = frozenset(
    {
        "invalid_arguments",
        "invalid_arg_name",
        "invalid_array_arg",
        "invalid_charset",
        "invalid_form_data",
        "invalid_post_type",
        "missing_post_type",
        "invalid_ts_latest",
        "invalid_ts_oldest",
        "invalid_limit",
        "no_text",
        "msg_too_long",
        "invalid_blocks",
        "invalid_blocks_format",
        "too_many_attachments",
        "cannot_reply_to_message",
        "messages_tab_disabled",
        "as_user_not_supported",
        "method_deprecated",
        "deprecated_endpoint",
    }
)
# chat.postMessage errors for requests Slack refused before posting. Errors outside this list, such as
# internal_error, fatal_error, request_timeout or service_unavailable, may follow a post that went through.
REFUSED_BEFORE_POSTING = (
    UNAUTHORIZED
    | RATE_LIMITED
    | FORBIDDEN
    | REJECTED
    | {"channel_not_found", "not_in_channel", "is_archived"}
)


def error_for(provider: str, error: Any) -> OperationError:
    code = error if isinstance(error, str) else ""
    if code in UNAUTHORIZED:
        return OperationError(
            "CONNECTION_UNAUTHORIZED", f"The {provider} connection is no longer authorized."
        )
    if code in RATE_LIMITED:
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    if code == "not_in_channel":
        return OperationError(
            "NOT_IN_CHANNEL",
            f"The {provider} app is not a member of this channel. Someone in the channel can add it "
            "(/invite and the app's name).",
        )
    if code == "is_archived":
        return OperationError("CHANNEL_ARCHIVED", "This channel is archived.")
    if code in FORBIDDEN:
        return OperationError("PROVIDER_FORBIDDEN", f"{provider} refused this request for the connected app.")
    if code in NOT_FOUND:
        return OperationError("NOT_FOUND", f"{provider} did not find this object.")
    if code == "invalid_cursor":
        return OperationError("INVALID_CURSOR", "This page token is invalid.")
    if code in REJECTED:
        return OperationError("PROVIDER_REJECTED", f"{provider} rejected this request.")
    return OperationError("PROVIDER_FAILED", f"{provider} could not complete this request.")


def _body(response: httpx.Response) -> dict[str, Any] | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    """Errors with a status other than 200; their status says enough except for authorization."""
    body = _body(response)
    if body is not None and body.get("error") in UNAUTHORIZED:
        return error_for(provider, body["error"])
    return None


def judge(response: httpx.Response) -> Effect | None:
    """What a post did. Only Slack's answer counts for a success status, whichever; other statuses are
    judged by status: 429 was refused, 5xx is unknown."""
    if not response.is_success:
        return None
    body = _body(response)
    if body is None:
        return Effect.UNKNOWN
    if body.get("ok") is True:
        return Effect.APPLIED
    if body.get("ok") is False and body.get("error") in REFUSED_BEFORE_POSTING:
        return Effect.NOT_APPLIED
    return Effect.UNKNOWN


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Identity(Model):
    team_id: str
    team: str = ""
    user_id: str
    user: str = ""
    is_enterprise_install: bool = False


class Text(Model):
    value: str = ""


class Channel(Model):
    id: str
    name: str = ""
    is_channel: bool = False
    is_group: bool = False
    is_im: bool = False
    is_mpim: bool = False
    is_private: bool = False
    is_archived: bool = False
    # Left out by some methods; unknown counts as not a member.
    is_member: bool | None = None
    is_ext_shared: bool = False
    is_pending_ext_shared: bool = False
    topic: Text | None = None
    purpose: Text | None = None
    num_members: int | None = None

    @property
    def is_conversation_channel(self) -> bool:
        """A public or private channel, not a direct or group message."""
        return (self.is_channel or self.is_group) and not self.is_im and not self.is_mpim


class Reaction(Model):
    name: str = ""
    count: int = 0


class File(Model):
    id: str | None = None
    name: str | None = None
    title: str | None = None
    mimetype: str | None = None
    size: int | None = None


class Message(Model):
    ts: str
    type: str | None = None
    subtype: str | None = None
    user: str | None = None
    bot_id: str | None = None
    username: str | None = None
    text: str = ""
    thread_ts: str | None = None
    reply_count: int | None = None
    latest_reply: str | None = None
    edited: dict[str, Any] | None = None
    reactions: list[Reaction] = []
    files: list[File] = []
    attachments: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]] = []


class Profile(Model):
    display_name: str = ""
    real_name: str = ""


class User(Model):
    id: str
    name: str = ""
    real_name: str = ""
    deleted: bool = False
    profile: Profile | None = None

    @property
    def shown_name(self) -> str:
        if self.profile and self.profile.display_name:
            return self.profile.display_name
        return self.real_name or (self.profile.real_name if self.profile else "") or self.name


class Posted(Model):
    channel: str | None = None
    ts: str | None = None


class SlackClient:
    """Thin async client for Slack's Web API. Responses are validated before use."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.bot = access_token.startswith(BOT_TOKEN_PREFIXES)
        self._http = ProviderHTTP(
            "Slack",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
            classify=classify,
            judge=judge,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def call(self, method: str, **params: Any) -> dict[str, Any]:
        """A read. An answer that is not `ok` refuses the call."""
        response = await self._http.bounded(
            f"/{method}",
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Slack returned more than Minerva reads."),
            params={key: value for key, value in params.items() if value is not None},
        )
        body = _body(response)
        if body is None:
            raise self.unexpected()
        if body.get("ok") is not True:
            raise error_for("Slack", body.get("error"))
        return body

    def _parse[M: BaseModel](self, model: type[M], value: Any) -> M:
        try:
            return model.model_validate(value)
        except ValidationError as error:
            raise self.unexpected() from error

    def _list[M: BaseModel](self, model: type[M], value: Any) -> list[M]:
        if not isinstance(value, list):
            raise self.unexpected()
        return [self._parse(model, item) for item in value]

    @staticmethod
    def _next(body: dict[str, Any]) -> str | None:
        metadata = body.get("response_metadata")
        cursor = metadata.get("next_cursor") if isinstance(metadata, dict) else None
        return cursor if isinstance(cursor, str) and cursor else None

    async def auth_test(self) -> Identity:
        return self._parse(Identity, await self.call("auth.test"))

    async def channel(self, channel_id: str) -> Channel:
        body = await self.call("conversations.info", channel=channel_id)
        return self._parse(Channel, body.get("channel"))

    async def channels(self, *, limit: int, cursor: str | None) -> tuple[list[Channel], str | None]:
        """Public channels, and private channels the app is a member of."""
        body = await self.call(
            "conversations.list",
            types="public_channel,private_channel",
            exclude_archived="false",
            limit=limit,
            cursor=cursor,
        )
        return self._list(Channel, body.get("channels")), self._next(body)

    async def member_channels(self, *, limit: int, cursor: str | None) -> tuple[list[Channel], str | None]:
        """Channels the app is a member of."""
        body = await self.call(
            "users.conversations",
            types="public_channel,private_channel",
            exclude_archived="true",
            limit=limit,
            cursor=cursor,
        )
        return self._list(Channel, body.get("channels")), self._next(body)

    async def history(
        self,
        channel_id: str,
        *,
        limit: int,
        cursor: str | None,
        oldest: str | None,
        latest: str | None,
    ) -> tuple[list[Message], str | None]:
        body = await self.call(
            "conversations.history",
            channel=channel_id,
            limit=limit,
            cursor=cursor,
            oldest=oldest,
            latest=latest,
            inclusive="false",
        )
        return self._list(Message, body.get("messages")), self._next(body)

    async def replies(
        self, channel_id: str, ts: str, *, limit: int, cursor: str | None
    ) -> tuple[list[Message], str | None]:
        """A thread, its parent message first. `ts` may be the parent or any reply."""
        body = await self.call("conversations.replies", channel=channel_id, ts=ts, limit=limit, cursor=cursor)
        return self._list(Message, body.get("messages")), self._next(body)

    async def user(self, user_id: str) -> User:
        return self._parse(User, (await self.call("users.info", user=user_id)).get("user"))

    async def post(self, channel_id: str, text: str, *, thread_ts: str | None) -> Posted:
        """The one write of an operation. Its outcome is judged by `judge`. `text` must already be escaped:
        it is sent with every Slack feature that could turn it into more than a message switched off."""
        payload: dict[str, Any] = {
            "channel": channel_id,
            "text": text,
            "mrkdwn": True,
            "parse": "none",
            "link_names": False,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if thread_ts is not None:
            payload["thread_ts"] = thread_ts
            payload["reply_broadcast"] = False
        response = await self._http.request(
            "POST",
            "/chat.postMessage",
            mutating=True,
            content=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        body = _body(response)
        if body is None:
            raise OperationError("WRITE_UNCONFIRMED", "Slack did not confirm the message.")
        if body.get("ok") is not True:
            raise error_for("Slack", body.get("error"))
        try:
            return Posted.model_validate(body)
        except ValidationError:
            return Posted()
