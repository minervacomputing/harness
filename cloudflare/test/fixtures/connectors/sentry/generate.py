"""Writes vectors.json: what today's Python Sentry connector (backend/connectors/sentry/) does.

- `declaration`: the connector as Python declares it (kinds, actions, auth, operations and their strings).
- `inputs`: each operation's input model on raw arguments: the normalized fields, with the query hash the
  executor binds page tokens to, or the executor's "Invalid arguments." message.
- `lax`: field values as the response models read them (Pydantic's lax mode): an int, a str and an id.
- `scenarios`: account, discover, describe and every operation's prepare and execute, run against
  scripted provider responses through httpx.MockTransport: the requests sent and what came back.
- `links`, `addresses`, `numbers`, `short`: the client's `next_cursor` on Link headers, and reads.py's
  `_address`, `_number` and `short`, on fixed and seeded random inputs.
- `issues`, `events`: the records reads.py builds from an issue (`_issue`, `_issue_detail`) and an event
  (`_event`), on fixed and seeded random shapes.

The executor's helpers (validation_message, _canonical, _hash) are read from executor.py's source, which
imports Django, rather than restated. Addresses and identifiers are made up, on reserved example domains.

Run from cloudflare/:
  cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/sentry/generate.py

The committed file keeps a sample of the seeded random groups (LINKS_RANDOM, ADDRESSES_RANDOM, EVENTS_RANDOM) to stay
under about 500 KB; add `--full` (after the script's path) for the whole set, about 0.7 MB, for a local run.
"""

import ast
import asyncio
import hashlib
import json
import random
import sys
import unicodedata
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

from vector_size import compact, sample  # noqa: E402

LINKS_RANDOM = sample(300, 100)  # Link headers made of pieces
ADDRESSES_RANDOM = sample(600, 150)  # addresses made of pieces
EVENTS_RANDOM = sample(250, 30)  # random events

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.base import Binding, Enumerate, Need, OAuth2, OperationError  # noqa: E402
from connectors.sentry import reads  # noqa: E402
from connectors.sentry.client import Issue, Organisation, Project, SentryClient, TagSummary, next_cursor  # noqa: E402
from connectors.sentry.connector import SentryConnector  # noqa: E402

CONNECTION = "0199a000-0000-7000-8000-0000000000e1"
TOKEN = "test-token"  # noqa: S105 (a fixture, not a credential)
CONNECTOR = SentryConnector()


def executor_helpers() -> dict[str, Any]:
    """validation_message, _canonical and _hash, compiled from executor.py on their own."""
    tree = ast.parse((BACKEND / "connectors" / "executor.py").read_text())
    wanted = {"validation_message", "_canonical", "_hash"}
    body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    if {node.name for node in body} != wanted:
        raise SystemExit("executor.py no longer defines the helpers this generator reads.")
    namespace: dict[str, Any] = {"json": json, "hashlib": hashlib, "Any": Any, "ValidationError": ValidationError}
    exec(compile(ast.Module(body=body, type_ignores=[]), "executor.py", "exec"), namespace)  # noqa: S102
    return namespace


HELPERS = executor_helpers()


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
        "manage_link": list(CONNECTOR.manage_link()),
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
    "list_projects": [
        None,
        {},
        [],
        "x",
        42,
        {"x": 1},
        {"query": "web"},
        {"query": "  web  "},
        {"query": ""},
        {"query": "   "},
        {"query": "a\tb"},
        {"query": "a\x7fb"},
        {"query": "\u0085web\u0085"},
        {"query": "\ufeffweb"},
        {"query": "a\u0085b"},
        {"query": "x" * 100},
        {"query": "x" * 101},
        {"query": "\U0001f600" * 100},
        {"query": "\U0001f600" * 101},
        {"query": None},
        {"query": 5},
        {"cursor": "0:100:0"},
        {"cursor": ""},
        {"cursor": " c "},
        {"cursor": "c\nd"},
        {"cursor": "x" * 200},
        {"cursor": "x" * 201},
        {"cursor": None},
        {"query": "web", "cursor": "0:100:0"},
        {"query": "", "cursor": "x" * 201, "extra": 1, "more": 2},
    ],
    "search_issues": [
        {"project": "web"},
        {"project": "WEB"},
        {"project": " Web "},
        {"project": "11"},
        {"project": "011"},
        {"project": "0"},
        {"project": "12345678901234567890"},
        {"project": "123456789012345678901"},
        {"project": "web-app_2"},
        {"project": "-web"},
        {"project": "_web"},
        {"project": "web/x"},
        {"project": "../payroll"},
        {"project": "w" * 100},
        {"project": "w" * 101},
        {"project": "\u212a"},
        {"project": "\u0130"},
        {"project": "WEB\u212a"},
        {"project": "w\u00e9b"},
        {"project": ""},
        {"project": "   "},
        {"project": 11},
        {"project": None},
        {},
        None,
        {"project": "web", "text": "bad total"},
        {"project": "web", "text": "  bad total  "},
        {"project": "web", "text": 'x" project:payroll "'},
        {"project": "web", "text": "x\\"},
        {"project": "web", "text": "a\nb"},
        {"project": "web", "text": "a\u0085b"},
        {"project": "web", "text": "it's"},
        {"project": "web", "text": "x" * 200},
        {"project": "web", "text": "x" * 201},
        {"project": "web", "text": ""},
        {"project": "web", "text": "  "},
        {"project": "web", "text": None},
        {"project": "web", "text": 5},
        {"project": "web", "status": "any"},
        {"project": "web", "status": "archived"},
        {"project": "web", "status": "ignored"},
        {"project": "web", "status": " any"},
        {"project": "web", "status": "ANY"},
        {"project": "web", "status": None},
        {"project": "web", "level": "fatal"},
        {"project": "web", "level": "FATAL"},
        {"project": "web", "level": "critical"},
        {"project": "web", "level": None},
        {"project": "web", "environment": "production"},
        {"project": "web", "environment": " production "},
        {"project": "web", "environment": "prod uction"},
        {"project": "web", "environment": "a/b"},
        {"project": "web", "environment": "a\tb"},
        {"project": "web", "environment": "a\x01b"},
        {"project": "web", "environment": "a\x7fb"},
        {"project": "web", "environment": "a\u0085b"},
        {"project": "web", "environment": "a\ufeffb"},
        {"project": "web", "environment": "a\u00a0b"},
        {"project": "web", "environment": "a\u2028b"},
        {"project": "web", "environment": "a\u3000b"},
        {"project": "web", "environment": "a\u180eb"},
        {"project": "web", "environment": "a\x1cb"},
        {"project": "web", "environment": "x" * 64},
        {"project": "web", "environment": "x" * 65},
        {"project": "web", "environment": ""},
        {"project": "web", "environment": None},
        {"project": "web", "environment": 5},
        {"project": "web", "period": "90d"},
        {"project": "web", "period": "1y"},
        {"project": "web", "sort": "users"},
        {"project": "web", "sort": "date"},
        {"project": "web", "limit": 25},
        {"project": "web", "limit": 26},
        {"project": "web", "limit": 0},
        {"project": "web", "limit": "5"},
        {"project": "web", "limit": True},
        {"project": "web", "limit": 2.5},
        {"project": "web", "limit": None},
        {"project": "web", "cursor": "0:1:0"},
        {"project": "web", "cursor": "x" * 201},
        {"project": "web", "query": "is:unresolved"},
        {
            "project": "11",
            "text": "bad total",
            "status": "any",
            "level": "fatal",
            "environment": "production",
            "period": "90d",
            "sort": "users",
            "limit": 25,
        },
        {
            "project": "-x",
            "text": "a\nb",
            "status": "x",
            "level": "x",
            "environment": "a b",
            "period": "x",
            "sort": "x",
            "limit": 99,
            "cursor": "x" * 201,
            "extra": 1,
        },
        {"text": '"', "level": 1, "query": "x"},
    ],
    "get_issue": [
        {"issue": "101"},
        {"issue": " 101 "},
        {"issue": "web-101"},
        {"issue": "WEB-1A3"},
        {"issue": "web--1"},
        {"issue": "\u00df-1"},
        {"issue": "\ufb00-1"},
        {"issue": "\u0131-1"},
        {"issue": "WEB_101"},
        {"issue": "web 101"},
        {"issue": "0101"},
        {"issue": "-1"},
        {"issue": "WEB-"},
        {"issue": "WEB-1234567890123"},
        {"issue": "WEB-12345678901234"},
        {"issue": "W" * 64 + "-1"},
        {"issue": "W" * 65 + "-1"},
        {"issue": "12345678901234567890"},
        {"issue": "123456789012345678901"},
        {"issue": "x" * 80},
        {"issue": "x" * 81},
        {"issue": ""},
        {"issue": "  "},
        {"issue": 101},
        {"issue": None},
        {},
        {"issue": "101", "event": "latest"},
    ],
    "get_issue_event": [
        {"issue": "101"},
        {"issue": "web-101", "event": "oldest"},
        {"issue": "101", "event": "recommended"},
        {"issue": "101", "event": "LATEST"},
        {"issue": "101", "event": " latest "},
        {"issue": "101", "event": "lat-est"},
        {"issue": "101", "event": "-latest-"},
        {"issue": "101", "event": "9FAC2CEE-D934-4F2B-BFDD-1FDACB0ED9B1"},
        {"issue": "101", "event": "9fac2ceed9344f2bbfdd1fdacb0ed9b1"},
        {"issue": "101", "event": "a" * 32},
        {"issue": "101", "event": "A" * 32},
        {"issue": "101", "event": "g" * 32},
        {"issue": "101", "event": "9fac2cee"},
        {"issue": "101", "event": "newest"},
        {"issue": "101", "event": "../202"},
        {"issue": "101", "event": "x" * 36},
        {"issue": "101", "event": "x" * 37},
        {"issue": "101", "event": "-" * 36},
        {"issue": "101", "event": ""},
        {"issue": "101", "event": None},
        {"issue": "101", "event": 1},
        {"event": "latest"},
        {"issue": "x", "event": "y"},
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
            query_hash = HELPERS["_hash"](HELPERS["_canonical"]({k: v for k, v in fields.items() if k != "cursor"}))
            cases.append({"raw": raw, "ok": True, "fields": fields, "query_hash": query_hash})
        out[op.name] = cases
    return out


# JSON texts of field values, read by the models' lax rules: as an issue's userCount (int), its title (str)
# and a project's id (str). Numbers with a fraction of zero (12.0), integers beyond 2^53 and floats from 2^53
# to about 9.2e18 are left out: a JavaScript number cannot hold what Python reads from them (client.ts).
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
    "1e-7",
    "9007199254740991",
    "-9007199254740991",
    "1e20",
    "1e400",
    '""',
    '" "',
    '"4"',
    '"-4"',
    '"+4"',
    '"04"',
    '"9007199254740991"',
    '"9007199254740993"',
    '"-9_007_199_254_740_991.0"',
    '" 4 "',
    '"\\t4\\n"',
    '"\\u00a04"',
    '"\\u00854"',
    '"\\u001c4"',
    '"\\ufeff4"',
    '"4.0"',
    '"4."',
    '"4.01"',
    '"4e0"',
    '"0x10"',
    '"1_000"',
    '"1__0"',
    '"_1"',
    '"\\uff14"',
    '"\\u0664"',
    '"\\ud800"',
    '"a\\udc00b"',
    '"\\ud83d\\ude00"',
]


def lax() -> list[dict[str, Any]]:
    out = []
    base = {"id": "101", "project": {"id": "11"}}
    for text in LAX:
        value = json.loads(text)
        case: dict[str, Any] = {"json": text}
        for field, model, data, read in (
            ("int", Issue, {**base, "userCount": value}, lambda parsed: parsed.userCount),
            ("str", Issue, {**base, "title": value}, lambda parsed: parsed.title),
            ("id", Project, {"id": value, "slug": "web"}, lambda parsed: parsed.id),
        ):
            try:
                case[field] = {"ok": True, "value": read(model.model_validate(data))}
            except ValidationError:
                case[field] = {"ok": False}
        out.append(case)
    return out


# Scenarios. Responses are served by path, in order for each path, so concurrent requests get theirs.


def ok(body: Any, status: int = 200, **headers: str) -> dict[str, Any]:
    return {"status": status, "body": json.dumps(body, ensure_ascii=False), "headers": headers}


def raw(text: str, status: int = 200, **headers: str) -> dict[str, Any]:
    return {"status": status, "body": text, "headers": headers}


def fail(status: int) -> dict[str, Any]:
    return ok({"detail": "SECRET detail"}, status)


AUTH = "/api/0/auth/"
ORGS = "/api/0/organizations/"
ORG = "/api/0/organizations/acme"
USER = {"id": "42", "name": "Ada Lovelace", "email": "ada@example.com"}
ACME = {"id": "7", "slug": "acme", "name": "Acme", "links": {"regionUrl": "https://de.sentry.io"}}
WEB = {"id": "11", "slug": "web", "name": "Web", "platform": "python"}
PAYROLL = {"id": "12", "slug": "payroll", "name": "SECRET payroll", "platform": "go"}


def orgs(*items: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    return {ORGS: [ok(list(items) or [ACME])]}


def page(items: list[Any], cursor: str | None = None, link: str | None = None) -> dict[str, Any]:
    if link is None:
        link = (
            f'<https://elsewhere.example.com/?cursor={cursor}>; rel="next"; results="true"; cursor="{cursor}"'
            if cursor
            else '<https://de.sentry.io/>; rel="next"; results="false"; cursor="0:99:0"'
        )
    return ok(items, Link=link)


def issue(issue_id: str, project: dict[str, Any], title: str = "ValueError: bad total", **fields: Any) -> dict:
    return {
        "id": issue_id,
        "shortId": f"{project['slug'].upper()}-{issue_id}",
        "title": title,
        "culprit": "app.views in checkout",
        "level": "error",
        "status": "unresolved",
        "substatus": "ongoing",
        "priority": "high",
        "count": "150",
        "userCount": 12,
        "firstSeen": "2026-09-01T10:00:00Z",
        "lastSeen": "2026-10-02T10:00:00Z",
        "platform": "python",
        "permalink": f"https://acme.sentry.io/issues/{issue_id}/",
        "project": {"id": project["id"], "slug": project["slug"], "name": project["name"]},
        "assignedTo": {"type": "user", "id": "5", "name": "Grace", "email": "grace@example.com"},
        "activity": [{"type": "note", "data": {"text": "see PAYROLL-202"}}],
    } | fields


EVENT_ID = "9fac2ceed9344f2bbfdd1fdacb0ed9b1"


def frame(n: int) -> dict[str, Any]:
    return {
        "filename": f"app/f{n}.py",
        "absPath": f"/srv/app/f{n}.py",
        "function": f"fn{n}",
        "module": f"app.f{n}",
        "lineNo": 20,
        "colNo": None,
        "inApp": n % 2 == 0,
        "context": [[line, f"line {line}"] for line in range(15, 26)],
        "vars": {"password": "hunter2"},
    }


def event(parent: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {
        "eventID": EVENT_ID,
        "groupID": parent["id"],
        "projectID": parent["project"]["id"],
        "title": parent["title"],
        "message": "",
        "platform": "python",
        "dateCreated": "2026-10-02T10:00:00Z",
        "release": {"version": "web@1.4.2"},
        "user": {"email": "ada@example.com", "ip_address": "192.0.2.7"},
        "tags": [
            {"key": "environment", "value": "production"},
            {"key": "user", "value": "email:ada@example.com"},
        ],
        "contexts": {"runtime": {"name": "CPython", "version": "3.14.0"}},
        "sdk": {"name": "sentry.python", "version": "2.40.0"},
        "entries": [
            {
                "type": "exception",
                "data": {"values": [{"type": "ValueError", "value": "bad total", "stacktrace": {"frames": [frame(1)]}}]},
            },
            {"type": "request", "data": {"method": "POST", "url": "https://u:pw@shop.example.com/cart?token=abc"}},
        ],
    } | fields


I101 = issue("101", WEB)
I202 = issue("202", PAYROLL, "SECRET payroll failed")

# (name, call, routes): a call is {"kind": "account" | "discover" | "describe" | "op", ...}; routes map a path
# to the responses it gives, in order.
SCENARIOS: list[tuple[str, dict[str, Any], dict[str, list[dict[str, Any]]]]] = [
    # account
    ("account", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs()),
    ("account with a name only", {"kind": "account"}, {AUTH: [ok({"id": "42", "name": "Ada"})]} | orgs()),
    ("account with an email only", {"kind": "account"}, {AUTH: [ok({"id": "42", "email": "a@example.com"})]} | orgs()),
    ("account without a name", {"kind": "account"}, {AUTH: [ok({"id": "42", "name": None, "email": None})]} | orgs()),
    ("account with empty names", {"kind": "account"}, {AUTH: [ok({"id": "42", "name": "", "email": ""})]} | orgs()),
    ("account with a blank name", {"kind": "account"}, {AUTH: [ok({"id": "42", "name": "  \t "})]} | orgs()),
    (
        "account with spaced names",
        {"kind": "account"},
        {AUTH: [ok({"id": "42", "name": " Ada\n  Lovelace ", "email": "\u2003ada@example.com"})]}
        | orgs(ACME | {"name": " Acme\u0085 Corp "}),
    ),
    (
        "account with a long name",
        {"kind": "account"},
        {AUTH: [ok({"id": "42", "name": "A" * 600, "email": "ada@example.com"})]} | orgs(ACME | {"name": "B" * 600}),
    ),
    ("account of an unnamed organisation", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"name": None})),
    ("account of a blank organisation", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"name": " "})),
    ("account with a leading zero", {"kind": "account"}, {AUTH: [ok({"id": "042"})]}),
    ("account with a numeric id", {"kind": "account"}, {AUTH: [raw('{"id": 42}')]}),
    ("account without an id", {"kind": "account"}, {AUTH: [ok({"name": "Ada"})]}),
    ("account with a final newline", {"kind": "account"}, {AUTH: [ok({"id": "42\n"})]}),
    ("account with a byte order mark", {"kind": "account"}, {AUTH: [raw('\ufeff{"id": "42"}')]}),
    (
        "account with organisations after a byte order mark",
        {"kind": "account"},
        {AUTH: [ok(USER)], ORGS: [raw("\ufeff" + json.dumps([ACME]))]},
    ),
    ("account with a lone surrogate", {"kind": "account"}, {AUTH: [raw('{"id": "42", "name": "\\ud800"}')]}),
    ("account that is a list", {"kind": "account"}, {AUTH: [ok([])]}),
    ("account that is not JSON", {"kind": "account"}, {AUTH: [raw("<html>")]}),
    ("account in two organisations", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok([ACME, ACME])]}),
    ("account in no organisation", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok([])]}),
    ("account with organisations as an empty object", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok({})]}),
    ("account with organisations as an empty string", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok("")]}),
    ("account with organisations as an object", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok({"7": ACME})]}),
    ("account with organisations as null", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok(None)]}),
    ("account with organisations as a number", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok(7)]}),
    ("account with a malformed organisation", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [ok([{"id": "7"}])]}),
    ("account with an organisation id of zero", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"id": "0"})),
    ("account with an uppercase slug", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"slug": "Acme"})),
    ("account with a long slug", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"slug": "a" * 101})),
    ("account with odd links", {"kind": "account"}, {AUTH: [ok(USER)]} | orgs(ACME | {"links": {"regionUrl": 5}})),
    ("account unauthorized", {"kind": "account"}, {AUTH: [fail(401)]}),
    ("account forbidden", {"kind": "account"}, {AUTH: [fail(403)]}),
    ("account with organisations forbidden", {"kind": "account"}, {AUTH: [ok(USER)], ORGS: [fail(403)]}),
    ("account rate limited", {"kind": "account"}, {AUTH: [fail(429)]}),
    ("account failed", {"kind": "account"}, {AUTH: [fail(502)]}),
    ("account redirected", {"kind": "account"}, {AUTH: [raw("", 302, location="https://elsewhere.example/")]}),
    # discover
    (
        "discover the first page",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB, PAYROLL], "0:100:0")]},
    ),
    (
        "discover the next page",
        {"kind": "discover", "query": None, "cursor": "0:100:0"},
        orgs() | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover by name",
        {"kind": "discover", "query": "pay", "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([PAYROLL])]},
    ),
    (
        "discover with an empty query",
        {"kind": "discover", "query": "", "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB])]},
    ),
    ("discover with an invalid cursor", {"kind": "discover", "query": None, "cursor": "0:0:0 "}, {}),
    ("discover with an empty cursor", {"kind": "discover", "query": None, "cursor": ""}, {}),
    (
        "discover with a cursor refused",
        {"kind": "discover", "query": None, "cursor": "0:100:0"},
        orgs() | {f"{ORG}/projects/": [fail(400)]},
    ),
    (
        "discover refused",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [fail(400)]},
    ),
    (
        "discover with organisations refused and a cursor",
        {"kind": "discover", "query": None, "cursor": "0:100:0"},
        {ORGS: [fail(400)]},
    ),
    (
        "discover names",
        {"kind": "discover", "query": None, "cursor": None},
        orgs()
        | {
            f"{ORG}/projects/": [
                page(
                    [
                        {"id": "1", "slug": "same", "name": "same"},
                        {"id": "2", "slug": "none", "name": None},
                        {"id": "3", "slug": "blank", "name": " \n "},
                        {"id": "4", "slug": "spaced", "name": " Payroll\n\tApp "},
                        {"id": "5", "slug": "bare"},
                        {"id": "6", "slug": "long", "name": "\U0001f600" * 501},
                        {"id": "7", "slug": "Upper-Case.slug", "name": "Odd"},
                    ]
                )
            ]
        },
    ),
    (
        "discover a project with a leading zero",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB | {"id": "011"}])]},
    ),
    (
        "discover a project with a numeric id",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB | {"id": 11}])]},
    ),
    (
        "discover projects as an object",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [ok({"11": WEB})]},
    ),
    (
        "discover projects as an empty object",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [ok({}, Link='<x>; rel="next"; results="true"; cursor="0:1:0"')]},
    ),
    (
        "discover projects that are not JSON",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [raw("[")]},
    ),
    (
        "discover with a page token Minerva cannot use",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB], link='<x>; rel="next"; results="true"; cursor="0 1"')]},
    ),
    (
        "discover with a next link without a cursor",
        {"kind": "discover", "query": None, "cursor": None},
        orgs() | {f"{ORG}/projects/": [page([WEB], link='<x>; rel="next"; results="true"')]},
    ),
    (
        "discover in the US region",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": {"regionUrl": "https://us.sentry.io"}}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover in a region with a trailing slash",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": {"regionUrl": "https://de.sentry.io/"}}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover in an unknown region",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": {"regionUrl": "https://evil.example.com"}}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover in a lookalike region",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": {"regionUrl": "https://de.sentry.io.evil.example"}}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover in a region over http",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": {"regionUrl": "http://de.sentry.io"}}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover without links",
        {"kind": "discover", "query": None, "cursor": None},
        orgs({"id": "7", "slug": "acme"}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover with null links",
        {"kind": "discover", "query": None, "cursor": None},
        orgs(ACME | {"links": None}) | {f"{ORG}/projects/": [page([WEB])]},
    ),
    (
        "discover with organisations failing",
        {"kind": "discover", "query": None, "cursor": None},
        {ORGS: [fail(500)]},
    ),
    (
        "discover in two organisations",
        {"kind": "discover", "query": None, "cursor": None},
        {ORGS: [ok([ACME, ACME | {"id": "8", "slug": "other"}])]},
    ),
    # describe
    (
        "describe",
        {"kind": "describe", "ids": ["11", "11", "99", "web", "x/1", "011"]},
        orgs() | {"/api/0/projects/acme/11/": [ok(WEB)], "/api/0/projects/acme/99/": [fail(404)]},
    ),
    (
        "describe hides forbidden projects",
        {"kind": "describe", "ids": ["11", "12"]},
        orgs() | {"/api/0/projects/acme/11/": [fail(403)], "/api/0/projects/acme/12/": [ok(PAYROLL)]},
    ),
    (
        "describe fails on a failure",
        {"kind": "describe", "ids": ["11"]},
        orgs() | {"/api/0/projects/acme/11/": [fail(500)]},
    ),
    (
        "describe fails on another project",
        {"kind": "describe", "ids": ["11"]},
        orgs() | {"/api/0/projects/acme/11/": [ok(PAYROLL)]},
    ),
    ("describe nothing", {"kind": "describe", "ids": ["web", "", "0"]}, {}),
    (
        "describe at most a hundred",
        {"kind": "describe", "ids": [str(n) for n in range(1, 103)]},
        orgs() | {f"/api/0/projects/acme/{n}/": [ok({"id": str(n), "slug": f"p{n}"})] for n in range(1, 101)},
    ),
    # list_projects
    (
        "list projects",
        {"kind": "op", "op": "list_projects", "args": {}},
        orgs() | {f"{ORG}/projects/": [page([WEB, PAYROLL | {"platform": None}], "0:100:0")]},
    ),
    (
        "list projects by name from a cursor",
        {"kind": "op", "op": "list_projects", "args": {"query": "we", "cursor": "0:100:0"}},
        orgs() | {f"{ORG}/projects/": [page([WEB | {"name": " Web\napp ", "platform": " py "}])]},
    ),
    (
        "list projects with a bad cursor",
        {"kind": "op", "op": "list_projects", "args": {"cursor": "a b"}},
        {},
    ),
    (
        "list projects with a malformed project",
        {"kind": "op", "op": "list_projects", "args": {}},
        orgs() | {f"{ORG}/projects/": [page([{"id": "abc", "slug": "x"}])]},
    ),
    # search_issues
    (
        "search issues",
        {"kind": "op", "op": "search_issues", "args": {"project": "WEB"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([I101], "0:1:0")]},
    ),
    (
        "search issues by id with every field",
        {
            "kind": "op",
            "op": "search_issues",
            "args": {
                "project": "11",
                "text": "bad total",
                "status": "resolved",
                "level": "fatal",
                "environment": "production",
                "period": "90d",
                "sort": "users",
                "limit": 25,
                "cursor": "0:25:0",
            },
        },
        orgs() | {"/api/0/projects/acme/11/": [ok(WEB)], f"{ORG}/issues/": [page([])]},
    ),
    (
        "search issues of any status",
        {"kind": "op", "op": "search_issues", "args": {"project": "web", "status": "any", "sort": "first_seen"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([])]},
    ),
    (
        "search issues by level",
        {"kind": "op", "op": "search_issues", "args": {"project": "web", "level": "debug", "sort": "events"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([])]},
    ),
    (
        "search issues of a missing project",
        {"kind": "op", "op": "search_issues", "args": {"project": "payroll"}},
        orgs() | {"/api/0/projects/acme/payroll/": [fail(404)]},
    ),
    (
        "search issues of a forbidden project",
        {"kind": "op", "op": "search_issues", "args": {"project": "payroll"}},
        orgs() | {"/api/0/projects/acme/payroll/": [fail(403)]},
    ),
    (
        "search issues of a project that fails",
        {"kind": "op", "op": "search_issues", "args": {"project": "payroll"}},
        orgs() | {"/api/0/projects/acme/payroll/": [fail(500)]},
    ),
    (
        "search issues of a project answered under another slug",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(PAYROLL)]},
    ),
    (
        "search issues of a project answered under another id",
        {"kind": "op", "op": "search_issues", "args": {"project": "11"}},
        orgs() | {"/api/0/projects/acme/11/": [ok(PAYROLL)]},
    ),
    (
        "search issues with organisations forbidden",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        {ORGS: [fail(403)]},
    ),
    (
        "search issues refused",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [fail(400)]},
    ),
    (
        "search issues refused with a cursor",
        {"kind": "op", "op": "search_issues", "args": {"project": "web", "cursor": "0:1:0"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [fail(400)]},
    ),
    (
        "search issues with a bad cursor",
        {"kind": "op", "op": "search_issues", "args": {"project": "web", "cursor": "0:1:0;x"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)]},
    ),
    (
        "search issues forbidden",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [fail(403)]},
    ),
    (
        "search issues answered with another project's",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([I101, I202])]},
    ),
    (
        "search issues answered with a malformed issue",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([{"id": "101"}])]},
    ),
    (
        "search issues answered with an issue of a malformed project",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs()
        | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([I101 | {"project": {"id": "x"}}])]},
    ),
    (
        "search issues with odd fields",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs()
        | {
            "/api/0/projects/acme/web/": [ok(WEB)],
            f"{ORG}/issues/": [
                page(
                    [
                        I101
                        | {
                            "count": "1e3",
                            "userCount": "7",
                            "assignedTo": {},
                            "permalink": "https://evil.example.com/sentry.io/",
                            "project": {"id": "11"},
                        },
                        issue("103", WEB)
                        | {
                            "count": "12",
                            "assignedTo": None,
                            "permalink": "http://acme.sentry.io/x",
                            "title": " A\n\tB ",
                            "shortId": None,
                        },
                        issue("104", WEB)
                        | {"count": "\u0663", "permalink": "https://sentry.io/organizations/acme/issues/104/"},
                        issue("105", WEB) | {"count": "", "permalink": "https://a-b.sentry.io/"},
                        issue("106", WEB) | {"count": " 7", "permalink": "https://a.b.sentry.io/"},
                    ]
                )
            ],
        },
    ),
    (
        "search issues with a numeric count",
        {"kind": "op", "op": "search_issues", "args": {"project": "web"}},
        orgs() | {"/api/0/projects/acme/web/": [ok(WEB)], f"{ORG}/issues/": [page([I101 | {"count": 12}])]},
    ),
    # get_issue
    (
        "get an issue by id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)]},
    ),
    (
        "get an issue by short id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "web-101"}},
        orgs()
        | {
            f"{ORG}/shortids/WEB-101/": [ok({"organizationSlug": "acme", "groupId": "101", "group": {"id": "0"}})],
            f"{ORG}/issues/101/": [ok(I101)],
        },
    ),
    (
        "get an issue by a short id without an organisation",
        {"kind": "op", "op": "get_issue", "args": {"issue": "WEB-101"}},
        orgs() | {f"{ORG}/shortids/WEB-101/": [ok({"groupId": "101"})], f"{ORG}/issues/101/": [ok(I101)]},
    ),
    (
        "get an issue by a short id of another organisation",
        {"kind": "op", "op": "get_issue", "args": {"issue": "WEB-101"}},
        orgs() | {f"{ORG}/shortids/WEB-101/": [ok({"organizationSlug": "other", "groupId": "101"})]},
    ),
    (
        "get an issue by a short id answered with a bad id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "WEB-101"}},
        orgs() | {f"{ORG}/shortids/WEB-101/": [ok({"organizationSlug": "acme", "groupId": "0"})]},
    ),
    (
        "get an issue by a short id answered with a numeric id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "WEB-101"}},
        orgs() | {f"{ORG}/shortids/WEB-101/": [raw('{"groupId": 101}')]},
    ),
    (
        "get an issue by a missing short id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "NOPE-1"}},
        orgs() | {f"{ORG}/shortids/NOPE-1/": [fail(404)]},
    ),
    (
        "get a missing issue",
        {"kind": "op", "op": "get_issue", "args": {"issue": "999"}},
        orgs() | {f"{ORG}/issues/999/": [fail(404)]},
    ),
    (
        "get a forbidden issue",
        {"kind": "op", "op": "get_issue", "args": {"issue": "202"}},
        orgs() | {f"{ORG}/issues/202/": [fail(403)]},
    ),
    (
        "get an issue unauthorized",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [fail(401)]},
    ),
    (
        "get an issue rate limited",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [fail(429)]},
    ),
    (
        "get an issue that fails",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [fail(503)]},
    ),
    (
        "get a merged issue",
        {"kind": "op", "op": "get_issue", "args": {"issue": "100"}},
        orgs() | {f"{ORG}/issues/100/": [ok(I101)]},
    ),
    (
        "get an issue with details",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs()
        | {
            f"{ORG}/issues/101/": [
                ok(
                    I101
                    | {
                        "firstRelease": {"version": "web@1.0"},
                        "lastRelease": None,
                        "tags": [
                            {"key": "browser", "name": "Browser", "totalValues": 150},
                            {"key": "customer:ada@example.com", "name": "Customer", "totalValues": 1},
                            {"key": "environment", "name": " Environment\n", "totalValues": "3"},
                            {"key": "os.name"},
                        ]
                        + [{"key": "level", "name": f"L{n}", "totalValues": n} for n in range(60)],
                        "numComments": 2,
                        "userReportCount": 1,
                        "permalink": "https://evil.example.com/issues/101/",
                    }
                )
            ]
        },
    ),
    (
        "get an issue with a malformed tag",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101 | {"tags": [{"name": "x"}]})]},
    ),
    (
        "get an issue with null tags",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101 | {"tags": None})]},
    ),
    (
        "get an issue without a project",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok({"id": "101"})]},
    ),
    (
        "get an issue with a bad id",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101 | {"id": "x"})]},
    ),
    (
        "get an issue that is not JSON",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [raw("{")]},
    ),
    (
        "get an issue with a byte order mark",
        {"kind": "op", "op": "get_issue", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [raw("\ufeff" + json.dumps(I101))]},
    ),
    # get_issue_event
    (
        "get the latest event",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "WEB-101"}},
        orgs()
        | {
            f"{ORG}/shortids/WEB-101/": [ok({"organizationSlug": "acme", "groupId": "101"})],
            f"{ORG}/issues/101/": [ok(I101)],
            f"{ORG}/issues/101/events/latest/": [ok(event(I101))],
        },
    ),
    (
        "get an event by id",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101", "event": EVENT_ID.upper()}},
        orgs()
        | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/{EVENT_ID}/": [ok(event(I101))]},
    ),
    (
        "get an event by id answered with another",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101", "event": "a" * 32}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/{'a' * 32}/": [ok(event(I101))]},
    ),
    (
        "get a missing event",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101", "event": "oldest"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/oldest/": [fail(404)]},
    ),
    (
        "get a forbidden event",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101", "event": "recommended"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/recommended/": [fail(403)]},
    ),
    (
        "get an event of a forbidden issue",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "202"}},
        orgs() | {f"{ORG}/issues/202/": [fail(403)]},
    ),
    (
        "get an event of another issue",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [ok(event(I202))]},
    ),
    (
        "get an event with numeric ids",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {
            f"{ORG}/issues/101/": [ok(I101)],
            f"{ORG}/issues/101/events/latest/": [ok(event(I101, groupID=101, projectID=11))],
        },
    ),
    (
        "get an event with ids written as floats",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {
            f"{ORG}/issues/101/": [ok(I101)],
            f"{ORG}/issues/101/events/latest/": [ok(event(I101, groupID=101.5))],
        },
    ),
    (
        "get an event with a boolean id",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [ok(event(I101, groupID=True))]},
    ),
    (
        "get an event without ids",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {
            f"{ORG}/issues/101/": [ok(I101)],
            f"{ORG}/issues/101/events/latest/": [ok({k: v for k, v in event(I101).items() if k != "groupID"})],
        },
    ),
    (
        "get an event with an uppercase id",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {
            f"{ORG}/issues/101/": [ok(I101)],
            f"{ORG}/issues/101/events/latest/": [ok(event(I101, eventID=EVENT_ID.upper()))],
        },
    ),
    (
        "get an event with a numeric event id",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs()
        | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [ok(event(I101, eventID=5))]},
    ),
    (
        "get an event that is a list",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [ok([event(I101)])]},
    ),
    (
        "get an event that is not JSON",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "101"}},
        orgs() | {f"{ORG}/issues/101/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [raw("nope")]},
    ),
    (
        "get an event of an issue merged into another",
        {"kind": "op", "op": "get_issue_event", "args": {"issue": "100"}},
        orgs()
        | {f"{ORG}/issues/100/": [ok(I101)], f"{ORG}/issues/101/events/latest/": [ok(event(I101))]},
    ),
]


def resource(r) -> dict[str, Any]:
    return {"connection_id": r.connection_id, "kind": r.kind, "id": r.id, "within": list(r.within), "partial": r.partial}


def requirement(r) -> dict[str, Any]:
    if isinstance(r, Need):
        return {"need": resource(r.resource), "action": r.action}
    assert isinstance(r, Enumerate)
    return {"enumerate": r.kind, "action": r.action}


class Script:
    """Serves the scripted responses by path, in order for each path, and records each request."""

    def __init__(self, routes: dict[str, list[dict[str, Any]]]) -> None:
        self.routes = {path: list(responses) for path, responses in routes.items()}
        self.requests: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "method": request.method,
                "host": request.url.host,
                "path": request.url.path,
                "params": [list(item) for item in request.url.params.multi_items()],
                "authorization": request.headers.get("authorization"),
                "accept": request.headers.get("accept"),
            }
        )
        queue = self.routes.get(request.url.path)
        if not queue:
            raise AssertionError(f"No scripted response left for {request.url.path}.")
        response = queue.pop(0)
        headers = {"content-type": "application/json", **response["headers"]}
        return httpx.Response(response["status"], content=response["body"].encode(), headers=headers)


async def scenario(name: str, call: dict[str, Any], routes: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    script = Script(routes)
    client = SentryClient(TOKEN, transport=httpx.MockTransport(script.handler))
    outcome: dict[str, Any] = {}
    try:
        if call["kind"] == "account":
            account = await CONNECTOR.account(client)
            outcome["account"] = {"id": account.id, "label": account.label}
        elif call["kind"] == "discover":
            found = await CONNECTOR.discover(client, "project", query=call["query"], cursor=call["cursor"])
            outcome["page"] = {
                "items": [[i.id, i.name, i.expandable] for i in found.items],
                "next_cursor": found.next_cursor,
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
            output = await prepared.execute()
            outcome["output"] = {
                "records": [{"resource": resource(r.resource), "data": r.data} for r in output.records],
                "next_cursor": output.next_cursor,
                "incomplete": output.incomplete,
            }
    except OperationError as e:
        outcome["error"] = {"code": e.code, "message": e.message}
    finally:
        await client.aclose()
    left = {path: queue for path, queue in script.routes.items() if queue}
    if left and call["kind"] != "describe":
        raise SystemExit(f"Responses left unused in {name!r}: {sorted(left)}.")
    return {"requests": script.requests, "outcome": outcome}


def scenarios() -> list[dict[str, Any]]:
    out = []
    names = set()
    for name, call, routes in SCENARIOS:
        if name in names:
            raise SystemExit(f"Two scenarios are named {name!r}.")
        names.add(name)
        result = asyncio.run(scenario(name, call, routes))
        out.append({"name": name, "call": call, "routes": routes, **result})
    return out


# Link headers, and next_cursor on each: the cursor, or the error's code.
LINKS = [
    "",
    '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1", '
    '<https://elsewhere.example.com/x>; rel="next"; results="true"; cursor="1727:100:0"',
    '<https://elsewhere.example.com/x>; rel="next"; results="false"; cursor="1727:100:0"',
    '<https://elsewhere.example.com/x>; rel="next"; results="true"; cursor="x y"',
    '<x>; rel="next"; results="true"',
    '<x>; rel="next"; results="true"; cursor=""',
    '<x>; rel="next"; results="true"; cursor="' + "c" * 200 + '"',
    '<x>; rel="next"; results="true"; cursor="' + "c" * 201 + '"',
    '<x>;rel="next";results="true";cursor="a"',
    '<x> ; rel="next" ; results="true" ; cursor="a"',
    '<x>\t;\trel="next"\t;\tresults="true"\t;\tcursor="a"',
    '<x>\x1c; rel="next"; results="true"; cursor="a"',
    '<x>\x85; rel="next"; results="true"; cursor="a"',
    '<x>\xa0; rel="next"; results="true"; cursor="a"',
    '<x>; rel="next"; results="true"; cursor="a"; cursor="b"',
    '<x>; rel="next"; rel="previous"; results="true"; cursor="a"',
    '<x>; REL="next"; results="true"; cursor="a"',
    '<x>; rel="Next"; results="true"; cursor="a"',
    '<x>; rel=next; results="true"; cursor="a"',
    '<x>; rel="next"; results="true"; cursor="a", <y>; rel="next"; results="true"; cursor="b"',
    '<x>; rel="next"; results="false"; cursor="a", <y>; rel="next"; results="true"; cursor="b"',
    '<a<b>; rel="next"; results="true"; cursor="a"',
    '<a>b>; rel="next"; results="true"; cursor="a"',
    '<x>; rel="next"; results="true"; cursor="a"junk; cursor="b"',
    '<x>; rel="next" results="true"; cursor="a"',
    'rel="next"; results="true"; cursor="a"',
    '<x>; rel="next"; results="true"; cursor="1727950000000:0:0"',
    '<x>; rel="next"; results="true"; cursor="a.b:c_d-E"',
    '<x>; rel="next"; results="true"; cursor="a/b"',
    '<x>; rel="next"; results="true"; cursor="a\\"b"',
    '<x>; rel="next"; results="true"; cursor="\xe9"',
    '<x>; rel="next"; results="true"; x-y="1"; cursor="a"',
    '<x>; rel="next"; results="true"; c1="1"; cursor="a"',
    "<>",
    "<x>",
]


def link_vectors() -> list[dict[str, Any]]:
    rng = random.Random(6061)
    pieces = ["<x>", "<", ">", ";", " ", "\t", ",", 'rel="next"', 'results="true"', 'results="false"', 'cursor="a:1"',
              'cursor="b c"', 'cursor=""', "rel=", '"', "next", "=", "\x85", "\xa0", "\x1c"]
    values = list(LINKS)
    for _ in range(LINKS_RANDOM):
        values.append("".join(rng.choice(pieces) for _ in range(rng.randint(1, 14))))
    out = []
    for value in values:
        response = httpx.Response(200, headers=[("link", value.encode("latin-1"))])
        try:
            out.append({"link": value, "cursor": next_cursor(response)})
        except OperationError as error:
            out.append({"link": value, "error": error.code})
    return out


ADDRESSES = [
    "https://user:pw@shop.example.com:8443/cart?token=abc#top",
    "https://u:pw@[2001:db8::1]:8443/cart?token=abc",
    "https://shop.example.com",
    "https://shop.example.com/",
    "HTTPS://Shop.Example.com/Cart",
    "http://shop.example.com/a b/c",
    "https://shop.example.com/a\tb\nc\rd",
    "  \x00https://shop.example.com/x",
    "https://shop.example.com/x   ",
    "https://shop.example.com/x?",
    "https://shop.example.com/x#",
    "https://shop.example.com#frag?x",
    "https://shop.example.com?q#f",
    "https://@shop.example.com/x",
    "https://a@b@shop.example.com/x",
    "https://shop.example.com:/x",
    "https://shop.example.com:0/x",
    "https://shop.example.com:65535/x",
    "https://shop.example.com:65536/x",
    "https://shop.example.com:08443/x",
    "https://shop.example.com:x/x",
    "https://shop.example.com:-1/x",
    "https://shop.example.com:\uff11/x",
    "https://shop.example.com:" + "9" * 5000 + "/x",
    "https://:443/x",
    "https:///x",
    "https:x",
    "//shop.example.com/x",
    "shop.example.com/x",
    "ftp://shop.example.com/x",
    "javascript:alert(1)",
    "mailto:ada@example.com",
    "http+unix://x/y",
    "1http://x/y",
    "h\u00e9://x/y",
    "https://[2001:db8::1]/x",
    "https://[2001:DB8::1]/x",
    "https://[::1]/x",
    "https://[::]/x",
    "https://[::ffff:192.0.2.1]/x",
    "https://[::ffff:192.0.2.01]/x",
    "https://[::ffff:192.0.2.256]/x",
    "https://[1:2:3:4:5:6:7:8]/x",
    "https://[1:2:3:4:5:6:7:8:9]/x",
    "https://[1:2:3:4:5:6:7::]/x",
    "https://[::2:3:4:5:6:7:8]/x",
    "https://[1::2::3]/x",
    "https://[1:2:3:4:5:6:7]/x",
    "https://[:1:2:3:4:5:6:7]/x",
    "https://[1:2:3:4:5:6:7:]/x",
    "https://[12345::1]/x",
    "https://[g::1]/x",
    "https://[fe80::1%eth0]/x",
    "https://[fe80::1%]/x",
    "https://[fe80::1%a%b]/x",
    "https://[fe80::1%25eth0]:8080/x",
    "https://[192.0.2.1]/x",
    "https://[v1.x]/x",
    "https://[V1.x]/x",
    "https://[v.x]/x",
    "https://[v1.]/x",
    "https://[vg.x]/x",
    "https://[v1.x\u2028y]/x",
    "https://[]/x",
    "https://[/x",
    "https://]/x",
    "https://a[::1]/x",
    "https://[::1]a/x",
    "https://[::1]:a/x",
    "https://[::1]:/x",
    "https://u[x]@[::1]/x",
    "https://u[@host/x",
    "https://[::1]@host/x",
    "https://[" + "1" * 50 + "::1]/x",
    "https://[0000:0000:0000:0000:0000:0000:0000:0001]/x",
    "https://[00000::1]/x",
    "https://[::1.2.3.4]/x",
    "https://[::1.2.3]/x",
    "https://[1:2:3:4:5:6:1.2.3.4]/x",
    "https://[1:2:3:4:5:6:7:1.2.3.4]/x",
    "https://shop.example.com\u2100/x",
    "https://shop.example\u3002com/x",
    "https://shop\uff0fexample.com/x",
    "https://shop.example.com\ufe55/x",
    "https://\u00e9xample.com/x",
    "https://\u212aelvin.example.com/x",
    "https://shop.example.com/\U0001f600",
    "https://" + "a" * 600 + ".example.com/x",
    "https://shop.example.com/" + "p" * 600,
    "https://shop.example.com/a\u2003b",
    "https://shop.example.com/a\x1cb",
    "https://shop.example.com/a\x85b",
    "http://shop.example.com\\x",
    "https://shop.example.com/x?y=https://evil.example.com/",
    "",
    " ",
    "https://",
    "http:",
]


def address_vectors() -> list[dict[str, Any]]:
    rng = random.Random(1997)
    pieces = ["https://", "http://", "HTTP://", "//", "u", "u:p@", "@", ":", "[", "]", "::", "1", "ff", "v1.", "%",
              "%25", "e", "/", "?", "#", ".", "example.com", "192.0.2.1", " ", "\t", "\n", "\x00", "\u2100", "\uff0f",
              "\u2003", "\u00e9", "8443", "65536", "\u3002", "a"]
    values = list(ADDRESSES)
    for _ in range(ADDRESSES_RANDOM):
        values.append("".join(rng.choice(pieces) for _ in range(rng.randint(1, 10))))
    values += [None, 5, ["https://x.example/"], {"url": "x"}]
    return [{"value": value, "address": reads._address(value)} for value in values]


NUMBERS = [
    0, 1, -1, 20, 9007199254740991, -9007199254740991, 1.5, True, False, None, "20", "020", "", " 20", "20 ",
    "+20", "-20", "2_0", "20.0", "\u0663", "\u0661\u0662", "\uff12\uff10", "\U0001d7d8", "\U0001d7ce\U0001d7ff",
    "\u0e51", "1\u0663", "x", [20], {"a": 1}, "9007199254740991", "1" * 30,
]
# On these Python's `str.isdigit()` is true and `int()` raises: superscripts and circled digits.
NOT_DECIMAL = ["\u00b2", "\u2460", "1\u00b2", "\u2070"]


def number_vectors() -> list[dict[str, Any]]:
    out = []
    for value in NUMBERS + NOT_DECIMAL:
        try:
            number = reads._number(value)
        except ValueError:
            out.append({"value": value, "raises": True})
            continue
        if isinstance(number, int) and abs(number) > 2**53 - 1:
            out.append({"value": value, "beyond": True})
            continue
        out.append({"value": value, "number": number})
    return out


SHORTS = [
    None, 5, True, [], {}, "", " ", "\t\n", "a", " a ", "a  b", "a\nb\tc", "a\u2003b", "a\x1cb", "a\x85b",
    "a\xa0b", "a\u200bb", "a\ufeffb", "a\u2028b", "\U0001f600" * 499 + " x", "\U0001f600" * 501, "x" * 500,
    "x" * 501, "x" * 499 + " " + "y", " " * 600 + "z",
]


def decimals() -> str:
    """Every decimal digit `int()` reads, as "<code point>:<value>" in hex and decimal, separated by spaces."""
    out = []
    for point in range(0x110000):
        char = chr(point)
        if char.isdecimal():
            assert reads._number(char) == unicodedata.decimal(char)
            out.append(f"{point:x}:{unicodedata.decimal(char)}")
    return " ".join(out)


def short_vectors() -> list[dict[str, Any]]:
    return [{"value": v, "short": reads.short(v), "short20": reads.short(v, 20)} for v in SHORTS]


def random_value(rng: random.Random, depth: int = 0) -> Any:
    pool = [
        None, True, False, 0, 3, 20, 22, -1, 1.5, "", " ", "x", "20", "21", "app/f.py", "exception", "request",
        "environment", "release", "user", "url", "\U0001f600", "a\nb", "https://u:p@h.example/p?q", "GET",
    ]
    roll = rng.random()
    if depth > 3 or roll < 0.55:
        return rng.choice(pool)
    if roll < 0.75:
        return [random_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    keys = ["type", "data", "values", "value", "key", "name", "version", "stacktrace", "frames", "lineNo", "colNo",
            "context", "inApp", "mechanism", "handled", "method", "url", "filename", "function", "module", "x"]
    return {rng.choice(keys): random_value(rng, depth + 1) for _ in range(rng.randint(0, 5))}


def random_event(rng: random.Random) -> dict[str, Any]:
    entries = []
    for _ in range(rng.randint(0, 4)):
        kind = rng.choice(["exception", "request", "breadcrumbs", None, 5])
        if kind == "exception":
            values = []
            for _ in range(rng.randint(0, 12)):
                frames = []
                for _ in range(rng.randint(0, 45)):
                    frames.append(
                        {
                            "filename": rng.choice(["app/a.py", None, 5, " a  b "]),
                            "function": rng.choice(["f", None, "x" * 600]),
                            "module": rng.choice(["m", None]),
                            "lineNo": rng.choice([20, "20", None, -3, 1.5, True]),
                            "colNo": rng.choice([None, 4, "4"]),
                            "inApp": rng.choice([True, False, 1, None, "true"]),
                            "context": rng.choice(
                                [None, 42, [[19, "a"], [20, "b"], ["21", "c"], [24, "d"], [17, "x" * 600]], [[20]],
                                 [[20, 1], [20, "dup"], [23, "y"]], random_value(rng, 2)]
                            ),
                        }
                        if rng.random() < 0.85
                        else random_value(rng, 2)
                    )
                values.append(
                    {
                        "type": rng.choice(["E", None, 3]),
                        "value": rng.choice(["v", "", None, "x" * 2500, 5]),
                        "module": rng.choice(["m", None]),
                        "mechanism": rng.choice([None, {"type": "generic", "handled": rng.choice([True, False, None, 1])}, "m"]),
                        "stacktrace": rng.choice([{"frames": frames}, None, "s", {"frames": "f"}]),
                    }
                    if rng.random() < 0.85
                    else random_value(rng, 2)
                )
            entries.append({"type": "exception", "data": rng.choice([{"values": values}, {"values": "v"}, None, values])})
        elif kind == "request":
            entries.append(
                {
                    "type": "request",
                    "data": rng.choice(
                        [
                            {"method": rng.choice(["GET", "x" * 30, None]), "url": rng.choice(ADDRESSES[:20] + [None, 5])},
                            None,
                            "d",
                        ]
                    ),
                }
            )
        else:
            entries.append(random_value(rng, 1) if kind is None else {"type": kind, "data": random_value(rng, 1)})
    event_tags = [
        rng.choice(
            [
                {"key": "environment", "value": rng.choice(["prod", None, 5, " a  b "])},
                {"key": "release", "value": "r@1"},
                {"key": "user", "value": "email:ada@example.com"},
                {"key": ["environment"], "value": "x"},
                {"key": "level"},
                "y",
            ]
        )
        for _ in range(rng.randint(0, 5))
    ]
    return {
        "eventID": EVENT_ID,
        "dateCreated": rng.choice(["2026-10-02T10:00:00Z", None, "x" * 50]),
        "title": rng.choice(["T", None, "x" * 600]),
        "message": rng.choice(["", None, "m", "m" * 6000, 5]),
        "platform": rng.choice(["python", None, "p" * 50]),
        "culprit": rng.choice(["c", None]),
        "location": rng.choice(["l", None]),
        "release": rng.choice([{"version": "web@1"}, {"version": None}, None, "r", {}]),
        "tags": rng.choice([event_tags, None, "t"]),
        "contexts": rng.choice(
            [{"runtime": {"name": "CPython", "version": 3}, "os": "x", "browser": {"name": "B" * 120}}, [], None]
        ),
        "sdk": rng.choice([{"name": "s", "version": "1"}, None, [], {"name": 5}]),
        "entries": rng.choice([entries, None, "e"]),
    }


FIXED_EVENTS = [
    {"eventID": EVENT_ID},
    {"eventID": EVENT_ID, "entries": [{"type": "exception", "data": {"values": [{"type": 3, "stacktrace": "x"}, "y"]}}, "z"],
     "tags": [{"key": ["environment"], "value": "x"}, "y"], "contexts": [], "sdk": None, "release": None,
     "message": "m" * 6000},
    {"eventID": EVENT_ID, "entries": [
        {"type": "exception", "data": {"values": [{"type": "E", "mechanism": {"type": "generic", "handled": {"x": 1}},
                                                   "stacktrace": {"frames": [{"lineNo": 20, "context": 42},
                                                                             {"lineNo": 20, "context": [[20, "x"]] * 1000 + [[19, "w"], ["21", "y"], [22, 5]]}]}}]}},
        {"type": "request", "data": {"method": "GET", "url": "https://u:pw@[2001:db8::1]:8443/cart?token=abc"}},
        {"type": "request", "data": {"method": "POST", "url": "https://second.example.com/"}},
    ]},
    {"eventID": EVENT_ID, "tags": [{"key": "release", "value": "r@2"}, {"key": "environment", "value": "a"},
                                   {"key": "environment", "value": "b"}], "release": "not a dict"},
    {"eventID": EVENT_ID, "entries": [{"type": "exception", "data": {"values": [{"type": f"E{n}"} for n in range(12)]}},
                                      {"type": "exception", "data": {"values": [{"type": "Last"}]}}]},
    {"eventID": EVENT_ID, "entries": [{"type": "exception", "data": {"values": [{"stacktrace": {"frames": [
        {"lineNo": n, "context": [[n - 4, "a"], [n - 3, "b"], [n + 3, "c"], [n + 4, "d"]]} for n in range(50)]}}]}}]},
    {"eventID": EVENT_ID, "entries": [{"type": "request", "data": {"method": " post\n", "url": "ftp://x.example/"}}]},
]


def event_vectors() -> list[dict[str, Any]]:
    rng = random.Random(2026)
    events = FIXED_EVENTS + [random_event(rng) for _ in range(EVENTS_RANDOM)]
    out = []
    for value in events:
        try:
            out.append({"event": value, "record": reads._event(value)})
        except ValueError:
            # A request address the fuzzer made unparseable in a way _address does not catch, say.
            out.append({"event": value, "raises": True})
    return out


ISSUES = [
    I101,
    I202,
    {"id": "101", "project": {"id": "11"}},
    I101 | {"assignedTo": {}, "count": None, "userCount": None, "permalink": None, "platform": " p\ny "},
    I101 | {"tags": [{"key": "browser", "totalValues": 3}, {"key": "os"}, {"key": "user", "name": "U"}],
            "firstRelease": {"version": " web@1\n"}, "lastRelease": {}, "numComments": 0, "userReportCount": None},
    I101 | {"tags": [{"key": "level", "name": str(n)} for n in range(55)]},
    I101 | {"permalink": "https://sentry.io/"},
    I101 | {"permalink": "https://Acme.sentry.io/"},
    I101 | {"permalink": "https://acme.sentry.io"},
    I101 | {"permalink": "https://acme.sentry.io.evil.example/"},
    I101 | {"permalink": "https://evil.example/?https://acme.sentry.io/"},
    I101 | {"permalink": "https://a_b.sentry.io/"},
    I101 | {"permalink": ""},
    I101 | {"title": "x" * 600, "culprit": "\U0001f600" * 600, "shortId": "  "},
    I101 | {"assignedTo": {"type": "team", "name": "Backend"}},
    I101 | {"level": None, "status": None, "substatus": None, "priority": None, "firstSeen": None, "lastSeen": None},
    I101 | {"count": "  7"},
    I101 | {"count": "007"},
    I101 | {"count": 7},
]


def issue_vectors() -> list[dict[str, Any]]:
    out = []
    for value in ISSUES:
        try:
            parsed = Issue.model_validate(value)
        except ValidationError:
            out.append({"issue": value, "invalid": True})
            continue
        out.append({"issue": value, "record": reads._issue(parsed), "detail": reads._issue_detail(parsed)})
    return out


def main() -> None:
    assert TagSummary and Organisation  # the models the vectors read through Issue and the client
    vectors = {
        "python": sys.version.split()[0],
        "unicode": unicodedata.unidata_version,
        "declaration": declaration(),
        "inputs": inputs(),
        "lax": lax(),
        "scenarios": scenarios(),
        "links": link_vectors(),
        "addresses": address_vectors(),
        "numbers": number_vectors(),
        "decimals": decimals(),
        "short": short_vectors(),
        "issues": issue_vectors(),
        "events": event_vectors(),
    }
    target = HERE / "vectors.json"
    target.write_text(json.dumps(compact(vectors), ensure_ascii=True, separators=(",", ":")) + "\n")
    print(f"Wrote {target.relative_to(HERE.parents[3])}")


if __name__ == "__main__":
    main()
