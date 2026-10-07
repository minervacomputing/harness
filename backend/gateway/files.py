"""The run's folder, over the gateway: blobs in and out, and checkpoints.

`PUT /blobs/{sha256}` is a raw ASGI app routed beside `/mcp` (gateway.asgi), behind require_run, so Django never
buffers its body: it streams to a temporary file while hashing, and the file is removed however the request ends.
The bytes are received and hashed even when the store already has the blob, since only that shows the run has the
contents. `GET /blobs/{sha256}` and `PUT /checkpoint` are Django views.
"""

import asyncio
import contextlib
import functools
import hashlib
import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import connection
from django.db.models import F
from django.http import HttpRequest, JsonResponse, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods
from starlette.types import Receive, Scope, Send

from files import limits, store
from files import runs as folder
from files.limits import QuotaExceeded
from files.manifest import SHA256
from gateway.asgi_json import send_error
from gateway.auth import ATTEMPT_SCOPE_KEY, INACTIVE, RUN_SCOPE_KEY, error_response, run_required
from runs.models import Run

BLOB_PATH = re.compile(r"/blobs/(?P<sha256>[^/]+)")
CHUNK_BYTES = 256 * 1024
CHECKPOINT_STATUS = {
    "stale": 401,
    "conflict": 409,
    "invalid_manifest": 400,
    "unknown_blob": 403,
    "quota": 413,
}


# Blob I/O (temporary files, storage, and the database work of an upload) has threads of its own, so transfers
# never wait behind, or hold up, the views' shared thread or the loop's default pool. Each run may have a few
# transfers at once in each process, so one run cannot take every thread.
BLOB_IO = ThreadPoolExecutor(max_workers=16, thread_name_prefix="blob-io")
TRANSFERS_PER_RUN = 4
_transfers: dict[UUID, int] = {}


class _Inactive(Exception):
    pass


class _Busy(Exception):
    pass


async def _io(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(BLOB_IO, functools.partial(fn, *args))


def _closing_connection(fn):
    """A blob I/O thread's database work: its connection is closed after, since no request cycle does."""

    @functools.wraps(fn)
    def wrapper(*args):
        try:
            return fn(*args)
        finally:
            connection.close()

    return wrapper


def _acquire(run_id: UUID) -> None:
    count = _transfers.get(run_id, 0)
    if count >= TRANSFERS_PER_RUN:
        raise _Busy
    _transfers[run_id] = count + 1


def _release(run_id: UUID) -> None:
    if _transfers[run_id] > 1:
        _transfers[run_id] -= 1
    else:
        del _transfers[run_id]


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
        _acquire(run_id)
    except _Busy:
        await send_error(send, 429, "This run has too many transfers in flight.")
        return
    try:
        await _receive_blob(run_id, attempt, sha256, size, receive, send)
    finally:
        _release(run_id)


async def _receive_blob(run_id: UUID, attempt: int, sha256: str, size: int, receive: Receive, send: Send):
    # Checked before the body is read, and again before anything is written to storage.
    try:
        await _io(_admit, run_id, attempt, size)
    except _Inactive:
        await send_error(send, 401, INACTIVE)
        return
    except QuotaExceeded as error:
        await _quota(send, error.limit)
        return
    descriptor, path = await _io(tempfile.mkstemp, "", "minerva-blob-")
    received = 0
    stored = False
    try:
        with os.fdopen(descriptor, "wb") as file:
            digest = hashlib.sha256()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body = message.get("body", b"")
                received += len(body)
                if received > size:
                    await send_error(send, 400, "The body is longer than its Content-Length.")
                    return
                if body:
                    await _io(_write, file, digest, body)
                if not message.get("more_body"):
                    break
        if received != size:
            await send_error(send, 400, "The body is shorter than its Content-Length.")
            return
        if digest.hexdigest() != sha256:
            await send_error(send, 400, "The contents do not match the hash.")
            return
        try:
            blob = await _io(_record, run_id, attempt, sha256, size, path)
        except _Inactive:
            await send_error(send, 401, INACTIVE)
            return
        except QuotaExceeded as error:
            await _quota(send, error.limit)
            return
        stored = True
        await _send_json(send, 200, {"sha256": blob.sha256, "size": blob.size})
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)
        if received and not stored:
            # Bytes the gateway received count against the run's budget even when nothing was stored, so a run
            # cannot make it receive and hash without end.
            with contextlib.suppress(Exception):
                await _io(_charge_refused, run_id, attempt, received)


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


_admit = _closing_connection(_check)


@_closing_connection
def _charge_refused(run_id: UUID, attempt: int, received: int) -> None:
    Run.unscoped.filter(pk=run_id, attempt=attempt).update(uploaded_bytes=F("uploaded_bytes") + received)


@_closing_connection
def _record(run_id: UUID, attempt: int, sha256: str, size: int, path: str):
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

    _check(run_id, attempt, size)
    workspace_id = Run.unscoped.filter(pk=run_id).values_list("workspace_id", flat=True).get()
    return store.store_blob(workspace_id, sha256, size, path, transact)


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
        _acquire(run.id)
    except _Busy:
        return error_response("This run has too many transfers in flight.", 429)
    try:
        stream = await _io(store.open_blob, blob)
    except BaseException:
        _release(run.id)
        raise
    response = StreamingHttpResponse(_Download(stream, run.id), content_type="application/octet-stream")
    response["Content-Length"] = str(blob.size)
    return response


class _Download:
    """A blob's contents, read chunk by chunk on the blob I/O threads (Django buffers a synchronous iterator
    whole under ASGI). Django calls close() however the response ends, even if it was never read."""

    def __init__(self, stream, run_id: UUID) -> None:
        self.stream, self.run_id, self.closed = stream, run_id, False
        self.loop = asyncio.get_running_loop()

    async def __aiter__(self):
        while chunk := await _io(self.stream.read, CHUNK_BYTES):
            yield chunk

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            # Django calls this from a thread of its own; the counts belong to the loop.
            self.loop.call_soon_threadsafe(_release, self.run_id)
            self.stream.close()


@require_http_methods(["PUT"])
@run_required
async def put_checkpoint(request: HttpRequest) -> JsonResponse:
    run = request.run  # type: ignore[attr-defined]
    try:
        body = json.loads(request.body)
        if not isinstance(body, dict) or set(body) != {"parent", "entries"}:
            raise ValueError
        parent = UUID(body["parent"]) if body["parent"] is not None else None
    except ValueError, TypeError, AttributeError:
        return _refused(folder.CheckpointRefused("invalid_manifest", 'The body is {"parent", "entries"}.'))
    try:
        version = await sync_to_async(folder.checkpoint)(run.id, run.attempt, parent, body["entries"])
    except folder.CheckpointRefused as error:
        return _refused(error)
    return JsonResponse({"version": str(version.id) if version is not None else None})


def _refused(error: folder.CheckpointRefused) -> JsonResponse:
    body = {"code": error.code, "message": error.message}
    if error.limit is not None:
        body["limit"] = error.limit
    return JsonResponse({"error": body}, status=CHECKPOINT_STATUS[error.code])
