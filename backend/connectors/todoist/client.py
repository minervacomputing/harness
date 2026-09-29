from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OperationError

API_URL = "https://api.todoist.com/api/v1"


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
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=httpx.Timeout(20.0),
            follow_redirects=False,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as error:
            raise OperationError("PROVIDER_UNAVAILABLE", "Todoist could not be reached.") from error
        if response.status_code in {401, 403}:
            raise OperationError("CONNECTION_UNAUTHORIZED", "The Todoist connection is no longer authorized.")
        if response.status_code == 404:
            raise OperationError("NOT_FOUND", "Todoist did not find this object.")
        if response.status_code == 429:
            raise OperationError(
                "PROVIDER_RATE_LIMITED", "Todoist is rate limiting requests. Try again later."
            )
        if response.is_error:
            raise OperationError("PROVIDER_FAILED", "Todoist could not complete this request.")
        return response.json()

    async def user(self) -> dict[str, Any]:
        return await self._request("GET", "/user")

    async def projects(self, cursor: str | None = None, limit: int = 200) -> Page[TodoistProject]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return Page[TodoistProject].model_validate(await self._request("GET", "/projects", params=params))

    async def tasks(self, project_id: str, *, cursor: str | None, limit: int) -> Page[TodoistTask]:
        params: dict[str, Any] = {"project_id": project_id, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return Page[TodoistTask].model_validate(await self._request("GET", "/tasks", params=params))

    async def filter_tasks(self, query: str, *, cursor: str | None, limit: int) -> Page[TodoistTask]:
        params: dict[str, Any] = {"query": query, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return Page[TodoistTask].model_validate(await self._request("GET", "/tasks/filter", params=params))

    async def task(self, task_id: str) -> TodoistTask:
        return TodoistTask.model_validate(await self._request("GET", f"/tasks/{task_id}"))

    async def create_task(self, project_id: str, content: str) -> TodoistTask:
        payload = {"project_id": project_id, "content": content}
        return TodoistTask.model_validate(await self._request("POST", "/tasks", json=payload))
