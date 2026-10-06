import json

import pytest
from django.test import Client

from connections.models import Connection
from conversations.models import Conversation, Message
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


def test_chat_message_starts_one_run_at_a_time(api, workspace, scoped, agent, grant):
    grant(work=["read", "create"])
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


def test_a_run_committed_concurrently_blocks_the_second_message(scoped, user, agent, monkeypatch):
    """Another request can start a run between this request's check and its insert."""
    conversation = Conversation.objects.create(agent=agent, user=user)
    effective_policy = services.effective_policy

    def interleaved(**kwargs):
        Run.objects.create(
            user=user,
            agent=agent,
            conversation=conversation,
            permissions=[],
            tools=[],
            model_alias="default",
        )
        return effective_policy(**kwargs)

    monkeypatch.setattr("runs.services.effective_policy", interleaved)
    with pytest.raises(services.RunConflict):
        services.start_run(conversation=conversation, user_id=user.id, content="second")
    assert not Message.objects.filter(conversation=conversation).exists()


def test_changing_an_agents_connections_stops_its_active_runs(api, workspace, scoped, user, agent):
    conversation = Conversation.objects.create(agent=agent, user=user)
    _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    url = f"/api/workspaces/{workspace.id}/agents/{agent.id}"
    connection_ids = [str(c.id) for c in agent.connections.all()]
    renamed = post(api, url, {"name": "Renamed", "connection_ids": connection_ids}, method="put")
    assert renamed.status_code == 200
    run.refresh_from_db()
    assert run.status == Run.Status.QUEUED
    assert post(api, url, {"name": "Renamed", "connection_ids": []}, method="put").status_code == 200
    run.refresh_from_db()
    assert (run.status, run.error_code) == (Run.Status.CANCELLED, "agent_connections_changed")


def test_code_mode_from_an_older_client_is_ignored(api, workspace, agent):
    for value in (True, False):
        created = post(
            api, f"/api/workspaces/{workspace.id}/agents", {"name": "Scripted", "code_mode": value}
        )
        assert created.status_code == 201
        assert "code_mode" not in created.json()
    url = f"/api/workspaces/{workspace.id}/agents/{agent.id}"
    updated = post(api, url, {"name": agent.name, "code_mode": False}, method="put")
    assert updated.status_code == 200
    assert "code_mode" not in updated.json()


def test_an_agent_keeps_a_connection_that_needs_reconnecting(api, workspace, agent, connection):
    connection.status = Connection.Status.ERROR
    connection.save()
    url = f"/api/workspaces/{workspace.id}/agents/{agent.id}"
    ids = [str(connection.id)]
    assert post(api, url, {"name": "Renamed", "connection_ids": ids}, method="put").status_code == 200
    assert post(api, url, {"name": "Renamed", "connection_ids": []}, method="put").status_code == 200
    # Adding it back is adding a connection, which must work.
    assert post(api, url, {"name": "Renamed", "connection_ids": ids}, method="put").status_code == 422


def test_access_settings_are_validated(api, workspace, connection, todoist):
    url = f"/api/workspaces/{workspace.id}/connections/{connection.id}/access"
    access = api.get(url).json()
    assert access["grants"] == []
    assert access["kinds"] == [
        {
            "id": "project",
            "label": "Project",
            "actions": ["read", "create"],
            "wildcard": True,
            "hierarchical": False,
            "note": None,
            "listed": True,
            "browsable": False,
        }
    ]
    assert todoist.calls == []
    resources = api.get(f"{url}/resources?kind=project").json()
    assert resources["items"][0] == {
        "id": "work",
        "name": "Work",
        "actions": [],
        "inherited": [],
        "expandable": False,
    }
    # Projects do not nest, so there is nothing to browse into.
    assert api.get(f"{url}/resources?kind=project&parent=work").status_code == 422
    bad = [
        [{"kind": "project", "id": "work", "actions": ["create"]}],
        [{"kind": "project", "id": "elsewhere", "actions": ["read"]}],
        [{"kind": "project", "id": "work", "actions": ["delete"]}],
        [{"kind": "task", "id": "work", "actions": ["read"]}],
        [
            {"kind": "project", "id": "work", "actions": ["read"]},
            {"kind": "project", "id": "work", "actions": []},
        ],
    ]
    for changes in bad:
        assert post(api, url, {"changes": changes}, method="patch").status_code == 422, changes
    saved = post(
        api,
        url,
        {"changes": [{"kind": "project", "id": "work", "actions": ["read", "create"]}]},
        method="patch",
    )
    assert saved.status_code == 200
    assert saved.json()["grants"] == [
        {"kind": "project", "id": "work", "name": "Work", "actions": ["create", "read"]}
    ]


def test_connections_summarize_what_the_user_allows(api, workspace, connection, todoist):
    url = f"/api/workspaces/{workspace.id}/connections"
    assert api.get(url).json()[0]["allowed"] == []
    changes = [
        {"kind": "project", "id": "*", "actions": ["read"]},
        {"kind": "project", "id": "work", "actions": ["read", "create"]},
    ]
    assert post(api, f"{url}/{connection.id}/access", {"changes": changes}, method="patch").status_code == 200
    assert api.get(url).json()[0]["allowed"] == [
        {
            "kind": "project",
            "kind_label": "Project",
            "action": "read",
            "action_label": "Read tasks",
            "all": True,
            "count": 1,
            "names": ["Work"],
        },
        {
            "kind": "project",
            "kind_label": "Project",
            "action": "create",
            "action_label": "Create tasks",
            "all": False,
            "count": 1,
            "names": ["Work"],
        },
    ]


def test_agents_can_only_use_connections_of_their_user(api, workspace, other_user):
    with workspace_scope(other_user.personal_workspace.id):
        from connections.models import Connection

        foreign = Connection(provider="todoist", owner=other_user, label="M", external_account_id="m")
        foreign.set_credentials({"access_token": "x"})
        foreign.save()
    url = f"/api/workspaces/{workspace.id}/agents"
    response = post(api, url, {"name": "Sneaky", "connection_ids": [str(foreign.id)]})
    assert response.status_code == 422
