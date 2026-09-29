import socket
import uuid
from datetime import timedelta

import psycopg
import pytest
from django.utils import timezone

from conversations.models import Conversation
from minerva.config import config
from runs import services
from runs.models import Run
from runs.sandbox.base import SandboxInfo
from runs.supervisor import QueueListener, Supervisor
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db


class FakeProvider:
    name = "fake"

    def __init__(self, sandboxes: list[SandboxInfo]) -> None:
        self.items = sandboxes
        self.stopped: list[dict] = []

    def sandboxes(self) -> list[SandboxInfo]:
        return self.items

    def stop(self, handle: dict) -> None:
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
