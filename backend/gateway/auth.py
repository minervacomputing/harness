from functools import wraps

from asgiref.sync import sync_to_async
from django.http import HttpRequest, JsonResponse

from runs.models import Run
from runs.services import run_for_token
from workspaces.tenancy import activate_workspace


def bearer(header: str | None) -> str | None:
    if not header or not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    return token or None


async def authenticate(header: str | None) -> Run | None:
    token = bearer(header)
    if token is None or len(token) > 200:
        return None
    return await sync_to_async(run_for_token)(token)


def error_response(message: str, status: int) -> JsonResponse:
    return JsonResponse({"error": {"message": message}}, status=status)


def unauthorized() -> JsonResponse:
    return error_response("Inactive run credential.", 401)


def run_required(view):
    """Worker-facing views: the run token is the only credential, and it selects the tenant."""

    @wraps(view)
    async def wrapper(request: HttpRequest, *args, **kwargs):
        run = await authenticate(request.headers.get("Authorization"))
        if run is None:
            return unauthorized()
        activate_workspace(run.workspace_id)
        request.run = run  # type: ignore[attr-defined]
        return await view(request, *args, **kwargs)

    return wrapper
