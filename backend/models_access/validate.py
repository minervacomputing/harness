"""Checks shared by the request builders. A request the gateway will not forward never reaches a provider."""

from typing import Any

MAX_INPUT_ITEMS = 500
MAX_TOOLS = 128
# The relay meters usage and screens provider errors event by event, so it relays streams only.
STREAM_REQUIRED = "Only streamed requests are accepted."


class InvalidModelRequest(ValueError):
    """A worker request the gateway will not forward. The message is shown to the worker."""


def capped(requested: Any, cap: int) -> int:
    # bool is an int in Python; a request for True tokens is not a request.
    return min(cap, requested) if type(requested) is int and requested > 0 else cap


def text(value: Any, what: str) -> str:
    if not isinstance(value, str):
        raise InvalidModelRequest(f"{what} must be a string.")
    return value


def items(value: Any, what: str, limit: int) -> list:
    if not isinstance(value, list) or len(value) > limit:
        raise InvalidModelRequest(f"{what} must be a list of at most {limit} entries.")
    return value


def copy_strings(item: dict[str, Any], out: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        if item.get(key) is not None:
            out[key] = text(item[key], key)
    return out


def copy_typed(item: dict[str, Any], out: dict[str, Any], kinds: tuple[type, ...], what: str, *keys: str):
    """Copies optional scalars; a missing or null one is left out. Types are matched exactly because bool
    is an int in Python, and `true` is not a temperature."""
    for key in keys:
        value = item.get(key)
        if value is not None:
            if type(value) not in kinds:
                raise InvalidModelRequest(f"{key} must be {what}.")
            out[key] = value
