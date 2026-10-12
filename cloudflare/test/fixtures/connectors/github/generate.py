"""Writes vectors.json: what today's GitHub connector computes, for test/unit/connectors-github.test.ts.

Each vector comes from backend/connectors/github/ itself: input validation (the executor's message, read
from executor.py's source, since importing the executor would set up Django), the Link header, path
segments, cursors, base64 file contents, the 403 wording, discovery's case folding and the records.
Configuration is never read: `minerva.config.config` is replaced before the connector is imported, so a
vector that needed it would stop the script instead of loading .env.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/github/generate.py
"""

import ast
import base64
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

import minerva.config  # noqa: E402


def _no_config():
    raise SystemExit("A vector read the configuration.")


minerva.config.config = _no_config

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.base import OperationError  # noqa: E402
from connectors.github import client as github_client  # noqa: E402
from connectors.github import connector as github  # noqa: E402


def load_validation_message():
    """executor.py `validation_message`, from its source."""
    source = (BACKEND / "connectors" / "executor.py").read_text()
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == "validation_message":
            namespace = {"ValidationError": ValidationError}
            exec(compile(ast.Module([node], []), "executor.py", "exec"), namespace)  # noqa: S102
            return namespace["validation_message"]
    raise SystemExit("No validation_message in executor.py")


validation_message = load_validation_message()

MODELS = {op.name: op.input_model for op in github.GitHubConnector.operations}

REPO = '"repository": "acme/app"'
INPUTS = {
    "list_repositories": [
        "{}",
        "null",
        '{"limit": 100, "cursor": "  abc  "}',
        '{"limit": 0}',
        '{"limit": 101}',
        '{"limit": "5"}',
        '{"limit": true}',
        '{"limit": 100000000000000000000}',
        '{"cursor": null}',
        '{"cursor": "' + "x" * 1001 + '"}',
        '{"connection_id": "other"}',
        "[]",
        '"acme/app"',
    ],
    "get_repository": [
        "{" + REPO + "}",
        '{"repository": "  acme/app\\n"}',
        '{"repository": "a/b"}',
        '{"repository": "ab"}',
        '{"repository": "acme/.."}',
        '{"repository": "acme/."}',
        '{"repository": "acme/..."}',
        '{"repository": "acme/app/extra"}',
        '{"repository": "ac.me/app"}',
        '{"repository": "acme/\\u00e1pp"}',
        '{"repository": "' + "a" * 40 + '/b"}',
        '{"repository": "' + "a" * 39 + "/" + "b" * 100 + '"}',
        '{"repository": "' + "a" * 39 + "/" + "b" * 101 + '"}',
        '{"repository": 5}',
        "{}",
        '{"repository": "acme/app", "extra": 1, "more": 2}',
    ],
    "list_issues": [
        "{" + REPO + "}",
        "{" + REPO + ', "state": "all", "limit": 50}',
        "{" + REPO + ', "state": " closed "}',
        "{" + REPO + ', "state": "OPEN"}',
        "{" + REPO + ', "state": ""}',
        "{" + REPO + ', "limit": 51}',
        '{"state": "open", "limit": 0}',
    ],
    "get_issue": [
        "{" + REPO + ', "number": 3}',
        "{" + REPO + ', "number": 0}',
        "{" + REPO + ', "number": 1000000000}',
        "{" + REPO + ', "number": 1000000001}',
        "{" + REPO + ', "number": 1.5}',
        "{" + REPO + ', "number": "3"}',
        # Integers beyond 2**53, which Python's int holds: the declared bound is named, not zod's own range.
        "{" + REPO + ', "number": 100000000000000000000}',
        "{" + REPO + ', "number": -100000000000000000000}',
        "{" + REPO + ', "number": 9007199254740993}',
        "{" + REPO + "}",
    ],
    "list_pull_requests": [
        "{" + REPO + ', "state": "all"}',
        "{" + REPO + ', "state": "merged"}',
    ],
    "get_pull_request": [
        "{" + REPO + ', "number": 2}',
        '{"repository": "acme/..", "number": -1}',
    ],
    "read_file": [
        "{" + REPO + "}",
        "{" + REPO + ', "path": "README.md", "ref": "v1.0", "max_chars": 5}',
        "{" + REPO + ', "path": " src/za\\u017c\\u00f3\\u0142\\u0107.py "}',
        "{" + REPO + ', "path": "../other/x"}',
        "{" + REPO + ', "path": "/etc/passwd"}',
        "{" + REPO + ', "path": "a//b"}',
        "{" + REPO + ', "path": "a/./b"}',
        "{" + REPO + ', "path": "a/"}',
        "{" + REPO + ', "path": "a\\tb"}',
        "{" + REPO + ', "path": "a\\rb"}',
        "{" + REPO + ', "path": "../a\\tb"}',
        "{" + REPO + ', "path": "' + "\U0001f600" * 1000 + '"}',
        "{" + REPO + ', "path": "' + "\U0001f600" * 1001 + '"}',
        "{" + REPO + ', "path": "README.md", "ref": "../../x"}',
        "{" + REPO + ', "path": "README.md", "ref": "-flag"}',
        "{" + REPO + ', "path": "README.md", "ref": "main.lock"}',
        "{" + REPO + ', "path": "README.md", "ref": "main/"}',
        "{" + REPO + ', "path": "README.md", "ref": "a//b"}',
        "{" + REPO + ', "path": "README.md", "ref": "/main"}',
        "{" + REPO + ', "path": "README.md", "ref": "feature/x"}',
        "{" + REPO + ', "path": "README.md", "ref": "  "}',
        "{" + REPO + ', "path": "README.md", "ref": "a b"}',
        "{" + REPO + ', "path": "README.md", "ref": null}',
        "{" + REPO + ', "max_chars": 0}',
        "{" + REPO + ', "max_chars": 100001}',
        '{"repository": "acme/..", "path": "a//b", "ref": "-x", "max_chars": 0, "zz": 1}',
    ],
    "create_issue": [
        "{" + REPO + ', "title": "Idea", "body": "Details\\nhere"}',
        "{" + REPO + ', "title": "  Idea  "}',
        "{" + REPO + ', "title": "two\\nlines"}',
        "{" + REPO + ', "title": "tab\\there"}',
        "{" + REPO + ', "title": ""}',
        "{" + REPO + ', "title": "   "}',
        "{" + REPO + ', "title": "' + "t" * 256 + '"}',
        "{" + REPO + ', "title": "' + "t" * 257 + '"}',
        "{" + REPO + ', "title": "' + "\U0001f600" * 256 + '"}',
        "{" + REPO + ', "title": "x", "body": "a\\u0000b"}',
        "{" + REPO + ', "title": "x", "body": "a\\tb\\r\\nc"}',
        "{" + REPO + ', "title": "x", "body": "   "}',
        "{" + REPO + ', "title": "x", "body": null}',
        "{" + REPO + ', "title": "x", "body": "' + "b" * 20001 + '"}',
    ],
    "add_comment": [
        "{" + REPO + ', "number": 3, "body": "Thanks"}',
        "{" + REPO + ', "number": 3, "body": " \\t "}',
        "{" + REPO + ', "number": 3, "body": "a\\u007fb"}',
        "{" + REPO + ', "body": "x"}',
    ],
}


def validated(name: str, text: str):
    raw = json.loads(text)
    try:
        data = MODELS[name].model_validate(raw if raw is not None else {})
    except ValidationError as error:
        return {"message": validation_message(error)}
    return {"fields": data.model_dump()}


def failure(error: OperationError):
    return {"error": [error.code, str(error)]}


LINKS = [
    '<https://api.github.com/repositories/1/issues?per_page=2&after=Y3Vy%3D&page=2>; rel="next", '
    '<https://api.github.com/x?page=9>; rel="last"',
    '<https://api.github.com/x?page=3>;rel="next"',
    '<https://api.github.com/x?page=3>;\t rel="next"',
    '<https://api.github.com/x?page=3>;\x1crel="next"',
    '<https://api.github.com/x?page=3>; rel="last"',
    '<https://api.github.com/x?page=9>; rel="last", <https://api.github.com/x?page=4>; rel="next"',
    '<https://api.github.com/x?page=&after=abc>; rel="next"',
    '<https://api.github.com/x?page=4&page=5>; rel="next"',
    '<https://api.github.com/x?per_page=2>; rel="next"',
    '<https://api.github.com/x#page=2?page=3>; rel="next"',
    '<https://api.github.com/x?page=2#frag>; rel="next"',
    '<https://api.github.com/x?after=a+b%2Bc>; rel="next"',
    '<https://api.github.com/x?after=%E2%82%AC%ZZ%FF>; rel="next"',
    '<https://api.github.com/x?page=2;after=x>; rel="next"',
    '<https://api.github.com/x?page&after=y>; rel="next"',
    '<https://api.github.com/x?a=1&&page=7&>; rel="next"',
    "",
]

SEGMENTS = [
    "acme",
    "za\u017c\u00f3\u0142\u0107.py",
    "a b",
    "~-_.!*'()",
    "a/b",
    "%2e",
    "\U0001f600",
    "a+b&c=d#e?f",
    "...",
]

PAGE_CURSORS = [
    "{}",
    '{"page": "2"}',
    '{"after": "Y3Vy=", "page": "2"}',
    '{"page": 2}',
    '{"page": ""}',
    '{"page": "123456"}',
    '{"page": "1234567"}',
    '{"page": "\\u0663"}',
    '{"page": "\\u00b2"}',
    '{"page": "\\u2460\\u2461"}',
    '{"page": "\\u00bd"}',
    '{"page": "1a"}',
    '{"after": "a\\u0000b"}',
    '{"after": "a b"}',
    '{"after": "a\\u00a0b"}',
    '{"after": "a\\u200bb"}',
    '{"after": "\\ud800"}',
    '{"after": "' + "x" * 500 + '"}',
    '{"after": "' + "x" * 501 + '"}',
    '{"after": "' + "\U0001f600" * 500 + '"}',
    '{"x": "1"}',
    '{"page": "1", "page": "x"}',
    "[1]",
    "null",
    '"page"',
    "nope",
]

# str.isdigit(): decimal digits and the other characters whose numeric type is Digit, not other numerals.
DIGITS = [
    "0123456789",
    "\u0663",
    "\u00b2\u00b3\u00b9",
    "\u2460",
    "\u24ea",
    "\u24ff",
    "\u2080",
    "\u1369",
    "\u19da",
    "\U00010a40",
    "\U0001f100",
    "\U0001d7d9",
    "12\u00b3",
    "\u00bd",
    "\u216b",
    "\u3007",
    "\u0f33",
    "",
    "1a",
    " 1",
    "-1",
]

REPOSITORY_CURSORS = [
    '{"installation": 10, "page": 2}',
    '{"installation": 11, "page": 1, "extra": "x"}',
    "{}",
    '{"installation": 10}',
    '{"installation": 0, "page": 1}',
    '{"installation": 999999999999999, "page": 9999}',
    '{"installation": 1000000000000000, "page": 1}',
    '{"installation": 5, "page": 10000}',
    '{"installation": 5, "page": 0}',
    '{"installation": -5, "page": 1}',
    '{"installation": 11, "page": "1"}',
    '{"installation": true, "page": 1}',
    '{"installation": 3, "page": true}',
    '{"installation": false, "page": 1}',
    '{"installation": null, "page": 1}',
    "[1]",
    '"x"',
    "null",
    "5",
    "not json",
]

BASE64 = [
    "IyBBcHAKSGVsbG8=",
    "IyBBcHAK\nSGVsbG8=\n",
    "YWJj",
    "YWJjZA==",
    "YWJjZA",
    "YWJjZA=",
    "YWJjZA===",
    "YWJjZA==extra",
    "YW=Jj",
    "=YWJj",
    "Y=Q==",
    "YWI=YWI=",
    "Y",
    "YWJjZ",
    "a-b_c",
    "",
    "====",
    "!@#$",
    "YWJj\u00e9",
    # Python 3.14 reads on past padding, which only completes the last group.
    "YWI=Y",
    "YQ==YQ==",
    "YQ=a",
    "YQ===a",
    "YWJj=YQ==",
    "Y==WJj",
    "YWJjZA=\n=",
    "YWJjZA=x=",
    "YWJjZA==\nYQ",
    "Q===",
    "+/z0",
    "//8=",
]


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


FILES = [
    ({"type": "file", "path": "a.txt", "size": 5, "encoding": "base64", "content": b64(b"hello")}, 3),
    (
        {
            "type": "file",
            "path": "a.txt",
            "size": 5,
            "encoding": "base64",
            "content": "aGVs\nbG8=\n",
            "html_url": "u",
        },
        20,
    ),
    (
        {
            "type": "file",
            "path": "bom.txt",
            "size": 5,
            "encoding": "base64",
            "content": b64("\ufeffhi".encode()),
        },
        20,
    ),
    (
        {
            "type": "file",
            "path": "bad.txt",
            "size": 4,
            "encoding": "base64",
            "content": b64(b"\xff\xfeab\xed\xa0\x80"),
        },
        20,
    ),
    (
        {
            "type": "file",
            "path": "emoji.txt",
            "size": 12,
            "encoding": "base64",
            "content": b64(("\U0001f600" * 3).encode()),
        },
        2,
    ),
    ({"type": "file", "path": "bin", "size": 3, "encoding": "base64", "content": b64(b"a\x00b")}, 20),
    ({"type": "dir", "path": "src"}, 20),
    ({"type": "submodule", "path": "vendor"}, 20),
    ({"type": "file", "path": "vendor", "submodule_git_url": "https://github.example/x/y.git"}, 20),
    (
        {
            "type": "file",
            "path": "f",
            "size": 1,
            "encoding": "base64",
            "content": b64(b"x"),
            "submodule_git_url": "",
        },
        20,
    ),
    ({"type": "symlink", "path": "link", "target": "/etc/passwd"}, 20),
    ({"type": "file", "path": "big", "size": 1048577, "encoding": "base64", "content": b64(b"x")}, 20),
    ({"type": "file", "path": "big", "size": 1048576, "encoding": "base64", "content": b64(b"x")}, 20),
    ({"type": "file", "path": "none", "size": 1, "encoding": "none", "content": ""}, 20),
    ({"type": "file", "path": "null", "size": 1, "encoding": "base64", "content": None}, 20),
    ({"type": "file", "path": "pad", "size": 1, "encoding": "base64", "content": "YQ"}, 20),
    ({"type": "file", "path": "ascii", "size": 1, "encoding": "base64", "content": "YQ\u00e9=="}, 20),
]

FORBIDDEN = [
    ({"x-ratelimit-remaining": "0"}, '{"message": "API rate limit exceeded"}'),
    ({}, '{"message": "You have exceeded a secondary rate limit."}'),
    ({"retry-after": "30"}, "{}"),
    ({}, '{"message": "Resource not accessible by integration"}'),
    ({}, '{"message": "Must have admin rights to Repository."}'),
    ({}, "not json"),
    ({}, '[{"message": "rate limit"}]'),
    ({}, '{"message": {"detail": "Rate Limit"}}'),
    ({}, '{"message": ["Not Accessible By Integration"]}'),
    ({}, '{"message": null}'),
    ({"x-ratelimit-remaining": "1"}, "{}"),
    ({}, '\ufeff{"message": "rate limit"}'),
    ({}, ""),
]

FOLDS = [
    ("NOTES", "ada/notes"),
    ("Acme/A", "acme/app"),
    ("\u017f", "acme/s"),
    ("\u00df", "acme/ss"),
    ("\u1e9e", "acme/ss"),
    ("\ufb01", "acme/fix"),
    ("\u212a", "x/k"),
    ("\u0131", "acme/i"),
    ("\u0130", "acme/i"),
    ("\u00e9", "acme/e"),
    ("\uff41", "acme/a"),
    ("-", "a-b/c"),
]

REPOSITORIES = [
    {"id": 1, "full_name": "acme/app", "private": False, "default_branch": "main"},
    {
        "id": 2,
        "full_name": "acme/secret",
        "owner": {"login": "acme"},
        "private": True,
        "description": "Secret things",
        "default_branch": "trunk",
        "html_url": "https://github.example/acme/secret",
        "open_issues_count": 4,
        "archived": True,
        "fork": True,
        "pushed_at": "2026-10-01T10:00:00Z",
        "ignored": {"nested": 1},
    },
]

ISSUES = [
    {"number": 3, "title": "Crash", "state": "open", "body": "x" * 20_001, "comments": 2},
    {"number": 2, "title": "Fix crash", "state": "open", "pull_request": {"url": "u"}, "comments": 0},
    {
        "number": 7,
        "title": "Labels",
        "state": "closed",
        "body": None,
        "user": {"login": "grace"},
        "labels": [{"name": "bug"}, {}],
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
        "closed_at": "2026-01-03T00:00:00Z",
        "html_url": "https://github.example/acme/app/issues/7",
    },
    # 20,001 characters, more UTF-16 units: cut by code point.
    {"number": 8, "user": {}, "body": "\U0001f600" * 4 + "a" * 19_997},
]

COMMENTS = [
    {"id": 7, "body": "Same here", "user": {"login": "grace"}},
    {"id": 8, "body": "+1"},
    {"id": 9, "body": "\U0001f600" * 2 + "y" * 3_999, "created_at": "2026-01-01T00:00:00Z", "html_url": "u"},
    {"id": 10, "body": None, "user": None},
]

PULLS = [
    {"number": 2, "title": "Fix crash", "state": "open", "changed_files": 3, "merged_at": None},
    {
        "number": 5,
        "title": "Merged",
        "state": "closed",
        "merged_at": "2026-01-01T00:00:00Z",
        "draft": True,
        "user": {"login": "ada"},
        "head": {"ref": "feature"},
        "base": {"ref": "main"},
        "body": "b" * 20_001,
        "additions": 10,
        "deletions": 2,
    },
    {"number": 6, "state": "open", "merged_at": "", "head": {}},
]


def main() -> None:
    inputs = [
        {"operation": name, "json": text, **validated(name, text)}
        for name, cases in INPUTS.items()
        for text in cases
    ]

    links = []
    for header in LINKS:
        response = httpx.Response(200, headers={"link": header} if header else {})
        links.append({"link": header, "next": github_client._next(response)})

    segments = [{"value": value, "segment": github_client.segment(value)} for value in SEGMENTS]

    page_cursors = []
    for cursor in PAGE_CURSORS:
        try:
            page_cursors.append({"cursor": cursor, "params": github._page_params(cursor)})
        except OperationError as error:
            page_cursors.append({"cursor": cursor, **failure(error)})
    page_cursors.append({"cursor": None, "params": github._page_params(None)})
    rendered = [
        {"params": params, "cursor": github._cursor(params)}
        for params in ({"page": "2", "after": "Y3Vy="}, {"page": "3"}, {"after": "\u20ac"}, {}, None)
    ]

    digits = [{"text": text, "isdigit": text.isdigit()} for text in DIGITS]

    repository_cursors = []
    for cursor in REPOSITORY_CURSORS:
        try:
            installation, page = github._repositories_cursor(cursor)
            repository_cursors.append({"cursor": cursor, "state": [int(installation), int(page)]})
        except OperationError as error:
            repository_cursors.append({"cursor": cursor, **failure(error)})

    decoded = []
    for text in BASE64:
        try:
            decoded.append({"text": text, "hex": base64.b64decode(text).hex()})
        except ValueError as error:
            decoded.append({"text": text, "error": type(error).__name__})

    files = []
    for entry, max_chars in FILES:
        try:
            files.append(
                {
                    "entry": entry,
                    "max_chars": max_chars,
                    "record": github._file(github.Entry.model_validate(entry), max_chars),
                }
            )
        except OperationError as error:
            files.append({"entry": entry, "max_chars": max_chars, **failure(error)})

    forbidden = []
    for headers, body in FORBIDDEN:
        error = github_client.forbidden("GitHub", httpx.Response(403, headers=headers, content=body.encode()))
        forbidden.append({"headers": headers, "body": body, **failure(error)})

    folds = [
        {"query": query, "name": name, "match": query.casefold() in name.casefold()} for query, name in FOLDS
    ]

    records = {
        "repositories": [
            {
                "data": data,
                "record": github._repository(github_client.Repository.model_validate(data)),
                "item": github._item(github_client.Repository.model_validate(data)).name,
            }
            for data in REPOSITORIES
        ],
        "issues": [
            {
                "data": data,
                "record": github._issue(github_client.Issue.model_validate(data)),
                "with_body": github._issue(github_client.Issue.model_validate(data), body=True),
            }
            for data in ISSUES
        ],
        "comments": [
            {"data": data, "record": github._comment(github_client.Comment.model_validate(data))}
            for data in COMMENTS
        ],
        "pulls": [
            {
                "data": data,
                "record": github._pull(github_client.Pull.model_validate(data)),
                "with_body": github._pull(github_client.Pull.model_validate(data), body=True),
            }
            for data in PULLS
        ],
    }

    declaration = {
        "operations": [
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "mutates": op.mutates,
                "paginated": op.paginated,
                "output_action": op.output_action,
                "consent": op.consent,
                "revision": op.revision,
            }
            for op in github.GitHubConnector.operations
        ],
        "kinds": [
            {
                "id": kind.id,
                "label": kind.label,
                "actions": list(kind.actions),
                "wildcard": kind.wildcard,
                "hierarchical": kind.hierarchical,
            }
            for kind in github.GitHubConnector.kinds
        ],
        "actions": [
            {"id": action.id, "label": action.label, "requires": action.requires}
            for action in github.GitHubConnector.actions
        ],
        "auth": {
            "app": github.GitHubConnector.auth.app,
            "authorize_url": github.GitHubConnector.auth.authorize_url,
            "token_url": github.GitHubConnector.auth.token_url,
            "scopes": list(github.GitHubConnector.auth.scopes),
            "scope_separator": github.GitHubConnector.auth.scope_separator,
            "registration_url": github.GitHubConnector.auth.registration_url,
            "authorize_params": [list(pair) for pair in github.GitHubConnector.auth.authorize_params],
            "login_hint": github.GitHubConnector.auth.login_hint,
            "client_auth": github.GitHubConnector.auth.client_auth,
            "json_body": github.GitHubConnector.auth.json_body,
            "pkce": github.GitHubConnector.auth.pkce,
        },
    }

    vectors = {
        "declaration": declaration,
        "inputs": inputs,
        "links": links,
        "segments": segments,
        "page_cursors": page_cursors,
        "rendered_cursors": rendered,
        "repository_cursors": repository_cursors,
        "digits": digits,
        "base64": decoded,
        "files": files,
        "forbidden": forbidden,
        "folds": folds,
        "records": records,
    }
    (HERE / "vectors.json").write_text(
        json.dumps(vectors, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
