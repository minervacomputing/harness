import json
from collections.abc import Callable

import httpx
import pytest
from django.test import Client

from accounts.models import User
from agents.models import Agent
from connections.models import Connection
from connectors.todoist.client import TodoistClient
from connectors.todoist.connector import TodoistConnector
from permissions.services import GrantSpec, replace_user_grants
from workspaces.tenancy import workspace_scope

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
def make_user(db) -> Callable[[str], User]:
    def make(email: str) -> User:
        return User.objects.create_user(email, PASSWORD)

    return make


@pytest.fixture
def user(make_user) -> User:
    return make_user("ada@example.com")


@pytest.fixture
def other_user(make_user) -> User:
    return make_user("mallory@example.com")


@pytest.fixture
def workspace(user):
    return user.personal_workspace


@pytest.fixture
def scoped(workspace):
    with workspace_scope(workspace.id):
        yield workspace


@pytest.fixture
def api(user) -> Client:
    client = Client(enforce_csrf_checks=False)
    client.force_login(user)
    return client


class FakeTodoist:
    """In-memory Todoist API v1, served through httpx.MockTransport."""

    def __init__(self) -> None:
        self.projects = [{"id": "work", "name": "Work"}, {"id": "private", "name": "Private"}]
        self.tasks = [
            {"id": "t1", "project_id": "work", "content": "Ship it", "priority": 1},
            {"id": "t2", "project_id": "private", "content": "Secret", "priority": 1},
        ]
        self.calls: list[tuple[str, str]] = []
        self.fail_writes = False
        self.revoked = False
        self.page_size: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        self.calls.append((request.method, path))
        if self.revoked:
            return httpx.Response(401, json={})
        if request.method == "GET" and path == "/user":
            return httpx.Response(200, json={"id": "u1", "full_name": "Ada"})
        if request.method == "GET" and path == "/projects":
            return httpx.Response(200, json={"results": self.projects, "next_cursor": None})
        if request.method == "GET" and path == "/tasks":
            project = request.url.params.get("project_id")
            items = [t for t in self.tasks if t["project_id"] == project]
            cursor = request.url.params.get("cursor")
            if self.page_size:
                start = int(cursor or 0)
                page = items[start : start + self.page_size]
                nxt = str(start + self.page_size) if start + self.page_size < len(items) else None
                return httpx.Response(200, json={"results": page, "next_cursor": nxt})
            return httpx.Response(200, json={"results": items, "next_cursor": None})
        if request.method == "GET" and path.startswith("/tasks/"):
            task = next((t for t in self.tasks if t["id"] == path.split("/")[-1]), None)
            return httpx.Response(200, json=task) if task else httpx.Response(404, json={})
        if request.method == "POST" and path == "/tasks":
            if self.fail_writes:
                raise httpx.ReadTimeout("timeout")
            body = json.loads(request.content)
            task = {
                "id": f"t{len(self.tasks) + 1}",
                "project_id": body["project_id"],
                "content": body["content"],
            }
            self.tasks.append(task)
            return httpx.Response(200, json=task)
        return httpx.Response(404, json={})


@pytest.fixture
def todoist(monkeypatch) -> FakeTodoist:
    fake = FakeTodoist()
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(
        TodoistConnector, "client", lambda self, token: TodoistClient(token, transport=transport)
    )
    return fake


@pytest.fixture
def connection(scoped, user) -> Connection:
    connection = Connection(provider="todoist", owner=user, label="Ada", external_account_id="u1")
    connection.set_credentials({"access_token": "test-token"})
    connection.save()
    return connection


@pytest.fixture
def agent(scoped, connection) -> Agent:
    agent = Agent.objects.get()
    agent.connections.set([connection])
    return agent


@pytest.fixture
def grant(user, connection) -> Callable[..., None]:
    def grant_(**projects: list[str]) -> None:
        specs = [
            GrantSpec(connection.id, "project", pid, tuple(actions)) for pid, actions in projects.items()
        ]
        replace_user_grants(user_id=user.id, connection_id=connection.id, specs=specs)

    return grant_
