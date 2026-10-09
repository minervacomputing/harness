from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema, Status
from ninja.errors import HttpError

from agents.models import Agent
from conversations.models import Conversation, Message
from demo import services as demo
from files import uploads
from files.models import FolderVersion, Upload
from runs import services
from runs.models import Run, RunEvent
from workspaces.auth import workspace_member

router = Router(tags=["conversations"], auth=workspace_member)

RunStatus = Literal[*Run.Status.values]
MessageRole = Literal[*Message.Role.values]
EventType = Literal[*RunEvent.Type.values]


class ConversationOut(Schema):
    id: UUID
    agent_id: UUID
    title: str
    updated_at: datetime


class ConversationIn(Schema):
    agent_id: UUID


class AttachmentOut(Schema):
    path: str
    size: int
    media_type: str


class MessageOut(Schema):
    id: UUID
    role: MessageRole
    content: str
    attachments: list[AttachmentOut]
    run_id: UUID | None
    created_at: datetime


class EventOut(Schema):
    seq: int
    type: EventType
    data: dict[str, Any]


class ChangedFileOut(Schema):
    path: str
    size: int


class FolderChangesOut(Schema):
    """What a turn changed in the folder. Each list holds at most 100 paths; `counts` are complete."""

    counts: dict[str, int]
    added: list[ChangedFileOut]
    modified: list[ChangedFileOut]
    deleted: list[ChangedFileOut]
    dirs_added: list[str]
    dirs_deleted: list[str]


class FolderWarningOut(Schema):
    path: str
    reason: str


class FolderWarningsOut(Schema):
    """What the run left out of the folder: `total` items, at most 100 of them listed."""

    total: int
    items: list[FolderWarningOut]


class RunOut(Schema):
    id: UUID
    status: RunStatus
    error_message: str
    created_at: datetime
    finished_at: datetime | None
    # The folder the run started from (with the message's attachments) and the one it left.
    base_version_id: UUID | None
    result_version_id: UUID | None
    folder_changes: FolderChangesOut | None
    folder_warnings: FolderWarningsOut | None
    events: list[EventOut]


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    runs: list[RunOut]


class MessageIn(Schema):
    content: Annotated[str, Field(max_length=20_000)]
    # Uploads (POST /api/workspaces/{workspace_id}/uploads) to add to the conversation's folder.
    attachments: Annotated[list[UUID], Field(max_length=100)] = []


class PostedOut(Schema):
    message: MessageOut
    run: RunOut


class FolderFileOut(Schema):
    path: str
    size: int
    # Milliseconds since the epoch.
    mtime: int


class FolderOut(Schema):
    version_id: UUID | None
    files: list[FolderFileOut]
    # Empty directories.
    dirs: list[str]


def _conversation(request, conversation_id: UUID) -> Conversation:
    return get_object_or_404(Conversation, pk=conversation_id, user=request.user)


def _run_out(run: Run) -> dict:
    return {
        "id": run.id,
        "status": run.status,
        "error_message": run.error_message,
        "created_at": run.created_at,
        "finished_at": run.finished_at,
        "base_version_id": run.base_version_id,
        "result_version_id": run.result_version_id,
        "folder_changes": run.folder_changes,
        "folder_warnings": run.folder_warnings,
        "events": [{"seq": e.seq, "type": e.type, "data": e.data} for e in run.events.all()],
    }


@router.get("/workspaces/{uuid:workspace_id}/conversations", response=list[ConversationOut])
def list_conversations(request, workspace_id: UUID):
    return list(Conversation.objects.filter(user=request.user)[:100])


@router.post("/workspaces/{uuid:workspace_id}/conversations", response={201: ConversationOut})
def create_conversation(request, workspace_id: UUID, payload: ConversationIn):
    agent = get_object_or_404(Agent, pk=payload.agent_id)
    with transaction.atomic():
        if demo.is_visitor(request.user):
            try:
                demo.check_new_conversation(request.user)
            except demo.DemoLimit as error:
                raise HttpError(error.status, error.message) from error
        conversation = Conversation.objects.create(agent=agent, user=request.user)
    return Status(201, conversation)


@router.get(
    "/workspaces/{uuid:workspace_id}/conversations/{uuid:conversation_id}", response=ConversationDetail
)
def get_conversation(request, workspace_id: UUID, conversation_id: UUID):
    conversation = _conversation(request, conversation_id)
    runs = Run.objects.filter(conversation=conversation).prefetch_related("events").order_by("created_at")
    return {
        "id": conversation.id,
        "agent_id": conversation.agent_id,
        "title": conversation.title,
        "updated_at": conversation.updated_at,
        "messages": list(Message.objects.filter(conversation=conversation)),
        "runs": [_run_out(run) for run in runs],
    }


@router.delete("/workspaces/{uuid:workspace_id}/conversations/{uuid:conversation_id}", response={204: None})
def delete_conversation(request, workspace_id: UUID, conversation_id: UUID):
    conversation = _conversation(request, conversation_id)
    for run in Run.objects.filter(conversation=conversation, status__in=Run.ACTIVE):
        services.cancel(run)
    conversation.delete()
    return Status(204, None)


@router.post(
    "/workspaces/{uuid:workspace_id}/conversations/{uuid:conversation_id}/messages", response={201: PostedOut}
)
def post_message(request, workspace_id: UUID, conversation_id: UUID, payload: MessageIn):
    conversation = _conversation(request, conversation_id)
    if not payload.content.strip() and not payload.attachments:
        raise HttpError(400, "Write a message or attach a file.")
    try:
        with transaction.atomic():
            # A demo visitor's turn is counted with the run, so a refused run costs nothing.
            if demo.is_visitor(request.user):
                demo.reserve_turn(request.user)
            message, run = services.start_run(
                conversation=conversation,
                user_id=request.user.id,
                content=payload.content,
                attachments=payload.attachments,
            )
    except uploads.AttachmentsRefused as error:
        raise HttpError(error.status, error.message) from error
    except services.RunConflict as error:
        raise HttpError(409, str(error)) from error
    except demo.DemoLimit as error:
        raise HttpError(error.status, error.message) from error
    return Status(201, {"message": message, "run": _run_out(run)})


@router.get("/workspaces/{uuid:workspace_id}/conversations/{uuid:conversation_id}/files", response=FolderOut)
def list_files(request, workspace_id: UUID, conversation_id: UUID, version: UUID | None = None):
    """A version of the conversation's folder: the current one, or a run's base or result version."""
    conversation = _conversation(request, conversation_id)
    folder = conversation_version(conversation, version)
    if folder is None:
        return {"version_id": None, "files": [], "dirs": []}
    files = [
        {"path": path, "size": entry["size"], "mtime": entry["mtime"]}
        for path, entry in sorted(folder.entries["files"].items())
    ]
    return {"version_id": folder.id, "files": files, "dirs": folder.entries["dirs"]}


def conversation_version(conversation: Conversation, version_id: UUID | None) -> FolderVersion | None:
    """The conversation's folder, or the version named, which must be one of its runs' starts or results (a
    checkpoint is still being written). Raises Http404."""
    if version_id is None:
        if conversation.folder_id is None:
            return None
        version_id = conversation.folder_id
    return get_object_or_404(
        FolderVersion.unscoped.exclude(kind=FolderVersion.Kind.CHECKPOINT),
        pk=version_id,
        conversation_id=conversation.pk,
    )


@router.delete("/workspaces/{uuid:workspace_id}/uploads/{uuid:upload_id}", response={204: None})
def delete_upload(request, workspace_id: UUID, upload_id: UUID):
    """Removes an upload that was not attached; its file is deleted with the next sweep."""
    Upload.objects.filter(pk=upload_id, user=request.user).delete()
    return Status(204, None)


@router.post("/workspaces/{uuid:workspace_id}/runs/{uuid:run_id}/cancel", response=RunOut)
def cancel_run(request, workspace_id: UUID, run_id: UUID):
    run = get_object_or_404(Run, pk=run_id, user=request.user)
    services.cancel(run)
    run.refresh_from_db()
    return _run_out(run)


@router.get("/workspaces/{uuid:workspace_id}/runs/{uuid:run_id}", response=RunOut)
def get_run(request, workspace_id: UUID, run_id: UUID):
    run = get_object_or_404(Run, pk=run_id, user=request.user)
    return _run_out(run)
