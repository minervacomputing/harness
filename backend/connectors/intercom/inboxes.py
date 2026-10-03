"""What Intercom's operations share: inboxes, conversation names, and where conversations are."""

from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError, Resource, denied
from connectors.intercom.client import ID, Conversation, IntercomClient

INBOX = "inbox"
# The inbox of conversations no team is assigned to: unassigned ones, and ones assigned to a teammate only.
NO_TEAM = "none"
NO_TEAM_NAME = "No team"
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN"})


def _inbox_name(value: str) -> str:
    if value == NO_TEAM or ID.match(value):
        return value
    raise ValueError('must be a team id from list_inboxes, or "none"')


def _conversation_name(value: str) -> str:
    if ID.match(value):
        return value
    raise ValueError("must be a conversation id")


InboxName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=20,
        description='A team inbox\'s id, from list_inboxes, or "none" for conversations with no team.',
    ),
    AfterValidator(_inbox_name),
]
ConversationId = Annotated[
    str,
    Field(min_length=1, max_length=20, description="A conversation's id, from search_conversations."),
    AfterValidator(_conversation_name),
]


def unseen(error: OperationError) -> bool:
    return error.code in HIDDEN


def unplaced(error: OperationError) -> bool:
    """A read that does not say which inbox the conversation is in. One too large to read cannot be placed, and
    an error naming its size would say that it exists, so it is treated like one the account cannot see."""
    return unseen(error) or error.code == "RESPONSE_TOO_LARGE"


def conversation_moved() -> OperationError:
    return OperationError(
        "CONVERSATION_MOVED",
        "This conversation moved to another inbox in Intercom while Minerva was using it, or access was lost. "
        "Try again.",
    )


def inbox_of(conversation: Conversation) -> str:
    team = conversation.team_assignee_id
    return NO_TEAM if not team else str(team)


def inbox_resource(binding: Binding, inbox: str) -> Resource:
    if inbox != NO_TEAM and not ID.match(inbox):
        raise binding.client.unexpected()
    return binding.resource(INBOX, inbox)


async def resolve_inbox(binding: Binding, name: str) -> Resource:
    """The inbox a call names. A team the account cannot see is refused like one without a grant."""
    client: IntercomClient = binding.client
    if name != NO_TEAM and name not in {team.id for team in await client.teams()}:
        raise denied()
    return inbox_resource(binding, name)


async def resolve_conversation(binding: Binding, conversation_id: str) -> tuple[Resource, Conversation]:
    """The conversation a call names and the inbox it is in now. One the account cannot see is refused like
    one without a grant."""
    client: IntercomClient = binding.client
    try:
        conversation = await client.conversation(conversation_id)
    except OperationError as error:
        if unplaced(error):
            raise denied() from None
        raise
    return inbox_resource(binding, inbox_of(conversation)), conversation


async def confirm_conversation(binding: Binding, resource: Resource, conversation_id: str) -> Conversation:
    """The conversation read again, refused unless it is still in the inbox it was authorized in."""
    client: IntercomClient = binding.client
    try:
        conversation = await client.conversation(conversation_id)
    except OperationError as error:
        if unseen(error):
            raise conversation_moved() from None
        raise
    if inbox_resource(binding, inbox_of(conversation)).id != resource.id:
        raise conversation_moved()
    return conversation


def iso(timestamp: int | None) -> str | None:
    if timestamp is None or timestamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")
    except OverflowError, OSError, ValueError:
        return None
