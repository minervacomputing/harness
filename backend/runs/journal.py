"""The worker's saved state: pi-durable's commits, kept on the trusted side so a new worker can resume a run
whose worker died. Each commit is opaque bytes, stored encrypted as the worker sent it and handed back
unchanged, one commit per request; the backend never parses it. Only the run's current attempt can append or
read, and the run's commits are deleted when it ends (services.finish)."""

import hashlib
import logging
from enum import Enum
from uuid import UUID

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from connections.crypto import CredentialKeyError, decrypt_bytes, encrypt_bytes
from runs import services
from runs.models import Run, RunCommit

log = logging.getLogger(__name__)

COMMIT_BYTES = 8 * 1024 * 1024
RUN_BYTES = 32 * 1024 * 1024
RUN_COMMITS = 5000
TOO_LARGE = "This run's saved state grew too large."
UNREADABLE = "This run's saved state could not be read."


class Inactive(Exception):
    """The attempt that asked is no longer the run's current one, or the run has ended."""


class Appended(Enum):
    STORED = "stored"
    # The same commit was stored before; the worker's earlier request succeeded but its answer was lost.
    DUPLICATE = "duplicate"
    CONFLICT = "conflict"
    EMPTY = "empty"
    TOO_LARGE = "too_large"


def _current_run(run_id: UUID, attempt: int, *fields: str, select_for_update: bool = False) -> Run:
    """The run, if `attempt` is its current one and it can still act; raises Inactive otherwise, including
    when the run was deleted after its token was checked."""
    runs = Run.unscoped.select_for_update() if select_for_update else Run.unscoped.all()
    run = runs.only("status", "deadline", "attempt", *fields).filter(pk=run_id).first()
    if (
        run is None
        or run.attempt != attempt
        or run.status not in Run.TOKEN_VALID
        or run.expired(timezone.now())
    ):
        raise Inactive
    return run


def append(run_id: UUID, attempt: int, seq: int, data: bytes) -> Appended:
    """Stores commit `seq`, which must follow the last one. Going over a limit fails the run: retrying, or
    resuming in a new worker, would only grow the same state again."""
    digest = hashlib.sha256(data).hexdigest()
    with transaction.atomic():
        run = _current_run(
            run_id, attempt, "workspace_id", "journal_seq", "journal_bytes", select_for_update=True
        )
        if not data:
            return Appended.EMPTY
        if seq <= run.journal_seq:
            stored = (
                RunCommit.unscoped.filter(run_id=run_id, seq=seq).values_list("digest", flat=True).first()
            )
            return Appended.DUPLICATE if stored == digest else Appended.CONFLICT
        if seq != run.journal_seq + 1:
            return Appended.CONFLICT
        if len(data) > COMMIT_BYTES or run.journal_bytes + len(data) > RUN_BYTES or seq > RUN_COMMITS:
            log.warning("Run %s: saved state over its limits at commit %d (%d bytes)", run_id, seq, len(data))
            services.finish(run_id, Run.Status.FAILED, code="state_too_large", message=TOO_LARGE)
            return Appended.TOO_LARGE
        ciphertext, version = encrypt_bytes(data)
        RunCommit.unscoped.create(
            workspace_id=run.workspace_id,
            run_id=run_id,
            seq=seq,
            attempt=attempt,
            data=ciphertext,
            key_version=version,
            size=len(data),
            digest=digest,
        )
        Run.unscoped.filter(pk=run_id).update(journal_seq=seq, journal_bytes=F("journal_bytes") + len(data))
    return Appended.STORED


def last(run_id: UUID, attempt: int) -> int:
    """The sequence number of the last stored commit, 0 if there is none."""
    return _current_run(run_id, attempt, "journal_seq").journal_seq


def read(run_id: UUID, attempt: int, seq: int) -> bytes | None:
    """Commit `seq` as the worker sent it, or None if there is no such commit. The run row is locked so that
    a read does not interleave with finish() deleting the state. A commit that cannot be decrypted (its key
    was removed) fails the run: no worker could resume it."""
    with transaction.atomic():
        _current_run(run_id, attempt, select_for_update=True)
        row = RunCommit.unscoped.filter(run_id=run_id, seq=seq).values_list("data", "key_version").first()
    if row is None:
        return None
    try:
        return decrypt_bytes(*row)
    except CredentialKeyError:
        log.exception("Run %s: saved state could not be decrypted", run_id)
        services.finish(
            run_id, Run.Status.FAILED, code="state_unreadable", message=UNREADABLE, attempt=attempt
        )
        raise Inactive from None
