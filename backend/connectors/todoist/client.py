from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.http import ProviderHTTP

API_URL = "https://api.todoist.com/api/v1"


class TodoistUser(BaseModel):
    model_config = ConfigDict(extra="ignore", coerce_numbers_to_str=True)
    id: str
    full_name: str | None = None
    email: str | None = None


class TodoistProject(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    color: str | None = None
    parent_id: str | None = None


class TodoistDue(BaseModel):
    model_config = ConfigDict(extra="ignore")
    date: str
    string: str | None = None


class TodoistTask(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    project_id: str
    content: str
    description: str = ""
    priority: int = 1
    due: TodoistDue | None = None
    checked: bool = False


class Page[T](BaseModel):
    results: list[T]
    next_cursor: str | None = None


class TodoistClient:
    """Thin async client for the Todoist API v1. Responses are validated before use."""

    def __init__(
        self, access_token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._http = ProviderHTTP(
            "Todoist",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def user(self) -> TodoistUser:
        return await self._http.parsed(TodoistUser, "GET", "/user")

    async def projects(self, cursor: str | None = None, limit: int = 200) -> Page[TodoistProject]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return await self._http.parsed(Page[TodoistProject], "GET", "/projects", params=params)

    async def tasks(self, project_id: str, *, cursor: str | None, limit: int) -> Page[TodoistTask]:
        params: dict[str, Any] = {"project_id": project_id, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return await self._http.parsed(Page[TodoistTask], "GET", "/tasks", params=params)

    async def filter_tasks(self, query: str, *, cursor: str | None, limit: int) -> Page[TodoistTask]:
        params: dict[str, Any] = {"query": query, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return await self._http.parsed(Page[TodoistTask], "GET", "/tasks/filter", params=params)

    async def task(self, task_id: str) -> TodoistTask:
        return await self._http.parsed(TodoistTask, "GET", f"/tasks/{task_id}")

    async def create_task(self, project_id: str, content: str) -> TodoistTask:
        payload = {"project_id": project_id, "content": content}
        return await self._http.parsed(TodoistTask, "POST", "/tasks", json=payload)
