"""Slack. Resources are channels; Minerva acts as the operator's Slack app, with its bot token.

Only bot tokens (`xoxb-`) are accepted: user tokens and organization-wide installs are refused, and the
account is the app's bot user in one workspace (`team_id:user_id`). Slack takes comma-separated scopes and
HTTP Basic client authentication without PKCE (Slack treats PKCE apps as public clients); writes ask for
`chat:write`.

The app reaches only the channels it has been added to in Slack, so a channel needs both a grant in
Minerva and the app as a member: two consents, one of them visible to everyone in the channel. Channels
(public and private, never direct messages) are one flat kind with a wildcard, keyed by Slack's channel
id. Tools name channels by id or by name; a name is resolved to the channel once, before authorization,
and a channel the app cannot see (or a name that is missing or ambiguous) is refused like a channel
without a grant. Reading a channel the app is not in answers `NOT_IN_CHANNEL` only after authorization.

Text agents read hides the names of channels that links in it point to (see `mrkdwn`), leaves out
attachments, which can quote messages from other channels, and shows only the metadata of files. Text
agents write is escaped and sent with `parse=none`, `link_names=false` and unfurling off, so it cannot
mention anyone or notify a channel, and it may not link to Slack. Replying in a thread and posting to the
channel are separate actions, with different reach. Every write first confirms the channel again: the same
id, the app a member, not archived, and not shared with another organization. What stays outside
Minerva's reach: Slack workflows and other apps that react to messages, and who joins a channel after it
was granted.
"""

import asyncio
import re
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import (
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    OAuth2,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ResourceKind,
    ScopedRecord,
    denied,
)
from connectors.slack import mrkdwn as text
from connectors.slack.client import Channel, Message, SlackClient
from connectors.text import truncate

CHANNEL = "channel"
MAX_TEXT = 4_000
MAX_READ_TEXT = 4_000
MAX_TOPIC = 500
MAX_PEOPLE = 30
MAX_RESOLVE_PAGES = 10
RESOLVE_PAGE = 200
MAX_DESCRIBE = 100
HIDDEN = frozenset(
    {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED", "NOT_IN_CHANNEL", "CHANNEL_ARCHIVED"}
)

_CHANNEL_ID = re.compile(r"\A[CG][A-Z0-9]{8,20}\Z")
# Slack channel names: lowercase, no spaces or periods, at most 80 characters.
_CHANNEL_NAME = re.compile(r"\A[^\s#<>|@,.&A-Z]{1,80}\Z")
_TS = re.compile(r"\A\d{9,10}\.\d{6}\Z")
_USER_ID = re.compile(r"\A[UWB][A-Z0-9]{2,20}\Z")
_MENTION = re.compile(r"<@([UW][A-Z0-9]{2,20})(?:\|[^<>]*)?>")
_CURSOR = re.compile(r"\A[A-Za-z0-9=+/_-]{1,500}\Z")


def _channel_name(value: str) -> str:
    """A channel id, or `#name`."""
    if _CHANNEL_ID.match(value):
        return value
    name = value.removeprefix("#").lower()
    if _CHANNEL_NAME.match(name):
        return f"#{name}"
    raise ValueError('must be a channel name such as "#general", or a channel id such as "C0123ABCDEF"')


def _ts(value: str) -> str:
    if not _TS.match(value):
        raise ValueError('must be a message ts such as "1727780000.123456"')
    return value


def _moment(value: str) -> str:
    """An ISO 8601 time as a Slack timestamp. Times without a zone are UTC."""
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("must be an ISO 8601 time such as 2026-10-01T09:00:00Z") from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return f"{moment.timestamp():.6f}"


ChannelName = Annotated[
    str,
    Field(min_length=1, max_length=81, description='A channel name such as "#general", or a channel id.'),
    AfterValidator(_channel_name),
]
Ts = Annotated[str, Field(min_length=1, max_length=20), AfterValidator(_ts)]
Moment = Annotated[
    str, Field(min_length=1, max_length=40, description="An ISO 8601 time."), AfterValidator(_moment)
]
Cursor = Annotated[str, Field(max_length=500)]
WrittenText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MAX_TEXT,
        description="Slack mrkdwn (*bold*, _italic_, `code`, lists). Shown literally: no mentions or links "
        "with labels.",
    ),
    AfterValidator(text.check_written),
]


def _gone() -> OperationError:
    return OperationError(
        "CHANNEL_MOVED", "This channel changed in Slack while Minerva was using it, or the app lost access."
    )


def _cursor(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return cursor


def _next(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("PROVIDER_LIMIT", "Slack returned a page token Minerva cannot use.")
    return cursor


async def _by_name(client: SlackClient, name: str) -> Channel | None:
    cursor = None
    found: list[Channel] = []
    for _ in range(MAX_RESOLVE_PAGES):
        channels, cursor = await client.channels(limit=RESOLVE_PAGE, cursor=cursor)
        found.extend(channel for channel in channels if channel.name == name)
        if cursor is None:
            return found[0] if len(found) == 1 else None
    # Refused whether or not the name was among the channels read, so the refusal says nothing about it.
    raise OperationError(
        "PROVIDER_LIMIT",
        "This workspace has more channels than Minerva searches by name. Use the channel id.",
    )


async def _resolve(binding: Binding, name: str) -> Resource:
    """The channel a call names, as the resource that is authorized. Channels the app cannot see are
    refused like channels without a grant."""
    client: SlackClient = binding.client
    try:
        if name.startswith("#"):
            channel = await _by_name(client, name[1:])
        else:
            channel = await client.channel(name)
            if channel.id != name:
                channel = None
    except OperationError as error:
        if error.code in HIDDEN:
            raise denied() from None
        raise
    if channel is None or not channel.is_conversation_channel or not _CHANNEL_ID.match(channel.id):
        raise denied()
    return binding.resource(CHANNEL, channel.id)


async def _confirm_for_writing(binding: Binding, resource: Resource) -> None:
    """Refuses a post unless the channel is still this one, the app is in it, and it is not archived or
    shared with another organization. The last step before the write."""
    try:
        channel = await binding.client.channel(resource.id)
    except OperationError as error:
        if error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN"}:
            raise _gone() from None
        raise
    if channel.id != resource.id or not channel.is_conversation_channel:
        raise _gone()
    if not channel.is_member:
        raise OperationError(
            "NOT_IN_CHANNEL",
            "The Slack app is not a member of this channel. Someone in the channel can add it (/invite and "
            "the app's name).",
        )
    if channel.is_archived:
        raise OperationError("CHANNEL_ARCHIVED", "This channel is archived.")
    if channel.is_ext_shared or channel.is_pending_ext_shared:
        raise OperationError(
            "EXTERNAL_CHANNEL",
            "Minerva does not post to channels shared with other organizations.",
        )


def _time(ts: str | None) -> str | None:
    if ts is None or not _TS.match(ts):
        return None
    return datetime.fromtimestamp(float(ts), UTC).isoformat().replace("+00:00", "Z")


def _topic(channel: Channel, field: str) -> str | None:
    value = getattr(channel, field)
    shown, _ = truncate(text.redact(value.value) if value else None, MAX_TOPIC)
    return shown or None


def _channel_data(channel: Channel) -> dict[str, Any]:
    return {
        "id": channel.id,
        "name": channel.name,
        "private": channel.is_private,
        "archived": channel.is_archived,
        "shared_with_other_organizations": channel.is_ext_shared or channel.is_pending_ext_shared,
        "topic": _topic(channel, "topic"),
        "purpose": _topic(channel, "purpose"),
        "members": channel.num_members,
    }


async def _people(client: SlackClient, messages: list[Message]) -> dict[str, str]:
    """Names of the authors and of the people mentioned, for at most MAX_PEOPLE people."""
    ids: list[str] = []
    for message in messages:
        if message.user and _USER_ID.match(message.user):
            ids.append(message.user)
        ids.extend(_MENTION.findall(message.text))
    wanted = list(dict.fromkeys(ids))[:MAX_PEOPLE]
    limit = asyncio.Semaphore(5)

    async def name(user_id: str) -> str | None:
        async with limit:
            try:
                user = await client.user(user_id)
            except OperationError as error:
                if error.code in HIDDEN:
                    return None
                raise
        return user.shown_name if user.id == user_id else None

    names = await asyncio.gather(*(name(user_id) for user_id in wanted))
    return {user_id: shown for user_id, shown in zip(wanted, names, strict=True) if shown}


def _message(message: Message, people: dict[str, str]) -> dict[str, Any]:
    body, truncated = truncate(text.redact(message.text), MAX_READ_TEXT)
    mentioned = {user_id: people[user_id] for user_id in _MENTION.findall(message.text) if user_id in people}
    record: dict[str, Any] = {
        "ts": message.ts,
        "time": _time(message.ts),
        "thread_ts": message.thread_ts,
        "reply_count": message.reply_count,
        "latest_reply": message.latest_reply,
        "subtype": message.subtype,
        "author_id": message.user or message.bot_id,
        "author": people.get(message.user or "") or message.username,
        "text": body,
        "text_truncated": truncated,
        "edited": message.edited is not None,
        "mentioned": mentioned,
        "reactions": [{"name": r.name, "count": r.count} for r in message.reactions],
        "files": [
            {"id": f.id, "name": f.name, "title": f.title, "mimetype": f.mimetype, "size": f.size}
            for f in message.files
        ],
    }
    # Attachments carry link previews and messages shared from other channels; Minerva leaves them out.
    if message.attachments:
        record["attachments_not_shown"] = len(message.attachments)
    if message.blocks and not message.text:
        record["content_not_shown"] = True
    return record


async def _messages(binding: Binding, resource: Resource, messages: list[Message]) -> list[ScopedRecord]:
    people = await _people(binding.client, messages)
    return [ScopedRecord(resource, _message(message, people)) for message in messages]


class ListChannels(OperationInput):
    limit: Annotated[int, Field(ge=1, le=200)] = 100
    cursor: Cursor | None = None


async def _prepare_list_channels(binding: Binding, data: ListChannels) -> Prepared:
    async def execute() -> ProviderOutput:
        client: SlackClient = binding.client
        channels, cursor = await client.member_channels(limit=data.limit, cursor=_cursor(data.cursor))
        records = [
            ScopedRecord(binding.resource(CHANNEL, channel.id), _channel_data(channel))
            for channel in channels
            if channel.is_conversation_channel
            and channel.is_member is not False
            and _CHANNEL_ID.match(channel.id)
        ]
        return ProviderOutput(records, _next(cursor))

    return Prepared([Enumerate(CHANNEL, "read")], execute)


LIST_CHANNELS = Operation(
    name="list_channels",
    title="List channels",
    description=(
        "List the Slack channels the app is in that you may read. To get the next page, repeat the "
        "call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListChannels,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_list_channels,
    paginated=True,
)


READ_NOTE = (
    "Links to channels appear without the channel's name, and attachments (link previews, messages shared "
    "from other channels) are left out."
)


class ReadChannel(OperationInput):
    channel: ChannelName
    limit: Annotated[int, Field(ge=1, le=100)] = 20
    after: Moment | None = None
    before: Moment | None = None
    cursor: Cursor | None = None


async def _prepare_read_channel(binding: Binding, data: ReadChannel) -> Prepared:
    resource = await _resolve(binding, data.channel)

    async def execute() -> ProviderOutput:
        messages, cursor = await binding.client.history(
            resource.id,
            limit=data.limit,
            cursor=_cursor(data.cursor),
            oldest=data.after,
            latest=data.before,
        )
        return ProviderOutput(await _messages(binding, resource, messages), _next(cursor))

    return Prepared([Need(resource, "read")], execute)


READ_CHANNEL = Operation(
    name="read_channel",
    title="Read a channel",
    description=(
        "Read a channel's messages, newest first, optionally between two times. Replies in threads "
        "are not included; read_thread reads them. To get the next page, repeat the call with "
        "identical arguments plus the returned next_cursor. " + READ_NOTE
    ),
    input_model=ReadChannel,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_read_channel,
    paginated=True,
)


class ReadThread(OperationInput):
    channel: ChannelName
    thread: Annotated[Ts, Field(description="The ts of the thread's first message, or of any reply in it.")]
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    cursor: Cursor | None = None


async def _prepare_read_thread(binding: Binding, data: ReadThread) -> Prepared:
    resource = await _resolve(binding, data.channel)

    async def execute() -> ProviderOutput:
        messages, cursor = await binding.client.replies(
            resource.id, data.thread, limit=data.limit, cursor=_cursor(data.cursor)
        )
        return ProviderOutput(await _messages(binding, resource, messages), _next(cursor))

    return Prepared([Need(resource, "read")], execute)


READ_THREAD = Operation(
    name="read_thread",
    title="Read a thread",
    description=(
        "Read a thread in a channel, its first message first. To get the next page, repeat the call "
        "with identical arguments plus the returned next_cursor. " + READ_NOTE
    ),
    input_model=ReadThread,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_read_thread,
    paginated=True,
)


WRITE_NOTE = (
    "Text is shown literally: it cannot mention people or notify the channel, and may not link to Slack. "
    "Everyone in the channel sees it, posted as the Minerva app."
)

POST_CONSENT = (frozenset({"chat:write"}),)


def _posted(resource: Resource, ts: str | None, thread_ts: str | None) -> dict[str, Any]:
    return {"written": True, "channel": resource.id, "ts": ts, "time": _time(ts), "thread_ts": thread_ts}


class PostMessage(OperationInput):
    channel: ChannelName
    text: WrittenText


async def _prepare_post_message(binding: Binding, data: PostMessage) -> Prepared:
    resource = await _resolve(binding, data.channel)

    async def execute() -> ProviderOutput:
        client: SlackClient = binding.client
        await _confirm_for_writing(binding, resource)
        posted = await client.post(resource.id, text.escape(data.text), thread_ts=None)
        ts = posted.ts if posted.ts and _TS.match(posted.ts) else None
        return ProviderOutput([ScopedRecord(resource, _posted(resource, ts, None))])

    return Prepared([Need(resource, "post")], execute)


POST_MESSAGE = Operation(
    name="post_message",
    title="Post to a channel",
    description="Post a new message to a channel where you have post permission. " + WRITE_NOTE,
    input_model=PostMessage,
    needs=((CHANNEL, "post"),),
    prepare=_prepare_post_message,
    consent=POST_CONSENT,
    mutates=True,
)


class Reply(OperationInput):
    channel: ChannelName
    thread: Annotated[
        Ts,
        Field(description="The ts of a message in this channel; replying to a reply joins its thread."),
    ]
    text: WrittenText


async def _prepare_reply(binding: Binding, data: Reply) -> Prepared:
    resource = await _resolve(binding, data.channel)

    async def execute() -> ProviderOutput:
        client: SlackClient = binding.client
        not_here = OperationError("INVALID_ARGUMENTS", "thread must be a message in this channel.")
        try:
            messages, _ = await client.replies(resource.id, data.thread, limit=1, cursor=None)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise not_here from None
            raise
        if not messages:
            raise not_here
        parent = messages[0]
        thread_ts = parent.thread_ts or parent.ts
        if not _TS.match(thread_ts):
            raise client.unexpected()
        # Last before the write, so the channel is checked as close to it as Slack allows.
        await _confirm_for_writing(binding, resource)
        posted = await client.post(resource.id, text.escape(data.text), thread_ts=thread_ts)
        ts = posted.ts if posted.ts and _TS.match(posted.ts) else None
        return ProviderOutput([ScopedRecord(resource, _posted(resource, ts, thread_ts))])

    return Prepared([Need(resource, "reply")], execute)


REPLY = Operation(
    name="reply",
    title="Reply in a thread",
    description=(
        "Reply in a thread of a channel where you have reply permission; the reply is not sent to "
        "the channel itself. " + WRITE_NOTE
    ),
    input_model=Reply,
    needs=((CHANNEL, "reply"),),
    prepare=_prepare_reply,
    consent=POST_CONSENT,
    mutates=True,
)


class SlackConnector(Connector):
    slug = "slack"
    name = "Slack"
    kinds = (
        ResourceKind(
            CHANNEL,
            "Channel",
            ("read", "reply", "post"),
            wildcard=True,
            note=(
                "Minerva acts as the Slack app and reaches only channels the app has been added to in Slack "
                "(/invite and the app's name). Posting to channels shared with other organizations is "
                "refused."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read messages"),
        ActionSpec("reply", "Reply in threads", requires="read"),
        ActionSpec("post", "Post to the channel", requires="read"),
    )
    auth = OAuth2(
        app="slack",
        authorize_url="https://slack.com/oauth/v2/authorize",
        token_url="https://slack.com/api/oauth.v2.access",  # noqa: S106
        scopes=("channels:read", "groups:read", "channels:history", "groups:history", "users:read"),
        scope_separator=",",
        client_auth="basic",
        # Slack treats an app that uses PKCE as a public client, without its secret.
        pkce=False,
    )

    operations = (LIST_CHANNELS, READ_CHANNEL, READ_THREAD, POST_MESSAGE, REPLY)

    def client(self, access_token: str) -> SlackClient:
        return SlackClient(access_token)

    async def account(self, client: SlackClient) -> Account:
        identity = await client.auth_test()
        if not client.bot or identity.is_enterprise_install:
            raise OperationError(
                "UNSUPPORTED_ACCOUNT",
                "Connect Slack by installing the app into one workspace; organization-wide installs are not "
                "supported.",
            )
        # The app's bot user, in this workspace: another app, even in the same workspace, is another account.
        label = f"{identity.user} ({identity.team})" if identity.user else identity.team
        return Account(id=f"{identity.team_id}:{identity.user_id}", label=label or identity.team_id)

    async def discover(
        self, client: SlackClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            channels, after = await client.channels(limit=RESOLVE_PAGE, cursor=_cursor(cursor))
            return DiscoveryPage([_item(c) for c in channels if _listable(c)], _next(after))
        folded = query.removeprefix("#").casefold()
        matches: list[Channel] = []
        after = None
        for _ in range(MAX_RESOLVE_PAGES):
            channels, after = await client.channels(limit=RESOLVE_PAGE, cursor=after)
            matches.extend(c for c in channels if _listable(c) and folded in c.name.casefold())
            after = _next(after)
            if after is None:
                return DiscoveryPage([_item(channel) for channel in matches])
        raise OperationError("PROVIDER_LIMIT", "There are more channels than Minerva can search.")

    async def describe(self, client: SlackClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = [channel_id for channel_id in ids if _CHANNEL_ID.match(channel_id)][:MAX_DESCRIBE]
        limit = asyncio.Semaphore(5)

        async def name(channel_id: str) -> str | None:
            async with limit:
                try:
                    channel = await client.channel(channel_id)
                except OperationError as error:
                    if error.code in HIDDEN:
                        return None
                    raise
            return (
                f"#{channel.name}" if channel.id == channel_id and channel.is_conversation_channel else None
            )

        names = await asyncio.gather(*(name(channel_id) for channel_id in wanted))
        return {channel_id: shown for channel_id, shown in zip(wanted, names, strict=True) if shown}


def _listable(channel: Channel) -> bool:
    return channel.is_conversation_channel and bool(_CHANNEL_ID.match(channel.id))


def _item(channel: Channel) -> DiscoveryItem:
    name = f"#{channel.name}"
    if not channel.is_member:
        name += " (app not added)"
    return DiscoveryItem(channel.id, name)
