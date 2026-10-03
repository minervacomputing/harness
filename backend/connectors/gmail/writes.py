"""Gmail's write operations: sending mail, replying, and saving drafts."""

from typing import Annotated

from pydantic import AfterValidator, Field, model_validator

from connectors import addresses
from connectors.base import (
    ACCOUNT_KIND,
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ScopedRecord,
)
from connectors.gmail import mime
from connectors.gmail.client import REPLY_HEADERS, GmailClient, Message
from connectors.gmail.mailbox import (
    DRAFT_CONSENT,
    LABEL,
    RECIPIENT,
    REPLY_CONSENT,
    REPLY_DRAFT_CONSENT,
    SEND_CONSENT,
    MessageId,
    confirm,
    locate,
)
from connectors.text import plain_text, single_line

MAX_RECIPIENTS = 10
MAX_BODY = 20_000
# Enough of the original to reply to it: its labels and the headers that address and thread a reply.
REPLY_FETCH = {"format": "metadata", "headers": REPLY_HEADERS}

Address = Annotated[
    str, Field(min_length=3, max_length=addresses.MAX_ADDRESS), AfterValidator(addresses.checked)
]
Subject = Annotated[str, Field(min_length=1, max_length=255), AfterValidator(single_line)]
Body = Annotated[
    str,
    Field(min_length=1, max_length=MAX_BODY, description="Plain text; sent as it is, not as HTML."),
    AfterValidator(plain_text),
]

SEND_NOTE = (
    "Mail is sent as plain text from the account's default address and kept in Sent. Gmail accepts it "
    "before delivering it; a bounce arrives later as mail. The number of writes per run is limited."
)
DRAFT_NOTE = (
    "The draft is saved in Drafts for the user to review and send; nothing is sent. The number of writes "
    "per run is limited."
)


def _recipient(binding: Binding, address: str) -> Resource:
    if address == addresses.UNSUPPORTED:
        # Never named by a grant; only allowing every recipient passes it, and the reply is then refused.
        return binding.resource(RECIPIENT, address, (), partial=True)
    return binding.resource(RECIPIENT, address, addresses.ancestors(address))


class Recipients(OperationInput):
    to: Annotated[list[Address], Field(min_length=1, max_length=MAX_RECIPIENTS)]
    cc: Annotated[list[Address], Field(max_length=MAX_RECIPIENTS)] = []
    bcc: Annotated[list[Address], Field(max_length=MAX_RECIPIENTS)] = []

    @model_validator(mode="after")
    def _distinct(self) -> Recipients:
        everyone = [*self.to, *self.cc, *self.bcc]
        if len(set(everyone)) != len(everyone):
            raise ValueError("each address may appear only once")
        if len(everyone) > MAX_RECIPIENTS:
            raise ValueError(f"a message may go to at most {MAX_RECIPIENTS} addresses")
        return self


class SendMessage(Recipients):
    subject: Subject
    body: Body


async def _prepare_send_message(binding: Binding, data: SendMessage) -> Prepared:
    everyone = [*data.to, *data.cc, *data.bcc]

    async def execute() -> ProviderOutput:
        raw = mime.raw(to=data.to, cc=data.cc, bcc=data.bcc, subject=data.subject, body=data.body)
        sent = await binding.client.send(raw, None)
        record = {
            "sent": True,
            "id": sent.id,
            "thread_id": sent.thread_id,
            "to": data.to,
            "cc": data.cc,
            "bcc": data.bcc,
            "subject": data.subject,
        }
        return ProviderOutput([ScopedRecord(_recipient(binding, data.to[0]), record)])

    return Prepared([Need(_recipient(binding, address), "send") for address in everyone], execute)


SEND_MESSAGE = Operation(
    name="send_message",
    title="Send mail",
    description="Send a new message. Every address in to, cc and bcc needs send permission. " + SEND_NOTE,
    input_model=SendMessage,
    needs=((RECIPIENT, "send"),),
    output_action="send",
    prepare=_prepare_send_message,
    consent=SEND_CONSENT,
    mutates=True,
)


def _reply_targets(message: Message) -> list[str]:
    """Who a reply goes to: the original's Reply-To addresses if it has the header, otherwise its sender
    (RFC 5322). A header Minerva cannot read strictly makes the whole reply unsupported; it never falls
    back to another header."""
    reply_to = message.headers("Reply-To")
    targets = mime.mailboxes(reply_to if reply_to else message.headers("From"))
    if not targets or len(targets) > MAX_RECIPIENTS:
        return [addresses.UNSUPPORTED]
    return targets


def _unsupported_recipients() -> OperationError:
    return OperationError(
        "UNSUPPORTED_RECIPIENT",
        "Minerva cannot tell who a reply to this message would go to. Use send_message instead.",
    )


async def _replyable(binding: Binding, resource: Resource, message_id: str, targets: list[str]) -> Message:
    """The original, read last before the write and refused if it changed, is the account's own mail, or
    is a draft (whose recipients can still change)."""
    client: GmailClient = binding.client
    if targets == [addresses.UNSUPPORTED]:
        raise _unsupported_recipients()
    own = set()
    for raw in await client.own_addresses():
        try:
            own.add(addresses.parse(raw))
        except OperationError:
            continue
    message = await confirm(binding, resource, message_id, **REPLY_FETCH)
    if _reply_targets(message) != targets:
        raise OperationError("MESSAGE_CHANGED", "Who this message's replies go to changed. Try again.")
    senders = [mime.mailboxes(message.headers(name)) for name in ("From", "Sender")]
    sender = senders[0]
    if (
        "SENT" in message.label_ids
        or "DRAFT" in message.label_ids
        or sender is None
        or own.intersection(sender)
        or (message.headers("Sender") and (senders[1] is None or own.intersection(senders[1])))
    ):
        raise OperationError(
            "UNSUPPORTED_MESSAGE",
            "Minerva does not reply to drafts or to messages sent from this account. Use send_message "
            "instead.",
        )
    return message


def _reply_raw(message: Message, targets: list[str], body: str) -> str:
    # Only the authorized targets, and no Cc or Bcc: nobody else is copied.
    return mime.raw(
        to=targets,
        subject=mime.reply_subject(next(iter(message.headers("Subject")), None)),
        body=body,
        in_reply_to=mime.threading(message.headers("Message-ID"), message.headers("References")),
    )


class Reply(OperationInput):
    message: MessageId
    body: Body


async def _prepare_reply(binding: Binding, data: Reply) -> Prepared:
    original, resource = await locate(binding, data.message, **REPLY_FETCH)
    targets = _reply_targets(original)

    async def execute() -> ProviderOutput:
        message = await _replyable(binding, resource, data.message, targets)
        sent = await binding.client.send(_reply_raw(message, targets, data.body), message.thread_id)
        record = {"replied": True, "id": sent.id, "thread_id": sent.thread_id, "to": targets}
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared(
        [Need(resource, "read"), *(Need(_recipient(binding, target), "send") for target in targets)], execute
    )


REPLY = Operation(
    name="reply",
    title="Reply to a message",
    description=(
        "Reply to a message you may read, in its conversation. The reply goes to the addresses the "
        "message asks replies to go to, or else to its sender, and each needs send permission; nobody "
        "else is copied. " + SEND_NOTE
    ),
    input_model=Reply,
    needs=((LABEL, "read"), (RECIPIENT, "send")),
    prepare=_prepare_reply,
    consent=REPLY_CONSENT,
    mutates=True,
)


class CreateDraft(Recipients):
    subject: Subject
    body: Body


async def _prepare_create_draft(binding: Binding, data: CreateDraft) -> Prepared:
    async def execute() -> ProviderOutput:
        raw = mime.raw(to=data.to, cc=data.cc, bcc=data.bcc, subject=data.subject, body=data.body)
        draft = await binding.client.create_draft(raw, None)
        record = {
            "draft_id": draft.id,
            "id": draft.message.id,
            "thread_id": draft.message.thread_id,
            "to": data.to,
            "cc": data.cc,
            "bcc": data.bcc,
            "subject": data.subject,
        }
        return ProviderOutput([ScopedRecord(binding.account(), record)])

    return Prepared([Need(binding.account(), "draft")], execute)


CREATE_DRAFT = Operation(
    name="create_draft",
    title="Draft a message",
    description=(
        "Save a new message as a draft. Its recipients need no send permission, since the user sends "
        "drafts themselves. " + DRAFT_NOTE
    ),
    input_model=CreateDraft,
    needs=((ACCOUNT_KIND, "draft"),),
    output_action="draft",
    prepare=_prepare_create_draft,
    consent=DRAFT_CONSENT,
    mutates=True,
)


async def _prepare_create_reply_draft(binding: Binding, data: Reply) -> Prepared:
    original, resource = await locate(binding, data.message, **REPLY_FETCH)
    targets = _reply_targets(original)

    async def execute() -> ProviderOutput:
        message = await _replyable(binding, resource, data.message, targets)
        draft = await binding.client.create_draft(_reply_raw(message, targets, data.body), message.thread_id)
        record = {
            "draft_id": draft.id,
            "id": draft.message.id,
            "thread_id": draft.message.thread_id,
            "in_reply_to": message.id,
            "to": targets,
        }
        return ProviderOutput([ScopedRecord(binding.account(), record)])

    return Prepared([Need(resource, "read"), Need(binding.account(), "draft")], execute)


CREATE_REPLY_DRAFT = Operation(
    name="create_reply_draft",
    title="Draft a reply",
    description=(
        "Save a reply to a message you may read as a draft in its conversation, addressed as reply "
        "would address it. " + DRAFT_NOTE
    ),
    input_model=Reply,
    needs=((LABEL, "read"), (ACCOUNT_KIND, "draft")),
    output_action="draft",
    prepare=_prepare_create_reply_draft,
    consent=REPLY_DRAFT_CONSENT,
    mutates=True,
)
