"""Microsoft Graph, for Teams: the teams the account joined, their channels, and channel messages.

Teams pages messages with a `$skiptoken` that is not always the URL-safe token other Graph lists use (it
can be JSON), so this client keeps its own page cursor: the token itself, checked to be printable and
short enough to store, and sent back as a query parameter on a request Minerva builds.
"""

import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from pydantic import Field

from connectors.base import OperationError
from connectors.microsoft import Graph, Model, segment

CHANNEL_FIELDS = "id,displayName,description,membershipType,webUrl"
MAX_PAGES = 10
# What the run's page token table stores, less the prefix.
_TOKEN = re.compile(r"^[\x21-\x7e]{1,990}$")
PREFIX = "t:"


class Team(Model):
    id: str
    display_name: str | None = None
    description: str | None = None
    is_archived: bool | None = None


class Channel(Model):
    id: str
    display_name: str | None = None
    description: str | None = None
    membership_type: str | None = None
    web_url: str | None = None


class Identity(Model):
    id: str | None = None
    display_name: str | None = None


class Sender(Model):
    user: Identity | None = None
    application: Identity | None = None


class Body(Model):
    content_type: str | None = None
    content: str | None = None


class ChannelIdentity(Model):
    team_id: str | None = None
    channel_id: str | None = None


class Mentioned(Model):
    user: Identity | None = None
    application: Identity | None = None
    conversation: dict[str, Any] | None = None
    tag: dict[str, Any] | None = None


class Mention(Model):
    id: int | None = None
    mentioned: Mentioned | None = None


class Attachment(Model):
    content_type: str | None = None
    name: str | None = None


class Reaction(Model):
    reaction_type: str | None = None


class Message(Model):
    id: str
    reply_to_id: str | None = None
    message_type: str | None = None
    created_date_time: str | None = None
    last_edited_date_time: str | None = None
    deleted_date_time: str | None = None
    subject: str | None = None
    importance: str | None = None
    web_url: str | None = None
    sender: Sender | None = Field(None, alias="from")
    body: Body | None = None
    channel_identity: ChannelIdentity | None = None
    attachments: list[Attachment] = []
    mentions: list[Mention] = []
    reactions: list[Reaction] = []


def page_params(cursor: str | None) -> dict[str, str]:
    if cursor is None:
        return {}
    token = cursor.removeprefix(PREFIX)
    if not cursor.startswith(PREFIX) or not _TOKEN.match(token):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return {"$skiptoken": token}


def next_cursor(next_link: Any) -> str | None:
    """The cursor for the next page, taken out of Graph's nextLink; the link itself is never requested."""
    if next_link is None:
        return None
    unusable = OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.")
    if not isinstance(next_link, str) or len(next_link) > 4000:
        raise unusable
    token = parse_qs(urlsplit(next_link).query).get("$skiptoken")
    if not token or len(token) != 1 or not _TOKEN.match(token[0]):
        raise unusable
    return f"{PREFIX}{token[0]}"


class TeamsClient(Graph):
    """Thin async client for the parts of Microsoft Graph Teams channels use."""

    def __init__(self, access_token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__("Microsoft Teams", access_token, transport=transport)

    def _list[M: Model](self, model: type[M], body: dict[str, Any]) -> tuple[list[M], str | None]:
        items = body.get("value")
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(model, item) for item in items], next_cursor(body.get("@odata.nextLink"))

    async def _all[M: Model](self, model: type[M], path: str, params: dict[str, str]) -> list[M]:
        """Every page of a list, up to MAX_PAGES; more is PROVIDER_LIMIT rather than a partial answer."""
        found: list[M] = []
        cursor = None
        for _ in range(MAX_PAGES):
            items, cursor = self._list(model, await self.get(path, params=params | page_params(cursor)))
            found.extend(items)
            if cursor is None:
                return found
        raise OperationError("PROVIDER_LIMIT", "Microsoft Teams returned more than Minerva reads.")

    async def joined_teams(self) -> list[Team]:
        return await self._all(Team, "/me/joinedTeams", {})

    async def channels(self, team_id: str) -> list[Channel]:
        """The channels the team hosts that the account can see."""
        return await self._all(Channel, f"/teams/{segment(team_id)}/channels", {"$select": CHANNEL_FIELDS})

    async def messages(
        self, team_id: str, channel_id: str, *, limit: int, cursor: str | None
    ) -> tuple[list[Message], str | None]:
        """A channel's messages that start threads (without their replies)."""
        body = await self.get(
            f"/teams/{segment(team_id)}/channels/{segment(channel_id)}/messages",
            params={"$top": str(limit), **page_params(cursor)},
        )
        return self._list(Message, body)

    async def message(self, team_id: str, channel_id: str, message_id: str) -> Message:
        return self._parse(
            Message,
            await self.get(
                f"/teams/{segment(team_id)}/channels/{segment(channel_id)}/messages/{segment(message_id)}"
            ),
        )

    async def replies(
        self, team_id: str, channel_id: str, message_id: str, *, limit: int, cursor: str | None
    ) -> tuple[list[Message], str | None]:
        body = await self.get(
            f"/teams/{segment(team_id)}/channels/{segment(channel_id)}/messages/{segment(message_id)}/replies",
            params={"$top": str(limit), **page_params(cursor)},
        )
        return self._list(Message, body)

    async def post(self, team_id: str, channel_id: str, html: str, *, reply_to: str | None) -> Message:
        """The one write of an operation: a new message in a channel, or a reply to one."""
        path = f"/teams/{segment(team_id)}/channels/{segment(channel_id)}/messages"
        if reply_to is not None:
            path += f"/{segment(reply_to)}/replies"
        return await self._http.parsed(
            Message, "POST", path, json={"body": {"contentType": "html", "content": html}}
        )
