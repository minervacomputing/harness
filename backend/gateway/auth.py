import asyncio
from functools import wraps

from asgiref.sync import sync_to_async
from django.db import connection
from django.http import HttpRequest, JsonResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from gateway.asgi_json import send_error
from runs.models import Run
from runs.services import run_for_token
from workspaces.tenancy import activate_workspace

INACTIVE = "Inactive run credential."
# Set by require_run for an active run's token; a client cannot set scope keys.
RUN_SCOPE_KEY = "minerva.run_id"
# The attempt current when the request was authenticated; the run may move on while the request runs.
ATTEMPT_SCOPE_KEY = "minerva.attempt"


def bearer(header: str | None) -> str | None:
    if not header or not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    return token or None


def _run_for_token(token: str) -> Run | None:
    # require_run checks tokens outside Django's request cycle, which is what closes a failed connection. Without
    # this, one dropped connection would fail every later check in the process.
    if connection.errors_occurred:
        connection.close()
    return run_for_token(token)


def _usable(header: str | None) -> str | None:
    """The bearer token in `header`, unless there is none or it is too long to be one."""
    token = bearer(header)
    return token if token is not None and len(token) <= 200 else None


async def authenticate(header: str | None) -> Run | None:
    token = _usable(header)
    if token is None:
        return None
    return await sync_to_async(_run_for_token)(token)


def require_run(app: ASGIApp, max_checking: int) -> ASGIApp:
    """Refuses a request without an active run's token before the app reads its body: Django's handler buffers
    the whole body before any view runs. The app gets the run's id and attempt in the scope.

    Tokens are checked one at a time, on asgiref's shared thread, so a flood of invented ones costs queries on
    one connection. At most `max_checking` checks are queued or running (per process); a request that would
    add one is refused with 503."""
    checks: set[asyncio.Task[Run | None]] = set()

    async def gated(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        # limit_in_flight answers several Authorization headers with 400; here they count as none.
        headers = [value for name, value in scope.get("headers", []) if name.lower() == b"authorization"]
        header = headers[0].decode("latin-1") if len(headers) == 1 else None
        if _usable(header) is None:
            await send_error(send, 401, INACTIVE)
            return
        if len(checks) >= max_checking:
            await send_error(send, 503, "The gateway is busy. Try again.")
            return
        # A check runs to the end even if its request is cancelled, and holds its place until then: a cancelled
        # lookup would stay queued on the thread.
        check = asyncio.ensure_future(authenticate(header))
        checks.add(check)
        check.add_done_callback(checks.discard)
        run = await asyncio.shield(check)
        if run is None:
            await send_error(send, 401, INACTIVE)
            return
        await app({**scope, RUN_SCOPE_KEY: run.id, ATTEMPT_SCOPE_KEY: run.attempt}, receive, send)

    return gated


def error_response(message: str, status: int) -> JsonResponse:
    return JsonResponse({"error": {"message": message}}, status=status)


def unauthorized() -> JsonResponse:
    return error_response(INACTIVE, 401)


def run_required(view):
    """Worker-facing views: the run token is the only credential, and it selects the tenant. require_run has
    already checked it, but before Django read the body; this checks the run as it is now."""

    @wraps(view)
    async def wrapper(request: HttpRequest, *args, **kwargs):
        run = await authenticate(request.headers.get("Authorization"))
        if run is None:
            return unauthorized()
        activate_workspace(run.workspace_id)
        request.run = run  # type: ignore[attr-defined]
        return await view(request, *args, **kwargs)

    return wrapper
