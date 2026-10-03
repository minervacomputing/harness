"""Microsoft Teams. Resources are teams and their channels; agents read channel messages, post and reply.

Only work and school accounts have Teams in Graph: a personal Microsoft account is refused when connecting.
Chats (one-to-one and group) and meetings are not reached.

Teams and channels are one hierarchical kind. A team's id is its GUID, in lower case; a channel's id is
Graph's (`19:…@thread.tacv2`), with its team as ancestor. What is allowed on a team covers every channel in
it, private channels the account is a member of and channels created later included. A channel belongs to a
team only if Graph lists it among the channels that team hosts: each call lists them first and refuses a
channel that is not there, so a channel cannot be named under a team it is not in. Messages Graph returns
for another team or channel than the one asked for are dropped.

Reading text hides channels and teams other messages could show (see `html`). Writing posts as the signed-in
user, shown literally, without mentions and without links to Teams. Every write first lists the channel
again, and refuses shared channels, which can include people of other organizations. A standard or private
channel can have guests from outside the organization too: refusing shared channels limits the kind of
channel, not who reads it. Importance is never set, so a post never notifies as urgent.

Reading messages needs ChannelMessage.Read.All, which a tenant administrator must consent to; listing teams
and channels and posting do not.
"""

import asyncio
import re
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
from connectors.microsoft import consent, consent_all, oauth
from connectors.teams import html
from connectors.teams.client import Channel, Message, Team, TeamsClient
from connectors.text import truncate

CHANNEL = "channel"
READ_CONSENT = consent("ChannelMessage.Read.All")
POST_CONSENT = consent("ChannelMessage.Send")
# Replying first reads the message replied to.
REPLY_CONSENT = consent_all("ChannelMessage.Send", "ChannelMessage.Read.All")

MAX_TEXT = 4_000
MAX_READ_TEXT = 4_000
MAX_SUBJECT = 500
MAX_TEAMS = 100
DISCOVERY_PAGE = 10
DISCOVERY_SCAN = 25
CONCURRENCY = 8
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN"})
WRITABLE = frozenset({"standard", "private"})

_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_CHANNEL_ID = re.compile(r"^19:[A-Za-z0-9._=+-]{1,200}@thread\.[a-z0-9]{1,20}$")
_MESSAGE_ID = re.compile(r"^\d{1,20}$")
_OFFSET = re.compile(r"^\d{1,4}$")


def _team_id(value: str) -> str:
    folded = value.lower()
    if not _GUID.match(folded):
        raise ValueError("must be a team id (a GUID) from list_teams or list_channels")
    return folded


def _channel_id(value: str) -> str:
    if not _CHANNEL_ID.match(value):
        raise ValueError('must be a channel id such as "19:…@thread.tacv2", from list_channels')
    return value


TeamId = Annotated[
    str, Field(min_length=36, max_length=36, description="A team's id."), AfterValidator(_team_id)
]
ChannelId = Annotated[
    str, Field(min_length=1, max_length=240, description="A channel's id."), AfterValidator(_channel_id)
]
MessageId = Annotated[str, Field(pattern=r"^\d{1,20}$")]
Cursor = Annotated[str, Field(max_length=1000)]
WrittenText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MAX_TEXT,
        description="Plain text, shown literally: no formatting, mentions or links to Teams.",
    ),
    AfterValidator(html.check_written),
]


def _unseen(error: OperationError) -> bool:
    return error.code in HIDDEN


def _team_key(team_id: str | None) -> str | None:
    folded = (team_id or "").lower()
    return folded if _GUID.match(folded) else None


async def _joined(client: TeamsClient) -> list[Team]:
    """The teams the account is in, by id, with ids in lower case."""
    teams = [
        team.model_copy(update={"id": key})
        for team in await client.joined_teams()
        if (key := _team_key(team.id)) is not None
    ]
    return sorted({team.id: team for team in teams}.values(), key=lambda team: team.id)


async def _channels(client: TeamsClient, team_id: str) -> list[Channel] | None:
    """The channels a team hosts that the account can see, or None for a team it cannot see."""
    try:
        channels = await client.channels(team_id)
    except OperationError as error:
        if _unseen(error):
            return None
        raise
    return [channel for channel in channels if _CHANNEL_ID.match(channel.id)]


async def _resolve(binding: Binding, team_id: str, channel_id: str) -> tuple[Resource, Channel]:
    """The channel a call names, in its team. A channel the team does not host is refused like a channel
    without a grant."""
    channels = await _channels(binding.client, team_id)
    channel = next((c for c in channels or [] if c.id == channel_id), None)
    if channel is None:
        raise denied()
    return binding.resource(CHANNEL, channel.id, (team_id,)), channel


async def _confirm_for_writing(binding: Binding, resource: Resource) -> None:
    """Refuses a write unless the team still hosts the channel and the channel is not shared. The last
    step before the write."""
    channels = await _channels(binding.client, resource.within[0])
    channel = next((c for c in channels or [] if c.id == resource.id), None)
    if channel is None:
        raise OperationError(
            "CHANNEL_MOVED", "This channel changed in Teams while Minerva was using it, or access was lost."
        )
    if channel.membership_type not in WRITABLE:
        raise OperationError(
            "EXTERNAL_CHANNEL",
            "Minerva posts only to standard and private channels, not to shared channels, which can include "
            "people of other organizations.",
        )


def _in(message: Message, resource: Resource) -> bool:
    """Whether Graph says the message is in this channel."""
    identity = message.channel_identity
    return (
        identity is not None
        and _team_key(identity.team_id) == resource.within[0]
        and identity.channel_id == resource.id
        and bool(_MESSAGE_ID.match(message.id))
    )


def _plain(value: str | None) -> str | None:
    shown, _ = truncate(html.redact(value) if value else None, MAX_SUBJECT)
    return shown or None


def _channel_data(team_id: str, channel: Channel) -> dict[str, Any]:
    return {
        "id": channel.id,
        "team_id": team_id,
        "name": channel.display_name,
        "description": _plain(channel.description),
        "membership": channel.membership_type,
        "link": channel.web_url,
    }


def _team_data(team: Team) -> dict[str, Any]:
    return {
        "id": team.id,
        "type": "team",
        "name": team.display_name,
        "description": _plain(team.description),
        "archived": team.is_archived,
    }


def _message(message: Message, resource: Resource) -> dict[str, Any]:
    deleted = message.deleted_date_time is not None
    sender = message.sender
    author = (sender.user or sender.application) if sender else None
    record: dict[str, Any] = {
        "id": message.id,
        "team_id": resource.within[0],
        "channel_id": resource.id,
        "reply_to_id": message.reply_to_id,
        "created_time": message.created_date_time,
        "edited_time": message.last_edited_date_time,
        "deleted": deleted,
        "author": author.display_name if author else None,
        "author_id": author.id if author else None,
        "importance": message.importance,
        "link": message.web_url,
    }
    if deleted:
        return record | {"subject": None, "text": "", "text_truncated": False, "reactions": [], "files": []}
    body = message.body
    text, truncated = truncate(
        html.read(body.content if body else None, body.content_type if body else None, message.mentions),
        MAX_READ_TEXT,
    )
    counts: dict[str, int] = {}
    for reaction in message.reactions:
        if reaction.reaction_type:
            counts[reaction.reaction_type] = counts.get(reaction.reaction_type, 0) + 1
    files = [a for a in message.attachments if a.content_type == "reference"]
    record |= {
        "subject": _plain(message.subject),
        "text": text,
        "text_truncated": truncated,
        "reactions": [{"type": kind, "count": count} for kind, count in counts.items()],
        "files": [{"name": a.name} for a in files],
    }
    # Cards, quoted and forwarded messages can carry what other channels say; Minerva leaves them out.
    if len(message.attachments) > len(files):
        record["attachments_not_shown"] = len(message.attachments) - len(files)
    return record


def _messages(messages: list[Message], resource: Resource) -> list[ScopedRecord]:
    """User messages Graph places in this channel; system events (members added, renames) left out."""
    return [
        ScopedRecord(resource, _message(message, resource))
        for message in messages
        if message.message_type == "message" and _in(message, resource)
    ]


def _not_a_thread() -> OperationError:
    return OperationError(
        "INVALID_ARGUMENTS", "message_id must be the first message of a thread in this channel."
    )


async def _root(binding: Binding, resource: Resource, message_id: str) -> Message:
    """The message that starts a thread in this channel, or INVALID_ARGUMENTS."""
    try:
        message = await binding.client.message(resource.within[0], resource.id, message_id)
    except OperationError as error:
        if _unseen(error):
            raise _not_a_thread() from None
        raise
    if message.id != message_id or message.reply_to_id is not None or not _in(message, resource):
        raise _not_a_thread()
    return message


class ListTeams(OperationInput):
    pass


async def _prepare_list_teams(binding: Binding, data: ListTeams) -> Prepared:
    async def execute() -> ProviderOutput:
        teams = await _joined(binding.client)
        return ProviderOutput([ScopedRecord(binding.resource(CHANNEL, t.id), _team_data(t)) for t in teams])

    return Prepared([Enumerate(CHANNEL, "read")], execute)


LIST_TEAMS = Operation(
    name="list_teams",
    title="List teams",
    description=(
        "List the Microsoft Teams teams you may read as a whole. Channels you may read in other teams are "
        "listed by list_channels."
    ),
    input_model=ListTeams,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_list_teams,
)


class ListChannels(OperationInput):
    team_id: Annotated[TeamId | None, Field(description="A team's id; without one, all teams.")] = None


async def _prepare_list_channels(binding: Binding, data: ListChannels) -> Prepared:
    async def execute() -> ProviderOutput:
        client: TeamsClient = binding.client
        incomplete = False
        if data.team_id is not None:
            team_ids = [data.team_id]
        else:
            team_ids = [team.id for team in await _joined(client)]
            incomplete = len(team_ids) > MAX_TEAMS
            team_ids = team_ids[:MAX_TEAMS]
        limit = asyncio.Semaphore(CONCURRENCY)

        async def listed(team_id: str) -> list[Channel]:
            async with limit:
                return await _channels(client, team_id) or []

        found = await asyncio.gather(*(listed(team_id) for team_id in team_ids))
        records = [
            ScopedRecord(binding.resource(CHANNEL, channel.id, (team_id,)), _channel_data(team_id, channel))
            for team_id, channels in zip(team_ids, found, strict=True)
            for channel in channels
        ]
        return ProviderOutput(records, incomplete=incomplete)

    return Prepared([Enumerate(CHANNEL, "read")], execute)


LIST_CHANNELS = Operation(
    name="list_channels",
    title="List channels",
    description="List the channels you may read, in one team or in all the teams the account is in.",
    input_model=ListChannels,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_list_channels,
)


READ_NOTE = (
    "Mentions of channels and teams, links to Teams and quotes appear without their content; "
    "cards and forwarded messages are left out, and files appear by name only."
)


class ReadChannel(OperationInput):
    team_id: TeamId
    channel_id: ChannelId
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_read_channel(binding: Binding, data: ReadChannel) -> Prepared:
    resource, _ = await _resolve(binding, data.team_id, data.channel_id)

    async def execute() -> ProviderOutput:
        messages, cursor = await binding.client.messages(
            data.team_id, data.channel_id, limit=data.limit, cursor=data.cursor
        )
        return ProviderOutput(_messages(messages, resource), cursor)

    return Prepared([Need(resource, "read")], execute)


READ_CHANNEL = Operation(
    name="read_channel",
    title="Read a channel",
    description=(
        "Read the messages that start threads in a channel. Replies are not included; read_thread reads "
        "them. To get the next page, repeat the call with identical arguments plus the returned "
        "next_cursor. " + READ_NOTE
    ),
    input_model=ReadChannel,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_read_channel,
    consent=READ_CONSENT,
    paginated=True,
)


class ReadThread(OperationInput):
    team_id: TeamId
    channel_id: ChannelId
    message_id: Annotated[MessageId, Field(description="The id of the message that starts the thread.")]
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_read_thread(binding: Binding, data: ReadThread) -> Prepared:
    resource, _ = await _resolve(binding, data.team_id, data.channel_id)

    async def execute() -> ProviderOutput:
        client: TeamsClient = binding.client
        records: list[ScopedRecord] = []
        if data.cursor is None:
            records = _messages([await _root(binding, resource, data.message_id)], resource)
        try:
            replies, cursor = await client.replies(
                data.team_id, data.channel_id, data.message_id, limit=data.limit, cursor=data.cursor
            )
        except OperationError as error:
            if _unseen(error):
                raise _not_a_thread() from None
            raise
        records += _messages([r for r in replies if r.reply_to_id == data.message_id], resource)
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], execute)


READ_THREAD = Operation(
    name="read_thread",
    title="Read a thread",
    description=(
        "Read a thread in a channel: its first message (on the first page), then its replies. To get the "
        "next page, repeat the call with identical arguments plus the returned next_cursor. " + READ_NOTE
    ),
    input_model=ReadThread,
    needs=((CHANNEL, "read"),),
    prepare=_prepare_read_thread,
    consent=READ_CONSENT,
    paginated=True,
)


WRITE_NOTE = (
    "Text is shown literally: it cannot format, mention anyone, or link to Teams. Everyone in the channel "
    "sees it, posted as the signed-in user. Shared channels are refused. The number of writes per run is "
    "limited."
)


def _posted(binding: Binding, resource: Resource, message: Message, reply_to: str | None) -> dict[str, Any]:
    if not _in(message, resource) or message.reply_to_id != reply_to:
        raise binding.client.unexpected()
    return {
        "written": True,
        "id": message.id,
        "team_id": resource.within[0],
        "channel_id": resource.id,
        "reply_to_id": reply_to,
        "created_time": message.created_date_time,
        "link": message.web_url,
    }


class PostMessage(OperationInput):
    team_id: TeamId
    channel_id: ChannelId
    text: WrittenText


async def _prepare_post_message(binding: Binding, data: PostMessage) -> Prepared:
    resource, _ = await _resolve(binding, data.team_id, data.channel_id)

    async def execute() -> ProviderOutput:
        await _confirm_for_writing(binding, resource)
        message = await binding.client.post(
            data.team_id, data.channel_id, html.written(data.text), reply_to=None
        )
        return ProviderOutput([ScopedRecord(resource, _posted(binding, resource, message, None))])

    return Prepared([Need(resource, "post")], execute)


POST_MESSAGE = Operation(
    name="post_message",
    title="Post to a channel",
    description="Start a new thread in a channel where you have post permission. " + WRITE_NOTE,
    input_model=PostMessage,
    needs=((CHANNEL, "post"),),
    prepare=_prepare_post_message,
    consent=POST_CONSENT,
    mutates=True,
)


class Reply(OperationInput):
    team_id: TeamId
    channel_id: ChannelId
    message_id: Annotated[MessageId, Field(description="The id of the message that starts the thread.")]
    text: WrittenText


async def _prepare_reply(binding: Binding, data: Reply) -> Prepared:
    resource, _ = await _resolve(binding, data.team_id, data.channel_id)

    async def execute() -> ProviderOutput:
        root = await _root(binding, resource, data.message_id)
        if root.message_type != "message" or root.deleted_date_time is not None:
            raise _not_a_thread()
        # Last before the write, so the channel is checked as close to it as Graph allows.
        await _confirm_for_writing(binding, resource)
        message = await binding.client.post(
            data.team_id, data.channel_id, html.written(data.text), reply_to=data.message_id
        )
        return ProviderOutput([ScopedRecord(resource, _posted(binding, resource, message, data.message_id))])

    return Prepared([Need(resource, "reply")], execute)


REPLY = Operation(
    name="reply",
    title="Reply in a thread",
    description="Reply in a thread of a channel where you have reply permission. " + WRITE_NOTE,
    input_model=Reply,
    needs=((CHANNEL, "reply"),),
    prepare=_prepare_reply,
    consent=REPLY_CONSENT,
    mutates=True,
)


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not _OFFSET.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return int(cursor)


async def _items(client: TeamsClient, teams: list[Team]) -> list[tuple[Team, list[Channel]]]:
    limit = asyncio.Semaphore(CONCURRENCY)

    async def listed(team: Team) -> list[Channel]:
        async with limit:
            return await _channels(client, team.id) or []

    return list(zip(teams, await asyncio.gather(*(listed(team) for team in teams)), strict=True))


def _team_name(team: Team) -> str:
    name = team.display_name or team.id
    return f"{name} (archived)" if team.is_archived else name


class TeamsConnector(Connector):
    slug = "teams"
    name = "Microsoft Teams"
    kinds = (
        ResourceKind(
            CHANNEL,
            "Channel",
            ("read", "reply", "post"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Access to a team covers all its channels, including private channels the account is in "
                "and channels added later. Agents post as you. Posting to shared channels is refused."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read messages"),
        ActionSpec("reply", "Reply in threads", requires="read"),
        ActionSpec("post", "Start threads", requires="read"),
    )
    # Listing teams and channels is enough to connect; reading and writing messages are asked for once the
    # user allows them.
    auth = oauth("Team.ReadBasic.All", "Channel.ReadBasic.All")

    operations = (LIST_TEAMS, LIST_CHANNELS, READ_CHANNEL, READ_THREAD, POST_MESSAGE, REPLY)

    def client(self, access_token: str) -> TeamsClient:
        return TeamsClient(access_token)

    async def account(self, client: TeamsClient) -> Account:
        user = await client.me()
        if not _GUID.match(user.id.lower()):
            raise OperationError(
                "UNSUPPORTED_ACCOUNT", "Microsoft Teams works with work and school accounts only."
            )
        return Account(
            id=user.id, label=user.mail or user.user_principal_name or user.display_name or "Microsoft Teams"
        )

    async def discover(
        self, client: TeamsClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        """Whole teams per page, each followed by its channels, so a page never splits a team."""
        teams = await _joined(client)
        start = _offset(cursor)
        folded = query.casefold() if query else None
        items: list[DiscoveryItem] = []
        end = start
        while end < len(teams) and end - start < (DISCOVERY_SCAN if folded else DISCOVERY_PAGE):
            chunk = teams[end : end + DISCOVERY_PAGE]
            end += len(chunk)
            for team, channels in await _items(client, chunk):
                name = _team_name(team)
                found = [DiscoveryItem(team.id, name)]
                found += [DiscoveryItem(c.id, f"{name} / {c.display_name or c.id}") for c in channels]
                items += [item for item in found if folded is None or folded in item.name.casefold()]
            if not folded or items:
                break
        return DiscoveryPage(items, str(end) if end < len(teams) else None)

    async def describe(self, client: TeamsClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        if not any(_GUID.match(i) or _CHANNEL_ID.match(i) for i in wanted):
            return {}
        teams = (await _joined(client))[:MAX_TEAMS]
        names: dict[str, str] = {team.id: _team_name(team) for team in teams if team.id in wanted}
        if any(_CHANNEL_ID.match(i) for i in wanted):
            for team, channels in await _items(client, teams):
                for channel in channels:
                    if channel.id in wanted:
                        names[channel.id] = f"{_team_name(team)} / {channel.display_name or channel.id}"
        return names
