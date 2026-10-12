"""Writes vectors.json: what today's Python Todoist connector (backend/connectors/todoist/) does.

- `declaration`: the connector as Python declares it (kinds, actions, auth, operations and their strings).
- `inputs`: each operation's input model on raw arguments: the normalized fields with the query hash and
  write key the executor computes from them, or the executor's "Invalid arguments." message.
- `lax`: field values as the response models read them (Pydantic's lax mode).
- `scenarios`: account, discover, describe and every operation's prepare and execute, run against
  scripted provider responses through httpx.MockTransport: the requests sent and what came back.
- `casefold`: `str.casefold()` of every code point it changes (discover's search).

The executor's helpers (validation_message, _canonical, _hash) are read from executor.py's source, which
imports Django, rather than restated.

Run from cloudflare/:
  cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/todoist/generate.py
"""

import ast
import asyncio
import hashlib
import json
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.base import (  # noqa: E402
    Binding,
    Enumerate,
    Need,
    OAuth2,
    OperationError,
)
from connectors.http import write_attempt  # noqa: E402
from connectors.todoist.client import TodoistClient, TodoistTask, TodoistUser  # noqa: E402
from connectors.todoist.connector import TodoistConnector  # noqa: E402

CONNECTION = "0199a000-0000-7000-8000-000000000007"
TOKEN = "test-token"  # noqa: S105 (a fixture, not a credential)


def executor_helpers() -> dict[str, Any]:
    """validation_message, _canonical and _hash, compiled from executor.py on their own."""
    tree = ast.parse((BACKEND / "connectors" / "executor.py").read_text())
    wanted = {"validation_message", "_canonical", "_hash"}
    body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    if {node.name for node in body} != wanted:
        raise SystemExit("executor.py no longer defines the helpers this generator reads.")
    namespace: dict[str, Any] = {
        "json": json,
        "hashlib": hashlib,
        "Any": Any,
        "ValidationError": ValidationError,
    }
    exec(compile(ast.Module(body=body, type_ignores=[]), "executor.py", "exec"), namespace)  # noqa: S102
    return namespace


HELPERS = executor_helpers()
CONNECTOR = TodoistConnector()


def declaration() -> dict[str, Any]:
    auth = CONNECTOR.auth
    assert isinstance(auth, OAuth2)
    return {
        "slug": CONNECTOR.slug,
        "name": CONNECTOR.name,
        "kinds": [
            {
                "id": k.id,
                "label": k.label,
                "actions": list(k.actions),
                "wildcard": k.wildcard,
                "hierarchical": k.hierarchical,
                "note": k.note,
                "listed": k.listed,
            }
            for k in CONNECTOR.kinds
        ],
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in CONNECTOR.actions],
        "auth": {
            "type": "oauth2",
            "app": auth.app,
            "authorize_url": auth.authorize_url,
            "token_url": auth.token_url,
            "scopes": list(auth.scopes),
            "scope_separator": auth.scope_separator,
            "registration_url": auth.registration_url,
            "authorize_params": [list(p) for p in auth.authorize_params],
            "login_hint": auth.login_hint,
            "client_auth": auth.client_auth,
            "json_body": auth.json_body,
            "pkce": auth.pkce,
        },
        "browsable": sorted(CONNECTOR.browsable),
        "manage_link": CONNECTOR.manage_link(),
        "operations": [
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(n) for n in op.needs],
                "output_action": op.output_action,
                "consent": None if op.consent is None else [sorted(o) for o in op.consent],
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
                "offered": CONNECTOR.offered(op),
                "input_schema": op.input_model.model_json_schema(),
            }
            for op in CONNECTOR.operations
        ],
    }


# Raw arguments per operation, as the model might send them.
INPUTS: dict[str, list[Any]] = {
    "list_projects": [None, {}, {"x": 1}, [], "x", {"cursor": "c"}],
    "list_tasks": [
        {"project_id": "work"},
        {"project_id": "  work  "},
        {"project_id": "work", "limit": 1},
        {"project_id": "work", "limit": 50},
        {"project_id": "work", "limit": 0},
        {"project_id": "work", "limit": 51},
        {"project_id": "work", "limit": "5"},
        {"project_id": "work", "limit": True},
        {"project_id": "work", "limit": 2.5},
        {"project_id": "work", "limit": None},
        {"project_id": "work", "search": " milk "},
        {"project_id": "work", "search": "   "},
        {"project_id": "work", "search": "\u00a0x\u2028"},
        {"project_id": "work", "search": "\ufeffx"},
        {"project_id": "work", "search": "\x1cx\x1c"},
        {"project_id": "work", "search": "\u0085x\u0085"},
        {"project_id": "work", "search": "x" * 200},
        {"project_id": "work", "search": "x" * 201},
        {"project_id": "work", "search": "\U0001f600" * 200},
        {"project_id": "work", "search": "\U0001f600" * 201},
        {"project_id": "work", "search": None},
        {"project_id": "work", "search": 5},
        {"project_id": "work", "cursor": ""},
        {"project_id": "work", "cursor": " abc "},
        {"project_id": "work", "cursor": "c" * 300},
        {"project_id": "work", "cursor": "c" * 301},
        {"project_id": "work", "cursor": None},
        {"project_id": "work", "search": "a", "limit": 3, "cursor": "z"},
        {"project_id": "work", "connection_id": "other"},
        {"project_id": "wo rk"},
        {"project_id": "work/../x"},
        {"project_id": ""},
        {"project_id": "   "},
        {"project_id": "w" * 160},
        {"project_id": "w" * 161},
        {"project_id": "!" * 161},
        {"project_id": "work\n"},
        {"project_id": 5},
        {"project_id": None},
        {},
        None,
        [],
        {"limit": 0, "search": "", "cursor": "c" * 301, "extra": 1, "more": 2},
    ],
    "get_task": [
        {"task_id": "t1"},
        {"task_id": " t1 "},
        {"task_id": "6X7rM8997g3RQmvh"},
        {"task_id": "t/1"},
        {"task_id": "t1", "project_id": "work"},
        {"task_id": 1},
        {},
    ],
    "create_task": [
        {"project_id": "work", "title": "Buy milk"},
        {"project_id": "work", "title": "  Buy milk  "},
        {"project_id": " work ", "title": "Buy milk"},
        {"project_id": "work", "title": "Caf\u00e9 \u2615 \U0001f389"},
        {"project_id": "work", "title": "x" * 300},
        {"project_id": "work", "title": "x" * 301},
        {"project_id": "work", "title": "line\nbreak"},
        {"project_id": "work", "title": ""},
        {"project_id": "work", "title": " "},
        {"project_id": "work"},
        {"title": "x"},
        {"project_id": "work", "title": "x", "due": "tomorrow"},
        {"project_id": "work", "title": 5},
    ],
}


def inputs() -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for op in CONNECTOR.operations:
        cases = []
        for raw in INPUTS[op.name]:
            try:
                data = op.input_model.model_validate(raw if raw is not None else {})
            except ValidationError as error:
                cases.append({"raw": raw, "ok": False, "message": HELPERS["validation_message"](error)})
                continue
            fields = data.model_dump()
            tool = f"todoist_{op.name}"
            case = {
                "raw": raw,
                "ok": True,
                "fields": fields,
                "query_hash": HELPERS["_hash"](
                    HELPERS["_canonical"]({k: v for k, v in fields.items() if k != "cursor"})
                ),
                "write_key": HELPERS["_hash"](f"{tool}:{HELPERS['_canonical'](fields)}")
                if op.mutates
                else None,
            }
            cases.append(case)
        out[op.name] = cases
    return out


def ok(body: Any, status: int = 200) -> dict[str, Any]:
    return {"status": status, "body": json.dumps(body, ensure_ascii=False), "type": "application/json"}


def raw(text: str, status: int = 200, content_type: str = "application/json") -> dict[str, Any]:
    return {"status": status, "body": text, "type": content_type}


def fail(status: int) -> dict[str, Any]:
    return ok({"error": "x", "error_code": status}, status)


def task(id: str, project: str, content: str, **extra: Any) -> dict[str, Any]:
    return {"id": id, "project_id": project, "content": content, **extra}


def projects(page: list[tuple[str, str]], cursor: str | None = None, **extra: Any) -> dict[str, Any]:
    return ok({"results": [{"id": i, "name": n, **extra} for i, n in page], "next_cursor": cursor})


def pages(count: int, last_cursor: str | None = None) -> list[dict[str, Any]]:
    out = []
    for n in range(count):
        cursor = f"p{n + 1}" if n + 1 < count else last_cursor
        out.append(projects([(f"id{n}", f"Project {n}")], cursor))
    return out


TASKS = [
    task("t1", "work", "Ship it", priority=4, description="Before Friday", checked=False),
    task("t2", "work", "Due string", due={"date": "2026-10-12", "string": "tomorrow"}),
    task("t3", "work", "Due date only", due={"date": "2026-10-13", "string": ""}),
    task("t4", "work", "Due without string", due={"date": "2026-10-14", "string": None}),
    task("t5", "work", "Lax fields", priority="3", checked="true", due=None, labels=["x"], order=7),
]

# (name, call, responses). A call is {"kind": "account" | "discover" | "describe" | "op", ...}.
SCENARIOS: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = [
    # account
    (
        "account with a full name",
        {"kind": "account"},
        [ok({"id": "u1", "full_name": "Ada", "email": "ada@example.com"})],
    ),
    (
        "account with an email only",
        {"kind": "account"},
        [ok({"id": "u1", "full_name": None, "email": "ada@example.com"})],
    ),
    ("account with empty names", {"kind": "account"}, [ok({"id": "u1", "full_name": "", "email": ""})]),
    ("account without names", {"kind": "account"}, [ok({"id": "u1"})]),
    (
        "account with a numeric id",
        {"kind": "account"},
        [raw('{"id": 2671355, "full_name": 7, "email": null}')],
    ),
    ("account with a fractional id", {"kind": "account"}, [raw('{"id": 12.5}')]),
    ("account with a boolean id", {"kind": "account"}, [raw('{"id": true, "full_name": "Ada"}')]),
    ("account with a boolean name", {"kind": "account"}, [raw('{"id": "u1", "full_name": false}')]),
    ("account without an id", {"kind": "account"}, [ok({"full_name": "Ada"})]),
    ("account that is a list", {"kind": "account"}, [ok([])]),
    ("account that is not JSON", {"kind": "account"}, [raw("<html>", content_type="text/html")]),
    ("account with a byte order mark", {"kind": "account"}, [raw('\ufeff{"id": "u1", "full_name": "Ada"}')]),
    ("account unauthorized", {"kind": "account"}, [fail(401)]),
    ("account forbidden", {"kind": "account"}, [fail(403)]),
    ("account not found", {"kind": "account"}, [fail(404)]),
    ("account rate limited", {"kind": "account"}, [fail(429)]),
    ("account rejected", {"kind": "account"}, [fail(400)]),
    ("account failed", {"kind": "account"}, [fail(500)]),
    (
        "account redirected",
        {"kind": "account"},
        [{"status": 302, "body": "", "type": "text/plain", "location": "https://elsewhere.example/"}],
    ),
    # discover
    (
        "discover the first page",
        {"kind": "discover", "query": None, "cursor": None},
        [projects([("work", "Work"), ("private", "Private")], "c2")],
    ),
    (
        "discover the next page",
        {"kind": "discover", "query": None, "cursor": "c2"},
        [projects([("later", "Later")])],
    ),
    (
        "discover with an odd cursor",
        {"kind": "discover", "query": None, "cursor": "a b&c=d/\u00e9+~*"},
        [projects([])],
    ),
    (
        "discover with an empty query",
        {"kind": "discover", "query": "", "cursor": None},
        [projects([("work", "Work")], "c2")],
    ),
    (
        "discover with an empty cursor",
        {"kind": "discover", "query": None, "cursor": ""},
        [projects([("work", "Work")])],
    ),
    (
        "discover by name across pages",
        {"kind": "discover", "query": "OR", "cursor": "ignored"},
        [
            projects([("work", "Work"), ("private", "Private")], "c2"),
            projects([("orbit", "Orbit"), ("x", "Box")]),
        ],
    ),
    (
        "discover by a casefolded name",
        {"kind": "discover", "query": "strasse", "cursor": None},
        [
            projects(
                [("1", "Stra\u00dfe"), ("2", "STRASSE"), ("3", "Strase"), ("4", "Gro\u00dfe Stra\u1e9ee")]
            )
        ],
    ),
    (
        "discover by sharp s",
        {"kind": "discover", "query": "\u00df", "cursor": None},
        [projects([("1", "Stra\u00dfe"), ("2", "STRASSE"), ("3", "Strase")])],
    ),
    (
        "discover by final sigma",
        {"kind": "discover", "query": "\u03c2", "cursor": None},
        [
            projects(
                [
                    ("1", "\u039f\u0394\u039f\u03a3"),
                    ("2", "\u03bf\u03b4\u03bf\u03c3"),
                    ("3", "\u03bf\u03b4\u03bf"),
                ]
            )
        ],
    ),
    (
        "discover by dotted and dotless i",
        {"kind": "discover", "query": "i", "cursor": None},
        [projects([("1", "\u0130stanbul"), ("2", "\u0131rmak"), ("3", "Ink"), ("4", "\u212a")])],
    ),
    (
        "discover by a ligature",
        {"kind": "discover", "query": "FI", "cursor": None},
        [projects([("1", "\ufb01le"), ("2", "Fine"), ("3", "\u1f80"), ("4", "\uab70")])],
    ),
    (
        "discover by Cherokee",
        {"kind": "discover", "query": "\uab70", "cursor": None},
        [projects([("1", "\u13a0"), ("2", "\uab70"), ("3", "a")])],
    ),
    ("discover twenty pages", {"kind": "discover", "query": "project", "cursor": None}, pages(20)),
    (
        "discover past twenty pages",
        {"kind": "discover", "query": "project", "cursor": None},
        pages(20, "more"),
    ),
    (
        "discover stops at an empty cursor",
        {"kind": "discover", "query": "w", "cursor": None},
        [projects([("work", "Work")], "")],
    ),
    (
        "discover with extra project fields",
        {"kind": "discover", "query": None, "cursor": None},
        [projects([("work", "Work")], None, color="red", parent_id=None, is_shared=False)],
    ),
    (
        "discover with a numeric project id",
        {"kind": "discover", "query": None, "cursor": None},
        [raw('{"results": [{"id": 5, "name": "x"}]}')],
    ),
    (
        "discover with a numeric parent",
        {"kind": "discover", "query": None, "cursor": None},
        [raw('{"results": [{"id": "5", "name": "x", "parent_id": 3}]}')],
    ),
    (
        "discover without results",
        {"kind": "discover", "query": None, "cursor": None},
        [ok({"next_cursor": None})],
    ),
    (
        "discover with a numeric cursor",
        {"kind": "discover", "query": None, "cursor": None},
        [raw('{"results": [], "next_cursor": 5}')],
    ),
    ("discover forbidden", {"kind": "discover", "query": None, "cursor": None}, [fail(403)]),
    (
        "discover by name, failing on the second page",
        {"kind": "discover", "query": "w", "cursor": None},
        [projects([("work", "Work")], "c2"), fail(500)],
    ),
    # describe
    (
        "describe names seen ones",
        {"kind": "describe", "ids": ["work", "missing", "private"]},
        [projects([("private", "Private"), ("work", "Work")], "c2"), projects([("other", "Other")])],
    ),
    (
        "describe keeps the last name of a repeated id",
        {"kind": "describe", "ids": ["work"]},
        [projects([("work", "Old"), ("x", "X")], "c2"), projects([("work", "New")])],
    ),
    ("describe nothing", {"kind": "describe", "ids": []}, [projects([("work", "Work")])]),
    (
        "describe a prototype key",
        {"kind": "describe", "ids": ["__proto__", "constructor"]},
        [projects([("__proto__", "Proto"), ("constructor", "Ctor")])],
    ),
    ("describe past twenty pages", {"kind": "describe", "ids": ["id0"]}, pages(20, "more")),
    # list_projects
    (
        "list projects",
        {"kind": "op", "op": "list_projects", "args": {}},
        [projects([("work", "Work"), ("private", "Private")])],
    ),
    (
        "list projects across pages",
        {"kind": "op", "op": "list_projects", "args": {}},
        [projects([("work", "Work")], "c2"), projects([("private", "Private")])],
    ),
    ("list projects past twenty pages", {"kind": "op", "op": "list_projects", "args": {}}, pages(20, "more")),
    ("list projects unauthorized", {"kind": "op", "op": "list_projects", "args": {}}, [fail(401)]),
    # list_tasks
    (
        "list tasks",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": TASKS, "next_cursor": "n2"})],
    ),
    (
        "list tasks with a limit and a cursor",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "limit": 2, "cursor": "n2"}},
        [ok({"results": TASKS[:2], "next_cursor": None})],
    ),
    (
        "list tasks with an empty cursor",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "cursor": ""}},
        [ok({"results": [], "next_cursor": ""})],
    ),
    (
        "list tasks without a next cursor",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": []})],
    ),
    (
        "search tasks",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "search": "Ship & it (now)!"}},
        [
            ok(
                {
                    "results": [task("t1", "work", "Ship it"), task("t9", "private", "Ship secretly")],
                    "next_cursor": "f2",
                }
            )
        ],
    ),
    (
        "search tasks with only operators",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "search": "  #@ "}},
        [ok({"results": []})],
    ),
    (
        "search tasks with every operator",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "search": "a&b|c!d(e)f#g@h,i\\j"}},
        [ok({"results": []})],
    ),
    (
        "search tasks with Python whitespace",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work", "search": "\x1cfoo&\x1f"}},
        [ok({"results": []})],
    ),
    (
        "search tasks with a cursor",
        {
            "kind": "op",
            "op": "list_tasks",
            "args": {"project_id": "work", "search": "milk", "limit": 5, "cursor": "f2"},
        },
        [ok({"results": [task("t1", "work", "milk")], "next_cursor": None})],
    ),
    (
        "list tasks with a task missing content",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [{"id": "t1", "project_id": "work"}]})],
    ),
    (
        "list tasks with a null description",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", description=None)]})],
    ),
    (
        "list tasks with a fractional priority",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", priority=2.5)]})],
    ),
    (
        "list tasks with lax numbers and booleans",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [
            raw(
                '{"results": ['
                '{"id": "a", "project_id": "work", "content": "x", "priority": 2.0, "checked": 1},'
                '{"id": "b", "project_id": "work", "content": "x", "priority": " +1_0.00 ", "checked": "OFF"},'
                '{"id": "c", "project_id": "work", "content": "x", "priority": true, "checked": 0.0},'
                '{"id": "d", "project_id": "work", "content": "x", "priority": "\\u00a04\\u2028", "checked": "Y"},'
                '{"id": "e", "project_id": "work", "content": "x", "priority": false, "checked": "t"}'
                "]}"
            )
        ],
    ),
    (
        "list tasks with an unparsable priority",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", priority="4.")]})],
    ),
    (
        "list tasks with an unparsable checked",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", checked=" true")]})],
    ),
    (
        "list tasks with a checked of two",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", checked=2)]})],
    ),
    (
        "list tasks with a due that is not an object",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", due="tomorrow")]})],
    ),
    (
        "list tasks with a due without a date",
        {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}},
        [ok({"results": [task("t1", "work", "x", due={"string": "tomorrow"})]})],
    ),
    ("list tasks not found", {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}}, [fail(404)]),
    ("list tasks failed", {"kind": "op", "op": "list_tasks", "args": {"project_id": "work"}}, [fail(503)]),
    # get_task
    ("get a task", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [ok(TASKS[0])]),
    (
        "get a task in another project",
        {"kind": "op", "op": "get_task", "args": {"task_id": "t2"}},
        [ok(task("t2", "private", "Secret"))],
    ),
    ("get a missing task", {"kind": "op", "op": "get_task", "args": {"task_id": "missing"}}, [fail(404)]),
    ("get a forbidden task", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [fail(403)]),
    ("get a task unauthorized", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [fail(401)]),
    ("get a task rate limited", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [fail(429)]),
    ("get a task failed", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [fail(500)]),
    (
        "get a task answered with another",
        {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}},
        [ok(task("t2", "work", "Other"))],
    ),
    ("get a malformed task", {"kind": "op", "op": "get_task", "args": {"task_id": "t1"}}, [ok({"id": "t1"})]),
    # create_task
    (
        "create a task",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "Buy milk"}},
        [ok(task("t9", "work", "Buy milk", priority=1, checked=False))],
    ),
    (
        "create a task Todoist puts elsewhere",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "Buy milk"}},
        [ok(task("t9", "inbox", "Buy milk"))],
    ),
    (
        "create a task with Unicode",
        {
            "kind": "op",
            "op": "create_task",
            "args": {"project_id": "work", "title": ' Caf\u00e9 \u2615 \U0001f389 "q" \\ '},
        },
        [ok(task("t9", "work", 'Caf\u00e9 \u2615 \U0001f389 "q" \\'))],
    ),
    (
        "create a task rejected",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [fail(400)],
    ),
    (
        "create a task forbidden",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [fail(403)],
    ),
    (
        "create a task unauthorized",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [fail(401)],
    ),
    (
        "create a task failed",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [fail(500)],
    ),
    (
        "create a task with a teapot",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [fail(418)],
    ),
    (
        "create a task answered with HTML",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [raw("<html>", content_type="text/html")],
    ),
    (
        "create a task answered with a malformed task",
        {"kind": "op", "op": "create_task", "args": {"project_id": "work", "title": "x"}},
        [ok({"id": "t9"})],
    ),
]


# JSON texts of field values, read by the models' lax rules: as a task's priority (int) and checked (bool),
# and as a user's id (str with coerce_numbers_to_str). Numbers with a fraction of zero (12.0), integers
# beyond 2^53 and floats from 2^53 to about 9.2e18 are left out: a JavaScript number cannot hold what Python
# reads from them (client.ts; the test names each difference).
LAX = [
    "4",
    "-4",
    "0",
    "-0",
    "true",
    "false",
    "null",
    '"x"',
    "[]",
    "{}",
    "4.5",
    "0.5",
    "1.5",
    "1e-7",
    "2",
    "-1",
    "123456789",
    "9007199254740991",
    "-9007199254740991",
    "1e20",
    "1e30",
    "-1e30",
    "1e400",
    "-1e400",
    "1.5e300",
    '""',
    '" "',
    '"4"',
    '"-4"',
    '"+4"',
    '"04"',
    '"0004"',
    '"9007199254740991"',
    '"-9_007_199_254_740_991.0"',
    '"00"',
    '"-0"',
    '" 4 "',
    '"\\t4\\n"',
    '"\\u00a04"',
    '"\\u20004"',
    '"\\u30004"',
    '"\\u00854"',
    '"4\\u2028"',
    '"\\u000c4"',
    '"\\u000b4"',
    '"\\u001c4"',
    '"\\ufeff4"',
    '"4.0"',
    '"4.00"',
    '"-4.0"',
    '"4."',
    '"4.01"',
    '".0"',
    '"4.0.0"',
    '"4e0"',
    '"4.0e0"',
    '"0x10"',
    '"0b1"',
    '"0o7"',
    '"1_000"',
    '"1_000.0"',
    '"4_0.0"',
    '"0_4"',
    '"1__0"',
    '"_1"',
    '"1_"',
    '"4.0_0"',
    '"4_.0"',
    '"+-4"',
    '"+ 4"',
    '"\\uff14"',
    '"\\u0664"',
    '"4\\u0000"',
    '"1.000000000000000000001"',
    '"1"',
    '"on"',
    '"t"',
    '"true"',
    '"y"',
    '"yes"',
    '"off"',
    '"f"',
    '"false"',
    '"n"',
    '"no"',
    '"TRUE"',
    '"True"',
    '"Yes"',
    '"nO"',
    '"oFf"',
    '"Y"',
    '"N"',
    '"T"',
    '"F"',
    '"true "',
    '" true"',
    '"1.0"',
    '"01"',
    '"\\u0131"',
    '"\\u212a"',
]


def lax() -> list[dict[str, Any]]:
    out = []
    base = {"id": "t1", "project_id": "p", "content": "c"}
    for text in LAX:
        value = json.loads(text)
        case: dict[str, Any] = {"json": text}
        for field, model, data, read in (
            ("int", TodoistTask, {**base, "priority": value}, lambda parsed: parsed.priority),
            ("bool", TodoistTask, {**base, "checked": value}, lambda parsed: parsed.checked),
            ("str", TodoistUser, {"id": value}, lambda parsed: parsed.id),
        ):
            try:
                case[field] = {"ok": True, "value": read(model.model_validate(data))}
            except ValidationError:
                case[field] = {"ok": False}
        out.append(case)
    return out


def resource(r) -> dict[str, Any]:
    return {
        "connection_id": r.connection_id,
        "kind": r.kind,
        "id": r.id,
        "within": list(r.within),
        "partial": r.partial,
    }


def requirement(r) -> dict[str, Any]:
    if isinstance(r, Need):
        return {"need": resource(r.resource), "action": r.action}
    assert isinstance(r, Enumerate)
    return {"enumerate": r.kind, "action": r.action}


class Script:
    """Serves the scripted responses in order and records each request."""

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "path": request.url.path,
                "params": [list(item) for item in request.url.params.multi_items()],
                "authorization": request.headers.get("authorization"),
                "content_type": request.headers.get("content-type"),
                "body": request.content.decode() if request.content else None,
            }
        )
        if not self.responses:
            raise AssertionError("No scripted response left.")
        response = self.responses.pop(0)
        headers = {"content-type": response["type"]}
        if "location" in response:
            headers["location"] = response["location"]
        return httpx.Response(response["status"], content=response["body"].encode(), headers=headers)


def error(e: OperationError) -> dict[str, Any]:
    return {"code": e.code, "message": e.message}


async def scenario(call: dict[str, Any], responses: list[dict[str, Any]]) -> dict[str, Any]:
    script = Script(responses)
    client = TodoistClient(TOKEN, transport=httpx.MockTransport(script.handler))
    outcome: dict[str, Any] = {}
    try:
        if call["kind"] == "account":
            account = await CONNECTOR.account(client)
            outcome["account"] = {"id": account.id, "label": account.label}
        elif call["kind"] == "discover":
            page = await CONNECTOR.discover(client, "project", query=call["query"], cursor=call["cursor"])
            outcome["page"] = {
                "items": [[i.id, i.name, i.expandable] for i in page.items],
                "next_cursor": page.next_cursor,
            }
        elif call["kind"] == "describe":
            names = await CONNECTOR.describe(client, "project", call["ids"])
            outcome["names"] = [[k, v] for k, v in names.items()]
        else:
            op = next(o for o in CONNECTOR.operations if o.name == call["op"])
            data = op.input_model.model_validate(call["args"])
            prepared = await op.prepare(Binding(CONNECTION, client), data)
            outcome["requirements"] = [requirement(r) for r in prepared.requirements]
            outcome["requests_before_execute"] = len(script.requests)
            if op.mutates:
                with write_attempt(time.monotonic() + 60) as attempt:
                    try:
                        output = await prepared.execute()
                    finally:
                        outcome["effect"] = (
                            (attempt.effect.value if attempt.effect else None) if attempt.sent else "not_sent"
                        )
            else:
                output = await prepared.execute()
            outcome["output"] = {
                "records": [{"resource": resource(r.resource), "data": r.data} for r in output.records],
                "next_cursor": output.next_cursor,
                "incomplete": output.incomplete,
            }
    except OperationError as e:
        outcome["error"] = error(e)
    finally:
        await client.aclose()
    if script.responses:
        raise SystemExit(f"Responses left unused in {call}.")
    return {"requests": script.requests, "outcome": outcome}


def scenarios() -> list[dict[str, Any]]:
    out = []
    names = set()
    for name, call, responses in SCENARIOS:
        if name in names:
            raise SystemExit(f"Two scenarios are named {name!r}.")
        names.add(name)
        result = asyncio.run(scenario(call, responses))
        out.append({"name": name, "call": call, "responses": responses, **result})
    return out


def casefold() -> list[list[Any]]:
    out = []
    for c in range(0x110000):
        if 0xD800 <= c <= 0xDFFF:
            continue
        folded = chr(c).casefold()
        if folded != chr(c):
            out.append([c, [ord(x) for x in folded]])
    return out


def main() -> None:
    vectors = {
        "python": sys.version.split()[0],
        "unicode": unicodedata.unidata_version,
        "declaration": declaration(),
        "inputs": inputs(),
        "lax": lax(),
        "scenarios": scenarios(),
        # "<code point>:<folded code points joined by .>" in hex, separated by spaces.
        "casefold": " ".join(f"{c:x}:{'.'.join(f'{x:x}' for x in f)}" for c, f in casefold()),
    }
    target = HERE / "vectors.json"
    target.write_text(json.dumps(vectors, ensure_ascii=True, indent=1) + "\n")
    print(f"Wrote {target.relative_to(HERE.parents[3])}")


if __name__ == "__main__":
    main()
