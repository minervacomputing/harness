"""Repairs for what the database cannot keep consistent by itself: `manage.py files_reconcile`.

The counters drift only when blob rows change outside this app (TRUNCATE, a restored backup, a manual fix), and
objects are left untracked only by a write that finished more than a day after its upload gave up. Run it after
a restore, and from time to time.
"""

import logging
from collections.abc import Iterator
from datetime import datetime, timedelta
from itertools import batched

from django.core.files.storage import Storage
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from files.store import storage

log = logging.getLogger("minerva.files")
UNTRACKED_AGE = timedelta(days=1)


def counters() -> int:
    """Sets each workspace's storage counter to the sum of its blobs. Returns how many were wrong."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT workspace_id FROM files_blob UNION SELECT workspace_id FROM files_workspacestorage"
            " ORDER BY workspace_id"
        )
        workspace_ids = [workspace_id for (workspace_id,) in cursor.fetchall()]
    corrected = 0
    for workspace_id in workspace_ids:
        try:
            corrected += _counter(workspace_id)
        except IntegrityError:
            # The workspace was deleted meanwhile.
            continue
    return corrected


def _counter(workspace_id) -> int:
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO files_workspacestorage (workspace_id, bytes) VALUES (%s, 0) ON CONFLICT DO NOTHING",
            [workspace_id],
        )
        # Locked first, then summed in a new statement: an upload or deletion that commits before the lock is
        # in the sum, and one still in flight adjusts the counter after us.
        cursor.execute(
            "SELECT bytes FROM files_workspacestorage WHERE workspace_id = %s FOR UPDATE", [workspace_id]
        )
        (counted,) = cursor.fetchone()
        cursor.execute(
            "SELECT coalesce(sum(size), 0) FROM files_blob WHERE workspace_id = %s", [workspace_id]
        )
        (total,) = cursor.fetchone()
        if counted == total:
            return 0
        log.warning("Workspace %s: storage counter %d, blobs %d; corrected", workspace_id, counted, total)
        cursor.execute(
            "UPDATE files_workspacestorage SET bytes = %s WHERE workspace_id = %s", [total, workspace_id]
        )
        return 1


def untracked_objects() -> int:
    """Deletes objects under blobs/ that no Blob or LooseObject row names and that are over a day old.

    Such an object can never be named again: a blob names its object only by claiming the object's loose row,
    in the transaction that inserts it, so every object a row may yet name has one row or the other.
    """
    store = storage()
    cutoff = timezone.now() - UNTRACKED_AGE
    deleted = 0
    old = (key for key, modified in _objects(store) if modified < cutoff)
    for keys in batched(old, 1000, strict=False):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT listed.key FROM unnest(%s::text[]) AS listed(key)"
                " WHERE NOT EXISTS (SELECT 1 FROM files_blob b WHERE b.storage_key = listed.key)"
                " AND NOT EXISTS (SELECT 1 FROM files_looseobject l WHERE l.key = listed.key)",
                [list(keys)],
            )
            untracked = [key for (key,) in cursor.fetchall()]
        for key in untracked:
            log.warning("Deleting the untracked object %s", key)
            store.delete(key)
            deleted += 1
    return deleted


def _objects(store: Storage) -> Iterator[tuple[str, datetime]]:
    from storages.backends.s3 import S3Storage

    if isinstance(store, S3Storage):
        # One listing request per thousand objects, rather than one request per object.
        for summary in store.bucket.objects.filter(Prefix="blobs/"):
            yield summary.key, summary.last_modified
    elif store.exists("blobs"):
        yield from _walk(store, "blobs")


def _walk(store: Storage, path: str) -> Iterator[tuple[str, datetime]]:
    directories, files = store.listdir(path)
    for name in files:
        yield f"{path}/{name}", store.get_modified_time(f"{path}/{name}")
    for name in directories:
        yield from _walk(store, f"{path}/{name}")
