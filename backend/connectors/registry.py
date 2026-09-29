from functools import cache

from connectors.base import Connector


@cache
def _registry() -> dict[str, Connector]:
    from connectors.todoist.connector import TodoistConnector

    connectors: list[Connector] = [TodoistConnector()]
    return {connector.slug: connector for connector in connectors}


def get(slug: str) -> Connector:
    try:
        return _registry()[slug]
    except KeyError:
        raise LookupError(f"Unknown connector {slug!r}.") from None


def all_connectors() -> list[Connector]:
    return list(_registry().values())
