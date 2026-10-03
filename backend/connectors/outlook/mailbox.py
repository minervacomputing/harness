"""What Outlook's operations share: Graph consent, folder and message ids, and where folders sit."""

from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.base import DENIED, Binding, OperationError, Resource
from connectors.outlook.client import ID, Folder, GraphClient, Message

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
# Errors about the connection, not about the object a call names; they say nothing about that object.
CONNECTION_ERRORS = frozenset(
    {"CONNECTION_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_ACCOUNT"}
)


def _denied() -> OperationError:
    return OperationError("POLICY_DENIED", DENIED)


def _moved() -> OperationError:
    return OperationError("MAIL_MOVED", "This folder or message moved while Minerva was using it. Try again.")


def no_controls(value: str) -> str:
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters")
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


async def locate(binding: Binding, tree: Tree, message_id: str, fields: str) -> tuple[Message, Resource]:
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


async def confirm_message(binding: Binding, tree: Tree, resource: Resource, message_id: str, **kwargs):
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
