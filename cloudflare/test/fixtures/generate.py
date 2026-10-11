"""Writes python-vectors.json: what today's Python computes, for lib/'s cross-language tests.

The canonical JSON variants are read from the backend's source rather than restated: each is the
keyword set of the `json.dumps` call in the function that uses it. Backend modules that would load
configuration (and with it .env) are never imported; the few pure helpers needed are loaded on their own.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/generate.py
"""

import ast
import base64
import builtins
import hashlib
import html
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import unquote

from cryptography.fernet import Fernet, InvalidToken
from django.utils.crypto import salted_hmac

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"

# Where each variant is defined: (file, function).
VARIANTS = {
    "fingerprint": ("connectors/registry.py", "fingerprint"),
    "write_key": ("connectors/executor.py", "_canonical"),
    "manifest_digest": ("files/manifest.py", "digest"),
    "credentials": ("connections/crypto.py", "encrypt"),
}


def dumps_keywords(relative: str, function: str) -> dict:
    tree = ast.parse((BACKEND / relative).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function:
            for call in ast.walk(node):
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "dumps"
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == "json"
                ):
                    keywords = {}
                    for keyword in call.keywords:
                        if isinstance(keyword.value, ast.Name):
                            keywords[keyword.arg] = getattr(builtins, keyword.value.id)
                        else:
                            keywords[keyword.arg] = ast.literal_eval(keyword.value)
                    return keywords
    raise SystemExit(f"No json.dumps call in {relative}:{function}")


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
]

TRUNCATE = [["abc", 2], ["abc", 3], ["\U0001f600\U0001f600\U0001f600", 2], ["\u00e9", 1], [None, 3], ["", 0]]

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


def main() -> None:
    text = load_text_module()
    variants = {name: dumps_keywords(*where) for name, where in VARIANTS.items()}
    names = {"ascii": "write_key", "utf8": "manifest_digest", "default": "credentials"}
    # The fingerprint uses the same variant as write keys and query hashes.
    assert variants["fingerprint"] == variants["write_key"], variants
    canonical = []
    for source in VALUES:
        value = json.loads(source)
        case = {"json": source}
        for label, variant in names.items():
            out = json.dumps(value, **variants[variant])
            case[label] = out
            case[f"{label}_sha256"] = hashlib.sha256(out.encode()).hexdigest()
        canonical.append(case)

    keys = [base64.urlsafe_b64encode(bytes(range(32))).decode(), base64.urlsafe_b64encode(bytes(range(32, 64))).decode()]
    plaintexts = [
        b"",
        b"x",
        b"16 bytes exactly",
        json.dumps({"kind": "oauth2", "access_token": "at", "refresh_token": None, "scopes": ["read"]}).encode(),
        "za\u017c\u00f3\u0142\u0107 \U0001f600".encode(),
        bytes(range(256)),
    ]
    fixed = []
    for plaintext in plaintexts:
        token = Fernet(keys[0])._encrypt_from_parts(plaintext, 1760000000, bytes(range(16)))  # noqa: SLF001
        fixed.append({"key": keys[0], "time": 1760000000, "iv": bytes(range(16)).hex(), "plaintext": plaintext.hex(), "token": token.decode()})
    random_tokens = [{"key": keys[0], "plaintext": p.hex(), "token": Fernet(keys[0]).encrypt(p).decode()} for p in plaintexts]
    good = random_tokens[1]["token"]
    invalid = [
        good[:-2] + ("A" if good[-2] != "A" else "B") + good[-1],
        base64.urlsafe_b64encode(b"\x81" + base64.urlsafe_b64decode(good)[1:]).decode(),
        good[:40],
        "not a token",
        "",
    ]
    for token in invalid:
        try:
            Fernet(keys[0]).decrypt(token)
        except InvalidToken:
            continue
        raise SystemExit(f"Expected InvalidToken for {token!r}")
    try:
        Fernet(keys[1]).decrypt(good)
        raise SystemExit("Expected InvalidToken with the other key")
    except InvalidToken:
        pass

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
        "variants": {name: {k: (v.__name__ if callable(v) else v) for k, v in kw.items()} for name, kw in variants.items()},
        "canonical": canonical,
        "floats": [{"value": value, "repr": repr(value)} for value in FLOATS],
        "fernet": {"fixed": fixed, "random": random_tokens, "invalid": invalid, "other_key": keys[1], "other_key_token": good},
        "salted_hmac": hmacs,
        "decoded": [{"input": item, "output": text.decoded(item)} for item in DECODED],
        "unquote": [{"input": item, "output": unquote(item)} for item in UNQUOTED],
        "unescape": [{"input": item, "output": html.unescape(item)} for item in UNESCAPED],
        "truncate": [{"input": item, "limit": limit, "output": list(text.truncate(item, limit))} for item, limit in TRUNCATE],
        "sorted": sorted(SORTED),
        "sha256": [{"input": item, "hex": hashlib.sha256(item.encode()).hexdigest()} for item in ["", "abc", "\u00e9\U0001f600"]],
        "pydantic": pydantic_strings(),
    }
    (HERE / "python-vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")
    print(f"wrote python-vectors.json with Python {vectors['python']}")


if __name__ == "__main__":
    main()
