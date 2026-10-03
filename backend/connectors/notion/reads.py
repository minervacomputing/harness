"""Notion's read operations: search, pages, databases and comments."""

from typing import Annotated, Any

from pydantic import AfterValidator, Field, ValidationError

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ScopedRecord,
)
from connectors.notion import markdown as page_text
from connectors.notion.client import Database, DataSource, Page
from connectors.notion.pages import (
    PAGE,
    ObjectId,
    Tree,
    canonical,
    comment_data,
    data_source,
    database_resource,
    json_size,
    page_record,
    page_resource,
    parent_id,
)
from connectors.notion.properties import check_filter, mentions_hidden, readable, schema
from connectors.text import no_controls

Cursor = Annotated[str, Field(max_length=1000)]


def _next_cursor(cursor: str | None, has_more: bool) -> str | None:
    if not has_more or not cursor:
        return None
    if len(cursor) > 1000:
        raise OperationError("PROVIDER_LIMIT", "Notion returned a page token that is too long.")
    return cursor


def _database_record(resource: Resource, database: Database, **extra: Any) -> ScopedRecord:
    return ScopedRecord(
        resource,
        {
            "id": resource.id,
            "type": "database",
            "title": database.name,
            "url": database.url,
            "parent_id": parent_id(resource),
            "in_trash": database.in_trash,
            # Names only once a source is known to be this database's own (see get_database): a linked
            # database lists another database's source, with its name.
            "data_sources": [{"id": s.id} for s in database.data_sources],
            **extra,
        },
    )


class Search(OperationInput):
    text: Annotated[str, Field(max_length=200), AfterValidator(no_controls)] | None = None
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
                    records.append(page_record(await tree.resource(binding, page), page))
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


SEARCH = Operation(
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
)


class PageInput(OperationInput):
    page_id: ObjectId


async def _prepare_get_page(binding: Binding, data: PageInput) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        return ProviderOutput([page_record(resource, page, properties=readable(page.properties))])

    return Prepared([Need(resource, "read")], execute)


GET_PAGE = Operation(
    name="get_page",
    title="Get page details",
    description="Read the title, properties and place of one Notion page by id or link.",
    input_model=PageInput,
    needs=((PAGE, "read"),),
    prepare=_prepare_get_page,
)


READ_TEXT_NOTE = (
    "Links to child pages and databases, and mentions of pages, appear without their titles (use get_page "
    "or get_database to see one you may read). Content synced from other pages is hidden."
)


class ReadPage(OperationInput):
    page_id: ObjectId
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0
    max_chars: Annotated[int, Field(ge=1, le=100_000)] = 20_000


async def _prepare_read_page(binding: Binding, data: ReadPage) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        body = await tree.client.markdown(resource.id)
        text = page_text.redact(body.markdown)
        end = data.offset + data.max_chars
        return ProviderOutput(
            [
                page_record(
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


READ_PAGE = Operation(
    name="read_page",
    title="Read a page",
    description=(
        "Read the content of one Notion page as Notion-flavored markdown, with its properties. Long "
        "pages are cut at max_chars and marked truncated; continue with offset. " + READ_TEXT_NOTE
    ),
    input_model=ReadPage,
    needs=((PAGE, "read"),),
    prepare=_prepare_read_page,
)


class DatabaseInput(OperationInput):
    database_id: ObjectId


async def _prepare_get_database(binding: Binding, data: DatabaseInput) -> Prepared:
    tree, resource = await database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        sources = []
        for ref in database.data_sources[:10]:
            try:
                source = await data_source(tree.client, database, canonical(ref.id))
            except OperationError as error:
                if error.code != "UNSUPPORTED_DATABASE":
                    raise
                sources.append({"id": ref.id, "linked_from_elsewhere": True})
                continue
            sources.append({"id": ref.id, "name": source.name, "properties": schema(source.properties)})
        return ProviderOutput([_database_record(resource, database, data_sources=sources)])

    return Prepared([Need(resource, "read")], execute)


GET_DATABASE = Operation(
    name="get_database",
    title="Get a database",
    description=(
        "Read a Notion database: its data sources and their properties, with the options of select "
        "and status properties. Properties marked hidden are never shown or used by Minerva."
    ),
    input_model=DatabaseInput,
    needs=((PAGE, "read"),),
    prepare=_prepare_get_database,
)


class QueryDatabase(OperationInput):
    database_id: ObjectId
    data_source_id: ObjectId | None = None
    filter: (
        Annotated[
            dict[str, Any],
            Field(description="A Notion data source query filter."),
            AfterValidator(json_size),
        ]
        | None
    ) = None
    sorts: (
        Annotated[
            list[dict[str, Any]],
            Field(max_length=10, description="Notion data source query sorts."),
            AfterValidator(json_size),
        ]
        | None
    ) = None
    limit: Annotated[int, Field(ge=1, le=100)] = 25
    cursor: Cursor | None = None


async def _prepare_query_database(binding: Binding, data: QueryDatabase) -> Prepared:
    tree, resource = await database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        source = await data_source(tree.client, database, data.data_source_id)
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
            records.append(page_record(row_resource, row, properties=readable(row.properties)))
        return ProviderOutput(records, _next_cursor(found.next_cursor, found.has_more), found.incomplete)

    return Prepared([Need(resource, "read")], execute)


QUERY_DATABASE = Operation(
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
)


class ListComments(OperationInput):
    page_id: ObjectId
    cursor: Cursor | None = None


async def _prepare_list_comments(binding: Binding, data: ListComments) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        await tree.confirm_page(resource)
        found = await tree.client.comments(resource.id, cursor=data.cursor)
        records = [
            ScopedRecord(resource, comment_data(c))
            for c in found.results
            if c.parent.type == "page_id" and canonical(c.parent.page_id) == resource.id
        ]
        return ProviderOutput(records, _next_cursor(found.next_cursor, found.has_more))

    return Prepared([Need(resource, "read")], execute)


LIST_COMMENTS = Operation(
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
)
