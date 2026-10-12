"""Writes python-vectors.json: what today's Python computes, for lib/'s cross-language tests.

Backend modules that would load configuration (and with it .env) are never imported; the few pure helpers
needed are loaded on their own. Hashed and encrypted values are no longer Python's (step 6b: canonical JSON
and AES-GCM), so only what the model and providers see is pinned here: `json.dumps(value)` (`default`).

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/generate.py
"""

import hashlib
import html
import html.entities
import html.parser as html_parser
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import unquote

from django.utils.crypto import salted_hmac

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"

def load_text_module():
    spec = importlib.util.spec_from_file_location("minerva_text", BACKEND / "connectors" / "text.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# JSON texts both sides parse. Integral floats (1.0) are left out: a parsed JavaScript number cannot tell
# them from ints, which lib/json.ts documents.
VALUES = [
    '{"b": 1, "a": 2}',
    '{"z": {"y": [3, {"b": null, "a": true}]}, "a": "x", "m": false}',
    '{"\\u00e9": 1, "e": 2, "\\ud83d\\ude00": 3, "\\uffff": 4, "\\ue000": 5, "Z": 6, "": 7}',
    '"quote\\" back\\\\ slash / tab\\t nl\\n cr\\r bs\\b ff\\f nul\\u0000 unit\\u001f del\\u007f \\u00e9 \\ud83d\\ude00 \\u2028 \\ufeff"',
    "[0, -1, 1.5, 0.1, 1e-07, 1e16, 1.7976931348623157e308, 5e-324, -2.5e-08, 123.456, 9007199254740991, 0.0001, 0.00012345, 1e21, 123456789.125, -0.5]",
    '{"a": [], "b": {}, "c": [[]], "d": [{}]}',
    '{"project_id": "work", "title": "Buy milk", "limit": 30, "cursor": null, "search": "caf\\u00e9"}',
    '{"files": {"a.txt": {"sha256": "' + "a" * 64 + '", "size": 5, "mode": 420, "mtime": 1700000000500},'
    ' "\\u00e9.txt": {"sha256": "' + "b" * 64 + '", "size": 0, "mode": 493, "mtime": 0},'
    ' "\\ud83d\\ude00/x": {"sha256": "' + "c" * 64 + '", "size": 4097, "mode": 420, "mtime": 253402300799999},'
    ' "\\ufeffbom.txt": {"sha256": "' + "d" * 64 + '", "size": 1, "mode": 420, "mtime": 1}}, "dirs": ["empty", "x/y"]}',
    '{"revision": 1, "input": {"type": "object", "properties": {"project_id": {"type": "string", "maxLength": 160,'
    ' "description": "The project\\u2019s id"}}, "required": ["project_id"], "additionalProperties": false},'
    ' "needs": [["project", "read"]], "output": "read", "consent": null, "mutates": false, "paginated": true,'
    ' "requires": {"read": ["read"]}, "kinds": {"project": {"actions": ["create", "read"], "wildcard": true, "hierarchical": false}}}',
    '{"kind": "oauth2", "access_token": "at", "refresh_token": null, "scopes": ["read", "write"], "expires_at": 1760000000}',
    # Keys written with escapes, which V8's JSON.parse can confuse with an earlier "\\" key (lib/json.ts).
    '{"\\\\": 1, "\\n": 2, "ab\\\\": 3, "ab\\n": 4, "\\u0041": 5, "\\t": 6, "\\u00e9": 7, "x\\"y": 8, "__proto__": {"a": 1}}',
]

FLOATS = [0.5, 0.1, 1e-07, 1e-05, 0.0001, 0.00012345, 1e16, 1e15, 123456789012345.6, 1.5e300, 5e-324, 1.7976931348623157e308, -2.5e-08, 2.0 ** 53, 1e22, 3.14159, -0.0, 100.25]

DECODED = [
    "[x](https://linear%2eapp/acme/issue/OPS-1)",
    "[x](https://linear&#46;app/acme/issue/OPS-1)",
    "[x](https://linear\\.app/acme/issue/OPS-1)",
    "[x](https://linear\u3002app/acme/issue/OPS-1)",
    "[x](https://\uff4c\uff49\uff4e\uff45\uff41\uff52.app/acme/issue/OPS-1)",
    "[x](https://linear\u200b.app/acme/issue/OPS-1)",
    "https://linear.app/acme/issue/ENG-1/%2e%2e",
    "acme.slack&#46;com/archives",
    "acme.slack\u200b.com",
    "linear%252eapp",
    "linear%25252eapp",
    "linear%2525252eapp",
    "linear&amp;#46;app",
    "linear&amp;amp;#46;app",
    "%26%2346%3B",
    "\ufeffstart and e\u0301nd",
    "\u2460 \ufb01 \u00bd",
    "plain text, nothing encoded",
    "100% sure & then some",
    "&lt;img src=x&gt;",
]

UNQUOTED = ["a%20b", "%E2%82%AC", "%e2%82", "%zz", "100%", "%", "%%41", "caf%C3%A9 \u00e9 %C3", "\u00e9%41", "%F0%9F%98%80", "%ff%fe", "a+b", "%2", "%41%"]

UNESCAPED = [
    "&amp;", "&amp", "&ampx", "&lt;b&gt;", "&#46;", "&#x2e;", "&#X2E", "&#0;", "&#128;", "&#x80;", "&#x9f;",
    "&#55296;", "&#1114112;", "&#99999999999999999999;", "&#1;", "&#11;", "&#13;", "&#xFFFE;", "&#00000065",
    "&notit;", "&notin;", "&nosuchentity;", "&constructor;", "&__proto__;", "&toString", "a & b", "&#;", "&#x;",
    "&AElig", "&aeligx", "&Aacute;&aacute", "&\U0001f600;", "&" + "a" * 40 + ";", "&nbsp&nbsp;", "&frac12;",
    # Numeric references: the Windows-1252 range, what is dropped, what is replaced, and the edges of each.
    "&#127;", "&#x7f;", "&#x81;", "&#x8d;", "&#x9f;&#xa0;", "&#8;&#9;&#10;&#12;&#14;&#31;&#32;", "&#xfdcf;&#xfdd0;&#xfdef;&#xfdf0;",
    "&#xffff;&#x1fffe;&#x10fffe;&#x10ffff;&#x10fffd;", "&#xd7ff;&#xd800;&#xdbff;&#xdfff;&#xe000;", "&#x110000;&#x7fffffff;",
    "&#0000000000000065;", "&#X41g", "&#65a", "&#6g", "&#xg;", "&#x41;;", "&#" + "9" * 400 + ";", "&#x" + "f" * 400,
    # Names: cut and extended at every point that matters, the table's longest, multi-character values.
    "&NotEqualTilde;", "&CounterClockwiseContourIntegral;", "&ThickSpace;", "&nbsp;x", "&notinx", "&notin", "&notin;",
    "&ampamp;", "&amp;amp;", "&AMP", "&Amp;", "&LT", "&lt=", "&lt;=", "&copy2", "&para;&para", "&sect=", "&" + "a" * 32,
    "&" + "a" * 31 + ";", "&&amp;", "&amp&", "&#38;amp;", "&#38;#38;", "&amp;#38;", "a&amp;b&lt;c&gt;\n&quot;&apos;",
    "&not;it", "&notit", "&notit;", "&isin;&isinv;&isinvx", "&Gt;&GT;&gt;&Gt", "&lsquo;&LSQUO&rsquo", "&ENG;&eng;&Eng",
    "&\t&amp;", "&\n", "&amp\r", "&\u00e9;", "&amp\u00e9", "&amp\u0301",
]

# Attribute values as html.parser reads them: numeric references always, a name only whole and not before "=".
ATTRIBUTES = [
    "&amp;", "&amp", "&ampx", "&amp=", "&amp;=", "&amp-", "&amp.", "&amp ", "&amp&amp", "&ampé", "&AMP", "&Amp;",
    "&notit;", "&notit", "&not;", "&not", "&notin", "&notin;", "&notin=", "&not=", "&copy=2", "&copy2", "&copy;2",
    "&lt;b&gt;", "&lt", "&lt>", "&lt/", "&#65", "&#65=", "&#65;=", "&#x41g", "&#X41;", "&#0;", "&#x7f;", "&#1;", "&#128;",
    "&#xd800;", "&#x110000;", "&#;", "&#x;", "&;", "&", "&&", "a&b", "a&b=c&d=e", "?a=1&copy=2&amp=3&lt;=4",
    "https://example.com/?a=1&b=2", "https://example.com/?a=1&amp;b=2", "https://example.com/?a=1&copyright=2",
    "&NotEqualTilde;", "&CounterClockwiseContourIntegral;", "&" + "a" * 40 + ";", "&nbsp&nbsp;", "&frac12", "&frac12;",
    "&AElig", "&AElig=", "&aeligx", "&\U0001f600;", "&amp;amp;", "&#38;amp;", "x&", "&x",
]

TRUNCATE = [["abc", 2], ["abc", 3], ["\U0001f600\U0001f600\U0001f600", 2], ["\u00e9", 1], [None, 3], ["", 0]]

# Strings as `f"{value!r}"` writes them into messages (permissions/services.py, connectors/registry.py).
# No lone surrogates: the tests' JSON loader refuses them (text.test.ts checks one itself).
REPR = [
    "", "project", "it's", 'say "hi"', "both ' and \"", "back\\slash", "tab\tnl\ncr\r", "\x00\x1f\x7f", "\x80\x9f\xa0\xad\xe9",
    "\u200b\u2028\u3000\ufeff\ue000\ufffe", "\U0001f600\U000e0001\U0010ffff", "e\u0301", "\u0378",
]

STRIPPED = ["  x  ", "\x1c\x1fx\x1f", "\ufeffx\ufeff", "\x85x\u3000", "\n\nAgent.\n", "", "\t"]

SORTED = ["b", "a", "\u00e9", "\U0001f600", "\ue000", "\uffff", "Z", "a\u0000", "", "ab", "aa", "\U0001f600x", "\U0001f601", "\ud7ff"]


def pydantic_strings() -> dict:
    """What connector inputs' `str_strip_whitespace` strips, and how `max_length` counts (lib/schema.ts)."""
    from typing import Annotated

    from pydantic import BaseModel, ConfigDict, Field, ValidationError

    class Stripped(BaseModel):
        # As connectors/base.py's OperationInput.
        model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
        s: Annotated[str, Field(max_length=3)]

    class Plain(BaseModel):
        s: Annotated[str, Field(min_length=2, max_length=3)]

    stripped = [c for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF and Stripped(s=chr(c) + "a").s == "a"]

    def accepts(model, value: str) -> bool:
        try:
            model(s=value)
        except ValidationError:
            return False
        return True

    cases = ["\U0001f600" * 3, "\U0001f600" * 4, "\U0001f600", "ab", "abcd", "e\u0301e", "\ufeffab", "\x85ab\x85", " a ", "\u3000abc\u3000"]
    return {
        "stripped": stripped,
        "cases": [
            {"input": case, "stripped": Stripped(s=case).s if accepts(Stripped, case) else None, "plain": accepts(Plain, case)}
            for case in cases
        ],
    }


# Connector inputs with dicts, as JSON text the model could send (lib/schema.ts `strictRecord`).
RECORDS = [
    '{"flags": {"__proto__": 1}}',
    '{"flags": {"__proto__": true}}',
    '{"filter": {" __proto__ ": {"injected": true}}}',
    '{"filter": {"__proto__": {"injected": true}, " k ": " v ", "n": {" x ": " y ", "__proto__": null}}}',
    '{"filter": {" a ": 1, "a": 2, "b": 3}}',
    '{"filter": {"b": 0, " a ": 1, "c": 2, "a": 3}}',
    '{"filter": {"1": "a", " 1 ": "b"}}',
    '{"filter": {"\\u0085a\\ufeff": 1, "": 2, "  ": 3}}',
    '{"filter": null}',
    '{"filter": [1]}',
    '{"filter": "x"}',
    '{"flags": {"a": 1, "b": false, " c ": "x"}}',
    '{"flags": {" a ": 1, "a": true}}',
    '{"sorts": [{"property": "x"}, {"__proto__": {"a": 1}}]}',
    '{"sorts": [1]}',
    '{"sorts": [' + ", ".join(["{}"] * 11) + "]}",
    '{"properties": {}}',
    '{"properties": {"a": 1, "b": 2, "c": 3}}',
    '{"properties": {" a ": 1, "a": 2, "b": 3}}',
    '{"properties": {"a": 1, "b": 2, "c": 3}, "flags": {"a": 0}}',
]


def pydantic_records() -> list:
    """How `dict[str, …]` validates in a connector input: keys stripped, "__proto__" an ordinary key, a
    dict's length after validation. The output as JSON (compared as a value), or the errors as Ninja and the
    executor read them (`model_validate` of the parsed JSON)."""
    from typing import Annotated, Any

    from pydantic import BaseModel, ConfigDict, Field, ValidationError

    class Input(BaseModel):
        # As connectors/base.py's OperationInput, with the dicts of notion's QueryDatabase and CreateRow.
        model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
        flags: dict[str, bool] | None = None
        filter: dict[str, Any] | None = None
        sorts: Annotated[list[dict[str, Any]], Field(max_length=10)] | None = None
        properties: Annotated[dict[str, Any], Field(min_length=1, max_length=2)] | None = None

    cases = []
    for source in RECORDS:
        try:
            data = Input.model_validate(json.loads(source)).model_dump()
        except ValidationError as error:
            cases.append({"json": source, "errors": error.errors(include_url=False, include_input=False)})
        else:
            cases.append({"json": source, "canonical": json.dumps(data, sort_keys=True, separators=(",", ":"))})
    return cases


def entity_table() -> dict:
    """The names of `html.entities.html5` with their values, as one digest the tests recompute from `entities`."""
    names = sorted(html.entities.html5)
    lines = "".join(f"{name}\t{' '.join(f'{ord(c):x}' for c in html.entities.html5[name])}\n" for name in names)
    return {
        "names": len(names),
        "without_semicolon": sum(not name.endswith(";") for name in names),
        "sha256": hashlib.sha256(lines.encode()).hexdigest(),
    }


def main() -> None:
    text = load_text_module()
    canonical = [{"json": source, "default": json.dumps(json.loads(source))} for source in VALUES]

    secret = "test-secret-not-a-real-key"
    hmacs = [
        {"salt": "minerva.gateway.write", "value": f"0199a000-0000-7000-8000-00000000000{i}:{'e' * 64}", "secret": secret,
         "sha1": salted_hmac("minerva.gateway.write", f"0199a000-0000-7000-8000-00000000000{i}:{'e' * 64}", secret=secret).hexdigest(),
         "sha256": salted_hmac("minerva.gateway.write", f"0199a000-0000-7000-8000-00000000000{i}:{'e' * 64}", secret=secret, algorithm="sha256").hexdigest()}
        for i in range(3)
    ]
    hmacs.append({"salt": "s\u00e9", "value": "v\U0001f600", "secret": "k\u00e9y",
                  "sha1": salted_hmac("s\u00e9", "v\U0001f600", secret="k\u00e9y").hexdigest(),
                  "sha256": salted_hmac("s\u00e9", "v\U0001f600", secret="k\u00e9y", algorithm="sha256").hexdigest()})

    vectors = {
        "python": sys.version.split()[0],
        "canonical": canonical,
        "floats": [{"value": value, "repr": repr(value)} for value in FLOATS],
        "salted_hmac": hmacs,
        "decoded": [{"input": item, "output": text.decoded(item)} for item in DECODED],
        "unquote": [{"input": item, "output": unquote(item)} for item in UNQUOTED],
        "unescape": [{"input": item, "output": html.unescape(item)} for item in UNESCAPED],
        "unescape_attribute": [{"input": item, "output": html_parser._unescape_attrvalue(item)} for item in ATTRIBUTES],
        "entities": entity_table(),
        "truncate": [{"input": item, "limit": limit, "output": list(text.truncate(item, limit))} for item, limit in TRUNCATE],
        "sorted": sorted(SORTED),
        "sha256": [{"input": item, "hex": hashlib.sha256(item.encode()).hexdigest()} for item in ["", "abc", "\u00e9\U0001f600"]],
        "pydantic": pydantic_strings(),
        "pydantic_records": pydantic_records(),
        "repr": [{"input": item, "output": repr(item)} for item in REPR],
        "isspace": [c for c in range(0x110000) if chr(c).isspace()],
        "strip": [{"input": item, "output": item.strip()} for item in STRIPPED],
    }
    (HERE / "python-vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")
    print(f"wrote python-vectors.json with Python {vectors['python']}")


if __name__ == "__main__":
    main()
