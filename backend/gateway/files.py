"""The run's folder, over the gateway: blobs in and out, and checkpoints.

`PUT /blobs/{sha256}` is a raw ASGI app routed beside `/mcp` (gateway.asgi), behind require_run, so Django never
buffers its body: it streams to a temporary file while hashing, and the file is removed however the request ends.
The bytes are received and hashed even when the store already has the blob, since only that shows the run has the
contents. `GET /blobs/{sha256}` and `PUT /checkpoint` are Django views.

Each upload or download is a files.transfers.Transfer, which holds one of the run's places until the blob I/O it
started has finished: cancelling an await (a client that leaves, a shutdown) does not stop a thread.
"""

import contextlib
import functools
import hashlib
import json
import logging
import os
import re
import tempfile
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db.models import F
from django.http import HttpRequest, JsonResponse, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods
from starlette.types import Receive, Scope, Send

from files import limits, store
from files import runs as folder
from files.limits import QuotaExceeded
from files.manifest import SHA256
from files.transfers import Busy, Download, Transfer, closing_connection
from gateway.asgi_json import send_error
from gateway.auth import ATTEMPT_SCOPE_KEY, INACTIVE, RUN_SCOPE_KEY, error_response, run_required
from runs.models import Run

BLOB_PATH = re.compile(r"/blobs/(?P<sha256>[^/]+)")
CHECKPOINT_STATUS = {
    "stale": 401,
    "conflict": 409,
    "invalid_manifest": 400,
    "unknown_blob": 403,
    "quota": 413,
}


TRANSFERS_PER_RUN = 4

log = logging.getLogger("minerva.files")


class _Inactive(Exception):
    pass


async def _send_json(send: Send, status: int, body: dict) -> None:
    data = json.dumps(body).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode())]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": data})


async def _quota(send: Send, limit: str) -> None:
    message = f"The {limit} limit would be exceeded."
    await _send_json(send, 413, {"error": {"code": "quota", "limit": limit, "message": message}})


async def put_blob(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["method"] != "PUT":
        await send_error(send, 405, "Use PUT.")
        return
    match = BLOB_PATH.fullmatch(scope["path"])
    sha256 = match["sha256"] if match else ""
    if not SHA256.fullmatch(sha256):
        await send_error(send, 404, "Not found.")
        return
    lengths = [value for name, value in scope.get("headers", []) if name.lower() == b"content-length"]
    if not lengths:
        await send_error(send, 411, "Send a Content-Length.")
        return
    if len(lengths) > 1 or not lengths[0].isdigit():
        await send_error(send, 400, "Invalid Content-Length.")
        return
    size = int(lengths[0])
    # A file cannot be larger than the folder that holds it.
    if size > limits.folder_bytes():
        await _quota(send, "folder_bytes")
        return

    run_id, attempt = scope[RUN_SCOPE_KEY], scope[ATTEMPT_SCOPE_KEY]
    try:
        transfer = Transfer(run_id, TRANSFERS_PER_RUN)
    except Busy:
        await send_error(send, 429, "This run has too many transfers in flight.")
        return
    staged = _Staged()
    try:
        await _receive_blob(transfer, staged, run_id, attempt, sha256, size, receive, send)
    finally:
        await transfer.finish(functools.partial(_discard, staged, run_id, attempt))


class _Staged:
    """An upload's temporary file. The blob I/O jobs that act on it set its fields, so an await cancelled while
    one runs loses nothing that the cleanup (_discard) needs."""

    def __init__(self) -> None:
        self.path: str | None = None
        self.file = None
        self.received = 0
        self.stored = False

    def open(self) -> None:
        descriptor, self.path = tempfile.mkstemp("", "minerva-blob-")
        self.file = os.fdopen(descriptor, "wb")


async def _receive_blob(
    transfer: Transfer,
    staged: _Staged,
    run_id: UUID,
    attempt: int,
    sha256: str,
    size: int,
    receive: Receive,
    send: Send,
):
    # Checked before the body is read, and again before anything is written to storage.
    try:
        await transfer.io(_admit, run_id, attempt, size)
    except _Inactive:
        await send_error(send, 401, INACTIVE)
        return
    except QuotaExceeded as error:
        await _quota(send, error.limit)
        return
    await transfer.io(staged.open)
    digest = hashlib.sha256()
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return
        body = message.get("body", b"")
        staged.received += len(body)
        if staged.received > size:
            await send_error(send, 400, "The body is longer than its Content-Length.")
            return
        if body:
            await transfer.io(_write, staged.file, digest, body)
        if not message.get("more_body"):
            break
    if staged.received != size:
        await send_error(send, 400, "The body is shorter than its Content-Length.")
        return
    if digest.hexdigest() != sha256:
        await send_error(send, 400, "The contents do not match the hash.")
        return
    try:
        blob = await transfer.io(_record, run_id, attempt, sha256, size, staged)
    except _Inactive:
        await send_error(send, 401, INACTIVE)
        return
    except QuotaExceeded as error:
        await _quota(send, error.limit)
        return
    await _send_json(send, 200, {"sha256": blob.sha256, "size": blob.size})


@closing_connection
def _discard(staged: _Staged, run_id: UUID, attempt: int) -> None:
    """An upload's cleanup, once its other jobs have finished: whether it was stored is what _record did. Each step
    runs even if one before it fails."""
    try:
        if staged.received and not staged.stored:
            # Bytes the gateway received count against the run's budget even when nothing was stored, so a run
            # cannot make it receive and hash without end. A commit that failed but took effect is charged twice.
            Run.unscoped.filter(pk=run_id, attempt=attempt).update(
                uploaded_bytes=F("uploaded_bytes") + staged.received
            )
    finally:
        try:
            if staged.file is not None:
                staged.file.close()
        finally:
            if staged.path is not None:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(staged.path)


def _write(file, digest, body: bytes) -> None:
    digest.update(body)
    file.write(body)


def _current(run: Run | None, attempt: int) -> bool:
    return (
        run is not None
        and run.attempt == attempt
        and run.status in Run.TOKEN_VALID
        and not run.expired(timezone.now())
    )


def _check(run_id: UUID, attempt: int, size: int) -> None:
    """Raises _Inactive, or QuotaExceeded when the upload would pass the run's budget. Not locked: the upload's
    transaction checks again."""
    run = Run.unscoped.only("status", "deadline", "attempt", "uploaded_bytes").filter(pk=run_id).first()
    if not _current(run, attempt):
        raise _Inactive
    if run.uploaded_bytes + size > limits.run_upload_bytes():
        raise QuotaExceeded("run_uploads")


_admit = closing_connection(_check)


@closing_connection
def _record(run_id: UUID, attempt: int, sha256: str, size: int, staged: _Staged):
    """Charges the upload to the run, records the blob (charged to the workspace if new) and grants it to the
    run, while the attempt is current."""

    def transact(record):
        run = folder.current_run(run_id, attempt)
        if run is None:
            raise _Inactive
        store.charge_run_upload(run_id, size)
        blob = record()
        store.grant(run, blob)
        return blob

    staged.file.close()
    _check(run_id, attempt, size)
    workspace_id = Run.unscoped.filter(pk=run_id).values_list("workspace_id", flat=True).get()
    blob = store.store_blob(workspace_id, sha256, size, staged.path, transact)
    staged.stored = True
    return blob


@require_GET
@run_required
async def get_blob(request: HttpRequest, sha256: str):
    if not SHA256.fullmatch(sha256):
        return error_response("Not found.", 404)
    run = request.run  # type: ignore[attr-defined]
    blob = await sync_to_async(folder.readable_blob)(run, sha256)
    if blob is None:
        # The same answer whether the blob does not exist or the run may not read it.
        return error_response("Not found.", 404)
    try:
        transfer = Transfer(run.id, TRANSFERS_PER_RUN)
    except Busy:
        return error_response("This run has too many transfers in flight.", 429)
    download = Download(transfer)
    try:
        await transfer.io(download.open, blob)
        response = StreamingHttpResponse(download, content_type="application/octet-stream")
        response["Content-Length"] = str(blob.size)
    except BaseException:
        download.close()
        raise
    return response


@require_http_methods(["PUT"])
@run_required
async def put_checkpoint(request: HttpRequest) -> JsonResponse:
    run = request.run  # type: ignore[attr-defined]
    try:
        body = json.loads(request.body)
        if not isinstance(body, dict) or not {"parent", "entries"} <= set(body) <= {
            "parent",
            "entries",
            "warnings",
        }:
            raise ValueError
        parent = UUID(body["parent"]) if body["parent"] is not None else None
    except ValueError, TypeError, AttributeError:
        message = 'The body is {"parent", "entries"}, with optional "warnings".'
        return _refused(folder.CheckpointRefused("invalid_manifest", message))
    try:
        version = await sync_to_async(folder.checkpoint)(
            run.id, run.attempt, parent, body["entries"], body.get("warnings")
        )
    except folder.CheckpointRefused as error:
        return _refused(error)
    return JsonResponse({"version": str(version.id) if version is not None else None})


def _refused(error: folder.CheckpointRefused) -> JsonResponse:
    body = {"code": error.code, "message": error.message}
    if error.limit is not None:
        body["limit"] = error.limit
    return JsonResponse({"error": body}, status=CHECKPOINT_STATUS[error.code])
