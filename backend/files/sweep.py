"""Garbage collection of agent files, run by the supervisor in a background thread.

Each phase works in batches, each batch its own short transaction, until it runs out of work or the time budget.
A batch that fails (a lock it would wait for, a reference that appeared meanwhile) is left for the next sweep.

1. Checkpoints of finished runs (or of none) that nothing refers to.
2. The upload grants (RunBlob) of finished runs.
3. Blobs that no version or grant names, unused for an hour.
4. Loose objects that are due: deleted from storage, and once more a day later.
"""

import logging
import time
from contextlib import contextmanager

from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Exists, OuterRef, Q, RestrictedError

from conversations.models import Conversation
from files.models import Blob, FolderVersion, RunBlob
from files.store import storage
from runs.models import Run

log = logging.getLogger("minerva.files")
BATCH = 100
FINISHED = [status for status in Run.Status if status not in Run.ACTIVE]

# The blobs are locked first, then the references checked again in a new statement, whose snapshot sees every
# reference committed before the locks were granted. Whatever refers to a blob later waits for the locks and then
# finds the row gone. The counters the deletion trigger updates are locked without waiting, so the sweep never
# waits for a transaction (such as a workspace's deletion) that may be waiting for its blobs.
UNNAMED = """
    NOT EXISTS (SELECT 1 FROM files_runblob grant_ WHERE grant_.blob_id = b.id)
    AND NOT EXISTS (
        SELECT 1 FROM files_folderversion v
        WHERE v.workspace_id = b.workspace_id AND v.hashes @> ARRAY[b.sha256]::varchar(64)[]
    )
"""
LOCK_BLOBS = f"""
    SELECT b.id, b.workspace_id FROM files_blob b
    WHERE b.last_used_at < clock_timestamp() - interval '1 hour' AND {UNNAMED}
    ORDER BY b.last_used_at LIMIT %s FOR UPDATE OF b SKIP LOCKED
"""  # noqa: S608 (constants only)
LOCK_COUNTERS = """
    SELECT 1 FROM files_workspacestorage WHERE workspace_id = ANY(%s) ORDER BY workspace_id FOR UPDATE NOWAIT
"""
DELETE_BLOBS = f"DELETE FROM files_blob b WHERE b.id = ANY(%s) AND {UNNAMED}"  # noqa: S608 (constants only)

# A lease keeps other sweeps off a row while this one deletes the object, and marks the row as taken for good:
# an upload can no longer claim it.
LEASE_LOOSE = """
    UPDATE files_looseobject SET delete_after = clock_timestamp() + interval '10 minutes', leases = leases + 1
    WHERE key IN (
        SELECT key FROM files_looseobject WHERE delete_after <= clock_timestamp()
        ORDER BY delete_after LIMIT %s FOR UPDATE SKIP LOCKED
    )
    RETURNING key, leases, deletions
"""


def sweep(budget_seconds: float = 30.0) -> dict[str, int]:
    """Runs every phase until it is done or the budget is spent. Returns how much each phase removed."""
    if connection.in_atomic_block:
        raise RuntimeError("The sweep commits batch by batch and writes to storage outside transactions.")
    deadline = time.monotonic() + budget_seconds
    removed = {}
    for name, phase in (
        ("checkpoints", _checkpoints),
        ("grants", _grants),
        ("blobs", _blobs),
        ("loose", _loose),
    ):
        removed[name] = 0
        while time.monotonic() < deadline:
            try:
                count, more = phase()
            except DatabaseError as error:
                log.info("Files sweep: %s phase stopped (%s); retrying next sweep", name, error)
                break
            removed[name] += count
            if not more:
                break
    return removed


@contextmanager
def _batch():
    """A transaction that gives up on a lock it would wait long for, rather than hold up the sweep."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '5s'")
        yield


def _checkpoints() -> tuple[int, bool]:
    referenced = Exists(Conversation.unscoped.filter(folder=OuterRef("pk"))) | Exists(
        Run.unscoped.filter(
            Q(base_version=OuterRef("pk")) | Q(checkpoint=OuterRef("pk")) | Q(result_version=OuterRef("pk"))
        )
    )
    ids = list(
        FolderVersion.unscoped.filter(kind=FolderVersion.Kind.CHECKPOINT)
        .filter(Q(run__isnull=True) | Q(run__status__in=FINISHED))
        .filter(~referenced)
        .order_by("created_at")
        .values_list("pk", flat=True)[:BATCH]
    )
    try:
        with _batch():
            deleted = _delete_checkpoints(ids)
    except RestrictedError, IntegrityError:
        # Something started to refer to one of them (checked again at commit); the others go one by one.
        deleted = 0
        for pk in ids:
            try:
                with _batch():
                    count = _delete_checkpoints([pk])
            except RestrictedError, IntegrityError:
                continue
            deleted += count
    return deleted, len(ids) == BATCH and deleted > 0


def _delete_checkpoints(ids) -> int:
    # The kind is checked again: publishing turns a run's checkpoint into a turn version.
    _, counts = FolderVersion.unscoped.filter(pk__in=ids, kind=FolderVersion.Kind.CHECKPOINT).delete()
    return counts.get(FolderVersion._meta.label, 0)


def _grants() -> tuple[int, bool]:
    with _batch():
        ids = list(RunBlob.unscoped.filter(run__status__in=FINISHED).values_list("pk", flat=True)[:BATCH])
        deleted, _ = RunBlob.unscoped.filter(pk__in=ids).delete()
    return deleted, len(ids) == BATCH


def _blobs() -> tuple[int, bool]:
    with _batch(), connection.cursor() as cursor:
        cursor.execute(LOCK_BLOBS, [BATCH])
        rows = cursor.fetchall()
        if not rows:
            return 0, False
        cursor.execute(LOCK_COUNTERS, [sorted({workspace_id for _, workspace_id in rows})])
        cursor.execute(DELETE_BLOBS, [[pk for pk, _ in rows]])
        deleted = cursor.rowcount
    return deleted, len(rows) == BATCH


def _loose() -> tuple[int, bool]:
    with _batch(), connection.cursor() as cursor:
        cursor.execute(LEASE_LOOSE, [BATCH])
        leased = cursor.fetchall()
    finished = 0
    for key, lease, deletions in leased:
        if Blob.unscoped.filter(storage_key=key).exists():
            # Cannot happen: a key is claimed (its loose row deleted) in the transaction that records its blob.
            log.error("Files sweep: the loose object %s is named by a blob; keeping the object", key)
            _finish(key, lease)
            continue
        try:
            storage().delete(key)
        except Exception:
            log.warning("Files sweep: could not delete %s; retrying after the lease", key, exc_info=True)
            continue
        if deletions == 0:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE files_looseobject SET deletions = 1, delete_after = clock_timestamp() + interval '1 day'"
                    " WHERE key = %s AND leases = %s",
                    [key, lease],
                )
        else:
            _finish(key, lease)
            finished += 1
    return finished, len(leased) == BATCH


def _finish(key: str, lease: int) -> None:
    """Drops the loose row, unless another sweep has leased it since (its lease expired while we worked)."""
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM files_looseobject WHERE key = %s AND leases = %s", [key, lease])
