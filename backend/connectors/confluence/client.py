"""Confluence Cloud's REST API, reached per site through api.atlassian.com.

The v2 API serves spaces, pages and comments; search is v1's CQL search, the only one Confluence has. Both
page with an opaque cursor in the `_links.next` address. This client takes only the `cursor` parameter from
that address, checked to be printable and short enough to store, and sends it to the same endpoint with
the same query again; the address itself is never followed.
"""

import json
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from pydantic import Field

from connectors.atlassian import AtlassianClient, Model, segment
from connectors.base import OperationError

MAX_PAGES = 10
BATCH_LIMIT = 250
_TOKEN = re.compile(r"\A[\x21-\x7e]{1,990}\Z")
PREFIX = "c:"


class Space(Model):
    id: str
    key: str
    name: str | None = None
    type: str | None = None
    status: str | None = None


class Version(Model):
    number: int | None = None
    created_at: str | None = None


class Representation(Model):
    value: Any = None


class Body(Model):
    atlas_doc_format: Representation | None = None


class Page(Model):
    id: str
    status: str | None = None
    title: str | None = None
    space_id: str | None = None
    parent_id: str | None = None
    parent_type: str | None = None
    created_at: str | None = None
    version: Version | None = None
    body: Body | None = None


class Comment(Model):
    id: str
    status: str | None = None
    version: Version | None = None
    body: Body | None = None


class Found(Model):
    id: str
    type: str | None = None


class Result(Model):
    content: Found | None = None


class Links(Model):
    next: str | None = None


class Listing(Model):
    results: list[dict[str, Any]] = Field(default_factory=list)
    links: Links = Field(default_factory=Links, alias="_links")


def page_params(cursor: str | None) -> dict[str, str]:
    if cursor is None:
        return {}
    token = cursor.removeprefix(PREFIX)
    if not cursor.startswith(PREFIX) or not _TOKEN.match(token):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return {"cursor": token}


def next_token(listing: Listing) -> str | None:
    """The cursor of the next page, from the `_links.next` address; None on the last page."""
    if not listing.links.next:
        return None
    tokens = parse_qs(urlsplit(listing.links.next).query).get("cursor", [])
    if len(tokens) != 1 or not _TOKEN.match(tokens[0]):
        raise OperationError("PROVIDER_LIMIT", "Confluence returned a page token Minerva cannot use.")
    return tokens[0]


def next_cursor(listing: Listing) -> str | None:
    token = next_token(listing)
    return f"{PREFIX}{token}" if token else None


def document(body: Body | None) -> Any:
    """The ADF document of a page's or comment's body; Confluence sends it as a JSON string."""
    value = body.atlas_doc_format.value if body and body.atlas_doc_format else None
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def _written(adf: dict[str, Any]) -> dict[str, str]:
    return {"representation": "atlas_doc_format", "value": json.dumps(adf)}


class ConfluenceClient(AtlassianClient):
    """Thin async client for the parts of Confluence's API the connector uses."""

    def __init__(self, access_token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(
            "Confluence", "confluence", access_token, scope="read:page:confluence", transport=transport
        )

    def _v2(self, cloud_id: str, path: str) -> str:
        return f"{self.api(cloud_id)}/wiki/api/v2{path}"

    async def _listing(self, path: str, params: dict[str, str]) -> Listing:
        return self._parse(Listing, await self.get(path, params=params))

    def _items[M: Model](self, model: type[M], listing: Listing) -> list[M]:
        return [self._parse(model, item) for item in listing.results]

    async def spaces(
        self, cloud_id: str, *, limit: int, cursor: str | None = None
    ) -> tuple[list[Space], str | None]:
        """One page of the spaces the account can see, and the token of the next page."""
        params = {"limit": str(limit), "sort": "name"}
        if cursor:
            params["cursor"] = cursor
        listing = await self._listing(self._v2(cloud_id, "/spaces"), params)
        return self._items(Space, listing), next_token(listing)

    async def space(self, cloud_id: str, space_id: str) -> Space:
        return self._parse(Space, await self.get(self._v2(cloud_id, f"/spaces/{segment(space_id)}")))

    async def _all(self, path: str, params: dict[str, str]) -> list[dict[str, Any]]:
        """Every result of a filtered listing, following its pages."""
        found: list[dict[str, Any]] = []
        seen: set[str] = set()
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            listing = await self._listing(path, params | ({"cursor": cursor} if cursor else {}))
            found += listing.results
            cursor = next_token(listing)
            if cursor is None:
                return found
            if cursor in seen:
                raise self.unexpected()
            seen.add(cursor)
        raise OperationError("PROVIDER_LIMIT", "Confluence returned more than Minerva reads.")

    async def spaces_by(self, cloud_id: str, field: str, values: list[str]) -> list[Space]:
        """The spaces the account can see whose `ids` or `keys` (the field) are among these values."""
        found: list[Space] = []
        for start in range(0, len(values), BATCH_LIMIT):
            params = {field: ",".join(values[start : start + BATCH_LIMIT]), "limit": str(BATCH_LIMIT)}
            found += [
                self._parse(Space, item) for item in await self._all(self._v2(cloud_id, "/spaces"), params)
            ]
        return found

    async def page(self, cloud_id: str, page_id: str, *, body: bool = False) -> Page:
        params = {"body-format": "atlas_doc_format"} if body else None
        return self._parse(
            Page, await self.get(self._v2(cloud_id, f"/pages/{segment(page_id)}"), params=params)
        )

    async def pages(self, cloud_id: str, ids: list[str]) -> list[Page]:
        """The current pages with these ids that the account can see, read fresh, in the order asked for."""
        found: list[Page] = []
        for start in range(0, len(ids), BATCH_LIMIT):
            params = {
                "id": ",".join(ids[start : start + BATCH_LIMIT]),
                "status": "current",
                "limit": str(BATCH_LIMIT),
            }
            found += [
                self._parse(Page, item) for item in await self._all(self._v2(cloud_id, "/pages"), params)
            ]
        order = {page_id: index for index, page_id in enumerate(ids)}
        unique = {page.id: page for page in found if page.id in order}
        return sorted(unique.values(), key=lambda page: order[page.id])

    async def search(
        self, cloud_id: str, cql: str, *, limit: int, cursor: str | None
    ) -> tuple[list[str], str | None]:
        """The ids of one page of pages matching `cql`."""
        params = {"cql": cql, "limit": str(limit), **page_params(cursor)}
        listing = await self._listing(f"{self.api(cloud_id)}/wiki/rest/api/search", params)
        results = self._items(Result, listing)
        ids = [r.content.id for r in results if r.content is not None and r.content.type == "page"]
        return ids, next_cursor(listing)

    async def footer_comments(self, cloud_id: str, page_id: str, *, limit: int) -> tuple[list[Comment], bool]:
        """The latest root footer comments, newest first, and whether there are more."""
        params = {"body-format": "atlas_doc_format", "sort": "-created-date", "limit": str(limit)}
        listing = await self._listing(
            self._v2(cloud_id, f"/pages/{segment(page_id)}/footer-comments"), params
        )
        return self._items(Comment, listing), bool(listing.links.next)

    # Writes: each operation sends exactly one.

    async def add_comment(self, cloud_id: str, page_id: str, adf: dict[str, Any]) -> Comment:
        body = {"pageId": page_id, "body": _written(adf)}
        return await self._http.parsed(Comment, "POST", self._v2(cloud_id, "/footer-comments"), json=body)

    async def create_page(
        self, cloud_id: str, *, space_id: str, title: str, parent_id: str | None, adf: dict[str, Any]
    ) -> Page:
        body: dict[str, Any] = {
            "spaceId": space_id,
            "status": "current",
            "title": title,
            "body": _written(adf),
        }
        if parent_id is not None:
            body["parentId"] = parent_id
        return await self._http.parsed(Page, "POST", self._v2(cloud_id, "/pages"), json=body)
