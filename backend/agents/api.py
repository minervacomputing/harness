from datetime import datetime
from typing import Annotated
from uuid import UUID

from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema, Status
from ninja.errors import HttpError

from agents.models import Agent
from connections.models import Connection
from runs import services
from runs.models import Run
from workspaces.auth import workspace_member

router = Router(tags=["agents"], auth=workspace_member)


class AgentOut(Schema):
    id: UUID
    name: str
    instructions: str
    connection_ids: list[UUID]
    can_edit: bool
    created_at: datetime


class AgentIn(Schema):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    instructions: Annotated[str, Field(max_length=8000)] = ""
    connection_ids: Annotated[list[UUID], Field(max_length=20)] = []


def _out(request, agent: Agent) -> dict:
    return {
        "id": agent.id,
        "name": agent.name,
        "instructions": agent.instructions,
        "connection_ids": [c.id for c in agent.connections.all()],
        "can_edit": agent.owner_id == request.user.id or request.membership.is_admin,
        "created_at": agent.created_at,
    }


def _connections(request, ids: list[UUID]) -> list[Connection]:
    connections = list(Connection.objects.filter(pk__in=ids))
    if len(connections) != len(set(ids)) or any(not c.usable_by(request.user.id) for c in connections):
        raise HttpError(422, "Choose connections you can use.")
    return connections


def _editable(request, agent_id: UUID) -> Agent:
    agent = get_object_or_404(Agent, pk=agent_id)
    if agent.owner_id != request.user.id and not request.membership.is_admin:
        raise HttpError(403, "You cannot change this agent.")
    return agent


@router.get("/workspaces/{uuid:workspace_id}/agents", response=list[AgentOut])
def list_agents(request, workspace_id: UUID):
    return [_out(request, agent) for agent in Agent.objects.prefetch_related("connections")]


@router.post("/workspaces/{uuid:workspace_id}/agents", response={201: AgentOut})
def create_agent(request, workspace_id: UUID, payload: AgentIn):
    connections = _connections(request, payload.connection_ids)
    with transaction.atomic():
        agent = Agent.objects.create(owner=request.user, name=payload.name, instructions=payload.instructions)
        agent.connections.set(connections)
    return Status(201, _out(request, agent))


@router.get("/workspaces/{uuid:workspace_id}/agents/{uuid:agent_id}", response=AgentOut)
def get_agent(request, workspace_id: UUID, agent_id: UUID):
    return _out(request, get_object_or_404(Agent, pk=agent_id))


@router.put("/workspaces/{uuid:workspace_id}/agents/{uuid:agent_id}", response=AgentOut)
def update_agent(request, workspace_id: UUID, agent_id: UUID, payload: AgentIn):
    agent = _editable(request, agent_id)
    connections = _connections(request, payload.connection_ids)
    with transaction.atomic():
        agent.name = payload.name
        agent.instructions = payload.instructions
        agent.save()
        agent.connections.set(connections)
    return _out(request, agent)


@router.delete("/workspaces/{uuid:workspace_id}/agents/{uuid:agent_id}", response={204: None})
def delete_agent(request, workspace_id: UUID, agent_id: UUID):
    agent = _editable(request, agent_id)
    if Agent.objects.count() <= 1:
        raise HttpError(422, "Keep at least one agent.")
    for run in Run.objects.filter(agent=agent, status__in=Run.ACTIVE):
        services.cancel(run)
    agent.delete()
    return Status(204, None)
