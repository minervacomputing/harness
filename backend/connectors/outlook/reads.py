"""Outlook's read operations: folders, message lists and single messages."""

from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
)
from connectors.outlook.client import FULL_FIELDS, ID, Folder, GraphClient, Message, Recipient
from connectors.outlook.mailbox import (
    FOLDER,
    READ_CONSENT,
    FolderRef,
    MessageId,
    Tree,
    confirm_message,
    locate,
)
from connectors.text import no_controls_or_del

MAX_ATTACHMENTS = 20
# Before any mail: the lower bound that lets a filter on time precede `isRead` (Graph requires properties
# in $orderby to come first in $filter).
EPOCH = "1900-01-01T00:00:00Z"


def _search_text(value: str) -> str:
    no_controls_or_del(value)
    if '"' in value or "\\" in value:
        raise ValueError("must not contain double quotes or backslashes")
    return value


def _moment(value: str) -> str:
    """An ISO 8601 time, in UTC, as Graph compares it. Times without a zone are UTC."""
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("must be an ISO 8601 time such as 2026-10-01T09:00:00Z") from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


Moment = Annotated[
    str, Field(min_length=1, max_length=40, description="An ISO 8601 time."), AfterValidator(_moment)
]
Cursor = Annotated[str, Field(max_length=1000)]


def _person(recipient: Recipient | None) -> dict[str, Any] | None:
    if recipient is None or recipient.email_address is None:
        return None
    return {"name": recipient.email_address.name, "address": recipient.email_address.address}


def _people(recipients: list[Recipient]) -> list[dict[str, Any]]:
    return [person for person in map(_person, recipients) if person is not None]


def _summary(message: Message) -> dict[str, Any]:
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "folder_id": message.parent_folder_id,
        "subject": message.subject,
        "from": _person(message.from_),
        "to": _people(message.to_recipients),
        "cc": _people(message.cc_recipients),
        "received": message.received_date_time,
        "sent": message.sent_date_time,
        "is_read": message.is_read,
        "is_draft": message.is_draft,
        "has_attachments": message.has_attachments,
        "importance": message.importance,
        "preview": message.body_preview,
        "categories": message.categories,
    }


def _folder_data(folder: Folder, parent_id: str | None) -> dict[str, Any]:
    return {
        "id": folder.id,
        "name": folder.display_name,
        "parent_id": parent_id,
        "unread": folder.unread_item_count,
        "total": folder.total_item_count,
    }


class ListFolders(OperationInput):
    parent: Annotated[
        FolderRef | None,
        Field(description="List this folder's subfolders; leave out for the top-level folders."),
    ] = None
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    cursor: Cursor | None = None


async def _prepare_list_folders(binding: Binding, data: ListFolders) -> Prepared:
    tree = Tree(binding.client)
    client: GraphClient = binding.client
    if data.parent is None:

        async def top() -> ProviderOutput:
            root = await tree.root()
            folders, cursor = await client.folders(None, limit=data.limit, cursor=data.cursor)
            records = [
                ScopedRecord(binding.resource(FOLDER, folder.id), _folder_data(folder, None))
                for folder in folders
                if folder.parent_folder_id == root and ID.match(folder.id) and folder.ordinary
            ]
            return ProviderOutput(records, cursor)

        return Prepared([Enumerate(FOLDER, "read")], top)

    resource, _ = await tree.resolve(binding, data.parent)

    async def children() -> ProviderOutput:
        folder = await tree.confirm(resource)
        folders, cursor = await client.folders(folder.id, limit=data.limit, cursor=data.cursor)
        within = (folder.id, *resource.within)
        records = [
            ScopedRecord(binding.resource(FOLDER, child.id, within), _folder_data(child, folder.id))
            for child in folders
            # A folder that does not name this one as its parent is not placed by this listing.
            if child.parent_folder_id == folder.id
            and ID.match(child.id)
            and child.id not in within
            and child.ordinary
        ]
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], children)


LIST_FOLDERS = Operation(
    name="list_folders",
    title="List mail folders",
    description=(
        "List mail folders you may read: the top-level folders, or the subfolders of parent. To get "
        "the next page, repeat the call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListFolders,
    needs=((FOLDER, "read"),),
    prepare=_prepare_list_folders,
    consent=READ_CONSENT,
    paginated=True,
)


class ListMessages(OperationInput):
    folder: FolderRef
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    unread_only: bool = False
    after: Annotated[Moment | None, Field(description="Only mail received at or after this time.")] = None
    before: Annotated[Moment | None, Field(description="Only mail received before this time.")] = None
    query: Annotated[
        str | None,
        Field(
            min_length=1,
            max_length=200,
            description="Words to search for in this folder's mail. Results are ordered by Outlook; cannot "
            "be combined with unread_only, after or before.",
        ),
        AfterValidator(_search_text),
    ] = None
    cursor: Cursor | None = None

    @model_validator(mode="after")
    def _search_alone(self) -> ListMessages:
        if self.query is not None and (self.unread_only or self.after or self.before):
            raise ValueError("query cannot be combined with unread_only, after or before")
        return self


def _filter(data: ListMessages) -> str | None:
    if not (data.unread_only or data.after or data.before):
        return None
    parts = [f"receivedDateTime ge {data.after or EPOCH}"]
    if data.before:
        parts.append(f"receivedDateTime lt {data.before}")
    if data.unread_only:
        parts.append("isRead eq false")
    return " and ".join(parts)


async def _prepare_list_messages(binding: Binding, data: ListMessages) -> Prepared:
    tree = Tree(binding.client)
    resource, _ = await tree.resolve(binding, data.folder)

    async def execute() -> ProviderOutput:
        folder = await tree.confirm(resource)
        messages, cursor = await binding.client.messages(
            folder.id, limit=data.limit, cursor=data.cursor, filter=_filter(data), search=data.query
        )
        records = [
            ScopedRecord(resource, _summary(message))
            for message in messages
            # Mail that lives in another folder (as in a search folder) is not this folder's to show.
            if message.parent_folder_id == folder.id and ID.match(message.id)
        ]
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], execute)


LIST_MESSAGES = Operation(
    name="list_messages",
    title="List messages",
    description=(
        "List the messages in one folder, newest first, with a short preview of each. Filter by "
        "unread_only and received time, or search with query. To get the next page, repeat the "
        "call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListMessages,
    needs=((FOLDER, "read"),),
    prepare=_prepare_list_messages,
    consent=READ_CONSENT,
    paginated=True,
)


class ReadMessage(OperationInput):
    message: MessageId
    max_chars: Annotated[int, Field(ge=500, le=50_000)] = 20_000
    # Where to start in the body, to continue a long message.
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0


async def _prepare_read_message(binding: Binding, data: ReadMessage) -> Prepared:
    tree = Tree(binding.client)
    _, resource = await locate(binding, tree, data.message, "id,parentFolderId")

    async def execute() -> ProviderOutput:
        client: GraphClient = binding.client
        message = await confirm_message(
            binding, tree, resource, data.message, fields=FULL_FIELDS, text_body=True
        )
        attachments = (
            await client.attachments(message.id, limit=MAX_ATTACHMENTS) if message.has_attachments else []
        )
        text = message.body.content if message.body else ""
        end = data.offset + data.max_chars
        record = {
            **_summary(message),
            "reply_to": _people(message.reply_to),
            "bcc": _people(message.bcc_recipients),
            "body": text[data.offset : end],
            "offset": data.offset,
            "total_chars": len(text),
            "next_offset": end if end < len(text) else None,
            "attachments": [
                {"name": a.name, "content_type": a.content_type, "size": a.size, "inline": a.is_inline}
                for a in attachments
            ],
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


READ_MESSAGE = Operation(
    name="read_message",
    title="Read a message",
    description=(
        "Read one message as plain text, with its recipients and the names of its attachments "
        "(attachments themselves cannot be read). Long bodies are cut at max_chars; continue with "
        "offset set to the returned next_offset. Reading does not mark the message as read."
    ),
    input_model=ReadMessage,
    needs=((FOLDER, "read"),),
    prepare=_prepare_read_message,
    consent=READ_CONSENT,
)
