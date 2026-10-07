import json
from collections.abc import Callable

import httpx
import pytest
from asgiref.sync import sync_to_async
from connector_runs import claimed_run, replace_grants
from django.test import Client, override_settings

from accounts.models import User
from agents.models import Agent
from connections import oauth as connection_oauth
from connections import services as connection_services
from connections.models import Connection
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import ApiKey, Builtin
from connectors.executor import Executor
from connectors.todoist.client import TodoistClient
from connectors.todoist.connector import TodoistConnector
from conversations.models import Conversation
from permissions.models import Grant
from permissions.services import GrantChange, apply_grant_changes
from runs import services
from workspaces.tenancy import workspace_scope

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture(autouse=True)
def files_storage(settings, tmp_path):
    """Agent files go to a directory of the test's own, never to the configured storage."""
    location = tmp_path / "files"
    settings.STORAGES = {
        **settings.STORAGES,
        "files": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": location, "allow_overwrite": True},
        },
    }
    return location


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
        """Replaces the user's grants on the connection; use ** {"*": [...]} for every project."""
        existing = Grant.objects.filter(layer__user=user, connection=connection, effect=Grant.Effect.ALLOW)
        changes = [
            GrantChange(g.resource_kind, g.resource_id, ()) for g in existing if g.resource_id not in projects
        ]
        changes += [GrantChange("project", pid, tuple(actions)) for pid, actions in projects.items()]
        if changes:
            apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})

    return grant_


@pytest.fixture
def connector_run(scoped, user):
    """Starts and claims a run for the workspace's agent with only the user's `provider` connection.

    `await connector_run(provider, grants, scopes=..., label=..., external_account_id=...)` creates the
    connection from the account fields the first time and stores an OAuth token holding `scopes`, or
    `access_token` as the key of an API key connector (a built-in connector's connection is enabled
    instead), then replaces the user's grants on it with `grants` ({(kind, id): actions}).
    """

    def start(provider: str, grants: dict, *, scopes=(), access_token="t", **account) -> Executor:  # noqa: S107
        auth = registry.get(provider).auth
        with workspace_scope(scoped.id):
            if isinstance(auth, Builtin):
                connection = connection_services.enable_builtin(
                    workspace_id=scoped.id, owner_id=user.id, provider=provider
                )
            else:
                connection = Connection.objects.filter(provider=provider).first() or Connection(
                    provider=provider, owner=user, **account
                )
                connection.set_credentials(
                    {"kind": "api_key", "key": access_token}
                    if isinstance(auth, ApiKey)
                    else {"kind": "oauth2", "access_token": access_token, "scopes": list(scopes)}
                )
                connection.save()
            replace_grants(user, connection, grants)
            agent = Agent.objects.get()
            agent.connections.set([connection])
        return claimed_run(scoped, user)

    return sync_to_async(start)


@pytest.fixture
def gateway_urls():
    with override_settings(ROOT_URLCONF="gateway.urls"):
        yield


@pytest.fixture
def claimed(scoped, user, agent, grant, todoist):
    """A claimed run and its raw token, as the supervisor would hand them to a sandbox."""
    grant(work=["read"])
    with workspace_scope(scoped.id):
        conversation = Conversation.objects.create(agent=agent, user=user)
        services.start_run(conversation=conversation, user_id=user.id, content="List my tasks")
    [(run, token)] = services.claim_queued(1)
    return run, token


@pytest.fixture
def token_endpoint(monkeypatch):
    """Every connector's token endpoint, as client "id" (see connector_runs.FLOW).

    Returns (sent, responses): each POST is recorded in `sent` and answered with the next of `responses`.
    Tokens recorded as issued by another client have no client to refresh them.
    """
    sent: list[dict] = []
    responses: list[httpx.Response] = []
    creds = ClientCredentials("id", "secret", "https://x/cb")
    monkeypatch.setattr(connection_oauth, "client_credentials", lambda connector: creds)
    monkeypatch.setattr(
        connection_oauth,
        "issuing_client",
        lambda connector, client_id: creds if client_id in (None, "id") else None,
    )

    def post(url, **kwargs):
        sent.append({"url": url, **kwargs})
        return responses.pop(0)

    monkeypatch.setattr(connection_oauth.httpx, "post", post)
    return sent, responses
