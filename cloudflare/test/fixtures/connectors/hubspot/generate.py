"""Writes vectors.json beside this file: what today's Python HubSpot
connector computes, for the port's cross-language tests.

- Declaration: the connector's kinds, actions, auth and operations (titles, descriptions, needs and terms),
  each field with its default, so every user-facing and model-facing word is today's.
- Schemas: each operation's input JSON Schema, what the model sees, without Pydantic's titles.
- Inputs: each operation's input model on a list of raw arguments, as the executor validates them
  (`model_validate`, the first five errors joined as `validation_message` words them), with the normalized
  arguments.
- Responses: the client's models on HubSpot's JSON, read as `_read` reads them (`model_validate_json`) and as
  `ProviderHTTP.parsed` does (`json.loads`, then `model_validate`); integers are written as strings.
- The helpers whose words or arithmetic matter: `note_html`, `after`, `following`, `record_data`,
  `pipeline_data`, `search_body`, `classify`, and `str.casefold()`, whose table the port carries.

The backend's HubSpot modules load no configuration, so they are imported as they are.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/hubspot/generate.py
"""

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLOUDFLARE = HERE.parents[3]
BACKEND = CLOUDFLARE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import httpx  # noqa: E402
from pydantic import BaseModel, ValidationError  # noqa: E402

from connectors.base import OperationError  # noqa: E402
from connectors.hubspot import client as hubspot_client  # noqa: E402
from connectors.hubspot import connector as hubspot_connector  # noqa: E402
from connectors.hubspot import reads, scope, writes  # noqa: E402


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def validation_message(error: ValidationError) -> str:
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


OPERATIONS = {op.name: op for op in hubspot_connector.HubSpotConnector.operations}

LONG_EMOJI = "\U0001f600" * 200
INPUTS = {
    "search_contacts": [
        {},
        None,
        {"query": " example.com "},
        {"query": ""},
        {"query": "a\tb"},
        {"query": "x" * 201},
        {"query": LONG_EMOJI},
        {"query": LONG_EMOJI + "\U0001f600"},
        {"query": None},
        {"email": "grace@example.com"},
        {"email": "  a@b.c  "},
        {"email": "ab"},
        {"email": "a\nb@c.d"},
        {"email": "x" * 255},
        {"email": None},
        {"company_id": "201"},
        {"company_id": " 201 "},
        {"company_id": "0101"},
        {"company_id": 201},
        {"company_id": "1" * 21},
        {"company_id": "\N{FULLWIDTH DIGIT ONE}\N{FULLWIDTH DIGIT ZERO}\N{FULLWIDTH DIGIT ONE}"},
        {"company_id": None},
        {"deal_id": "301", "limit": 50},
        {"limit": 0},
        {"limit": 51},
        {"limit": "10"},
        {"limit": 10.5},
        {"limit": True},
        {"limit": None},
        {"cursor": "abc"},
        {"cursor": "x" * 201},
        {"cursor": None},
        {"connection_id": "x"},
        {"query": 1, "email": 2, "company_id": 3, "deal_id": 4, "limit": "x", "cursor": 5},
    ],
    "get_contact": [
        {"contact_id": "101"},
        {"contact_id": " 101\n"},
        {"contact_id": "0101"},
        {"contact_id": "0"},
        {"contact_id": "12345678901234567890"},
        {"contact_id": ""},
        {},
        {"contact_id": None},
    ],
    "search_companies": [
        {},
        {"domain": "acme.example"},
        {"domain": "ab"},
        {"domain": "a\u0000b.example"},
        {"domain": None},
        {"contact_id": "101", "deal_id": "301"},
        {"query": "Acme", "limit": 1},
    ],
    "get_company": [{"company_id": "201"}, {"company_id": "x"}],
    "list_pipelines": [{}, {"x": 1}],
    "search_deals": [
        {},
        {"pipeline": "default"},
        {"pipeline": "200", "stage": "signed"},
        {"pipeline": "a b"},
        {"pipeline": "x" * 101},
        {"pipeline": "x" * 100},
        {"stage": "closedwon", "query": "Big"},
        {"stage": ""},
        {"contact_id": "101", "company_id": "201", "limit": 1, "cursor": "t"},
    ],
    "get_deal": [{"deal_id": "301"}, {"deal_id": "abc"}],
    "create_contact": [
        {"email": "new@example.com", "firstname": "Nia"},
        {},
        {"email": " x "},
        {"email": "a\tb"},
        {"email": "x", "firstname": "y" * 101},
        {"email": "x", "phone": "1" * 51},
        {"email": "x", "phone": None},
        {"email": "x", "company": "c", "jobtitle": "j", "lastname": "l"},
        {"email": "x", "contact_id": "101"},
    ],
    "update_contact": [
        {"contact_id": "101"},
        {"contact_id": "101", "jobtitle": "Analyst"},
        {"contact_id": "101", "email": "x"},
        {"contact_id": "101", "email": None, "phone": "1"},
        {"contact_id": "101", "email": None},
        {"contact_id": "101", "phone": "  "},
        {"contact_id": "0", "phone": "1"},
        {"contact_id": "0"},
    ],
    "create_deal": [
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1500.50"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1500"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "01500"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1,500"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1500.505"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1e3"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "-1"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "12345678901234"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1234567890123.45"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "12345678901234.5"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": ""},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": " 10 "},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": 10},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-12-31"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-2-1"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-02-30"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2024-02-29"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2100-02-29"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2000-02-29"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "0000-01-01"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "0001-01-01"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "9999-12-31"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "20261231"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-W01"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-12-31T00:00"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": "2026-13-01"},
        {"pipeline": "default", "stage": "qualified", "name": "New", "close_date": ""},
        {"pipeline": "default", "stage": "qualified", "name": "New", "contact_ids": ["101", "101"]},
        {"pipeline": "default", "stage": "qualified", "name": "New", "contact_ids": ["0"]},
        {"pipeline": "default", "stage": "qualified", "name": "New", "contact_ids": [str(i) for i in range(1, 12)]},
        {"pipeline": "default", "stage": "qualified", "name": "New", "contact_ids": [101]},
        {"pipeline": "default", "stage": "qualified", "name": "New", "contact_ids": None},
        {"pipeline": "default", "stage": "qualified", "name": "New", "company_ids": [" 201 "]},
        {"pipeline": "default", "stage": "qualified", "name": "New", "amount": None},
        {"pipeline": "default", "stage": "qualified"},
        {"name": "x" * 201},
    ],
    "update_deal": [
        {"deal_id": "301"},
        {"deal_id": "301", "stage": None},
        {"deal_id": "301", "stage": "closedwon", "amount": "10"},
        {"deal_id": "301", "name": "Renamed"},
        {"deal_id": "301", "name": ""},
        {"deal_id": "301", "close_date": "2026-12-31"},
        {"deal_id": "0301"},
        {"deal_id": "301", "pipeline": "200"},
    ],
    "add_note": [
        {"body": "hi"},
        {"contact_id": "101", "deal_id": "301", "body": "hi"},
        {"contact_id": "101", "body": "<b>Call</b>\nback"},
        {"contact_id": None, "deal_id": "301", "body": "x"},
        {"company_id": "201", "body": "a\u0000b"},
        {"company_id": "201", "body": "a\tb\r\nc"},
        {"deal_id": "301", "body": "x" * 5001},
        {"deal_id": "301", "body": "  \t "},
        {"deal_id": "301"},
        {"contact_id": "0101", "body": "x"},
    ],
}


def input_vectors() -> list:
    out = []
    for name, raws in INPUTS.items():
        op = OPERATIONS[name]
        for raw in raws:
            entry = {"op": name, "raw": raw}
            try:
                fields = op.input_model.model_validate(raw if raw is not None else {}).model_dump()
            except ValidationError as error:
                entry["message"] = validation_message(error)
            except Exception as error:  # noqa: BLE001
                # A validator that fails on a value it did not expect: the executor reports it as a failure.
                entry["raised"] = type(error).__name__
            else:
                entry["dump"] = fields
            out.append(entry)
    return out


def untitled(node):
    """A JSON Schema without Pydantic's titles, which zod does not write."""
    if isinstance(node, dict):
        return {k: untitled(v) for k, v in node.items() if k != "title"}
    if isinstance(node, list):
        return [untitled(v) for v in node]
    return node


def declaration() -> dict:
    """What the connector declares, every field with its default, as the port declares it."""
    connector = hubspot_connector.HubSpotConnector
    auth = connector.auth
    return {
        "slug": connector.slug,
        "name": connector.name,
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
            for kind in connector.kinds
        ],
        "actions": [{"id": action.id, "label": action.label, "requires": action.requires} for action in connector.actions],
        "auth": {
            "app": auth.app,
            "authorize_url": auth.authorize_url,
            "token_url": auth.token_url,
            "scopes": list(auth.scopes),
            "scope_separator": auth.scope_separator,
            "registration_url": auth.registration_url,
            "authorize_params": [list(pair) for pair in auth.authorize_params],
            "login_hint": auth.login_hint,
            "client_auth": auth.client_auth,
            "json_body": auth.json_body,
            "pkce": auth.pkce,
        },
        "browsable": sorted(connector.browsable),
        "manage_link": hubspot_connector.HubSpotConnector().manage_link(),
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
            for op in connector.operations
        ],
    }


def schema_vectors() -> list:
    return [[op.name, untitled(op.input_model.model_json_schema())] for op in OPERATIONS.values()]


def plain(value):
    """A model dump as JSON: integers as strings, so none is rounded on the way."""
    if isinstance(value, bool) or value is None or isinstance(value, str | float):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    raise TypeError(type(value))


MODELS = {
    "Details": hubspot_client.Details,
    "Record": hubspot_client.Record,
    "SearchPage": hubspot_client.SearchPage,
    "Batch": hubspot_client.Batch,
    "Pipeline": hubspot_client.Pipeline,
    "Pipelines": hubspot_client.Pipelines,
}

RESPONSES = {
    "Details": [
        '{"portalId": 4242, "portalName": "Acme Corp", "uiDomain": "app.hubspot.com"}',
        '{"portalId": 4242}',
        '{"portal_id": 4242, "portal_name": "Snake"}',
        '{"portalId": 1, "portal_id": 2}',
        '{"portalId": "4242"}',
        '{"portalId": " +4_242 "}',
        '{"portalId": "4242.0"}',
        '{"portalId": "4242.5"}',
        '{"portalId": 4242.0}',
        '{"portalId": 4242.5}',
        '{"portalId": true}',
        '{"portalId": "007"}',
        '{"portalId": "123456789012345678901234567890"}',
        '{"portalId": null}',
        '{"portalName": "x"}',
        '{"portalId": 1, "portalName": 5}',
        '{"portalId": 1, "portalName": null}',
        '{"portalId": 1, "portalName": ""}',
        '[]',
        '"x"',
        '{"portalId": "\\u00a01"}',
        '{"portalId": "1\\u001c"}',
        '{"portalId": "1__0"}',
        '{"portalId": "-0"}',
        '{"portalId": 1e3}',
    ],
    "Record": [
        '{"id": "101", "properties": {"email": "a@example.com", "phone": null}, "archived": false}',
        '{"id": "101"}',
        '{"id": 101}',
        '{"id": "101", "properties": {"n": 1}}',
        '{"id": "101", "properties": null}',
        '{"id": "101", "properties": {"__proto__": "x", "constructor": null}}',
        '{"id": "101", "archived": "yes"}',
        '{"id": "101", "archived": "Off"}',
        '{"id": "101", "archived": "f"}',
        '{"id": "101", "archived": "T"}',
        '{"id": "101", "archived": "y"}',
        '{"id": "101", "archived": "N"}',
        '{"id": "101", "archived": "no"}',
        '{"id": "101", "archived": "ON"}',
        '{"id": "101", "archived": "False"}',
        '{"id": "101", "archived": "1"}',
        '{"id": "101", "archived": "0"}',
        '{"id": "101", "archived": "01"}',
        '{"id": "101", "archived": "1.0"}',
        '{"id": "101", "archived": ""}',
        '{"id": "101", "archived": 1.0}',
        '{"id": "101", "archived": -0}',
        '{"id": "101", "archived": 0.5}',
        '{"id": "101", "archived": []}',
        '{"id": "101", "archived": 1}',
        '{"id": "101", "archived": 0.0}',
        '{"id": "101", "archived": 2}',
        '{"id": "101", "archived": " true"}',
        '{"id": "101", "archived": null}',
        '{"id": "101", "createdAt": "2026-01-01T00:00:00Z", "extra": [1, 2]}',
        '{"properties": {}}',
        # Pydantic's JSON parser refuses a lone surrogate escape anywhere; json.loads keeps it.
        '{"id": "101", "unused": "\\ud800"}',
        '{"id": "101", "properties": {"email": "\\udc00"}}',
        '{"id": "101", "properties": {"\\ud800x": "a"}}',
        '{"id": "101", "extra": ["\\ude00\\ud83d"]}',
        '{"id": "101", "properties": {"e": "\\ud83d\\ude00"}}',
    ],
    "SearchPage": [
        '{"total": 2, "results": [{"id": "1"}, {"id": "2"}], "paging": {"next": {"after": "2", "link": "x"}}}',
        '{}',
        '{"paging": null}',
        '{"paging": {}}',
        '{"paging": {"next": null}}',
        '{"paging": {"next": {}}}',
        '{"paging": {"next": {"after": 10}}}',
        '{"results": null}',
        '{"results": [1]}',
        '{"total": "x"}',
    ],
    "Batch": ['{"status": "COMPLETE", "results": [{"id": "301", "properties": {"pipeline": "default"}}]}', '{}', '{"results": {}}'],
    "Pipeline": [
        '{"id": "default", "label": "Sales", "displayOrder": 0, "archived": false, "stages": [{"id": "s", "label": "S", "displayOrder": 2, "metadata": {"probability": "0.5", "isClosed": "false"}}]}',
        '{"id": "default", "label": "Sales"}',
        '{"id": "default"}',
        '{"id": "default", "label": "Sales", "stages": [{"id": "s", "label": "S", "metadata": {"probability": 0.5}}]}',
        '{"id": "default", "label": "Sales", "display_order": "3", "stages": null}',
    ],
    "Pipelines": ['{"results": []}', '{}', '{"results": [{"id": "1", "label": "One", "displayOrder": "1"}]}'],
}


def response_vectors() -> list:
    out = []
    for name, texts in RESPONSES.items():
        model: type[BaseModel] = MODELS[name]
        for text in texts:
            entry = {"model": name, "text": text}
            try:
                entry["json_mode"] = plain(model.model_validate_json(text).model_dump())
            except ValidationError:
                entry["json_mode"] = None
            try:
                entry["python_mode"] = plain(model.model_validate(json.loads(text)).model_dump())
            except ValidationError:
                entry["python_mode"] = None
            out.append(entry)
    return out


NOTES = [
    '<a href="x">hi</a> & bye\r\nnext',
    "<b>Call</b>\nback",
    "it's \"quoted\"",
    "a\rb\r\n\r\nc\n",
    "&amp; already",
    "\U0001f600 <\N{LATIN SMALL LETTER E WITH ACUTE}>",
    "",
]

AFTER = [[None, 10], ["0", 10], ["9990", 10], ["9991", 10], ["010", 10], ["-1", 10], ["1e3", 10], ["abc", 10],
         ["100000", 10], ["99999", 1], ["9950", 50], ["9951", 50], ["", 10], ["1 ", 10], ["\N{FULLWIDTH DIGIT ONE}", 10]]

FOLLOWING = [
    [{}, 10],
    [{"paging": {"next": {"after": "10"}}}, 10],
    [{"paging": {"next": {"after": "9990"}}}, 10],
    [{"paging": {"next": {"after": "9995"}}}, 10],
    [{"paging": {"next": {"after": "abc"}}}, 10],
    [{"paging": {"next": {"after": "010"}}}, 10],
    [{"paging": {"next": {"after": "100000"}}}, 10],
    [{"paging": {}}, 10],
]


class FakeClient:
    def unexpected(self) -> OperationError:
        return OperationError("PROVIDER_FAILED", "HubSpot returned an unexpected response.")


def helper_vectors() -> dict:
    after = []
    for value, limit in AFTER:
        try:
            after.append([value, limit, scope.after(value, limit)])
        except OperationError as error:
            after.append([value, limit, {"code": error.code, "message": error.message}])
    following = []
    for page, limit in FOLLOWING:
        parsed = hubspot_client.SearchPage.model_validate(page)
        try:
            following.append([page, limit, list(scope.following(FakeClient(), parsed, limit))])
        except OperationError as error:
            following.append([page, limit, {"code": error.code, "message": error.message}])
    record = {
        "id": "301",
        "properties": {
            "dealname": "d" * 501,
            "description": "\U0001f600" * 2001,
            "amount": "9000",
            "pipeline": None,
            "unasked": "x",
        },
    }
    record_data = [
        {"record": record, "properties": names, "data": scope.record_data(hubspot_client.Record.model_validate(record), names)}
        for names in (scope.DEAL_PROPERTIES, ["description", "dealname"], [])
    ]
    pipeline = {
        "id": "default",
        "label": "Sales",
        "stages": [
            {"id": "b", "label": "B", "displayOrder": 2, "metadata": {"isClosed": "true", "probability": "1.0"}},
            {"id": "a", "label": "A", "displayOrder": 1, "metadata": {"isClosed": "True"}},
            {"id": "c", "label": "C", "displayOrder": 1, "archived": True},
            {"id": "d", "label": "D", "displayOrder": 1, "metadata": {"probability": None}},
            {"id": "e", "label": "E", "displayOrder": -1},
        ],
    }
    pipeline_data = [{"pipeline": pipeline, "data": reads.pipeline_data(hubspot_client.Pipeline.model_validate(pipeline))}]
    searches = [
        {"query": None, "filters": [], "properties": ["pipeline"], "sort": "hs_lastmodifieddate", "limit": 10, "after": None},
        {
            "query": "Big",
            "filters": [scope.equals("pipeline", "default"), scope.equals("dealstage", "won")],
            "properties": scope.CONTACT_PROPERTIES,
            "sort": "lastmodifieddate",
            "limit": 1,
            "after": "0",
        },
        {"query": "", "filters": [], "properties": [], "sort": "x", "limit": 50, "after": ""},
    ]
    bodies = [{"options": options, "body": scope.search_body(**options)} for options in searches]
    classified = []
    for status, body in [
        (403, {"status": "error", "category": "MISSING_SCOPES", "message": "SECRET"}),
        (403, {"category": "FORBIDDEN"}),
        (403, ["MISSING_SCOPES"]),
        (403, "not json"),
        (409, {"category": "CONFLICT"}),
        (409, "<html>"),
        (400, {"category": "MISSING_SCOPES"}),
        (401, {"category": "INVALID_AUTHENTICATION"}),
        (404, {"category": "OBJECT_NOT_FOUND"}),
    ]:
        content = body if isinstance(body, str) else json.dumps(body)
        error = hubspot_client.classify("HubSpot", httpx.Response(status, text=content))
        classified.append([status, content, None if error is None else {"code": error.code, "message": error.message}])
    return {
        "note_html": [[body, writes.note_html(body)] for body in NOTES],
        "after": after,
        "following": following,
        "record_data": record_data,
        "pipeline_data": pipeline_data,
        "search_body": bodies,
        "classify": classified,
    }


CASEFOLD = [
    "Stra\N{LATIN SMALL LETTER SHARP S}e",
    "PARTN",
    "\N{GREEK CAPITAL LETTER SIGMA}\N{GREEK SMALL LETTER IOTA WITH TONOS}\N{GREEK SMALL LETTER SIGMA}\N{GREEK SMALL LETTER FINAL SIGMA}",
    "\N{LATIN SMALL LIGATURE FI}ne",
    "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}stanbul",
    "\N{CHEROKEE LETTER A}\N{CHEROKEE LETTER E}",
    "\N{CHEROKEE SMALL LETTER A}",
    "\N{LATIN CAPITAL LETTER SHARP S}",
    "\N{LATIN SMALL LETTER LONG S}",
    "\N{KELVIN SIGN}",
    "\N{DESERET CAPITAL LETTER LONG I}",
    "\N{GREEK CAPITAL LETTER ALPHA WITH PSILI AND PROSGEGRAMMENI}",
    "\N{LATIN SMALL LETTER N PRECEDED BY APOSTROPHE}",
    "\N{MICRO SIGN}",
    "Deals in Partners",
]


def main() -> None:
    vectors = {
        "python": sys.version.split()[0],
        "scopes": list(hubspot_connector.SCOPES),
        "declaration": declaration(),
        "schemas": schema_vectors(),
        "inputs": input_vectors(),
        "responses": response_vectors(),
        **helper_vectors(),
        "casefold": [[text, text.casefold()] for text in CASEFOLD],
        # Every code point but the surrogates, each folded alone, as compact JSON with ASCII escapes.
        "casefold_all": sha256(
            json.dumps([chr(p).casefold() for p in range(0x110000) if not 0xD800 <= p <= 0xDFFF], separators=(",", ":"))
        ),
    }
    # One vector per line, so a change shows as the lines it changes.
    lines = ["{"]
    for index, (key, value) in enumerate(vectors.items()):
        comma = "," if index < len(vectors) - 1 else ""
        if isinstance(value, list) and value:
            items = ",\n".join(f"  {json.dumps(item, ensure_ascii=True, separators=(',', ':'))}" for item in value)
            lines.append(f" {json.dumps(key)}: [\n{items}\n ]{comma}")
        else:
            lines.append(f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=True, separators=(',', ':'))}{comma}")
    lines.append("}")
    (HERE / "vectors.json").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
