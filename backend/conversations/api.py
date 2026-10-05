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


class MessageOut(Schema):
    id: UUID
    role: MessageRole
    content: str
    run_id: UUID | None
    created_at: datetime


class EventOut(Schema):
    seq: int
    type: EventType
    data: dict[str, Any]


class RunOut(Schema):
    id: UUID
    status: RunStatus
    error_message: str
    created_at: datetime
    finished_at: datetime | None
    events: list[EventOut]


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    runs: list[RunOut]


class MessageIn(Schema):
    content: Annotated[str, Field(min_length=1, max_length=20_000)]


class PostedOut(Schema):
    message: MessageOut
    run: RunOut


def _conversation(request, conversation_id: UUID) -> Conversation:
    return get_object_or_404(Conversation, pk=conversation_id, user=request.user)


def _run_out(run: Run) -> dict:
    return {
        "id": run.id,
        "status": run.status,
        "error_message": run.error_message,
        "created_at": run.created_at,
        "finished_at": run.finished_at,
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
    try:
        with transaction.atomic():
            # A demo visitor's turn is counted with the run, so a refused run costs nothing.
            if demo.is_visitor(request.user):
                demo.reserve_turn(request.user)
            message, run = services.start_run(
                conversation=conversation, user_id=request.user.id, content=payload.content
            )
    except services.RunConflict as error:
        raise HttpError(409, str(error)) from error
    except demo.DemoLimit as error:
        raise HttpError(error.status, error.message) from error
    return Status(201, {"message": message, "run": _run_out(run)})


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
