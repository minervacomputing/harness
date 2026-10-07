"""A run's folder: the version it hydrates, the blobs it may read, its checkpoints, and the version it publishes
when it ends.

A run may read the blobs of its base version and of its own checkpoints, and the blobs it uploaded (RunBlob).
Knowing a hash is not enough: a blob of another conversation in the same workspace stays out of reach.

Checkpoints and the end of a run (runs.services.finish) both take the run's row lock, so no checkpoint is
accepted after the run ended, and the version a run publishes is its last accepted checkpoint.
"""

from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from conversations.models import Conversation
from files import limits, store
from files.limits import QuotaExceeded
from files.manifest import InvalidManifest, Manifest, parse
from files.models import Blob, FolderVersion, RunBlob
from runs.models import Run


class CheckpointRefused(Exception):
    """`code` is one of stale, conflict, invalid_manifest, unknown_blob or quota."""

    def __init__(self, code: str, message: str, *, limit: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.limit = code, message, limit


def hydrate_version(run: Run) -> FolderVersion | None:
    """The version a new attempt starts from: its last checkpoint, else its base version."""
    version_id = run.checkpoint_id or run.base_version_id
    return FolderVersion.unscoped.get(pk=version_id) if version_id else None


def wire_entries(version: FolderVersion | None) -> dict:
    """A version as the worker receives it: files in path order, with sizes, and empty directories."""
    if version is None:
        return {"files": [], "dirs": []}
    files = [{"path": path, **entry} for path, entry in sorted(version.entries["files"].items())]
    return {"files": files, "dirs": version.entries["dirs"]}


def unreadable(run: Run, hashes: set[str]) -> list[str]:
    """The hashes among `hashes` that the run may not read."""
    missing = set(hashes)
    if missing:
        granted = RunBlob.unscoped.filter(run_id=run.pk, blob__sha256__in=missing)
        missing -= set(granted.values_list("blob__sha256", flat=True))
    if missing:
        named = FolderVersion.unscoped.filter(
            Q(pk=run.base_version_id) | Q(run_id=run.pk, kind=FolderVersion.Kind.CHECKPOINT),
            workspace_id=run.workspace_id,
            hashes__overlap=sorted(missing),
        )
        for version_hashes in named.values_list("hashes", flat=True):
            missing -= set(version_hashes)
    return sorted(missing)


def readable_blob(run: Run, sha256: str) -> Blob | None:
    """The blob, if the run may read it."""
    if unreadable(run, {sha256}):
        return None
    return Blob.unscoped.filter(workspace_id=run.workspace_id, sha256=sha256).first()


def current_run(run_id: UUID, attempt: int) -> Run | None:
    """The run, locked, if `attempt` is its current one and it can still act. In the caller's transaction."""
    run = Run.unscoped.select_for_update().filter(pk=run_id).first()
    if (
        run is None
        or run.attempt != attempt
        or run.status not in Run.TOKEN_VALID
        or run.expired(timezone.now())
    ):
        return None
    return run


def checkpoint(run_id: UUID, attempt: int, parent_id: UUID | None, data: object) -> FolderVersion | None:
    """Records the run's folder as `data` (a manifest in wire form) describes it, on top of `parent_id`, which
    must be the run's last checkpoint (or its base version, for the first). An identical manifest is answered
    with the current version, which is None for a run that has never had files. Raises CheckpointRefused."""
    with transaction.atomic():
        run = current_run(run_id, attempt)
        if run is None:
            raise CheckpointRefused("stale", "This attempt is no longer the run's current one.")
        current_id = run.checkpoint_id or run.base_version_id
        if parent_id != current_id:
            raise CheckpointRefused("conflict", "The parent is not the run's last checkpoint.")
        try:
            manifest = parse(data, max_entries=limits.folder_entries())
        except InvalidManifest as error:
            raise CheckpointRefused("invalid_manifest", str(error)) from None
        except QuotaExceeded as error:
            raise _quota(error.limit) from None
        current = FolderVersion.unscoped.get(pk=current_id) if current_id else None
        if _same(current, manifest):
            return current
        missing = unreadable(run, manifest.hashes)
        if missing:
            raise CheckpointRefused("unknown_blob", f"{len(missing)} blob(s) are not readable by this run.")
        conversation = Conversation.unscoped.get(pk=run.conversation_id)
        try:
            version = store.record_version(
                conversation,
                FolderVersion.Kind.CHECKPOINT,
                manifest,
                parent=current,
                run=run,
                attempt=attempt,
            )
        except QuotaExceeded as error:
            raise _quota(error.limit) from None
        except store.UnknownBlob:
            raise CheckpointRefused("unknown_blob", "A blob is no longer in the store.") from None
        Run.unscoped.filter(pk=run_id).update(checkpoint=version)
    return version


def _quota(limit: str) -> CheckpointRefused:
    return CheckpointRefused("quota", f"The folder is over its {limit} limit.", limit=limit)


def _same(current: FolderVersion | None, manifest: Manifest) -> bool:
    if current is None:
        return not manifest.files and not manifest.dirs
    files = {
        path: (entry["sha256"], entry["mode"], entry["mtime"])
        for path, entry in current.entries["files"].items()
    }
    ours = {path: (entry.sha256, entry.mode, entry.mtime) for path, entry in manifest.files.items()}
    return files == ours and list(current.entries["dirs"]) == list(manifest.dirs)


def publish(run_id: UUID) -> None:
    """Makes the run's last checkpoint, else its base version, the conversation's folder and the run's result.
    In the transaction that ends the run, which holds its row lock."""
    run = Run.unscoped.only("conversation_id", "base_version_id", "checkpoint_id").get(pk=run_id)
    version_id = run.checkpoint_id or run.base_version_id
    if version_id is None:
        return
    if run.checkpoint_id is not None:
        # The turn's version builds on the turn's start, so its other checkpoints can be deleted.
        FolderVersion.unscoped.filter(pk=run.checkpoint_id).update(
            kind=FolderVersion.Kind.TURN, parent_id=run.base_version_id
        )
    Run.unscoped.filter(pk=run_id).update(result_version_id=version_id)
    Conversation.unscoped.filter(pk=run.conversation_id).update(folder_id=version_id)
