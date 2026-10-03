"""Intercom's REST API, at a pinned version, so response shapes do not change under Minerva.

Requests go to api.intercom.io, which Intercom routes to the workspace's region (US, EU or Australia).
Responses are validated before use, and read with a byte limit: a conversation carries up to 500 parts.
Intercom's error messages are never passed on.
"""

import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OperationError
from connectors.http import ProviderHTTP

API_URL = "https://api.intercom.io"
VERSION = "2.16"
# Conversation, team and admin ids are positive integers; leading zeros are refused, so each has one spelling.
ID = re.compile(r"^[1-9][0-9]{0,19}$")
MAX_RESPONSE = 4 * 1024 * 1024
MAX_TEAMS = 500
# Intercom's cursors are opaque; they are checked, never followed as addresses.
_CURSOR = re.compile(r"^[\x21-\x7e]{1,900}$")


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class App(Model):
    id_code: str
    name: str | None = None


class Me(Model):
    id: str
    name: str | None = None
    email: str | None = None
    app: App | None = None


class Team(Model):
    id: str
    name: str | None = None
    admin_ids: list[int] = []


class Teams(Model):
    teams: list[Team] = []


class Author(Model):
    type: str | None = None
    id: str | None = None
    name: str | None = None
    email: str | None = None


class Attachment(Model):
    name: str | None = None


class Source(Model):
    id: str | None = None
    delivered_as: str | None = None
    subject: str | None = None
    body: str | None = None
    author: Author | None = None
    attachments: list[Attachment] = []
    redacted: bool = False


class Part(Model):
    id: str
    part_type: str | None = None
    body: str | None = None
    created_at: int | None = None
    author: Author | None = None
    attachments: list[Attachment] = []
    redacted: bool = False


class Parts(Model):
    conversation_parts: list[Part] = []
    total_count: int = 0


class Conversation(Model):
    id: str
    title: str | None = None
    created_at: int | None = None
    updated_at: int | None = None
    waiting_since: int | None = None
    state: str | None = None
    priority: str | None = None
    # Required: where a conversation is decides who may see it, so a response without it is not guessed at.
    # Intercom gives 0 for no team.
    team_assignee_id: int | None
    source: Source | None = None
    conversation_parts: Parts | None = None


class Found(Model):
    id: str


class Next(Model):
    starting_after: str | None = None


class Pages(Model):
    next: Next | None = None


class SearchPage(Model):
    conversations: list[Found] = []
    pages: Pages | None = None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    try:
        errors = response.json().get("errors") or []
        codes = {e.get("code") for e in errors if isinstance(e, dict)}
    except ValueError, AttributeError:
        codes = set()
    if response.status_code == 403 and "api_plan_restricted" in codes:
        return OperationError("PROVIDER_FORBIDDEN", "This Intercom workspace's plan does not include this.")
    if response.status_code == 403:
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "Intercom refused this request. The Intercom app may lack a permission in Minerva's setup guide, or "
            "the teammate may not have access.",
        )
    return None


def cursor(value: str | None) -> str | None:
    """A cursor from a call, checked before it is sent."""
    if value is not None and not _CURSOR.match(value):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return value


class IntercomClient:
    def __init__(
        self, token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._http = ProviderHTTP(
            "Intercom",
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Intercom-Version": VERSION,
            },
            transport=transport,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def _read[M: BaseModel](
        self, model: type[M], path: str, *, method: str = "GET", **kwargs: Any
    ) -> M:
        response = await self._http.bounded(
            path,
            method=method,
            limit=MAX_RESPONSE,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Intercom's response was too large to read."),
            **kwargs,
        )
        try:
            return model.model_validate_json(response.content)
        except ValueError as error:
            raise self.unexpected() from error

    def _checked(self, conversation: Conversation, conversation_id: str | None = None) -> Conversation:
        if not ID.match(conversation.id) or (
            conversation_id is not None and conversation.id != conversation_id
        ):
            raise self.unexpected()
        if conversation.team_assignee_id is not None and conversation.team_assignee_id < 0:
            raise self.unexpected()
        return conversation

    async def me(self) -> Me:
        me = await self._read(Me, "/me")
        if not ID.match(me.id):
            raise self.unexpected()
        return me

    async def teams(self) -> list[Team]:
        found = await self._read(Teams, "/teams")
        if len(found.teams) > MAX_TEAMS:
            raise OperationError("PROVIDER_LIMIT", "This workspace has more teams than Minerva reads.")
        return [team for team in found.teams if ID.match(team.id)]

    async def conversation(self, conversation_id: str) -> Conversation:
        found = await self._read(Conversation, f"/conversations/{conversation_id}")
        return self._checked(found, conversation_id)

    async def search(
        self, query: dict[str, Any], *, per_page: int, starting_after: str | None
    ) -> tuple[list[str], str | None]:
        """The ids of one page of matching conversations, and the cursor of the next page."""
        pagination: dict[str, Any] = {"per_page": per_page}
        if starting_after is not None:
            pagination["starting_after"] = cursor(starting_after)
        page = await self._read(
            SearchPage,
            "/conversations/search",
            method="POST",
            json={"query": query, "pagination": pagination},
        )
        if any(not ID.match(found.id) for found in page.conversations):
            raise self.unexpected()
        after = page.pages.next.starting_after if page.pages and page.pages.next else None
        if after is not None and not _CURSOR.match(after):
            raise OperationError("PROVIDER_LIMIT", "Intercom returned a page token Minerva cannot use.")
        return [found.id for found in page.conversations], after

    async def reply(self, conversation_id: str, body: dict[str, Any]) -> Conversation:
        """A reply or note, as an admin; Intercom answers with the conversation."""
        found = await self._http.parsed(
            Conversation, "POST", f"/conversations/{conversation_id}/reply", json=body
        )
        return self._checked(found, conversation_id)
