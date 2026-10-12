"""Writes vectors.json: what today's Python Xero connector answers, for connectors-xero-vectors.test.ts.

The declaration (kinds, actions, auth, operations with their descriptions and input schemas), input
validation (the normalized arguments with their query hash and write key, or the executor's message), the
client's helpers (error names, judging a write, pages, dates, messages), exact amounts, the date parsing
calls take, and scenarios: the connector's account, discovery and operations run against scripted Xero
responses, with every request they sent and what they answered. The Xero package, connectors/base.py,
http.py and text.py are pure: nothing here loads configuration or Django; the executor's helpers are
compiled from executor.py on their own.

The vectors are hand-written scenarios and exhaustive tables, no random groups, and are written without indentation
(vector_size.py) to stay under about 500 KB.

Run from cloudflare/:
  cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/xero/generate.py
"""

import ast
import asyncio
import hashlib
import json
import sys
import time
import unicodedata
from datetime import date as Date
from decimal import Decimal
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

import httpx  # noqa: E402
from pydantic import BaseModel, ValidationError  # noqa: E402

from connectors.base import Binding, Enumerate, Need, OAuth2, OperationError  # noqa: E402
from connectors.http import write_attempt  # noqa: E402
from vector_size import compact  # noqa: E402
from connectors.xero import client as xc  # noqa: E402
from connectors.xero import organisations as xo  # noqa: E402
from connectors.xero import reads as xr  # noqa: E402
from connectors.xero import writes as xw  # noqa: E402
from connectors.xero.client import XeroClient  # noqa: E402
from connectors.xero.connector import XeroConnector  # noqa: E402

CONNECTION = "0199a000-0000-7000-8000-0000000000e1"
TOKEN = "test-token"  # noqa: S105 (a fixture, not a credential)
ACME = "0a1b2c3d-0000-4000-8000-000000000001"
BETA = "0a1b2c3d-0000-4000-8000-000000000002"
UNREACHED = "0a1b2c3d-0000-4000-8000-000000000003"
CUSTOMER = "c0000000-0000-4000-8000-000000000001"
SUPPLIER = "c0000000-0000-4000-8000-000000000002"
INVOICE = "10000000-0000-4000-8000-000000000001"
SECRET = "SECRET acquisition"


def executor_helpers() -> dict[str, Any]:
    """validation_message, compiled from executor.py on its own."""
    tree = ast.parse((BACKEND / "connectors" / "executor.py").read_text())
    wanted = {"validation_message"}
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
CONNECTOR = XeroConnector()
OPERATIONS = {op.name: op for op in CONNECTOR.operations}


def declaration() -> dict[str, Any]:
    auth = CONNECTOR.auth
    assert isinstance(auth, OAuth2)
    return {
        "slug": CONNECTOR.slug,
        "name": CONNECTOR.name,
        "kinds": [
            {
                "id": kind.id,
                "label": kind.label,
                "actions": list(kind.actions),
                "wildcard": kind.wildcard,
                "hierarchical": kind.hierarchical,
                "note": kind.note,
                "listed": kind.listed,
            }
            for kind in CONNECTOR.kinds
        ],
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in CONNECTOR.actions],
        "auth": {
            "type": "oauth2",
            "app": auth.app,
            "authorizeUrl": auth.authorize_url,
            "tokenUrl": auth.token_url,
            "scopes": list(auth.scopes),
            "scopeSeparator": auth.scope_separator,
            "registrationUrl": auth.registration_url,
            "authorizeParams": [list(pair) for pair in auth.authorize_params],
            "loginHint": auth.login_hint,
            "clientAuth": auth.client_auth,
            "jsonBody": auth.json_body,
            "pkce": auth.pkce,
        },
        "browsable": sorted(CONNECTOR.browsable),
        "manage_link": CONNECTOR.manage_link(),
        "operations": [
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "output_action": op.output_action,
                "consent": None if op.consent is None else [sorted(option) for option in op.consent],
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
            }
            for op in CONNECTOR.operations
        ],
    }


def inlined(node: Any, defs: dict[str, Any], field: bool = False) -> Any:
    """Pydantic's JSON Schema with its $defs written in place, and without the titles it gives fields,
    which zod has no names for. The models' titles (the root's and each nested model's) stay."""
    if isinstance(node, list):
        return [inlined(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        return inlined(defs[node["$ref"].removeprefix("#/$defs/")], defs)
    out = {}
    for key, value in node.items():
        if key == "$defs" or (field and key == "title"):
            continue
        if key == "properties":
            out[key] = {name: inlined(item, defs, field=True) for name, item in value.items()}
        else:
            out[key] = inlined(value, defs)
    return out


def schemas() -> list[list[Any]]:
    out = []
    for op in CONNECTOR.operations:
        schema = op.input_model.model_json_schema()
        out.append([op.name, inlined(schema, schema.get("$defs", {}))])
    return out


LINE = {
    "description": "Consulting, October",
    "quantity": "1.50",
    "unit_amount": "80.1250",
    "account_code": "200",
    "tax_type": "OUTPUT2",
    "discount_rate": "10.0",
}
GOODWILL = {"description": "Goodwill", "quantity": "1", "unit_amount": "-5"}
DRAFT = {
    "contact": CUSTOMER,
    "date": "2026-10-01",
    "due_date": "2026-10-31",
    "currency": "EUR",
    "amounts_are": "inclusive",
    "number": "INV-0100",
    "reference": "PO 9",
    "lines": [LINE, GOODWILL],
}
PAPER = {"description": "Paper", "quantity": "2", "unit_amount": "4.20"}
BILL = {"organisation": ACME, "contact": SUPPLIER, "number": "S-77", "lines": [PAPER]}


def line(**fields: Any) -> dict[str, Any]:
    return {"lines": [{"description": "x", "quantity": "1", "unit_amount": "1"} | fields], "contact": CUSTOMER}


DAYS = [
    "2026-10-01",
    " 2026-10-01 ",
    "2026-W40-4",
    "2026-W53-1",
    "2025-W53-1",
    "2026-W00-1",
    "2026-W01-0",
    "2026-W01-8",
    "2026-W01-1",
    "2026-w40-4",
    "2026W401xx",
    "2026W40xxx",
    "2026-W401x",
    "20261001xx",
    "20261301xx",
    "2026-1001xx",
    "2026-02-30",
    "2026-02-29",
    "2024-02-29",
    "1900-02-29",
    "2000-02-29",
    "26-01-01",
    "2026/10/01",
    "+026-10-01",
    "2026-10-0١",
    "２026-10-01",
    "0000-01-01",
    "0001-01-01",
    "1899-12-31",
    "1900-01-01",
    "2200-12-31",
    "2201-01-01",
    "1800-01-01",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-1x",
    "2026-1-01x",
    "1900-W01-1",
    "2200-W53-7",
    "2200-W52-7",
    "2026-10-01T",
    "2026-10",
    "",
]


def inputs_cases() -> list[tuple[str, Any]]:
    cases: list[tuple[str, Any]] = [
        ("list_organisations", {}),
        ("list_organisations", None),
        ("list_organisations", {"organisation": ACME}),
        ("list_organisations", []),
        ("list_organisations", "x"),
        ("search_contacts", {}),
        ("search_contacts", {"organisation": ACME.upper()}),
        ("search_contacts", {"organisation": f"  {ACME}\n"}),
        ("search_contacts", {"organisation": "not-a-uuid-but-thirty-six-chars-xxx"}),
        ("search_contacts", {"organisation": "x"}),
        ("search_contacts", {"organisation": "0a1b2c3d-0000-4000-8000-00000000000g"}),
        ("search_contacts", {"organisation": xc.ZERO_UUID}),
        ("search_contacts", {"organisation": 5}),
        ("search_contacts", {"organisation": None}),
        ("search_contacts", {"text": "carol", "limit": 5}),
        ("search_contacts", {"text": " carol "}),
        ("search_contacts", {"text": "INV\n1"}),
        ("search_contacts", {"text": ""}),
        ("search_contacts", {"text": "   "}),
        ("search_contacts", {"text": "x" * 101}),
        ("search_contacts", {"text": "\U0001f600" * 100}),
        ("search_contacts", {"include_archived": True, "limit": 2}),
        ("search_contacts", {"include_archived": "true"}),
        ("search_contacts", {"include_archived": 1}),
        ("search_contacts", {"limit": 0}),
        ("search_contacts", {"limit": 51}),
        ("search_contacts", {"limit": "5"}),
        ("search_contacts", {"limit": 5.5}),
        ("search_contacts", {"limit": True}),
        ("search_contacts", {"cursor": "2"}),
        ("search_contacts", {"cursor": " 2 "}),
        ("search_contacts", {"cursor": "x" * 1001}),
        ("search_contacts", {"connection_id": "c"}),
        ("search_contacts", {"text": 5, "limit": 0, "organisation": "x", "include_archived": None, "cursor": 1, "z": 1}),
        (
            "search_invoices",
            {
                "type": "sales",
                "statuses": ["AUTHORISED", "PAID", "AUTHORISED"],
                "contact": CUSTOMER.upper(),
                "text": "INV-0001",
                "date_from": "2026-01-01",
                "date_to": "2026-12-31",
                "limit": 10,
            },
        ),
        ("search_invoices", {}),
        ("search_invoices", {"type": "credit"}),
        ("search_invoices", {"type": " sales "}),
        ("search_invoices", {"type": None}),
        ("search_invoices", {"statuses": ["SENT"]}),
        ("search_invoices", {"statuses": []}),
        ("search_invoices", {"statuses": ["PAID"] * 7}),
        ("search_invoices", {"statuses": ["paid"]}),
        ("search_invoices", {"statuses": "PAID"}),
        ("search_invoices", {"statuses": None}),
        ("search_invoices", {"contact": "Carol"}),
        ("search_invoices", {"contact": None}),
        ("search_invoices", {"text": "INV\n1"}),
        ("search_invoices", {"where": "Total>0"}),
        ("search_invoices", {"date_from": "2026-02-01", "date_to": "2026-01-01"}),
        ("get_invoice", {"invoice": INVOICE.upper()}),
        ("get_invoice", {"invoice": INVOICE, "organisation": BETA}),
        ("get_invoice", {}),
        ("get_invoice", {"invoice": "x"}),
        ("get_invoice", {"invoice": None}),
        ("get_invoice", {"invoice": "10000000-0000-4000-8000-00000000000Z"}),
        ("list_accounts", {}),
        ("list_accounts", {"organisation": BETA}),
        ("list_accounts", {"organisation": BETA, "limit": 1}),
        ("list_tax_rates", {}),
        ("list_tax_rates", {"organisation": ACME.upper()}),
        ("create_draft_invoice", DRAFT),
        ("create_draft_invoice", DRAFT | {"status": "AUTHORISED"}),
        ("create_draft_invoice", DRAFT | {"contact": {"Name": "New Co"}}),
        ("create_draft_invoice", DRAFT | {"lines": []}),
        ("create_draft_invoice", DRAFT | {"lines": [LINE | {"Status": "PAID"}]}),
        ("create_draft_invoice", DRAFT | {"lines": [LINE | {"quantity": 1.5}]}),
        ("create_draft_invoice", DRAFT | {"due_date": "2026-09-30"}),
        ("create_draft_invoice", DRAFT | {"currency": "eur"}),
        ("create_draft_invoice", DRAFT | {"currency": " EUR "}),
        ("create_draft_invoice", DRAFT | {"currency": "EURO"}),
        ("create_draft_invoice", DRAFT | {"number": "INV\n1"}),
        ("create_draft_invoice", DRAFT | {"number": "x" * 256}),
        ("create_draft_invoice", DRAFT | {"amounts_are": "gross"}),
        ("create_draft_invoice", DRAFT | {"lines": [5]}),
        ("create_draft_invoice", DRAFT | {"lines": [GOODWILL] * 101}),
        ("create_draft_invoice", DRAFT | {"lines": "x"}),
        ("create_draft_invoice", {"contact": CUSTOMER, "lines": [GOODWILL]}),
        ("create_draft_invoice", {"lines": [GOODWILL]}),
        ("create_draft_invoice", {}),
        ("create_draft_invoice", line(description="a\tb\nc")),
        ("create_draft_invoice", line(description="a\x00b")),
        ("create_draft_invoice", line(description="  ")),
        ("create_draft_invoice", line(account_code="2\t00")),
        ("create_draft_invoice", line(item_code="x" * 51)),
        ("create_draft_invoice", line(tax_type=None)),
        ("create_draft_invoice", line(quantity="2.500", unit_amount="-0.0")),
        ("create_draft_invoice", line(unit_amount="9999999999.9999")),
        ("create_draft_invoice", line(discount_rate="100")),
        ("create_draft_invoice", line(discount_rate="100.00")),
        ("create_draft_invoice", line(discount_rate="0")),
        ("create_draft_invoice", line(discount_rate="010.50")),
        ("create_draft_invoice", line(discount_rate=None)),
        ("create_draft_invoice", line(quantity="0010", unit_amount="0.0001")),
        ("create_draft_invoice", line(quantity=" 2 ", unit_amount=" -5.10 ")),
        ("create_draft_invoice", line(quantity="999999999.9999", unit_amount="-9999999999.9999")),
    ]
    for fields in (
        {"quantity": "0"},
        {"quantity": "0.0000"},
        {"quantity": "-1"},
        {"quantity": "1.00001"},
        {"quantity": "1e3"},
        {"quantity": "1."},
        {"quantity": ".5"},
        {"quantity": "+1"},
        {"quantity": "１"},
        {"quantity": "1000000000"},
        {"quantity": ""},
        {"quantity": "x" * 16},
        {"unit_amount": "1,00"},
        {"unit_amount": "NaN"},
        {"unit_amount": "Infinity"},
        {"unit_amount": "12345678901"},
        {"unit_amount": "--1"},
        {"unit_amount": "-"},
        {"unit_amount": "1.23456"},
        {"discount_rate": "100.01"},
        {"discount_rate": "-1"},
        {"discount_rate": "1000"},
        {"discount_rate": "99.999"},
        {"discount_rate": ""},
        {"discount_rate": 5},
    ):
        cases.append(("create_draft_invoice", line(**fields)))
    cases += [
        ("create_draft_bill", BILL),
        ("create_draft_bill", BILL | {"reference": "x"}),
        ("create_draft_bill", BILL | {"lines": [PAPER | {"discount_rate": "5"}]}),
        ("create_draft_bill", BILL | {"lines": [PAPER | {"quantity": "0"}]}),
        ("create_draft_bill", {"contact": SUPPLIER, "lines": [PAPER], "date": "2026-10-01"}),
    ]
    for value in DAYS:
        cases.append(("search_invoices", {"date_from": value}))
        cases.append(("create_draft_bill", {"contact": SUPPLIER, "lines": [PAPER], "due_date": value}))
    return cases


def inputs() -> list[dict[str, Any]]:
    out = []
    for name, raw in inputs_cases():
        op = OPERATIONS[name]
        entry: dict[str, Any] = {"op": name, "raw": raw}
        try:
            data = op.input_model.model_validate(raw if raw is not None else {})
        except ValidationError as error:
            entry["message"] = HELPERS["validation_message"](error)
        else:
            fields = data.model_dump()
            entry["dump"] = fields
            if name == "search_invoices":
                entry["where"] = xr._where(data)
                entry["params"] = [[k, str(v)] for k, v in xr._invoice_params(data, 1).items()]
            if name in {"create_draft_invoice", "create_draft_bill"}:
                kind = "sales" if name == "create_draft_invoice" else "bill"
                entry["body"] = json.dumps({"Invoices": [xw.body(data, kind)]})
        out.append(entry)
    return out


class Amount(BaseModel):
    a: Decimal | None = None


AMOUNTS = [
    "0",
    "-0",
    "0.0",
    "-0.0",
    "1",
    "-1",
    "1e2",
    "1E2",
    "100.0",
    "70.0",
    "0.1",
    "0.30000000000000004",
    "1e-7",
    "-1e-7",
    "1.5e-10",
    "5e-324",
    "1e-400",
    "80.1234",
    "115.1875",
    "120.19",
    "24.04",
    "-5",
    "-0.005",
    "1.005",
    "2.675",
    "123456789.123",
    "9999999999.9999",
    "1e15",
    "1.5e15",
    "9007199254740991",
    "-9007199254740991",
    "4503599627370496.5",
    "12.5",
    "12.50",
    "0.01",
    "0.001",
    "1.10",
    "20.0",
    "17.5",
    "0.125",
]


def amounts() -> list[dict[str, Any]]:
    out = []
    for text in AMOUNTS:
        value = Amount.model_validate_json('{"a": ' + text + "}").a
        out.append({"text": text, "money": xo.money(value), "number": xo.number(value)})
    return out


MOMENTS = [
    "/Date(1788220800000+0000)/",
    "/Date(1788220800000)/",
    "/Date(1788220800999+0000)/",
    "/Date(1788307200000-0700)/",
    "/Date(0)/",
    "/Date(-1)/",
    "/Date(-999)/",
    "/Date(-1000)/",
    "/Date(-1001)/",
    "/Date(999999999999999)/",
    "/Date(99999999999999999)/",
    "/Date(253402300799999)/",
    "/Date(253402300800000)/",
    "/Date(-62135596800000)/",
    "/Date(-62135596800001)/",
    "/Date(-62135596799999)/",
    "/Date(١٧٨٨٢٢٠٨٠٠٠٠٠)/",
    "/Date(\U0001d7d8\U0001d7d9\U0001d7da)/",
    "/Date(1788220800000+00)/",
    "/Date(1788220800000 +0000)/",
    "/Date(+1788220800000)/",
    "/Date()/",
    "/Date(1788220800000+0000)/\n",
    "Date(1788220800000)",
    "2026-09-01",
    "",
]
STRINGS = [
    "2026-09-01T00:00:00",
    "2026-09-01",
    "2026-09-01T",
    "2026-09-01T00:00:00.123",
    "2026-09-01T00:00:00Z",
    "2026-09-01 00:00:00",
    "２０２６-09-01",
    "2026-9-01",
    "2026-09-01\n",
    "soon",
    "",
]


def dates() -> dict[str, Any]:
    days = []
    for value in DAYS:
        stripped = value.strip()
        try:
            kept = xr._day(stripped)
        except ValueError as error:
            days.append({"value": stripped, "error": str(error)})
        else:
            found = Date.fromisoformat(kept)
            days.append({"value": stripped, "date": [found.year, found.month, found.day]})
    return {
        "moments": [[value, xc.moment(value)] for value in MOMENTS],
        "dates": [[value, xc.date(value)] for value in STRINGS],
        "invoice_dates": [
            [text, raw, xc.invoice_date(text, raw)]
            for text in (None, "2026-09-02T00:00:00", "soon")
            for raw in (None, "/Date(1788220800000+0000)/", "/Date(x)/")
        ],
        "days": days,
    }


def pages() -> dict[str, Any]:
    found = []
    for cursor in (None, "1", "7", "100000", "100001", "0", "01", "-1", "x", "1" * 7, " 1", "1.0", "١"):
        try:
            found.append([cursor, xc.page(cursor)])
        except OperationError as error:
            found.append([cursor, {"code": error.code, "message": error.message}])
    following = []
    for count_known in (None, 3, 0):
        pagination = None if count_known is None else xc.Pagination(pageCount=count_known)
        for current, count, size in ((1, 10, 10), (1, 9, 10), (2, 10, 10), (3, 10, 10), (xc.MAX_PAGE, 10, 10), (xc.MAX_PAGE - 1, 10, 10)):
            following.append([count_known, current, count, size, xc.next_page(pagination, current, count, size)])
    following.append(["empty", 1, 10, 10, xc.next_page(xc.Pagination(), 1, 10, 10)])
    return {"page": found, "next": following}


CLASSIFIED = [
    (
        400,
        {
            "ErrorNumber": 10,
            "Type": "ValidationException",
            "Message": SECRET,
            "Elements": [
                {"ValidationErrors": [{"Message": "Account code '999' is not a valid code."}]},
                {"ValidationErrors": [{"Message": "Account code '999' is not a valid code."}, {"Message": "x\ny"}]},
            ],
        },
    ),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": str(n) * 400} for n in range(9)]}),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": "a" * 300 + "b"}, {"Message": "a" * 300 + "c"}]}),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": "a" * 300}, {"Message": "a" * 300}]}),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": None}, {"Message": "  \x1c "}, {}]}),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": "first"}], "Elements": [{"ValidationErrors": [{"Message": "second"}]}]}),
    (400, {"Type": "ValidationException"}),
    (400, {"Type": "ValidationException", "Elements": None}),
    (400, {"Type": "ValidationException", "ValidationErrors": [{"Message": 5}]}),
    (400, {"Type": "QueryParseException", "Message": SECRET}),
    (400, {"Type": None}),
    (400, ["ValidationException"]),
    (400, b"<html>"),
    (400, b""),
    (400, b"\xef\xbb\xbf" + json.dumps({"Type": "ValidationException", "ValidationErrors": [{"Message": "m"}]}).encode()),
    (403, {"Detail": SECRET}),
    (403, b"<html>"),
    (401, {"Detail": SECRET}),
    (404, {"Type": "ValidationException"}),
    (500, {"Detail": SECRET}),
]


def classified() -> list[dict[str, Any]]:
    out = []
    for status, content in CLASSIFIED:
        raw = content if isinstance(content, bytes) else json.dumps(content).encode()
        found = xc.classify("Xero", httpx.Response(status, content=raw))
        out.append({"status": status, "body": raw.decode(), "named": None if found is None else [found.code, found.message]})
    return out


REFUSED = {"InvoiceID": xc.ZERO_UUID, "HasErrors": True, "ValidationErrors": []}
JUDGED = [
    (200, {"Invoices": [REFUSED]}),
    (200, {"Invoices": [REFUSED | {"InvoiceID": INVOICE}]}),
    (200, {"Invoices": [REFUSED | {"InvoiceID": INVOICE.upper()}]}),
    (200, {"Invoices": [{"InvoiceID": INVOICE}]}),
    (200, {"Invoices": []}),
    (200, {"Invoices": None}),
    (200, [REFUSED]),
    (400, {"Invoices": [REFUSED]}),
    (201, {"Invoices": [REFUSED, REFUSED | {"InvoiceID": None}]}),
    (200, {"Invoices": [REFUSED, REFUSED | {"InvoiceID": "not-an-id"}]}),
    (200, {"Invoices": [REFUSED, REFUSED | {"HasErrors": 1}]}),
    (200, {"Invoices": [REFUSED, 5]}),
    (200, {"Invoices": [REFUSED | {"InvoiceID": 0}]}),
    (200, {"Invoices": [REFUSED | {"InvoiceID": []}]}),
    (200, {"Invoices": [REFUSED | {"InvoiceID": 5}]}),
    (200, {"Invoices": [{"HasErrors": False}, REFUSED | {"InvoiceID": 5}]}),
    (200, {"Invoices": [{"HasErrors": True}]}),
    (200, b"not json"),
    (200, b"\xef\xbb\xbf" + json.dumps({"Invoices": [REFUSED]}).encode()),
]


def judged() -> list[dict[str, Any]]:
    out = []
    for status, content in JUDGED:
        raw = content if isinstance(content, bytes) else json.dumps(content).encode()
        try:
            found = xc.judge(httpx.Response(status, content=raw))
        except AttributeError:
            effect: Any = "raises"
        else:
            effect = None if found is None else found.value
        out.append({"status": status, "body": raw.decode(), "effect": effect})
    return out


SHORTS = [
    None,
    "",
    "   ",
    "Acme  Ltd",
    "\tAcme\nLtd\x1c\x1d\x1e\x1f\x85\xa0 　x​",
    "x" * 501,
    "\U0001f600" * 501,
    "a​b",
]


def texts() -> dict[str, Any]:
    return {
        "short": [[value, xo.short(value)] for value in SHORTS],
        "short_300": [[value, xo.short(value, 300)] for value in SHORTS],
        "messages": [
            [found, xc.messages([xc.Message(Message=m) for m in found])]
            for found in (
                [],
                ["one", "one", " one "],
                ["x\ny", None, "", "  "],
                [str(n) * 400 for n in range(9)],
                ["a" * 300 + "b", "a" * 300 + "c", "a" * 300 + "b"],
                ["a", "b", "c", "d", "e", "f"],
            )
        ],
    }


def resource(r) -> dict[str, Any]:
    return {"connection_id": r.connection_id, "kind": r.kind, "id": r.id, "within": list(r.within), "partial": r.partial}


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
                "url": f"{request.url.scheme}://{request.url.host}{request.url.path}",
                "params": [list(item) for item in request.url.params.multi_items()],
                "authorization": request.headers.get("authorization"),
                "accept": request.headers.get("accept"),
                "tenant": request.headers.get("xero-tenant-id"),
                "content_type": request.headers.get("content-type"),
                "body": request.content.decode() if request.content else None,
            }
        )
        if not self.responses:
            raise AssertionError("No scripted response left.")
        status, content = served(self.responses.pop(0))
        return httpx.Response(status, content=content, headers={"content-type": "application/json"})


def served(response: dict[str, Any]) -> tuple[int, bytes]:
    """A scripted response as it is sent: its status and the bytes of its body."""
    if "hex" in response:
        return response["status"], bytes.fromhex(response["hex"])
    if isinstance(response["body"], str):
        return response["status"], response["body"].encode()
    return response["status"], json.dumps(response["body"]).encode()


def written(response: dict[str, Any]) -> dict[str, Any]:
    """A scripted response for the vectors: the body's exact text, so a JSON number reads as Python wrote it
    (-0.0 keeps its sign), or its bytes in hex when they are not UTF-8."""
    status, content = served(response)
    try:
        return {"status": status, "text": content.decode()}
    except UnicodeDecodeError:
        return {"status": status, "hex": content.hex()}


def ok(body: Any, status: int = 200) -> dict[str, Any]:
    return {"status": status, "body": body}


def connections(*tenants: str) -> dict[str, Any]:
    names = {ACME: "Acme  Ltd", BETA: SECRET}
    return ok([{"id": f"c{n}", "tenantId": t, "tenantType": "ORGANISATION", "tenantName": names.get(t)} for n, t in enumerate(tenants)])


ALL_CONNECTIONS = ok(
    [
        {"id": "c1", "tenantId": BETA, "tenantType": "ORGANISATION", "tenantName": SECRET},
        {"id": "c2", "tenantId": ACME, "tenantType": "ORGANISATION", "tenantName": "Acme  Ltd"},
        {"id": "c3", "tenantId": ACME.upper(), "tenantType": "ORGANISATION", "tenantName": "Acme"},
        {"id": "c4", "tenantId": UNREACHED, "tenantType": "PRACTICEMANAGER", "tenantName": "Practice"},
        {"id": "c5", "tenantId": "not-a-uuid", "tenantType": "ORGANISATION", "tenantName": "Odd"},
        {"id": "c6", "tenantId": xc.ZERO_UUID, "tenantType": "ORGANISATION", "tenantName": "Zero"},
        {"id": "c7", "tenantId": "0a1b2c3d-0000-4000-8000-000000000009", "tenantType": None, "tenantName": "Untyped"},
        {"id": "c8", "tenantId": "0a1b2c3d-0000-4000-8000-000000000004", "tenantType": "ORGANISATION", "tenantName": " \n "},
    ]
)
ME = ok({"sub": "u-991", "name": "Ada Lovelace", "given_name": "Ada", "family_name": "Lovelace", "email": "ada@example.com"})


def contact(contact_id: str, name: str, status: str = "ACTIVE", **fields: Any) -> dict[str, Any]:
    return {
        "ContactID": contact_id.upper(),
        "Name": name,
        "ContactStatus": status,
        "EmailAddress": f"{name.split()[0].lower()}@example.com",
        "BankAccountDetails": "01-0123-0123456-00",
        "Addresses": [],
        "Phones": [],
        "ContactPersons": [],
    } | fields


CAROL = contact(
    CUSTOMER,
    "Carol Customer",
    IsCustomer=True,
    Addresses=[
        {"AddressType": "POBOX", "AddressLine1": "PO Box 1", "City": "Zurich", "Country": "CH"},
        {"AddressType": "STREET"},
        {"AddressType": "DELIVERY", "AddressLine2": "  ", "Region": "ZH"},
        {"AddressType": "STREET", "AddressLine1": " Main\tStreet ", "AddressLine3": "Floor 2", "PostalCode": "8000"},
    ],
    Phones=[
        {"PhoneType": "DEFAULT", "PhoneNumber": "123 45 67", "PhoneAreaCode": "44", "PhoneCountryCode": "41"},
        {"PhoneType": "FAX"},
        {"PhoneType": "MOBILE", "PhoneNumber": "  ", "PhoneAreaCode": ""},
        {"PhoneType": "DDI", "PhoneNumber": " 9\n9 "},
    ],
    ContactPersons=[
        {"FirstName": "Cy", "LastName": "C", "EmailAddress": "cy@example.com"},
        {"FirstName": "", "LastName": None},
        {"LastName": "Only"},
    ],
    Balances={"AccountsReceivable": {"Outstanding": 70.0, "Overdue": 0}, "AccountsPayable": {"Outstanding": -0.0, "Overdue": 12.345}},
    FirstName="Carol",
    LastName=None,
    ContactNumber=" 42 ",
    AccountNumber="A-1",
    IsSupplier=False,
    DefaultCurrency="EUR",
    TaxNumber="CHE-1",
)
SAM = contact(SUPPLIER, "Sam Supplier", IsSupplier=True, Balances={})
MANY = contact("c0000000-0000-4000-8000-000000000004", "Many", Addresses=[{"City": f"City {n}"} for n in range(25)], Phones=[{"PhoneNumber": str(n)} for n in range(25)], ContactPersons=[{"FirstName": str(n)} for n in range(25)])


def invoice(invoice_id: str, kind: str, of: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {
        "InvoiceID": invoice_id,
        "Type": kind,
        "InvoiceNumber": "INV-0001",
        "Reference": "PO 7",
        "Contact": {"ContactID": of["ContactID"], "Name": of["Name"]},
        "Status": "AUTHORISED",
        "Date": "/Date(1788220800000+0000)/",
        "DateString": "2026-09-01T00:00:00",
        "DueDate": "/Date(1789430400000+0000)/",
        "DueDateString": "2026-09-15T00:00:00",
        "CurrencyCode": "EUR",
        "LineAmountTypes": "Exclusive",
        "SubTotal": 100.0,
        "TotalTax": 20.0,
        "Total": 120.0,
        "AmountDue": 70.0,
        "AmountPaid": 50.0,
        "AmountCredited": 0,
        "SentToContact": True,
        "HasAttachments": False,
        "UpdatedDateUTC": "/Date(1788307200000+0000)/",
    } | fields


LINES = [
    {
        "Description": "Consulting\nSeptember",
        "Quantity": 1.5,
        "UnitAmount": 80.1234,
        "AccountCode": "200",
        "TaxType": "OUTPUT2",
        "TaxAmount": 24.04,
        "LineAmount": 120.19,
        "DiscountRate": 0,
        "Tracking": [{"Name": "Region", "Option": "North"}],
    },
    {"Description": "x" * 2500, "Quantity": 1, "UnitAmount": 1},
    {"Description": "", "Quantity": -0.0, "UnitAmount": 1e-7, "DiscountAmount": 0.005, "ItemCode": " A\tB ", "Tracking": [{"Name": f"T{n}"} for n in range(25)]},
] + [{"Description": "more", "Quantity": 1, "UnitAmount": 1}] * 200
FULL = invoice(
    INVOICE,
    "ACCREC",
    CAROL,
    LineItems=LINES,
    Payments=[{"PaymentID": "p", "Date": "/Date(1788393600000+0000)/", "Amount": 50.0, "Reference": "wire"}, {"Date": None, "Amount": None}]
    + [{"Date": "/Date(0)/", "Amount": 1}] * 50,
)
ODD = invoice(
    "10000000-0000-4000-8000-000000000002",
    "ACCPAY",
    SAM,
    DateString=None,
    DueDateString="soon",
    DueDate="/Date(x)/",
    SubTotal=-0.0,
    TotalTax=1e-7,
    Total=0.30000000000000004,
    AmountDue=1e15,
    AmountPaid=None,
    AmountCredited=12.5,
    SentToContact=None,
    UpdatedDateUTC=None,
    Contact=None,
    Type="ACCPAYCREDIT",
)
DRAFTED = invoice(
    "20000000-0000-4000-8000-000000000001",
    "ACCREC",
    CAROL,
    Status="DRAFT",
    InvoiceNumber="INV-0100",
    Reference="PO 9",
    SubTotal=115.1875,
    TotalTax=0,
    Total=115.1875,
    AmountDue=115.1875,
    AmountPaid=0,
    SentToContact=False,
    Warnings=[{"Message": "Account code '200' has been archived"}],
)
ACCOUNTS = [
    {"Code": "200", "Name": "Sales", "Type": "REVENUE", "Class": "REVENUE", "Status": "ACTIVE", "TaxType": "OUTPUT2", "Description": "Income from sales"},
    {"Code": "090", "Name": "Bank", "Type": "BANK", "Class": "ASSET", "Status": "ACTIVE", "BankAccountNumber": "01-0123-0123456-00"},
    {"Code": "999", "Name": "Old", "Type": "EXPENSE", "Status": "ARCHIVED"},
    {"Code": " 300 ", "Name": None, "Description": "d" * 400},
]
TAX_RATES = [
    {
        "Name": "20% (VAT on Income)",
        "TaxType": "OUTPUT2",
        "Status": "ACTIVE",
        "DisplayTaxRate": 20.0,
        "EffectiveRate": 20.0,
        "CanApplyToRevenue": True,
        "CanApplyToExpenses": False,
        "TaxComponents": [{"Name": "VAT", "Rate": 20.0, "IsCompound": False, "IsNonRecoverable": False}],
    },
    {"Name": "Old", "TaxType": "OLD", "Status": "DELETED"},
    {"Name": "Compound", "TaxType": "C", "DisplayTaxRate": 17.5, "EffectiveRate": 17.875, "TaxComponents": [{"Name": f"c{n}", "Rate": n / 8} for n in range(25)]},
]
VALIDATION = {"Type": "ValidationException", "Message": SECRET, "Elements": [{"ValidationErrors": [{"Message": "Invoice # must be unique."}]}]}
SMALL_DRAFT = {"contact": CUSTOMER, "lines": [{"description": "x1", "quantity": "1", "unit_amount": "1"}]}


def page_of(key: str, items: list[Any], page: int = 1, count: int | None = 1) -> dict[str, Any]:
    pagination = None if count is None else {"page": page, "pageSize": 100, "pageCount": count, "itemCount": len(items)}
    return ok({"pagination": pagination, key: items} if pagination is not None else {key: items})


SCENARIOS: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = [
    ("account", {"kind": "account"}, [ME, ALL_CONNECTIONS]),
    ("account given name", {"kind": "account"}, [ok({"sub": "u-991", "given_name": "Ada"}), connections(ACME)]),
    ("account family name and email", {"kind": "account"}, [ok({"sub": "u-991", "family_name": "L", "email": "a@example.com"}), connections(ACME)]),
    ("account email only", {"kind": "account"}, [ok({"sub": "u-991", "email": "a@example.com", "name": ""}), connections(ACME)]),
    ("account nothing", {"kind": "account"}, [ok({"sub": "u-991"}), connections(ACME)]),
    ("account without sub", {"kind": "account"}, [ok({"name": "Ada"})]),
    ("account empty sub", {"kind": "account"}, [ok({"sub": ""})]),
    ("account sub not text", {"kind": "account"}, [ok({"sub": 5})]),
    ("account no organisation", {"kind": "account"}, [ok({"sub": "u-991"}), ok([{"tenantId": UNREACHED, "tenantType": "PRACTICEMANAGER"}])]),
    ("account unauthorized", {"kind": "account"}, [ok({}, 401)]),
    ("discover", {"kind": "discover", "query": None, "cursor": None}, [ALL_CONNECTIONS]),
    ("discover query", {"kind": "discover", "query": "ACME", "cursor": None}, [ALL_CONNECTIONS]),
    ("discover empty query", {"kind": "discover", "query": "", "cursor": None}, [ALL_CONNECTIONS]),
    ("discover folded query", {"kind": "discover", "query": "STRASSE", "cursor": None}, [ok([{"tenantId": ACME, "tenantType": "ORGANISATION", "tenantName": "Straße GmbH"}])]),
    ("discover unnamed", {"kind": "discover", "query": "organisation 0a1b", "cursor": None}, [ok([{"tenantId": ACME, "tenantType": "ORGANISATION"}])]),
    ("discover cursor", {"kind": "discover", "query": None, "cursor": "2"}, []),
    (
        "discover a hundred",
        {"kind": "discover", "query": None, "cursor": None},
        [ok([{"tenantId": f"0A1B2C3D-0000-4000-8000-{n:012d}", "tenantType": "ORGANISATION"} for n in range(100, 0, -1)] + [{"tenantId": ACME, "tenantType": "ORGANISATION"}])],
    ),
    ("discover not a list", {"kind": "discover", "query": None, "cursor": None}, [ok({"tenantId": ACME})]),
    ("discover item without id", {"kind": "discover", "query": None, "cursor": None}, [ok([{"tenantType": "ORGANISATION"}])]),
    ("discover byte order mark", {"kind": "discover", "query": None, "cursor": None}, [ok("﻿" + json.dumps([{"tenantId": ACME, "tenantType": "ORGANISATION"}]))]),
    ("discover forbidden", {"kind": "discover", "query": None, "cursor": None}, [ok({"Detail": SECRET}, 403)]),
    ("describe", {"kind": "describe", "ids": [ACME, UNREACHED, "x", BETA.upper()]}, [ALL_CONNECTIONS]),
    ("list organisations", {"kind": "op", "op": "list_organisations", "args": {}}, [ALL_CONNECTIONS]),
    ("search contacts", {"kind": "op", "op": "search_contacts", "args": {"text": "carol", "limit": 5}}, [connections(ACME), page_of("Contacts", [CAROL, SAM, MANY], count=2)]),
    (
        "search contacts archived page",
        {"kind": "op", "op": "search_contacts", "args": {"organisation": BETA, "include_archived": True, "limit": 2, "cursor": "2"}},
        [connections(ACME, BETA), page_of("Contacts", [SAM], page=2, count=2)],
    ),
    ("search contacts without pagination", {"kind": "op", "op": "search_contacts", "args": {"limit": 1}}, [connections(ACME), ok({"Contacts": [SAM]})]),
    ("search contacts short page", {"kind": "op", "op": "search_contacts", "args": {"limit": 2}}, [connections(ACME), ok({"Contacts": [SAM]})]),
    ("search contacts last page", {"kind": "op", "op": "search_contacts", "args": {"limit": 1, "cursor": "100000"}}, [connections(ACME), ok({"Contacts": [SAM]})]),
    ("search contacts bad cursor", {"kind": "op", "op": "search_contacts", "args": {"cursor": "0"}}, [connections(ACME)]),
    ("search contacts too many", {"kind": "op", "op": "search_contacts", "args": {"limit": 1}}, [connections(ACME), ok({"Contacts": [SAM, CAROL]})]),
    ("search contacts odd id", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME), ok({"Contacts": [contact(xc.ZERO_UUID, "Zero")]})]),
    ("search contacts no id", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME), ok({"Contacts": [{"Name": "x"}]})]),
    ("search contacts null list", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME), ok({"Contacts": None})]),
    ("search contacts invalid utf-8", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME), {"status": 200, "hex": "7b22436f6e7461637473223a5b5dff7d"}]),
    ("search contacts two organisations", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME, BETA)]),
    ("search contacts no organisation", {"kind": "op", "op": "search_contacts", "args": {}}, [ok([])]),
    ("search contacts unreached", {"kind": "op", "op": "search_contacts", "args": {"organisation": UNREACHED}}, [ALL_CONNECTIONS]),
    ("search contacts rate limited", {"kind": "op", "op": "search_contacts", "args": {}}, [connections(ACME), ok({}, 429)]),
    (
        "search invoices",
        {
            "kind": "op",
            "op": "search_invoices",
            "args": {
                "type": "sales",
                "statuses": ["AUTHORISED", "PAID", "AUTHORISED"],
                "contact": CUSTOMER.upper(),
                "text": "INV-0001",
                "date_from": "2026-01-01",
                "date_to": "2026-12-31",
                "limit": 10,
            },
        },
        [connections(ACME), page_of("Invoices", [invoice(INVOICE, "ACCREC", CAROL), ODD])],
    ),
    ("search invoices week dates", {"kind": "op", "op": "search_invoices", "args": {"type": "bill", "date_from": "2026-W40-4", "date_to": "20261231xx"}}, [connections(ACME), ok({"Invoices": []})]),
    ("search invoices reversed dates", {"kind": "op", "op": "search_invoices", "args": {"date_from": "2026-02-01", "date_to": "2026-01-01"}}, []),
    ("search invoices reversed as text", {"kind": "op", "op": "search_invoices", "args": {"date_from": "2026-W40-4", "date_to": "2026-12-31"}}, []),
    ("search invoices page", {"kind": "op", "op": "search_invoices", "args": {"limit": 2, "cursor": "2"}}, [connections(ACME), page_of("Invoices", [ODD], page=2, count=2)]),
    ("search invoices page refused", {"kind": "op", "op": "search_invoices", "args": {"limit": 2, "cursor": "2"}}, [connections(ACME), ok({"Type": "QueryParseException"}, 400)]),
    ("search invoices page invalid", {"kind": "op", "op": "search_invoices", "args": {"limit": 2, "cursor": "2"}}, [connections(ACME), ok(VALIDATION, 400)]),
    ("search invoices refused", {"kind": "op", "op": "search_invoices", "args": {"limit": 2}}, [connections(ACME), ok(VALIDATION, 400)]),
    ("search invoices not found", {"kind": "op", "op": "search_invoices", "args": {"limit": 2, "cursor": "2"}}, [connections(ACME), ok({}, 404)]),
    ("search invoices without id", {"kind": "op", "op": "search_invoices", "args": {}}, [connections(ACME), ok({"Invoices": [{"Type": "ACCREC"}]})]),
    ("get invoice", {"kind": "op", "op": "get_invoice", "args": {"invoice": INVOICE.upper()}}, [connections(ACME), ok({"Invoices": [FULL]})]),
    ("get invoice odd", {"kind": "op", "op": "get_invoice", "args": {"invoice": ODD["InvoiceID"]}}, [connections(ACME), ok({"Invoices": [ODD]})]),
    ("get invoice other", {"kind": "op", "op": "get_invoice", "args": {"invoice": INVOICE}}, [connections(ACME), ok({"Invoices": [ODD]})]),
    ("get invoice two", {"kind": "op", "op": "get_invoice", "args": {"invoice": ODD["InvoiceID"]}}, [connections(ACME), ok({"Invoices": [ODD, ODD]})]),
    ("get invoice missing", {"kind": "op", "op": "get_invoice", "args": {"invoice": INVOICE}}, [connections(ACME), ok({"Title": SECRET}, 404)]),
    ("get invoice forbidden", {"kind": "op", "op": "get_invoice", "args": {"invoice": INVOICE}}, [connections(ACME), ok({"Title": SECRET}, 403)]),
    ("get invoice failed", {"kind": "op", "op": "get_invoice", "args": {"invoice": INVOICE}}, [connections(ACME), ok({"Title": SECRET}, 503)]),
    ("list accounts", {"kind": "op", "op": "list_accounts", "args": {}}, [connections(ACME), ok({"Accounts": ACCOUNTS})]),
    ("list tax rates", {"kind": "op", "op": "list_tax_rates", "args": {"organisation": ACME}}, [connections(ACME, BETA), ok({"TaxRates": TAX_RATES})]),
    (
        "draft invoice",
        {"kind": "op", "op": "create_draft_invoice", "args": DRAFT},
        [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": [DRAFTED]})],
    ),
    (
        "draft bill",
        {"kind": "op", "op": "create_draft_bill", "args": BILL},
        [connections(ACME, BETA), ok({"Contacts": [SAM]}), ok({"Invoices": [invoice("20000000-0000-4000-8000-000000000002", "ACCPAY", SAM, Status="DRAFT", InvoiceNumber="S-77", SubTotal=8.4)]})],
    ),
    ("draft with week dates", {"kind": "op", "op": "create_draft_bill", "args": {"contact": SUPPLIER, "lines": [PAPER], "date": "2026-W40-4", "due_date": "20261231xx"}}, [connections(ACME), ok({"Contacts": [SAM]}), ok({"Invoices": [DRAFTED]})]),
    ("draft dates reversed", {"kind": "op", "op": "create_draft_invoice", "args": DRAFT | {"due_date": "2026-09-30"}}, []),
    ("draft contact missing", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Title": SECRET}, 404)]),
    ("draft contact archived", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [contact(CUSTOMER, "Old", "ARCHIVED")]})]),
    ("draft contact without status", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [{"ContactID": CUSTOMER}]})]),
    ("draft contact of another id", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [SAM]})]),
    ("draft contact forbidden", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({}, 403)]),
    ("draft refused", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok(VALIDATION, 400)]),
    (
        "draft refused with 200",
        {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT},
        [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": [REFUSED | {"ValidationErrors": [{"Message": "Contact is archived."}]}]})],
    ),
    (
        "draft answered with errors",
        {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT},
        [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": [DRAFTED | {"HasErrors": True, "ValidationErrors": [{"Message": "Odd."}]}]})],
    ),
    ("draft answered as approved", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": [DRAFTED | {"Status": "AUTHORISED"}]})]),
    (
        "draft answered for another contact",
        {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT},
        [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": [DRAFTED | {"Contact": {"ContactID": SUPPLIER, "Name": "Sam"}}]})],
    ),
    ("draft answered empty", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Invoices": []})]),
    ("draft answered unreadable", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok("<html>")]),
    ("draft failed", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok({"Detail": SECRET}, 500)]),
    ("draft rate limited", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT}, [connections(ACME), ok({"Contacts": [CAROL]}), ok({}, 429)]),
    ("draft unreached", {"kind": "op", "op": "create_draft_invoice", "args": SMALL_DRAFT | {"organisation": UNREACHED}}, [ALL_CONNECTIONS]),
]


def error(e: OperationError) -> dict[str, Any]:
    return {"code": e.code, "message": e.message}


async def scenario(call: dict[str, Any], responses: list[dict[str, Any]]) -> dict[str, Any]:
    script = Script(responses)
    client = XeroClient(TOKEN, transport=httpx.MockTransport(script.handler))
    outcome: dict[str, Any] = {}
    try:
        if call["kind"] == "account":
            account = await CONNECTOR.account(client)
            outcome["account"] = {"id": account.id, "label": account.label}
        elif call["kind"] == "discover":
            page = await CONNECTOR.discover(client, "organisation", query=call["query"], cursor=call["cursor"])
            outcome["page"] = {"items": [[i.id, i.name, i.expandable] for i in page.items], "next_cursor": page.next_cursor}
        elif call["kind"] == "describe":
            names = await CONNECTOR.describe(client, "organisation", call["ids"])
            outcome["names"] = [[k, v] for k, v in names.items()]
        else:
            op = OPERATIONS[call["op"]]
            data = op.input_model.model_validate(call["args"])
            prepared = await op.prepare(Binding(CONNECTION, client), data)
            outcome["requirements"] = [requirement(r) for r in prepared.requirements]
            outcome["requests_before_execute"] = len(script.requests)
            if op.mutates:
                with write_attempt(time.monotonic() + 60) as attempt:
                    try:
                        output = await prepared.execute()
                    finally:
                        outcome["effect"] = (attempt.effect.value if attempt.effect else None) if attempt.sent else "not_sent"
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
        out.append({"name": name, "call": call, "responses": [written(response) for response in responses], **result})
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
        "schemas": schemas(),
        "inputs": inputs(),
        "amounts": amounts(),
        "dates": dates(),
        "pages": pages(),
        "classify": classified(),
        "judge": judged(),
        "texts": texts(),
        "scenarios": scenarios(),
        # "<code point>:<folded code points joined by .>" in hex, separated by spaces.
        "casefold": " ".join(f"{c:x}:{'.'.join(f'{x:x}' for x in f)}" for c, f in casefold()),
    }
    target = HERE / "vectors.json"
    target.write_text(json.dumps(compact(vectors), ensure_ascii=True, separators=(",", ":")) + "\n")
    print(f"Wrote {target.relative_to(HERE.parents[3])}")


if __name__ == "__main__":
    main()
