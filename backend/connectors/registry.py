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
# Set by the flow itself; a connector's `authorize_params` must not replace them.
RESERVED_AUTHORIZE_PARAMS = frozenset(
    {
        "client_id",
        "client_secret",
        "code",
        "code_challenge",
        "code_challenge_method",
        "grant_type",
        "login_hint",
        "redirect_uri",
        "resource",
        "response_type",
        "scope",
        "state",
    }
)


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
    for kind_id, action in op.needs:
        kind = connector.kind(kind_id)
        if kind is None:
            raise InvalidConnector(f"{where}: unknown kind {kind_id!r}.")
        for item in _chain(connector, action):
            if item not in kind.actions:
                raise InvalidConnector(f"{where}: {item!r} does not apply to {kind_id!r}.")
    # Records may be scoped to any kind the operation needs; the output action must apply to one of them,
    # and records of a kind it does not apply to are dropped.
    output_chain = _chain(connector, op.output_action)
    if not any(
        all(item in connector.kind(kind_id).actions for item in output_chain) for kind_id, _ in op.needs
    ):
        raise InvalidConnector(f"{where}: {op.output_action!r} applies to none of its kinds.")
    if op.consent is not None and not isinstance(connector.auth, OAuth2):
        raise InvalidConnector(f"{where}: consent needs an OAuth connector.")
    if op.paginated and "cursor" not in op.input_model.model_fields:
        raise InvalidConnector(f"{where}: paginated operations take a cursor.")


def _validate_auth(connector: Connector) -> None:
    oauth = connector.auth
    if not isinstance(oauth, OAuth2):
        return
    if not NAME_PATTERN.match(oauth.app):
        raise InvalidConnector(
            f"{connector.slug}: OAuth app names are lowercase words joined by underscores."
        )
    urls = [oauth.authorize_url, oauth.token_url, oauth.registration_url]
    if any(url is not None and not url.startswith("https://") for url in urls):
        raise InvalidConnector(f"{connector.slug}: OAuth endpoints must use HTTPS.")
    names = [name for name, _ in oauth.authorize_params]
    if len(set(names)) != len(names) or RESERVED_AUTHORIZE_PARAMS.intersection(names):
        raise InvalidConnector(
            f"{connector.slug}: authorize_params repeats or replaces a protocol parameter."
        )


def validate(connectors: list[Connector]) -> None:
    tools: dict[str, str] = {}
    slugs: set[str] = set()
    for connector in connectors:
        if not NAME_PATTERN.match(connector.slug) or connector.slug in slugs:
            raise InvalidConnector(
                f"{connector.slug!r}: slugs are unique lowercase words joined by underscores."
            )
        slugs.add(connector.slug)
        _validate_auth(connector)
        for action in connector.actions:
            if action.requires is not None and connector.action(action.requires) is None:
                raise InvalidConnector(f"{connector.slug}: {action.id!r} requires an unknown action.")
            _chain(connector, action.id)
        kind_ids = [kind.id for kind in connector.kinds]
        if not kind_ids or len(set(kind_ids)) != len(kind_ids):
            raise InvalidConnector(f"{connector.slug}: kinds must be declared once each.")
        for kind in connector.kinds:
            if kind.id == ACCOUNT_KIND and (kind.wildcard or kind.hierarchical):
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
            kind.id: {
                "actions": sorted(kind.actions),
                "wildcard": kind.wildcard,
                "hierarchical": kind.hierarchical,
            }
            for kind in connector.kinds
            if kind.id in kinds
        },
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _declared() -> list[Connector]:
    from connectors.github.connector import GitHubConnector
    from connectors.gmail.connector import GmailConnector
    from connectors.google_calendar.connector import GoogleCalendarConnector
    from connectors.google_drive.connector import GoogleDriveConnector
    from connectors.hubspot.connector import HubSpotConnector
    from connectors.linear.connector import LinearConnector
    from connectors.notion.connector import NotionConnector
    from connectors.onedrive.connector import OneDriveConnector
    from connectors.outlook.connector import OutlookConnector
    from connectors.outlook_calendar.connector import OutlookCalendarConnector
    from connectors.slack.connector import SlackConnector
    from connectors.stripe.connector import StripeConnector
    from connectors.teams.connector import TeamsConnector
    from connectors.todoist.connector import TodoistConnector
    from connectors.web.connector import WebConnector

    return [
        TodoistConnector(),
        GoogleCalendarConnector(),
        GoogleDriveConnector(),
        GitHubConnector(),
        NotionConnector(),
        LinearConnector(),
        SlackConnector(),
        OutlookConnector(),
        OutlookCalendarConnector(),
        OneDriveConnector(),
        TeamsConnector(),
        GmailConnector(),
        StripeConnector(),
        HubSpotConnector(),
        WebConnector(),
    ]


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
