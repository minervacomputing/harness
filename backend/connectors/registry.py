"""The registered connectors. Declarations are validated before anything can use them."""

import hashlib
import json
import re
from functools import cache

from connectors.base import ACCOUNT_KIND, Connector, OAuth2, Operation

# No digits: a second connection of a provider gets a numeric suffix (todoist2), which then cannot collide.
NAME_PATTERN = re.compile(r"^[a-z]+(_[a-z]+)*$")
MAX_TOOL_NAME = 64
MAX_ALIAS_SUFFIX = "99"


class InvalidConnector(Exception):
    pass


def _chain(connector: Connector, action: str) -> list[str]:
    chain: list[str] = []
    current: str | None = action
    while current is not None:
        if current in chain:
            raise InvalidConnector(f"{connector.slug}: the action {action!r} requires itself.")
        chain.append(current)
        current = connector.requires_of(current)
    return chain


def _validate_operation(connector: Connector, op: Operation) -> None:
    where = f"{connector.slug}.{op.name}"
    if not NAME_PATTERN.match(op.name):
        raise InvalidConnector(f"{where}: operation names are lowercase words joined by underscores.")
    if len(f"{connector.slug}{MAX_ALIAS_SUFFIX}_{op.name}") > MAX_TOOL_NAME:
        raise InvalidConnector(f"{where}: the tool name would exceed {MAX_TOOL_NAME} characters.")
    if not op.needs:
        raise InvalidConnector(f"{where}: declares no needs.")
    for kind_id, action in [*op.needs, *((k, op.output_action) for k, _ in op.needs)]:
        kind = connector.kind(kind_id)
        if kind is None:
            raise InvalidConnector(f"{where}: unknown kind {kind_id!r}.")
        for item in _chain(connector, action):
            if item not in kind.actions:
                raise InvalidConnector(f"{where}: {item!r} does not apply to {kind_id!r}.")
    if op.consent is not None and not isinstance(connector.auth, OAuth2):
        raise InvalidConnector(f"{where}: consent needs an OAuth connector.")
    if op.paginated and "cursor" not in op.input_model.model_fields:
        raise InvalidConnector(f"{where}: paginated operations take a cursor.")


def validate(connectors: list[Connector]) -> None:
    tools: dict[str, str] = {}
    slugs: set[str] = set()
    for connector in connectors:
        if not NAME_PATTERN.match(connector.slug) or connector.slug in slugs:
            raise InvalidConnector(
                f"{connector.slug!r}: slugs are unique lowercase words joined by underscores."
            )
        slugs.add(connector.slug)
        for action in connector.actions:
            if action.requires is not None and connector.action(action.requires) is None:
                raise InvalidConnector(f"{connector.slug}: {action.id!r} requires an unknown action.")
            _chain(connector, action.id)
        kind_ids = [kind.id for kind in connector.kinds]
        if not kind_ids or len(set(kind_ids)) != len(kind_ids):
            raise InvalidConnector(f"{connector.slug}: kinds must be declared once each.")
        for kind in connector.kinds:
            if kind.id == ACCOUNT_KIND and kind.wildcard:
                raise InvalidConnector(f"{connector.slug}: the account kind has one resource.")
            for action_id in kind.actions:
                if connector.action(action_id) is None:
                    raise InvalidConnector(f"{connector.slug}: {kind.id!r} lists an unknown action.")
        names = [op.name for op in connector.operations]
        if len(set(names)) != len(names):
            raise InvalidConnector(f"{connector.slug}: operation names must be unique.")
        for op in connector.operations:
            _validate_operation(connector, op)
            tool = f"{connector.slug}_{op.name}"
            if tool in tools:
                raise InvalidConnector(f"{tool!r} is declared by both {tools[tool]} and {connector.slug}.")
            tools[tool] = connector.slug


def fingerprint(connector: Connector, op: Operation) -> str:
    """Identifies what a tool means. Runs snapshot it, and a tool whose meaning changed stops working."""
    actions = sorted({action for _, action in op.needs} | {op.output_action})
    kinds = sorted({kind for kind, _ in op.needs})
    payload = {
        "revision": op.revision,
        "input": op.input_schema(),
        "needs": sorted(op.needs),
        "output": op.output_action,
        "consent": sorted(sorted(option) for option in op.consent) if op.consent is not None else None,
        "mutates": op.mutates,
        "paginated": op.paginated,
        "requires": {action: _chain(connector, action) for action in actions},
        "kinds": {
            kind.id: {"actions": sorted(kind.actions), "wildcard": kind.wildcard}
            for kind in connector.kinds
            if kind.id in kinds
        },
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _declared() -> list[Connector]:
    from connectors.google_calendar.connector import GoogleCalendarConnector
    from connectors.todoist.connector import TodoistConnector

    return [TodoistConnector(), GoogleCalendarConnector()]


@cache
def _registry() -> dict[str, Connector]:
    connectors = _declared()
    validate(connectors)
    return {connector.slug: connector for connector in connectors}


def get(slug: str) -> Connector:
    try:
        return _registry()[slug]
    except KeyError:
        raise LookupError(f"Unknown connector {slug!r}.") from None


def all_connectors() -> list[Connector]:
    return list(_registry().values())


@cache
def contract(provider: str, operation: str) -> str:
    connector = get(provider)
    op = connector.operation(operation)
    if op is None:
        raise LookupError(f"Unknown operation {provider}.{operation}.")
    return fingerprint(connector, op)


def resolve(provider: str, operation: str, snapshot: str) -> Operation | None:
    """The operation a run's tool refers to, or None when it no longer exists or changed meaning."""
    try:
        connector = get(provider)
    except LookupError:
        return None
    op = connector.operation(operation)
    if op is None or contract(provider, operation) != snapshot:
        return None
    return op
