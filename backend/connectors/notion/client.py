from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from connectors.base import OperationError
from connectors.http import ProviderHTTP

API_URL = "https://api.notion.com/v1"
# Pinned: the markdown endpoints and data sources behave as documented for this version.
NOTION_VERSION = "2026-03-11"
MAX_MARKDOWN_BYTES = 4 * 1024 * 1024


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Parent(Model):
    type: str
    page_id: str | None = None
    database_id: str | None = None
    data_source_id: str | None = None
    block_id: str | None = None


class Page(Model):
    object: str
    id: str
    parent: Parent
    url: str | None = None
    in_trash: bool = False
    is_locked: bool = False
    created_time: str | None = None
    last_edited_time: str | None = None
    properties: dict[str, dict[str, Any]] = {}

    @property
    def title(self) -> str:
        for value in self.properties.values():
            if value.get("type") == "title":
                return text_of(value.get("title"))
        return ""


class DataSourceRef(Model):
    id: str
    name: str = ""


class Database(Model):
    object: str
    id: str
    parent: Parent
    title: list[dict[str, Any]] = []
    url: str | None = None
    in_trash: bool = False
    is_inline: bool = False
    data_sources: list[DataSourceRef] = []

    @property
    def name(self) -> str:
        return text_of(self.title)


class DataSource(Model):
    object: str
    id: str
    parent: Parent
    title: list[dict[str, Any]] = []
    properties: dict[str, dict[str, Any]] = {}

    @property
    def name(self) -> str:
        return text_of(self.title)

    @property
    def database_id(self) -> str | None:
        return self.parent.database_id if self.parent.type == "database_id" else None


class Block(Model):
    object: str
    id: str
    parent: Parent


class RequestStatus(Model):
    type: str = "complete"


class SearchPage(Model):
    results: list[dict[str, Any]] = []
    next_cursor: str | None = None
    has_more: bool = False
    request_status: RequestStatus | None = None

    @property
    def incomplete(self) -> bool:
        return self.request_status is not None and self.request_status.type == "incomplete"


class PageMarkdown(Model):
    id: str
    markdown: str
    truncated: bool = False
    unknown_block_ids: list[str] = []


class Author(Model):
    id: str


class Comment(Model):
    id: str
    discussion_id: str | None = None
    parent: Parent
    created_time: str | None = None
    created_by: Author | None = None
    rich_text: list[dict[str, Any]] = []


class CommentPage(Model):
    results: list[Comment] = []
    next_cursor: str | None = None
    has_more: bool = False


class Bot(Model):
    workspace_id: str | None = None
    workspace_name: str | None = None


class BotUser(Model):
    id: str
    name: str | None = None
    type: str
    bot: Bot | None = None


# Mentions of these show the other object's title, which the agent may not be allowed to read.
TITLED_MENTIONS = frozenset({"page", "database", "data_source", "agent"})


def _titled_mention(item: dict[str, Any]) -> dict[str, Any] | None:
    mention = item.get("mention") if item.get("type") == "mention" else None
    if (
        isinstance(mention, dict)
        and isinstance(mention.get("type"), str)
        and mention["type"] in TITLED_MENTIONS
    ):
        return mention
    return None


def has_titled_mention(items: Any) -> bool:
    return isinstance(items, list) and any(isinstance(i, dict) and _titled_mention(i) for i in items)


def text_of(items: Any) -> str:
    """Plain text of rich text. Mentions of pages and databases show their id instead of their title."""
    if not isinstance(items, list):
        return ""
    parts = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if mention := _titled_mention(item):
            target = mention.get(mention["type"])
            target_id = target.get("id") if isinstance(target, dict) else None
            parts.append(f"(mention of {mention['type']} {target_id})")
        else:
            text = item.get("plain_text", "")
            parts.append(text if isinstance(text, str) else "")
    return "".join(parts)


def forbidden(provider: str, response: httpx.Response) -> OperationError:
    """Notion answers 403 when the integration lacks a capability (say, inserting comments)."""
    return OperationError(
        "PROVIDER_FORBIDDEN",
        "Notion does not let Minerva's integration do this. Its capabilities are set by whoever runs "
        "this Minerva instance, in Notion's integration settings.",
    )


class NotionClient:
    """Thin async client for the Notion API. Responses are validated before use."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._http = ProviderHTTP(
            "Notion",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}", "Notion-Version": NOTION_VERSION},
            transport=transport,
            forbidden=forbidden,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def me(self) -> BotUser:
        return await self._http.parsed(BotUser, "GET", "/users/me")

    async def page(self, page_id: str) -> Page:
        return await self._http.parsed(Page, "GET", f"/pages/{page_id}")

    async def database(self, database_id: str) -> Database:
        return await self._http.parsed(Database, "GET", f"/databases/{database_id}")

    async def data_source(self, data_source_id: str) -> DataSource:
        return await self._http.parsed(DataSource, "GET", f"/data_sources/{data_source_id}")

    async def block(self, block_id: str) -> Block:
        return await self._http.parsed(Block, "GET", f"/blocks/{block_id}")

    async def markdown(self, page_id: str) -> PageMarkdown:
        response = await self._http.bounded(
            f"/pages/{page_id}/markdown",
            limit=MAX_MARKDOWN_BYTES,
            too_large=OperationError("PAGE_TOO_LARGE", "This page is larger than Minerva reads."),
        )
        try:
            return PageMarkdown.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise self._http.unexpected() from error

    async def search(
        self, query: str | None, *, limit: int, cursor: str | None, only: str | None = None
    ) -> SearchPage:
        body: dict[str, Any] = {"page_size": limit}
        if query:
            body["query"] = query
        if cursor:
            body["start_cursor"] = cursor
        if only:
            body["filter"] = {"property": "object", "value": only}
        return await self._http.parsed(SearchPage, "POST", "/search", json=body, mutating=False)

    async def query(
        self,
        data_source_id: str,
        *,
        limit: int,
        cursor: str | None,
        filter: dict[str, Any] | None,
        sorts: list[Any] | None,
    ) -> SearchPage:
        body: dict[str, Any] = {"page_size": limit, "result_type": "page"}
        if cursor:
            body["start_cursor"] = cursor
        if filter:
            body["filter"] = filter
        if sorts:
            body["sorts"] = sorts
        return await self._http.parsed(
            SearchPage, "POST", f"/data_sources/{data_source_id}/query", json=body, mutating=False
        )

    async def comments(self, block_id: str, *, cursor: str | None) -> CommentPage:
        params = {"block_id": block_id, "page_size": "100"}
        if cursor:
            params["start_cursor"] = cursor
        return await self._http.parsed(CommentPage, "GET", "/comments", params=params)

    # Writes: each operation sends exactly one.

    async def create_page(self, body: dict[str, Any]) -> Page:
        return await self._http.parsed(Page, "POST", "/pages", json=body)

    async def update_page(self, page_id: str, body: dict[str, Any]) -> Page:
        return await self._http.parsed(Page, "PATCH", f"/pages/{page_id}", json=body)

    async def update_markdown(self, page_id: str, body: dict[str, Any]) -> PageMarkdown:
        return await self._http.parsed(PageMarkdown, "PATCH", f"/pages/{page_id}/markdown", json=body)

    async def add_comment(self, body: dict[str, Any]) -> Comment:
        return await self._http.parsed(Comment, "POST", "/comments", json=body)
