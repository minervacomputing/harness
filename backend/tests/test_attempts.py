"""A run's worker can be replaced by a new attempt while the old one is still connected. Work the old attempt
starts is refused; work it had already started (a write in flight) is still recorded."""

import asyncio
from datetime import timedelta
from types import SimpleNamespace

import httpx
import mcp_types as types
import pytest
from asgiref.sync import sync_to_async
from django.utils import timezone

from connectors.base import OperationError
from connectors.executor import Executor, RunContext
from connectors.todoist.client import TodoistClient
from connectors.todoist.connector import TodoistConnector
from conversations.models import Conversation, Message
from gateway import relay, views
from gateway.mcp import ATTEMPT_SCOPE_KEY, RUN_SCOPE_KEY, call_tool
from gateway.views import WorkerEvent
from runs import services
from runs.models import Run, RunEvent, RunWrite
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db(transaction=True)


def replace(run: Run) -> None:
    """A new attempt takes over the run, as a restart would."""
    Run.unscoped.filter(pk=run.id).update(attempt=2)


def mcp_ctx(run: Run, attempt: int) -> SimpleNamespace:
    return SimpleNamespace(request=SimpleNamespace(scope={RUN_SCOPE_KEY: run.id, ATTEMPT_SCOPE_KEY: attempt}))


def list_tasks() -> types.CallToolRequestParams:
    return types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "work"})


def create_task(title: str) -> types.CallToolRequestParams:
    return types.CallToolRequestParams(
        name="todoist_create_task", arguments={"project_id": "work", "title": title}
    )


def tool_calls(run: Run) -> list[dict]:
    return [event.data for event in RunEvent.unscoped.filter(run=run, type="tool_call").order_by("seq")]


@pytest.fixture
def writer(scoped, user, agent, grant, todoist) -> Run:
    """A claimed run that may create tasks in the work project."""
    grant(work=["read", "create"])
    with workspace_scope(scoped.id):
        conversation = Conversation.objects.create(agent=agent, user=user)
        services.start_run(conversation=conversation, user_id=user.id, content="Add a task")
    [(run, _)] = services.claim_queued(1)
    return run


def test_an_attempts_event_is_appended_only_while_it_is_current(claimed):
    run, _ = claimed
    assert services.append_event(run.id, RunEvent.Type.PHASE, {"text": "a"}, attempt=1) is not None
    replace(run)
    assert services.append_event(run.id, RunEvent.Type.PHASE, {"text": "b"}, attempt=1) is None
    assert services.append_event(run.id, RunEvent.Type.PHASE, {"text": "c"}, attempt=2) is not None
    Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() - timedelta(seconds=1))
    assert services.append_event(run.id, RunEvent.Type.PHASE, {"text": "d"}, attempt=2) is None
    # The backend's own events do not depend on an attempt.
    assert services.append_event(run.id, RunEvent.Type.PHASE, {"text": "e"}) is not None
    events = list(RunEvent.unscoped.filter(run=run, type="phase").order_by("seq"))
    assert [event.data["text"] for event in events] == ["a", "c", "e"]
    # A refused event takes no sequence number.
    seqs = list(RunEvent.unscoped.filter(run=run).order_by("seq").values_list("seq", flat=True))
    assert seqs == list(range(1, len(seqs) + 1))
    assert Run.unscoped.get(pk=run.id).event_seq == len(seqs)


def test_a_replaced_attempt_can_neither_fail_nor_complete_the_run(claimed):
    run, _ = claimed
    replace(run)
    assert not services.finish(run.id, Run.Status.FAILED, code="worker_failed", attempt=1)
    assert not services.complete(run.id, "stale answer", attempt=1)
    assert Run.unscoped.get(pk=run.id).status == Run.Status.PROVISIONING
    answers = Message.unscoped.filter(run=run, role=Message.Role.ASSISTANT)
    assert not answers.exists()
    assert services.complete(run.id, "answer", attempt=2)
    assert Run.unscoped.get(pk=run.id).status == Run.Status.COMPLETED
    assert list(answers.values_list("content", flat=True)) == ["answer"]


def test_a_replaced_attempts_worker_events_are_dropped(claimed):
    run, _ = claimed
    replace(run)
    # `run` was authenticated as attempt 1.
    views._apply_events(
        run,
        [
            WorkerEvent(seq=1, type="phase", text="stale"),
            WorkerEvent(seq=2, type="failed", text="stale"),
            WorkerEvent(seq=3, type="completed", text="stale"),
        ],
    )
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.status, stored.worker_seq) == (Run.Status.PROVISIONING, 0)
    assert not RunEvent.unscoped.filter(run=run, type__in=["phase", "message"]).exists()
    # The new attempt's worker numbers its events from 1.
    run.attempt = 2
    views._apply_events(run, [WorkerEvent(seq=1, type="phase", text="current")])
    assert [event.data["text"] for event in RunEvent.unscoped.filter(run=run, type="phase")] == ["current"]


def test_an_attempt_starts_once_and_keeps_the_runs_first_start_time(claimed):
    run, _ = claimed
    replace(run)
    views._start(run.id, 1)
    assert Run.unscoped.get(pk=run.id).status == Run.Status.PROVISIONING
    first_start = timezone.now() - timedelta(minutes=1)
    Run.unscoped.filter(pk=run.id).update(started_at=first_start)
    views._start(run.id, 2)
    views._start(run.id, 2)
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.status, stored.started_at) == (Run.Status.RUNNING, first_start)
    statuses = RunEvent.unscoped.filter(run=run, type="status", data__status="running")
    assert statuses.count() == 1


async def test_a_replaced_attempt_cannot_call_tools(claimed, todoist):
    run, _ = claimed
    await sync_to_async(replace)(run)
    result = await call_tool(mcp_ctx(run, 1), list_tasks())
    assert result.is_error
    assert result.content[0].text == "This run is no longer active."
    assert (await Run.unscoped.aget(pk=run.id)).tool_calls == 0
    assert await sync_to_async(tool_calls)(run) == []
    assert ("GET", "/tasks") not in todoist.calls
    # The current attempt can.
    assert not (await call_tool(mcp_ctx(run, 2), list_tasks())).is_error


async def test_a_replaced_attempts_queued_call_does_nothing_and_is_not_shown(claimed, todoist):
    run, _ = claimed
    context = RunContext.from_run(run)
    # The call was counted, then waited for a slot while its attempt was replaced.
    await sync_to_async(replace)(run)
    for tool in ("todoist_list_tasks", "no_such_tool"):
        with pytest.raises(OperationError) as ended:
            await Executor(context).invoke(tool, {"project_id": "work"})
        assert ended.value.code == "RUN_ENDED"
    unknown = types.CallToolRequestParams(name="no_such_tool", arguments={})
    assert (await call_tool(mcp_ctx(run, 1), unknown)).is_error
    assert await sync_to_async(tool_calls)(run) == []
    assert ("GET", "/tasks") not in todoist.calls


def test_a_replaced_attempt_cannot_reserve_a_write(writer):
    executor = Executor(RunContext.from_run(writer))
    replace(writer)
    with pytest.raises(OperationError) as ended:
        executor._dispatch("key")
    assert ended.value.code == "RUN_ENDED"
    assert not RunWrite.unscoped.filter(run=writer).exists()


async def test_a_write_in_flight_when_its_attempt_is_replaced_is_recorded_and_not_repeated(
    writer, todoist, monkeypatch
):
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            # The worker dies and a new attempt takes over while the provider applies the write.
            await Run.unscoped.filter(pk=writer.id).aupdate(attempt=2)
        return todoist.handler(request)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        TodoistConnector, "client", lambda self, token: TodoistClient(token, transport=transport)
    )
    first = await call_tool(mcp_ctx(writer, 1), create_task("a"))
    assert not first.is_error
    write = await RunWrite.unscoped.aget(run_id=writer.id)
    assert write.status == RunWrite.Status.SUCCEEDED
    # The new attempt's model asks for the same write; the recorded one answers it.
    again = await call_tool(mcp_ctx(writer, 2), create_task("a"))
    assert not again.is_error
    assert again.structured_content == first.structured_content
    assert todoist.calls.count(("POST", "/tasks")) == 1
    events = await sync_to_async(tool_calls)(writer)
    assert [(event["decision"], event.get("repeat")) for event in events] == [
        ("allowed", None),
        ("allowed", True),
    ]
    assert events[0]["write"] == events[1]["write"] != write.key


def test_a_replaced_attempt_cannot_make_a_model_call_or_stream_text(claimed):
    run, _ = claimed
    replace(run)
    assert not relay._count_model_call(run.id, 1)
    relay._publish(run.id, 1, "c1", [("reasoning", "stale"), ("text", "stale")])
    assert Run.unscoped.get(pk=run.id).model_calls == 0
    assert not RunEvent.unscoped.filter(run=run, type__in=["text_delta", "reasoning_delta"]).exists()
    assert relay._count_model_call(run.id, 2)
    relay._publish(run.id, 2, "c2", [("text", "current")])
    texts = RunEvent.unscoped.filter(run=run, type="text_delta").values_list("data__text", flat=True)
    assert list(texts) == ["current"]


async def test_a_replaced_attempts_model_call_is_cut_short(claimed, monkeypatch):
    run, _ = claimed
    monkeypatch.setattr(relay, "REVOCATION_CHECK_SECONDS", 0.01)
    waiting = asyncio.create_task(asyncio.sleep(10))
    await sync_to_async(replace)(run)
    assert not await relay._until_run_ends(run.id, 1, waiting)
    assert waiting.cancelled()
    finished = asyncio.create_task(asyncio.sleep(0.05))
    assert await relay._until_run_ends(run.id, 2, finished)
