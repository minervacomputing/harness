"""Confluence's read operations: spaces, page search and single pages."""

import re
from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.atlassian import Site, adf
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
from connectors.confluence.client import Comment, ConfluenceClient, Page, Space, document
from connectors.confluence.pages import (
    ID,
    SPACE,
    SPACE_KEY,
    PageName,
    SiteId,
    SpaceName,
    confirm_page,
    hosts,
    link,
    resolve_page,
    resolve_space,
    space_id,
    space_resource,
)
from connectors.text import single_line, truncate

MAX_SPACE_PAGES = 20
SPACE_PAGE = 50
MAX_SEARCH_WORDS = 8
MAX_BODY = 20_000
MAX_COMMENT = 4_000
MAX_COMMENTS = 30
MAX_SHORT = 500

Cursor = Annotated[str, Field(max_length=1000)]
_WORD = re.compile(r"\w+")


def short(value: str | None, site_hosts: list[str]) -> str | None:
    shown, _ = truncate(adf.redact(value, site_hosts) if value else None, MAX_SHORT)
    return shown or None


def _space_data(site: Site, space: Space, site_hosts: list[str]) -> dict[str, Any]:
    return {
        "id": space.id,
        "site_id": site.id,
        "site": site.label,
        "key": space.key,
        "name": short(space.name, site_hosts),
        "type": space.type,
        "status": space.status,
    }


class ListSpaces(OperationInput):
    site_id: Annotated[SiteId | None, Field(description="A site's id; without one, every site.")] = None


async def _prepare_list_spaces(binding: Binding, data: ListSpaces) -> Prepared:
    async def execute() -> ProviderOutput:
        client: ConfluenceClient = binding.client
        sites = [await client.site(data.site_id)] if data.site_id else await client.sites()
        site_hosts = hosts(await client.sites())
        records: list[ScopedRecord] = []
        incomplete = False
        for site in sites:
            token: str | None = None
            seen: set[str] = set()
            for _ in range(MAX_SPACE_PAGES):
                spaces, token = await client.spaces(site.id, limit=SPACE_PAGE, cursor=token)
                records += [
                    ScopedRecord(space_resource(binding, site, s.id), _space_data(site, s, site_hosts))
                    for s in spaces
                ]
                if token is None:
                    break
                if token in seen:
                    raise client.unexpected()
                seen.add(token)
            incomplete = incomplete or token is not None
        return ProviderOutput(records, incomplete=incomplete)

    return Prepared([Enumerate(SPACE, "read")], execute)


LIST_SPACES = Operation(
    name="list_spaces",
    title="List spaces",
    description="List the Confluence spaces you may read, with the site each is on.",
    input_model=ListSpaces,
    needs=((SPACE, "read"),),
    prepare=_prepare_list_spaces,
)


def _search_words(text: str) -> str:
    words = _WORD.findall(text)[:MAX_SEARCH_WORDS]
    if not words:
        raise OperationError("INVALID_ARGUMENTS", "text must contain letters or digits.")
    return " ".join(words)


SearchText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        description="Words to find in page titles (page bodies are not searched).",
    ),
    AfterValidator(single_line),
]


class SearchPages(OperationInput):
    site_id: SiteId | None = None
    space: SpaceName
    text: SearchText | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Cursor | None = None


def _updated(page: Page) -> str | None:
    return page.version.created_at if page.version else None


async def _prepare_search_pages(binding: Binding, data: SearchPages) -> Prepared:
    site, resource, space = await resolve_space(binding, data.site_id, data.space)

    async def execute() -> ProviderOutput:
        client: ConfluenceClient = binding.client
        if not SPACE_KEY.match(space.key):
            raise client.unexpected()
        # The query is built from fields, never taken from the agent: CQL can select pages by their relations
        # to content elsewhere. Titles only: text search also matches bodies, whose links can carry titles of
        # pages the agent may not read.
        clauses = ["type = page", f'space = "{space.key}"']
        if data.text is not None:
            clauses.append(f'title ~ "{_search_words(data.text)}"')
        cql = " AND ".join(clauses) + " ORDER BY lastmodified DESC"
        try:
            ids, cursor = await client.search(site.id, cql, limit=data.limit, cursor=data.cursor)
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED":
                raise OperationError("INVALID_ARGUMENTS", "Confluence could not run this search.") from None
            raise
        # Search reads an index that can lag behind moves: each page is read again, and shown under the space
        # it is in now. What the index returned beside the id (titles, excerpts, breadcrumbs) is not used.
        ids = list(dict.fromkeys(i for i in ids if ID.match(i)))
        pages = await client.pages(site.id, ids) if ids else []
        site_hosts = hosts(await client.sites())
        records = []
        for page in pages:
            if page.status != "current" or page.space_id is None or not ID.match(page.space_id):
                continue
            record = {
                "id": page.id,
                "site_id": site.id,
                "space_id": page.space_id,
                "title": short(page.title, site_hosts),
                "updated": _updated(page),
                "link": link(site, page.id),
            }
            records.append(ScopedRecord(space_resource(binding, site, page.space_id), record))
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], execute)


SEARCH_PAGES = Operation(
    name="search_pages",
    title="Search pages",
    description=(
        "Find a space's pages, most recently changed first, by words in the title. To get the next page, "
        "repeat the call with identical arguments plus the returned next_cursor."
    ),
    input_model=SearchPages,
    needs=((SPACE, "read"),),
    prepare=_prepare_search_pages,
    paginated=True,
)


READ_NOTE = (
    "Links to Atlassian appear without their titles, and macros without their content. Only the latest "
    "top-level footer comments are shown: not replies or inline comments."
)


def _comment(comment: Comment, site_hosts: list[str]) -> dict[str, Any]:
    """A comment; its text is null when Confluence sent none that could be read."""
    found = document(comment.body)
    body, truncated = (
        truncate(adf.read(found, site_hosts), MAX_COMMENT) if found is not None else (None, False)
    )
    return {
        "id": comment.id,
        # The latest version's time: Confluence gives a comment's creation time only with its version history.
        "updated": comment.version.created_at if comment.version else None,
        "text": body,
        "text_truncated": truncated,
    }


async def _parent(
    client: ConfluenceClient, site: Site, resource: Resource, page: Page, site_hosts: list[str]
) -> dict[str, Any] | None:
    """The parent page, read fresh, when it is a current page in the same space; otherwise nothing."""
    if page.parent_id is None or page.parent_type != "page" or not ID.match(page.parent_id):
        return None
    found = await client.pages(site.id, [page.parent_id])
    parent = found[0] if found else None
    if parent is None or parent.space_id is None or space_id(site, parent.space_id) != resource.id:
        return None
    return {"id": parent.id, "title": short(parent.title, site_hosts)}


class GetPage(OperationInput):
    site_id: SiteId | None = None
    page: PageName


async def _prepare_get_page(binding: Binding, data: GetPage) -> Prepared:
    site, resource, found = await resolve_page(binding, data.site_id, data.page)

    async def execute() -> ProviderOutput:
        client: ConfluenceClient = binding.client
        site_hosts = hosts(await client.sites())
        comments, more = await client.footer_comments(site.id, found.id, limit=MAX_COMMENTS)
        # Last, so the page is seen in the space after its comments were read.
        page = await confirm_page(binding, site, resource, found.id, body=True)
        parent = await _parent(client, site, resource, page, site_hosts)
        found_body = document(page.body)
        if found_body is None:
            raise client.unexpected()
        body, body_truncated = truncate(adf.read(found_body, site_hosts), MAX_BODY)
        record = {
            "id": page.id,
            "site_id": site.id,
            "space_id": page.space_id,
            "title": short(page.title, site_hosts),
            "parent": parent,
            "created": page.created_at,
            "updated": _updated(page),
            "version": page.version.number if page.version else None,
            "body": body,
            "body_truncated": body_truncated,
            "comments": [_comment(comment, site_hosts) for comment in reversed(comments)],
            "more_comments": more,
            "link": link(site, page.id),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_PAGE = Operation(
    name="get_page",
    title="Read a page",
    description="Read one Confluence page with its body and latest comments. " + READ_NOTE,
    input_model=GetPage,
    needs=((SPACE, "read"),),
    prepare=_prepare_get_page,
)
