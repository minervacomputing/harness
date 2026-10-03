"""Notion's write operations: creating and editing pages and rows, and commenting."""

from typing import Annotated, Any

from pydantic import AfterValidator, Field

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
from connectors.notion import markdown as page_text
from connectors.notion.client import Page
from connectors.notion.pages import (
    PAGE,
    ObjectId,
    Tree,
    canonical,
    comment_data,
    data_source,
    database_resource,
    json_size,
    moved,
    no_controls,
    page_record,
    page_resource,
)
from connectors.notion.properties import readable, writable

MAX_MARKDOWN = 100_000
MAX_COMMENT = 2000
MAX_PROPERTIES = 50


def _no_nul(value: str) -> str:
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


Title = Annotated[str, Field(min_length=1, max_length=2000), AfterValidator(no_controls)]
Markdown = Annotated[
    str,
    Field(min_length=1, max_length=MAX_MARKDOWN, description="Notion-flavored markdown."),
    AfterValidator(_no_nul),
    AfterValidator(page_text.check_written),
]
Properties = Annotated[
    dict[str, Any],
    Field(min_length=1, max_length=MAX_PROPERTIES),
    AfterValidator(json_size),
]


WRITE_TEXT_NOTE = (
    "Text is Notion-flavored markdown without images, embeds, media, child page or database tags, synced "
    "blocks, or mentions of people. The number of writes per run is limited."
)


def _title(value: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": value}}]}


class CreatePage(OperationInput):
    parent_page_id: ObjectId
    title: Title
    markdown: Markdown | None = None


async def _prepare_create_page(binding: Binding, data: CreatePage) -> Prepared:
    tree, resource = await page_resource(binding, data.parent_page_id)

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
            [page_record(binding.resource(PAGE, created_id, within, resource.partial), created)]
        )

    return Prepared([Need(resource, "create")], execute)


CREATE_PAGE = Operation(
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
)


class CreateRow(OperationInput):
    database_id: ObjectId
    data_source_id: ObjectId | None = None
    properties: Properties
    markdown: Markdown | None = None


async def _prepare_create_row(binding: Binding, data: CreateRow) -> Prepared:
    tree, resource = await database_resource(binding, data.database_id)

    async def execute() -> ProviderOutput:
        database = await tree.confirm_database(resource)
        source = await data_source(tree.client, database, data.data_source_id)
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
        return ProviderOutput([page_record(row, created, properties=readable(created.properties))])

    return Prepared([Need(resource, "create")], execute)


CREATE_DATABASE_ROW = Operation(
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
)


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
        raise moved()
    requested = canonical(parent.data_source_id) if parent.type == "data_source_id" else None
    source = await data_source(tree.client, database, requested)
    return source.properties


async def _prepare_update_properties(binding: Binding, data: UpdateProperties) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        properties = writable(await _page_schema(tree, page, resource), data.properties)
        updated = await tree.client.update_page(resource.id, {"properties": properties})
        return ProviderOutput([page_record(resource, updated, properties=readable(updated.properties))])

    return Prepared([Need(resource, "edit")], execute)


UPDATE_PAGE_PROPERTIES = Operation(
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
)


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
    tree, resource = await page_resource(binding, data.page_id)

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
        return ProviderOutput([page_record(resource, page, edits=len(updates))])

    return Prepared([Need(resource, "edit")], execute)


EDIT_PAGE = Operation(
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
)


class AppendToPage(OperationInput):
    page_id: ObjectId
    markdown: Markdown


async def _prepare_append(binding: Binding, data: AppendToPage) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        page = await tree.confirm_page(resource)
        await tree.client.update_markdown(
            resource.id,
            {
                "type": "insert_content",
                "insert_content": {"content": data.markdown, "position": {"type": "end"}},
            },
        )
        return ProviderOutput([page_record(resource, page)])

    return Prepared([Need(resource, "edit")], execute)


APPEND_TO_PAGE = Operation(
    name="append_to_page",
    title="Append to a page",
    description=(
        "Add content at the end of a Notion page where you have edit permission. " + WRITE_TEXT_NOTE
    ),
    input_model=AppendToPage,
    needs=((PAGE, "edit"),),
    prepare=_prepare_append,
    mutates=True,
)


class AddComment(OperationInput):
    page_id: ObjectId
    text: Annotated[
        str,
        Field(min_length=1, max_length=MAX_COMMENT, description="Inline Notion-flavored markdown."),
        AfterValidator(_no_nul),
        AfterValidator(page_text.check_written),
    ]


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    tree, resource = await page_resource(binding, data.page_id)

    async def execute() -> ProviderOutput:
        await tree.confirm_page(resource)
        comment = await tree.client.add_comment({"parent": {"page_id": resource.id}, "markdown": data.text})
        return ProviderOutput([ScopedRecord(resource, comment_data(comment))])

    return Prepared([Need(resource, "comment")], execute)


ADD_COMMENT = Operation(
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
)
