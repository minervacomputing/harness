"""What Gmail's operations share: consent, ids, labels and where messages sit.

A message is not a resource users choose. It is authorized as `message:<id>` inside every grantable label
it carries, and inside those labels' parents, so a grant on any of them covers it and a deny on any of them
hides it (see `connector`).
"""

from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError, Resource, denied
from connectors.gmail.client import ID, GmailClient, Label, Message

LABEL = "label"
RECIPIENT = "recipient"

_SCOPE = "https://www.googleapis.com/auth/"
READONLY_SCOPE = _SCOPE + "gmail.readonly"
SEND_SCOPE = _SCOPE + "gmail.send"
COMPOSE_SCOPE = _SCOPE + "gmail.compose"
MODIFY_SCOPE = _SCOPE + "gmail.modify"
FULL_SCOPE = "https://mail.google.com/"

READ_CONSENT = (frozenset({READONLY_SCOPE}), frozenset({MODIFY_SCOPE}), frozenset({FULL_SCOPE}))
SEND_CONSENT = (
    frozenset({SEND_SCOPE}),
    frozenset({COMPOSE_SCOPE}),
    frozenset({MODIFY_SCOPE}),
    frozenset({FULL_SCOPE}),
)
# A reply reads the original and the account's addresses, then sends.
REPLY_CONSENT = (
    frozenset({READONLY_SCOPE, SEND_SCOPE}),
    frozenset({READONLY_SCOPE, COMPOSE_SCOPE}),
    frozenset({MODIFY_SCOPE}),
    frozenset({FULL_SCOPE}),
)
DRAFT_CONSENT = (frozenset({COMPOSE_SCOPE}), frozenset({MODIFY_SCOPE}), frozenset({FULL_SCOPE}))
REPLY_DRAFT_CONSENT = (
    frozenset({READONLY_SCOPE, COMPOSE_SCOPE}),
    frozenset({MODIFY_SCOPE}),
    frozenset({FULL_SCOPE}),
)

# System labels users can choose, with the names shown for them.
SYSTEM_LABELS = {
    "INBOX": "Inbox",
    "SENT": "Sent",
    "DRAFT": "Drafts",
    "SPAM": "Spam",
    "TRASH": "Trash",
    "CATEGORY_PERSONAL": "Category: Primary",
    "CATEGORY_SOCIAL": "Category: Social",
    "CATEGORY_PROMOTIONS": "Category: Promotions",
    "CATEGORY_UPDATES": "Category: Updates",
    "CATEGORY_FORUMS": "Category: Forums",
}
# Marks that say nothing about where a message belongs, and that Gmail sets by itself (IMPORTANT): never
# used to authorize a message.
MARKS = frozenset({"UNREAD", "STARRED", "IMPORTANT"})
# Chats are not mail; messages carrying this label are refused.
CHAT = "CHAT"
SPAM_TRASH = frozenset({"SPAM", "TRASH"})
MESSAGE_PREFIX = "message:"
# The executor's limit on a resource's ancestors.
MAX_WITHIN = 64
# Errors about the connection, not about the object a call names; they say nothing about that object.
CONNECTION_ERRORS = frozenset(
    {"CONNECTION_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_ACCOUNT"}
)


def moved() -> OperationError:
    return OperationError(
        "MAIL_MOVED", "This message or label changed while Minerva was using it. Try again."
    )


def unsupported_message() -> OperationError:
    return OperationError("UNSUPPORTED_MESSAGE", "Minerva does not read chats or mail with this many labels.")


def _id(value: str) -> str:
    if not ID.match(value):
        raise ValueError("must be an id from list_messages")
    return value


MessageId = Annotated[str, Field(min_length=1, max_length=64), AfterValidator(_id)]


class Labels:
    """The mailbox's labels as one `labels.list` response gave them."""

    def __init__(self, labels: list[Label]) -> None:
        self.grantable: dict[str, Label] = {}
        user_names: dict[str, str] = {}
        for label in labels:
            if not ID.match(label.id):
                continue
            if label.type == "user" or label.id in SYSTEM_LABELS:
                self.grantable[label.id] = label
            if label.type == "user":
                user_names.setdefault(label.name.casefold(), label.id)
        self._user_names = user_names

    @classmethod
    async def fetch(cls, client: GmailClient) -> Labels:
        return cls(await client.labels())

    def name(self, label_id: str) -> str:
        label = self.grantable[label_id]
        return label.name if label.type == "user" else SYSTEM_LABELS[label_id]

    def _parents(self, label_id: str) -> list[tuple[int, str]]:
        """A user label's parents, nearest first, each with the number of name segments it covers: Gmail
        nests labels by name, so `Work/Projects` sits under the user label named `Work` when there is one.
        Names are compared without case, as Gmail does."""
        label = self.grantable[label_id]
        if label.type != "user":
            return []
        parts = label.name.split("/")
        found: list[tuple[int, str]] = []
        for end in range(len(parts) - 1, 0, -1):
            parent = self._user_names.get("/".join(parts[:end]).casefold())
            if parent is not None and parent != label_id and parent not in (p for _, p in found):
                found.append((end, parent))
        return found

    def ancestors(self, label_id: str) -> tuple[str, ...]:
        return tuple(parent for _, parent in self._parents(label_id))

    def short_name(self, label_id: str) -> str:
        """The label's name below its nearest parent (`Projects` for `Work/Projects`), so that a label's
        name does not name a parent the agent may not read."""
        parents = self._parents(label_id)
        if not parents:
            return self.name(label_id)
        return "/".join(self.grantable[label_id].name.split("/")[parents[0][0] :])

    def resource(self, binding: Binding, label_id: str) -> Resource:
        """A label a call names, as the resource authorized; one Minerva does not offer is refused like a
        label without a grant."""
        if label_id not in self.grantable:
            raise denied()
        return binding.resource(LABEL, label_id, self.ancestors(label_id))

    def message(self, binding: Binding, message: Message) -> Resource:
        """Where a message sits: inside each grantable label it carries and their parents. A label Minerva
        does not know makes the chain partial, so any deny on a label hides the message."""
        if CHAT in message.label_ids:
            raise unsupported_message()
        within: list[str] = []
        partial = False
        for label_id in message.label_ids:
            if label_id in MARKS:
                continue
            if label_id not in self.grantable:
                partial = True
                continue
            for item in (label_id, *self.ancestors(label_id)):
                if item not in within:
                    within.append(item)
        if len(within) > MAX_WITHIN:
            raise unsupported_message()
        return binding.resource(LABEL, MESSAGE_PREFIX + message.id, tuple(within), partial)


async def locate(binding: Binding, message_id: str, **fetch: Any) -> tuple[Message, Resource]:
    """A message and where it sits, before authorization. A message Minerva cannot read or place is
    refused like one without a grant."""
    client: GmailClient = binding.client
    try:
        message = await client.message(message_id, **fetch)
    except OperationError as error:
        if error.code in CONNECTION_ERRORS:
            raise
        raise denied() from None
    if message.id != message_id:
        raise denied()
    # Labels after the message, so that where they sit is never older than the labels it carries.
    labels = await Labels.fetch(client)
    try:
        return message, labels.message(binding, message)
    except OperationError:
        raise denied() from None


async def confirm(binding: Binding, resource: Resource, message_id: str, **fetch: Any) -> Message:
    """The message again, refused if its labels, or where they sit, changed since it was authorized."""
    client: GmailClient = binding.client
    try:
        message = await client.message(message_id, **fetch)
    except OperationError as error:
        if error.code in CONNECTION_ERRORS or error.code == "RESPONSE_TOO_LARGE":
            raise
        raise moved() from None
    if message.id != message_id:
        raise moved()
    labels = await Labels.fetch(client)
    try:
        fresh = labels.message(binding, message)
    except OperationError:
        raise moved() from None
    if fresh != resource:
        raise moved()
    return message
