"""What Notion's operations share: ids, where pages and databases sit, and how they are shown."""

import json
import re
from typing import Annotated, Any
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError, Resource, ScopedRecord, denied
from connectors.notion.client import Comment, Database, DataSource, NotionClient, Page, Parent, text_of

PAGE = "page"
MAX_DEPTH = 32
MAX_HOPS = 64
MAX_LOOKUPS = 150
MAX_FILTER = 8000

_UUID = re.compile(r"\A[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\Z", re.IGNORECASE)
_LINK_ID = re.compile(r"([0-9a-f]{32})$", re.IGNORECASE)


def canonical(value: Any) -> str | None:
    """A Notion id as a lowercase UUID with dashes, or None when it is not one."""
    if not isinstance(value, str) or not _UUID.match(value):
        return None
    h = value.replace("-", "").lower()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _notion_host(host: str) -> bool:
    return host in {"notion.so", "www.notion.so", "notion.site"} or host.endswith(".notion.site")


def _object_id(value: str) -> str:
    if found := canonical(value):
        return found
    try:
        link = urlsplit(value)
    except ValueError:
        link = None
    if link is not None and link.scheme == "https" and _notion_host((link.hostname or "").lower()):
        segment = link.path.rstrip("/").rsplit("/", 1)[-1]
        if (match := _LINK_ID.search(segment)) and (found := canonical(match[1])):
            return found
    raise ValueError("must be a Notion id, or a link to a Notion page or database")


def json_size(value: Any) -> Any:
    if len(json.dumps(value)) > MAX_FILTER:
        raise ValueError(f"must be at most {MAX_FILTER} characters as JSON")
    return value


ObjectId = Annotated[
    str,
    Field(min_length=32, max_length=300, description="A Notion id, or a link to the page or database."),
    AfterValidator(_object_id),
]


def moved() -> OperationError:
    return OperationError("PAGE_MOVED", "This page or database moved while Minerva was using it. Try again.")


class Tree:
    """Where pages and databases sit, resolved for one call. Lookups are cached and limited."""

    def __init__(self, client: NotionClient) -> None:
        self.client = client
        self._pages: dict[str, Page | None] = {}
        self._databases: dict[str, Database | None] = {}
        self._sources: dict[str, DataSource | None] = {}
        self._blocks: dict[str, Parent | None] = {}
        self._lookups = 0

    async def _lookup(self, cache: dict[str, Any], fetch: Any, object_id: str) -> Any:
        """None when Notion does not show the object, or the call looked up too many."""
        if object_id in cache:
            return cache[object_id]
        if self._lookups >= MAX_LOOKUPS:
            return None
        self._lookups += 1
        try:
            found = await fetch(object_id)
        except OperationError as error:
            if error.code not in {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"}:
                raise
            found = None
        if found is not None and canonical(found.id) != object_id:
            found = None
        cache[object_id] = found
        return found

    async def _block_parent(self, block_id: str) -> Parent | None:
        block = await self._lookup(self._blocks, self.client.block, block_id)
        return block.parent if block is not None else None

    def remember(self, page: Page) -> None:
        if page_id := canonical(page.id):
            self._pages.setdefault(page_id, page)

    async def page(self, page_id: str) -> Page:
        """A page the call names. Pages Notion does not show are refused like pages without a grant."""
        try:
            page = await self.client.page(page_id)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            if error.code == "PROVIDER_REJECTED":
                raise OperationError(
                    "NOT_FOUND", "There is no page with this id. Databases have their own tools."
                ) from None
            raise
        if canonical(page.id) != page_id:
            raise denied()
        self._pages[page_id] = page
        return page

    async def database(self, database_id: str) -> Database:
        try:
            database = await self.client.database(database_id)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            if error.code == "PROVIDER_REJECTED":
                raise OperationError(
                    "NOT_FOUND", "There is no database with this id. Pages have their own tools."
                ) from None
            raise
        if canonical(database.id) != database_id:
            raise denied()
        self._databases[database_id] = database
        return database

    async def known_database(self, database_id: str) -> Database | None:
        return await self._lookup(self._databases, self.client.database, database_id)

    async def place(self, obj: Page | Database) -> tuple[tuple[str, ...], bool]:
        """The object's ancestors (pages and databases), nearest first, and whether the chain is partial."""
        within: list[str] = []
        seen = {canonical(obj.id)}
        current = obj.parent
        for _ in range(MAX_HOPS):
            match current.type:
                case "workspace":
                    return tuple(within), False
                case "block_id":
                    block_id = canonical(current.block_id)
                    if block_id is None or block_id in seen:
                        return tuple(within), True
                    seen.add(block_id)
                    parent = await self._block_parent(block_id)
                    if parent is None:
                        return tuple(within), True
                    current = parent
                    continue
                case "page_id":
                    next_id = canonical(current.page_id)
                    cache, fetch = self._pages, self.client.page
                case "database_id" | "data_source_id":
                    next_id = canonical(current.database_id)
                    if next_id is None and current.type == "data_source_id":
                        next_id = await self._source_database(current.data_source_id)
                    cache, fetch = self._databases, self.client.database
                case _:
                    return tuple(within), True
            if next_id is None or next_id in seen or len(within) >= MAX_DEPTH:
                return tuple(within), True
            seen.add(next_id)
            within.append(next_id)
            found = await self._lookup(cache, fetch, next_id)
            if found is None:
                return tuple(within), True
            current = found.parent
        return tuple(within), True

    async def _source_database(self, data_source_id: str | None) -> str | None:
        source_id = canonical(data_source_id)
        if source_id is None:
            return None
        source = await self._lookup(self._sources, self.client.data_source, source_id)
        return canonical(source.database_id) if source is not None else None

    async def resource(self, binding: Binding, obj: Page | Database) -> Resource:
        within, partial = await self.place(obj)
        return binding.resource(PAGE, canonical(obj.id) or obj.id, within, partial)

    async def _confirm(self, resource: Resource, fetch: Any) -> Any:
        fresh = Tree(self.client)
        try:
            obj = await fetch(resource.id)
        except OperationError as error:
            if error.code in {"NOT_FOUND", "PROVIDER_REJECTED"}:
                raise moved() from None
            raise
        within, partial = await fresh.place(obj)
        if (canonical(obj.id), within, partial) != (resource.id, resource.within, resource.partial):
            raise moved()
        return obj

    async def confirm_page(self, resource: Resource) -> Page:
        """The page again, from Notion, refused if it moved since `resource` was authorized."""
        return await self._confirm(resource, self.client.page)

    async def confirm_database(self, resource: Resource) -> Database:
        return await self._confirm(resource, self.client.database)


def parent_id(resource: Resource) -> str | None:
    return resource.within[0] if resource.within else None


def _page_data(resource: Resource, page: Page) -> dict[str, Any]:
    return {
        "id": resource.id,
        "type": "page",
        "title": page.title,
        "url": page.url,
        "parent_id": parent_id(resource),
        "in_trash": page.in_trash,
        "created_time": page.created_time,
        "last_edited_time": page.last_edited_time,
    }


def page_record(resource: Resource, page: Page, **extra: Any) -> ScopedRecord:
    return ScopedRecord(resource, {**_page_data(resource, page), **extra})


async def data_source(client: NotionClient, database: Database, requested: str | None) -> DataSource:
    """The database's data source the call uses, which must belong to this database itself."""
    sources = {canonical(s.id): s for s in database.data_sources}
    if requested is not None:
        if requested not in sources:
            raise OperationError("INVALID_ARGUMENTS", "This database has no data source with that id.")
        chosen = requested
    elif len(sources) == 1:
        [chosen] = sources
    else:
        raise OperationError(
            "INVALID_ARGUMENTS",
            f"This database has several data sources; pass data_source_id: {', '.join(map(str, sources))}.",
        )
    if chosen is None:
        raise OperationError("PROVIDER_FAILED", "Notion returned an unexpected response.")
    source = await client.data_source(chosen)
    # A linked database shows a data source that belongs to another database, which grants on this one
    # do not cover.
    if canonical(source.id) != chosen or canonical(source.database_id) != canonical(database.id):
        raise OperationError(
            "UNSUPPORTED_DATABASE",
            "This database shows data from another database. Use the original database instead.",
        )
    return source


async def page_resource(binding: Binding, page_id: str) -> tuple[Tree, Resource]:
    tree = Tree(binding.client)
    page = await tree.page(page_id)
    return tree, await tree.resource(binding, page)


async def database_resource(binding: Binding, database_id: str) -> tuple[Tree, Resource]:
    tree = Tree(binding.client)
    database = await tree.database(database_id)
    return tree, await tree.resource(binding, database)


def comment_data(comment: Comment) -> dict[str, Any]:
    return {
        "id": comment.id,
        "discussion_id": comment.discussion_id,
        "text": text_of(comment.rich_text),
        "created_time": comment.created_time,
        "author_id": comment.created_by.id if comment.created_by else None,
    }
