"""Database properties as agents read and set them.

Only properties that hold the row's own values are shown. Rollups and formulas are left out because they
can carry values from related pages the agent may not read; files because their links grant access by
themselves. Agents set only plain values, and only options a select already has: a new option would change
the database's schema. Relations are not set (a two-way relation also changes the related page), nor are
people (which notifies them).
"""

import math
import re
from typing import Any

from connectors.base import OperationError
from connectors.notion.client import has_titled_mention, text_of

READABLE = frozenset(
    {
        "title",
        "rich_text",
        "number",
        "select",
        "multi_select",
        "status",
        "date",
        "checkbox",
        "url",
        "email",
        "phone_number",
        "created_time",
        "last_edited_time",
        "created_by",
        "last_edited_by",
        "unique_id",
        "relation",
        "people",
    }
)
WRITABLE = frozenset(
    {
        "title",
        "rich_text",
        "number",
        "select",
        "multi_select",
        "status",
        "date",
        "checkbox",
        "url",
        "email",
        "phone_number",
    }
)
# Filters and sorts may use what reading shows, and nothing else: filtering on a hidden value reveals it.
FILTERABLE = READABLE
MAX_TEXT = 2000
MAX_OPTIONS = 100
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$")


def _name_or_id(user: Any) -> str | None:
    if not isinstance(user, dict):
        return None
    name = user.get("name")
    return name if isinstance(name, str) and name else user.get("id")


def _typed(properties: Any) -> dict[str, tuple[str, dict[str, Any]]]:
    """Properties with a usable type, by name; Notion's responses are not trusted to be well formed."""
    if not isinstance(properties, dict):
        return {}
    return {
        name: (prop["type"], prop)
        for name, prop in properties.items()
        if isinstance(name, str) and isinstance(prop, dict) and isinstance(prop.get("type"), str)
    }


def _by_id(properties: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        prop["id"]: prop
        for prop in properties.values()
        if isinstance(prop, dict) and isinstance(prop.get("id"), str)
    }


def _value(kind: str, value: Any) -> Any:
    match kind:
        case "title" | "rich_text":
            return text_of(value)
        case "select" | "status":
            return value.get("name") if isinstance(value, dict) else None
        case "multi_select":
            return [o.get("name") for o in value if isinstance(o, dict)] if isinstance(value, list) else []
        case "date":
            if not isinstance(value, dict):
                return None
            return {k: value.get(k) for k in ("start", "end", "time_zone")}
        case "unique_id":
            if not isinstance(value, dict):
                return None
            prefix, number = value.get("prefix"), value.get("number")
            return f"{prefix}-{number}" if prefix else number
        case "relation":
            return [r.get("id") for r in value if isinstance(r, dict)] if isinstance(value, list) else []
        case "people":
            return [_name_or_id(p) for p in value] if isinstance(value, list) else []
        case "created_by" | "last_edited_by":
            return _name_or_id(value)
        case "number" | "checkbox" | "url" | "email" | "phone_number" | "created_time" | "last_edited_time":
            return value if isinstance(value, str | int | float | bool) else None
    return None


def readable(properties: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The values of a page's properties that agents are shown. Notion lists at most 25 related pages or
    people in a page; where it has more, the value says so."""
    values = {}
    for name, (kind, prop) in _typed(properties).items():
        if kind in READABLE:
            value = _value(kind, prop.get(kind))
            values[name] = {"items": value, "more": True} if prop.get("has_more") is True else value
    return values


def schema(properties: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """A data source's properties: their types, and the options of selects."""
    described = {}
    for name, (kind, prop) in _typed(properties).items():
        entry: dict[str, Any] = {"type": kind}
        if kind not in READABLE:
            entry["hidden"] = True
        if kind in {"select", "multi_select", "status"}:
            entry["options"] = _options(prop)
        described[name] = entry
    return described


def _options(prop: dict[str, Any]) -> list[str]:
    config = prop.get(prop.get("type", ""))
    options = config.get("options") if isinstance(config, dict) else None
    if not isinstance(options, list):
        return []
    return [o["name"] for o in options if isinstance(o, dict) and isinstance(o.get("name"), str)]


def _invalid(message: str) -> OperationError:
    return OperationError("INVALID_ARGUMENTS", message)


def _text(name: str, value: Any, *, required: bool = False) -> list[dict[str, Any]]:
    if value is None and not required:
        return []
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise _invalid(f"{name!r} takes text of at most {MAX_TEXT} characters.")
    return [{"type": "text", "text": {"content": value}}] if value else []


def _plain(name: str, value: Any) -> str | None:
    if value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT):
        raise _invalid(f"{name!r} takes text of at most {MAX_TEXT} characters, or null.")
    return value or None


def _option(name: str, prop: dict[str, Any], value: Any) -> dict[str, str]:
    # The options are not listed here: an agent may edit a row without being allowed to read its database.
    if not isinstance(value, str) or value not in _options(prop):
        raise _invalid(f"{name!r} takes one of its existing options, as get_database shows them.")
    return {"name": value}


def _date(name: str, value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = {"start": value}
    if (
        not isinstance(value, dict)
        or not set(value) <= {"start", "end"}
        or not all(isinstance(v, str) and _DATE.match(v) for v in value.values())
        or "start" not in value
    ):
        raise _invalid(f'{name!r} takes a date like "2026-10-01", or {{"start": ..., "end": ...}}, or null.')
    return value


def _convert(name: str, prop: dict[str, Any], value: Any) -> Any:
    kind = prop.get("type")
    match kind:
        case "title":
            return {"title": _text(name, value, required=True)}
        case "rich_text":
            return {"rich_text": _text(name, value)}
        case "number":
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value)
            ):
                raise _invalid(f"{name!r} takes a number, or null.")
            return {"number": value}
        case "select":
            return {"select": None if value is None else _option(name, prop, value)}
        case "status":
            return {"status": _option(name, prop, value)}
        case "multi_select":
            if (
                not isinstance(value, list)
                or len(value) > MAX_OPTIONS
                or len(set(map(str, value))) != len(value)
            ):
                raise _invalid(f"{name!r} takes a list of distinct existing options.")
            return {"multi_select": [_option(name, prop, item) for item in value]}
        case "date":
            return {"date": _date(name, value)}
        case "checkbox":
            if not isinstance(value, bool):
                raise _invalid(f"{name!r} takes true or false.")
            return {"checkbox": value}
        case "url" | "email" | "phone_number":
            return {kind: _plain(name, value)}
    raise _invalid(f"Minerva does not set {kind} properties such as {name!r}.")


def writable(properties: dict[str, dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
    """Notion property values for what the agent asked to set, checked against the schema."""
    converted = {}
    typed = {name: prop for name, (_, prop) in _typed(properties).items()}
    by_id = _by_id(typed)
    for name, value in values.items():
        prop = typed.get(name)
        if prop is None:
            raise _invalid(f"There is no property named {name!r}.")
        # Notion reads these keys as names or ids.
        if by_id.get(name, prop) is not prop:
            raise _invalid(f"The property name {name!r} is also another property's id; rename it in Notion.")
        converted[name] = _convert(name, prop, value)
    return converted


def check_filter(properties: dict[str, dict[str, Any]], value: Any) -> set[str]:
    """Refuses filters and sorts that use properties agents are not shown. Returns the names of the
    properties they use."""
    typed = {name: prop for name, (_, prop) in _typed(properties).items()}
    names = {id(prop): name for name, prop in typed.items()}
    used: set[str] = set()
    _check_filter(typed, _by_id(typed), value, 0, lambda prop: used.add(names[id(prop)]))
    return used


def _check_filter(typed: dict, by_id: dict, value: Any, depth: int, use: Any) -> None:
    if depth > 8:
        raise _invalid("The filter is nested too deeply.")
    if isinstance(value, list):
        for item in value:
            _check_filter(typed, by_id, item, depth + 1, use)
        return
    if not isinstance(value, dict):
        return
    if "property" in value:
        name = value["property"]
        # Notion takes a name or an id here; a name may equal another property's id, so both must pass.
        matches = [p for p in (typed.get(name), by_id.get(name)) if p] if isinstance(name, str) else []
        if not matches:
            raise _invalid(f"There is no property named {name!r}.")
        for prop in matches:
            if prop["type"] not in FILTERABLE:
                raise _invalid(f"Minerva does not filter or sort by {prop['type']} properties.")
            use(prop)
    for item in value.values():
        _check_filter(typed, by_id, item, depth + 1, use)


def mentions_hidden(prop: Any) -> bool:
    """Whether a text property's value mentions another page, whose title a filter or sort could probe."""
    if not isinstance(prop, dict) or prop.get("type") not in {"title", "rich_text"}:
        return False
    return has_titled_mention(prop.get(prop["type"]))
