"""Google Drive. Resources are files and folders; what is allowed on a folder covers everything inside it.

Each call resolves where the files it touches sit (their chain of parent folders) and hands that to the
policy with each resource. Ancestry that cannot be resolved completely (a parent the account cannot see, a
limit reached) is marked partial, and the policy then treats it conservatively. Ancestry is read when the
call is prepared, and resolved again just before a folder is listed, a file is read, or a file is created:
a call whose file moved in between is refused. What remains is the moment between that check and the
provider call itself, which Drive offers no way to close.
"""

import asyncio
import json
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
from connectors.google import oauth as google_oauth
from connectors.google_drive.client import FOLDER, SHORTCUT, DriveFile, GoogleDriveClient, quoted
from connectors.text import single_line

FILE = "file"
READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
FULL_SCOPE = "https://www.googleapis.com/auth/drive"
READ_CONSENT = (frozenset({READ_SCOPE}), frozenset({FULL_SCOPE}))
# Google's narrower drive.file scope cannot add files to folders Minerva did not create, so creating files
# needs the full scope. What agents may do stays limited by Minerva's permissions.
CREATE_CONSENT = (frozenset({FULL_SCOPE}),)

ROOT = "root"
MAX_DEPTH = 32
MAX_LOOKUPS = 150
DESCRIBE_CONCURRENCY = 8
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_EXPORT_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024
GOOGLE_DOC = "application/vnd.google-apps.document"
EXPORTS = {
    GOOGLE_DOC: "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}
TYPES = {
    FOLDER: "folder",
    SHORTCUT: "shortcut",
    GOOGLE_DOC: "document",
    "application/vnd.google-apps.spreadsheet": "spreadsheet",
    "application/vnd.google-apps.presentation": "presentation",
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
        "application/x-httpd-php",
    }
)


def _upload_size(value: str) -> str:
    if len(value.encode()) > MAX_UPLOAD_BYTES:
        raise ValueError(f"must be at most {MAX_UPLOAD_BYTES} bytes as UTF-8")
    return value


FileId = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")]
FolderId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9_-]+$",
        description='A folder id, or "root" for My Drive.',
    ),
]
Cursor = Annotated[str, Field(max_length=1000)]


def _moved() -> OperationError:
    return OperationError("FILE_MOVED", "This file or folder moved while Minerva was using it. Try again.")


class Tree:
    """Where files sit, resolved for one call. Parent lookups are cached and limited."""

    def __init__(self, client: GoogleDriveClient) -> None:
        self.client = client
        self._root: str | None = None
        self._files: dict[str, DriveFile | None] = {}
        self._lookups = 0

    async def root(self) -> str:
        if self._root is None:
            self._root = await self.client.root_id()
        return self._root

    async def get(self, file_id: str) -> DriveFile:
        """A file the call names. Files the account cannot see are refused like files without a grant."""
        if file_id == ROOT:
            file_id = await self.root()
        try:
            file = await self.client.file(file_id)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise
        self._files[file.id] = file
        return file

    async def _parent(self, file_id: str) -> DriveFile | None:
        """None when the account cannot see the folder, or the call looked up too many."""
        if file_id in self._files:
            return self._files[file_id]
        if self._lookups >= MAX_LOOKUPS:
            return None
        self._lookups += 1
        try:
            parent: DriveFile | None = await self.client.file(file_id)
        except OperationError as error:
            if error.code != "NOT_FOUND":
                raise
            parent = None
        self._files[file_id] = parent
        return parent

    async def place(self, file: DriveFile) -> tuple[tuple[str, ...], bool]:
        """The file's ancestors, nearest first, and whether the chain is partial."""
        root = await self.root()
        within: list[str] = []
        current = file
        while True:
            if current.id == root or (current.drive_id and current.id == current.drive_id):
                return tuple(within), False
            parents = current.parents or []
            if len(parents) > 1:
                raise OperationError(
                    "UNSUPPORTED_FILE", "This file is in several folders, which Minerva does not support."
                )
            if not parents:
                # Shared with the account without its folder, or orphaned.
                return tuple(within), True
            parent_id = parents[0]
            if parent_id == file.id or parent_id in within or len(within) >= MAX_DEPTH:
                return tuple(within), True
            within.append(parent_id)
            if parent_id == root or (current.drive_id and parent_id == current.drive_id):
                return tuple(within), False
            parent = await self._parent(parent_id)
            if parent is None or parent.id != parent_id:
                return tuple(within), True
            current = parent

    async def resource(self, binding: Binding, file: DriveFile) -> Resource:
        within, partial = await self.place(file)
        return binding.resource(FILE, file.id, within, partial)

    async def confirm(self, resource: Resource) -> DriveFile:
        """The file again, from Drive, refused if it moved since `resource` was authorized."""
        fresh = Tree(self.client)
        fresh._root = self._root
        try:
            file = await fresh.client.file(resource.id)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise _moved() from None
            raise
        within, partial = await fresh.place(file)
        if (file.id, within, partial) != (resource.id, resource.within, resource.partial):
            raise _moved()
        return file


def _record(resource: Resource, file: DriveFile, **extra: Any) -> ScopedRecord:
    size = int(file.size) if file.size and file.size.isdigit() else None
    shortcut = file.shortcut_details
    return ScopedRecord(
        resource,
        {
            "id": file.id,
            "name": file.name,
            "type": TYPES.get(file.mime_type, "file"),
            "mime_type": file.mime_type,
            "size": size,
            "modified_time": file.modified_time,
            "link": file.web_view_link,
            "parent_id": resource.within[0] if resource.within else None,
            "shared_drive_id": file.drive_id,
            "trashed": file.trashed,
            "shortcut_target_id": shortcut.target_id if shortcut else None,
            **extra,
        },
    )


def _next_cursor(token: str | None) -> str | None:
    if token and len(token) > 1000:
        raise OperationError("PROVIDER_LIMIT", "Google Drive returned a page token that is too long.")
    return token


class ListFolder(OperationInput):
    folder_id: FolderId
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    cursor: Cursor | None = None


async def _prepare_list_folder(binding: Binding, data: ListFolder) -> Prepared:
    tree = Tree(binding.client)
    folder = await tree.get(data.folder_id)
    resource = await tree.resource(binding, folder)

    async def execute() -> ProviderOutput:
        folder = await tree.confirm(resource)
        if not folder.is_folder:
            raise OperationError("UNSUPPORTED_FILE", "This is not a folder.")
        if folder.capabilities and folder.capabilities.can_list_children is False:
            raise OperationError(
                "PROVIDER_FORBIDDEN", "Google Drive does not let this account list this folder."
            )
        page = await tree.client.files(
            f"{quoted(folder.id)} in parents and trashed = false",
            limit=data.limit,
            page_token=data.cursor,
            drive_id=folder.drive_id,
            order_by="folder,name",
        )
        within = (folder.id, *resource.within)
        records = [
            _record(binding.resource(FILE, child.id, within, resource.partial), child)
            # A child that does not name this folder as its only parent is not placed by this listing.
            for child in page.files
            if child.parents == [folder.id]
        ]
        return ProviderOutput(records, _next_cursor(page.next_page_token), page.incomplete_search)

    return Prepared([Need(resource, "read")], execute)


LIST_FOLDER = Operation(
    name="list_folder",
    title="List a folder",
    description=(
        'List the files and folders inside one Google Drive folder. Use "root" for My Drive. '
        "To get the next page, repeat the call with identical arguments plus the returned "
        "next_cursor. Items you may not read are left out."
    ),
    input_model=ListFolder,
    needs=((FILE, "read"),),
    prepare=_prepare_list_folder,
    consent=READ_CONSENT,
    paginated=True,
)


class SearchFiles(OperationInput):
    text: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_search_files(binding: Binding, data: SearchFiles) -> Prepared:
    tree = Tree(binding.client)

    async def execute() -> ProviderOutput:
        text = quoted(data.text)
        page = await tree.client.files(
            f"(name contains {text} or fullText contains {text}) and trashed = false",
            limit=data.limit,
            page_token=data.cursor,
            all_drives=True,
        )
        records = []
        for file in page.files:
            try:
                resource = await tree.resource(binding, file)
            except OperationError as error:
                if error.code != "UNSUPPORTED_FILE":
                    raise
                continue
            records.append(_record(resource, file))
        return ProviderOutput(records, _next_cursor(page.next_page_token), page.incomplete_search)

    return Prepared([Enumerate(FILE, "read")], execute)


SEARCH_FILES = Operation(
    name="search_files",
    title="Search files",
    description=(
        "Search Google Drive by words: Google matches names that contain words starting with the "
        "text, and content that contains its words. Only files you may read are returned. "
        "incomplete: true means Google did not search every shared drive."
    ),
    input_model=SearchFiles,
    needs=((FILE, "read"),),
    prepare=_prepare_search_files,
    consent=READ_CONSENT,
    paginated=True,
)


class GetFile(OperationInput):
    file_id: FileId


async def _prepare_get_file(binding: Binding, data: GetFile) -> Prepared:
    tree = Tree(binding.client)
    file = await tree.get(data.file_id)
    resource = await tree.resource(binding, file)

    async def execute() -> ProviderOutput:
        return ProviderOutput([_record(resource, file)])

    return Prepared([Need(resource, "read")], execute)


GET_FILE = Operation(
    name="get_file",
    title="Get file details",
    description="Read the details of one Google Drive file or folder by id.",
    input_model=GetFile,
    needs=((FILE, "read"),),
    prepare=_prepare_get_file,
    consent=READ_CONSENT,
)


class ReadFile(OperationInput):
    file_id: FileId
    max_chars: Annotated[int, Field(ge=1, le=100_000)] = 20_000


def _is_text(mime_type: str) -> bool:
    return mime_type.startswith("text/") or mime_type in TEXT_TYPES


async def _text(client: GoogleDriveClient, file: DriveFile) -> str:
    if file.mime_type == SHORTCUT:
        target = file.shortcut_details.target_id if file.shortcut_details else None
        raise OperationError(
            "UNSUPPORTED_FILE", f"This is a shortcut. Read its target instead: file id {target}."
        )
    if file.capabilities and file.capabilities.can_download is False:
        raise OperationError("PROVIDER_FORBIDDEN", "The owner of this file does not allow downloading it.")
    export = EXPORTS.get(file.mime_type)
    if export is not None:
        body = await client.export(file.id, export, limit=MAX_EXPORT_BYTES)
    elif _is_text(file.mime_type):
        if file.size and file.size.isdigit() and int(file.size) > MAX_TEXT_BYTES:
            raise OperationError("FILE_TOO_LARGE", f"Minerva reads text files up to {MAX_TEXT_BYTES} bytes.")
        body = await client.content(file.id, limit=MAX_TEXT_BYTES)
    else:
        raise OperationError(
            "UNSUPPORTED_FILE",
            "Minerva can read Google Docs, Sheets, Slides, and text files, not this type of file.",
        )
    return body.decode("utf-8", errors="replace")


async def _prepare_read_file(binding: Binding, data: ReadFile) -> Prepared:
    tree = Tree(binding.client)
    file = await tree.get(data.file_id)
    resource = await tree.resource(binding, file)

    async def execute() -> ProviderOutput:
        file = await tree.confirm(resource)
        text = await _text(tree.client, file)
        truncated = len(text) > data.max_chars
        return ProviderOutput([_record(resource, file, text=text[: data.max_chars], truncated=truncated)])

    return Prepared([Need(resource, "read")], execute)


READ_FILE = Operation(
    name="read_file",
    title="Read a file",
    description=(
        "Read the text of one Google Drive file: Google Docs and Slides as plain text, the first "
        "sheet of Google Sheets as CSV, and text files. Other types (PDF, images) are not "
        "supported. Long text is cut at max_chars and marked truncated."
    ),
    input_model=ReadFile,
    needs=((FILE, "read"),),
    prepare=_prepare_read_file,
    consent=READ_CONSENT,
)


class CreateFile(OperationInput):
    folder_id: FolderId
    name: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
    content: Annotated[str, Field(max_length=MAX_UPLOAD_BYTES), AfterValidator(_upload_size)]
    as_document: Annotated[
        bool, Field(description="Convert the text into a Google Doc instead of a plain text file.")
    ] = False


async def _prepare_create_file(binding: Binding, data: CreateFile) -> Prepared:
    tree = Tree(binding.client)
    folder = await tree.get(data.folder_id)
    resource = await tree.resource(binding, folder)

    async def execute() -> ProviderOutput:
        folder = await tree.confirm(resource)
        if not folder.is_folder:
            raise OperationError("UNSUPPORTED_FILE", "This is not a folder.")
        if folder.capabilities and folder.capabilities.can_add_children is False:
            raise OperationError(
                "PROVIDER_FORBIDDEN", "Google Drive does not let this account add files to this folder."
            )
        metadata: dict[str, Any] = {"name": data.name, "parents": [folder.id]}
        if data.as_document:
            metadata["mimeType"] = GOOGLE_DOC
        created = await tree.client.create(metadata, data.content.encode())
        within = (folder.id, *resource.within)
        return ProviderOutput(
            [_record(binding.resource(FILE, created.id, within, resource.partial), created)]
        )

    return Prepared([Need(resource, "create")], execute)


CREATE_FILE = Operation(
    name="create_file",
    title="Create a file",
    description=(
        "Create one text file, or a Google Doc with as_document, in a folder where you have "
        'create permission. Use "root" for My Drive. Everyone who can see the folder can see the '
        "file. The number of writes per run is limited."
    ),
    input_model=CreateFile,
    needs=((FILE, "create"),),
    prepare=_prepare_create_file,
    consent=CREATE_CONSENT,
    mutates=True,
)


def _discovery_state(cursor: str) -> dict[str, Any]:
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    if (
        not isinstance(state, dict)
        or set(state) != {"phase", "page"}
        or state["phase"] not in ("drives", "folders", "search")
        or not isinstance(state["page"], str | None)
    ):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return state


def _discovery_cursor(phase: str, page: str | None) -> str:
    return json.dumps({"phase": phase, "page": _next_cursor(page)})


def _browse_state(cursor: str, parent: str | None) -> dict[str, Any]:
    """A browsing cursor, valid only for the parent it was issued for."""
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    phases = ("drives", "shared") if parent is None else ("folders",)
    if (
        not isinstance(state, dict)
        or set(state) != {"phase", "page", "parent"}
        or state["phase"] not in phases
        or state["parent"] != parent
        or not isinstance(state["page"], str | None)
    ):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return state


def _browse_cursor(phase: str, page: str | None, parent: str | None) -> str:
    return json.dumps({"phase": phase, "page": _next_cursor(page), "parent": parent})


def _item(file: DriveFile) -> DiscoveryItem:
    return DiscoveryItem(file.id, f"{file.name}/" if file.is_folder else file.name)


class GoogleDriveConnector(Connector):
    slug = "google_drive"
    name = "Google Drive"
    kinds = (ResourceKind(FILE, "File", ("read", "create"), wildcard=True, hierarchical=True),)
    actions = (
        ActionSpec("read", "Read files"),
        ActionSpec("create", "Create files", requires="read"),
    )
    # Reading is enough to connect; the scope for creating files is asked for once the user allows it.
    auth = google_oauth(READ_SCOPE)

    operations = (LIST_FOLDER, SEARCH_FILES, GET_FILE, READ_FILE, CREATE_FILE)
    browsable = frozenset({FILE})

    def client(self, access_token: str) -> GoogleDriveClient:
        return GoogleDriveClient(access_token)

    async def account(self, client: GoogleDriveClient) -> Account:
        user = await client.user()
        return Account(id=user.sub, label=user.email or user.name or "Google")

    async def discover(
        self, client: GoogleDriveClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        state = _discovery_state(cursor) if cursor else None
        if query or (state and state["phase"] == "search"):
            if not query:
                raise OperationError("INVALID_CURSOR", "This page token is invalid.")
            page = await client.files(
                f"name contains {quoted(query)} and trashed = false",
                limit=100,
                page_token=state["page"] if state else None,
                all_drives=True,
                order_by="folder,name",
            )
            return DiscoveryPage(
                [_item(f) for f in page.files],
                _discovery_cursor("search", page.next_page_token) if page.next_page_token else None,
            )
        items: list[DiscoveryItem] = []
        if state is None:
            items.append(DiscoveryItem(await client.root_id(), "My Drive"))
            state = {"phase": "drives", "page": None}
        if state["phase"] == "drives":
            drives = await client.drives(state["page"])
            items.extend(DiscoveryItem(d.id, f"{d.name} (shared drive)") for d in drives.drives)
            if drives.next_page_token:
                return DiscoveryPage(items, _discovery_cursor("drives", drives.next_page_token))
            return DiscoveryPage(items, _discovery_cursor("folders", None))
        page = await client.files(
            f"mimeType = {quoted(FOLDER)} and trashed = false",
            limit=100,
            page_token=state["page"],
            all_drives=True,
            order_by="name",
        )
        items.extend(_item(f) for f in page.files)
        next_cursor = _discovery_cursor("folders", page.next_page_token) if page.next_page_token else None
        return DiscoveryPage(items, next_cursor)

    async def children(
        self, client: GoogleDriveClient, kind: str, parent: str | None, *, cursor: str | None
    ) -> DiscoveryPage:
        """Folders only: My Drive, shared drives and folders shared with the account at the top, then the
        folders inside each. Files are found by searching."""
        state = _browse_state(cursor, parent) if cursor else None
        if parent is None:
            items: list[DiscoveryItem] = []
            if state is None:
                items.append(DiscoveryItem(await client.root_id(), "My Drive", expandable=True))
                state = {"phase": "drives", "page": None}
            if state["phase"] == "drives":
                drives = await client.drives(state["page"])
                items.extend(
                    DiscoveryItem(d.id, f"{d.name} (shared drive)", expandable=True) for d in drives.drives
                )
                phase, token = (
                    ("drives", drives.next_page_token) if drives.next_page_token else ("shared", None)
                )
                return DiscoveryPage(items, _browse_cursor(phase, token, None))
            page = await client.files(
                f"sharedWithMe = true and mimeType = {quoted(FOLDER)} and trashed = false",
                limit=100,
                page_token=state["page"],
                order_by="name",
            )
            items.extend(
                DiscoveryItem(f.id, f"{f.name}/ (shared with you)", expandable=True) for f in page.files
            )
            token = page.next_page_token
            return DiscoveryPage(items, _browse_cursor("shared", token, None) if token else None)
        folder = await client.file(parent)
        if not folder.is_folder:
            raise OperationError("UNSUPPORTED_FILE", "This is not a folder.")
        if folder.capabilities and folder.capabilities.can_list_children is False:
            raise OperationError(
                "PROVIDER_FORBIDDEN", "Google Drive does not let this account list this folder."
            )
        page = await client.files(
            f"{quoted(folder.id)} in parents and mimeType = {quoted(FOLDER)} and trashed = false",
            limit=100,
            page_token=state["page"] if state else None,
            drive_id=folder.drive_id,
            order_by="name",
        )
        token = page.next_page_token
        return DiscoveryPage(
            [DiscoveryItem(f.id, _item(f).name, expandable=True) for f in page.files],
            _browse_cursor("folders", token, parent) if token else None,
        )

    async def describe(self, client: GoogleDriveClient, kind: str, ids: list[str]) -> dict[str, str]:
        root = await client.root_id()
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)

        async def name(file_id: str) -> str | None:
            if file_id == root:
                return "My Drive"
            async with limit:
                try:
                    file = await client.file(file_id)
                    if file.drive_id and file.id == file.drive_id:
                        return f"{(await client.drive(file.id)).name} (shared drive)"
                except OperationError as error:
                    if error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN"}:
                        return None
                    raise
            return _item(file).name

        names = await asyncio.gather(*(name(file_id) for file_id in ids))
        return {file_id: n for file_id, n in zip(ids, names, strict=True) if n is not None}
