"""Gmail's read operations: labels, message lists, messages and threads."""

import asyncio
import html
from typing import Annotated, Any

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
from connectors.gmail import mime
from connectors.gmail.client import ID, GmailClient, Message
from connectors.gmail.mailbox import (
    CONNECTION_ERRORS,
    LABEL,
    READ_CONSENT,
    SPAM_TRASH,
    SYSTEM_LABELS,
    Labels,
    MessageId,
    confirm,
    locate,
    moved,
)
from connectors.text import single_line

FETCH_CONCURRENCY = 5
MAX_THREAD_MESSAGES = 25
MAX_SNIPPET = 300


def _label_ref(value: str) -> str:
    if value.upper() in SYSTEM_LABELS:
        return value.upper()
    if not ID.match(value):
        raise ValueError("must be a label id from list_labels")
    return value


LabelRef = Annotated[
    str,
    Field(
        min_length=1,
        max_length=64,
        description=f"A label id from list_labels, or a system label: {', '.join(SYSTEM_LABELS)}.",
    ),
    AfterValidator(_label_ref),
]
# The run's own page token; the executor swaps it for Gmail's before the call is prepared.
Cursor = Annotated[str, Field(max_length=1000)]


def _first(message: Message, name: str) -> str | None:
    return mime.header_text(next(iter(message.headers(name)), None))


def _summary(message: Message) -> dict[str, Any]:
    return {
        "id": message.id,
        "thread_id": message.thread_id,
        "label_ids": [label for label in message.label_ids if ID.match(label)],
        "from": _first(message, "From"),
        "to": _first(message, "To"),
        "cc": _first(message, "Cc"),
        "subject": _first(message, "Subject"),
        "date": _first(message, "Date"),
        # Gmail escapes the snippet as HTML.
        "snippet": mime.header_text(html.unescape(message.snippet))[:MAX_SNIPPET]
        if message.snippet
        else None,
        "unread": "UNREAD" in message.label_ids,
    }


def _record(binding: Binding, labels: Labels, message: Message, data: dict) -> ScopedRecord | None:
    """The message's data scoped to where it sits; None for a message Minerva does not place (a chat)."""
    try:
        return ScopedRecord(labels.message(binding, message), data)
    except OperationError:
        return None


class ListLabels(OperationInput):
    pass


async def _prepare_list_labels(binding: Binding, data: ListLabels) -> Prepared:
    async def execute() -> ProviderOutput:
        labels = await Labels.fetch(binding.client)
        records = []
        for label_id, label in labels.grantable.items():
            within = labels.ancestors(label_id)
            record = {
                "id": label_id,
                "name": labels.short_name(label_id),
                "type": "user" if label.type == "user" else "system",
                "parent_id": within[0] if within else None,
            }
            records.append(ScopedRecord(binding.resource(LABEL, label_id, within), record))
        return ProviderOutput(records)

    return Prepared([Enumerate(LABEL, "read")], execute)


LIST_LABELS = Operation(
    name="list_labels",
    title="List labels",
    description=(
        "List the labels you may read: Gmail's system labels (Inbox, Sent, Drafts, Spam, Trash and the "
        "inbox categories) and the user's own labels. A label's name is given below its parent_id."
    ),
    input_model=ListLabels,
    needs=((LABEL, "read"),),
    prepare=_prepare_list_labels,
    consent=READ_CONSENT,
)


class ListMessages(OperationInput):
    label: Annotated[
        LabelRef | None, Field(description="Only mail with this label; leave out to search all mail.")
    ] = None
    query: Annotated[
        str | None,
        Field(
            min_length=1,
            max_length=200,
            description='Gmail search, as in its search box, such as "from:ada@example.com is:unread".',
        ),
        AfterValidator(single_line),
    ] = None
    limit: Annotated[int, Field(ge=1, le=25)] = 10
    cursor: Cursor | None = None


async def _summaries(client: GmailClient, refs) -> list[Message]:
    limit = asyncio.Semaphore(FETCH_CONCURRENCY)

    async def fetch(message_id: str) -> Message | None:
        async with limit:
            try:
                message = await client.message(message_id, format="metadata")
            except OperationError as error:
                if error.code in CONNECTION_ERRORS:
                    raise
                # Deleted since it was listed.
                return None
        return message if message.id == message_id else None

    found = await asyncio.gather(*(fetch(ref.id) for ref in refs if ID.match(ref.id)))
    return [message for message in found if message is not None]


async def _prepare_list_messages(binding: Binding, data: ListMessages) -> Prepared:
    client: GmailClient = binding.client
    authorized = None
    if data.label is not None:
        authorized = (await Labels.fetch(client)).resource(binding, data.label)

    async def execute() -> ProviderOutput:
        refs, cursor = await client.messages(
            label_id=data.label,
            query=data.query,
            limit=data.limit,
            cursor=data.cursor,
            # Gmail leaves spam and trash out of every list but their own.
            spam_trash=data.label in SPAM_TRASH,
        )
        messages = await _summaries(client, refs)
        # Labels after the messages, so that where they sit is never older than the labels they carry.
        labels = await Labels.fetch(client)
        if authorized is not None and (
            authorized.id not in labels.grantable or labels.resource(binding, authorized.id) != authorized
        ):
            raise moved()
        records = [_record(binding, labels, message, _summary(message)) for message in messages]
        return ProviderOutput([record for record in records if record is not None], cursor)

    if authorized is None:
        return Prepared([Enumerate(LABEL, "read")], execute)
    return Prepared([Need(authorized, "read")], execute)


LIST_MESSAGES = Operation(
    name="list_messages",
    title="List messages",
    description=(
        "List messages, newest first, with their senders, subjects and a short snippet: those with one "
        "label, those matching a Gmail search, or both. Only mail you may read is shown; spam and trash "
        "only when that label is asked for. To get the next page, repeat the call with identical "
        "arguments plus the returned next_cursor."
    ),
    input_model=ListMessages,
    needs=((LABEL, "read"),),
    prepare=_prepare_list_messages,
    consent=READ_CONSENT,
    paginated=True,
)


def _full(message: Message, max_chars: int, offset: int = 0) -> dict[str, Any]:
    found = mime.content(message.payload)
    end = offset + max_chars
    return {
        **_summary(message),
        "bcc": _first(message, "Bcc"),
        "reply_to": _first(message, "Reply-To"),
        "body": found.text[offset:end],
        "offset": offset,
        "total_chars": len(found.text),
        "next_offset": end if end < len(found.text) else None,
        "body_incomplete": found.unavailable,
        "attachments": found.attachments,
    }


class ReadMessage(OperationInput):
    message: MessageId
    max_chars: Annotated[int, Field(ge=500, le=50_000)] = 20_000
    # Where to start in the body, to continue a long message.
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0


async def _prepare_read_message(binding: Binding, data: ReadMessage) -> Prepared:
    _, resource = await locate(binding, data.message, format="minimal")

    async def execute() -> ProviderOutput:
        message = await confirm(binding, resource, data.message, format="full")
        return ProviderOutput([ScopedRecord(resource, _full(message, data.max_chars, data.offset))])

    return Prepared([Need(resource, "read")], execute)


READ_MESSAGE = Operation(
    name="read_message",
    title="Read a message",
    description=(
        "Read one message as plain text, with its headers and the names of its attachments "
        "(attachments themselves cannot be read). Long bodies are cut at max_chars; continue with "
        "offset set to the returned next_offset. Reading does not mark the message as read."
    ),
    input_model=ReadMessage,
    needs=((LABEL, "read"),),
    prepare=_prepare_read_message,
    consent=READ_CONSENT,
)


class ReadThread(OperationInput):
    thread: Annotated[MessageId, Field(description="A thread_id from list_messages or read_message.")]
    max_chars_per_message: Annotated[int, Field(ge=200, le=20_000)] = 5_000


async def _prepare_read_thread(binding: Binding, data: ReadThread) -> Prepared:
    async def execute() -> ProviderOutput:
        client: GmailClient = binding.client
        try:
            thread = await client.thread(data.thread)
        except OperationError as error:
            if error.code in CONNECTION_ERRORS or error.code == "RESPONSE_TOO_LARGE":
                raise
            # A thread that does not exist reads like one with no message you may read.
            return ProviderOutput([])
        if thread.id != data.thread:
            raise client.unexpected()
        labels = await Labels.fetch(client)
        messages = sorted(
            (m for m in thread.messages if m.thread_id == thread.id and ID.match(m.id)),
            key=lambda m: int(m.internal_date) if (m.internal_date or "").isdigit() else 0,
        )
        records = []
        for message in messages[-MAX_THREAD_MESSAGES:]:
            full = _full(message, data.max_chars_per_message)
            full["body_truncated"] = full.pop("next_offset") is not None
            del full["offset"], full["total_chars"]
            if (record := _record(binding, labels, message, full)) is not None:
                records.append(record)
        return ProviderOutput(records, incomplete=len(messages) > MAX_THREAD_MESSAGES)

    return Prepared([Enumerate(LABEL, "read")], execute)


READ_THREAD = Operation(
    name="read_thread",
    title="Read a conversation",
    description=(
        f"Read the messages you may read in one conversation, oldest first, each as plain text cut at "
        f"max_chars_per_message. Only the conversation's last {MAX_THREAD_MESSAGES} messages are "
        "considered, readable or not; use list_messages and read_message for older ones, and for the rest "
        "of a long message."
    ),
    input_model=ReadThread,
    needs=((LABEL, "read"),),
    prepare=_prepare_read_thread,
    consent=READ_CONSENT,
)
