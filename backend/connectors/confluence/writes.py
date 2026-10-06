"""Confluence's write operations: commenting on pages and creating them.

Each write reads its page (or the new page's parent) again just before sending, and refuses one that moved.
That cannot stop a move that lands between that read and the write; Confluence takes no condition on where a
page is.
"""

from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.atlassian import adf
from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
    denied,
)
from connectors.confluence.client import ConfluenceClient
from connectors.confluence.pages import (
    ID,
    SPACE,
    PageName,
    SiteId,
    SpaceName,
    confirm_page,
    hosts,
    link,
    resolve_page,
    resolve_space,
    space_resource,
)
from connectors.text import single_line

MAX_TITLE = 255
MAX_BODY = 50_000
MAX_COMMENT = 20_000

TEXT_DESCRIPTION = "Plain text, shown literally: no formatting, mentions or links to Atlassian."
Title = Annotated[
    str,
    Field(min_length=1, max_length=MAX_TITLE, description="The page's title, unique in its space."),
    AfterValidator(single_line),
    AfterValidator(adf.check_written),
]
BodyText = Annotated[
    str,
    Field(min_length=1, max_length=MAX_BODY, description=TEXT_DESCRIPTION),
    AfterValidator(adf.check_written),
]
CommentText = Annotated[
    str,
    Field(min_length=1, max_length=MAX_COMMENT, description=TEXT_DESCRIPTION),
    AfterValidator(adf.check_written),
]

WRITE_NOTE = (
    "Everyone who can view the space sees what you write, posted as the signed-in user; watchers are "
    "notified, and the space's automation rules in Confluence may make further changes."
)


class AddComment(OperationInput):
    site_id: SiteId | None = None
    page: PageName
    text: CommentText


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    site, resource, page = await resolve_page(binding, data.site_id, data.page)
    adf.check_hosts(data.text, hosts(await binding.client.sites()))

    async def execute() -> ProviderOutput:
        client: ConfluenceClient = binding.client
        await confirm_page(binding, site, resource, page.id)
        comment = await client.add_comment(site.id, page.id, adf.written(data.text))
        record = {
            "written": True,
            "id": comment.id,
            "page_id": page.id,
            "created": comment.version.created_at if comment.version else None,
            "link": link(site, page.id),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "comment")], execute)


ADD_COMMENT = Operation(
    name="add_comment",
    title="Comment on a page",
    description=(
        "Add a comment at the foot of a Confluence page in a space where you have comment permission. "
        + WRITE_NOTE
    ),
    input_model=AddComment,
    needs=((SPACE, "comment"),),
    prepare=_prepare_add_comment,
    consent=(frozenset({"write:comment:confluence"}),),
    mutates=True,
)


class CreatePage(OperationInput):
    site_id: SiteId | None = None
    space: SpaceName
    title: Title
    body: BodyText | None = None
    parent_page: Annotated[
        PageName | None,
        Field(
            description=(
                "The id of a page in the same space to put the new page under; without one, under the space's "
                "homepage."
            )
        ),
    ] = None


async def _prepare_create_page(binding: Binding, data: CreatePage) -> Prepared:
    site, resource, space = await resolve_space(binding, data.site_id, data.space)
    if data.parent_page is not None:
        # A parent elsewhere is refused like one the account cannot see: the authorization below is on this
        # space only, so a different answer would tell the agent where an unreadable page is not.
        _, parent_resource, _ = await resolve_page(binding, site.id, data.parent_page)
        if parent_resource.id != resource.id:
            raise denied()
    adf.check_hosts(f"{data.title}\n{data.body or ''}", hosts(await binding.client.sites()))

    async def execute() -> ProviderOutput:
        client: ConfluenceClient = binding.client
        if data.parent_page is not None:
            await confirm_page(binding, site, resource, data.parent_page)
        try:
            created = await client.create_page(
                site.id,
                space_id=space.id,
                title=data.title,
                parent_id=data.parent_page,
                adf=adf.written(data.body or ""),
            )
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED":
                raise OperationError(
                    "INVALID_ARGUMENTS",
                    "Confluence refused the page. A page with this title may already exist in the space.",
                ) from None
            raise
        if not ID.match(created.id):
            raise client.unexpected()
        # Automation can move a new page at once: the record names the space the page is in now.
        page = await client.page(site.id, created.id)
        if page.id != created.id:
            raise client.unexpected()
        record = {
            "written": True,
            "id": page.id,
            "site_id": site.id,
            "space_id": page.space_id,
            "link": link(site, page.id),
        }
        return ProviderOutput([ScopedRecord(space_resource(binding, site, page.space_id), record)])

    return Prepared([Need(resource, "create")], execute)


CREATE_PAGE = Operation(
    name="create_page",
    title="Create a page",
    description="Create a page in a Confluence space where you have create permission. " + WRITE_NOTE,
    input_model=CreatePage,
    needs=((SPACE, "create"),),
    prepare=_prepare_create_page,
    consent=(frozenset({"write:page:confluence"}),),
    mutates=True,
)
