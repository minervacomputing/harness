import jsonschema
import pytest
from asgiref.sync import sync_to_async
from connector_runs import ceiling, claimed_run

from connections.models import Connection
from connectors import executor as executor_module
from connectors.base import OperationError
from connectors.executor import RESULT_SCHEMA
from conversations.models import Conversation
from permissions.models import Grant
from runs import services
from runs.models import Run, RunWrite
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def start(scoped, user, agent, todoist):
    """Start and claim a run with the grants in place at that moment; returns an executor."""
    return sync_to_async(lambda: claimed_run(scoped, user))


@pytest.fixture
def agrant(scoped, grant):
    def grant_(**projects):
        with workspace_scope(scoped.id):
            grant(**projects)

    return sync_to_async(grant_)


async def test_listing_only_returns_allowed_projects(agrant, start, todoist):
    await agrant(work=["read"])
    executor = await start()
    outcome = await executor.invoke("todoist_list_projects", {})
    assert [item["id"] for item in outcome.result["items"]] == ["work"]


async def test_reads_outside_the_grant_are_denied_before_the_provider_call(agrant, start, todoist):
    await agrant(work=["read"])
    executor = await start()
    with pytest.raises(OperationError) as denied:
        await executor.invoke("todoist_list_tasks", {"project_id": "private"})
    assert denied.value.code == "POLICY_DENIED"
    assert ("GET", "/tasks") not in todoist.calls


async def test_get_task_resolves_the_real_project_before_authorizing(agrant, start):
    await agrant(work=["read"])
    executor = await start()
    assert (await executor.invoke("todoist_get_task", {"task_id": "t1"})).result["count"] == 1
    for task_id in ["t2", "missing"]:
        with pytest.raises(OperationError) as denied:
            await executor.invoke("todoist_get_task", {"task_id": task_id})
        assert denied.value.code == "POLICY_DENIED"


async def test_strict_arguments(agrant, start):
    await agrant(work=["read"])
    executor = await start()
    with pytest.raises(OperationError) as invalid:
        await executor.invoke("todoist_list_tasks", {"project_id": "work", "connection_id": "other"})
    assert invalid.value.code == "INVALID_ARGUMENTS"
    with pytest.raises(OperationError) as unknown:
        await executor.invoke("github_list_repos", {})
    assert unknown.value.code == "UNKNOWN_OPERATION"


async def test_create_needs_create_permission(agrant, start):
    await agrant(work=["read"])
    assert "todoist_create_task" not in (await start()).context.tools
    await agrant(work=["read"], private=["read", "create"])
    executor = await start()
    with pytest.raises(OperationError) as denied:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "x"})
    assert denied.value.code == "POLICY_DENIED"


async def test_write_limit_and_deduplication(agrant, start, todoist):
    await agrant(work=["read", "create"])
    executor = await start()
    first = await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    again = await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert first.result == again.result
    assert todoist.calls.count(("POST", "/tasks")) == 1
    await executor.invoke("todoist_create_task", {"project_id": "work", "title": "b"})
    await executor.invoke("todoist_create_task", {"project_id": "work", "title": "c"})
    with pytest.raises(OperationError) as limited:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "d"})
    assert limited.value.code == "LIMIT_REACHED"


async def test_uncertain_write_pauses_further_writes(agrant, start, todoist):
    await agrant(work=["read", "create"])
    executor = await start()
    todoist.fail_writes = True
    with pytest.raises(OperationError) as uncertain:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert uncertain.value.code == "WRITE_UNCERTAIN"
    todoist.fail_writes = False
    with pytest.raises(OperationError) as paused:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "other"})
    assert paused.value.code == "WRITE_UNCERTAIN"


async def test_revoked_provider_token_marks_the_connection(agrant, start, todoist, connection):
    await agrant(work=["read", "create"])
    executor = await start()
    todoist.revoked = True
    with pytest.raises(OperationError) as refused:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert refused.value.code == "CONNECTION_UNAUTHORIZED"
    run = await Run.unscoped.aget(pk=executor.context.run_id)
    assert not run.writes_uncertain
    await connection.arefresh_from_db()
    assert connection.status == Connection.Status.ERROR


async def test_page_tokens_are_opaque_and_bound_to_the_query(agrant, start, todoist):
    await agrant(work=["read"], private=["read"])
    todoist.tasks += [{"id": f"w{i}", "project_id": "work", "content": f"t{i}"} for i in range(3)]
    todoist.page_size = 2
    executor = await start()
    page = await executor.invoke("todoist_list_tasks", {"project_id": "work", "limit": 2})
    token = page.result["next_cursor"]
    assert token not in {"2", ""}
    jsonschema.validate(page.result, RESULT_SCHEMA)
    nxt = await executor.invoke("todoist_list_tasks", {"project_id": "work", "limit": 2, "cursor": token})
    assert nxt.result["count"] == 2
    with pytest.raises(OperationError) as replay:
        await executor.invoke("todoist_list_tasks", {"project_id": "private", "limit": 2, "cursor": token})
    assert replay.value.code == "INVALID_CURSOR"


async def test_ended_runs_cannot_call_tools(agrant, start):
    await agrant(work=["read"])
    executor = await start()
    await Run.unscoped.filter(pk=executor.context.run_id).aupdate(status=Run.Status.CANCELLED)
    with pytest.raises(OperationError) as ended:
        await executor.invoke("todoist_list_projects", {})
    assert ended.value.code == "RUN_ENDED"


async def test_write_applied_before_revocation_is_still_recorded(agrant, start, todoist, monkeypatch):
    await agrant(work=["read", "create"])
    executor = await start()
    valid = services.is_token_valid
    # The run is revoked while the provider applies the write.
    monkeypatch.setattr(
        executor_module,
        "is_token_valid",
        lambda run_id: valid(run_id) and ("POST", "/tasks") not in todoist.calls,
    )
    with pytest.raises(OperationError) as ended:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert ended.value.code == "RUN_ENDED"
    write = await RunWrite.unscoped.aget(run_id=executor.context.run_id)
    assert write.status == RunWrite.Status.SUCCEEDED
    assert write.result["count"] == 1


async def test_revocation_after_reserving_a_write_stops_the_provider_call(
    agrant, start, todoist, monkeypatch
):
    await agrant(work=["read", "create"])
    executor = await start()
    valid = services.is_token_valid
    monkeypatch.setattr(
        executor_module,
        "is_token_valid",
        lambda run_id: valid(run_id) and Run.unscoped.get(pk=run_id).write_count == 0,
    )
    with pytest.raises(OperationError) as ended:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert ended.value.code == "RUN_ENDED"
    assert ("POST", "/tasks") not in todoist.calls


async def test_required_actions_are_enforced_after_layers_intersect(
    scoped, connection, agrant, start, todoist
):
    await ceiling("todoist", "project", "work", Grant.Effect.DENY)
    await agrant(work=["read", "create"], private=["read", "create"])
    executor = await start()
    with pytest.raises(OperationError) as denied:
        await executor.invoke("todoist_create_task", {"project_id": "work", "title": "a"})
    assert denied.value.code == "POLICY_DENIED"
    assert ("POST", "/tasks") not in todoist.calls


def test_permission_changes_revoke_active_runs(scoped, user, agent, grant):
    grant(work=["read"])
    conversation = Conversation.objects.create(agent=agent, user=user)
    _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    grant(work=["read", "create"])
    run.refresh_from_db()
    assert run.status == Run.Status.CANCELLED
    assert run.error_code == "permissions_changed"
