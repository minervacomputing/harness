"""The blob store: file contents, kept once per workspace under keys never reused, and the folder versions that
name them by hash.

Every object in storage is named by a Blob row or by a LooseObject row (objects to delete), apart from one whose
write finished so late that its loose row was already gone, which `manage.py files_reconcile --storage` finds.

1. Stage, outside any transaction: a loose row for a new random key K, due in an hour, then the write of K.
2. Record, in the upload's transaction: a Blob row naming K, the workspace's charge, and the claim, which deletes
   K's loose row and succeeds only while the sweep has never taken it (`leases = 0`). All commit, or none does.
3. Deleting a Blob row, by any path, queues its object as loose and subtracts its size from the workspace counter
   (a database trigger, files_blob_deleted).
4. The sweep (files.sweep) takes loose rows that are due, deletes their objects, and deletes them again a day
   later, in case a write was still in flight.

Blob rows and the objects behind them never change. Anything that starts to refer to a blob holds the blob's row
lock while it does (or a KEY SHARE lock on a version naming it), which is what the sweep relies on.
"""

import contextlib
import logging
import os
import secrets
from collections.abc import Callable
from typing import IO
from uuid import UUID

from django.core.files import File
from django.core.files.storage import FileSystemStorage, Storage, storages
from django.db import IntegrityError, connection, transaction
from django.db.models import DateTimeField, F, Func

from conversations.models import Conversation
from files import limits
from files.limits import QuotaExceeded
from files.manifest import SHA256, Manifest, digest, folder_bytes, stored_entries
from files.models import Blob, FolderVersion, RunBlob
from runs.models import Run
from workspaces.tenancy import CrossTenantReference

log = logging.getLogger("minerva.files")


class StorageRace(Exception):
    """An upload lost a race with the sweep. store_blob retries it once."""


class UnknownBlob(Exception):
    """A manifest names contents the workspace does not have."""

    def __init__(self, hashes: list[str]) -> None:
        super().__init__(f"{len(hashes)} blob(s) are not in this workspace's store.")
        self.hashes = hashes


class StaleParent(Exception):
    """The version a new one builds on no longer exists, or belongs to another conversation."""


class ClockTimestamp(Func):
    """The current time, rather than the start of the statement (Now()) or transaction."""

    template = "clock_timestamp()"
    output_field = DateTimeField()


def storage() -> Storage:
    return storages["files"]


def open_blob(blob: Blob) -> IO[bytes]:
    return storage().open(blob.storage_key, "rb")


def delete_object(key: str) -> None:
    """Deletes an object, and on a local disk its directory, which held only it (keys are never reused)."""
    store = storage()
    store.delete(key)
    if isinstance(store, FileSystemStorage):
        with contextlib.suppress(OSError):
            os.rmdir(os.path.dirname(store.path(key)))


def store_blob[T](
    workspace_id: UUID,
    sha256: str,
    size: int,
    path: str | os.PathLike,
    transact: Callable[[Callable[[], Blob]], T],
) -> T:
    """Stores the file at `path`, whose contents hash to `sha256`, in the workspace, and returns what `transact`
    returns.

    `transact(record)` runs in a transaction that store_blob opens. It does the caller's checks and charges (lock
    the run, charge_run_upload, ...), then calls `record()` once, which returns the blob: an existing row, or a new
    one charged to the workspace. Everything it does commits together, or not at all. It may be called a second
    time, in a new transaction, when the first lost a race with the sweep.

    Raises QuotaExceeded("workspace") for a new blob the workspace has no room for, and whatever `transact` raises.
    """
    if connection.in_atomic_block:
        raise RuntimeError("store_blob writes to storage, which it does outside any transaction.")
    if not SHA256.fullmatch(sha256):
        raise ValueError("A sha256 is 64 lowercase hex digits.")
    if os.path.getsize(path) != size:
        raise ValueError("The file's size does not match.")
    try:
        return _store(workspace_id, sha256, size, path, transact)
    except StorageRace:
        return _store(workspace_id, sha256, size, path, transact)


def _store(workspace_id, sha256, size, path, transact):
    key = None
    if not Blob.unscoped.filter(workspace_id=workspace_id, sha256=sha256).exists():
        key = _stage(workspace_id, sha256, path)
    record = _Record(workspace_id, sha256, size, key)
    try:
        with transaction.atomic():
            return transact(record)
    finally:
        # Only an object no row can name is deleted here. Once record() inserted a row naming it, an error (even
        # from the commit) does not prove a rollback, so the object is left to the sweep, which finds it loose
        # unless the row committed.
        if key is not None and not record.inserted:
            _discard(key)


def _stage(workspace_id: UUID, sha256: str, path) -> str:
    key = f"blobs/{workspace_id}/{sha256}/{secrets.token_hex(16)}"
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO files_looseobject (key, delete_after, leases, deletions)"
            " VALUES (%s, clock_timestamp() + interval '1 hour', 0, 0)",
            [key],
        )
    try:
        with open(path, "rb") as source:
            saved = storage().save(key, File(source))
    except BaseException:
        _discard(key)
        raise
    if saved != key:
        # A backend that renames would leave an object no row names.
        storage().delete(saved)
        _discard(key)
        raise RuntimeError(f"The files storage saved {key} as {saved}; it must keep the name.")
    return key


def _discard(key: str) -> None:
    """Deletes an object that no row names, then its loose row. On failure, the loose row stays for the sweep."""
    try:
        delete_object(key)
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM files_looseobject WHERE key = %s", [key])
    except Exception:
        log.warning("Could not delete the unused object %s; the sweep will", key, exc_info=True)


class _Record:
    """`record()` for one upload: one-shot, in the upload's transaction."""

    def __init__(self, workspace_id: UUID, sha256: str, size: int, key: str | None) -> None:
        self.workspace_id, self.sha256, self.size, self.key = workspace_id, sha256, size, key
        self.called = False
        # True once a row naming our key may commit.
        self.inserted = False

    def __call__(self) -> Blob:
        if self.called:
            raise RuntimeError("record() records one blob per upload.")
        self.called = True
        if not connection.in_atomic_block:
            raise RuntimeError("record() runs inside store_blob's transaction.")
        # A savepoint: when anything here fails, nothing of it remains, whatever the caller does next.
        with transaction.atomic():
            blob = self._existing()
            if blob is not None:
                return blob
            if self.key is None:
                # The blob was deleted since store_blob looked, and we wrote nothing.
                raise StorageRace
            try:
                with transaction.atomic():
                    blob = Blob.unscoped.create(
                        workspace_id=self.workspace_id,
                        sha256=self.sha256,
                        size=self.size,
                        storage_key=self.key,
                    )
            except IntegrityError:
                # The same contents were recorded meanwhile; ours is not needed.
                blob = self._existing()
                if blob is None:
                    raise StorageRace from None
                return blob
            _charge_workspace(self.workspace_id, self.size)
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM files_looseobject WHERE key = %s AND leases = 0", [self.key])
                if cursor.rowcount != 1:
                    # The sweep has taken the object (the upload took over an hour): it may be deleted already.
                    raise StorageRace
        self.inserted = True
        return blob

    def _existing(self) -> Blob | None:
        blob = (
            Blob.unscoped.select_for_update()
            .filter(workspace_id=self.workspace_id, sha256=self.sha256)
            .first()
        )
        if blob is not None:
            Blob.unscoped.filter(pk=blob.pk).update(last_used_at=ClockTimestamp())
        return blob


def _charge_workspace(workspace_id: UUID, size: int) -> None:
    limit = limits.workspace_bytes()
    # The insert branch below is not guarded by the limit, so a first blob over it is refused here.
    if limit is not None and size > limit:
        raise QuotaExceeded("workspace")
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO files_workspacestorage AS counter (workspace_id, bytes) VALUES (%s, %s)"
            " ON CONFLICT (workspace_id) DO UPDATE SET bytes = counter.bytes + EXCLUDED.bytes"
            " WHERE %s::bigint IS NULL OR counter.bytes + EXCLUDED.bytes <= %s::bigint"
            " RETURNING bytes",
            [workspace_id, size, limit, limit],
        )
        if cursor.fetchone() is None:
            raise QuotaExceeded("workspace")


def charge_run_upload(run_id: UUID, size: int) -> None:
    """Charges an upload to the run, whether or not the store already had its contents. The caller holds the
    run's row lock."""
    remaining = limits.run_upload_bytes() - size
    if not Run.unscoped.filter(pk=run_id, uploaded_bytes__lte=remaining).update(
        uploaded_bytes=F("uploaded_bytes") + size
    ):
        raise QuotaExceeded("run_uploads")


def grant(run: Run, blob: Blob) -> None:
    """Lets the run read the blob and name it in its checkpoints until it ends. In record()'s transaction, which
    holds the blob's lock."""
    if run.workspace_id != blob.workspace_id:
        raise CrossTenantReference("The blob belongs to a different workspace than the run.")
    RunBlob.unscoped.get_or_create(run=run, blob=blob, defaults={"workspace_id": run.workspace_id})


def record_version(
    conversation: Conversation,
    kind: str,
    manifest: Manifest,
    *,
    parent: FolderVersion | None = None,
    run: Run | None = None,
    attempt: int | None = None,
) -> FolderVersion:
    """Records a version of the conversation's folder, in the caller's transaction.

    Blobs new relative to the parent are locked in hash order. A transaction records at most one version: two in
    one transaction may lock the same blobs in different orders and deadlock with another.

    Raises StaleParent, UnknownBlob, QuotaExceeded("folder_bytes"); the entry limit is checked by manifest.parse.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("record_version runs in the transaction that uses the version.")
    kind = FolderVersion.Kind(kind)
    if run is not None and run.conversation_id != conversation.pk:
        raise ValueError("The run belongs to a different conversation.")
    workspace_id = conversation.workspace_id
    hashes = manifest.hashes
    sizes: dict[str, int] = {}
    with transaction.atomic():
        if parent is not None:
            # Held until we commit, so the parent, and the blobs it names, stay until our version names them too.
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM files_folderversion WHERE id = %s AND conversation_id = %s FOR KEY SHARE",
                    [parent.pk, conversation.pk],
                )
                if cursor.fetchone() is None:
                    raise StaleParent
            entries = FolderVersion.unscoped.values_list("entries", flat=True).get(pk=parent.pk)
            for entry in entries["files"].values():
                if entry["sha256"] in hashes:
                    sizes[entry["sha256"]] = entry["size"]
        new = sorted(hashes - sizes.keys())
        if new:
            found = list(
                Blob.unscoped.select_for_update()
                .filter(workspace_id=workspace_id, sha256__in=new)
                .order_by("sha256")
                .values_list("pk", "sha256", "size")
            )
            if len(found) != len(new):
                raise UnknownBlob(sorted(set(new) - {sha256 for _, sha256, _ in found}))
            Blob.unscoped.filter(pk__in=[pk for pk, _, _ in found]).update(last_used_at=ClockTimestamp())
            sizes.update((sha256, size) for _, sha256, size in found)
        size = folder_bytes([sizes[entry.sha256] for entry in manifest.files.values()])
        if size > limits.folder_bytes():
            raise QuotaExceeded("folder_bytes")
        entries = stored_entries(manifest, sizes)
        version = FolderVersion(
            workspace_id=workspace_id,
            conversation=conversation,
            parent=parent,
            kind=kind,
            run=run,
            attempt=attempt,
            entries=entries,
            hashes=sorted(hashes),
            digest=digest(entries),
            size=size,
            file_count=len(manifest.files),
        )
        version.save()
    return version
