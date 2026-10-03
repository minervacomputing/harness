"""Intercom's read operations: inboxes, conversation search and single conversations."""

import asyncio
import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
)
from connectors.intercom import html
from connectors.intercom.client import Attachment, Author, Conversation, IntercomClient, Part
from connectors.intercom.inboxes import (
    INBOX,
    NO_TEAM,
    NO_TEAM_NAME,
    ConversationId,
    InboxName,
    inbox_of,
    inbox_resource,
    iso,
    resolve_conversation,
    resolve_inbox,
    unplaced,
)
from connectors.text import single_line, truncate

MAX_SEARCH_WORDS = 5
CONCURRENCY = 5
MAX_PREVIEW = 300
MAX_MESSAGE = 4_000
MAX_MESSAGES = 50
MAX_SHORT = 500
MAX_ATTACHMENTS = 20

Cursor = Annotated[str, Field(max_length=1000)]
_WORD = re.compile(r"\w+")
# Parts that carry a message. Others (assignments, state changes, tags, events) say who did what, which can
# name teams and teammates elsewhere; they are left out.
_MESSAGE_PARTS = frozenset({"comment", "note", "quick_reply", "close"})
# Authors shown by name. A team as author names another inbox; it is shown without a name.
_AUTHORS = frozenset({"admin", "user", "lead", "contact", "bot"})


def short(value: str | None, limit: int = MAX_SHORT) -> str | None:
    shown, _ = truncate(html.redact(value) if value else None, limit)
    return shown or None


def _author(author: Author | None) -> dict[str, Any] | None:
    if author is None or author.type is None:
        return None
    if author.type not in _AUTHORS:
        return {"type": "other", "name": None, "email": None}
    return {"type": author.type, "name": short(author.name), "email": short(author.email)}


def _attachments(attachments: list[Attachment]) -> list[str]:
    return [short(a.name) or "attachment" for a in attachments[:MAX_ATTACHMENTS]]


def _contact(conversation: Conversation) -> dict[str, Any] | None:
    author = conversation.source.author if conversation.source else None
    if author is None or author.type not in {"user", "lead", "contact"}:
        return None
    return {"name": short(author.name), "email": short(author.email)}


def _header(conversation: Conversation) -> dict[str, Any]:
    source = conversation.source
    return {
        "id": conversation.id,
        "inbox": inbox_of(conversation),
        "title": short(conversation.title),
        "subject": short(html.read(source.subject)) if source and not source.redacted else None,
        "state": conversation.state,
        "priority": conversation.priority,
        "created": iso(conversation.created_at),
        "updated": iso(conversation.updated_at),
        "waiting_since": iso(conversation.waiting_since),
        "contact": _contact(conversation),
    }


class ListInboxes(OperationInput):
    pass


async def _prepare_list_inboxes(binding: Binding, data: ListInboxes) -> Prepared:
    async def execute() -> ProviderOutput:
        client: IntercomClient = binding.client
        records = [
            ScopedRecord(
                inbox_resource(binding, team.id),
                {"id": team.id, "name": short(team.name), "teammates": len(team.admin_ids)},
            )
            for team in await client.teams()
        ]
        records.append(
            ScopedRecord(
                inbox_resource(binding, NO_TEAM), {"id": NO_TEAM, "name": NO_TEAM_NAME, "teammates": None}
            )
        )
        return ProviderOutput(records)

    return Prepared([Enumerate(INBOX, "read")], execute)


LIST_INBOXES = Operation(
    name="list_inboxes",
    title="List inboxes",
    description=(
        'List the Intercom team inboxes you may read. "none" holds conversations no team is assigned to: '
        "unassigned ones and ones assigned only to a teammate."
    ),
    input_model=ListInboxes,
    needs=((INBOX, "read"),),
    prepare=_prepare_list_inboxes,
)


def _words(text: str) -> list[str]:
    words = _WORD.findall(text)[:MAX_SEARCH_WORDS]
    if not words:
        raise OperationError("INVALID_ARGUMENTS", "text must contain letters or digits.")
    return words


def _since(value: str) -> str:
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("must be an ISO 8601 date or time such as 2026-10-01T09:00:00Z") from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    if not 2000 <= moment.year <= 2100:
        raise ValueError("must be a time between the years 2000 and 2100")
    return value


SearchText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        description=f"Up to {MAX_SEARCH_WORDS} words, all of which the conversation's first message contains.",
    ),
    AfterValidator(single_line),
]
Since = Annotated[
    str,
    Field(
        min_length=1,
        max_length=40,
        description="Only conversations updated at or after this ISO 8601 time; times without a zone are UTC.",
    ),
    AfterValidator(_since),
]


class SearchConversations(OperationInput):
    inbox: InboxName
    state: Literal["open", "closed", "snoozed"] | None = None
    text: SearchText | None = None
    updated_after: Since | None = None
    limit: Annotated[int, Field(ge=1, le=20)] = 10
    cursor: Cursor | None = None


def _timestamp(value: str) -> int:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp())


def _first_text(conversation: Conversation) -> str | None:
    source = conversation.source
    return html.read(source.body) if source and not source.redacted else None


def _shows_words(text: str | None, words: list[str]) -> bool:
    """Whether every searched word is in the first message as shown. Intercom searches the raw body, which
    includes the hidden labels of links to Intercom; a match there alone would reveal them."""
    folded = (text or "").casefold()
    return all(word.casefold() in folded for word in words)


def _query(data: SearchConversations) -> dict[str, Any]:
    """The search, built from fields: one inbox, ANDed with the other filters."""
    team = 0 if data.inbox == NO_TEAM else int(data.inbox)
    filters: list[dict[str, Any]] = [{"field": "team_assignee_id", "operator": "=", "value": team}]
    if data.state is not None:
        filters.append({"field": "state", "operator": "=", "value": data.state})
    if data.updated_after is not None:
        filters.append({"field": "updated_at", "operator": ">", "value": _timestamp(data.updated_after)})
    if data.text is not None:
        filters += [{"field": "source.body", "operator": "~", "value": word} for word in _words(data.text)]
    return {"operator": "AND", "value": filters}


async def _fresh(client: IntercomClient, ids: list[str]) -> list[Conversation]:
    """The conversations read again, in order; ones that cannot be placed in an inbox are left out."""
    limit = asyncio.Semaphore(CONCURRENCY)

    async def read(conversation_id: str) -> Conversation | None:
        async with limit:
            try:
                return await client.conversation(conversation_id)
            except OperationError as error:
                if unplaced(error):
                    return None
                raise

    found = await asyncio.gather(*(read(i) for i in ids))
    return [conversation for conversation in found if conversation is not None]


async def _prepare_search_conversations(binding: Binding, data: SearchConversations) -> Prepared:
    resource = await resolve_inbox(binding, data.inbox)

    async def execute() -> ProviderOutput:
        client: IntercomClient = binding.client
        try:
            ids, cursor = await client.search(_query(data), per_page=data.limit, starting_after=data.cursor)
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED" and data.cursor is not None:
                raise OperationError("INVALID_CURSOR", "This page token is invalid.") from None
            if error.code == "PROVIDER_REJECTED":
                raise OperationError("INVALID_ARGUMENTS", "Intercom could not run this search.") from None
            raise
        # Search reads an index that can lag behind reassignments: each conversation is read again, and shown
        # under the inbox it is in now. What the index returned beside the id is not used.
        words = _words(data.text) if data.text is not None else []
        records = []
        for conversation in await _fresh(client, list(dict.fromkeys(ids))):
            preview = _first_text(conversation)
            if not _shows_words(preview, words):
                continue
            record = _header(conversation)
            record["preview"], record["preview_truncated"] = truncate(preview or None, MAX_PREVIEW)
            records.append(ScopedRecord(inbox_resource(binding, inbox_of(conversation)), record))
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], execute)


SEARCH_CONVERSATIONS = Operation(
    name="search_conversations",
    title="Search conversations",
    description=(
        "Find conversations in one Intercom inbox by state, update time and words in the first message. Results "
        "are not sorted, and a page can hold fewer than limit even when more follow. To get the next page, repeat the call with identical arguments plus the returned "
        "next_cursor."
    ),
    input_model=SearchConversations,
    needs=((INBOX, "read"),),
    prepare=_prepare_search_conversations,
    paginated=True,
)


def _message(
    message_id: str | None,
    kind: str,
    author: Author | None,
    created: int | None,
    body: str | None,
    attachments: list[Attachment],
    redacted: bool,
) -> dict[str, Any]:
    text, truncated = (None, False) if redacted else truncate(html.read(body) or None, MAX_MESSAGE)
    return {
        "id": message_id,
        "type": kind,
        "author": _author(author),
        "created": iso(created),
        "text": "[redacted]" if redacted else text,
        "text_truncated": truncated,
        "attachments": [] if redacted else _attachments(attachments),
    }


def _messages(conversation: Conversation) -> tuple[list[dict[str, Any]], bool]:
    """The first message, then the newest parts that carry a message, oldest first."""
    messages = []
    source = conversation.source
    if source is not None:
        messages.append(
            _message(
                source.id,
                "first",
                source.author,
                conversation.created_at,
                source.body,
                source.attachments,
                source.redacted,
            )
        )
    found = conversation.conversation_parts
    parts: list[Part] = found.conversation_parts if found else []
    shown = [part for part in parts if part.part_type in _MESSAGE_PARTS]
    # A closing part without words says only who closed the conversation.
    shown = [p for p in shown if p.part_type != "close" or p.body or p.attachments]
    more = len(shown) > MAX_MESSAGES or (found is not None and found.total_count > len(parts))
    for part in shown[-MAX_MESSAGES:]:
        messages.append(
            _message(
                part.id,
                part.part_type or "comment",
                part.author,
                part.created_at,
                part.body,
                part.attachments,
                part.redacted,
            )
        )
    return messages, more


class GetConversation(OperationInput):
    conversation: ConversationId


async def _prepare_get_conversation(binding: Binding, data: GetConversation) -> Prepared:
    # One read decides both where the conversation is and what is shown.
    resource, conversation = await resolve_conversation(binding, data.conversation)

    async def execute() -> ProviderOutput:
        record = _header(conversation)
        record["messages"], record["more_messages"] = _messages(conversation)
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_CONVERSATION = Operation(
    name="get_conversation",
    title="Read a conversation",
    description=(
        f"Read one Intercom conversation: its first message, then up to {MAX_MESSAGES} of the latest replies and "
        "internal notes, oldest first. Assignments and other events are left out, links to Intercom appear "
        "without their text, and attachments by name only."
    ),
    input_model=GetConversation,
    needs=((INBOX, "read"),),
    prepare=_prepare_get_conversation,
)
