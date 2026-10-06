import socket
import threading
import uuid
from datetime import timedelta

import psycopg
import pytest
from django.db import connection, transaction
from django.utils import timezone

from conversations.models import Conversation
from gateway import views
from minerva.config import config
from runs import services
from runs.models import Run, RunEvent, RunWrite
from runs.sandbox.base import SandboxError, SandboxInfo, SandboxStatus
from runs.supervisor import PROVISIONING_TIMEOUT, QueueListener, Supervisor
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db


class FakeProvider:
    name = "fake"

    def __init__(self, sandboxes: list[SandboxInfo] | None = None) -> None:
        self.items = sandboxes or []
        self.stopped: list[dict] = []
        self.started: list[dict] = []
        # Sandboxes not listed here are running.
        self.states: dict[str, str] = {}
        self.on_start = None
        self.on_stop = None

    def sandboxes(self) -> list[SandboxInfo]:
        return self.items

    def start(self, run_id, image, env, limits, command=None, *, attempt=1) -> dict:
        if self.on_start:
            self.on_start()
        self.started.append({"run_id": run_id, "env": env, "attempt": attempt})
        return {"id": f"{run_id}-{attempt}"}

    def status(self, handle: dict) -> SandboxStatus:
        return SandboxStatus(self.states.get(handle["id"], "running"))  # type: ignore[arg-type]

    def stop(self, handle: dict) -> None:
        if self.on_stop:
            self.on_stop()
        self.stopped.append(handle)


def supervisor_with(provider: FakeProvider) -> Supervisor:
    supervisor = Supervisor.__new__(Supervisor)
    supervisor.cfg = config()
    supervisor.provider = provider
    return supervisor


def test_only_untracked_sandboxes_past_their_grace_period_are_removed(scoped, user, agent):
    with workspace_scope(scoped.id):
        conversation = Conversation.objects.create(agent=agent, user=user)
        _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    now = timezone.now()
    long_ago = now - timedelta(hours=1)
    provider = FakeProvider(
        [
            SandboxInfo(str(run.id), {"id": "tracked"}, False, long_ago),
            SandboxInfo(str(uuid.uuid4()), {"id": "orphan-exited"}, False, long_ago),
            SandboxInfo(str(uuid.uuid4()), {"id": "just-exited"}, False, now),
            SandboxInfo(str(uuid.uuid4()), {"id": "orphan-running"}, True, long_ago),
            SandboxInfo(str(uuid.uuid4()), {"id": "recent-running"}, True, now - timedelta(seconds=30)),
            SandboxInfo("not-a-uuid", {"id": "foreign"}, False, long_ago),
        ]
    )
    supervisor_with(provider).collect_orphans()
    assert {handle["id"] for handle in provider.stopped} == {"orphan-exited", "orphan-running", "foreign"}


def test_sandboxes_of_finished_runs_without_a_handle_are_removed(scoped, user, agent):
    """The database can fail between starting a sandbox and saving its handle."""
    runs = []
    for _ in range(2):
        with workspace_scope(scoped.id):
            conversation = Conversation.objects.create(agent=agent, user=user)
            _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
        services.finish(run.id, Run.Status.TIMED_OUT)
        runs.append(run)
    unsaved, releasing = runs
    Run.unscoped.filter(pk=releasing.pk).update(sandbox_handle={"id": "releasing"})
    long_ago = timezone.now() - timedelta(hours=1)
    provider = FakeProvider(
        [
            SandboxInfo(str(unsaved.id), {"id": "unsaved"}, False, long_ago),
            SandboxInfo(str(releasing.id), {"id": "releasing"}, False, long_ago),
        ]
    )
    supervisor_with(provider).collect_orphans()
    assert provider.stopped == [{"id": "unsaved"}]


class DroppedConnection:
    """A LISTEN connection whose server went away: the socket is readable, but reading fails."""

    def __init__(self) -> None:
        self.ours, self.theirs = socket.socketpair()
        self.theirs.send(b"x")
        self.closed = False

    def fileno(self) -> int:
        return self.ours.fileno()

    def notifies(self, timeout: float):
        raise psycopg.OperationalError("server closed the connection unexpectedly")

    def close(self) -> None:
        self.closed = True
        self.ours.close()
        self.theirs.close()


def test_queue_listener_survives_database_outages(monkeypatch):
    monkeypatch.setattr("runs.supervisor.time.sleep", lambda seconds: None)
    dropped = DroppedConnection()
    attempts: list[int] = []

    def connect():
        attempts.append(1)
        if len(attempts) == 1:
            return dropped
        raise psycopg.OperationalError("connection refused")

    listener = QueueListener(connect)
    listener.wait(0.1)
    assert dropped.closed
    assert listener.conn is None
    listener.wait(0.1)
    assert listener.backoff == 2.0
    listener.wait(0.1)
    assert len(attempts) == 2, "no reconnect attempt inside the backoff window"


@pytest.fixture
def dead(claimed) -> tuple[Run, str, FakeProvider]:
    """A claimed run whose worker has exited, and the provider that ran it."""
    run, token = claimed
    Run.unscoped.filter(pk=run.id).update(sandbox_handle={"id": "first"}, worker_seq=5)
    provider = FakeProvider()
    provider.states["first"] = "exited"
    return run, token, provider


def test_a_dead_worker_is_replaced_by_one_that_resumes_the_run(dead):
    run, token, provider = dead
    supervisor_with(provider).reconcile()
    [started] = provider.started
    assert started["attempt"] == 2
    assert started["env"]["RUN_ID"] == str(run.id)
    assert provider.stopped == [{"id": "first"}]
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.attempt, stored.status, stored.worker_seq) == (2, Run.Status.PROVISIONING, 0)
    assert stored.sandbox_handle == {"id": f"{run.id}-2"}
    assert stored.attempt_started_at > run.attempt_started_at
    assert stored.deadline == run.deadline
    # Only the new worker's token is valid.
    assert services.run_for_token(token) is None
    assert services.run_for_token(started["env"]["RUN_TOKEN"]).id == run.id
    last = RunEvent.unscoped.filter(run=run).order_by("-seq").first()
    assert (last.type, last.data) == (RunEvent.Type.STATUS, {"status": "provisioning", "attempt": 2})


def test_a_run_is_restarted_twice_at_most(dead):
    run, _, provider = dead
    supervisor = supervisor_with(provider)
    for attempt in (2, 3):
        supervisor.reconcile()
        assert Run.unscoped.get(pk=run.id).attempt == attempt
        provider.states[f"{run.id}-{attempt}"] = "missing"
    supervisor.reconcile()
    assert [started["attempt"] for started in provider.started] == [2, 3]
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.attempt, stored.status, stored.error_code) == (3, Run.Status.FAILED, "worker_exited")


def test_a_dead_worker_that_cannot_be_removed_is_still_replaced(dead):
    run, _, provider = dead

    def refuse():
        raise SandboxError("busy")

    provider.on_stop = refuse
    supervisor_with(provider).reconcile()
    assert [started["attempt"] for started in provider.started] == [2]
    assert Run.unscoped.get(pk=run.id).sandbox_handle == {"id": f"{run.id}-2"}


def test_a_running_worker_is_left_alone(claimed):
    run, _ = claimed
    Run.unscoped.filter(pk=run.id).update(sandbox_handle={"id": "first"})
    provider = FakeProvider()
    supervisor_with(provider).reconcile()
    assert (provider.started, provider.stopped) == ([], [])
    assert Run.unscoped.get(pk=run.id).attempt == 1


def test_a_restart_waits_until_the_dead_workers_write_has_settled(dead):
    run, _, provider = dead
    write = RunWrite.unscoped.create(workspace_id=run.workspace_id, run=run, key="k")
    supervisor = supervisor_with(provider)
    assert services.restart(run.id, 1) is services.Restart.WAIT
    supervisor.reconcile()
    assert provider.started == []
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.attempt, stored.status) == (1, Run.Status.PROVISIONING)
    RunWrite.unscoped.filter(pk=write.pk).update(status=RunWrite.Status.SUCCEEDED)
    supervisor.reconcile()
    assert [started["attempt"] for started in provider.started] == [2]


def test_a_lost_write_lets_the_restart_go_ahead(dead):
    run, _, provider = dead
    lost = timezone.now() - services.LOST_WRITE_GRACE - timedelta(seconds=1)
    RunWrite.unscoped.create(workspace_id=run.workspace_id, run=run, key="k", deadline_at=lost)
    services.sweep_lost_writes()
    assert RunWrite.unscoped.get(run=run).status == RunWrite.Status.UNCERTAIN
    supervisor_with(provider).reconcile()
    assert Run.unscoped.get(pk=run.id).attempt == 2


@pytest.mark.django_db(transaction=True)
def test_a_restart_waits_for_a_write_claimed_at_the_same_time(dead):
    """A write is claimed under the run lock (Executor._dispatch), so the restart either sees it or happens
    first, in which case the claim is refused for the replaced attempt."""
    run, _, _ = dead
    locked, claimed = threading.Event(), threading.Event()

    def claim():
        try:
            with transaction.atomic():
                Run.unscoped.select_for_update().get(pk=run.id)
                locked.set()
                RunWrite.unscoped.create(workspace_id=run.workspace_id, run=run, key="k")
                claimed.wait(0.2)
        finally:
            connection.close()

    thread = threading.Thread(target=claim)
    thread.start()
    assert locked.wait(5)
    assert services.restart(run.id, 1) is services.Restart.WAIT
    thread.join()
    assert Run.unscoped.get(pk=run.id).attempt == 1


@pytest.mark.parametrize("reason", ["restarts", "time"])
def test_a_dead_worker_fails_the_run_once_it_cannot_be_restarted(dead, reason):
    run, _, provider = dead
    match reason:
        case "restarts":
            Run.unscoped.filter(pk=run.id).update(attempt=services.MAX_RESTARTS + 1)
        case "time":
            remaining = services.RESTART_MIN_REMAINING - timedelta(seconds=1)
            Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() + remaining)
    supervisor_with(provider).reconcile()
    assert provider.started == []
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.status, stored.error_code) == (Run.Status.FAILED, "worker_exited")


def test_a_run_without_a_deadline_is_restarted(dead):
    run, _, provider = dead
    Run.unscoped.filter(pk=run.id).update(deadline=None)
    supervisor_with(provider).reconcile()
    assert len(provider.started) == 1
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.attempt, stored.deadline) == (2, None)


def test_only_the_current_attempt_of_an_active_run_is_restarted(claimed):
    run, _ = claimed
    assert services.restart(run.id, 2) is services.Restart.REFUSED
    services.finish(run.id, Run.Status.CANCELLED)
    assert services.restart(run.id, 1) is services.Restart.REFUSED
    assert services.restart(uuid.uuid4(), 1) is services.Restart.REFUSED
    assert Run.unscoped.get(pk=run.id).attempt == 1


def test_a_replaced_attempt_does_not_fail_the_run(dead):
    """The run was restarted by another supervisor after this one listed it."""
    run, _, provider = dead
    stale = Run.unscoped.get(pk=run.id)
    Run.unscoped.filter(pk=run.id).update(attempt=services.MAX_RESTARTS + 1)
    supervisor = supervisor_with(provider)
    assert services.restart(run.id, stale.attempt) is services.Restart.REFUSED
    assert not services.finish(run.id, Run.Status.FAILED, code="worker_exited", attempt=stale.attempt)
    assert Run.unscoped.get(pk=run.id).status == Run.Status.PROVISIONING
    supervisor.reconcile()
    assert Run.unscoped.get(pk=run.id).status == Run.Status.FAILED


def test_a_new_worker_that_cannot_start_fails_the_run(dead):
    run, _, provider = dead

    def refuse():
        raise SandboxError("no capacity")

    provider.on_start = refuse
    supervisor_with(provider).reconcile()
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.attempt, stored.status, stored.error_code) == (2, Run.Status.FAILED, "sandbox_failed")


def test_a_worker_whose_attempt_was_replaced_while_it_started_is_stopped(dead):
    run, _, provider = dead
    provider.on_start = lambda: Run.unscoped.filter(pk=run.id).update(attempt=3)
    supervisor_with(provider).reconcile()
    assert provider.stopped == [{"id": f"{run.id}-2"}, {"id": "first"}]
    assert Run.unscoped.get(pk=run.id).sandbox_handle is None


def test_each_attempt_has_the_provisioning_timeout_to_ask_for_its_spec(claimed):
    run, _ = claimed
    supervisor = supervisor_with(FakeProvider())
    # Restarted just now, late in a run that was claimed long ago.
    Run.unscoped.filter(pk=run.id).update(
        attempt=2, attempt_started_at=timezone.now(), deadline=timezone.now() + timedelta(seconds=60)
    )
    supervisor.enforce_deadlines()
    assert Run.unscoped.get(pk=run.id).status == Run.Status.PROVISIONING
    late = timezone.now() - PROVISIONING_TIMEOUT - timedelta(seconds=1)
    Run.unscoped.filter(pk=run.id).update(attempt_started_at=late)
    supervisor.enforce_deadlines()
    stored = Run.unscoped.get(pk=run.id)
    assert (stored.status, stored.error_code) == (Run.Status.FAILED, "worker_silent")


def test_a_worker_that_asked_for_its_spec_just_in_time_is_not_failed(claimed, monkeypatch):
    run, _ = claimed
    late = timezone.now() - PROVISIONING_TIMEOUT - timedelta(seconds=1)
    Run.unscoped.filter(pk=run.id).update(attempt_started_at=late)
    finish = services.finish

    def started_meanwhile(*args, **kwargs):
        views._start(run.id, 1)
        return finish(*args, **kwargs)

    monkeypatch.setattr(services, "finish", started_meanwhile)
    supervisor_with(FakeProvider()).enforce_deadlines()
    assert Run.unscoped.get(pk=run.id).status == Run.Status.RUNNING
