"""Microsoft Graph, for files in OneDrive and SharePoint document libraries.

Items are addressed by drive and item id (`/drives/{drive}/items/{item}`), never by path, except for the
name of a file being created. A file's content comes from the pre-authenticated download URL Graph gives
with the item: a second client that sends no token fetches it, only over HTTPS from Microsoft's file hosts,
and follows no redirect. Uploads send `conflictBehavior=fail`, so an existing file is never replaced.

Microsoft Search (`/search/query`) covers what a work or school account can open; personal accounts search
their own OneDrive and what was shared with them (`/me/drive/search`).
"""

from typing import Any
from urllib.parse import quote

import httpx
from pydantic import Field

from connectors.base import OperationError
from connectors.http import ProviderHTTP
from connectors.microsoft import (
    API_URL,
    MAX_RESPONSE_BYTES,
    Graph,
    Model,
    classify,
    error_code,
    next_cursor,
    page_param,
    segment,
)

ITEM_FIELDS = "id,name,size,file,folder,root,package,remoteItem,parentReference,webUrl,lastModifiedDateTime"
DOWNLOAD_FIELDS = f"{ITEM_FIELDS},@microsoft.graph.downloadUrl"
DRIVE_FIELDS = "id,name,driveType,webUrl"
# Where Graph's download URLs point: SharePoint (work and school) and OneDrive's personal file hosts.
DOWNLOAD_HOSTS = (".sharepoint.com", ".1drv.com", ".microsoftpersonalcontent.com")


class ItemReference(Model):
    drive_id: str | None = None
    drive_type: str | None = None
    id: str | None = None


class FileFacet(Model):
    mime_type: str | None = None


class FolderFacet(Model):
    child_count: int | None = None


class RemoteItem(Model):
    id: str | None = None
    parent_reference: ItemReference | None = None


class DriveItem(Model):
    id: str
    name: str = ""
    size: int | None = None
    file: FileFacet | None = None
    folder: FolderFacet | None = None
    # Facets that Graph may send empty ({}): test them for presence.
    root: dict[str, Any] | None = None
    package: dict[str, Any] | None = None
    remote_item: RemoteItem | None = None
    parent_reference: ItemReference | None = None
    web_url: str | None = None
    last_modified_date_time: str | None = None
    download_url: str | None = Field(None, alias="@microsoft.graph.downloadUrl")


class Drive(Model):
    id: str
    name: str = ""
    drive_type: str | None = None
    web_url: str | None = None


class Site(Model):
    id: str
    name: str | None = None
    display_name: str | None = None
    web_url: str | None = None


def _classify(provider: str, response: httpx.Response) -> OperationError | None:
    if response.status_code == 409 and error_code(response) == "nameAlreadyExists":
        return OperationError(
            "PROVIDER_REJECTED", "A file or folder with this name already exists in this folder."
        )
    return classify(provider, response)


def download_allowed(url: str) -> bool:
    """Whether a download URL Graph gave is one Minerva fetches: HTTPS on Microsoft's file hosts."""
    if len(url) > 8000 or "\\" in url or any(ord(c) <= 0x20 or ord(c) == 0x7F for c in url):
        return False
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL:
        return False
    host = parsed.host.lower()
    return (
        parsed.scheme == "https"
        and not parsed.userinfo
        and parsed.port is None
        and any(host.endswith(suffix) and len(host) > len(suffix) for suffix in DOWNLOAD_HOSTS)
    )


class DriveClient(Graph):
    """Thin async client for the parts of Microsoft Graph OneDrive and SharePoint files use."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        super().__init__("OneDrive", access_token, base_url=base_url, transport=transport, classify=_classify)
        # Download URLs carry their own authorization; this client never holds the token.
        self._files = ProviderHTTP("OneDrive", base_url="", headers={}, transport=transport)

    async def aclose(self) -> None:
        await super().aclose()
        await self._files.aclose()

    async def my_drive(self) -> Drive | None:
        """The account's own OneDrive, or None when it has none (say, a guest or an unlicensed user)."""
        try:
            body = await self.get("/me/drive", params={"$select": DRIVE_FIELDS})
        except OperationError as error:
            if error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"}:
                return None
            raise
        return self._parse(Drive, body)

    async def drive(self, drive_id: str) -> Drive:
        return self._parse(
            Drive, await self.get(f"/drives/{segment(drive_id)}", params={"$select": DRIVE_FIELDS})
        )

    async def my_root(self) -> DriveItem:
        return self._parse(DriveItem, await self.get("/me/drive/root", params={"$select": ITEM_FIELDS}))

    async def drive_root(self, drive_id: str) -> DriveItem:
        return self._parse(
            DriveItem,
            await self.get(f"/drives/{segment(drive_id)}/root", params={"$select": ITEM_FIELDS}),
        )

    async def item(self, drive_id: str, item_id: str, *, download: bool = False) -> DriveItem:
        """An item by id. With `download`, Graph includes a short-lived download URL for a file."""
        return self._parse(
            DriveItem,
            await self.get(
                f"/drives/{segment(drive_id)}/items/{segment(item_id)}",
                params={"$select": DOWNLOAD_FIELDS if download else ITEM_FIELDS},
            ),
        )

    async def children(
        self, drive_id: str, item_id: str, *, limit: int, cursor: str | None
    ) -> tuple[list[DriveItem], str | None]:
        params = {"$select": ITEM_FIELDS, "$top": str(limit), **(page_param(cursor) if cursor else {})}
        body = await self.get(f"/drives/{segment(drive_id)}/items/{segment(item_id)}/children", params=params)
        return self._page(DriveItem, body)

    async def followed_sites(self, limit: int) -> tuple[list[Site], bool]:
        """The SharePoint sites the account follows, at most `limit`, and whether there are more."""
        body = await self.get(
            "/me/followedSites", params={"$select": "id,name,displayName,webUrl", "$top": str(limit)}
        )
        sites, more = self._page(Site, body)
        return sites[:limit], more is not None or len(sites) > limit

    async def libraries(self, site_id: str, limit: int) -> list[Drive]:
        """A site's document libraries, at most `limit`."""
        body = await self.get(
            f"/sites/{segment(site_id)}/drives", params={"$select": DRIVE_FIELDS, "$top": str(limit)}
        )
        items = body.get("value")
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(Drive, item) for item in items[:limit]]

    async def search_work(self, text: str, *, offset: int, size: int) -> tuple[list[DriveItem], bool]:
        """Microsoft Search over files: the items hit, in rank order, and whether there are more."""
        request = {
            "entityTypes": ["driveItem"],
            "query": {"queryString": text},
            "from": offset,
            "size": size,
        }
        response = await self._http.bounded(
            "/search/query",
            method="POST",
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError("RESPONSE_TOO_LARGE", "OneDrive returned more than Minerva reads."),
            json={"requests": [request]},
        )
        try:
            body = response.json()
            containers = [c for answer in body["value"] for c in answer.get("hitsContainers") or []]
        except ValueError, KeyError, TypeError, AttributeError:
            raise self.unexpected() from None
        items: list[DriveItem] = []
        more = False
        for container in containers:
            if not isinstance(container, dict):
                raise self.unexpected()
            more = more or container.get("moreResultsAvailable") is True
            for hit in container.get("hits") or []:
                resource = hit.get("resource") if isinstance(hit, dict) else None
                if not isinstance(resource, dict):
                    continue
                # A hit's resource may leave out its id; for a driveItem, hitId is the item's id.
                item_id = resource.get("id") or hit.get("hitId")
                if not isinstance(item_id, str):
                    continue
                items.append(self._parse(DriveItem, {**resource, "id": item_id}))
        return items, more

    async def search_personal(
        self, text: str, *, limit: int, cursor: str | None
    ) -> tuple[list[DriveItem], str | None]:
        """A personal account's search: its own OneDrive and items shared with it."""
        literal = quote(text.replace("'", "''"), safe="")
        params = {"$select": ITEM_FIELDS, "$top": str(limit), **(page_param(cursor) if cursor else {})}
        body = await self.get(f"/me/drive/search(q='{literal}')", params=params)
        items = body.get("value")
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(DriveItem, item) for item in items], next_cursor(body.get("@odata.nextLink"))

    async def content(self, url: str, *, limit: int) -> bytes:
        if not download_allowed(url):
            raise OperationError(
                "PROVIDER_FAILED",
                "OneDrive offered this file from an address Minerva does not download from.",
            )
        return await self._files.download(url, limit=limit)

    async def upload(self, drive_id: str, folder_id: str, name: str, content: bytes) -> DriveItem:
        """The one write of an operation: a new file in a folder, refused if the name is taken."""
        return await self._http.parsed(
            DriveItem,
            "PUT",
            f"/drives/{segment(drive_id)}/items/{segment(folder_id)}:/{segment(name)}:/content",
            params={"@microsoft.graph.conflictBehavior": "fail"},
            content=content,
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
