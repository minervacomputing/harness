from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from asgiref.sync import async_to_sync
from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema, Status
from ninja.errors import HttpError

from connections import services
from connections.models import Connection
from connectors import registry
from connectors.base import OperationError, ScopeItem
from permissions.models import Grant, PermissionLayer
from permissions.services import GrantSpec, InvalidGrants, replace_user_grants, validate_grants
from runs.services import revoke_active_runs
from workspaces.auth import workspace_member

router = Router(tags=["connections"], auth=workspace_member)


class ActionOut(Schema):
    id: str
    label: str
    requires: str | None


class ConnectorOut(Schema):
    slug: str
    name: str
    scope_label: str
    actions: list[ActionOut]


class ConnectionOut(Schema):
    id: UUID
    provider: str
    provider_name: str
    label: str
    status: Literal[*Connection.Status.values]
    personal: bool
    created_at: datetime


class AuthorizeOut(Schema):
    url: str


class ResourceAccess(Schema):
    id: str
    name: str
    actions: list[str]


class AccessOut(Schema):
    connection: ConnectionOut
    scope_label: str
    actions: list[ActionOut]
    resources: list[ResourceAccess]


class ResourceAccessIn(Schema):
    id: Annotated[str, Field(min_length=1, max_length=200)]
    actions: Annotated[list[str], Field(max_length=10)]


class AccessIn(Schema):
    resources: Annotated[list[ResourceAccessIn], Field(max_length=500)]


def _connection_out(connection: Connection) -> dict:
    return {
        "id": connection.id,
        "provider": connection.provider,
        "provider_name": registry.get(connection.provider).name,
        "label": connection.label,
        "status": connection.status,
        "personal": connection.owner_id is not None,
        "created_at": connection.created_at,
    }


def _usable(request, connection_id: UUID) -> Connection:
    connection = get_object_or_404(Connection, pk=connection_id)
    if connection.owner_id not in (None, request.user.id):
        raise HttpError(404, "Not found.")
    return connection


def _scope(connection: Connection) -> list[ScopeItem]:
    async def fetch() -> list[ScopeItem]:
        async with services.open_client(connection.provider, connection.id) as client:
            return await registry.get(connection.provider).list_scope(client)

    try:
        return async_to_sync(fetch)()
    except OperationError as error:
        raise HttpError(502, error.message) from error


def _actions(slug: str) -> list[dict]:
    return [{"id": a.id, "label": a.label, "requires": a.requires} for a in registry.get(slug).actions]


@router.get("/workspaces/{uuid:workspace_id}/connectors", response=list[ConnectorOut])
def list_connectors(request, workspace_id: UUID):
    return [
        {"slug": c.slug, "name": c.name, "scope_label": c.scope_label, "actions": _actions(c.slug)}
        for c in registry.all_connectors()
    ]


@router.get("/workspaces/{uuid:workspace_id}/connections", response=list[ConnectionOut])
def list_connections(request, workspace_id: UUID):
    connections = Connection.objects.filter(owner=request.user).order_by("created_at")
    shared = Connection.objects.filter(owner__isnull=True).order_by("created_at")
    return [_connection_out(c) for c in [*connections, *shared]]


@router.post("/workspaces/{uuid:workspace_id}/connections/{provider}/authorize", response=AuthorizeOut)
def authorize(request, workspace_id: UUID, provider: str):
    try:
        registry.get(provider)
    except LookupError:
        raise HttpError(404, "Unknown provider.") from None
    try:
        url = services.authorization_url(request.session, workspace_id=workspace_id, provider=provider)
    except services.ConnectionFlowError as error:
        raise HttpError(503, str(error)) from error
    return {"url": url}


@router.delete("/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}", response={204: None})
def delete_connection(request, workspace_id: UUID, connection_id: UUID):
    connection = _usable(request, connection_id)
    if connection.owner_id is None and not request.membership.is_admin:
        raise HttpError(403, "Only workspace admins can remove shared connections.")
    with transaction.atomic():
        connection.delete()
        revoke_active_runs(user_id=request.user.id, reason="connection_removed")
    return Status(204, None)


@router.get("/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}/access", response=AccessOut)
def get_access(request, workspace_id: UUID, connection_id: UUID):
    connection = _usable(request, connection_id)
    connector = registry.get(connection.provider)
    items = _scope(connection)
    grants = Grant.objects.filter(
        layer__level=PermissionLayer.Level.USER,
        layer__user=request.user,
        connection=connection,
        effect=Grant.Effect.ALLOW,
        resource_kind=connector.scope_kind,
    )
    granted = {grant.resource_id: grant.actions for grant in grants}
    return {
        "connection": _connection_out(connection),
        "scope_label": connector.scope_label,
        "actions": _actions(connection.provider),
        "resources": [{"id": i.id, "name": i.name, "actions": granted.get(i.id, [])} for i in items],
    }


@router.put("/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}/access", response=AccessOut)
def set_access(request, workspace_id: UUID, connection_id: UUID, payload: AccessIn):
    connection = _usable(request, connection_id)
    connector = registry.get(connection.provider)
    specs = [
        GrantSpec(connection.id, connector.scope_kind, item.id, tuple(item.actions))
        for item in payload.resources
        if item.actions
    ]
    visible = {item.id for item in _scope(connection)}
    try:
        validate_grants(specs, user_id=request.user.id, scope={connection.id: visible})
    except InvalidGrants as error:
        raise HttpError(422, str(error)) from error
    replace_user_grants(user_id=request.user.id, connection_id=connection.id, specs=specs)
    return get_access(request, workspace_id, connection_id)
