from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from asgiref.sync import async_to_sync
from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja import Field, Query, Router, Schema, Status
from ninja.errors import HttpError

from connections import services
from connections.models import Connection
from connectors import registry
from connectors.base import ACCOUNT_KIND, ApiKey, Connector, DiscoveryItem, OperationError
from permissions.models import Grant, PermissionLayer
from permissions.policy import ANY
from permissions.services import MAX_CHANGES, GrantChange, InvalidGrants, apply_grant_changes, check_changes
from runs.services import revoke_active_runs
from workspaces.auth import workspace_member

router = Router(tags=["connections"], auth=workspace_member)


class ActionOut(Schema):
    id: str
    label: str
    requires: str | None


class KindOut(Schema):
    id: str
    label: str
    actions: list[str]
    # Whether one grant can cover every resource of this kind.
    wildcard: bool
    # Whether a grant on a resource covers everything inside it (folders).
    hierarchical: bool


class ConnectorOut(Schema):
    slug: str
    name: str
    auth: Literal["oauth2", "api_key"]
    kinds: list[KindOut]
    actions: list[ActionOut]


class ConnectionOut(Schema):
    id: UUID
    provider: str
    provider_name: str
    label: str
    status: Literal[*Connection.Status.values]
    personal: bool
    created_at: datetime
    # Actions the user allows that the provider has not given Minerva access for yet.
    consent_needed: list[str]


class AuthorizeOut(Schema):
    url: str


class ConsentIn(Schema):
    # Actions to ask the provider for now, in addition to those the user already allows.
    actions: Annotated[list[str], Field(max_length=10)] = []


class GrantOut(Schema):
    kind: str
    # "*" covers every resource of the kind.
    id: str
    # The provider's name when the grant was saved; null when unknown.
    name: str | None
    actions: list[str]


class AccessOut(Schema):
    connection: ConnectionOut
    kinds: list[KindOut]
    actions: list[ActionOut]
    grants: list[GrantOut]


class ResourceOut(Schema):
    id: str
    name: str
    actions: list[str]
    # Actions allowed through the grant on every resource of this kind.
    inherited: list[str]


class ResourcePageOut(Schema):
    items: list[ResourceOut]
    next_cursor: str | None


class ResourceQuery(Schema):
    kind: Annotated[str, Field(min_length=1, max_length=64)]
    q: Annotated[str | None, Field(max_length=100)] = None
    cursor: Annotated[str | None, Field(max_length=1000)] = None


class ChangeIn(Schema):
    kind: Annotated[str, Field(min_length=1, max_length=64)]
    id: Annotated[str, Field(min_length=1, max_length=200)]
    actions: Annotated[list[str], Field(max_length=10)]


class AccessChangesIn(Schema):
    changes: Annotated[list[ChangeIn], Field(min_length=1, max_length=MAX_CHANGES)]


def _connection_out(connection: Connection, user_id: UUID) -> dict:
    connector = registry.get(connection.provider)
    needed = services.consent_needed(
        connector, services.granted_scopes(connection), services.allowed_actions(connection, user_id)
    )
    return {
        "id": connection.id,
        "provider": connection.provider,
        "provider_name": registry.get(connection.provider).name,
        "label": connection.label,
        "status": connection.status,
        "personal": connection.owner_id is not None,
        "created_at": connection.created_at,
        "consent_needed": needed,
    }


def _usable(request, connection_id: UUID) -> Connection:
    connection = get_object_or_404(Connection, pk=connection_id)
    if connection.owner_id not in (None, request.user.id):
        raise HttpError(404, "Not found.")
    return connection


def _actions(connector: Connector) -> list[dict]:
    return [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions]


def _kinds(connector: Connector) -> list[dict]:
    return [
        {
            "id": k.id,
            "label": k.label,
            "actions": list(k.actions),
            "wildcard": k.wildcard,
            "hierarchical": k.hierarchical,
        }
        for k in connector.kinds
    ]


def _provider_call(connection: Connection, call):
    """Runs `call(connector, client)` against the provider; provider failures become HTTP 502."""

    async def run():
        async with services.open_client(connection.provider, connection.id) as opened:
            return await call(registry.get(connection.provider), opened.client)

    try:
        return async_to_sync(run)()
    except OperationError as error:
        raise HttpError(502, error.message) from error


def _user_grants(request, connection: Connection):
    return Grant.objects.filter(
        layer__level=PermissionLayer.Level.USER,
        layer__user=request.user,
        connection=connection,
        effect=Grant.Effect.ALLOW,
    ).order_by("resource_kind", "resource_id")


@router.get("/workspaces/{uuid:workspace_id}/connectors", response=list[ConnectorOut])
def list_connectors(request, workspace_id: UUID):
    return [
        {
            "slug": c.slug,
            "name": c.name,
            "auth": "api_key" if isinstance(c.auth, ApiKey) else "oauth2",
            "kinds": _kinds(c),
            "actions": _actions(c),
        }
        for c in registry.all_connectors()
    ]


@router.get("/workspaces/{uuid:workspace_id}/connections", response=list[ConnectionOut])
def list_connections(request, workspace_id: UUID):
    connections = Connection.objects.filter(owner=request.user).order_by("created_at")
    shared = Connection.objects.filter(owner__isnull=True).order_by("created_at")
    return [_connection_out(c, request.user.id) for c in [*connections, *shared]]


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


@router.post(
    "/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}/reconnect", response=AuthorizeOut
)
def reconnect(request, workspace_id: UUID, connection_id: UUID, payload: ConsentIn):
    """Reconnects the account, or grants the provider access that allowed actions still need."""
    connection = _usable(request, connection_id)
    if connection.owner_id is None and not request.membership.is_admin:
        raise HttpError(403, "Only workspace admins can reconnect shared connections.")
    connector = registry.get(connection.provider)
    unknown = [a for a in payload.actions if connector.action(a) is None]
    if unknown:
        raise HttpError(422, f"{connector.name} has no action {unknown[0]!r}.")
    try:
        # A shared connection serves every member who allows something on it.
        allowed = services.allowed_actions(connection, request.user.id if connection.owner_id else None)
        scopes = services.requested_scopes(connector, allowed | set(payload.actions))
        url = services.authorization_url(
            request.session,
            workspace_id=workspace_id,
            provider=connection.provider,
            connection=connection,
            scopes=scopes,
        )
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
    """What the user allows on this connection. Does not call the provider."""
    connection = _usable(request, connection_id)
    connector = registry.get(connection.provider)
    return {
        "connection": _connection_out(connection, request.user.id),
        "kinds": _kinds(connector),
        "actions": _actions(connector),
        "grants": [
            {
                "kind": g.resource_kind,
                "id": g.resource_id,
                "name": g.resource_name or None,
                "actions": g.actions,
            }
            for g in _user_grants(request, connection)
            if connector.kind(g.resource_kind) is not None
        ],
    }


@router.get(
    "/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}/access/resources",
    response=ResourcePageOut,
)
def list_access_resources(request, workspace_id: UUID, connection_id: UUID, query: Query[ResourceQuery]):
    """One page of resources the connected account can see, with what the user allows on each."""
    connection = _usable(request, connection_id)
    connector = registry.get(connection.provider)
    if connector.kind(query.kind) is None:
        raise HttpError(422, f"{connector.name} has no resources of type {query.kind!r}.")
    if query.kind == ACCOUNT_KIND:
        items, next_cursor = [DiscoveryItem(str(connection.id), connection.label)], None
    else:
        page = _provider_call(
            connection,
            lambda c, client: c.discover(client, query.kind, query=query.q or None, cursor=query.cursor),
        )
        items, next_cursor = page.items, page.next_cursor
    granted = {
        g.resource_id: g.actions for g in _user_grants(request, connection).filter(resource_kind=query.kind)
    }
    inherited = granted.get(ANY, [])
    return {
        "items": [
            {"id": item.id, "name": item.name, "actions": granted.get(item.id, []), "inherited": inherited}
            for item in items
            if item.id != ANY
        ],
        "next_cursor": next_cursor,
    }


@router.patch("/workspaces/{uuid:workspace_id}/connections/{uuid:connection_id}/access", response=AccessOut)
def change_access(request, workspace_id: UUID, connection_id: UUID, payload: AccessChangesIn):
    """Changes what the user allows on some resources, all or nothing. Revokes the user's active runs."""
    connection = _usable(request, connection_id)
    connector = registry.get(connection.provider)
    changes = [GrantChange(c.kind, c.id, tuple(c.actions)) for c in payload.changes]
    try:
        check_changes(connector, connection, changes)
    except InvalidGrants as error:
        raise HttpError(422, str(error)) from error
    # Only resources the account can see may be allowed; removing a grant never needs the provider.
    wanted: dict[str, list[str]] = {}
    for change in changes:
        if change.actions and change.resource_id != ANY and change.kind != ACCOUNT_KIND:
            wanted.setdefault(change.kind, []).append(change.resource_id)
    names: dict[tuple[str, str], str] = {
        (c.kind, c.resource_id): connection.label for c in changes if c.kind == ACCOUNT_KIND and c.actions
    }
    if wanted:

        async def describe(c, client):
            return {kind: await c.describe(client, kind, ids) for kind, ids in wanted.items()}

        described = _provider_call(connection, describe)
        for kind, ids in wanted.items():
            for resource_id in ids:
                name = described[kind].get(resource_id)
                if name is None:
                    label = connector.kind(kind).label.lower()
                    raise HttpError(422, f"Choose a {label} that the connected account can see.")
                names[(kind, resource_id)] = name
    try:
        apply_grant_changes(user_id=request.user.id, connection=connection, changes=changes, names=names)
    except InvalidGrants as error:
        raise HttpError(422, str(error)) from error
    return get_access(request, workspace_id, connection_id)
