"""A run's folder: the version it hydrates, the blobs it may read, its checkpoints, and the version it publishes
when it ends.

A run may read the blobs of its base version and of its last checkpoint, and the blobs it uploaded (RunBlob).
Knowing a hash is not enough: a blob of another conversation in the same workspace stays out of reach.

Checkpoints and the end of a run (runs.services.finish) both take the run's row lock, so no checkpoint is
accepted after the run ended, and the version a run publishes is its last accepted checkpoint. A run keeps only that
one: each checkpoint deletes the one it replaces.
"""

import unicodedata
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Subquery
from django.db.models.functions import Coalesce
from django.utils import timezone

from conversations.models import Conversation
from files import limits, store
from files.limits import QuotaExceeded
from files.manifest import InvalidManifest, Manifest, parse
from files.models import Blob, FolderVersion
from runs.models import Run

UNREADABLE = """
    SELECT h FROM unnest(%s::varchar[]) AS wanted(h)
    EXCEPT SELECT b.sha256 FROM files_runblob g JOIN files_blob b ON b.id = g.blob_id WHERE g.run_id = %s
    EXCEPT SELECT unnest(v.hashes) FROM files_folderversion v WHERE v.id = ANY(%s::uuid[])
"""
# One hash, as for every download: a containment test on at most two arrays, with nothing unnested.
SINGLE_UNREADABLE = """
    SELECT h FROM unnest(%s::varchar[]) AS wanted(h)
    WHERE NOT EXISTS (
        SELECT 1 FROM files_runblob g JOIN files_blob b ON b.id = g.blob_id WHERE g.run_id = %s AND b.sha256 = h
    )
    AND NOT EXISTS (
        SELECT 1 FROM files_folderversion v WHERE v.id = ANY(%s::uuid[]) AND v.hashes @> ARRAY[h]::varchar(64)[]
    )
"""


# Why the worker left an entry out of a checkpoint.
WARNING_REASONS = {"symlink", "special", "invalid_name", "too_long", "too_deep", "unreadable"}
WARNINGS_KEPT = 100
WARNING_PATH_CHARS = 1024


class CheckpointRefused(Exception):
    """`code` is one of stale, conflict, invalid_manifest, unknown_blob or quota."""

    def __init__(self, code: str, message: str, *, limit: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.limit = code, message, limit


def hydrate_version(run: Run) -> FolderVersion | None:
    """The version a new attempt starts from: its last checkpoint, else its base version. In one statement, since a
    checkpoint deletes the one it replaces."""
    current = Run.unscoped.filter(pk=run.pk).values(version=Coalesce("checkpoint_id", "base_version_id"))
    return FolderVersion.unscoped.filter(pk=Subquery(current[:1])).first()


def wire_entries(version: FolderVersion | None) -> dict:
    """A version as the worker receives it: files in path order, with sizes, and empty directories."""
    if version is None:
        return {"files": [], "dirs": []}
    files = [{"path": path, **entry} for path, entry in sorted(version.entries["files"].items())]
    return {"files": files, "dirs": version.entries["dirs"]}


def unreadable(run: Run, hashes: set[str]) -> list[str]:
    """The hashes among `hashes` that the run may not read.

    The run's uploads, its base version and its last checkpoint are enough: every blob of an earlier checkpoint
    was in the base version or uploaded, and grants last until the run ends. Version hashes are compared in the
    database, never loaded.
    """
    if not hashes:
        return []
    versions = [pk for pk in (run.base_version_id, run.checkpoint_id) if pk is not None]
    with connection.cursor() as cursor:
        if len(hashes) == 1:
            cursor.execute(SINGLE_UNREADABLE, [list(hashes), run.pk, versions])
        else:
            cursor.execute(UNREADABLE, [list(hashes), run.pk, versions])
        return sorted(sha256 for (sha256,) in cursor.fetchall())


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


def checkpoint(
    run_id: UUID, attempt: int, parent_id: UUID | None, data: object, warnings: object = None
) -> FolderVersion | None:
    """Records the run's folder as `data` (a manifest in wire form) describes it, on top of `parent_id`, which
    must be the run's last checkpoint (or its base version, for the first). An identical manifest is answered
    with the current version, which is None for a run that has never had files. `warnings`, what the worker left
    out (parse_warnings), replace the run's. Raises CheckpointRefused."""
    with transaction.atomic():
        run = current_run(run_id, attempt)
        if run is None:
            raise CheckpointRefused("stale", "This attempt is no longer the run's current one.")
        current_id = run.checkpoint_id or run.base_version_id
        if parent_id != current_id:
            raise CheckpointRefused("conflict", "The parent is not the run's last checkpoint.")
        try:
            manifest = parse(data, max_entries=limits.folder_entries())
            if warnings is not None:
                # Even for an identical manifest: what was left out can change without what was kept changing.
                Run.unscoped.filter(pk=run_id).update(folder_warnings=parse_warnings(warnings))
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
        if current is not None and current.kind == FolderVersion.Kind.CHECKPOINT and current.run_id == run.pk:
            # A run keeps only its last checkpoint, since each holds a whole manifest. Nothing needs the one it
            # replaces: what the run may read is its base version, its last checkpoint and its uploads, and every
            # blob of an earlier checkpoint is in its base version or uploaded (granted until the run ends).
            FolderVersion.unscoped.filter(pk=version.pk).update(parent_id=run.base_version_id)
            FolderVersion.unscoped.filter(pk=current.pk).delete()
    return version


def parse_warnings(data: object) -> dict:
    """What the worker left out of the folder, as it reports it: {"total", "items": [{"path", "reason"}]}, with at
    most WARNINGS_KEPT items. The paths are for display only, so they need not be valid manifest paths, but they
    must be storable. Raises InvalidManifest."""
    if not isinstance(data, dict) or set(data) != {"total", "items"}:
        raise InvalidManifest('Warnings are {"total", "items"}.')
    total, items = data["total"], data["items"]
    if not isinstance(items, list) or len(items) > WARNINGS_KEPT:
        raise InvalidManifest(f"Warnings list at most {WARNINGS_KEPT} items.")
    if type(total) is not int or not len(items) <= total < 2**31:
        raise InvalidManifest("The warnings' total is not a count of their items.")
    kept = []
    for item in items:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "reason"}
            or not isinstance(item["reason"], str)
            or item["reason"] not in WARNING_REASONS
        ):
            raise InvalidManifest('A warning is {"path", "reason"}, with a known reason.')
        path = item["path"]
        if (
            not isinstance(path, str)
            or not 0 < len(path) <= WARNING_PATH_CHARS
            or any(unicodedata.category(char) in ("Cc", "Cs") for char in path)
        ):
            raise InvalidManifest("A warning's path is empty, too long, or has control characters.")
        kept.append({"path": path, "reason": item["reason"]})
    return {"total": total, "items": kept}


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
    """Makes the run's last checkpoint, else its base version, the conversation's folder and the run's result, and
    records what the turn changed. In the transaction that ends the run, which holds its row lock."""
    run = Run.unscoped.only("conversation_id", "base_version_id", "checkpoint_id").get(pk=run_id)
    version_id = run.checkpoint_id or run.base_version_id
    if version_id is None:
        return
    changes = None
    if run.checkpoint_id is not None:
        # The turn's version builds on the turn's start.
        FolderVersion.unscoped.filter(pk=run.checkpoint_id).update(
            kind=FolderVersion.Kind.TURN, parent_id=run.base_version_id
        )
        entries = dict(
            FolderVersion.unscoped.filter(pk__in=[run.base_version_id, run.checkpoint_id]).values_list(
                "pk", "entries"
            )
        )
        changes = folder_changes(entries.get(run.base_version_id), entries[run.checkpoint_id])
    Run.unscoped.filter(pk=run_id).update(result_version_id=version_id, folder_changes=changes)
    Conversation.unscoped.filter(pk=run.conversation_id).update(folder_id=version_id)


# Paths listed of each kind of change; the counts are complete.
CHANGES_KEPT = 100


def folder_changes(before: dict | None, after: dict) -> dict | None:
    """What changed from one version's entries to another's: files added, modified (contents or mode) and deleted,
    and directories added and deleted (listed or implied). None when nothing did."""
    old, new = (before or {"files": {}, "dirs": []})["files"], after["files"]
    changed = {
        "added": sorted(path for path in new if path not in old),
        "modified": sorted(
            path
            for path in new
            if path in old
            and (new[path]["sha256"], new[path]["mode"]) != (old[path]["sha256"], old[path]["mode"])
        ),
        "deleted": sorted(path for path in old if path not in new),
    }
    old_dirs, new_dirs = _directories(before), _directories(after)
    changed["dirs_added"] = sorted(new_dirs - old_dirs)
    changed["dirs_deleted"] = sorted(old_dirs - new_dirs)
    if not any(changed.values()):
        return None
    sizes = {"added": new, "modified": new, "deleted": old}
    result: dict = {"counts": {key: len(paths) for key, paths in changed.items()}}
    for key, paths in changed.items():
        kept = paths[:CHANGES_KEPT]
        result[key] = (
            [{"path": path, "size": sizes[key][path]["size"]} for path in kept] if key in sizes else kept
        )
    return result


def _directories(entries: dict | None) -> set[str]:
    if entries is None:
        return set()
    implied: set[str] = set()
    for path in (*entries["files"], *entries["dirs"]):
        end = path.rfind("/")
        # A directory's parents were added with it.
        while end > 0 and path[:end] not in implied:
            implied.add(path[:end])
            end = path.rfind("/", 0, end)
    return implied | set(entries["dirs"])
