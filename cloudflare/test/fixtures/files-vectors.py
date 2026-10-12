"""Writes files-vectors.json: what today's Python answers for agent files, for src/files/'s tests.

The functions are read from the backend's source rather than restated: manifest.py is loaded whole (with a
stand-in for files.limits, which would load configuration), and the pure functions of runs.py, uploads.py and
gateway/views.py are taken out of their modules' syntax trees and run on their own. Django's
content_disposition_header and urllib's parse_qs are the installed ones.

Run from cloudflare/ with the backend's interpreter:
    ../backend/.venv/bin/python -I test/fixtures/files-vectors.py
(or `cd ../backend && uv run python -I ../cloudflare/test/fixtures/files-vectors.py`).
"""

import ast
import base64
import importlib.util
import json
import os
import sys
import types
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs

from django.utils.http import content_disposition_header

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"


class QuotaExceeded(Exception):
    def __init__(self, limit: str) -> None:
        super().__init__(f"The {limit} limit would be exceeded.")
        self.limit = limit


def load_manifest():
    files = types.ModuleType("files")
    limits = types.ModuleType("files.limits")
    limits.QuotaExceeded = QuotaExceeded
    sys.modules["files"], sys.modules["files.limits"] = files, limits
    spec = importlib.util.spec_from_file_location("files.manifest", BACKEND / "files" / "manifest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extract(relative: str, names: set[str], namespace: dict) -> dict:
    """Runs the module-level definitions named `names` of a backend file in `namespace`."""
    tree = ast.parse((BACKEND / relative).read_text())
    found = set()
    for node in tree.body:
        name = None
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        if name in names:
            exec(compile(ast.Module([node], []), relative, "exec"), namespace)
            found.add(name)
    missing = names - found
    if missing:
        raise SystemExit(f"Not in {relative}: {sorted(missing)}")
    return namespace


manifest = load_manifest()
runs = extract(
    "files/runs.py",
    {"WARNING_REASONS", "WARNINGS_KEPT", "WARNING_PATH_CHARS", "CHANGES_KEPT", "parse_warnings", "folder_changes", "_directories"},
    {"unicodedata": unicodedata, "InvalidManifest": manifest.InvalidManifest},
)
uploads = extract(
    "files/uploads.py",
    {"MAX_EXTENSION_CHARS", "ZIP_TYPES", "TEXT_TYPES", "clean_name", "numbered", "_split", "_fit", "sniff", "_is_text", "size_text"},
    {"unicodedata": unicodedata, "os": os, "MAX_SEGMENT_BYTES": manifest.MAX_SEGMENT_BYTES},
)
views = extract("gateway/views.py", {"_mib"}, {})

A, B, C = "a" * 64, "b" * 64, "c" * 64


def file(path, sha256=A, mode=0o644, mtime=0):
    return {"path": path, "sha256": sha256, "mode": mode, "mtime": mtime}


def outcome(call):
    try:
        return {"ok": call()}
    except manifest.InvalidManifest as error:
        return {"invalid": str(error)}
    except QuotaExceeded as error:
        return {"quota": error.limit}


def parsed(data, max_entries):
    result = manifest.parse(data, max_entries=max_entries)
    return {
        "files": {path: [entry.sha256, entry.mode, entry.mtime] for path, entry in result.files.items()},
        "dirs": list(result.dirs),
        "entry_count": result.entry_count,
        "hashes": sorted(result.hashes),
    }


MANIFESTS = [
    ({"files": [file("docs/a/x.txt"), file("docs/b.txt", B)], "dirs": ["empty"]}, 10),
    *(
        ({"files": [file(path)], "dirs": []}, 10)
        for path in [
            "/abs", "a//b", "a/", "./a", "a/../b", "..", ".", "", "a\x00b", "a\nb", "a\x7fb", "a\x85b", "e\u0301",
            "\udcff", "\ud83d", "x" * 256, "/".join(["d"] * 33), "/".join(["x" * 200] * 6), 7, None, ["a"],
            "a\u202eb", "\ufeffbom", "a b", "Ünïcödé", "\U0001f600/\U0001f600", "a\\b", "a'b", 'a"b', "a'\"b",
            "x" * 255, "é" * 127, "é" * 128, "/".join(["d"] * 32), "/".join(["x" * 200] * 5) + "/" + "x" * 23,
            "/".join(["x" * 200] * 5) + "/" + "x" * 24, "\u2028", "\U000e0001",
        ]
    ),
    ({"files": [file("/".join(["d"] * 32)), file("é" * 127)], "dirs": []}, 100),
    ([], 10),
    ({"files": []}, 10),
    ({"files": [], "dirs": [], "extra": 1}, 10),
    ({"files": {}, "dirs": []}, 10),
    ({"files": [], "dirs": {}}, 10),
    ({"files": [file("a") | {"size": 1}], "dirs": []}, 10),
    ({"files": [{"path": "a", "sha256": A, "mode": 420}], "dirs": []}, 10),
    ({"files": ["a"], "dirs": []}, 10),
    ({"files": [file("a", sha256="A" * 64)], "dirs": []}, 10),
    ({"files": [file("a", sha256="a" * 63)], "dirs": []}, 10),
    ({"files": [file("a", sha256=None)], "dirs": []}, 10),
    ({"files": [file("a", mode=0o777)], "dirs": []}, 10),
    ({"files": [file("a", mode=True)], "dirs": []}, 10),
    ({"files": [file("a", mode="420")], "dirs": []}, 10),
    ({"files": [file("a", mode=493)], "dirs": []}, 10),
    ({"files": [file("a", mtime=-1)], "dirs": []}, 10),
    ({"files": [file("a", mtime=1.5)], "dirs": []}, 10),
    ({"files": [file("a", mtime=False)], "dirs": []}, 10),
    ({"files": [file("a", mtime=manifest.MAX_MTIME)], "dirs": []}, 10),
    ({"files": [file("a", mtime=manifest.MAX_MTIME + 1)], "dirs": []}, 10),
    ({"files": [file("a"), file("a", B)], "dirs": []}, 10),
    ({"files": [file("a")], "dirs": ["a"]}, 10),
    ({"files": [], "dirs": ["a", "a"]}, 10),
    ({"files": [], "dirs": ["a/", "b"]}, 10),
    ({"files": [file("a"), file("a/b")], "dirs": []}, 10),
    ({"files": [file("a/b"), file("a")], "dirs": []}, 10),
    ({"files": [file("a/b")], "dirs": ["a"]}, 10),
    ({"files": [], "dirs": ["a/b", "a"]}, 10),
    ({"files": [file("a/b/c/d.txt")], "dirs": []}, 4),
    ({"files": [file("a/b/c/d.txt")], "dirs": []}, 3),
    ({"files": [{"path": None}] * 11, "dirs": []}, 10),
    ({"files": [], "dirs": ["x"] * 11}, 10),
    ({"files": [file("a/b/c"), file("x/y")], "dirs": ["z"]}, 6),
    ({"files": [file("a/b/c"), file("x/y")], "dirs": ["z"]}, 7),
    ({"files": [file("a/b/c"), file("a/x/../c")], "dirs": []}, 10),
    ({"files": [file("b", B), file("a/b"), file("\U0001f600"), file("\ue000"), file("Z")], "dirs": ["\uffff", "é"]}, 20),
]

DIGESTS = [
    ({"files": [file("a"), file("b", B)], "dirs": ["z", "y"]}, {A: 1, B: 4097}),
    ({"files": [file("b", B), file("a")], "dirs": ["y", "z"]}, {A: 1, B: 4097}),
    ({"files": [], "dirs": []}, {}),
    (
        {
            "files": [
                file("é.txt", B, 0o755, 1700000000500),
                file("\U0001f600/x", C, 0o644, manifest.MAX_MTIME),
                file("\ufeffbom.txt", A, 0o644, 1),
                file("\ue000", A),
                file('q"uote', B),
                file("back\\slash", C),
                file("a\u2028b", A),
            ],
            "dirs": ["empty", "x/y", "\U0001f601"],
        },
        {A: 0, B: 4096, C: 5000},
    ),
]


def digested(data, sizes):
    result = manifest.parse(data, max_entries=100)
    entries = manifest.stored_entries(result, sizes)
    return {
        "entries": entries,
        "folder_bytes": manifest.folder_bytes([entries["files"][p]["size"] for p in entries["files"]]),
    }


def entries(files, dirs=()):
    return {"files": {p: {"sha256": s, "mode": m, "size": z} for p, (s, m, z) in files.items()}, "dirs": list(dirs)}


CHANGES = [
    (
        entries({"a.txt": ("1", 0o644, 1), "b.txt": ("2", 0o644, 1), "sub/c.txt": ("3", 0o644, 1)}, ["empty/inner"]),
        entries({"a.txt": ("1", 0o755, 1), "b.txt": ("2", 0o644, 1), "new/deep/d.txt": ("4", 0o644, 1)}, ["x/y"]),
    ),
    (None, entries({"a": ("1", 0o644, 5)})),
    (None, entries({})),
    (entries({"a": ("1", 0o644, 5)}), entries({"a": ("1", 0o644, 9)})),
    (entries({"a": ("1", 0o644, 5)}), entries({"a": ("2", 0o644, 9)})),
    (entries({"\U0001f600": ("1", 0o644, 5), "\ue000": ("1", 0o644, 5)}), entries({"z/\U0001f600": ("1", 0o644, 5), "z/\ue000": ("2", 0o644, 2)})),
    (entries({f"f{i:03}": ("1", 0o644, i) for i in range(150)}, [f"d{i:03}" for i in range(120)]), entries({f"g{i:03}/x": ("1", 0o644, i) for i in range(130)})),
]

WARNINGS = [
    {"total": 3, "items": [{"path": "link", "reason": "symlink"}, {"path": "a\ufffdb", "reason": "invalid_name"}]},
    {"total": 0, "items": []},
    [],
    {"total": 0},
    {"total": 0, "items": [], "more": 1},
    {"total": True, "items": []},
    {"total": 1.0, "items": []},
    {"total": 0, "items": [{"path": "a", "reason": "symlink"}]},
    {"total": 2**31, "items": []},
    {"total": 2**31 - 1, "items": []},
    {"total": -1, "items": []},
    {"total": 101, "items": [{"path": "a", "reason": "symlink"}] * 101},
    {"total": 100, "items": [{"path": "a", "reason": "special"}] * 100},
    {"total": 1, "items": [{"path": "a", "reason": "deleted"}]},
    {"total": 1, "items": [{"path": "a", "reason": []}]},
    {"total": 1, "items": [{"path": "a", "reason": {}}]},
    {"total": 1, "items": [{"path": "a", "reason": "symlink", "size": 1}]},
    {"total": 1, "items": [{"path": "", "reason": "symlink"}]},
    {"total": 1, "items": [{"path": "a\nb", "reason": "symlink"}]},
    {"total": 1, "items": [{"path": "a\x85b", "reason": "symlink"}]},
    {"total": 1, "items": [{"path": "a\ud800b", "reason": "symlink"}]},
    {"total": 1, "items": [{"path": "a\u202eb\ufeff", "reason": "invalid_name"}]},
    {"total": 1, "items": [{"path": "a" * 1025, "reason": "too_long"}]},
    {"total": 1, "items": [{"path": "a" * 1024, "reason": "too_long"}]},
    {"total": 1, "items": [{"path": "\U0001f600" * 1024, "reason": "too_deep"}]},
    {"total": 1, "items": [{"path": 1, "reason": "symlink"}]},
    {"total": 1, "items": ["a"]},
    {"total": 1, "items": {}},
    {"total": 6, "items": [{"path": p, "reason": r} for p, r in zip("abcdef", sorted(runs["WARNING_REASONS"]))]},
]

CLEAN = [
    "report.pdf", "C:\\Users\\ada\\report.pdf", "../../etc/passwd", "..", ".", "", "  ", "evil\u202egnp.exe", "a\nb.txt",
    "Cafe\u0301.txt", "x" * 300 + ".txt", "../Q3 report.pdf", "a\ud800b.txt", "\u2028line\u2029", "\ufeffbom.txt",
    "é" * 200 + ".txt", "\U0001f600" * 100 + ".png", "name." + "e" * 15, "name." + "e" * 16, ".bashrc", "...",
    "a" * 254 + "\u0301", "trailing \u3000", "\x00\x01", "x" * 260, "a.b" + "c" * 300, "\U0001f600" * 70,
    " x.txt ", "x.tar.gz", "e\u0301" * 100 + ".txt", "x" * 250 + "     .txt",
]

NUMBERED = [
    ("a.txt", []),
    ("a.txt", ["a.txt", "a (2).txt"]),
    ("archive.tar.gz", ["archive.tar.gz"]),
    ("README", ["README"]),
    ("x" * 251 + ".txt", ["x" * 251 + ".txt"]),
    (".bashrc", [".bashrc"]),
    ("e\u0301", ["e\u0301"]),
    ("é" * 127, ["é" * 127]),
    ("\U0001f600" * 63 + ".txt", ["\U0001f600" * 63 + ".txt"]),
    ("a", ["a"] + [f"a ({n})" for n in range(2, 12)]),
    ("name." + "e" * 15, ["name." + "e" * 15]),
    ("x" * 250 + "     .txt", ["x" * 250 + "     .txt"]),
]

SNIFF = [
    (b"%PDF-1.7", "a.txt"),
    (b"\x89PNG\r\n\x1a\n", "a.pdf"),
    (b"\xff\xd8\xff\xe0", "a.bin"),
    (b"GIF87a", "a"),
    (b"GIF89a....", "a"),
    (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "a"),
    (b"RIFF\x00\x00\x00\x00WAVE", "a.wav"),
    (b"PK\x03\x04", "a.docx"),
    (b"PK\x03\x04", "a.DOCX"),
    (b"PK\x03\x04", "a.xlsx"),
    (b"PK\x03\x04", "a.pptx"),
    (b"PK\x03\x04", "a.odt"),
    (b"PK\x03\x04", "a.ods"),
    (b"PK\x03\x04", "a.zip"),
    (b"\x1f\x8b\x08", "a.gz"),
    (b"a,b\n1,2\n", "a.csv"),
    (b'{"a": 1}', "a.json"),
    (b"# Title", "a.md"),
    (b"a\tb", "a.tsv"),
    (b"a\tb", ".tsv"),
    (b"plain", "a.TXT"),
    ("zażółć".encode()[:-1], "a.txt"),
    (b"a\0b", "a.txt"),
    (b"<html><script>", "a.html"),
    (b"", "empty"),
    (b"\xff", "a"),
    (b"\xff\xff", "a"),
    (b"\xff\xff\xff", "a"),
    (b"\xff\xff\xff\xff", "a"),
    (b"ok\xff\xff\xff", "a"),
    (b"ok\xff\xff\xff\xff", "a"),
    ("\U0001f600".encode()[:2], "a"),
    (b"\xed\xa0\x80", "a"),
    (b"abc\xed\xa0\x80", "a"),
    (b"\xc0\xaf", "a"),
    (b"x" * 10, "a..csv"),
    (b"x", "..csv"),
    (b"x", "a.tar.json"),
]

CONTENT_DISPOSITION = [
    "report.html", "zażółć report.html", 'q"uote', "back\\slash", "tab\there", "a\n", "a\nb", "~!@#$%^&*()_+`-={}|[]:;'<>?,./",
    "\U0001f600.png", "\x7f", "100%", "a b", "\u00e9", "line\u2028", "",
]

QUERIES = [
    "name=report.pdf", "name=Q3+report.pdf", "name=Q3%20report.pdf", "name=%E2%82%AC.txt", "name=%E2%82.txt",
    "name=%ff", "name=a&name=b", "name=", "name=&name=a", "", "other=1", "name", "name=a%", "name=%zz",
    "%6Eame=a", "name=a=b", "name=a;b", "a=1&name=x&b=2", "name=%00", "name=%C3%A9&x", "&&name=a&&",
]


def ascii_query_names(query: str):
    try:
        names = parse_qs(query.encode().decode("ascii"), errors="strict").get("name")
    except UnicodeDecodeError:
        names = None
    return names


def main() -> None:
    out = {
        "manifest": [{"data": data, "max_entries": limit, "outcome": outcome(lambda: parsed(data, limit))} for data, limit in MANIFESTS],
        "digest": [{"data": data, "sizes": sizes, **digested(data, sizes)} for data, sizes in DIGESTS],
        "folder_bytes": [{"sizes": sizes, "bytes": manifest.folder_bytes(sizes)} for sizes in ([0, 1, 4096, 4097], [], [8192, 1])],
        "folder_changes": [{"before": before, "after": after, "changes": runs["folder_changes"](before, after)} for before, after in CHANGES],
        "warnings": [{"data": data, "outcome": outcome(lambda: runs["parse_warnings"](data))} for data in WARNINGS],
        "clean_name": [{"raw": raw, "clean": uploads["clean_name"](raw)} for raw in CLEAN],
        "numbered": [{"name": name, "taken": taken, "numbered": uploads["numbered"](name, set(taken))} for name, taken in NUMBERED],
        "sniff": [{"head": base64.b64encode(head).decode(), "name": name, "media_type": uploads["sniff"](head, name)} for head, name in SNIFF],
        "size_text": [{"bytes": n, "text": uploads["size_text"](n)} for n in (52_428_800, 268_435_456, 2**30, 3 * 2**30 // 2, 10, 1_000_000, 2**40, 3)],
        "mib": [{"bytes": n, "text": views["_mib"](n)} for n in (2**20, 268_435_456, 2**30, 2**20 - 1, 3 * 2**19, 5 * 2**19, 7 * 2**19, 1, 0)],
        "content_disposition": [{"name": name, "header": content_disposition_header(True, name)} for name in CONTENT_DISPOSITION],
        "query_names": [{"query": query, "names": ascii_query_names(query)} for query in QUERIES],
        "unicode": unicodedata.unidata_version,
    }
    target = HERE / "files-vectors.json"
    target.write_text(json.dumps(out, indent=1) + "\n")
    print(f"Wrote {target.relative_to(HERE.parents[1])}")


main()
