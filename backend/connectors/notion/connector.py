"""Notion. Resources are pages and databases; what is allowed on one covers everything inside it.

Notion itself decides which pages Minerva's integration can reach: the user picks them when connecting.
Within those, each call resolves where the pages it touches sit (their chain of parent pages and databases,
through any blocks in between) and hands that to the policy. Ancestry that cannot be resolved completely
(a parent Notion does not show, a limit reached) is marked partial, and the policy then treats it
conservatively. Ancestry is resolved again just before content is read or written: a call whose page moved
in between is refused.

Page text hides what belongs to other pages (see `markdown`), and database rows show only their own values
(see `properties`). What stays outside Minerva's reach: Notion automations, which may act on a row or page
an agent changed, and the integration's own capabilities, which the operator sets in Notion.
"""

import asyncio
import json
import re
from typing import Annotated, Any
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field, ValidationError

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
from connectors.notion import markdown as page_text
from connectors.notion.client import (
    Comment,
    Database,
    DataSource,
    NotionClient,
    Page,
    Parent,
    text_of,
)
from connectors.notion.properties import check_filter, mentions_hidden, readable, schema, writable

PAGE = "page"
MAX_DEPTH = 32
MAX_HOPS = 64
MAX_LOOKUPS = 150
DESCRIBE_CONCURRENCY = 8
MAX_MARKDOWN = 100_000
MAX_COMMENT = 2000
MAX_FILTER = 8000
MAX_PROPERTIES = 50

_UUID = re.compile(r"^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$", re.IGNORECASE)
_LINK_ID = re.compile(r"([0-9a-f]{32})$", re.IGNORECASE)
_CURSOR = re.compile(r"^[A-Za-z0-9_=-]{1,300}$")


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


def _no_controls(value: str) -> str:
    if any(ord(c) < 32 for c in value):
        raise ValueError("must not contain control characters")
    return value


def _no_nul(value: str) -> str:
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


def _json_size(value: Any) -> Any:
    if len(json.dumps(value)) > MAX_FILTER:
        raise ValueError(f"must be at most {MAX_FILTER} characters as JSON")
    return value


ObjectId = Annotated[
    str,
    Field(min_length=32, max_length=300, description="A Notion id, or a link to the page or database."),
    AfterValidator(_object_id),
]
Cursor = Annotated[str, Field(max_length=1000)]
Title = Annotated[str, Field(min_length=1, max_length=2000), AfterValidator(_no_controls)]
Markdown = Annotated[
    str,
    Field(min_length=1, max_length=MAX_MARKDOWN, description="Notion-flavored markdown."),
    AfterValidator(_no_nul),
    AfterValidator(page_text.check_written),
]
Properties = Annotated[
    dict[str, Any],
    Field(min_length=1, max_length=MAX_PROPERTIES),
    AfterValidator(_json_size),
]


def _denied() -> OperationError:
    return OperationError("POLICY_DENIED", DENIED)


def _moved() -> OperationError:
    return OperationError("PAGE_MOVED", "This page or database moved while Minerva was using it. Try again.")


def _next_cursor(cursor: str | None, has_more: bool) -> str | None:
    if not has_more or not cursor:
        return None
    if len(cursor) > 1000:
        raise OperationError("PROVIDER_LIMIT", "Notion returned a page token that is too long.")
    return cursor


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
        async def fetch(object_id: str) -> Any:
            return await self.client.block(object_id)

        block = await self._lookup(self._blocks, fetch, block_id)
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
                raise _denied() from None
            if error.code == "PROVIDER_REJECTED":
                raise OperationError(
                    "NOT_FOUND", "There is no page with this id. Databases have their own tools."
                ) from None
            raise
        if canonical(page.id) != page_id:
            raise _denied()
        self._pages[page_id] = page
        return page

    async def database(self, database_id: str) -> Database:
        try:
            database = await self.client.database(database_id)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise _denied() from None
            if error.code == "PROVIDER_REJECTED":
                raise OperationError(
                    "NOT_FOUND", "There is no database with this id. Pages have their own tools."
                ) from None
            raise
        if canonical(database.id) != database_id:
            raise _denied()
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
                raise _moved() from None
            raise
        within, partial = await fresh.place(obj)
        if (canonical(obj.id), within, partial) != (resource.id, resource.within, resource.partial):
            raise _moved()
        return obj

    async def confirm_page(self, resource: Resource) -> Page:
        """The page again, from Notion, refused if it moved since `resource` was authorized."""
        return await self._confirm(resource, self.client.page)

    async def confirm_database(self, resource: Resource) -> Database:
        return await self._confirm(resource, self.client.database)


def _parent_id(resource: Resource) -> str | None:
    return resource.within[0] if resource.within else None


def _page_data(resource: Resource, page: Page) -> dict[str, Any]:
    return {
        "id": resource.id,
        "type": "page",
        "title": page.title,
        "url": page.url,
        "parent_id": _parent_id(resource),
        "in_trash": page.in_trash,
        "created_time": page.created_time,
        "last_edited_time": page.last_edited_time,
    }


def _page_record(resource: Resource, page: Page, **extra: Any) -> ScopedRecord:
    return ScopedRecord(resource, {**_page_data(resource, page), **extra})


def _database_record(resource: Resource, database: Database, **extra: Any) -> ScopedRecord:
    return ScopedRecord(
        resource,
        {
            "id": resource.id,
            "type": "database",
            "title": database.name,
            "url": database.url,
            "parent_id": _parent_id(resource),
            "in_trash": database.in_trash,
            # Names only once a source is known to be this database's own (see get_database): a linked
            # database lists another database's source, with its name.
            "data_sources": [{"id": s.id} for s in database.data_sources],
            **extra,
        },
    )


async def _data_source(client: NotionClient, database: Database, requested: str | None) -> DataSource:
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


class Search(OperationInput):
    text: Annotated[str, Field(max_length=200), AfterValidator(_no_controls)] | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_search(binding: Binding, data: Search) -> Prepared:
    tree = Tree(binding.client)

    async def execute() -> ProviderOutput:
        found = await tree.client.search(data.text, limit=data.limit, cursor=data.cursor)
        records = []
        databases: set[str] = set()
        for item in found.results:
            try:
                if item.get("object") == "page":
                    page = Page.model_validate(item)
                    if canonical(page.id) is None:
                        continue
                    tree.remember(page)
                    records.append(_page_record(await tree.resource(binding, page), page))
                elif item.get("object") == "data_source":
                    source = DataSource.model_validate(item)
                    database_id = canonical(source.database_id)
                    if database_id is None or database_id in databases:
                        continue
                    databases.add(database_id)
                    database = await tree.known_database(database_id)
                    if database is not None:
                        records.append(_database_record(await tree.resource(binding, database), database))
            except ValidationError:
                continue
        return ProviderOutput(records, _next_cursor(found.next_cursor, found.has_more), found.incomplete)

    return Prepared([Enumerate(PAGE, "read")], execute)


class PageInput(OperationInput):
    page_id: ObjectId


async def _page_resource(binding: Binding, page_id: str) -> tuple[Tree, Resource]:
    tree = Tree(binding.client)
    page = await tree.page(page_id)
    return tree, await tree.resource(binding, page)


async def _database_resource(binding: Binding, database_id: str) -> tuple[Tree, Resource]:
    tree = Tree(binding.client)
    database = await tree.database(database_id)
    return tree, await tree.resource(binding, database)


async def _prepare_get_page(binding: Binding, data: PageInput) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        return ProviderOutput([_page_record(resource, page, properties=readable(page.properties))])

    return Prepared([Need(resource, "read")], execute)


class ReadPage(OperationInput):
    page_id: ObjectId
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0
    max_chars: Annotated[int, Field(ge=1, le=100_000)] = 20_000


async def _prepare_read_page(binding: Binding, data: ReadPage) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        body = await tree.client.markdown(resource.id)
        text = page_text.redact(body.markdown)
        end = data.offset + data.max_chars
        return ProviderOutput(
            [
                _page_record(
                    resource,
                    page,
                    properties=readable(page.properties),
                    text=text[data.offset : end],
                    offset=data.offset,
                    total_chars=len(text),
                    truncated=end < len(text) or body.truncated,
                    unreadable_blocks=len(body.unknown_block_ids),
                )
            ]
        )

    return Prepared([Need(resource, "read")], execute)


class DatabaseInput(OperationInput):
    database_id: ObjectId


async def _prepare_get_database(binding: Binding, data: DatabaseInput) -> Prepared:
    tree, resource = await _database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        sources = []
        for ref in database.data_sources[:10]:
            try:
                source = await _data_source(tree.client, database, canonical(ref.id))
            except OperationError as error:
                if error.code != "UNSUPPORTED_DATABASE":
                    raise
                sources.append({"id": ref.id, "linked_from_elsewhere": True})
                continue
            sources.append({"id": ref.id, "name": source.name, "properties": schema(source.properties)})
        return ProviderOutput([_database_record(resource, database, data_sources=sources)])

    return Prepared([Need(resource, "read")], execute)


class QueryDatabase(OperationInput):
    database_id: ObjectId
    data_source_id: ObjectId | None = None
    filter: (
        Annotated[
            dict[str, Any],
            Field(description="A Notion data source query filter."),
            AfterValidator(_json_size),
        ]
        | None
    ) = None
    sorts: (
        Annotated[
            list[dict[str, Any]],
            Field(max_length=10, description="Notion data source query sorts."),
            AfterValidator(_json_size),
        ]
        | None
    ) = None
    limit: Annotated[int, Field(ge=1, le=100)] = 25
    cursor: Cursor | None = None


async def _prepare_query_database(binding: Binding, data: QueryDatabase) -> Prepared:
    tree, resource = await _database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        source = await _data_source(tree.client, database, data.data_source_id)
        used = check_filter(source.properties, data.filter) | check_filter(source.properties, data.sorts)
        found = await tree.client.query(
            source.id, limit=data.limit, cursor=data.cursor, filter=data.filter, sorts=data.sorts
        )
        within = (resource.id, *resource.within)
        records = []
        for item in found.results:
            try:
                row = Page.model_validate(item)
            except ValidationError:
                continue
            row_id = canonical(row.id)
            # Only rows that sit in this data source, still in this database, are placed by this query.
            if (
                row_id is None
                or row.parent.type != "data_source_id"
                or canonical(row.parent.data_source_id) != canonical(source.id)
                or canonical(row.parent.database_id) != resource.id
            ):
                continue
            # Notion matches and sorts text by the titles of pages it mentions, which are not shown.
            if any(mentions_hidden(row.properties.get(name)) for name in used):
                continue
            row_resource = binding.resource(PAGE, row_id, within, resource.partial)
            records.append(_page_record(row_resource, row, properties=readable(row.properties)))
        return ProviderOutput(records, _next_cursor(found.next_cursor, found.has_more), found.incomplete)

    return Prepared([Need(resource, "read")], execute)


class ListComments(OperationInput):
    page_id: ObjectId
    cursor: Cursor | None = None


def _comment_data(comment: Comment) -> dict[str, Any]:
    return {
        "id": comment.id,
        "discussion_id": comment.discussion_id,
        "text": text_of(comment.rich_text),
        "created_time": comment.created_time,
        "author_id": comment.created_by.id if comment.created_by else None,
    }


async def _prepare_list_comments(binding: Binding, data: ListComments) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        await tree.confirm_page(resource)
        found = await tree.client.comments(resource.id, cursor=data.cursor)
        records = [
            ScopedRecord(resource, _comment_data(c))
            for c in found.results
            if c.parent.type == "page_id" and canonical(c.parent.page_id) == resource.id
        ]
        return ProviderOutput(records, _next_cursor(found.next_cursor, found.has_more))

    return Prepared([Need(resource, "read")], execute)


def _title(value: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": value}}]}


class CreatePage(OperationInput):
    parent_page_id: ObjectId
    title: Title
    markdown: Markdown | None = None


async def _prepare_create_page(binding: Binding, data: CreatePage) -> Prepared:
    tree, resource = await _page_resource(binding, data.parent_page_id)

    async def execute() -> ProviderOutput:
        await tree.confirm_page(resource)
        body: dict[str, Any] = {
            "parent": {"page_id": resource.id},
            "properties": {"title": _title(data.title)},
        }
        if data.markdown:
            body["markdown"] = data.markdown
        created = await tree.client.create_page(body)
        within = (resource.id, *resource.within)
        created_id = canonical(created.id) or created.id
        return ProviderOutput(
            [_page_record(binding.resource(PAGE, created_id, within, resource.partial), created)]
        )

    return Prepared([Need(resource, "create")], execute)


class CreateRow(OperationInput):
    database_id: ObjectId
    data_source_id: ObjectId | None = None
    properties: Properties
    markdown: Markdown | None = None


async def _prepare_create_row(binding: Binding, data: CreateRow) -> Prepared:
    tree, resource = await _database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        source = await _data_source(tree.client, database, data.data_source_id)
        body: dict[str, Any] = {
            "parent": {"data_source_id": source.id},
            "properties": writable(source.properties, data.properties),
        }
        if data.markdown:
            body["markdown"] = data.markdown
        created = await tree.client.create_page(body)
        within = (resource.id, *resource.within)
        created_id = canonical(created.id) or created.id
        row = binding.resource(PAGE, created_id, within, resource.partial)
        return ProviderOutput([_page_record(row, created, properties=readable(created.properties))])

    return Prepared([Need(resource, "create")], execute)


class UpdateProperties(OperationInput):
    page_id: ObjectId
    properties: Properties


async def _page_schema(tree: Tree, page: Page, resource: Resource) -> dict[str, dict[str, Any]]:
    """The properties a page may have: its data source's for a database row, else only its title."""
    parent = page.parent
    if parent.type not in {"data_source_id", "database_id"}:
        return page.properties
    database = await tree.client.database(resource.within[0]) if resource.within else None
    if database is None:
        raise _moved()
    requested = canonical(parent.data_source_id) if parent.type == "data_source_id" else None
    source = await _data_source(tree.client, database, requested)
    return source.properties


async def _prepare_update_properties(binding: Binding, data: UpdateProperties) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        properties = writable(await _page_schema(tree, page, resource), data.properties)
        updated = await tree.client.update_page(resource.id, {"properties": properties})
        return ProviderOutput([_page_record(resource, updated, properties=readable(updated.properties))])

    return Prepared([Need(resource, "edit")], execute)


class Edit(OperationInput):
    old: Annotated[
        str, Field(min_length=1, max_length=10_000, description="Text to replace, as read_page shows it.")
    ]
    new: Annotated[
        str,
        Field(max_length=MAX_MARKDOWN, description="Its replacement, in Notion-flavored markdown."),
        AfterValidator(_no_nul),
        AfterValidator(page_text.check_written),
    ]


class EditPage(OperationInput):
    page_id: ObjectId
    edits: Annotated[list[Edit], Field(min_length=1, max_length=20)]


async def _prepare_edit_page(binding: Binding, data: EditPage) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        body = await tree.client.markdown(resource.id)
        if body.truncated:
            raise OperationError("PAGE_TOO_LARGE", "This page is too long for Minerva to edit.")
        if page_text.shows_synced_content(body.markdown):
            raise OperationError(
                "UNSUPPORTED_PAGE",
                "This page shows synced content from another page. Minerva does not edit it.",
            )
        updates = page_text.plan_edits(body.markdown, [(e.old, e.new) for e in data.edits])
        # Never allowed to delete: Notion then refuses edits that would remove child pages or databases.
        try:
            await tree.client.update_markdown(
                resource.id,
                {
                    "type": "update_content",
                    "update_content": {"content_updates": updates, "allow_deleting_content": False},
                },
            )
        except OperationError as error:
            if error.code != "PROVIDER_REJECTED":
                raise
            raise OperationError(
                "EDIT_NOT_APPLIED",
                "Notion did not apply the edits: the page changed, or they would remove child pages or "
                "databases. Read the page and try again.",
            ) from None
        return ProviderOutput([_page_record(resource, page, edits=len(updates))])

    return Prepared([Need(resource, "edit")], execute)


class AppendToPage(OperationInput):
    page_id: ObjectId
    markdown: Markdown


async def _prepare_append(binding: Binding, data: AppendToPage) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        await tree.client.update_markdown(
            resource.id,
            {
                "type": "insert_content",
                "insert_content": {"content": data.markdown, "position": {"type": "end"}},
            },
        )
        return ProviderOutput([_page_record(resource, page)])

    return Prepared([Need(resource, "edit")], execute)


class AddComment(OperationInput):
    page_id: ObjectId
    text: Annotated[
        str,
        Field(min_length=1, max_length=MAX_COMMENT, description="Inline Notion-flavored markdown."),
        AfterValidator(_no_nul),
        AfterValidator(page_text.check_written),
    ]


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    tree, resource = await _page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        await tree.confirm_page(resource)
        comment = await tree.client.add_comment({"parent": {"page_id": resource.id}, "markdown": data.text})
        return ProviderOutput([ScopedRecord(resource, _comment_data(comment))])

    return Prepared([Need(resource, "comment")], execute)


def _discovery_cursor(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return cursor


READ_TEXT_NOTE = (
    "Links to child pages and databases, and mentions of pages, appear without their titles (use get_page "
    "or get_database to see one you may read). Content synced from other pages is hidden."
)
WRITE_TEXT_NOTE = (
    "Text is Notion-flavored markdown without images, embeds, media, child page or database tags, synced "
    "blocks, or mentions of people. The number of writes per run is limited."
)


class NotionConnector(Connector):
    slug = "notion"
    name = "Notion"
    kinds = (
        ResourceKind(
            PAGE,
            "Page or database",
            ("read", "comment", "create", "edit"),
            wildcard=True,
            hierarchical=True,
            note=(
                "What is allowed on a page or database also covers the pages inside it. Notion decides "
                "which pages Minerva can reach at all: they are chosen when connecting Notion, and "
                "connecting again changes them. Where Notion does not show where a page sits, blocking an "
                "action anywhere in this connection also blocks it there."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read pages"),
        ActionSpec("comment", "Comment on pages", requires="read"),
        ActionSpec("create", "Create pages", requires="read"),
        ActionSpec("edit", "Edit pages", requires="read"),
    )
    auth = OAuth2(
        app="notion",
        authorize_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",  # noqa: S106
        scopes=(),
        authorize_params=(("owner", "user"),),
        client_auth="basic",
        json_body=True,
        pkce=False,
    )

    operations = (
        Operation(
            name="search",
            title="Search pages",
            description=(
                "Search the Notion pages and databases you may read, by title. Without text, lists recently "
                "edited ones. To get the next page, repeat the call with identical arguments plus the "
                "returned next_cursor. incomplete: true means Notion did not search everything."
            ),
            input_model=Search,
            needs=((PAGE, "read"),),
            prepare=_prepare_search,
            paginated=True,
        ),
        Operation(
            name="get_page",
            title="Get page details",
            description="Read the title, properties and place of one Notion page by id or link.",
            input_model=PageInput,
            needs=((PAGE, "read"),),
            prepare=_prepare_get_page,
        ),
        Operation(
            name="read_page",
            title="Read a page",
            description=(
                "Read the content of one Notion page as Notion-flavored markdown, with its properties. Long "
                "pages are cut at max_chars and marked truncated; continue with offset. " + READ_TEXT_NOTE
            ),
            input_model=ReadPage,
            needs=((PAGE, "read"),),
            prepare=_prepare_read_page,
        ),
        Operation(
            name="get_database",
            title="Get a database",
            description=(
                "Read a Notion database: its data sources and their properties, with the options of select "
                "and status properties. Properties marked hidden are never shown or used by Minerva."
            ),
            input_model=DatabaseInput,
            needs=((PAGE, "read"),),
            prepare=_prepare_get_database,
        ),
        Operation(
            name="query_database",
            title="Query a database",
            description=(
                "List rows of a Notion database, optionally with a Notion filter and sorts on properties "
                "that are not hidden. A database with several data sources needs data_source_id. Rows you "
                "may not read are left out. To get the next page, repeat the call with identical arguments "
                "plus the returned next_cursor."
            ),
            input_model=QueryDatabase,
            needs=((PAGE, "read"),),
            prepare=_prepare_query_database,
            paginated=True,
        ),
        Operation(
            name="list_comments",
            title="List comments",
            description=(
                "List the open comments on a Notion page itself (not comments on text inside it). To get "
                "the next page, repeat the call with identical arguments plus the returned next_cursor."
            ),
            input_model=ListComments,
            needs=((PAGE, "read"),),
            prepare=_prepare_list_comments,
            paginated=True,
        ),
        Operation(
            name="create_page",
            title="Create a page",
            description=(
                "Create a Notion page inside a page where you have create permission, with a title and "
                "optional content. Everyone who can see the parent page can see it. " + WRITE_TEXT_NOTE
            ),
            input_model=CreatePage,
            needs=((PAGE, "create"),),
            prepare=_prepare_create_page,
            mutates=True,
        ),
        Operation(
            name="create_database_row",
            title="Add a database row",
            description=(
                "Add a row to a Notion database where you have create permission. properties maps property "
                'names to values: text, numbers, true/false, dates ("2026-10-01" or {"start", "end"}), and '
                "existing select, multi-select and status options (see get_database). Relations, people, "
                "files and computed properties cannot be set. Notion automations on the database may make "
                "further changes. " + WRITE_TEXT_NOTE
            ),
            input_model=CreateRow,
            needs=((PAGE, "create"),),
            prepare=_prepare_create_row,
            mutates=True,
        ),
        Operation(
            name="update_page_properties",
            title="Update page properties",
            description=(
                "Change properties of a Notion page where you have edit permission, with values as for "
                "create_database_row. A page outside a database has only its title. Notion automations may "
                "make further changes. The number of writes per run is limited."
            ),
            input_model=UpdateProperties,
            needs=((PAGE, "edit"),),
            prepare=_prepare_update_properties,
            mutates=True,
        ),
        Operation(
            name="edit_page",
            title="Edit a page",
            description=(
                "Replace text in a Notion page where you have edit permission. Each old text must appear "
                "exactly once in the page as read_page shows it; lines linking to child pages, databases or "
                "mentioned pages cannot be edited, and nothing can be deleted along with child pages. "
                + WRITE_TEXT_NOTE
            ),
            input_model=EditPage,
            needs=((PAGE, "edit"),),
            prepare=_prepare_edit_page,
            mutates=True,
        ),
        Operation(
            name="append_to_page",
            title="Append to a page",
            description=(
                "Add content at the end of a Notion page where you have edit permission. " + WRITE_TEXT_NOTE
            ),
            input_model=AppendToPage,
            needs=((PAGE, "edit"),),
            prepare=_prepare_append,
            mutates=True,
        ),
        Operation(
            name="add_comment",
            title="Add a comment",
            description=(
                "Comment on a Notion page where you have comment permission. People following the page may "
                "be notified. " + WRITE_TEXT_NOTE
            ),
            input_model=AddComment,
            needs=((PAGE, "comment"),),
            prepare=_prepare_add_comment,
            mutates=True,
        ),
    )

    def client(self, access_token: str) -> NotionClient:
        return NotionClient(access_token)

    async def account(self, client: NotionClient) -> Account:
        # The workspace is what the connection reaches; the bot id may change when the user reconnects.
        me = await client.me()
        workspace_id = canonical(me.bot.workspace_id) if me.bot else None
        if workspace_id is None:
            raise OperationError("PROVIDER_FAILED", "Notion did not say which workspace was connected.")
        return Account(id=workspace_id, label=(me.bot.workspace_name if me.bot else None) or "Notion")

    async def discover(
        self, client: NotionClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        found = await client.search(query or None, limit=100, cursor=_discovery_cursor(cursor))
        items: list[DiscoveryItem] = []
        seen: set[str] = set()
        for item in found.results:
            try:
                if item.get("object") == "page":
                    page = Page.model_validate(item)
                    object_id, name = canonical(page.id), page.title or "Untitled"
                elif item.get("object") == "data_source":
                    source = DataSource.model_validate(item)
                    object_id, name = canonical(source.database_id), f"{source.name or 'Untitled'} (database)"
                else:
                    continue
            except ValidationError:
                continue
            if object_id is not None and object_id not in seen:
                seen.add(object_id)
                items.append(DiscoveryItem(object_id, name))
        next_cursor = found.next_cursor if found.has_more else None
        return DiscoveryPage(items, _discovery_cursor(next_cursor))

    async def describe(self, client: NotionClient, kind: str, ids: list[str]) -> dict[str, str]:
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)
        hidden = {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"}

        async def name(object_id: str) -> str | None:
            if canonical(object_id) != object_id:
                return None
            async with limit:
                try:
                    return (await client.page(object_id)).title or "Untitled"
                except OperationError as error:
                    if error.code not in hidden:
                        raise
                try:
                    return f"{(await client.database(object_id)).name or 'Untitled'} (database)"
                except OperationError as error:
                    if error.code not in hidden:
                        raise
            return None

        names = await asyncio.gather(*(name(object_id) for object_id in ids))
        return {object_id: n for object_id, n in zip(ids, names, strict=True) if n is not None}
