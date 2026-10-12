"""Writes vectors.json: what today's Python answers, for the Atlassian connectors' cross-language tests.

- `unicode`: the parts of Python's string semantics the connectors rely on, per assigned code point (as of
  this Python's Unicode version): `\\w`, `\\d` and `\\s` in `re`, `str.lower()`, `str.upper()` and
  `str.casefold()`, and which other characters match each ASCII letter under `re.IGNORECASE`.
- `adf`: `connectors.atlassian.adf` on hand-written and seeded random documents and texts.
- `jira`, `confluence`: the pure helpers of the two clients and connectors (page tokens, cursors, sites).
- `models`: provider responses read through the clients' Pydantic models (lax ints and bools, camelCase
  aliases and field names, defaults, nulls), as each model dumps them or "ValidationError".

The connector modules import only pydantic, httpx and the connector core, never configuration.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/atlassian/generate.py
"""

import json
import random
import re
import sys
import unicodedata
from pathlib import Path

from pydantic import ValidationError

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

from connectors.atlassian import Site, adf  # noqa: E402
from connectors.base import OperationError  # noqa: E402
from connectors.confluence import client as confluence_client  # noqa: E402
from connectors.confluence import connector as confluence_connector  # noqa: E402
from connectors.confluence import reads as confluence_reads  # noqa: E402
from connectors.jira import client as jira_client  # noqa: E402
from connectors.jira import connector as jira_connector  # noqa: E402
from connectors.jira import reads as jira_reads  # noqa: E402
from connectors.jira import writes as jira_writes  # noqa: E402


def ranges(points):
    """Sorted code points as [start, end] runs."""
    out = []
    for point in points:
        if out and out[-1][1] == point - 1:
            out[-1][1] = point
        else:
            out.append([point, point])
    return out


def unicode_tables():
    assigned, word, digit, space = [], [], [], []
    lower, upper, casefold = {}, {}, {}
    w, d, s = re.compile(r"\w"), re.compile(r"\d"), re.compile(r"\s")
    for point in range(0x110000):
        char = chr(point)
        if unicodedata.category(char) == "Cn":
            continue
        assigned.append(point)
        if w.fullmatch(char):
            word.append(point)
        if d.fullmatch(char):
            digit.append(point)
        if s.fullmatch(char):
            space.append(point)
        if char.lower() != char:
            lower[point] = char.lower()
        if char.upper() != char:
            upper[point] = char.upper()
        if char.casefold() != char:
            casefold[point] = char.casefold()
    ignorecase = {}
    for letter in "abcdefghijklmnopqrstuvwxyz":
        pattern = re.compile(letter, re.IGNORECASE)
        ignorecase[letter] = [p for p in range(0x80, 0x110000) if pattern.fullmatch(chr(p))]
    return {
        "version": unicodedata.unidata_version,
        "assigned": ranges(assigned),
        "word": ranges(word),
        "digit": ranges(digit),
        "space": ranges(space),
        "lower": lower,
        "upper": upper,
        "casefold": casefold,
        "ignorecase": ignorecase,
    }


def outcome(function, *args):
    """What a helper returns, or the error it raises: an owned error's code and message, or the class."""
    try:
        return {"value": function(*args)}
    except OperationError as error:
        return {"error": error.code, "message": error.message}
    except ValueError as error:
        return {"error": "ValueError", "message": str(error)}
    except TypeError:
        return {"error": "TypeError"}


# Texts with the encodings and spellings the reader and the checks must see through.
ADDRESSES = [
    "https://acme.atlassian.net/browse/FIN-1",
    "https%3A%2F%2Facme%2Eatlassian%2Enet/browse/FIN-1",
    "ACME.ATLASSIAN.NET/x",
    "acme.atlassİan.net",
    "acme.atlassıan.net",
    "acme.atlaſſian.net",
    "ａｃｍｅ．ａｔｌａｓｓｉａｎ．ｎｅｔ",
    "acme。atlassian。net",
    "acme&period;atlassian&period;net",
    "acme&#46;atlassian&#x2e;net",
    "acme\u200b.atlassian.net",
    "acme\\.atlassian\\.net",
    "atl\tas\nsian.net",
    "%2561tlassian.net",
    "%252561tlassian.net",
    "%25252561tlassian.net",
    "jira.com/x",
    "jıra.com",
    "atlassian.design",
    "atl.so/x",
    "trello.com/b/x",
    "BITBUCKET.ORG",
    "bitbucket.org.example",
    "https://example.com/docs",
    "https://acme.example.com/browse/FIN-1",
    "https://JIRA.acme.example/browse/FIN-1",
    "jira%2Eacme%2Eexample/x",
    "/browse/FIN-1",
    "//evil.example/x",
    " //evil.example/x",
    "mailto:ada@example.com",
    "ıttps://example.com",
    "İttps://example.com",
    "\u212attps://example.com",
    "ftp+x.y-z://example.com",
    "1http://example.com",
    "https:",
    ":x",
    "",
    " ",
    "\u3000https://example.com",
    "\x1chttps://example.com\x1f",
    "\ufeffhttps://example.com",
    "javascript:alert(1)",
    "data:text/html,x",
    "#fragment",
    "?q=1",
    "example.com",
    "https://atlassian.net",
    "https://atlassian.com.example",
    "x atlassian.netx",
    "\ud800atlassian.net",
]

HOSTS = [[], ["acme.example.com"], ["jira.acme.example"], ["ACME.EXAMPLE.COM"], [""], ["acme.atlassian.net", "beta.example"]]

TEXTS = [
    "plain words",
    "word https://acme.atlassian.net/browse/FIN-1 word",
    "a\u00a0b\u2003c\u3000d\x1ce\x1df\x1eg\x1fh\x85i\u2028j\u2029k\ufeffl\u200bm",
    "tabs\tand\nnewlines\r\nhere",
    "  leading and trailing  ",
    "emoji \U0001f600 and e\u0301 combining",
    "[Atlassian link] stays",
    "(https://example.com/x) and (acme.atlassian.net)",
    "acme.example.com/x and ACME.example.COM",
    "",
    "\x07 bell",
    "a\x0bb\x0cc",
    "fine text with trello.com inside",
    "x" * 50,
] + ADDRESSES


def node(rng, depth):
    """A random ADF node, mostly well formed."""
    kinds = [
        "text", "text", "text", "paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem",
        "codeBlock", "panel", "table", "tableRow", "tableCell", "tableHeader", "expand", "nestedExpand",
        "layoutSection", "layoutColumn", "taskList", "taskItem", "decisionList", "decisionItem", "mediaSingle",
        "mediaGroup", "media", "mediaInline", "inlineCard", "blockCard", "embedCard", "hardBreak", "rule",
        "mention", "emoji", "date", "status", "placeholder", "extension", "bodiedExtension", "somethingNew",
        "doc",
    ]
    roll = rng.random()
    if roll < 0.03:
        return rng.choice(["a string", 5, None, True, ["list"]])
    kind = rng.choice(kinds)
    if kind == "text":
        result = {"type": "text", "text": rng.choice(TEXTS)}
        if rng.random() < 0.15:
            result["text"] = rng.choice([None, 5, ["x"]])
        if rng.random() < 0.6:
            marks = []
            for _ in range(rng.choice([1, 1, 1, 2])):
                mark = rng.choice(["link", "link", "strong", "em"])
                if mark == "link":
                    attrs = rng.choice([{"href": rng.choice(ADDRESSES)}, {"href": rng.choice(ADDRESSES)}, {}, {"href": 5}, "x"])
                    marks.append({"type": "link", "attrs": attrs})
                else:
                    marks.append({"type": mark})
            if rng.random() < 0.05:
                marks = rng.choice(["x", {"type": "link"}, [5, None]])
            result["marks"] = marks
        return result
    result: dict = {"type": kind}
    attrs: dict = {}
    if kind == "mention":
        attrs["text"] = rng.choice(["@Grace", "Grace", "@@", "", None, 5, "@ Ada \u00a0"])
    elif kind == "emoji":
        attrs = rng.choice([{"shortName": ":smile:", "text": "😄"}, {"shortName": ":x:"}, {"text": ""}, {}])
    elif kind == "date":
        attrs["timestamp"] = rng.choice(
            ["1759276800000", 1759276800000, 1.7e12, "x", None, "-1", " 12_000 ", "\u0661\u0662", 1e300, True, [1],
             "253402300800000", 253402300799999, -62135596800001, "1.5"]
        )
    elif kind == "status":
        attrs["text"] = rng.choice(["BLOCKED", "", None, "acme.atlassian.net"])
    elif kind in {"inlineCard", "blockCard", "embedCard"}:
        attrs["url"] = rng.choice([*ADDRESSES, None, 5])
    elif kind in {"expand", "nestedExpand"}:
        attrs["title"] = rng.choice(["Details", "", None, "see acme.atlassian.net"])
    elif kind == "taskItem":
        attrs["state"] = rng.choice(["DONE", "TODO", None])
    elif kind == "decisionItem":
        attrs["state"] = rng.choice(["DECIDED", "DONE"])
    elif kind in {"extension", "bodiedExtension"}:
        attrs = {"extensionKey": "x", "text": "SECRET"}
    if attrs:
        result["attrs"] = attrs if rng.random() > 0.05 else "not attrs"
    if depth < 5 and rng.random() < 0.8:
        result["content"] = [node(rng, depth + 1) for _ in range(rng.randint(0, 3))]
        if rng.random() < 0.03:
            result["content"] = "not a list"
    return result


def adf_cases():
    rng = random.Random(7)
    documents = []
    for _ in range(90):
        documents.append({"type": "doc", "version": 1, "content": [node(rng, 1) for _ in range(rng.randint(1, 5))]})
    # The same link split across text nodes, and links whose labels repeat or omit their address.
    link = {"type": "link", "attrs": {"href": "https://example.com/a"}}
    documents += [
        {"type": "doc", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "one ", "marks": [link]},
            {"type": "text", "text": "link", "marks": [link]},
            {"type": "text", "text": " plain"},
            {"type": "text", "text": "https://example.com/a", "marks": [link]},
            {"type": "text", "text": " ", "marks": [link]},
            {"type": "hardBreak"},
            {"type": "text", "text": "x", "marks": [{"type": "link", "attrs": {"href": "https://example.com/b"}}]},
            {"type": "text", "text": "y", "marks": [link]},
        ]}]},
        {"type": "doc", "content": [{"type": "bulletList", "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]},
                                             {"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]},
            {"type": "listItem", "content": [{"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "nested"}]}]}]}]},
        ]}]},
        {"type": "doc", "content": [{"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "h1"}]}]},
            {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "c1"}]}]},
        ]}]}]},
        {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}, {"type": "rule"},
                                    {"type": "paragraph", "content": []}, {"type": "paragraph"}, {"type": "rule"}]},
        {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x\n\n\n\ny  \n z\u00a0"}]}]},
        {"type": "doc", "content": [{"type": ["list"], "content": []}]},
        {"type": "doc", "content": [{"type": {"a": 1}}]},
        {"type": "doc", "content": [{"type": 5}, {"type": None}, {"type": True}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "not a doc at the root"}]},
        "not a document",
        None,
        [{"type": "doc"}],
    ]
    return [
        {"document": document, "results": [{"hosts": hosts, **outcome(adf.read, document, hosts)} for hosts in (HOSTS[0], HOSTS[1])]}
        for document in documents
    ]


def texts_cases():
    redact, internal, check_hosts, check_written, written = [], [], [], [], []
    for text in TEXTS:
        redact.append({"text": text, "results": [outcome(adf.redact, text, hosts) for hosts in HOSTS]})
        internal.append({"text": text, "results": [outcome(adf.internal, text, hosts) for hosts in HOSTS]})
        check_hosts.append({"text": text, "results": [outcome(adf.check_hosts, text, hosts) for hosts in HOSTS]})
        check_written.append({"text": text, **outcome(adf.check_written, text)})
    for text in [
        "a\r\nb\n\n\nc",
        "Done.\n\n**not bold**\nnext",
        "  \n\n a \n \t \n b \r\r c\n",
        "",
        " ",
        "one\n\n\n\ntwo",
        "x\n\x0b\ny",
        "\u3000a\u3000",
        "line\n\nline",
        "a\n \n\n \nb",
    ]:
        written.append({"text": text, **outcome(adf.written, text)})
    return redact, internal, check_hosts, check_written, written


DATES = [
    "1759276800000", 1759276800000, 1.7e12, "x", None, "-1", -1, " 12_000 ", "1_2", "_12", "12_", "1__2", "+5",
    "\u0661\u0662", "\uff11\uff12", 1e300, float("1e20"), True, False, [1], {"a": 1}, "253402300800000",
    253402300799999, 253402300800000, -62135596800000, -62135596800001, "1.5", "", " ", "\u20021\u2002",
    "\x1c1\x1f", "0x10", "9" * 400, 86399999, -86400000, 1.999, -1.5,
]


def dates():
    return [{"timestamp": value, "value": adf._date(value)} for value in DATES]


def site_cases():
    cases = []
    for item in [
        {"id": "x", "name": "Acme", "url": "https://acme.atlassian.net"},
        {"id": "x", "name": "Acme", "url": "https://ACME.atlassian.net/"},
        {"id": "x", "name": "acme.atlassian.net", "url": "https://acme.atlassian.net///"},
        {"id": "x", "name": None, "url": "https://acme.atlassian.net"},
        {"id": "x", "name": "", "url": None},
        {"id": "x", "name": "Acme", "url": "http://acme.atlassian.net"},
        {"id": "x", "name": "Acme", "url": "https://acme"},
        {"id": "x", "name": "Acme", "url": "https://acme.atlassian.net/wiki"},
        {"id": "x", "name": "Acme", "url": "https://acme_x.atlassian.net"},
        {"id": "x", "name": "Acme", "url": "https://\u212acme.atlassian.net"},
        {"id": "x", "name": "Acme", "url": "https://acme.atlassian.net\n"},
        {"id": "x", "name": "Acme", "url": "https://xn--80ak6aa92e.example"},
        {"id": "x", "name": "Acme", "url": ""},
    ]:
        site = Site.model_validate(item)
        cases.append({"site": item, "host": site.host, "label": site.label})
    return cases


def jira_cases():
    page_params = [
        {"cursor": cursor, **outcome(jira_client.page_params, cursor)}
        for cursor in [None, "t:eyJ+a/b=", "x:abc", "t:", "t:a b", "t:" + "a" * 990, "t:" + "a" * 991, "t:é", "t:~!", "T:a"]
    ]
    next_cursor = [
        {"body": body, **outcome(jira_client.next_cursor, body)}
        for body in [
            {"nextPageToken": "abc", "isLast": True},
            {"nextPageToken": "abc", "isLast": False},
            {"nextPageToken": "abc", "isLast": 1},
            {"nextPageToken": "abc"},
            {},
            {"nextPageToken": None},
            {"nextPageToken": "a b"},
            {"nextPageToken": 5},
            {"nextPageToken": "a" * 991},
            {"nextPageToken": ""},
            {"nextPageToken": ["a"]},
        ]
    ]
    discover_cursor = []
    sites = [None, None]
    for cursor in [None, "0:0", "1:50", "2:0", "x", "0:-1", "0:1234567", "00:12", "\u0661:\u0662", "0:\uff11", "01:5", "0:", ":0", "0:0\n"]:
        discover_cursor.append({"cursor": cursor, **outcome(jira_connector._cursor, cursor, sites)})
    words = [{"text": text, **outcome(jira_reads._search_words, text)} for text in TEXTS + ['login "OR project = FIN', "?!", "a b c d e f g h i j", "é_x ٣ Ⅷ ² e\u0301"]]
    names = [
        {"values": values, "value": jira_writes._names(values)}
        for values in [[], [None, ""], ["b", "a", "b"], [str(n) for n in range(40)], ["Ä", "a", "Z", "ä"]]
    ]
    return {"page_params": page_params, "next_cursor": next_cursor, "discover_cursor": discover_cursor, "search_words": words, "names": names}


def confluence_cases():
    page_params = [
        {"cursor": cursor, **outcome(confluence_client.page_params, cursor)}
        for cursor in [None, "c:eyJ+a/b=", "x:abc", "c:", "c:a b", "c:" + "a" * 991, "c:é"]
    ]
    next_token = []
    for link in [
        None,
        "",
        "/wiki/api/v2/pages?cursor=abc%2B&limit=5",
        "https://evil.example/x?cursor=abc",
        "/x?limit=5",
        "/x?cursor=a%20b",
        "/x?cursor=a+b",
        "/x?cursor=a&cursor=b",
        "/x?cursor=" + "a" * 991,
        "/x?cursor=",
        "/x?cursor=&cursor=b",
        "/x?cursor",
        "/x?a=1&cursor=%7E%21",
        "/x#?cursor=a",
        "/x?cursor=a#b",
        "/x?cursor=a;b",
        "/x?cursor=%ZZ",
        "/x?cursor=%C3%A9",
        "/x?cur\nsor=a",
        " \t/x?cursor=a",
        "https://ex\tample/?cursor=a",
        "x:y?cursor=a",
        "/x?cursor=a?b",
        "/x??cursor=a",
        "/x?&&cursor=a&",
        "/x?CURSOR=a",
        "https://[::1]/?cursor=a",
        "https://[x/?cursor=a",
        "https://x]/?cursor=a",
        "https://[1.2.3.4]/?cursor=a",
        "https://a[::1]/?cursor=a",
        "https://[::1]x/?cursor=a",
        "https://[::1]:80/?cursor=a",
        "https://u@[::1]/?cursor=a",
        "https://[v1.x]/?cursor=a",
        "https://[v1.]/?cursor=a",
        "https://[vz.x]/?cursor=a",
        "https://[::1%25eth0]/?cursor=a",
        "https://[::1%]/?cursor=a",
        "https://[1:2:3:4:5:6:7:8:9]/?cursor=a",
        "https://[1:2:3:4:5:6:7:8]/?cursor=a",
        "https://[1::2::3]/?cursor=a",
        "https://[::ffff:1.2.3.4]/?cursor=a",
        "https://[::ffff:1.2.3.04]/?cursor=a",
        "https://[:1::2]/?cursor=a",
        "https://[1::2:]/?cursor=a",
        "https://[12345::1]/?cursor=a",
        "https://[::g]/?cursor=a",
        "https://℀.example/?cursor=a",
        "https://Ａ.example/?cursor=a",
        "//[::1/?cursor=a",
    ]:
        listing = confluence_client.Listing.model_validate({"results": [], "_links": {"next": link} if link is not None else {}})
        next_token.append({"next": link, **outcome(confluence_client.next_token, listing)})
    discover_cursor = []
    sites = [None, None]
    for cursor in [None, "0:", "1:abc", "2:", "x", "0:a b", "0:" + "a" * 990, "0:" + "a" * 991, "\u0661:x", "01:x", "0:~", ":x"]:
        discover_cursor.append({"cursor": cursor, **outcome(confluence_connector._cursor, cursor, sites)})
    words = [{"text": text, **outcome(confluence_reads._search_words, text)} for text in ['run "OR space = FIN', "?!"]]
    documents = []
    # Python also reads NaN and Infinity, which JSON (and parseJson) do not have; they are left out.
    for value in ['{"type": "doc"}', "{broken", "", "[]", "null", '"text"', "nan", '{"a": 1', 5, None, '{"a": "\\ud800"}']:
        body = confluence_client.Body.model_validate({"atlas_doc_format": {"value": value}})
        documents.append({"value": value, "document": confluence_client.document(body)})
    return {"page_params": page_params, "next_token": next_token, "discover_cursor": discover_cursor, "search_words": words, "documents": documents}


def validated(model, value):
    """What a model reads from a response: its dump, or the error's class."""
    try:
        return {"value": model.model_validate(value).model_dump()}
    except ValidationError:
        return {"error": "ValidationError"}


def model_cases():
    numbers = [
        1, 0, -3, 3.0, 3.5, True, False, None, "12", "1_000", " 12 ", " 12", " 1 ", "\x1c12", "12.0",
        "12.000", "-12.0", "1_000.0", "12.", ".0", "0.", "12.01", "12.0_0", "_1", "1_", "1__0", "+5", "-0", "+_1",
        "+-1", "1e3", "0x10", "١٢", "", " ", [], {}, "1" * 19,
    ]
    flags = [
        True, False, 0, 1, 2, 1.0, 0.0, 0.5, None, "", "0", "1", "2", "Yes", "ON", " true", "TRUE", "f", "n", "No",
        "oFF", "t", "y", "İ", "yeſ", "K", [], {},
    ]
    pages = [{"id": "1", "version": {"number": number}} for number in numbers] + [
        {"id": "1", "createdAt": "alias", "created_at": "name"},
        {"id": "1", "created_at": "name"},
        {"id": "1", "createdAt": None, "created_at": "name"},
        {"id": "1", "spaceId": 5},
        {"id": 1},
        {"title": "no id"},
        {"id": "1", "version": None, "body": None},
        {"id": "1", "version": "x"},
        {"id": "1", "version": {"createdAt": "v", "number": None}},
        {"id": "1", "body": {"atlas_doc_format": None}},
        {"id": "1", "body": {"atlasDocFormat": {"value": "camel"}, "atlas_doc_format": {"value": "name"}}},
        {"id": "1", "body": {"atlas_doc_format": {"value": {"type": "doc"}}}},
        {"id": "1", "body": {"atlas_doc_format": {}}},
        {"id": "1", "parentId": "2", "parentType": "page", "status": "current", "title": "T", "extra": [1]},
        "not an object",
        [],
    ]
    listings = [
        {},
        {"results": [{"a": 1}], "_links": {"next": "/x?cursor=a"}},
        {"_links": {"next": "x"}, "links": {"next": "y"}},
        {"links": {"next": "y"}},
        {"_links": None},
        {"_links": {}},
        {"results": None},
        {"results": [1]},
        {"results": [], "_links": {"next": None}},
        {"results": [], "_links": {"next": 5}},
    ]
    projects = [{"id": "1", "key": "K", "archived": flag} for flag in flags] + [
        {"id": "1", "key": "K", "projectTypeKey": "software", "project_type_key": "x", "name": "N"},
        {"id": "1", "key": "K", "project_type_key": "business"},
        {"id": "1"},
        {"id": "1", "key": None},
    ]
    issues = [
        {"id": "1", "key": "K-1"},
        {"id": "1", "key": "K-1", "fields": None},
        {"id": "1", "key": "K-1", "fields": {}},
        {"id": "1", "key": "K-1", "fields": {"labels": None}},
        {"id": "1", "key": "K-1", "fields": {"labels": ["a", 1]}},
        {"id": "1", "key": "K-1", "fields": {"attachment": [{"x": 1}, {}]}},
        {"id": "1", "key": "K-1", "fields": {"attachment": [1]}},
        {"id": "1", "key": "K-1", "fields": {"description": {"type": "doc"}, "parent": {"id": "2", "key": "K-2"}}},
        {"id": "1", "key": "K-1", "fields": {"status": {"name": "Done", "statusCategory": {"key": "done", "name": "Done"}}}},
        {"id": "1", "key": "K-1", "fields": {"status": {"status_category": {"name": "by name"}}}},
        {"id": "1", "key": "K-1", "fields": {"issuelinks": [{"type": None, "inwardIssue": {"id": "3"}, "outward_issue": {"id": "4"}}]}},
        {"id": "1", "key": "K-1", "fields": {"issuetype": {"subtask": "yes", "id": None}}},
        {"id": "1", "key": "K-1", "fields": {"subtasks": [{"id": 5}]}},
        {"id": "1", "key": "K-1", "fields": {"assignee": {"displayName": "A", "display_name": "B"}, "reporter": {}}},
        {"id": "1", "key": "K-1", "fields": {"project": {"id": "10000"}}},
        {"id": "1", "key": "K-1", "fields": {"project": {"key": "K"}}},
    ]
    comments = [
        {"id": "1"},
        {"id": "1", "body": None, "author": None, "created": "c", "updated": None},
        {"id": "1", "body": "text", "author": {"displayName": "A"}},
        {"id": None},
    ]
    return {
        "page": [{"input": item, **validated(confluence_client.Page, item)} for item in pages],
        "listing": [{"input": item, **validated(confluence_client.Listing, item)} for item in listings],
        "project": [{"input": item, **validated(jira_client.Project, item)} for item in projects],
        "issue": [{"input": item, **validated(jira_client.Issue, item)} for item in issues],
        "comment": [{"input": item, **validated(jira_client.Comment, item)} for item in comments],
    }


def main() -> None:
    redact, internal, check_hosts, check_written, written = texts_cases()
    vectors = {
        "unicode": unicode_tables(),
        "adf": {
            "hosts": HOSTS,
            "read": adf_cases(),
            "redact": redact,
            "internal": internal,
            "check_hosts": check_hosts,
            "check_written": check_written,
            "written": written,
            "dates": dates(),
        },
        "sites": site_cases(),
        "jira": jira_cases(),
        "confluence": confluence_cases(),
        "models": model_cases(),
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
