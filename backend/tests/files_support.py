"""Helpers for the agent files tests."""

import hashlib
import threading
import time
from datetime import timedelta
from pathlib import Path

from django.db import connection, transaction
from django.utils import timezone

from agents.models import Agent
from conversations.models import Conversation
from files import store
from files.manifest import Manifest, parse
from files.models import Blob, FolderVersion, LooseObject, WorkspaceStorage
from runs.models import Run
from workspaces.tenancy import workspace_scope


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def upload(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / f"upload-{sha(data)}"
    path.write_bytes(data)
    return path


def put(
    tmp_path: Path, workspace_id, data: bytes, *, run: Run | None = None, before=None, after=None
) -> Blob:
    """Uploads `data` as the gateway will: charge the run, record, grant. `before` and `after` run in the upload's
    transaction around record()."""

    def transact(record):
        if before:
            before()
        if run is not None:
            store.charge_run_upload(run.id, len(data))
        blob = record()
        if run is not None:
            store.grant(run, blob)
        if after:
            after()
        return blob

    return store.store_blob(workspace_id, sha(data), len(data), upload(tmp_path, data), transact)


def conversation_in(workspace, user) -> Conversation:
    with workspace_scope(workspace.id):
        return Conversation.objects.create(agent=Agent.objects.get(), user=user)


def run_in(conversation: Conversation, status=Run.Status.RUNNING) -> Run:
    return Run.unscoped.create(
        workspace_id=conversation.workspace_id,
        user=conversation.user,
        agent=conversation.agent,
        conversation=conversation,
        permissions={},
        tools=[],
        model_alias="default",
        status=status,
    )


def manifest(**files: bytes) -> Manifest:
    """A manifest of files at the folder root, by name."""
    entries = [{"path": name, "sha256": sha(data), "mode": 0o644, "mtime": 0} for name, data in files.items()]
    return parse({"files": entries, "dirs": []}, max_entries=10_000)


def version(
    conversation: Conversation, kind="turn", *, parent=None, run=None, **files: bytes
) -> FolderVersion:
    """Records a version holding `files` (whose blobs must exist) in a transaction of its own."""
    with transaction.atomic():
        return store.record_version(conversation, kind, manifest(**files), parent=parent, run=run)


def age(*blobs: Blob, hours: float = 2) -> None:
    """Makes the blobs look unused for `hours`."""
    when = timezone.now() - timedelta(hours=hours)
    Blob.unscoped.filter(pk__in=[blob.pk for blob in blobs]).update(last_used_at=when)


def make_due() -> None:
    """Makes every loose object due for deletion."""
    LooseObject.objects.update(delete_after=timezone.now() - timedelta(seconds=1))


def counted(workspace) -> int | None:
    return WorkspaceStorage.objects.filter(workspace=workspace).values_list("bytes", flat=True).first()


def stored_keys(location: Path) -> list[str]:
    return sorted(path.relative_to(location).as_posix() for path in location.rglob("*") if path.is_file())


def wait_until_blocked(waiting: int = 1, timeout: float = 5.0) -> None:
    """Waits until `waiting` other connections wait for a lock."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with connection.cursor() as cursor:
            # Within a transaction, pg_stat_activity is read once and kept unless the snapshot is cleared.
            cursor.execute("SELECT pg_stat_clear_snapshot()")
            cursor.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'"
                " AND datname = current_database() AND pid <> pg_backend_pid()"
            )
            if cursor.fetchone()[0] >= waiting:
                return
        time.sleep(0.02)
    raise AssertionError(f"Fewer than {waiting} connection(s) waited for a lock.")


class Background:
    """Runs `fn` in a thread with its own database connection. `result()` joins it and returns or re-raises."""

    def __init__(self, fn, *args, **kwargs) -> None:
        self._outcome: dict = {}

        def target():
            try:
                self._outcome["value"] = fn(*args, **kwargs)
            except BaseException as error:
                self._outcome["error"] = error
            finally:
                connection.close()

        self._thread = threading.Thread(target=target)
        self._thread.start()

    def result(self, timeout: float = 10.0):
        self._thread.join(timeout)
        assert not self._thread.is_alive(), "The background call did not finish."
        if "error" in self._outcome:
            raise self._outcome["error"]
        return self._outcome["value"]
