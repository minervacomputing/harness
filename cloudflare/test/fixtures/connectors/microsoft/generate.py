"""Writes vectors.json: what today's Python computes for the Microsoft connectors' shared parts, for their
port (src/connectors/microsoft/ and the four connectors):

- the four declarations (kinds, actions, auth, every operation's strings and terms, and the descriptions in
  each input field's JSON Schema), which the port must repeat verbatim;
- Graph's paging (`next_cursor`, `page_param`) and Teams' own, on links and cursors, fuzzed too;
- `classify` on Graph's error answers;
- `datetime.fromisoformat` and `date.fromisoformat` on generated text (the port follows CPython's C parser);
- `str.casefold()` on sample text.

Only connector modules are imported, which load no configuration. Run from cloudflare/:
cd ../backend && .venv/bin/python -I ../cloudflare/test/fixtures/connectors/microsoft/generate.py

The committed file keeps a sample of the random groups (LINKS_RANDOM, TEAMS_LINKS_RANDOM, ISO_RANDOM, CASEFOLD_RANDOM)
to stay under about 500 KB; add `--full` (after the script's path) for the whole set, about 0.6 MB, for a local run.
"""

import json
import random
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[3].parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

import httpx  # noqa: E402

from connectors import microsoft  # noqa: E402
from connectors.base import OAuth2, OperationError  # noqa: E402
from connectors.onedrive.connector import OneDriveConnector  # noqa: E402
from connectors.outlook.connector import OutlookConnector  # noqa: E402
from connectors.outlook_calendar.connector import OutlookCalendarConnector  # noqa: E402
from connectors.teams import client as teams_client  # noqa: E402
from connectors.teams.connector import TeamsConnector  # noqa: E402
from vector_size import compact, sample  # noqa: E402

random.seed(20261011)
LINKS_RANDOM = sample(400, 250)  # Graph paging links of random pieces
TEAMS_LINKS_RANDOM = sample(200, 100)  # the same for Teams
ISO_RANDOM = sample(3000, 1500)  # date-times and dates of random pieces
CASEFOLD_RANDOM = sample(300, 150)  # random text to casefold


def descriptions(schema) -> list[str]:
    found = []

    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get("description"), str):
                found.append(value["description"])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(schema)
    return sorted(set(found))


def declaration(connector) -> dict:
    auth = connector.auth
    assert isinstance(auth, OAuth2)
    operations = []
    for op in connector.operations:
        schema = op.input_model.model_json_schema()
        operations.append(
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "output_action": op.output_action,
                "consent": [sorted(option) for option in op.consent] if op.consent is not None else None,
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
                "offered": connector.offered(op),
                "fields": {name: descriptions(field) for name, field in schema.get("properties", {}).items()},
                "required": sorted(schema.get("required", [])),
            }
        )
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
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions],
        "auth": {
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
        "browsable": sorted(connector.browsable),
        "manage_link": connector.manage_link(),
        "operations": operations,
    }


def outcome(call):
    try:
        return {"value": call()}
    except OperationError as error:
        return {"error": error.code, "message": error.message}
    except ValueError as error:
        return {"error": "ValueError", "message": str(error)}
    except TypeError as error:
        return {"error": "TypeError"}


BASE = "https://graph.microsoft.com/v1.0/me/mailFolders/X/messages"
LINKS = [
    None, f"{BASE}?%24skiptoken=abc%3D%3D&%24top=5", f"{BASE}?$skip=40", "https://attacker.example/?$skip=40",
    f"{BASE}?$skip=40&$skiptoken=abc", f"{BASE}?$skip=1&$skip=2", f"{BASE}?$skip=-1", f"{BASE}?$skiptoken=a b",
    f"{BASE}?$skiptoken=" + "a" * 881, f"{BASE}?$skiptoken=" + "a" * 880, f"{BASE}?$top=5", BASE, 42, "x" * 4001,
    f"{BASE}?$skip=0", f"{BASE}?$skip=1234567", f"{BASE}?$skip=\u0663", f"{BASE}?$skip=%D9%A3", f"{BASE}?$skiptoken=a+b",
    f"{BASE}?$skiptoken=a%2Bb", f"{BASE}?$skiptoken=", f"{BASE}?$skiptoken", f"{BASE}?$skiptoken=a&$skiptoken=",
    f"{BASE}#?$skip=4", f"{BASE}?a=1#$skip=4", f"{BASE}?$skip=4#frag", "?$skip=7", "$skip=7", "//h/?$skip=7",
    "https://[::1]/?$skip=3", "https://[::1/?$skip=3", "https://::1]/?$skip=3", "https://[v1.x]/?$skip=3",
    "https://[1.2.3.4]/?$skip=3", "https://a[::1]/?$skip=3", "https://[::1]x/?$skip=3", "https://[::1]:80/?$skip=3",
    "https://u@[::1]/?$skip=3", "https://\u2100/?$skip=3", "https://ex\u00e4mple.com/?$skip=3", " \t https://x/?$skip=3",
    "https://x/?$sk\nip=3", "https://x/?$skip=3\r", "HTTPS://X/?$SKIP=3", "https://x/?%24skip=3", "https://x/?$skip%3D3",
    "mailto:a?$skip=3", "1http://x/?$skip=3", "ht tp://x/?$skip=3", "https://x/?$skiptoken=~._-%2F%3A%25",
    f"{BASE}?$skiptoken=" + "%41" * 880, "x" * 4000, "\U0001f600" * 1001 + "?$skip=1", "\U0001f600" * 999 + "?$skip=1",
]  # fmt: skip
CURSORS = [
    "skip:40", "token:abc==", "skip:x", "token:", "token:a&b", "page:1", "40", "skip:", "skip:1234567", "skip:123456",
    "skip:\u0663", "token:" + "a" * 880, "token:" + "a" * 881, "token:a:b", "skip:1:2", "", ":", "token:%2F~",
]  # fmt: skip
TEAMS_TOKEN = '{"page":2,"x":"a+b/c"}'
TEAMS_CURSORS = [
    "t:" + TEAMS_TOKEN, "token:abc", "t:", "t:a b", "t:" + "a" * 991, "t:" + "a" * 990, "t:\u00e9", "t:a\tb", None, "x",
    "t:t:abc",
]  # fmt: skip
TEAMS_LINKS = [
    None, "https://graph.microsoft.com/v1.0/x?$skip=2", "https://x/?$skiptoken=a%20b", 5,
    "https://graph.microsoft.com/v1.0/x?$skiptoken=" + "%7B%22page%22%3A2%7D", "https://x/?$skiptoken=a&$skiptoken=b",
    "https://x/?$skiptoken=" + "a" * 991, "https://x/?$skiptoken=" + "a" * 990, "https://x/?$skiptoken=%C3%A9", "x" * 4001,
    "https://x/?$skiptoken=a+b", "https://x/?$skiptoken=%2B", "https://[::1/?$skiptoken=a",
]  # fmt: skip


def fuzz_links(count: int) -> list[str]:
    pieces = ["$skip", "$skiptoken", "%24skip", "%24skiptoken", "=", "&", "?", "#", "+", "%20", "%2", "%41", "1", "40", "abc", "a b",
              "\u0663", "%D9%A3", ";", "/", ":", "[", "]", "@", "https://", "//", "x", "\t", "\n", "~", "%"]  # fmt: skip
    links = []
    while len(links) < count:
        text = "".join(random.choice(pieces) for _ in range(random.randint(1, 9)))
        prefix = random.choice(["https://graph.microsoft.com/v1.0/x?", "https://x/", "", "?", "//h?"])
        links.append(prefix + text)
    return links


def show(value: datetime) -> dict:
    offset = value.utcoffset()
    return {
        "v": [value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond],
        "o": None if offset is None else (offset.days * 86400 + offset.seconds) * 1_000_000 + offset.microseconds,
    }


def iso_cases(count: int) -> list[str]:
    bases = ["2026-10-01", "20261001", "2026-W40-1", "2026W401", "2026-W40", "2026W40", "0001-01-01", "9999-12-31", "2026-02-28",
             "2024-02-29", "2026-00-00", "2026-13-40"]  # fmt: skip
    seps = ["T", " ", "x", "\u00e9", "", "t", "\U0001f600", "\ud800", "\x00"]
    times = ["09", "00", ":", ".", ",", "5", "123456", "1234567", "24", "Z", "+", "-", "05", "30", "01", "1", "60", "99"]
    pieces = ["2026", "-", "10", "01", "T", ":", "09", "00", "30", ".", ",", "Z", "+", "W", "40", "1", "24", "5", "0", " ", "\u00e9",
              "\U0001f600", "\u0660", "\uff10", "\ud800", "\x00"]  # fmt: skip
    seen: list[str] = []
    while len(seen) < count:
        if random.random() < 0.6:
            text = random.choice(bases) + random.choice(seps) + "".join(random.choice(times) for _ in range(random.randint(0, 9)))
        else:
            text = "".join(random.choice(pieces) for _ in range(random.randint(1, 10)))
        # JSON cannot carry two lone surrogates side by side apart from the pair they make.
        if text not in seen and "\ud800\udfff" not in text:
            seen.append(text)
    return seen


def iso(text: str) -> dict:
    try:
        result = show(datetime.fromisoformat(text))
    except ValueError as error:
        result = {"e": str(error)}
    try:
        d = date.fromisoformat(text)
        day = [d.year, d.month, d.day]
    except ValueError as error:
        day = {"e": str(error)}
    return {"t": text, "dt": result, "d": day}


CLASSIFY = [
    (404, '{"error": {"code": "MailboxNotEnabledForRESTAPI"}}'),
    (404, '{"error": {"code": "MailboxNotSupportedForRESTAPI", "message": "x"}}'),
    (503, ""),
    (503, '{"error": {"code": "MailboxNotEnabledForRESTAPI"}}'),
    (404, '{"error": {"code": "ErrorItemNotFound"}}'),
    (400, "<html>"),
    (400, '["error"]'),
    (400, '{"error": "MailboxNotEnabledForRESTAPI"}'),
    (400, '{"error": {"code": 5}}'),
    (400, '{"error": null}'),
    (400, "null"),
    (500, '{"error": {"code": "MailboxNotEnabledForRESTAPI"}}'),
    (409, '{"error": {"code": "nameAlreadyExists"}}'),
]


def classified(status: int, body: str, onedrive: bool):
    response = httpx.Response(status, content=body.encode())
    if onedrive:
        from connectors.onedrive.client import _classify

        error = _classify("OneDrive", response)
    else:
        error = microsoft.classify("Outlook", response)
    return None if error is None else {"code": error.code, "message": error.message}


def casefold_samples() -> list[str]:
    samples = ["Große STRAẞE ΣΑΣ ﬁ İ", "inbox/PRO", "GRACE", "\u0130\u0131\u017f\u212a", "Ǆǅǆ", "ᏸᏹ", "\U00010400\U00010428"]
    for _ in range(CASEFOLD_RANDOM):
        samples.append("".join(chr(random.choice([random.randint(0x20, 0x24F), random.randint(0x370, 0x58F), random.randint(0x1E00, 0x1FFF),
                                                      random.randint(0x2C00, 0x2E7F), random.randint(0xA640, 0xA7FF), random.randint(0xFB00, 0xFB4F),
                                                      random.randint(0x10400, 0x1044F), random.randint(0x13A0, 0x13FF), random.randint(0xAB70, 0xABBF)]))
                               for _ in range(12)))  # fmt: skip
    return [s for s in samples if not any(0xD800 <= ord(c) <= 0xDFFF for c in s)]


def main() -> None:
    links = [*LINKS, *fuzz_links(LINKS_RANDOM)]
    vectors = {
        "declarations": [declaration(c()) for c in (OutlookConnector, OutlookCalendarConnector, OneDriveConnector, TeamsConnector)],
        "next_cursor": [{"link": link, **outcome(lambda link=link: microsoft.next_cursor(link))} for link in links],
        "page_param": [{"cursor": c, **outcome(lambda c=c: microsoft.page_param(c))} for c in CURSORS],
        "teams_page_params": [{"cursor": c, **outcome(lambda c=c: teams_client.page_params(c))} for c in TEAMS_CURSORS],
        "teams_next_cursor": [
            {"link": link, **outcome(lambda link=link: teams_client.next_cursor(link))} for link in [*TEAMS_LINKS, *fuzz_links(TEAMS_LINKS_RANDOM)]
        ],
        "classify": [
            {"status": status, "body": body, "outlook": classified(status, body, False), "onedrive": classified(status, body, True)}
            for status, body in CLASSIFY
        ],
        "isoformat": [iso(text) for text in iso_cases(ISO_RANDOM)],
        "casefold": [[sample, sample.casefold()] for sample in casefold_samples()],
    }
    (HERE / "vectors.json").write_text(json.dumps(compact(vectors), ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
