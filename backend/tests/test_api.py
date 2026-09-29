import json

import pytest
from django.test import Client

from connectors.base import ScopeItem
from conversations.models import Conversation
from runs import services
from runs.models import Run
from workspaces.tenancy import workspace_scope


def post(client: Client, url: str, body: dict | None = None, method: str = "post"):
    return getattr(client, method)(url, data=json.dumps(body or {}), content_type="application/json")


def test_me_requires_login_and_lists_the_personal_workspace(client, api, user, workspace):
    assert client.get("/api/me").status_code == 401
    body = api.get("/api/me").json()
    assert body["user"]["email"] == user.email
    assert body["workspaces"] == [
        {"id": str(workspace.id), "name": "Personal", "kind": "personal", "role": "owner"}
    ]


@pytest.mark.parametrize(
    "path",
    ["agents", "connections", "connectors", "conversations"],
)
def test_other_workspaces_are_not_reachable(api, other_user, path):
    foreign = other_user.personal_workspace.id
    assert api.get(f"/api/workspaces/{foreign}/{path}").status_code == 401


def test_foreign_conversations_and_runs_are_not_found(api, user, other_user, workspace):
    theirs = other_user.personal_workspace
    with workspace_scope(theirs.id):
        conversation = Conversation.objects.create(agent=theirs_agent(theirs), user=other_user)
        _, run = services.start_run(conversation=conversation, user_id=other_user.id, content="secret")
    mine = workspace.id
    assert api.get(f"/api/workspaces/{mine}/conversations/{conversation.id}").status_code == 404
    assert (
        post(
            api, f"/api/workspaces/{mine}/conversations/{conversation.id}/messages", {"content": "x"}
        ).status_code
        == 404
    )
    assert post(api, f"/api/workspaces/{mine}/runs/{run.id}/cancel").status_code == 404
    assert api.get(f"/api/workspaces/{mine}/runs/{run.id}/stream").status_code == 404
    assert api.get(f"/api/workspaces/{theirs.id}/runs/{run.id}/stream").status_code == 404


def theirs_agent(workspace):
    from agents.models import Agent

    return Agent.objects.get(workspace=workspace)


def test_chat_message_starts_one_run_at_a_time(api, workspace, scoped, agent):
    base = f"/api/workspaces/{workspace.id}"
    conversation = post(api, f"{base}/conversations", {"agent_id": str(agent.id)}).json()
    url = f"{base}/conversations/{conversation['id']}/messages"
    posted = post(api, url, {"content": "What is due today?"})
    assert posted.status_code == 201
    run = Run.objects.get(pk=posted.json()["run"]["id"])
    assert run.status == Run.Status.QUEUED
    assert {tool["name"] for tool in run.tools} >= {"todoist_list_projects", "todoist_create_task"}
    assert [layer["name"] for layer in run.permissions] == ["ceiling", "user", "agent"]
    assert post(api, url, {"content": "again"}).status_code == 409
    detail = api.get(f"{base}/conversations/{conversation['id']}").json()
    assert detail["title"] == "What is due today?"
    assert [m["role"] for m in detail["messages"]] == ["user"]


def test_access_settings_are_validated(api, workspace, connection, monkeypatch):
    monkeypatch.setattr(
        "connections.api._scope", lambda c: [ScopeItem("work", "Work"), ScopeItem("private", "Private")]
    )
    url = f"/api/workspaces/{workspace.id}/connections/{connection.id}/access"
    assert api.get(url).json()["resources"][0] == {"id": "work", "name": "Work", "actions": []}
    bad = [
        {"resources": [{"id": "work", "actions": ["create"]}]},
        {"resources": [{"id": "elsewhere", "actions": ["read"]}]},
        {"resources": [{"id": "work", "actions": ["delete"]}]},
    ]
    for body in bad:
        assert post(api, url, body, method="put").status_code == 422, body
    saved = post(api, url, {"resources": [{"id": "work", "actions": ["read", "create"]}]}, method="put")
    assert saved.status_code == 200
    assert saved.json()["resources"][0]["actions"] == ["create", "read"]


def test_agents_can_only_use_connections_of_their_user(api, workspace, other_user):
    with workspace_scope(other_user.personal_workspace.id):
        from connections.models import Connection

        foreign = Connection(provider="todoist", owner=other_user, label="M", external_account_id="m")
        foreign.set_credentials({"access_token": "x"})
        foreign.save()
    url = f"/api/workspaces/{workspace.id}/agents"
    response = post(api, url, {"name": "Sneaky", "connection_ids": [str(foreign.id)]})
    assert response.status_code == 422
