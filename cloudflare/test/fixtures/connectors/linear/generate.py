"""Writes vectors.json and casefold.json: what today's Linear connector computes, for the port's tests.

Covers the text rules (redact, check_written, issue_links), team and issue names, due dates, the judge of
writes, the mapping of GraphQL errors (`classify`, whose `error_for` reads use too), the validation of every
operation's input (the normalized dump or the message the model sees), how the response models read bools
and floats (Pydantic's lax mode), and str.casefold. The connector modules are pure: nothing that loads
Django configuration is imported.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/linear/generate.py
"""

import json
import math
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.linear import client, markdown, teams, writes  # noqa: E402
from connectors.linear.client import classify, judge  # noqa: E402
from connectors.linear.connector import LinearConnector  # noqa: E402

SECRET = "Secret ops thing"
UPPER_UUID = "0000000A-0000-4000-8000-00000000000B"

REDACT = [
    f"[{SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing) and "
    "https://linear.app/Acme/issue/ops-2/other-title, "
    "https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f/overview, "
    "linear.app/acme/view/hush-hush, https://linear.app/acme, "
    "![shot](https://uploads.linear.app/a/b.png), "
    f"[\\[SEC\\] {SECRET} \\[x\\]](https://linear.app/acme/issue/OPS-1/x), "
    f"[[{SECRET}]](https://linear.app/acme/issue/OPS-1 'tip'), "
    f"![{SECRET}](https://linear.app/acme/issue/OPS-1 ({SECRET})), "
    f'[{SECRET}](https://linear.app/acme/issue/OPS-1 "a \\"quote\\"")',
    "https://linear.app/acme/issue/ENG-12/some-title.",
    "see linear.app/acme/issue/eng-12/title, and",
    "xlinear.app/acme/issue/ENG-1/secret",
    "\u00e9linear.app/acme/issue/ENG-1/secret",
    "\u0301linear.app/acme/issue/ENG-1/secret",
    "\U0001f600linear.app/acme/issue/ENG-1/secret",
    "\u2160linear.app/acme/issue/ENG-1/secret",
    "LINEAR.APP/ACME/ISSUE/ENG-1/SECRET",
    "l\u0131near.app/acme/issue/ENG-1/secret",
    "l\u0130near.app/acme/issue/ENG-1/secret",
    "http\u017f://linear.app/acme/issue/ENG-1/x",
    "https://linear.app/acme/\u0130ssue/ENG-1/x",
    "https://linear.app/acme/issue/ENG-\u0661\u0662/x",
    "https://linear.app/\u212a/issue/ENG-1/x",
    "https://linear.app/acme/project/name-0A1B2C3D4E5F/x",
    "https://linear.app/acme/project/short-0a1b/x",
    "https://linear.app/acme/document/doc-name-abcdef0123",
    "https://linear.app/acme/issue/ENG-1/title\u0085more",
    "https://linear.app/acme/issue/ENG-1/title\ufeffmore",
    "https://linear.app/acme/issue/ENG-1/title\u001cmore",
    "https://linear.app/acme/issue/ENG-1/title\u3000more",
    f'[label](https://linear.app/acme/issue/OPS-1/secret "{SECRET}")',
    "[label](<https://linear.app/acme/issue/OPS-1/secret>)",
    "![img](linear.app/acme/view/secret-view)",
    "[a [b] c](https://linear.app/acme/issue/OPS-1/s)",
    "[a\\]b](https://linear.app/acme/issue/OPS-1/s)",
    "[a\\\rb](https://linear.app/acme/issue/OPS-1/s)",
    "[x]( https://linear.app/acme/issue/OPS-1 )",
    "[x](\u0085https://linear.app/acme/issue/OPS-1\u0085)",
    "[lab\nel](https://linear.app/acme/issue/OPS-1/secret)",
    "[[x](https://linear.app/acme/issue/OPS-1/s)](https://linear.app/acme/issue/OPS-2/t)",
    "[x](https://linear.app/acme/issue/OPS-1/s (paren title))",
    "[x](https://linear.app/acme/issue/OPS-1/s 'single \\' quote')",
    "https://linear.app/acme/issue/ENG-1/x/y/z?q=1#frag",
    "(https://linear.app/acme/issue/ENG-1/x)",
    "<https://linear.app/acme/issue/ENG-1/x>",
    "https://linear.app/acme https://linear.app/acme. https://linear.app/ linear.app",
    "foo@linear.app/acme/issue/ENG-1/x a.linear.app/acme/x -linear.app/acme/x _linear.app/acme/x",
    "https://linear.app/acme/issue/ENG-1/x!!! https://linear.app/acme/issue/ENG-1/x...?",
    "https://linear.app/acme/team/ENG/all https://linear.app/acme/issue/ENG-1",
    "https://linear.app/acme/issue/eng-1x/x https://linear.app/acme/issue/ENGINEERING1-1/x",
    "https://linear.app/acme/issue/ENG-1234567890/x https://linear.app/acme/issue/ENG-123456789/x",
    "https://linear.app/acme/issue/E\u0131G-1/x https://linear.app/acme/issue/ENG-1/x`y",
    "https://linear.app/acme/view/x-\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668",
    "Plain text without links, \u00fcber alles.",
    "",
]

WRITTEN = [
    # test_written_text_may_only_add_words
    "![x](https://evil.example/p.png)",
    "<img src=https://evil.example/p.png>",
    '<a href="https://evil.example">x</a>',
    "<iframe>",
    "https://linear.app/acme/project/roadmap-0a1b2c3d4e5f",
    "linear.app/acme/issue/ENG-1",
    "https://linear.app/acme/issue/ENG-1.evil",
    "[x](https://linear.app/acme/issue/ENG-1/../../issue/OPS-1)",
    "[x](https://linear.app/acme/issue/ENG-1/x_/../../OPS-1)",
    "[x](https://linear.app/acme/issue/ENG-1'/../OPS-1)",
    "https://linear.app/acme/issue/ENG-1)/../OPS-1",
    "https://linear.app/acme/issue/ENG-1\\)/../OPS-1",
    "https://linear.app/acme/issue/ENG-1/%2e%2e",
    "https://linear.app/acme/issue/ENG-1?x=1",
    "https://linear.app/acme/issue/ENG-1#top",
    "[x](https://linear%2eapp/acme/issue/OPS-1)",
    "[x](https://linear&#46;app/acme/issue/OPS-1)",
    "[x](https://linear\\.app/acme/issue/OPS-1)",
    "[x](https://linear\u3002app/acme/issue/OPS-1)",
    "[x](https://\uff4c\uff49\uff4e\uff45\uff41\uff52.app/acme/issue/OPS-1)",
    "[x](https://linear\u200b.app/acme/issue/OPS-1)",
    "https://linear.app/acme/settings/api",
    "[ENG-1](https://linear.app/acme/team/ENG)",
    "nul\x00",
    " ".join(f"https://linear.app/acme/issue/ENG-{n}" for n in range(1, 12)),
    # test_written_text_allows_markdown_uploads_and_issue_links
    "Plain **markdown** with [a link](https://example.com), <br>, "
    "![shot](https://uploads.linear.app/a/b.png), [docs](https://linear.app/Acme/issue/eng-2/write-docs) "
    "and https://linear.app/acme/issue/ENG-2. (https://linear.app/acme/issue/ENG-2), 100% sure, "
    "**https://linear.app/acme/issue/ENG-2**, <https://linear.app/acme/issue/ENG-2/>",
    # Python's re semantics
    "l\u0131near.app/acme/issue/ENG-1",
    "https://l\u0131near.app/acme/issue/ENG-1",
    "https://linear.app/acme/\u0130ssue/ENG-1",
    "https://linear.app/acme/issue/ENG-\u0661",
    "HTTPS://LINEAR.APP/ACME/ISSUE/ENG-1",
    "http\u017f://linear.app/acme/issue/ENG-1",
    "https://linear.app/\u212acme/issue/\u212a-1",
    "https://linear.app/acme/issue/ENG-1\u0085x",
    "https://linear.app/acme/issue/ENG-1\ufeffx",
    "https://linear.app/acme/issue/ENG-1\u3000x",
    "https://linear.app/acme/issue/ENG-1\u001cx",
    "<IMG src=x>",
    "<LIN\u212a rel=x>",
    "<a data-x=1>",
    "<a xhref=1>",
    "<a \u00e9href=1>",
    "<a \u0301href=1>",
    "<a \u017frc=1>",
    "<a act\u0130on=1>",
    "<a bac\u212aground=1>",
    "<a SRC =x>",
    "<a\u0085src=x>",
    "< img>",
    "</iframe>",
    "<b>bold</b> <br/> <p class=x>",
    '![x](https://uploads.linear.app/a.png "t")',
    "![x](https://uploads.linear.app/a.png 't')",
    "![x](HTTPS://uploads.linear.app/a.png)",
    "![x](https://uploads.linear.app/a.png)linear.app",
    "https://linear.app/acme/issue/ENG-1/Title-Here",
    "https://linear.app/acme/issue/ENG-1/title_with_underscore",
    "https://linear.app/acme/issue/ENG-1/ https://linear.app/acme/issue/ENG-1//",
    "*https://linear.app/acme/issue/ENG-1* _https://linear.app/acme/issue/ENG-1_",
    "http://\nlinear.app/acme/issue/ENG-1",
    "xhttps://linear.app/acme/issue/ENG-1",
    "\U0001f600https://linear.app/acme/issue/ENG-1 \U0001f600",
    "https://linear.app/acme/issue/ENG-1&#47;x",
    "https://linear.app/acme/issue/ENG-1%2Fx",
    "https://linear.app/acme/issue/ENG-1 linear&#46;app",
    " ".join(f"https://linear.app/acme/issue/ENG-{n}" for n in range(1, 11)),
    "https://linear.app/acme/issue/ENG-2 https://linear.app/Acme/issue/eng-2 https://linear.app/beta/issue/OPS-1",
    "\ttabs\nand\r\nnewlines",
    "\x7f",
    "\x0b",
    "\u00e9t\u00e9 \u2014 caf\u00e9",
]

TEAM_NAMES = ["eng", "ENG", "Eng1", "ENGINEERIN", "ENGINEERING", "\u00df", "\u00df" * 5, "\u00df" * 6, "\u0131nc",
              "\u017f", "\ufb01", "E-NG", "\u0130", UPPER_UUID, "00000000-0000-4000-8000-00000000000g",
              "00000000-0000-4000-8000-000000000001", "\u212a"]  # fmt: skip
ISSUE_NAMES = ["eng-1", "ENG-123456789", "ENG-1234567890", "ENGINEERIN-1", "ENGINEERING-1", "eng-\u0661\u0662",
               "e1", "ENG_1", "\u00df-1", "\u0131-1", UPPER_UUID, "-1", "E-"]  # fmt: skip
DATES = ["2026-10-01", "20261001", "2026-W40", "2026W40", "2026-W40-1", "2026W401", "2026-W53", "2027-W53",
         "2026-02-29", "2024-02-29", "0000-01-01", "0001-01-01", "9999-12-31", "9999-W52-6", "2026-13-01",
         "2026-10-00", "2026-10-32", "2026-W00", "2026-W40-0", "2026-W40-8", "2026-10", "2026", "10/10/2026",
         "2026/10/01", "2026-\u0661\u0660-01", "2026100199", "20261001xx", "2026W401xx", "20261001\u00e9",
         "2026W40\u00e9", "2026-W40xx", "2026W40-1", "2026-1001", "202610-01", "2026-w40", "", "1900-02-29",
         "2000-02-29", "2026-04-31", "2025-W01-1", "2004-W53-6", "20261001\x00\x00"]  # fmt: skip

ERROR = {"message": "x", "extensions": {"type": "internal error"}}
MALFORMED = {"message": "x", "extensions": {"type": "graphql error", "code": "GRAPHQL_VALIDATION_FAILED"}}
LIMITED = {"message": "x", "extensions": {"type": "Ratelimited", "code": "RATELIMITED"}}
JUDGED = [
    (200, {"data": {"issueCreate": {"success": True}}}),
    (400, {"errors": [MALFORMED]}),
    (400, {"data": None, "errors": [LIMITED]}),
    (400, {"errors": [ERROR]}),
    (200, {"data": None, "errors": [MALFORMED]}),
    (200, {"data": None, "errors": [ERROR]}),
    (200, {"data": {"issueCreate": {"success": False}}}),
    (200, "<html>"),
    (502, "<html>"),
    (200, []),
    (500, []),
    (200, {"errors": []}),
    (400, {"errors": [{"extensions": {"type": "AUTHENTICATION ERROR"}}]}),
    (400, {"errors": [{"extensions": {"type": "Ratelimited"}}, {"extensions": {"type": "internal"}}]}),
    (400, {"errors": ["x"]}),
    (400, {"errors": [{"extensions": {"code": "graphql_parse_failed"}}]}),
    (400, {"data": {}, "errors": [{"extensions": {"code": "GRAPHQL_PARSE_FAILED"}}]}),
    (200, {"data": {"a": {"success": 1}}}),
    (200, {"data": {"a": {"success": True}}, "errors": [{}]}),
    (200, {"data": {"a": [{"success": True}], "b": {"success": True}}}),
    (200, {"data": {"__proto__": {"success": True}}}),
    (429, {"errors": [LIMITED]}),
    (409, "not json"),
    (200, "\ufeff" + json.dumps({"data": {"a": {"success": True}}})),
    (200, '{"data": {"a": {"success": true}}}  \n'),
    (200, '{"data": {"a": {"success": true}}} x'),
]

# Bodies that are not UTF-8, or not quite: `response.json()` reads bytes.
CONFIRMED = b'{"data": {"a": {"success": true}}, "x": "'
FORBIDDEN = b'{"errors": [{"extensions": {"type": "forbidden"}}], "x": "'
RAW = [
    (200, CONFIRMED + b'\xff"}'),
    (400, CONFIRMED + b'\xff"}'),
    (200, CONFIRMED + b'\xef\xbf\xbd"}'),
    (200, CONFIRMED + b'\xc3"}'),
    (200, b"\xef\xbb\xbf" + CONFIRMED + b'"}'),
    (200, b"\xef\xbb\xbf\xef\xbb\xbf" + CONFIRMED + b'"}'),
    (400, FORBIDDEN + b'\xff"}'),
    (400, FORBIDDEN + b'\xef\xbf\xbd"}'),
    (403, FORBIDDEN + b'\xed\xa0\x80"}'),
    # What json.loads reads beyond UTF-8 JSON: the write may have run, so it is unknown, not refused.
    (400, b'{"data":null,"errors":[{"extensions":{"type":"internal error"}}],"x":NaN}'),
    (400, b'{"data":null,"errors":[{"extensions":{"type":"internal error"}}],"x":"\xed\xa0\x80"}'),
    (400, '{"data":null,"errors":[{"extensions":{"type":"internal error"}}]}'.encode("utf-16")),
    (400, '{"data":null,"errors":[{"extensions":{"type":"internal error"}}]}'.encode("utf-16-be")),
    (400, '{"data":null,"errors":[{"extensions":{"type":"internal error"}}]}'.encode("utf-32-le")),
    (200, '{"data":{"a":{"success":true}}}'.encode("utf-32")),
    (400, b'{"errors":[{"message":1e400,"extensions":{"type":"ratelimited"}}]}'),
    (400, b'{"errors":[{"message":-Infinity},{"message":"Not found"}]}'),
    (400, b'{"errors":[{"message":NaN,"extensions":{"type":"user error"}}]}'),
    (400, b'{"errors":[{"message":null,"extensions":{"type":"user error"}}]}'),
    (400, b'{"errors":[{"message":"x","extensions":{"type":"user error"}}],"y":-NaN}'),
]

# Bodies for json.loads itself: encodings, surrogates and the float constants.
LOADS = [
    b'{"a": NaN}', b'{"a": -Infinity, "b": Infinity}', b'{"a": -NaN}', b'{"a": - Infinity}', b'[NaNx]', b'[1NaN]',
    b'{"a": "NaN"}', b'{"a": "x\\"NaN"}', b'{"a\\\\": "Infinity"}', b'[1e400]', b'"\xed\xa0\x80"', b'"\xed\xb0\x80"',
    b'"\xed\x9f\xbf"', b'"\xf0\x9f\x98\x80"', b'"\xf4\x8f\xbf\xbf"', b'"\xf4\x90\x80\x80"', b'"\xc0\x80"',
    b'"\xe0\x80\xaf"', b'"\xf0\x80\x80\xaf"', b'"\xed\xa0"', b'"\xc3"', b'"\xff"',
    '{"a": "é\U0001f600"}'.encode("utf-16-le"), '{"a": "é"}'.encode("utf-16-be"),
    '{"a": "é"}'.encode("utf-16"), '{"a": "é"}'.encode("utf-32"), '{"a": 1}'.encode("utf-32-le"),
    '{"a": "\U0001f600"}'.encode("utf-32-be"), b'\xff\xfe{\x00', b'{\x00"\x00', b'1\x00', b'\x001', b'1', b'',
    b'\xef\xbb\xbf\xef\xbb\xbf1', b'\xef\xbb\xbf1', b'\xff\xfe\x00\xd8"\x00', b'\xff\xfe"\x00\x00\xd8"\x00',
    b'"\x00\x00\xd8"\x00', b'\x00\x00\x00\x00', b'\xff\xfe\x00\x00"\x00\x00\x00\x00\x00\x11\x00"\x00\x00\x00',
    b'"\x00\x00\x00\x00\xd8\x00\x00"\x00\x00\x00', b'1\x00\x00\x00\x00', b'{"a": [1, 2', b' \t\n1\r ',
]  # fmt: skip

ERRORS = [
    [{"message": "Entity not found", "extensions": {"type": "invalid input"}}],
    [{"extensions": {"type": "Forbidden"}}],
    [{"extensions": {"type": "feature not accessible"}}],
    [{"extensions": {"code": "ratelimited"}}],
    [{"extensions": {"type": "authentication error"}}],
    [{"message": "Not Found"}],
    [{"message": ["not found"]}],
    [{"message": {"not found": 1}}],
    [{"message": None}],
    [{"message": "x", "extensions": {"type": "user error"}}],
    [{"extensions": {"type": "graphql error"}}],
    [{}],
    ["x"],
    [{"extensions": "x"}],
    [{"extensions": {"type": 5}}],
    [{"extensions": {"type": "forbidden"}}, {"extensions": {"type": "ratelimited"}}],
    [{"message": "Not found"}, {"extensions": {"type": "forbidden"}}],
    [{"message": "nOt FoUnD here"}],
    [{"message": "not\nfound"}],
    [{"message": ["not\nfound"]}],
    [{"message": 404}],
    [{"message": True}, {"message": "Not", "extensions": {"type": "x"}}],
    [{"message": "Not"}, {"message": "found"}],
]

# Values Linear could send where the response models want a bool or a float (Pydantic's lax mode).
LAX_BOOLS = [True, False, 1, 0, 1.0, 0.0, 2, -1, 0.5, "true", "TRUE", "tRuE", "True", " true", "yes", "on", "ON",
             "1", "0", "t", "y", "n", "f", "off", "no", "1.0", "", "ı", "ſ", None, [], {}]  # fmt: skip
LAX_FLOATS = [1, -2, 1.5, True, False, "1.5", " 1.5 ", " 1.5", " 1.5", "1.5\u0085", "1.5﻿", "1.5​",
              "1.5\x1c", "1_000", "1__0", "_1", "1_", "1_.5", "1._5", "+_1", "1_e5", "1e1_0", "1e3", ".5", "5.", "+1",
              "00012", "-.5e-2", "1E5", "1e", "e1", ".", "- 1", "+-1", "1.5.5", "0x10", "", "١", "¹", "inf",
              "nan", "Infinity", None, [], {}]  # fmt: skip

# Responses read by name or alias (`populate_by_name`); the alias wins where both are given.
MODELS = [
    ("PageInfo", {"has_next_page": True, "end_cursor": "c1"}),
    ("PageInfo", {"has_next_page": True, "hasNextPage": False, "endCursor": "c2", "end_cursor": "c3"}),
    ("PageInfo", {"hasNextPage": "yes", "extra": 1}),
    ("Comment", {"id": "c", "body": "x", "hide_in_linear": True, "bot_actor": {"name": "Bot"}, "created_at": "t"}),
    ("Comment", {"id": "c", "hideInLinear": False, "hide_in_linear": True}),
    ("Comment", {"id": "c", "body": None}),
    ("Comment", {"id": "c", "parent": {"id": "p", "parent": {"id": "q"}}}),
    ("Label", {"id": "l", "name": "Area", "is_group": True, "parent": None}),
    ("Person", {"id": "p", "name": "Ada", "display_name": "ada", "active": 0}),
    ("Organization", {"name": "Acme", "url_key": "acme"}),
    ("Organization", {"name": "Acme"}),
    ("IssueSummary", {"id": "i", "identifier": "ENG-1", "title": "t", "priority_label": "High", "due_date": "d",
                      "updated_at": "u", "team": {"id": "t"}}),
    ("IssueSummary", {"id": "i", "identifier": "ENG-1", "title": 5, "team": {"id": "t"}}),
    ("Team", {"id": "t", "key": "ENG", "name": "Eng", "private": "false", "parent": {"id": "p"}}),
]  # fmt: skip

LONG = "x" * 201
INPUTS = {
    "list_teams": [{}, {"limit": 0}, {"limit": 101}, {"limit": "5"}, {"limit": True}, {"limit": 2.5},
                   {"cursor": "  c  "}, {"cursor": "x" * 501}, {"cursor": None}, {"cursor": ""},
                   {"connection_id": "x"}, None, []],  # fmt: skip
    "get_team": [{}, {"team": "eng"}, {"team": "  web "}, {"team": "e n g"}, {"team": UPPER_UUID},
                 {"team": "x" * 37}, {"team": ""}, {"team": "   "}, {"team": 5}, {"team": "\u00df\u00df"},
                 {"team": None}],  # fmt: skip
    "list_issues": [{"team": "eng"}, {"team": "eng", "state": "done"}, {"team": "eng", "assigned_to_me": "true"},
                    {"team": "eng", "limit": 51}, {"team": "eng", "state": "closed", "assigned_to_me": True,
                    "limit": 3, "cursor": " t "}, {"state": "x", "limit": 0, "zz": 1}],  # fmt: skip
    "search_issues": [{"team": "eng", "query": "a\nb"}, {"team": "eng", "query": "  plan  "},
                      {"team": "eng", "query": ""}, {"team": "eng", "query": LONG}, {"team": "eng"},
                      {"team": "eng", "query": "a\tb"}, {"team": "eng", "query": "a\u0085b c"},
                      {"team": "eng", "query": "x", "state": "open"}],  # fmt: skip
    "get_issue": [{"issue": "eng-1"}, {"issue": "eng"}, {"issue": UPPER_UUID}, {"issue": " web-1 "},
                  {"issue": "eng-\u0661"}, {}],  # fmt: skip
    "create_issue": [
        {"team": "eng", "title": "New thing", "description": "Follows https://linear.app/acme/issue/ENG-2/write-docs",
         "state": "todo", "priority": 2, "labels": ["bug", "area/frontend", "Urgent"], "assignee": "Me",
         "due_date": "2026-10-10"},
        {"team": "ENG", "title": "two\nlines"},
        {"team": "ENG", "title": "x", "priority": 5},
        {"team": "ENG", "title": "x", "priority": True},
        {"team": "ENG", "title": "x", "due_date": "10/10/2026"},
        {"team": "ENG", "title": "x", "due_date": " 20261001 "},
        {"team": "ENG", "title": "x", "due_date": "2026W401"},
        {"team": "ENG", "title": "x", "labels": []},
        {"team": "ENG", "title": "x", "labels": ["a"] * 11},
        {"team": "ENG", "title": "x", "labels": ["a\nb", LONG]},
        {"team": "ENG", "title": "x", "description": "See https://linear.app/acme/project/x-0a1b2c3d4e5f"},
        {"team": "ENG", "title": "x", "description": ""},
        {"team": "ENG", "title": "x", "description": "   "},
        {"team": "ENG", "title": "x", "description": "x" * 50001},
        {"team": "ENG", "title": "x", "description": "<img>" + "x" * 50000},
        {"team": "ENG", "title": "a\nb" + "x" * 300, "labels": ["a\nb" + "x" * 300]},
        {"team": "ENG", "title": "x", "due_date": "10/10/20260"},
        {"team": "x" * 37, "title": "x"},
        {"team": "ß" * 6, "title": "x"},
        {"team": "ENG", "title": "x", "assignee": ""},
        {"team": "ENG", "title": "x" * 256},
        {"team": "ENG", "title": "\U0001f600" * 255},
        {"team": "ENG", "title": "x", "state": None, "labels": None},
        {"team": "", "title": "", "priority": 9, "due_date": "x", "labels": [], "extra": 1},
    ],
    "add_comment": [
        {"issue": "ENG-1", "body": "Thanks"},
        {"issue": "ENG-1", "body": "x", "reply_to": "c1"},
        {"issue": "ENG-1", "body": "x", "reply_to": UPPER_UUID},
        {"issue": "ENG-1", "body": "x", "reply_to": ""},
        {"issue": "ENG-1", "body": "<img src=x>"},
        {"issue": "ENG-1", "body": "x" * 20001},
        {"issue": "ENG-1", "body": "<img>" + "x" * 20000, "reply_to": "x" * 37},
        {"issue": "ENG-1", "body": "cc https://linear.app/acme/issue/OPS-2"},
        {"issue": "ENG-1"},
    ],
    "update_issue": [
        {"issue": "ENG-2", "title": "Write better docs", "priority": 1, "add_labels": ["Bug"],
         "remove_labels": ["Frontend"], "unassign": True, "clear_due_date": True},
        {"issue": "ENG-1"},
        {"issue": "ENG-1", "assignee": "grace", "unassign": True},
        {"issue": "ENG-1", "due_date": "2026-10-10", "clear_due_date": True},
        {"issue": "ENG-1", "add_labels": ["Bug"], "remove_labels": ["bug"]},
        {"issue": "ENG-1", "add_labels": ["Stra\u00dfe"], "remove_labels": ["STRASSE"]},
        {"issue": "ENG-1", "unassign": True},
        {"issue": "ENG-1", "clear_due_date": True},
        {"issue": "ENG-1", "title": "x", "priority": 5},
        {"issue": "bad name"},
        {"issue": "ENG-1", "title": None, "description": None},
        {"issue": "ENG-1", "unassign": False},
        {"issue": "ENG-1", "due_date": "2026W401"},
        {"issue": "ENG-1", "state": "In progress"},
        {"issue": "ENG-1", "description": "![x](https://evil.example/p.png)", "assignee": "a", "unassign": True},
    ],
}  # fmt: skip


def validation_message(error: ValidationError) -> str:
    """connectors/executor.py's, restated: that module loads Django's models."""
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


def check(fn, value):
    try:
        return {"ok": fn(value)}
    except ValueError as error:
        return {"error": str(error)}


def judged(status, body):
    if isinstance(body, str):
        response = httpx.Response(status, content=body.encode())
        shown = body
    else:
        response = httpx.Response(status, json=body)
        shown = json.dumps(body)
    effect = judge(response)
    return {"status": status, "body": shown, "effect": None if effect is None else str(effect)}


def raw(status, body):
    """`judge` and `classify` on a body given as bytes (hex)."""
    effect = judge(httpx.Response(status, content=body))
    named = classify("Linear", httpx.Response(status, content=body))
    return {
        "status": status,
        "hex": body.hex(),
        "effect": None if effect is None else str(effect),
        "code": None if named is None else named.code,
    }


def floats_as_none(value):
    """A loaded value with its non-finite floats as None, as the port reads NaN and Infinity for `judge`."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, list):
        return [floats_as_none(item) for item in value]
    if isinstance(value, dict):
        return {key: floats_as_none(item) for key, item in value.items()}
    return value


def loaded(body):
    """The value as JSON text, since a lone surrogate's escape in vectors.json would stop Vite's JSON import."""
    try:
        return {"hex": body.hex(), "json": json.dumps(floats_as_none(json.loads(body)))}
    except ValueError:
        return {"hex": body.hex(), "error": True}


def read_model(name, value):
    """A response model's reading of `value`, by alias, or that it is refused."""
    try:
        read = getattr(client, name).model_validate(value)
    except ValidationError:
        return {"model": name, "value": value, "refused": True}
    return {"model": name, "value": value, "read": read.model_dump(by_alias=True)}


def classified(errors):
    """The code `classify` names for a failed response with these GraphQL errors, as reads use them too."""
    named = classify("Linear", httpx.Response(400, json={"errors": errors}))
    return None if named is None else named.code


def validated(op, raw):
    try:
        data = op.input_model.model_validate(raw if raw is not None else {})
    except ValidationError as error:
        return {"json": json.dumps(raw), "message": validation_message(error)}
    return {"json": json.dumps(raw), "data": data.model_dump()}


class Estimate(client.Model):
    """The response models' config with `Issue.estimate` alone."""

    estimate: float | None = None


def lax(model, attribute, value):
    """What a response model makes of `value` as Linear names the field: its value, or a non-finite float's
    repr, or that it is refused."""
    try:
        read = getattr(model.model_validate({model.model_fields[attribute].alias: value}), attribute)
    except ValidationError:
        return {"value": value, "refused": True}
    if isinstance(read, float) and not math.isfinite(read):
        return {"value": value, "ok": repr(read)}
    return {"value": value, "ok": read}


def described(schema):
    """Each field's description and default, as Pydantic's JSON Schema shows them (inside `anyOf` for an
    optional field), and the required fields: what the model is told beyond the types."""
    fields = {}
    for name, prop in schema["properties"].items():
        options = [prop, *prop.get("anyOf", []), *[item.get("items", {}) for item in prop.get("anyOf", [])]]
        description = next((option["description"] for option in options if "description" in option), None)
        fields[name] = {"description": description, **({"default": prop["default"]} if "default" in prop else {})}
    return {"fields": fields, "required": schema.get("required", [])}


def declaration(connector):
    """The connector's declaration, every flag and every model- and user-facing string."""
    auth = connector.auth
    return {
        "slug": connector.slug,
        "name": connector.name,
        "kinds": [
            {"id": k.id, "label": k.label, "actions": list(k.actions), "wildcard": k.wildcard,
             "hierarchical": k.hierarchical, "note": k.note, "listed": k.listed}
            for k in connector.kinds
        ],  # fmt: skip
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions],
        "auth": {
            "app": auth.app, "authorize_url": auth.authorize_url, "token_url": auth.token_url,
            "scopes": list(auth.scopes), "scope_separator": auth.scope_separator,
            "registration_url": auth.registration_url, "authorize_params": [list(p) for p in auth.authorize_params],
            "login_hint": auth.login_hint, "client_auth": auth.client_auth, "json_body": auth.json_body,
            "pkce": auth.pkce,
        },  # fmt: skip
        "browsable": list(getattr(connector, "browsable", ())),
        "operations": [
            {"name": op.name, "title": op.title, "description": op.description, "needs": [list(n) for n in op.needs],
             "output_action": op.output_action,
             "consent": None if op.consent is None else [sorted(option) for option in op.consent],
             "revision": op.revision, "mutates": op.mutates, "paginated": op.paginated,
             "schema": described(op.input_schema())}
            for op in connector.operations
        ],  # fmt: skip
    }


def ranges(test):
    """The code points (surrogates left out) for which `test` holds, as "first-last" ranges in hex joined
    with commas."""
    found = []
    for point in range(0x110000):
        if 0xD800 <= point <= 0xDFFF or not test(chr(point)):
            continue
        if found and found[-1][1] == point - 1:
            found[-1][1] = point
        else:
            found.append([point, point])
    return ",".join(f"{first:x}-{last:x}" for first, last in found)


def classes():
    """`re`'s `\\w`, `\\d` and `\\s` in a str pattern, and the code points this Python's Unicode leaves
    unassigned, where a newer runtime may differ."""
    return {
        "unicode": unicodedata.unidata_version,
        "word": ranges(lambda c: re.match(r"\w", c) is not None),
        "digit": ranges(lambda c: re.match(r"\d", c) is not None),
        "space": ranges(lambda c: re.match(r"\s", c) is not None),
        "unassigned": ranges(lambda c: unicodedata.category(c) == "Cn"),
    }


def main() -> None:
    operations = {op.name: op for op in LinearConnector.operations}
    vectors = {
        "declaration": declaration(LinearConnector),
        "redact": [{"text": text, "shown": markdown.redact(text)} for text in REDACT],
        "written": [
            {"text": text, **check(markdown.check_written, text), **({"links": markdown.issue_links(text)} if
             check(markdown.check_written, text).get("ok") is not None else {})}
            for text in WRITTEN
        ],  # fmt: skip
        "teams": [{"name": name, **check(teams._team_name, name)} for name in TEAM_NAMES],
        "issues": [{"name": name, **check(teams._issue_name, name)} for name in ISSUE_NAMES],
        "dates": [{"value": value, **check(writes._due_date, value)} for value in DATES],
        "judge": [judged(status, body) for status, body in JUDGED],
        "raw": [raw(status, body) for status, body in RAW],
        "loads": [loaded(body) for body in LOADS],
        "errors": [{"errors": errors, "code": classified(errors)} for errors in ERRORS],
        "inputs": {name: [validated(operations[name], raw) for raw in raws] for name, raws in INPUTS.items()},
        "lax": {
            "bool": [lax(client.PageInfo, "has_next_page", value) for value in LAX_BOOLS],
            "float": [lax(Estimate, "estimate", value) for value in LAX_FLOATS],
        },
        "classes": classes(),
        "models": [read_model(name, value) for name, value in MODELS],
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")

    folds = {}
    for point in range(0x110000):
        if 0xD800 <= point <= 0xDFFF:
            continue
        char = chr(point)
        if char.casefold() != char:
            folds[f"{point:x}"] = " ".join(f"{ord(c):x}" for c in char.casefold())
    (HERE / "casefold.json").write_text(json.dumps(folds) + "\n")


if __name__ == "__main__":
    main()
