"""Outlook's write operations: sending mail and replying to it."""

from typing import Annotated, Any

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
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
from connectors.outlook import addresses
from connectors.outlook.client import REPLY_FIELDS, GraphClient, Message, Recipient, User
from connectors.outlook.mailbox import (
    FOLDER,
    RECIPIENT,
    SEND_CONSENT,
    MessageId,
    Tree,
    confirm_message,
    locate,
    no_controls,
)

MAX_RECIPIENTS = 10
MAX_BODY = 20_000


def _plain_text(value: str) -> str:
    if any((ord(c) < 0x20 and c not in "\n\t") or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters other than newlines and tabs")
    return value


Address = Annotated[
    str, Field(min_length=3, max_length=addresses.MAX_ADDRESS), AfterValidator(addresses.checked)
]
Body = Annotated[
    str,
    Field(min_length=1, max_length=MAX_BODY, description="Plain text; sent as it is, not as HTML."),
    AfterValidator(_plain_text),
]


WRITE_NOTE = (
    "Mail is sent as plain text from the connected account and saved to Sent Items. Outlook accepts it "
    "before delivering it; a bounce arrives later as mail. The number of writes per run is limited."
)


def _recipient(binding: Binding, address: str) -> Resource:
    if address == addresses.UNSUPPORTED:
        # Never named by a grant; only allowing every recipient passes it, and the reply is then refused.
        return binding.resource(RECIPIENT, address, (), partial=True)
    return binding.resource(RECIPIENT, address, addresses.ancestors(address))


def _graph_recipients(values: list[str]) -> list[dict[str, Any]]:
    return [{"emailAddress": {"address": value}} for value in values]


class SendMessage(OperationInput):
    to: Annotated[list[Address], Field(min_length=1, max_length=MAX_RECIPIENTS)]
    cc: Annotated[list[Address], Field(max_length=MAX_RECIPIENTS)] = []
    bcc: Annotated[list[Address], Field(max_length=MAX_RECIPIENTS)] = []
    subject: Annotated[str, Field(min_length=1, max_length=255), AfterValidator(no_controls)]
    body: Body

    @model_validator(mode="after")
    def _distinct(self) -> SendMessage:
        everyone = [*self.to, *self.cc, *self.bcc]
        if len(set(everyone)) != len(everyone):
            raise ValueError("each address may appear only once")
        if len(everyone) > MAX_RECIPIENTS:
            raise ValueError(f"a message may go to at most {MAX_RECIPIENTS} addresses")
        return self


async def _prepare_send_message(binding: Binding, data: SendMessage) -> Prepared:
    everyone = [*data.to, *data.cc, *data.bcc]

    async def execute() -> ProviderOutput:
        # Only these fields: never a sender, reply-to address, headers or attachments.
        await binding.client.send(
            {
                "subject": data.subject,
                "body": {"contentType": "Text", "content": data.body},
                "toRecipients": _graph_recipients(data.to),
                "ccRecipients": _graph_recipients(data.cc),
                "bccRecipients": _graph_recipients(data.bcc),
            }
        )
        record = {"sent": True, "to": data.to, "cc": data.cc, "bcc": data.bcc, "subject": data.subject}
        return ProviderOutput([ScopedRecord(_recipient(binding, data.to[0]), record)])

    return Prepared([Need(_recipient(binding, address), "send") for address in everyone], execute)


SEND_MESSAGE = Operation(
    name="send_message",
    title="Send mail",
    description=("Send a new message. Every address in to, cc and bcc needs send permission. " + WRITE_NOTE),
    input_model=SendMessage,
    needs=((RECIPIENT, "send"),),
    output_action="send",
    prepare=_prepare_send_message,
    consent=SEND_CONSENT,
    mutates=True,
)


def _reply_targets(message: Message) -> list[str]:
    """The addresses Graph sends a reply to: the original's reply-to addresses if it has any, otherwise
    its sender (RFC 5322). One Minerva cannot name as an address makes the whole reply unsupported."""
    sources = message.reply_to or ([message.from_] if message.from_ else [])
    targets: list[str] = []
    for source in sources:
        raw = source.email_address.address if source.email_address else None
        try:
            address = addresses.parse(raw or "")
        except OperationError:
            return [addresses.UNSUPPORTED]
        if address not in targets:
            targets.append(address)
    if not targets or len(targets) > MAX_RECIPIENTS:
        return [addresses.UNSUPPORTED]
    return targets


def _own_addresses(user: User) -> set[str]:
    """The account's addresses: its mail and sign-in names, and its aliases (Exchange lists them as
    `SMTP:` or `smtp:` proxy addresses, beside other kinds such as `X500:`)."""
    aliases = [raw[5:] for raw in user.proxy_addresses if raw[:5].lower() == "smtp:"]
    own = set()
    for raw in (user.mail, user.user_principal_name, *aliases):
        try:
            own.add(addresses.parse(raw or ""))
        except OperationError:
            continue
    return own


def _address(recipient: Recipient | None) -> str | None:
    raw = recipient.email_address.address if recipient and recipient.email_address else None
    try:
        return addresses.parse(raw or "")
    except OperationError:
        return None


class Reply(OperationInput):
    message: MessageId
    body: Body


async def _prepare_reply(binding: Binding, data: Reply) -> Prepared:
    tree = Tree(binding.client)
    original, resource = await locate(binding, tree, data.message, REPLY_FIELDS)
    targets = _reply_targets(original)

    async def execute() -> ProviderOutput:
        client: GraphClient = binding.client
        if targets == [addresses.UNSUPPORTED]:
            raise OperationError(
                "UNSUPPORTED_RECIPIENT",
                "Minerva cannot tell who a reply to this message would go to. Use send_message instead.",
            )
        own = _own_addresses(await client.identities())
        sent_items = (await client.folder("sentitems")).id
        # The last reads before the write: the message and its folder, as they are now.
        message = await confirm_message(binding, tree, resource, data.message, fields=REPLY_FIELDS)
        if message.is_draft is not False:
            # A draft's recipients and reply-to addresses can still change; a sent message's cannot.
            raise OperationError("UNSUPPORTED_MESSAGE", "Minerva does not reply to drafts.")
        if _reply_targets(message) != targets:
            raise OperationError("MESSAGE_CHANGED", "Who this message's replies go to changed. Try again.")
        sender, delegate = _address(message.from_), _address(message.sender)
        if sender is None or sender in own or delegate in own or message.parent_folder_id == sent_items:
            raise OperationError(
                "UNSUPPORTED_MESSAGE",
                "Minerva does not reply to messages sent from this account. Use send_message instead.",
            )
        # The recipients are named, and Cc and Bcc emptied, so the reply goes to exactly the addresses that
        # were authorized, whether Graph would otherwise add to them or work them out itself.
        await client.reply(
            message.id,
            {
                "toRecipients": _graph_recipients(targets),
                "ccRecipients": [],
                "bccRecipients": [],
                "body": {"contentType": "Text", "content": data.body},
            },
        )
        return ProviderOutput(
            [ScopedRecord(resource, {"replied": True, "message": message.id, "to": targets})]
        )

    return Prepared(
        [Need(resource, "read"), *(Need(_recipient(binding, target), "send") for target in targets)], execute
    )


REPLY = Operation(
    name="reply",
    title="Reply to a message",
    description=(
        "Reply to a message you may read. The reply goes to the addresses the message asks replies "
        "to go to, or else to its sender, and each needs send permission; nobody else is copied. "
        + WRITE_NOTE
    ),
    input_model=Reply,
    needs=((FOLDER, "read"), (RECIPIENT, "send")),
    prepare=_prepare_reply,
    consent=SEND_CONSENT,
    mutates=True,
)
