"""Outlook mail, through Microsoft Graph. Folders are read per folder; mail is sent per recipient.

Microsoft's read permission covers the whole mailbox, so the folder limits are Minerva's. A grant on a
folder covers its subfolders. Each call resolves where a folder sits (its chain of parent folders up to
the top of the mailbox's folders) before authorization, and again just before it reads or replies: a
call whose folder moved in between is refused. Folders outside that tree (Exchange's system folders) are
refused, and so are search folders, which collect mail from other folders, and hidden folders, wherever
they sit and for everything below them. A listing leaves out any message that does not live in the folder
listed.

Sending is allowed per recipient address, or per domain (see `addresses`). Every address a message goes
to, Cc and Bcc included, needs a grant. A reply goes to the addresses the original asks replies to go to,
or else to its sender, and needs a grant for each of them and permission to read the original's folder.
Minerva names those addresses itself in the reply, and refuses replies to drafts and to the account's own
messages (sent from any of its addresses, sent by it for someone else, or kept in Sent Items), whose
recipients Graph would work out differently.

Mail is sent as plain text, from the connected account, and saved to Sent Items. Not supported: drafts,
attachments, forwarding, reply-all, moving, deleting or flagging mail, and shared mailboxes.
"""

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    DENIED,
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    OAuth2,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ResourceKind,
    ScopedRecord,
)
from connectors.outlook import addresses
from connectors.outlook.client import (
    FULL_FIELDS,
    ID,
    REPLY_FIELDS,
    Folder,
    GraphClient,
    Message,
    Recipient,
    User,
)

FOLDER = "folder"
RECIPIENT = "recipient"
GRAPH = "https://graph.microsoft.com"


def _consent(*scopes: str) -> tuple[frozenset[str], ...]:
    """Any of these Graph scopes, the first as requested. Microsoft reports granted scopes in their short
    form, or prefixed with Graph's URL, and not always in the case they were requested in."""
    spellings = [form for scope in scopes for form in (scope, f"{GRAPH}/{scope}")]
    spellings += [form.lower() for form in spellings]
    return tuple(frozenset({form}) for form in dict.fromkeys(spellings))


READ_CONSENT = _consent("Mail.Read", "Mail.ReadWrite")
SEND_CONSENT = _consent("Mail.Send")

ROOT = "msgfolderroot"
WELL_KNOWN = ("inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail")
MAX_DEPTH = 16
MAX_LOOKUPS = 60
MAX_RECIPIENTS = 10
MAX_BODY = 20_000
MAX_ATTACHMENTS = 20
DESCRIBE_CONCURRENCY = 5
MAX_DISCOVER = 500
MAX_DISCOVER_REQUESTS = 60
# Before any mail: the lower bound that lets a filter on time precede `isRead` (Graph requires properties
# in $orderby to come first in $filter).
EPOCH = "1900-01-01T00:00:00Z"
# Errors about the connection, not about the object a call names; they say nothing about that object.
CONNECTION_ERRORS = frozenset(
    {"CONNECTION_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_ACCOUNT"}
)


def _denied() -> OperationError:
    return OperationError("POLICY_DENIED", DENIED)


def _moved() -> OperationError:
    return OperationError("MAIL_MOVED", "This folder or message moved while Minerva was using it. Try again.")


def _no_controls(value: str) -> str:
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters")
    return value


def _plain_text(value: str) -> str:
    if any((ord(c) < 0x20 and c not in "\n\t") or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters other than newlines and tabs")
    return value


def _search_text(value: str) -> str:
    _no_controls(value)
    if '"' in value or "\\" in value:
        raise ValueError("must not contain double quotes or backslashes")
    return value


def _folder_ref(value: str) -> str:
    if value.lower() in WELL_KNOWN:
        return value.lower()
    if ID.match(value):
        return value
    raise ValueError(f"must be a folder id, or one of: {', '.join(WELL_KNOWN)}")


def _message_id(value: str) -> str:
    if not ID.match(value):
        raise ValueError("must be a message id from list_messages")
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


FolderRef = Annotated[
    str,
    Field(
        min_length=1,
        max_length=512,
        description=f"A folder id from list_folders, or a well-known folder: {', '.join(WELL_KNOWN)}.",
    ),
    AfterValidator(_folder_ref),
]
MessageId = Annotated[str, Field(min_length=10, max_length=512), AfterValidator(_message_id)]
Moment = Annotated[
    str, Field(min_length=1, max_length=40, description="An ISO 8601 time."), AfterValidator(_moment)
]
Cursor = Annotated[str, Field(max_length=1000)]
Address = Annotated[
    str, Field(min_length=3, max_length=addresses.MAX_ADDRESS), AfterValidator(addresses.checked)
]
Body = Annotated[
    str,
    Field(min_length=1, max_length=MAX_BODY, description="Plain text; sent as it is, not as HTML."),
    AfterValidator(_plain_text),
]


class Tree:
    """Where folders sit, resolved for one call. Parent lookups are cached and limited."""

    def __init__(self, client: GraphClient) -> None:
        self.client = client
        self._root: str | None = None
        self._folders: dict[str, Folder | None] = {}
        self._lookups = 0

    async def root(self) -> str:
        """The id of the top of the mailbox's folders (Graph's msgfolderroot)."""
        if self._root is None:
            root = await self.client.folder(ROOT)
            if not ID.match(root.id):
                raise self.client.unexpected()
            self._root = root.id
        return self._root

    async def _parent(self, folder_id: str) -> Folder | None:
        """None when the folder cannot be read, or the call looked up too many."""
        if folder_id in self._folders:
            return self._folders[folder_id]
        if self._lookups >= MAX_LOOKUPS:
            return None
        self._lookups += 1
        try:
            parent: Folder | None = await self.client.folder(folder_id)
        except OperationError as error:
            if error.code in CONNECTION_ERRORS:
                raise
            parent = None
        if parent is not None and parent.id != folder_id:
            parent = None
        self._folders[folder_id] = parent
        return parent

    async def place(self, folder: Folder) -> tuple[str, ...] | None:
        """The folder's ancestors below the root, nearest first. None for a folder outside the tree under
        the root (the root itself, search folders, system folders), or one whose chain cannot be followed
        completely: such folders are never resources."""
        root = await self.root()
        if folder.id == root or not ID.match(folder.id):
            return None
        within: list[str] = []
        current = folder
        while True:
            if not current.ordinary:
                return None
            parent_id = current.parent_folder_id
            if parent_id == root:
                return tuple(within)
            if (
                not parent_id
                or not ID.match(parent_id)
                or parent_id == folder.id
                or parent_id in within
                or len(within) >= MAX_DEPTH
            ):
                return None
            parent = await self._parent(parent_id)
            if parent is None:
                return None
            within.append(parent_id)
            current = parent

    def path(self, folder: Folder, within: tuple[str, ...]) -> str:
        """The folder's name with its parents' names, as far as they were looked up."""
        names = [f.display_name for f in (self._folders.get(i) for i in reversed(within)) if f is not None]
        return "/".join([*names, folder.display_name])

    async def resolve(self, binding: Binding, name: str) -> tuple[Resource, Folder]:
        """The folder a call names, as the resource that is authorized. Anything that keeps Minerva from
        placing it is refused like a folder without a grant, so the refusal says nothing about it."""
        try:
            folder = await self.client.folder(name)
            within = await self.place(folder)
        except OperationError as error:
            if error.code in CONNECTION_ERRORS:
                raise
            raise _denied() from None
        if within is None or (name not in WELL_KNOWN and folder.id != name):
            raise _denied()
        self._folders[folder.id] = folder
        return binding.resource(FOLDER, folder.id, within), folder

    async def confirm(self, resource: Resource) -> Folder:
        """The folder again, from Graph, refused if it moved since `resource` was authorized."""
        fresh = Tree(self.client)
        fresh._root = self._root
        try:
            folder = await self.client.folder(resource.id)
            within = await fresh.place(folder)
        except OperationError as error:
            if error.code in CONNECTION_ERRORS:
                raise
            raise _moved() from None
        if folder.id != resource.id or within != resource.within:
            raise _moved()
        return folder


async def _locate(binding: Binding, tree: Tree, message_id: str, fields: str) -> tuple[Message, Resource]:
    """A message and the folder it lives in, before authorization. A message Minerva cannot read or place
    is refused like one in a folder without a grant."""
    try:
        message = await binding.client.message(message_id, fields=fields)
    except OperationError as error:
        if error.code in CONNECTION_ERRORS:
            raise
        raise _denied() from None
    if message.id != message_id or not message.parent_folder_id or not ID.match(message.parent_folder_id):
        raise _denied()
    resource, _ = await tree.resolve(binding, message.parent_folder_id)
    return message, resource


async def _confirm_message(binding: Binding, tree: Tree, resource: Resource, message_id: str, **kwargs):
    """The message again, with its folder, refused if either moved since the folder was authorized."""
    await tree.confirm(resource)
    try:
        message = await binding.client.message(message_id, **kwargs)
    except OperationError as error:
        if error.code in CONNECTION_ERRORS:
            raise
        raise _moved() from None
    if message.id != message_id or message.parent_folder_id != resource.id:
        raise _moved()
    return message


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


class ReadMessage(OperationInput):
    message: MessageId
    max_chars: Annotated[int, Field(ge=500, le=50_000)] = 20_000
    # Where to start in the body, to continue a long message.
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0


async def _prepare_read_message(binding: Binding, data: ReadMessage) -> Prepared:
    tree = Tree(binding.client)
    _, resource = await _locate(binding, tree, data.message, "id,parentFolderId")

    async def execute() -> ProviderOutput:
        client: GraphClient = binding.client
        message = await _confirm_message(
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
    subject: Annotated[str, Field(min_length=1, max_length=255), AfterValidator(_no_controls)]
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
    original, resource = await _locate(binding, tree, data.message, REPLY_FIELDS)
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
        message = await _confirm_message(binding, tree, resource, data.message, fields=REPLY_FIELDS)
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


WRITE_NOTE = (
    "Mail is sent as plain text from the connected account and saved to Sent Items. Outlook accepts it "
    "before delivering it; a bounce arrives later as mail. The number of writes per run is limited."
)


class OutlookConnector(Connector):
    slug = "outlook"
    name = "Outlook"
    kinds = (
        ResourceKind(
            FOLDER,
            "Folder",
            ("read",),
            wildcard=True,
            hierarchical=True,
            note=(
                "Microsoft lets Minerva read the whole mailbox; Minerva limits agents to the folders allowed "
                "here. Access to a folder covers its subfolders."
            ),
        ),
        ResourceKind(
            RECIPIENT,
            "Recipient",
            ("send",),
            wildcard=True,
            hierarchical=True,
            listed=False,
            note=(
                "Paste an address or a domain to add it. Everyone at a domain means every address there, "
                "which for a provider such as gmail.com is everyone with an account. Mail to an address can "
                "still reach others through distribution lists, aliases and forwarding."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read mail"),
        ActionSpec("send", "Send mail"),
    )
    # Reading is enough to connect; sending is asked for once the user allows it.
    auth = OAuth2(
        app="microsoft",
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",  # noqa: S106
        scopes=("offline_access", "User.Read", "Mail.Read"),
        authorize_params=(("prompt", "select_account"),),
    )

    operations = (
        Operation(
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
        ),
        Operation(
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
        ),
        Operation(
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
        ),
        Operation(
            name="send_message",
            title="Send mail",
            description=(
                "Send a new message. Every address in to, cc and bcc needs send permission. " + WRITE_NOTE
            ),
            input_model=SendMessage,
            needs=((RECIPIENT, "send"),),
            output_action="send",
            prepare=_prepare_send_message,
            consent=SEND_CONSENT,
            mutates=True,
        ),
        Operation(
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
        ),
    )

    def client(self, access_token: str) -> GraphClient:
        return GraphClient(access_token)

    async def account(self, client: GraphClient) -> Account:
        user = await client.me()
        return Account(
            id=user.id, label=user.mail or user.user_principal_name or user.display_name or "Outlook"
        )

    async def discover(
        self, client: GraphClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if kind == RECIPIENT:
            if not query:
                return DiscoveryPage([])
            return DiscoveryPage(
                [DiscoveryItem(item, addresses.name(item)) for item in addresses.choices(query)]
            )
        found = await _all_folders(client)
        folded = query.casefold() if query else None
        return DiscoveryPage(
            [
                DiscoveryItem(folder_id, path)
                for folder_id, path in found
                if not folded or folded in path.casefold()
            ]
        )

    async def describe(self, client: GraphClient, kind: str, ids: list[str]) -> dict[str, str]:
        if kind == RECIPIENT:
            return {
                resource_id: addresses.name(resource_id)
                for resource_id in ids
                if addresses.valid_id(resource_id)
            }
        tree = Tree(client)
        await tree.root()
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)

        async def name(folder_id: str) -> str | None:
            async with limit:
                try:
                    folder = await client.folder(folder_id)
                    within = await tree.place(folder)
                except OperationError as error:
                    if error.code in CONNECTION_ERRORS:
                        raise
                    return None
            if within is None or folder.id != folder_id:
                return None
            return tree.path(folder, within)

        wanted = [folder_id for folder_id in ids if ID.match(folder_id)]
        names = await asyncio.gather(*(name(folder_id) for folder_id in wanted))
        return {folder_id: n for folder_id, n in zip(wanted, names, strict=True) if n is not None}


async def _all_folders(client: GraphClient) -> list[tuple[str, str]]:
    """Folders under the root with their paths, breadth first, as many as a few requests find."""
    root = (await client.folder(ROOT)).id
    found: list[tuple[str, str]] = []
    queue: list[tuple[str | None, str]] = [(None, "")]
    requests = 0
    while queue and requests < MAX_DISCOVER_REQUESTS and len(found) < MAX_DISCOVER:
        parent, prefix = queue.pop(0)
        cursor = None
        while requests < MAX_DISCOVER_REQUESTS:
            requests += 1
            folders, cursor = await client.folders(parent, limit=100, cursor=cursor)
            for folder in folders:
                if (
                    folder.parent_folder_id != (parent or root)
                    or not ID.match(folder.id)
                    or not folder.ordinary
                ):
                    continue
                path = prefix + folder.display_name
                found.append((folder.id, path))
                if folder.child_folder_count:
                    queue.append((folder.id, f"{path}/"))
            if cursor is None:
                break
    return found[:MAX_DISCOVER]
