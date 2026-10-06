"""OneDrive and SharePoint. Resources are files and folders in drives: the account's OneDrive, and SharePoint
document libraries. What is allowed on a folder covers everything inside it, and a library's root folder
stands for the whole library.

A resource id joins the drive and item ids Graph uses (`{drive}:{item}`). Every id a call names is looked up
first, and the resource is built from what Graph answers, so another spelling of an id resolves to the same
resource. Personal drive ids are hexadecimal and Graph spells them in either case, so they are kept in lower
case. Only that spelling can be allowed or denied: `describe` leaves out any other.

Each call resolves the chain of parent folders up to the drive's root and hands it to the policy with the
resource. Ancestry that cannot be resolved completely (a parent the account cannot open, as for an item
someone shared from their own OneDrive; a parent in another drive; a limit reached) is marked partial, and
the policy then treats it conservatively. Ancestry is read when the call is prepared, and resolved again
just before a folder is listed, a file is read, or a file is created: a call whose item moved in between is
refused. What remains is the moment between that check and the provider call itself, which Graph offers no
way to close.

An item that points to another drive's item (a shared folder added to a personal OneDrive) is listed with
its target's id, and is otherwise refused: the target is reached by its own id, in its own drive.

Sites are not resources: their libraries are. Without a search, the libraries offered are those of the
SharePoint sites the account follows.
"""

import asyncio
import json
import posixpath
import re
from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import (
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ResourceKind,
    ScopedRecord,
    denied,
)
from connectors.microsoft import consent, oauth, page_param
from connectors.onedrive import office
from connectors.onedrive.client import DriveClient, DriveItem, ItemReference
from connectors.text import single_line

ITEM = "item"
READ_CONSENT = consent("Files.Read.All", "Files.ReadWrite.All")
WRITE_CONSENT = consent("Files.ReadWrite.All")
SITES_CONSENT = consent("Sites.Read.All", "Sites.ReadWrite.All")

ROOT = "root"
MAX_DEPTH = 32
MAX_LOOKUPS = 150
CONCURRENCY = 8
MAX_DESCRIBE = 200
MAX_SITES = 25
MAX_SITE_LIBRARIES = 20
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_OFFICE_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024
PERSONAL_DRIVE = re.compile(r"\A[0-9A-Fa-f]{16}\Z")
DRIVE_PART = r"[A-Za-z0-9!_=-]{1,200}"
ITEM_PART = r"[A-Za-z0-9!_.=-]{1,200}"
ITEM_ID = re.compile(rf"^({DRIVE_PART}):({ITEM_PART})$")
OFFICE = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}
TEXT_TYPES = frozenset(
    {
        "application/json",
        "application/xml",
        "application/javascript",
        "application/x-javascript",
        "application/yaml",
        "application/x-yaml",
        "application/x-sh",
        "application/sql",
    }
)
TEXT_EXTENSIONS = frozenset(
    {
        ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".html", ".htm",
        ".log", ".ini", ".toml", ".rst", ".py", ".js", ".ts", ".sql", ".sh",
    }
)  # fmt: skip
# Characters OneDrive and SharePoint refuse in names, and names they reserve.
INVALID_NAME = re.compile(r'["*:<>?/\\|]')
DEVICES = frozenset(
    {"con", "prn", "aux", "nul", *(f"com{n}" for n in range(10)), *(f"lpt{n}" for n in range(10))}
)
RESERVED_NAMES = frozenset({".lock", "desktop.ini", "forms"})


def _drive_key(drive_id: str) -> str:
    return drive_id.lower() if PERSONAL_DRIVE.match(drive_id) else drive_id


def _key(drive_id: str, item_id: str) -> str:
    return f"{_drive_key(drive_id)}:{item_id}"


def _split(resource_id: str) -> tuple[str, str]:
    match = ITEM_ID.match(resource_id)
    if match is None:
        raise denied()
    return match.group(1), match.group(2)


def _drive_of(client: DriveClient, item: DriveItem) -> str:
    drive = item.parent_reference.drive_id if item.parent_reference else None
    if not drive or not re.fullmatch(DRIVE_PART, drive) or not re.fullmatch(ITEM_PART, item.id):
        raise client.unexpected()
    return _drive_key(drive)


def _target(item: DriveItem) -> str | None:
    """The id of the item another drive's item this one points to, if it does."""
    remote = item.remote_item
    ref = remote.parent_reference if remote else None
    if remote is None or ref is None or not remote.id or not ref.drive_id:
        return None
    key = _key(ref.drive_id, remote.id)
    return key if ITEM_ID.match(key) else None


def _moved() -> OperationError:
    return OperationError("FILE_MOVED", "This file or folder moved while Minerva was using it. Try again.")


def _unseen(error: OperationError) -> bool:
    return error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"}


class Tree:
    """Where items sit, resolved for one call. Parent lookups are cached and limited."""

    def __init__(self, client: DriveClient) -> None:
        self.client = client
        self._items: dict[str, DriveItem | None] = {}
        self._lookups = 0

    def key(self, item: DriveItem) -> str:
        return f"{_drive_of(self.client, item)}:{item.id}"

    async def get(self, item_id: str) -> DriveItem:
        """An item the call names. Items the account cannot open are refused like items without a grant."""
        try:
            if item_id == ROOT:
                item = await self.client.my_root()
            else:
                item = await self.client.item(*_split(item_id))
        except OperationError as error:
            if _unseen(error):
                raise denied() from None
            raise
        self._items[self.key(item)] = item
        return item

    async def _parent(self, drive_id: str, item_id: str) -> DriveItem | None:
        """None when the account cannot open the folder, or the call looked up too many."""
        key = _key(drive_id, item_id)
        if key in self._items:
            return self._items[key]
        if self._lookups >= MAX_LOOKUPS:
            return None
        self._lookups += 1
        try:
            parent: DriveItem | None = await self.client.item(drive_id, item_id)
        except OperationError as error:
            if not _unseen(error):
                raise
            parent = None
        self._items[key] = parent
        return parent

    async def place(self, item: DriveItem) -> tuple[tuple[str, ...], bool]:
        """The item's ancestors, nearest first, and whether the chain is partial."""
        own = self.key(item)
        drive = _drive_of(self.client, item)
        within: list[str] = []
        current = item
        while True:
            if current.root is not None:
                return tuple(within), False
            ref: ItemReference | None = current.parent_reference
            if ref is None or not ref.id or not ref.drive_id or _drive_key(ref.drive_id) != drive:
                return tuple(within), True
            parent_key = _key(drive, ref.id)
            if parent_key == own or parent_key in within or len(within) >= MAX_DEPTH:
                return tuple(within), True
            if not ITEM_ID.match(parent_key):
                return tuple(within), True
            within.append(parent_key)
            parent = await self._parent(drive, ref.id)
            if parent is None or self.key(parent) != parent_key:
                return tuple(within), True
            current = parent

    async def resource(self, binding: Binding, item: DriveItem) -> Resource:
        within, partial = await self.place(item)
        return binding.resource(ITEM, self.key(item), within, partial)

    async def confirm(self, resource: Resource, *, download: bool = False) -> DriveItem:
        """The item again, from Graph, refused if it moved since `resource` was authorized."""
        fresh = Tree(self.client)
        try:
            item = await fresh.client.item(*_split(resource.id), download=download)
        except OperationError as error:
            if _unseen(error):
                raise _moved() from None
            raise
        within, partial = await fresh.place(item)
        if (fresh.key(item), within, partial) != (resource.id, resource.within, resource.partial):
            raise _moved()
        return item


def _type(item: DriveItem) -> str:
    if item.root is not None:
        return "library"
    if item.remote_item is not None:
        return "shortcut"
    if item.folder is not None:
        return "folder"
    if item.package is not None:
        return "package"
    return "file"


def _record(resource: Resource, item: DriveItem, **extra: Any) -> ScopedRecord:
    return ScopedRecord(
        resource,
        {
            "id": resource.id,
            "name": item.name,
            "type": _type(item),
            "mime_type": item.file.mime_type if item.file else None,
            "size": item.size,
            "modified_time": item.last_modified_date_time,
            "link": item.web_url,
            "parent_id": resource.within[0] if resource.within else None,
            "target_id": _target(item),
            **extra,
        },
    )


def _folder(item: DriveItem) -> DriveItem:
    if item.remote_item is not None:
        raise OperationError(
            "UNSUPPORTED_FILE",
            f"This points to an item in another drive. Use its id instead: {_target(item)}.",
        )
    if item.folder is None and item.root is None:
        raise OperationError("UNSUPPORTED_FILE", "This is not a folder.")
    return item


ItemId = Annotated[
    str,
    Field(
        max_length=420,
        pattern=rf"^({ROOT}|{DRIVE_PART}:{ITEM_PART})$",
        description="A file's id from a record.",
    ),
]
FolderId = Annotated[
    str,
    Field(
        max_length=420,
        pattern=rf"^({ROOT}|{DRIVE_PART}:{ITEM_PART})$",
        description="A folder's or library's id from a record, or \"root\" for your own OneDrive.",
    ),
]
Cursor = Annotated[str, Field(max_length=1000)]


async def _libraries(client: DriveClient) -> tuple[list[tuple[DriveItem, str]], bool]:
    """The root folders of the account's OneDrive and of the libraries of the SharePoint sites it follows,
    each with a name, and whether sites were left out."""
    found: list[tuple[DriveItem, str]] = []
    mine = await client.my_drive()
    if mine is not None:
        found.append((await client.my_root(), "OneDrive"))
        if mine.drive_type == "personal":
            return found, False
    try:
        sites, more = await client.followed_sites(MAX_SITES)
    except OperationError as error:
        if not _unseen(error):
            raise
        return found, False
    limit = asyncio.Semaphore(CONCURRENCY)

    async def site_libraries(site_id: str) -> list[Any]:
        async with limit:
            try:
                return await client.libraries(site_id, MAX_SITE_LIBRARIES)
            except OperationError as error:
                if not _unseen(error):
                    raise
                return []

    async def root(drive_id: str) -> DriveItem | None:
        async with limit:
            try:
                return await client.drive_root(drive_id)
            except OperationError as error:
                if not _unseen(error):
                    raise
                return None

    per_site = await asyncio.gather(*(site_libraries(site.id) for site in sites))
    named = [
        (drive, f"{site.display_name or site.name or 'Site'} / {drive.name}")
        for site, drives in zip(sites, per_site, strict=True)
        for drive in drives
        if drive.drive_type == "documentLibrary"
    ]
    roots = await asyncio.gather(*(root(drive.id) for drive, _ in named))
    seen = {(f"{_drive_of(client, item)}:{item.id}") for item, _ in found}
    for item, (_, name) in zip(roots, named, strict=True):
        if item is not None and (key := f"{_drive_of(client, item)}:{item.id}") not in seen:
            seen.add(key)
            found.append((item, name))
    return found, more


class ListLibraries(OperationInput):
    pass


async def _prepare_list_libraries(binding: Binding, data: ListLibraries) -> Prepared:
    tree = Tree(binding.client)

    async def execute() -> ProviderOutput:
        libraries, more = await _libraries(tree.client)
        records = [
            _record(binding.resource(ITEM, tree.key(item), (), False), item, name=name)
            for item, name in libraries
        ]
        return ProviderOutput(records, incomplete=more)

    return Prepared([Enumerate(ITEM, "read")], execute)


LIST_LIBRARIES = Operation(
    name="list_libraries",
    title="List libraries",
    description=(
        "List where files live: your own OneDrive, and the document libraries of the SharePoint sites "
        f"you follow (up to {MAX_SITES} sites). Libraries you may not read are left out; you may still "
        "have access to folders inside them, which list_folder and search_files reach. incomplete: true "
        "means you follow more sites than were listed."
    ),
    input_model=ListLibraries,
    needs=((ITEM, "read"),),
    prepare=_prepare_list_libraries,
    consent=SITES_CONSENT,
)


class ListFolder(OperationInput):
    folder_id: FolderId
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    cursor: Cursor | None = None


async def _prepare_list_folder(binding: Binding, data: ListFolder) -> Prepared:
    tree = Tree(binding.client)
    folder = await tree.get(data.folder_id)
    resource = await tree.resource(binding, folder)

    async def execute() -> ProviderOutput:
        folder = _folder(await tree.confirm(resource))
        drive = _drive_of(tree.client, folder)
        children, next_cursor = await tree.client.children(
            drive, folder.id, limit=data.limit, cursor=data.cursor
        )
        within = (resource.id, *resource.within)
        records = [
            _record(binding.resource(ITEM, _key(drive, child.id), within, resource.partial), child)
            for child in children
            # A child that does not name this folder as its parent is not placed by this listing.
            if child.parent_reference
            and child.parent_reference.id == folder.id
            and _drive_key(child.parent_reference.drive_id or "") == drive
            and ITEM_ID.match(_key(drive, child.id))
        ]
        return ProviderOutput(records, next_cursor)

    return Prepared([Need(resource, "read")], execute)


LIST_FOLDER = Operation(
    name="list_folder",
    title="List a folder",
    description=(
        'List the files and folders inside one folder or library. Use "root" for your own OneDrive. '
        "An item of type shortcut points to an item in another drive: use its target_id. Items you may "
        "not read are left out. To get the next page, repeat the call with identical arguments plus the "
        "returned next_cursor."
    ),
    input_model=ListFolder,
    needs=((ITEM, "read"),),
    prepare=_prepare_list_folder,
    consent=READ_CONSENT,
    paginated=True,
)


class SearchFiles(OperationInput):
    text: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
    limit: Annotated[int, Field(ge=1, le=25)] = 10
    cursor: Cursor | None = None


async def _search(
    client: DriveClient, text: str, *, limit: int, cursor: str | None
) -> tuple[list[str], str | None]:
    """The ids of the items a search hits, in Microsoft's order, and the next page's cursor."""
    mine = await client.my_drive()
    if mine is not None and mine.drive_type == "personal":
        items, next_cursor = await client.search_personal(text, limit=limit, cursor=cursor)
    else:
        offset = 0
        if cursor is not None:
            skip = page_param(cursor).get("$skip")
            if skip is None:
                raise OperationError("INVALID_CURSOR", "This page token is invalid.")
            offset = int(skip)
        items, more = await client.search_work(text, offset=offset, size=limit)
        next_cursor = f"skip:{offset + limit}" if more else None
    ids: list[str] = []
    for item in items:
        target = _target(item)
        if target is None:
            drive = item.parent_reference.drive_id if item.parent_reference else None
            target = _key(drive, item.id) if drive else None
        if target and ITEM_ID.match(target) and target not in ids:
            ids.append(target)
    return ids, next_cursor


async def _prepare_search_files(binding: Binding, data: SearchFiles) -> Prepared:
    tree = Tree(binding.client)

    async def execute() -> ProviderOutput:
        ids, next_cursor = await _search(tree.client, data.text, limit=data.limit, cursor=data.cursor)
        records = []
        for item_id in ids:
            # Each hit is read again by id: what the search said about it is not relied on.
            try:
                item = await tree.get(item_id)
            except OperationError as error:
                if error.code != "POLICY_DENIED":
                    raise
                continue
            records.append(_record(await tree.resource(binding, item), item))
        return ProviderOutput(records, next_cursor)

    return Prepared([Enumerate(ITEM, "read")], execute)


SEARCH_FILES = Operation(
    name="search_files",
    title="Search files",
    description=(
        "Search files and folders by words in their names and content: for work and school accounts "
        "across OneDrive, SharePoint and what was shared with you (Microsoft Search, which accepts KQL); "
        "for personal accounts in your OneDrive and what was shared with you. Only items you may read "
        "are returned, so a page may have fewer results than limit. To get the next page, repeat the "
        "call with identical arguments plus the returned next_cursor."
    ),
    input_model=SearchFiles,
    needs=((ITEM, "read"),),
    prepare=_prepare_search_files,
    consent=READ_CONSENT,
    paginated=True,
)


class GetFile(OperationInput):
    file_id: ItemId


async def _prepare_get_file(binding: Binding, data: GetFile) -> Prepared:
    tree = Tree(binding.client)
    item = await tree.get(data.file_id)
    resource = await tree.resource(binding, item)

    async def execute() -> ProviderOutput:
        return ProviderOutput([_record(resource, item)])

    return Prepared([Need(resource, "read")], execute)


GET_FILE = Operation(
    name="get_file",
    title="Get file details",
    description="Read the details of one file, folder or library by id.",
    input_model=GetFile,
    needs=((ITEM, "read"),),
    prepare=_prepare_get_file,
    consent=READ_CONSENT,
)


class ReadFile(OperationInput):
    file_id: ItemId
    max_chars: Annotated[int, Field(ge=1, le=100_000)] = 20_000


def _readable(item: DriveItem) -> str:
    """How a file is read: "text", or the Office format whose text is extracted."""
    if item.remote_item is not None:
        raise OperationError(
            "UNSUPPORTED_FILE",
            f"This points to an item in another drive. Use its id instead: {_target(item)}.",
        )
    if item.file is None:
        raise OperationError("UNSUPPORTED_FILE", "This is not a file.")
    mime = (item.file.mime_type or "").split(";")[0].strip().lower()
    extension = posixpath.splitext(item.name)[1].lower()
    if (kind := OFFICE.get(mime)) or (kind := extension.removeprefix(".")) in office.READERS:
        return kind
    if mime.startswith("text/") or mime in TEXT_TYPES or extension in TEXT_EXTENSIONS:
        return "text"
    raise OperationError(
        "UNSUPPORTED_FILE",
        "Minerva can read Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and text files, not this type of "
        "file.",
    )


async def _text(client: DriveClient, item: DriveItem, limit: int) -> str:
    kind = _readable(item)
    size_limit = MAX_TEXT_BYTES if kind == "text" else MAX_OFFICE_BYTES
    if item.size is not None and item.size > size_limit:
        raise OperationError("FILE_TOO_LARGE", f"Minerva reads files of this type up to {size_limit} bytes.")
    if not item.download_url:
        raise OperationError("PROVIDER_FORBIDDEN", "OneDrive does not offer this file for download.")
    body = await client.content(item.download_url, limit=size_limit)
    if kind == "text":
        return body.decode("utf-8", errors="replace").removeprefix("﻿")
    return await asyncio.to_thread(office.extract, kind, body, limit)


async def _prepare_read_file(binding: Binding, data: ReadFile) -> Prepared:
    tree = Tree(binding.client)
    item = await tree.get(data.file_id)
    resource = await tree.resource(binding, item)

    async def execute() -> ProviderOutput:
        item = await tree.confirm(resource, download=True)
        text = await _text(tree.client, item, data.max_chars + 1)
        truncated = len(text) > data.max_chars
        return ProviderOutput([_record(resource, item, text=text[: data.max_chars], truncated=truncated)])

    return Prepared([Need(resource, "read")], execute)


READ_FILE = Operation(
    name="read_file",
    title="Read a file",
    description=(
        "Read the text of one file: Word documents and PowerPoint slides as plain text, the first sheet "
        "of an Excel workbook as CSV (stored values; dates as numbers), and text files. Other types (PDF, "
        "images, legacy .doc/.xls) are not supported. Long text is cut at max_chars and marked truncated."
    ),
    input_model=ReadFile,
    needs=((ITEM, "read"),),
    prepare=_prepare_read_file,
    consent=READ_CONSENT,
)


def _upload_size(value: str) -> str:
    if len(value.encode()) > MAX_UPLOAD_BYTES:
        raise ValueError(f"must be at most {MAX_UPLOAD_BYTES} bytes as UTF-8")
    return value


def _file_name(value: str) -> str:
    if INVALID_NAME.search(value):
        raise ValueError('must not contain any of " * : < > ? / \\ |')
    lowered = value.lower()
    if value.endswith(".") or lowered.split(".")[0] in DEVICES or lowered in RESERVED_NAMES:
        raise ValueError("is a name OneDrive and SharePoint do not allow")
    if value.startswith("~$") or "_vti_" in lowered:
        raise ValueError("is a name OneDrive and SharePoint do not allow")
    return value


class CreateFile(OperationInput):
    folder_id: FolderId
    name: Annotated[
        str,
        Field(min_length=1, max_length=200, description="The new file's name, with its extension."),
        AfterValidator(single_line),
        AfterValidator(_file_name),
    ]
    content: Annotated[str, Field(max_length=MAX_UPLOAD_BYTES), AfterValidator(_upload_size)]


async def _prepare_create_file(binding: Binding, data: CreateFile) -> Prepared:
    tree = Tree(binding.client)
    folder = await tree.get(data.folder_id)
    resource = await tree.resource(binding, folder)

    async def execute() -> ProviderOutput:
        folder = _folder(await tree.confirm(resource))
        drive = _drive_of(tree.client, folder)
        created = await tree.client.upload(drive, folder.id, data.name, data.content.encode())
        key = _key(drive, created.id)
        if not ITEM_ID.match(key):
            raise tree.client.unexpected()
        ref = created.parent_reference
        placed = ref is not None and ref.id == folder.id and _drive_key(ref.drive_id or drive) == drive
        # The record names where Graph says it put the file; anywhere else is not placed by this call.
        within, partial = ((resource.id, *resource.within), resource.partial) if placed else ((), True)
        return ProviderOutput([_record(binding.resource(ITEM, key, within, partial), created)])

    return Prepared([Need(resource, "create")], execute)


CREATE_FILE = Operation(
    name="create_file",
    title="Create a file",
    description=(
        'Create one text file in a folder or library where you have create permission. Use "root" for '
        "your own OneDrive. An existing file is never replaced: if the name is taken, the call fails. "
        "Everyone who can open the folder can open the file."
    ),
    input_model=CreateFile,
    needs=((ITEM, "create"),),
    prepare=_prepare_create_file,
    consent=WRITE_CONSENT,
    mutates=True,
)


def _search_cursor(cursor: str) -> str:
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    if not isinstance(state, dict) or set(state) != {"page"} or not isinstance(state["page"], str):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return state["page"]


class OneDriveConnector(Connector):
    slug = "onedrive"
    name = "OneDrive and SharePoint"
    kinds = (
        ResourceKind(
            ITEM,
            "File",
            ("read", "create"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Microsoft lets Minerva open every file the account can open, in OneDrive and SharePoint; "
                "Minerva limits agents to the files, folders and libraries allowed here. Access to a "
                "folder covers everything inside it, and access to a library covers the whole library."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read files"),
        ActionSpec("create", "Create files", requires="read"),
    )
    # Reading is enough to connect; writing is asked for once the user allows an agent to create files.
    # Sites.Read.All lists the SharePoint sites the account follows, and their libraries.
    auth = oauth("Files.Read.All", "Sites.Read.All")

    operations = (LIST_LIBRARIES, LIST_FOLDER, SEARCH_FILES, GET_FILE, READ_FILE, CREATE_FILE)

    def client(self, access_token: str) -> DriveClient:
        return DriveClient(access_token)

    async def account(self, client: DriveClient) -> Account:
        user = await client.me()
        return Account(
            id=user.id, label=user.mail or user.user_principal_name or user.display_name or "OneDrive"
        )

    async def discover(
        self, client: DriveClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            if cursor:
                raise OperationError("INVALID_CURSOR", "This page token is invalid.")
            libraries, _ = await _libraries(client)
            return DiscoveryPage(
                [DiscoveryItem(f"{_drive_of(client, item)}:{item.id}", name) for item, name in libraries]
            )
        page = _search_cursor(cursor) if cursor else None
        ids, next_cursor = await _search(client, query, limit=25, cursor=page)
        names = await self.describe(client, kind, ids)
        return DiscoveryPage(
            [DiscoveryItem(i, names[i]) for i in ids if i in names],
            json.dumps({"page": next_cursor}) if next_cursor else None,
        )

    async def describe(self, client: DriveClient, kind: str, ids: list[str]) -> dict[str, str]:
        mine = await client.my_drive()
        limit = asyncio.Semaphore(CONCURRENCY)

        async def name(item_id: str) -> str | None:
            if not ITEM_ID.match(item_id):
                return None
            async with limit:
                try:
                    item = await client.item(*_split(item_id))
                    # Only the id as calls spell it can be allowed: a grant under another spelling of it
                    # would never match.
                    if f"{_drive_of(client, item)}:{item.id}" != item_id:
                        return None
                    if item.root is None:
                        return f"{item.name}/" if item.folder is not None else item.name
                    drive = await client.drive(_drive_of(client, item))
                except OperationError as error:
                    if _unseen(error):
                        return None
                    raise
            if mine is not None and _drive_key(drive.id) == _drive_key(mine.id):
                return "OneDrive"
            return f"{drive.name} (library)"

        wanted = ids[:MAX_DESCRIBE]
        names = await asyncio.gather(*(name(item_id) for item_id in wanted))
        return {item_id: n for item_id, n in zip(wanted, names, strict=True) if n is not None}
