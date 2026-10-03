"""What Confluence's operations share: sites, space and page names, and where pages sit."""

import re
from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.atlassian import CLOUD_ID, Site
from connectors.base import Binding, OperationError, Resource, denied
from connectors.confluence.client import ConfluenceClient, Page, Space

SPACE = "space"
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN"})

ID = re.compile(r"^\d{1,18}$")
# Ids as calls give them: written as Confluence writes them, so another spelling cannot tell an existing
# space from a missing one.
CANONICAL_ID = re.compile(r"^[1-9]\d{0,17}$")
SPACE_KEY = re.compile(r"^~?[A-Za-z0-9_:-]{1,255}$")


def _site_id(value: str) -> str:
    folded = value.lower()
    if not CLOUD_ID.match(folded):
        raise ValueError("must be a site id from list_spaces")
    return folded


def _space_name(value: str) -> str:
    if CANONICAL_ID.match(value) or (SPACE_KEY.match(value) and not value.isdigit()):
        return value
    raise ValueError('must be a space key such as "ENG", or a space id')


def _page_name(value: str) -> str:
    if CANONICAL_ID.match(value):
        return value
    raise ValueError("must be a page id")


SiteId = Annotated[
    str,
    Field(
        min_length=36,
        max_length=36,
        description="The site's id, from list_spaces. Needed only when the connection reaches several sites.",
    ),
    AfterValidator(_site_id),
]
SpaceName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=256,
        description='A space key such as "ENG" (keys are case-sensitive), or a space id. Digits alone are an id.',
    ),
    AfterValidator(_space_name),
]
PageName = Annotated[
    str,
    Field(min_length=1, max_length=18, description="A page id, from search_pages or a page's link."),
    AfterValidator(_page_name),
]


def unseen(error: OperationError) -> bool:
    return error.code in HIDDEN


def page_moved() -> OperationError:
    return OperationError(
        "PAGE_MOVED",
        "This page moved in Confluence while Minerva was using it, or access was lost. Try again.",
    )


def space_id(site: Site, space: str) -> str:
    return f"{site.id}/{space}"


def space_resource(binding: Binding, site: Site, space: str | None) -> Resource:
    """The resource of a space Confluence named. A malformed id fails rather than being guessed."""
    if space is None or not ID.match(space):
        raise binding.client.unexpected()
    return binding.resource(SPACE, space_id(site, space), (site.id,))


def hosts(sites: list[Site]) -> list[str]:
    """The hosts of the connection's sites, whose addresses text hides as links to Atlassian."""
    return [site.host for site in sites if site.host]


async def resolve_space(binding: Binding, site_id: str | None, name: str) -> tuple[Site, Resource, Space]:
    """The space a call names, by id or key. One the account cannot see is refused like one without a
    grant."""
    client: ConfluenceClient = binding.client
    site = await client.site(site_id)
    if ID.match(name):
        try:
            space = await client.space(site.id, name)
        except OperationError as error:
            if unseen(error):
                raise denied() from None
            raise
        if space.id != name:
            raise client.unexpected()
    else:
        # Keys are matched exactly: Confluence's filter is case-sensitive, and only a space whose key is the
        # one asked for counts.
        found = [s for s in await client.spaces_by(site.id, "keys", [name]) if s.key == name]
        if len(found) != 1:
            raise denied()
        space = found[0]
    return site, space_resource(binding, site, space.id), space


async def resolve_page(binding: Binding, site_id: str | None, name: str) -> tuple[Site, Resource, Page]:
    """The page a call names and the space it is in now. Drafts, archived and trashed pages, and pages the
    account cannot see, are refused like pages without a grant."""
    client: ConfluenceClient = binding.client
    site = await client.site(site_id)
    try:
        page = await client.page(site.id, name)
    except OperationError as error:
        if unseen(error):
            raise denied() from None
        raise
    if page.id != name or page.status != "current":
        raise denied()
    return site, space_resource(binding, site, page.space_id), page


async def confirm_page(
    binding: Binding, site: Site, resource: Resource, page_id: str, *, body: bool = False
) -> Page:
    """The page read again by id, refused unless it is current and still in the space it was authorized in."""
    client: ConfluenceClient = binding.client
    try:
        page = await client.page(site.id, page_id, body=body)
    except OperationError as error:
        if unseen(error):
            raise page_moved() from None
        raise
    if page.id != page_id or page.status != "current" or page.space_id is None:
        raise page_moved()
    if space_id(site, page.space_id) != resource.id:
        raise page_moved()
    return page


def link(site: Site, page_id: str) -> str | None:
    return f"https://{site.host}/wiki/pages/viewpage.action?pageId={page_id}" if site.host else None
