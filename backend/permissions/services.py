from dataclasses import dataclass
from uuid import UUID

from django.db import transaction
from django.db.models import F, Prefetch

from connections.models import Connection
from connectors import registry
from connectors.base import ACCOUNT_KIND, Connector
from permissions.models import Grant, PermissionLayer
from permissions.policy import ANY, Layer, Policy

# A missing layer means: ceiling passes everything through, a user allows nothing until they choose,
# an agent inherits whatever the layers above allow.
DEFAULT_RESTRICTED = {
    PermissionLayer.Level.CEILING: False,
    PermissionLayer.Level.USER: True,
    PermissionLayer.Level.AGENT: False,
}
MAX_CHANGES = 100
MAX_GRANTS_PER_CONNECTION = 500


class InvalidGrants(ValueError):
    pass


@dataclass(frozen=True)
class GrantChange:
    """The actions a user allows on one resource of one connection. No actions removes the grant."""

    kind: str
    resource_id: str
    actions: tuple[str, ...]


def _layer_query(level: str, *, user_id: UUID | None = None, agent_id: UUID | None = None):
    return PermissionLayer.objects.filter(level=level, user_id=user_id, agent_id=agent_id)


def _enforceable(grant: Grant) -> bool:
    """Denies always apply. An allow counts only for a kind the connector still declares, and a wildcard
    allow only where the kind supports one, so a hand-edited row cannot widen access."""
    if grant.effect == Grant.Effect.DENY:
        return True
    try:
        kind = registry.get(grant.connection.provider).kind(grant.resource_kind)
    except LookupError:
        return False
    return kind is not None and (grant.resource_id != ANY or kind.wildcard)


def _to_layer(name: str, level: str, layer: PermissionLayer | None) -> Layer:
    if layer is None:
        return Layer(name, DEFAULT_RESTRICTED[level], frozenset(), frozenset())
    grants = [
        (str(g.connection_id), g.resource_kind, g.resource_id, g.actions, g.effect)
        for g in layer.grants.all()
        if _enforceable(g)
    ]
    return Layer.build(name, layer.restricted, grants)


def effective_policy(*, user_id: UUID, agent_id: UUID, lock: bool = False) -> Policy:
    """Snapshot of every layer that applies to a run by this user with this agent (current workspace).

    With `lock`, the layers stay locked until the transaction ends, so a grant edit either finishes
    before the snapshot or sees the new run when it revokes active runs.
    """
    specs = [
        ("ceiling", PermissionLayer.Level.CEILING, _layer_query(PermissionLayer.Level.CEILING)),
        ("user", PermissionLayer.Level.USER, _layer_query(PermissionLayer.Level.USER, user_id=user_id)),
        ("agent", PermissionLayer.Level.AGENT, _layer_query(PermissionLayer.Level.AGENT, agent_id=agent_id)),
    ]
    grants = Prefetch("grants", queryset=Grant.objects.select_related("connection"))
    layers = []
    for name, level, query in specs:
        if lock:
            query = query.select_for_update(of=("self",))
        layers.append(_to_layer(name, level, query.prefetch_related(grants).first()))
    return Policy(tuple(layers))


def user_layer(user_id: UUID) -> PermissionLayer:
    layer, _ = PermissionLayer.objects.get_or_create(
        level=PermissionLayer.Level.USER,
        user_id=user_id,
        agent_id=None,
        defaults={"restricted": True},
    )
    return layer


def user_grants(connection: Connection, user_id: UUID | None):
    """The allow grants users set on the connection: one user's, or with None, every user's."""
    grants = Grant.objects.filter(
        layer__level=PermissionLayer.Level.USER, connection=connection, effect=Grant.Effect.ALLOW
    )
    if user_id is not None:
        grants = grants.filter(layer__user_id=user_id)
    return grants.order_by("resource_kind", "resource_id")


def allowed_actions(connection: Connection, user_id: UUID | None) -> set[str]:
    """Every action the user (or, with None, any user) allows on some resource of the connection."""
    grants = user_grants(connection, user_id).values_list("actions", flat=True)
    return {action for actions in grants for action in actions}


def _label(connector: Connector, action_id: str) -> str:
    action = connector.action(action_id)
    return action.label if action else action_id


def check_changes(connector: Connector, connection: Connection, changes: list[GrantChange]) -> None:
    """Rejects changes the connector cannot enforce, before anything asks the provider about them."""
    if not changes:
        raise InvalidGrants("Nothing to change.")
    if len(changes) > MAX_CHANGES:
        raise InvalidGrants(f"Change at most {MAX_CHANGES} resources at once.")
    seen: set[tuple[str, str]] = set()
    for change in changes:
        kind = connector.kind(change.kind)
        if kind is None:
            raise InvalidGrants(f"{connector.name} has no resources of type {change.kind!r}.")
        if not change.resource_id or len(change.resource_id) > 200:
            raise InvalidGrants("Choose a resource.")
        if change.resource_id == ANY and not kind.wildcard:
            raise InvalidGrants(f"Permissions for {kind.label.lower()} resources are set one at a time.")
        if kind.id == ACCOUNT_KIND and change.resource_id != str(connection.pk):
            raise InvalidGrants("Account permissions apply to the connection itself.")
        key = (change.kind, change.resource_id)
        if key in seen:
            raise InvalidGrants("Each resource can only be listed once.")
        seen.add(key)
        for action_id in change.actions:
            if action_id not in kind.actions:
                raise InvalidGrants(
                    f"{connector.name} does not support {action_id!r} on {kind.label.lower()}."
                )


def _check_state(
    connector: Connector,
    state: dict[tuple[str, str], set[str]],
    names: dict[tuple[str, str], str],
    kinds: set[str],
) -> None:
    """Checks the grants as they will be after the change. A requirement may be met by a wildcard grant."""
    if sum(1 for actions in state.values() if actions) > MAX_GRANTS_PER_CONNECTION:
        raise InvalidGrants(f"A connection can have at most {MAX_GRANTS_PER_CONNECTION} permissions.")
    for (kind, resource_id), actions in sorted(state.items()):
        if kind not in kinds:
            continue
        inherited = state.get((kind, ANY), set())
        for action_id in sorted(actions):
            required = connector.requires_of(action_id)
            if required is not None and required not in actions and required not in inherited:
                name = names.get((kind, resource_id)) or resource_id
                raise InvalidGrants(
                    f"{_label(connector, action_id)} on {name} also requires {_label(connector, required)}."
                )


def apply_grant_changes(
    *, user_id: UUID, connection: Connection, changes: list[GrantChange], names: dict[tuple[str, str], str]
) -> dict[tuple[str, str], set[str]]:
    """Applies a set of changes to the user's allow grants on one connection, all or nothing, and revokes
    the user's active runs. Returns the resulting grants. `names` are provider names for display."""
    from runs.services import revoke_active_runs

    connector = registry.get(connection.provider)
    check_changes(connector, connection, changes)
    with transaction.atomic():
        layer = user_layer(user_id)
        PermissionLayer.objects.select_for_update().get(pk=layer.pk)
        rows = {
            (g.resource_kind, g.resource_id): g
            for g in Grant.objects.filter(layer=layer, connection=connection, effect=Grant.Effect.ALLOW)
        }
        state = {key: set(g.actions) for key, g in rows.items()}
        stored_names = {key: g.resource_name for key, g in rows.items() if g.resource_name}
        for change in changes:
            state[(change.kind, change.resource_id)] = set(change.actions)
        _check_state(connector, state, {**stored_names, **names}, {change.kind for change in changes})
        for change in changes:
            key = (change.kind, change.resource_id)
            row = rows.get(key)
            if not change.actions:
                if row is not None:
                    row.delete()
                continue
            if row is None:
                row = Grant(
                    workspace_id=layer.workspace_id,
                    layer=layer,
                    connection=connection,
                    resource_kind=change.kind,
                    resource_id=change.resource_id,
                )
            row.actions = sorted(set(change.actions))
            row.resource_name = names.get(key, row.resource_name)
            row.save()
        PermissionLayer.objects.filter(pk=layer.pk).update(version=F("version") + 1)
        revoke_active_runs(user_id=user_id, reason="permissions_changed")
    return {key: actions for key, actions in state.items() if actions}
