import json
import secrets
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.google import USERINFO_URL, GoogleUser, forbidden, segment
from connectors.http import ProviderHTTP

API_URL = "https://www.googleapis.com/drive/v3"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"
FILE_FIELDS = (
    "id,name,mimeType,parents,driveId,size,modifiedTime,webViewLink,trashed,"
    "shortcutDetails(targetId,targetMimeType),capabilities(canAddChildren,canListChildren,canDownload)"
)
# Files may be in shared drives; without these Drive acts as if they did not exist.
ALL_DRIVES = {"supportsAllDrives": "true"}


def quoted(text: str) -> str:
    """A string literal in Drive's query language."""
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class Capabilities(Model):
    can_add_children: bool | None = None
    can_list_children: bool | None = None
    can_download: bool | None = None


class ShortcutDetails(Model):
    target_id: str | None = None
    target_mime_type: str | None = None


class DriveFile(Model):
    id: str
    name: str = ""
    mime_type: str = ""
    parents: list[str] | None = None
    drive_id: str | None = None
    size: str | None = None
    modified_time: str | None = None
    web_view_link: str | None = None
    trashed: bool = False
    shortcut_details: ShortcutDetails | None = None
    capabilities: Capabilities | None = None

    @property
    def is_folder(self) -> bool:
        return self.mime_type == FOLDER


class FilePage(Model):
    files: list[DriveFile] = []
    next_page_token: str | None = None
    incomplete_search: bool = False


class SharedDrive(Model):
    id: str
    name: str = ""


class DrivePage(Model):
    drives: list[SharedDrive] = []
    next_page_token: str | None = None


class RootId(Model):
    id: str


class GoogleDriveClient:
    """Thin async client for the Google Drive API v3. Responses are validated before use."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        upload_url: str = UPLOAD_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._upload_url = upload_url
        self._http = ProviderHTTP(
            "Google Drive",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
            forbidden=forbidden,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def user(self) -> GoogleUser:
        return await self._http.parsed(GoogleUser, "GET", USERINFO_URL)

    async def root_id(self) -> str:
        return (await self._http.parsed(RootId, "GET", "/files/root", params={"fields": "id"})).id

    async def file(self, file_id: str) -> DriveFile:
        params = {**ALL_DRIVES, "fields": FILE_FIELDS}
        return await self._http.parsed(DriveFile, "GET", f"/files/{segment(file_id)}", params=params)

    async def files(
        self,
        query: str,
        *,
        limit: int,
        page_token: str | None,
        drive_id: str | None = None,
        all_drives: bool = False,
        order_by: str | None = None,
    ) -> FilePage:
        params: dict[str, Any] = {
            **ALL_DRIVES,
            "includeItemsFromAllDrives": "true",
            "q": query,
            "pageSize": limit,
            "fields": f"nextPageToken,incompleteSearch,files({FILE_FIELDS})",
        }
        if drive_id:
            params |= {"corpora": "drive", "driveId": drive_id}
        elif all_drives:
            params["corpora"] = "allDrives"
        if order_by:
            params["orderBy"] = order_by
        if page_token:
            params["pageToken"] = page_token
        return await self._http.parsed(FilePage, "GET", "/files", params=params)

    async def drives(self, page_token: str | None) -> DrivePage:
        params: dict[str, Any] = {"pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        return await self._http.parsed(DrivePage, "GET", "/drives", params=params)

    async def drive(self, drive_id: str) -> SharedDrive:
        return await self._http.parsed(SharedDrive, "GET", f"/drives/{segment(drive_id)}")

    async def export(self, file_id: str, mime_type: str, *, limit: int) -> bytes:
        return await self._http.download(
            f"/files/{segment(file_id)}/export", limit=limit, params={"mimeType": mime_type}
        )

    async def content(self, file_id: str, *, limit: int) -> bytes:
        return await self._http.download(
            f"/files/{segment(file_id)}", limit=limit, params={**ALL_DRIVES, "alt": "media"}
        )

    async def create(self, metadata: dict[str, Any], content: bytes) -> DriveFile:
        """One multipart upload: the file's metadata and its text in a single request."""
        boundary = "minerva-" + secrets.token_hex(16)
        if boundary.encode() in content:
            raise OperationError("PROVIDER_REJECTED", "The file content could not be encoded. Try again.")
        body = b"".join(
            [
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode(),
                json.dumps(metadata).encode(),
                f"\r\n--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n".encode(),
                content,
                f"\r\n--{boundary}--".encode(),
            ]
        )
        return await self._http.parsed(
            DriveFile,
            "POST",
            self._upload_url,
            params={
                **ALL_DRIVES,
                "uploadType": "multipart",
                # A domain's default link sharing would otherwise apply to the new file.
                "ignoreDefaultVisibility": "true",
                "fields": FILE_FIELDS,
            },
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            content=body,
        )
