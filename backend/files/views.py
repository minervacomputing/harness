"""`GET /api/workspaces/{workspace_id}/conversations/{conversation_id}/files/download?path=&version=`: a file of the
conversation's folder (or of the version named), for its owner.

An async view, since Django buffers a synchronous iterator whole under ASGI. The file is always sent as an
attachment of type application/octet-stream that the browser may not sniff or render, so a file an agent wrote
cannot run as a page of this site.
"""

from uuid import UUID

from asgiref.sync import sync_to_async
from django.http import Http404, HttpRequest, HttpResponse, JsonResponse, StreamingHttpResponse
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET

from conversations.api import conversation_version
from conversations.models import Conversation
from files.models import Blob
from files.transfers import Busy, Download, Transfer, closing_connection
from workspaces.models import Membership

DOWNLOADS_PER_USER = 4


@require_GET
async def download(request: HttpRequest, workspace_id: UUID, conversation_id: UUID) -> HttpResponse:
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({"detail": "Unauthorized"}, status=401)
    path = request.GET.get("path", "")
    raw_version = request.GET.get("version")
    try:
        version_id = UUID(raw_version) if raw_version else None
    except ValueError:
        return JsonResponse({"detail": "Not Found"}, status=404)
    blob = await sync_to_async(_find, thread_sensitive=False)(
        workspace_id, conversation_id, user, version_id, path
    )
    if blob is None:
        return JsonResponse({"detail": "Not Found"}, status=404)
    try:
        transfer = Transfer(("download", user.pk), DOWNLOADS_PER_USER)
    except Busy:
        return JsonResponse({"detail": "You are downloading too many files at once."}, status=429)
    stream = Download(transfer)
    try:
        await transfer.io(stream.open, blob)
        response = StreamingHttpResponse(stream, content_type="application/octet-stream")
    except BaseException:
        stream.close()
        raise
    response["Content-Length"] = str(blob.size)
    response["Content-Disposition"] = content_disposition_header(True, path.rsplit("/", 1)[-1])
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "sandbox"
    response["Cache-Control"] = "private, no-store"
    return response


@closing_connection
def _find(workspace_id: UUID, conversation_id: UUID, user, version_id: UUID | None, path: str) -> Blob | None:
    """The blob at `path` in the folder version, if the user may read it."""
    if not Membership.objects.filter(workspace_id=workspace_id, user=user).exists():
        return None
    conversation = Conversation.unscoped.filter(
        pk=conversation_id, workspace_id=workspace_id, user=user
    ).first()
    if conversation is None:
        return None
    try:
        version = conversation_version(conversation, version_id)
    except Http404:
        return None
    entry = version.entries["files"].get(path) if version is not None else None
    if entry is None:
        return None
    return Blob.unscoped.filter(workspace_id=workspace_id, sha256=entry["sha256"]).first()
