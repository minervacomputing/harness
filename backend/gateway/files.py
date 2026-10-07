"""The run's folder, over the gateway: blobs in and out, and checkpoints.

`PUT /blobs/{sha256}` is a raw ASGI app routed beside `/mcp` (gateway.asgi), behind require_run, so Django never
buffers its body: it streams to a temporary file while hashing, and the file is removed however the request ends.
The bytes are received and hashed even when the store already has the blob, since only that shows the run has the
contents. `GET /blobs/{sha256}` and `PUT /checkpoint` are Django views.
"""

import asyncio
import contextlib
import hashlib
import json
import os
import re
import tempfile
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import connection
from django.http import HttpRequest, JsonResponse, StreamingHttpResponse
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
    descriptor, path = tempfile.mkstemp(prefix="minerva-blob-")
    try:
        with os.fdopen(descriptor, "wb") as file:
            digest = hashlib.sha256()
            received = 0
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
                    await asyncio.to_thread(_write, file, digest, body)
                if not message.get("more_body"):
                    break
        if received != size:
            await send_error(send, 400, "The body is shorter than its Content-Length.")
            return
        if digest.hexdigest() != sha256:
            await send_error(send, 400, "The contents do not match the hash.")
            return
        try:
            # Not on the thread the views share: a large write to storage would hold them all up.
            blob = await sync_to_async(_record, thread_sensitive=False)(run_id, attempt, sha256, size, path)
        except _Inactive:
            await send_error(send, 401, INACTIVE)
            return
        except QuotaExceeded as error:
            await _quota(send, error.limit)
            return
        await _send_json(send, 200, {"sha256": blob.sha256, "size": blob.size})
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)


def _write(file, digest, body: bytes) -> None:
    digest.update(body)
    file.write(body)


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

    try:
        workspace_id = Run.unscoped.filter(pk=run_id).values_list("workspace_id", flat=True).first()
        if workspace_id is None:
            raise _Inactive
        return store.store_blob(workspace_id, sha256, size, path, transact)
    finally:
        # A pool thread's connection, which no request cycle closes.
        connection.close()


@require_GET
@run_required
async def get_blob(request: HttpRequest, sha256: str):
    if not SHA256.fullmatch(sha256):
        return error_response("Not found.", 404)
    blob = await sync_to_async(folder.readable_blob)(request.run, sha256)  # type: ignore[attr-defined]
    if blob is None:
        # The same answer whether the blob does not exist or the run may not read it.
        return error_response("Not found.", 404)
    stream = await sync_to_async(store.open_blob, thread_sensitive=False)(blob)
    response = StreamingHttpResponse(_chunks(stream), content_type="application/octet-stream")
    response["Content-Length"] = str(blob.size)
    return response


async def _chunks(stream):
    """Reads in a pool thread, chunk by chunk: Django buffers a synchronous iterator whole under ASGI."""
    try:
        while chunk := await asyncio.to_thread(stream.read, CHUNK_BYTES):
            yield chunk
    finally:
        await asyncio.to_thread(stream.close)


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
