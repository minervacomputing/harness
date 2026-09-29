from dataclasses import dataclass
from uuid import UUID

from django.db import transaction
from django.db.models import F

from connections.models import Connection
from connectors import registry
from permissions.models import Grant, PermissionLayer
from permissions.policy import Layer, Policy

# A missing layer means: ceiling passes everything through, a user allows nothing until they choose,
# an agent inherits whatever the layers above allow.
DEFAULT_RESTRICTED = {
    PermissionLayer.Level.CEILING: False,
    PermissionLayer.Level.USER: True,
    PermissionLayer.Level.AGENT: False,
}


class InvalidGrants(ValueError):
    pass


@dataclass(frozen=True)
class GrantSpec:
    connection_id: UUID
    resource_kind: str
    resource_id: str
    actions: tuple[str, ...]


def _layer_query(level: str, *, user_id: UUID | None = None, agent_id: UUID | None = None):
    return PermissionLayer.objects.filter(level=level, user_id=user_id, agent_id=agent_id)


def _to_layer(name: str, level: str, layer: PermissionLayer | None) -> Layer:
    if layer is None:
        return Layer(name, DEFAULT_RESTRICTED[level], frozenset(), frozenset())
    grants = [
        (str(g.connection_id), g.resource_kind, g.resource_id, g.actions, g.effect)
        for g in layer.grants.all()
    ]
    return Layer.build(name, layer.restricted, grants)


def effective_policy(*, user_id: UUID, agent_id: UUID) -> Policy:
    """Snapshot of every layer that applies to a run by this user with this agent (current workspace)."""
    specs = [
        ("ceiling", PermissionLayer.Level.CEILING, _layer_query(PermissionLayer.Level.CEILING)),
        ("user", PermissionLayer.Level.USER, _layer_query(PermissionLayer.Level.USER, user_id=user_id)),
        ("agent", PermissionLayer.Level.AGENT, _layer_query(PermissionLayer.Level.AGENT, agent_id=agent_id)),
    ]
    layers = [
        _to_layer(name, level, query.prefetch_related("grants").first()) for name, level, query in specs
    ]
    return Policy(tuple(layers))


def user_layer(user_id: UUID) -> PermissionLayer:
    layer, _ = PermissionLayer.objects.get_or_create(
        level=PermissionLayer.Level.USER,
        user_id=user_id,
        agent_id=None,
        defaults={"restricted": True},
    )
    return layer


def validate_grants(specs: list[GrantSpec], *, user_id: UUID, scope: dict[UUID, set[str]]) -> None:
    """Reject grants the connector cannot enforce, so a saved setting never silently means less.

    `scope` maps each connection to the resource ids its account can currently see.
    """
    seen: set[tuple[UUID, str, str]] = set()
    for spec in specs:
        connection = Connection.objects.filter(pk=spec.connection_id).first()
        if connection is None or not connection.usable_by(user_id):
            raise InvalidGrants("Choose one of your active connections.")
        connector = registry.get(connection.provider)
        if spec.resource_kind != connector.scope_kind:
            raise InvalidGrants(f"{connector.name} permissions are set per {connector.scope_label.lower()}.")
        if spec.resource_id not in scope.get(spec.connection_id, set()):
            raise InvalidGrants(
                f"Choose a {connector.scope_label.lower()} that the connected account can see."
            )
        key = (spec.connection_id, spec.resource_kind, spec.resource_id)
        if key in seen:
            raise InvalidGrants("Each resource can only be listed once.")
        seen.add(key)
        for action_id in spec.actions:
            action = connector.action(action_id)
            if action is None:
                raise InvalidGrants(f"{connector.name} does not support the action {action_id!r}.")
            if action.requires and action.requires not in spec.actions:
                required = connector.action(action.requires)
                label = required.label if required else action.requires
                raise InvalidGrants(f"{action.label} also requires {label}.")


def replace_user_grants(*, user_id: UUID, connection_id: UUID, specs: list[GrantSpec]) -> PermissionLayer:
    """Replace the user's allow grants for one connection. Active runs in the workspace are revoked."""
    from runs.services import revoke_active_runs

    with transaction.atomic():
        layer = user_layer(user_id)
        PermissionLayer.objects.filter(pk=layer.pk).select_for_update().get()
        Grant.objects.filter(layer=layer, connection_id=connection_id, effect=Grant.Effect.ALLOW).delete()
        Grant.objects.bulk_create(
            [
                Grant(
                    workspace_id=layer.workspace_id,
                    layer=layer,
                    connection_id=spec.connection_id,
                    resource_kind=spec.resource_kind,
                    resource_id=spec.resource_id,
                    actions=sorted(set(spec.actions)),
                )
                for spec in specs
                if spec.actions
            ]
        )
        PermissionLayer.objects.filter(pk=layer.pk).update(version=F("version") + 1)
        revoke_active_runs(user_id=user_id, reason="permissions_changed")
    return layer
