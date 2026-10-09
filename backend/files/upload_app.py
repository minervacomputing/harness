"""`POST /api/workspaces/{workspace_id}/uploads?name=<file name>`: a file the user will attach to a message, sent as
the raw request body.

A raw ASGI app routed beside Django (minerva.asgi), since Django's handler buffers the whole body before any view
or authentication sees it. Here the session, CSRF token, membership and demo rules are checked from the headers
first, then the body streams to a temporary file while it is hashed, and the file is removed however the request
ends. Answers 201 with the upload ({id, name, size, media_type}); errors are {"detail": message}, like the API's.
"""

import asyncio
import contextlib
import functools
import hashlib
import io
import json
import logging
import os
import re
import tempfile
from urllib.parse import parse_qs
from uuid import UUID

from asgiref.sync import sync_to_async
from django.contrib import auth
from django.contrib.sessions.middleware import SessionMiddleware
from django.core.exceptions import DisallowedHost
from django.core.handlers.asgi import ASGIRequest
from django.middleware.csrf import CsrfViewMiddleware
from starlette.types import Receive, Scope, Send

from demo import services as demo
from files import limits, uploads
from files.limits import QuotaExceeded
from files.transfers import Busy, Transfer, closing_connection
from workspaces.models import Membership

PATH = re.compile(
    r"/api/workspaces/(?P<workspace_id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/uploads"
)
# Uploads one user may have in flight in this process, and all users together: each holds a temporary file.
UPLOADS_PER_USER = 3
UPLOADS_IN_FLIGHT = 32
# A body that stalls this long between chunks, or is still arriving after the deadline, is refused, so stalled
# uploads cannot keep the slots above.
IDLE_SECONDS = 60
DEADLINE_SECONDS = 15 * 60

log = logging.getLogger("minerva.files")
in_flight = 0


class _Refused(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


async def _send_json(send: Send, status: int, body: dict) -> None:
    data = json.dumps(body).encode()
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(data)).encode()),
        (b"cache-control", b"no-store"),
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": data})


async def refuse(send: Send, status: int, message: str) -> None:
    await _send_json(send, status, {"detail": message})


def matches(scope: Scope) -> bool:
    return scope["type"] == "http" and PATH.fullmatch(scope["path"]) is not None


async def upload_app(scope: Scope, receive: Receive, send: Send) -> None:
    global in_flight
    if in_flight >= UPLOADS_IN_FLIGHT:
        await refuse(send, 503, "Too many files are being uploaded. Try again in a moment.")
        return
    in_flight += 1
    try:
        await _upload(scope, receive, send)
    finally:
        in_flight -= 1


async def _upload(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["method"] != "POST":
        await refuse(send, 405, "Use POST.")
        return
    workspace_id = UUID(PATH.fullmatch(scope["path"])["workspace_id"])
    lengths = [value for name, value in scope.get("headers", []) if name.lower() == b"content-length"]
    if not lengths:
        await refuse(send, 411, "Send a Content-Length.")
        return
    if len(lengths) > 1 or not lengths[0].isdigit():
        await refuse(send, 400, "Invalid Content-Length.")
        return
    size = int(lengths[0])
    if size > limits.upload_bytes():
        await refuse(send, 413, f"A file can be at most {uploads.size_text(limits.upload_bytes())}.")
        return
    try:
        names = parse_qs(scope.get("query_string", b"").decode("ascii"), errors="strict").get("name")
    except UnicodeDecodeError:
        names = None
    if names is None or len(names) != 1:
        await refuse(send, 400, "Name the file with ?name=.")
        return
    name = uploads.clean_name(names[0])
    try:
        user_id = await sync_to_async(_authenticate, thread_sensitive=False)(scope, workspace_id)
    except _Refused as refused:
        await refuse(send, refused.status, refused.message)
        return
    try:
        transfer = Transfer(("upload", user_id), UPLOADS_PER_USER)
    except Busy:
        await refuse(send, 429, "You are uploading too many files at once.")
        return
    staged = _Staged()
    try:
        await _receive(transfer, staged, workspace_id, user_id, name, size, receive, send)
    finally:
        await transfer.finish(functools.partial(_discard, staged))


@closing_connection
def _authenticate(scope: Scope, workspace_id: UUID) -> UUID:
    """The signed-in user's id, as Django's middleware and the API's authentication would find it, from the
    request's headers alone. Raises _Refused."""
    headers = [
        (n, v) for n, v in scope.get("headers", []) if n.lower() not in (b"content-length", b"content-type")
    ]
    # Without a body, so nothing here tries to read one.
    request = ASGIRequest({**scope, "headers": headers}, io.BytesIO())
    try:
        request.get_host()
    except DisallowedHost:
        raise _Refused(400, "Bad request.") from None
    SessionMiddleware(_unused).process_request(request)
    user = auth.get_user(request)
    if not user.is_authenticated:
        raise _Refused(401, "Unauthorized")
    csrf = CsrfViewMiddleware(_unused)
    csrf.process_request(request)
    if csrf.process_view(request, None, (), {}) is not None:
        raise _Refused(403, "CSRF check Failed")
    if not Membership.objects.filter(workspace_id=workspace_id, user=user).exists():
        raise _Refused(401, "Unauthorized")
    if demo.is_visitor(user):
        raise _Refused(403, "Not available in the demo.")
    return user.pk


def _unused(request):
    raise AssertionError


class _Staged:
    """The upload's temporary file. The blob I/O jobs that act on it set its fields, so an await cancelled while
    one runs loses nothing that the cleanup (_discard) needs."""

    def __init__(self) -> None:
        self.path: str | None = None
        self.file = None
        self.received = 0
        self.head = b""

    def open(self) -> None:
        descriptor, self.path = tempfile.mkstemp("", "minerva-upload-")
        self.file = os.fdopen(descriptor, "wb")

    def write(self, digest, body: bytes) -> None:
        if len(self.head) < uploads.SNIFF_BYTES:
            self.head += body[: uploads.SNIFF_BYTES - len(self.head)]
        digest.update(body)
        self.file.write(body)


async def _receive(
    transfer: Transfer,
    staged: _Staged,
    workspace_id: UUID,
    user_id: UUID,
    name: str,
    size: int,
    receive: Receive,
    send: Send,
) -> None:
    await transfer.io(staged.open)
    digest = hashlib.sha256()
    deadline = asyncio.get_running_loop().time() + DEADLINE_SECONDS
    while True:
        try:
            async with asyncio.timeout_at(min(deadline, asyncio.get_running_loop().time() + IDLE_SECONDS)):
                message = await receive()
        except TimeoutError:
            await refuse(send, 408, "The file took too long to arrive.")
            return
        if message["type"] == "http.disconnect":
            return
        body = message.get("body", b"")
        staged.received += len(body)
        if staged.received > size:
            await refuse(send, 400, "The body is longer than its Content-Length.")
            return
        if body:
            await transfer.io(staged.write, digest, body)
        if not message.get("more_body"):
            break
    if staged.received != size:
        await refuse(send, 400, "The body is shorter than its Content-Length.")
        return
    media_type = uploads.sniff(staged.head, name)
    try:
        upload = await transfer.io(
            _record, workspace_id, user_id, name, media_type, staged, digest.hexdigest()
        )
    except uploads.NotMember:
        await refuse(send, 401, "Unauthorized")
        return
    except uploads.TooManyUploads:
        await refuse(
            send,
            429,
            "You have too many files waiting to be sent. Send or remove some, or try again tomorrow.",
        )
        return
    except QuotaExceeded:
        await refuse(send, 413, "This workspace has no room for more files.")
        return
    body = {"id": str(upload.pk), "name": upload.name, "size": upload.size, "media_type": upload.media_type}
    await _send_json(send, 201, body)


@closing_connection
def _record(workspace_id: UUID, user_id: UUID, name: str, media_type: str, staged: _Staged, sha256: str):
    staged.file.close()
    return uploads.record_upload(
        workspace_id,
        user_id,
        name=name,
        media_type=media_type,
        path=staged.path,
        sha256=sha256,
        size=staged.received,
    )


def _discard(staged: _Staged) -> None:
    try:
        if staged.file is not None:
            staged.file.close()
    finally:
        if staged.path is not None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(staged.path)
