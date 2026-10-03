"""Intercom's write operations: internal notes and replies to customers.

Both are sent as the connected teammate. Each write reads its conversation again just before sending, and
refuses one that moved to another inbox (`CONVERSATION_MOVED`). That cannot stop a reassignment that lands
between that read and the write: Intercom's reply endpoint takes no condition on where a conversation is, and
assignment rules reassign conversations on their own. The record names the inbox the conversation is in after
the write.
"""

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
)
from connectors.intercom import html
from connectors.intercom.client import Conversation, IntercomClient
from connectors.intercom.inboxes import (
    INBOX,
    ConversationId,
    confirm_conversation,
    inbox_of,
    inbox_resource,
    iso,
    resolve_conversation,
)

MAX_TEXT = 10_000

WrittenText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MAX_TEXT,
        description="Plain text, shown literally: no formatting, mentions or links to Intercom.",
    ),
    AfterValidator(html.check_written),
]

RACE_NOTE = (
    "If the conversation is reassigned to another team at the moment of writing, the write can land there."
)


class Write(OperationInput):
    conversation: ConversationId
    text: WrittenText


class AddNote(Write):
    pass


class Reply(Write):
    pass


def _part_ids(conversation: Conversation) -> set[str]:
    found = conversation.conversation_parts
    return {part.id for part in found.conversation_parts} if found else set()


def _part(
    conversation: Conversation, before: set[str], admin_id: str, part_type: str
) -> tuple[str | None, str | None]:
    """The id and time of the part just written: the one part of this type by this teammate that the read before
    the write did not have. None when Intercom's answer shows none, or several (the teammate wrote elsewhere at
    the same moment)."""
    found = conversation.conversation_parts
    new = [
        part
        for part in (found.conversation_parts if found else [])
        if part.id not in before
        and part.part_type == part_type
        and part.author
        and part.author.type == "admin"
        and part.author.id == admin_id
    ]
    return (new[0].id, iso(new[0].created_at)) if len(new) == 1 else (None, None)


def _prepare(message_type: Literal["note", "comment"], action: str):
    async def prepare(binding: Binding, data: Write) -> Prepared:
        client: IntercomClient = binding.client
        resource, _ = await resolve_conversation(binding, data.conversation)
        admin_id = (await client.me()).id

        async def execute() -> ProviderOutput:
            before = _part_ids(await confirm_conversation(binding, resource, data.conversation))
            body: dict[str, Any] = {
                "message_type": message_type,
                "type": "admin",
                "admin_id": admin_id,
                "body": html.written(data.text),
            }
            conversation = await client.reply(data.conversation, body)
            part_id, created = _part(conversation, before, admin_id, message_type)
            record = {
                "written": True,
                "conversation_id": conversation.id,
                "inbox": inbox_of(conversation),
                "part_id": part_id,
                "created": created,
            }
            # Automation can reassign a conversation at once: the record names the inbox it is in now.
            return ProviderOutput([ScopedRecord(inbox_resource(binding, inbox_of(conversation)), record)])

        return Prepared([Need(resource, action)], execute)

    return prepare


ADD_NOTE = Operation(
    name="add_note",
    title="Add an internal note",
    description=(
        "Add an internal note to an Intercom conversation in an inbox where you have note permission. Notes are "
        "seen by teammates only, posted as the connected teammate. The number of writes per run is limited. "
        + RACE_NOTE
    ),
    input_model=AddNote,
    needs=((INBOX, "note"),),
    prepare=_prepare("note", "note"),
    mutates=True,
)


REPLY = Operation(
    name="reply",
    title="Reply to the customer",
    description=(
        "Reply to the customer in an Intercom conversation in an inbox where you have reply permission. The "
        "customer receives it by email or in the Messenger, sent as the connected teammate; replying can reopen "
        "the conversation. The number of writes per run is limited. " + RACE_NOTE
    ),
    input_model=Reply,
    needs=((INBOX, "reply"),),
    prepare=_prepare("comment", "reply"),
    mutates=True,
)
