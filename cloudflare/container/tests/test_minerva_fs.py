"""Unit tests for minerva-fs, run as `python3 -I -m unittest discover -s container/tests` (vitest runs them
from test/unit/sandbox-python.test.ts, with the image's Python in Docker as well when it is available).

The scan cases are worker/test/folder.test.ts's, ported case by case; the file operation cases follow
WorkspaceEnv's FIFO-safe semantics and pi's error codes. Each case runs the helper as a separate process,
as the sandbox does."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FS = os.path.join(HERE, "..", "minerva", "minerva-fs")
LINUX = sys.platform.startswith("linux")
MAX_DEPTH = 32
LIMITS = {"bytes": 100 * 1024 * 1024, "entries": 10_000}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def run(op, *arguments, stdin=b"", timeout=10):
    """Runs one operation; returns (exit status, the first JSON line or None, the bytes after it, stderr)."""
    process = subprocess.run(
        [sys.executable, "-I", "-S", FS, op, *[str(argument) for argument in arguments]],
        input=stdin,
        capture_output=True,
        timeout=timeout,
    )
    line, _, rest = process.stdout.partition(b"\n")
    try:
        head = json.loads(line) if line else None
    except ValueError:
        head = None
    return process.returncode, head, rest, process.stderr


def value(op, *arguments, stdin=b""):
    status, head, _, stderr = run(op, *arguments, stdin=stdin)
    if status != 0 or not head or not head.get("ok"):
        raise AssertionError(f"{op} failed: {status} {head} {stderr!r}")
    return head["value"]


def refused(op, *arguments, stdin=b""):
    status, head, _, stderr = run(op, *arguments, stdin=stdin)
    if status != 0 or not head or head.get("ok"):
        raise AssertionError(f"{op} did not refuse: {status} {head} {stderr!r}")
    return head["code"], head["message"]


def lines(data):
    return [json.loads(line) for line in data.split(b"\n") if line]


def scan(root, index=None, limits=LIMITS, rehash_all=False):
    """The scan's lines put back together: files, dirs, warnings and the index, as the Sandbox reads them."""
    request = {"root": root, "bytes": limits["bytes"], "entries": limits["entries"], "rehashAll": rehash_all, "index": index or []}
    status, head, rest, stderr = run("scan", stdin=json.dumps(request).encode())
    if status != 0 or head is None:
        raise AssertionError(f"scan crashed: {status} {stderr!r}")
    if not head.get("ok"):
        return head
    body = lines(rest)
    files = body[: head["files"]]
    dirs = body[head["files"] : head["files"] + head["dirs"]]
    items = body[head["files"] + head["dirs"] :]
    if len(items) != head["warnings"]["items"]:
        raise AssertionError("the scan's lines do not match its header")
    return {
        "ok": True,
        "files": [line[:5] for line in files],
        "dirs": dirs,
        "warnings": {"total": head["warnings"]["total"], "items": items},
        "index": [[line[0], line[4], line[5], line[6], line[7], line[8], line[1], line[3], line[9]] for line in files],
    }


class Case(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="minerva-fs-")
        self.base = os.path.realpath(self.directory.name)
        self.root = os.path.join(self.base, "workspace")

    def tearDown(self):
        for current, dirs, _ in os.walk(self.base):
            for name in dirs:
                try:
                    os.chmod(os.path.join(current, name), 0o755)
                except OSError:
                    pass
        self.directory.cleanup()

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def write(self, relative, data=b""):
        path = self.path(relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as file:
            file.write(data)
        return path


class FileOperations(Case):
    def test_write_creates_parents_and_truncates(self):
        path = self.path("a", "b", "c.txt")
        self.assertIsNone(value("write", path, "write", stdin=b"hello world"))
        self.assertIsNone(value("write", path, "write", stdin=b"short"))
        with open(path, "rb") as file:
            self.assertEqual(file.read(), b"short")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o644)
        self.assertIsNone(value("write", path, "append", stdin=b"+more"))
        with open(path, "rb") as file:
            self.assertEqual(file.read(), b"short+more")

    def test_info_exists_and_codes(self):
        path = self.write("x.txt", b"12345")
        info = value("info", path)
        self.assertEqual({key: info[key] for key in ("name", "path", "kind", "size")}, {"name": "x.txt", "path": path, "kind": "file", "size": 5})
        self.assertAlmostEqual(info["mtimeMs"], os.stat(path).st_mtime_ns / 1e6, places=3)
        self.assertTrue(value("exists", path))
        self.assertFalse(value("exists", self.path("missing")))
        code, message = refused("info", self.path("missing"))
        self.assertEqual(code, "not_found")
        self.assertEqual(message, f"ENOENT: no such file or directory, lstat '{self.path('missing')}'")
        self.assertEqual(refused("exists", self.path("x.txt", "below"))[0], "not_directory")
        os.symlink("nowhere", self.path("dangling"))
        self.assertTrue(value("exists", self.path("dangling")))
        self.assertEqual(value("info", self.path("dangling"))["kind"], "symlink")

    def test_fifos_never_hang_and_are_refused(self):
        os.makedirs(self.root)
        fifo = self.path("pipe")
        os.mkfifo(fifo)
        started = time.monotonic()
        self.assertEqual(refused("read-text", fifo, 1000), ("invalid", "Not a regular file"))
        self.assertEqual(refused("write", fifo, "write", stdin=b"x")[0], "invalid")
        self.assertEqual(refused("reader", fifo, 0), ("invalid", "Not a regular file"))
        self.assertEqual(refused("exists", fifo), ("invalid", "Unsupported file type"))
        self.assertEqual(refused("info", fifo), ("invalid", "Unsupported file type"))
        self.assertLess(time.monotonic() - started, 5)

    def test_a_socket_is_invalid_for_text_and_unknown_elsewhere(self):
        # WorkspaceEnv maps ENXIO (opening a socket) to "invalid" for the text reads and writes it overrides;
        # pi's other operations map it to "unknown".
        import socket

        os.makedirs(self.root)
        path = self.path("sock")
        server = socket.socket(socket.AF_UNIX)
        server.bind(path)
        try:
            self.assertEqual(refused("read-text", path, 100)[0], "invalid")
            self.assertEqual(refused("write", path, "write", stdin=b"x")[0], "invalid")
            self.assertEqual(refused("write", path, "append", stdin=b"x")[0], "unknown")
            self.assertEqual(refused("truncate", path, 0)[0], "unknown")
            self.assertEqual(refused("info", path), ("invalid", "Unsupported file type"))
        finally:
            server.close()

    def test_snapshot_signs_the_watched_paths(self):
        self.write("skills/a/SKILL.md", b"one")
        self.write("skills/.hidden/x", b"x")
        self.write("skills/node_modules/dep/SKILL.md", b"dep")
        self.write("data/real.md", b"real")
        os.symlink("data/real.md", self.path("link.md"))
        targets = [
            {"path": self.path("skills"), "recursive": True, "exclude": {"hidden": True, "names": ["node_modules"]}},
            {"path": self.path("link.md")},
            {"path": self.path("missing.md")},
        ]
        snapshot = value("snapshot", stdin=json.dumps({"targets": targets, "maxEntries": 100}).encode())
        self.assertEqual(sorted(snapshot["entries"]), [self.path("link.md"), self.path("skills"), self.path("skills/a"), self.path("skills/a/SKILL.md")])
        self.assertTrue(snapshot["entries"][self.path("link.md")].startswith("l:data/real.md:f:4:"))
        self.write("data/real.md", b"changed")
        again = value("snapshot", stdin=json.dumps({"targets": targets, "maxEntries": 100}).encode())
        self.assertNotEqual(again["entries"][self.path("link.md")], snapshot["entries"][self.path("link.md")])
        self.assertEqual(again["entries"][self.path("skills/a/SKILL.md")], snapshot["entries"][self.path("skills/a/SKILL.md")])
        self.assertEqual(value("snapshot", stdin=json.dumps({"targets": targets, "maxEntries": 2}).encode()), {"overflow": True})

    def test_a_server_answers_as_each_operation_alone_would(self):
        path = self.path("served", "x.txt")
        requests = [
            ({"op": "write", "args": [path, "write"], "stdin": 5}, b"hello"),
            ({"op": "read-text", "args": [path, 100], "stdin": 0}, b""),
            ({"op": "exists", "args": [self.path("missing")], "stdin": 0}, b""),
            ({"op": "info", "args": [self.path("missing")], "stdin": 0}, b""),
            ({"op": "reader", "args": [path, "0"], "stdin": 0}, b""),
            ({"op": "exists", "args": [], "stdin": 0}, b""),
        ]
        stdin = b"".join(json.dumps(request).encode() + b"\n" + data for request, data in requests)
        process = subprocess.run([sys.executable, "-I", "-S", FS, "serve"], input=stdin, capture_output=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)
        answers = []
        rest = process.stdout
        while rest:
            line, _, rest = rest.partition(b"\n")
            length = json.loads(line)["length"]
            answers.append(rest[:length])
            rest = rest[length:]
        self.assertEqual(answers[0], b'{"ok":true,"value":null}\n')
        self.assertEqual(answers[1], b'{"ok":true,"value":{"length":5}}\nhello')
        self.assertEqual(answers[2], b'{"ok":true,"value":false}\n')
        self.assertEqual(json.loads(answers[3])["code"], "not_found")
        # Readers, scans and the like run in processes of their own.
        self.assertEqual(json.loads(answers[4]), {"ok": False, "code": "unknown", "message": "reader is not served"})
        self.assertEqual(json.loads(answers[5])["code"], "unknown")

    def test_read_text_and_directories(self):
        path = self.write("t.txt", b"\xef\xbb\xbfhi\xff")
        status, head, rest, _ = run("read-text", path, 100)
        self.assertEqual((status, head), (0, {"ok": True, "value": {"length": 6}}))
        self.assertEqual(rest, b"\xef\xbb\xbfhi\xff")
        self.assertEqual(refused("read-text", self.root, 100), ("is_directory", "Is a directory"))
        self.assertEqual(refused("read-text", path, 5)[0], "unknown")
        self.assertEqual(refused("read-text", self.path("missing"), 5)[0], "not_found")

    def test_reader_reads_ranges_and_keeps_its_file(self):
        path = self.write("a.txt", b"one")
        requests = [
            {"op": "read", "offset": 0, "length": 2},
            {"op": "stat"},
            {"op": "read", "offset": 1, "length": 100},
            {"op": "read", "offset": 50, "length": 1},
            {"op": "read", "offset": -1, "length": 1},
            {"op": "read", "offset": 0, "length": 1.5},
            {"op": "scan", "start": 2, "end": 2},
        ]
        process = subprocess.Popen([sys.executable, "-I", "-S", FS, "reader", path, "0"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        out = process.stdout
        opened = json.loads(out.readline())
        self.assertEqual(opened["value"]["size"], 3)
        os.rename(path, self.path("b.txt"))
        self.write("a.txt", b"two!")
        answers = []
        for request in requests:
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.flush()
            head = json.loads(out.readline())
            body = out.read(head["value"]["length"]) if head.get("ok") and request["op"] == "read" else None
            answers.append((head, body))
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), 0)
        process.stdout.close()
        self.assertEqual(answers[0][1], b"on")
        self.assertEqual(answers[1][0]["value"]["size"], 3)
        self.assertEqual(answers[2][1], b"ne")
        self.assertEqual(answers[3][1], b"")
        self.assertEqual(answers[4][0]["code"], "invalid")
        self.assertEqual(answers[5][0]["code"], "invalid")
        self.assertEqual(answers[6][0], {"ok": False, "code": "invalid", "message": "Invalid line range"})

    def test_reader_refuses_directories_and_final_symlinks(self):
        os.makedirs(self.path("dir"))
        self.write("target.txt", b"t")
        os.symlink("target.txt", self.path("link.txt"))
        self.assertEqual(refused("reader", self.path("dir"), 0), ("is_directory", "EISDIR: illegal operation on a directory, read"))
        self.assertEqual(refused("reader", self.path("missing"), 0)[0], "not_found")
        self.assertEqual(refused("reader", self.path("link.txt"), 1), ("invalid", "Refusing to follow a symbolic link"))
        status, head, _, _ = run("reader", self.path("link.txt"), 0)
        self.assertEqual((status, head["ok"]), (0, True))

    def test_reader_scans_lines(self):
        data = bytes([0xEF, 0xBB, 0xBF, 0x61, 0x0A, 0xE2, 0x82, 0x0A, 0x0A, 0xEF, 0xBB, 0xBF, 0x62, 0x0A, 0xC3, 0xA9])
        path = self.write("lines.txt", data)
        lines = data.decode("utf-8", "replace")[1:].split("\n")
        process = subprocess.Popen([sys.executable, "-I", "-S", FS, "reader", path, "0"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        json.loads(process.stdout.readline())
        for start, end in [(0, None), (0, 1), (1, 3), (2, 3), (3, None), (4, 9)]:
            process.stdin.write(json.dumps({"op": "scan", "start": start, "end": end}).encode() + b"\n")
            process.stdin.flush()
            scanned = json.loads(process.stdout.readline())["value"]
            selected = lines[start:end]
            self.assertEqual(scanned["newlines"], len(lines) - 1)
            piece = data[scanned["start"] : scanned["end"]]
            if scanned["start"] == 0:
                piece = piece[3:]
            self.assertEqual(piece.decode("utf-8", "replace"), "\n".join(selected))
            self.assertEqual(scanned["selectedBytes"], len("\n".join(selected).encode()))
            self.assertEqual(scanned["firstLineBytes"], len(lines[start].encode()))
        process.stdin.close()
        process.wait(timeout=5)
        process.stdout.close()

    def test_list_pages_in_byte_order(self):
        for name in ["c", "a", "b", "é", "d"]:
            self.write(name, name.encode())
        os.makedirs(self.path("sub"))
        os.mkfifo(self.path("pipe"))
        names = []
        cursor = ""
        for _ in range(10):
            page = value("list", self.root, cursor, 2)
            self.assertLessEqual(len(page["entries"]), 2)
            names.extend(entry["name"] for entry in page["entries"])
            if page["next"] is None:
                break
            cursor = page["next"]
        self.assertEqual(names, ["a", "b", "c", "d", "sub", "é"])
        self.assertEqual(refused("opendir", self.path("a"))[0], "not_directory")
        self.assertEqual(refused("opendir", self.path("missing"))[0], "not_found")
        self.assertIsNone(value("opendir", self.root))

    def test_mkdir_remove_rename_truncate_flush(self):
        self.assertIsNone(value("mkdir", self.path("x", "y"), 1))
        self.assertEqual(refused("mkdir", self.path("x", "y"), 0)[0], "unknown")
        self.write("x/y/f", b"abc")
        self.assertEqual(refused("remove", self.path("x"), 0, 0)[0], "unknown")
        self.assertIsNone(value("remove", self.path("missing"), 0, 1))
        self.assertEqual(refused("remove", self.path("missing"), 0, 0)[0], "not_found")
        self.assertIsNone(value("truncate", self.path("x", "y", "f"), 10))
        self.assertEqual(os.stat(self.path("x", "y", "f")).st_size, 10)
        self.assertIsNone(value("flush", self.path("x", "y", "f")))
        self.assertEqual(refused("flush", self.path("x"))[0], "is_directory")
        self.assertIsNone(value("rename", self.path("x", "y", "f"), self.path("g")))
        code, message = refused("rename", self.path("nope"), self.path("g2"))
        self.assertEqual(code, "not_found")
        self.assertEqual(message, f"ENOENT: no such file or directory, rename '{self.path('nope')}' -> '{self.path('g2')}'")
        self.assertIsNone(value("remove", self.path("x"), 1, 0))
        self.assertFalse(os.path.exists(self.path("x")))
        self.assertEqual(value("canonical", self.path("g")), self.path("g"))

    def test_spill_appends(self):
        os.makedirs(self.root)
        path = self.write("spill.log")
        self.assertIsNone(value("spill", path, stdin=b"a" * 100_000))
        self.assertIsNone(value("spill", path, stdin=b"b"))
        self.assertEqual(os.path.getsize(path), 100_001)


class Scan(Case):
    def test_lists_files_and_empty_directories_in_code_point_order(self):
        os.makedirs(self.path("a", "sub"))
        os.makedirs(self.path("empty"))
        self.write("a/x.txt", b"x")
        self.write("b.txt", b"b")
        self.write("é.txt", b"e")
        self.write("Z.sh", b"z")
        self.write("﻿bom.txt", b"bom")
        os.chmod(self.path("Z.sh"), 0o700)
        os.utime(self.path("b.txt"), ns=(1_700_000_000_500_000_000, 1_700_000_000_500_000_000))
        scanned = scan(self.root)
        self.assertTrue(scanned["ok"])
        self.assertEqual([file[0] for file in scanned["files"]], ["Z.sh", "a/x.txt", "b.txt", "é.txt", "﻿bom.txt"])
        self.assertEqual(scanned["dirs"], ["a/sub", "empty"])
        self.assertEqual(scanned["warnings"], {"total": 0, "items": []})
        by_path = {file[0]: file for file in scanned["files"]}
        self.assertEqual(by_path["Z.sh"][2], 0o755)
        self.assertEqual(by_path["b.txt"][2], 0o644)
        self.assertEqual(by_path["b.txt"][3], 1_700_000_000_500)
        self.assertEqual(by_path["b.txt"][1], sha256(b"b"))
        self.assertEqual(by_path["b.txt"][4], 1)

    def test_skips_what_the_manifest_refuses_and_says_why(self):
        self.write("kept.txt", b"kept")
        os.symlink("kept.txt", self.path("link"))
        os.mkfifo(self.path("pipe"))
        self.write("tab\there")
        self.write("café")
        deep = self.path(*(["n"] * MAX_DEPTH))
        os.makedirs(deep)
        self.write("/".join(["n"] * MAX_DEPTH) + "/deep.txt")
        scanned = scan(self.root)
        self.assertEqual([file[0] for file in scanned["files"]], ["kept.txt"])
        self.assertEqual(scanned["dirs"], ["/".join(["n"] * MAX_DEPTH)])
        items = [[path[:12], reason] for path, reason in scanned["warnings"]["items"]]
        self.assertEqual(
            items,
            [["café", "invalid_name"], ["link", "symlink"], ["n/n/n/n/n/n/", "too_deep"], ["pipe", "special"], ["tab�here", "invalid_name"]],
        )
        self.assertEqual(scanned["warnings"]["total"], 5)

    @unittest.skipUnless(LINUX, "macOS limits paths to 1024 bytes")
    def test_skips_a_path_longer_than_1024_bytes(self):
        long = self.path(*(["d" * 250] * 4))
        os.makedirs(long)
        open(os.path.join(long, "x" * 20), "wb").close()
        open(os.path.join(long, "x" * 21), "wb").close()
        scanned = scan(self.root)
        self.assertEqual([len(file[0].encode()) for file in scanned["files"]], [1024])
        self.assertEqual([[len(path), path[-1], reason] for path, reason in scanned["warnings"]["items"]], [[1024, "…", "too_long"]])

    @unittest.skipUnless(LINUX, "APFS refuses names that are not UTF-8")
    def test_skips_a_name_that_is_not_utf8(self):
        os.makedirs(self.root)
        open(os.fsencode(self.root) + b"/f\xff", "wb").close()
        scanned = scan(self.root)
        self.assertEqual(scanned["files"], [])
        self.assertEqual(scanned["warnings"], {"total": 1, "items": [["f�", "invalid_name"]]})

    def test_keeps_100_warnings_and_counts_the_rest(self):
        os.makedirs(self.root)
        for i in range(120):
            os.symlink("nowhere", self.path(f"link{i:03d}"))
        warnings = scan(self.root)["warnings"]
        self.assertEqual(warnings["total"], 120)
        self.assertEqual(len(warnings["items"]), 100)
        self.assertEqual(warnings["items"][99][0], "link099")

    def test_counts_every_entry_against_the_limit_kept_or_not(self):
        self.write("dir/a")
        os.symlink("a", self.path("dir", "b"))
        self.assertEqual(scan(self.root, limits={**LIMITS, "entries": 2}), {"ok": False, "limit": "folder_entries"})
        self.assertTrue(scan(self.root, limits={**LIMITS, "entries": 3})["ok"])

    def test_measures_files_in_pages_before_hashing_them(self):
        self.write("a", b"a")
        self.write("b", b"b")
        self.assertEqual(scan(self.root, limits={**LIMITS, "bytes": 4096}), {"ok": False, "limit": "folder_bytes"})
        self.assertTrue(scan(self.root, limits={**LIMITS, "bytes": 8192})["ok"])
        os.truncate(self.path("a"), 64 * 1024 * 1024 * 1024)
        started = time.monotonic()
        self.assertEqual(scan(self.root), {"ok": False, "limit": "folder_bytes"})
        self.assertLess(time.monotonic() - started, 5)

    def test_reuses_a_hash_unless_racy_or_rehashing_everything(self):
        self.write("a", b"a")
        first = scan(self.root)
        self.assertEqual(first["files"][0][1], sha256(b"a"))
        entry = first["index"][0]
        # Written just now, so its metadata may not show a change made within the same tick.
        self.assertTrue(entry[8])
        stale = "0" * 64
        racy = [*entry[:6], stale, entry[7], True]
        self.assertEqual(scan(self.root, [racy])["files"][0][1], sha256(b"a"))
        settled = [*entry[:6], stale, entry[7], False]
        self.assertEqual(scan(self.root, [settled])["files"][0][1], stale)
        self.assertEqual(scan(self.root, [settled], rehash_all=True)["files"][0][1], sha256(b"a"))
        with open(self.path("a"), "wb") as file:
            file.write(b"b")
        self.assertEqual(scan(self.root, [settled])["files"][0][1], sha256(b"b"))

    def test_keeps_the_indexed_mtime_of_a_file_whose_mtime_did_not_change(self):
        self.write("a", b"a")
        first = scan(self.root)["index"][0]
        # As if hydration had rounded it: the index holds a manifest mtime one millisecond off.
        rounded = [*first[:7], first[7] + 1, True]
        self.assertEqual(scan(self.root, [rounded])["files"][0][3], first[7] + 1)

    def test_recreates_a_folder_that_a_command_removed(self):
        scanned = scan(self.root)
        self.assertEqual(scanned["files"], [])
        self.assertTrue(os.path.isdir(self.root))

    def test_never_follows_a_symlinked_parent(self):
        outside = os.path.join(self.base, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "secret.txt"), "wb") as file:
            file.write(b"secret")
        os.makedirs(self.root)
        os.symlink(outside, self.path("escape"))
        scanned = scan(self.root)
        self.assertEqual(scanned["files"], [])
        self.assertEqual(scanned["warnings"]["items"], [["escape", "symlink"]])

    def test_skips_unreadable_entries(self):
        if os.geteuid() == 0:
            self.skipTest("root reads everything")
        self.write("locked/inner.txt", b"x")
        self.write("closed.txt", b"y")
        os.chmod(self.path("closed.txt"), 0)
        os.chmod(self.path("locked"), 0)
        scanned = scan(self.root)
        self.assertEqual(scanned["files"], [])
        self.assertEqual(scanned["warnings"]["items"], [["closed.txt", "unreadable"], ["locked", "unreadable"]])


class Hydrate(Case):
    def plan(self, files, dirs=()):
        """Each item is a blob: (path, data, mode, mtime, copies), a copy being (path, mode, mtime)."""
        header = {"root": self.root, "dirs": list(dirs), "blobs": []}
        body = b""
        for path, data, mode, mtime, copies in files:
            holders = [{"path": path, "mode": mode, "mtime": mtime}]
            holders += [{"path": copy, "mode": copy_mode, "mtime": copy_mtime} for copy, copy_mode, copy_mtime in copies]
            header["blobs"].append({"sha256": sha256(data), "size": len(data), "files": holders})
            body += data
        return json.dumps(header).encode() + b"\n" + body

    def hydrate(self, stdin):
        status, head, rest, stderr = run("hydrate", stdin=stdin)
        self.assertEqual(status, 0, stderr)
        if head.get("ok"):
            index = lines(rest)
            self.assertEqual(len(index), head["files"])
            return {"ok": True, "index": index}
        return head

    def test_restores_files_modes_mtimes_and_dirs(self):
        answer = self.hydrate(self.plan([("a/x.txt", b"x", 0o644, 1_700_000_000_500, [("b/copy.txt", 0o755, 9)]), ("run.sh", b"#!/bin/sh\n", 0o755, 7, [])], ["empty/inner"]))
        self.assertTrue(answer["ok"], answer)
        with open(self.path("b", "copy.txt"), "rb") as file:
            self.assertEqual(file.read(), b"x")
        self.assertEqual(os.stat(self.path("run.sh")).st_mode & 0o777, 0o755)
        self.assertEqual(os.stat(self.path("a", "x.txt")).st_mtime_ns, 1_700_000_000_500_000_000)
        self.assertTrue(os.path.isdir(self.path("empty", "inner")))
        self.assertEqual(sorted(entry[0] for entry in answer["index"]), ["a/x.txt", "b/copy.txt", "run.sh"])
        scanned = scan(self.root, answer["index"])
        self.assertEqual([(file[0], file[2], file[3]) for file in scanned["files"]], [("a/x.txt", 0o644, 1_700_000_000_500), ("b/copy.txt", 0o755, 9), ("run.sh", 0o755, 7)])
        self.assertEqual(scanned["dirs"], ["empty/inner"])

    def test_refuses_a_root_that_is_not_empty_and_invalid_paths(self):
        self.write("left.txt")
        self.assertEqual(self.hydrate(self.plan([("a", b"a", 0o644, 0, [])]))["reason"], "not_empty")
        os.remove(self.path("left.txt"))
        self.assertEqual(self.hydrate(self.plan([("../escape", b"a", 0o644, 0, [])]))["reason"], "invalid_path")
        self.assertEqual(self.hydrate(self.plan([("a", b"a", 0o644, 0, [])], ["x//y"]))["reason"], "invalid_path")
        self.assertEqual(os.listdir(self.root), [])

    def test_refuses_contents_that_do_not_match(self):
        stdin = self.plan([("a", b"abc", 0o644, 0, [])])
        self.assertEqual(self.hydrate(stdin.replace(b"abc", b"abd"))["reason"], "mismatch")

    def test_refuses_a_short_or_long_stream(self):
        stdin = self.plan([("a", b"abc", 0o644, 0, [])])
        self.assertEqual(self.hydrate(stdin[:-1])["reason"], "mismatch")
        for name in os.listdir(self.root):
            os.remove(self.path(name))
        self.assertEqual(self.hydrate(stdin + b"!")["reason"], "mismatch")


class Pull(Case):
    def pull(self, path, size):
        process = subprocess.run([sys.executable, "-I", "-S", FS, "pull", self.root, path, str(size)], capture_output=True, timeout=10)
        return process.returncode, process.stdout

    def test_writes_exactly_the_file(self):
        data = os.urandom(3 * 1024 * 1024 + 5)
        self.write("d/big.bin", data)
        self.assertEqual(self.pull("d/big.bin", len(data)), (0, data))

    def test_many_files_in_order_stopping_at_one_that_changed(self):
        self.write("a", b"alpha")
        self.write("d/b", b"")
        self.write("c", b"gamma")
        files = [["a", 5], ["d/b", 0], ["c", 4], ["a", 5]]
        process = subprocess.run(
            [sys.executable, "-I", "-S", FS, "pull-many", self.root],
            input=json.dumps({"files": files}).encode() + b"\n",
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(process.returncode, 0)
        self.assertEqual(process.stdout, b'{"ok":true}\nalpha{"ok":true}\n{"ok":false,"reason":"changed"}\n')
        os.symlink(self.path("d"), self.path("linked"))
        process = subprocess.run(
            [sys.executable, "-I", "-S", FS, "pull-many", self.root],
            input=json.dumps({"files": [["linked/b", 0]]}).encode() + b"\n",
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(process.stdout, b'{"ok":false,"reason":"changed"}\n')

    def test_refuses_a_changed_file_a_fifo_and_symlinks(self):
        self.write("a", b"abc")
        self.assertEqual(self.pull("a", 4)[0], 3)
        os.mkfifo(self.path("pipe"))
        self.assertEqual(self.pull("pipe", 0)[0], 3)
        os.symlink("a", self.path("link"))
        self.assertEqual(self.pull("link", 3)[0], 3)
        outside = os.path.join(self.base, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "secret"), "wb") as file:
            file.write(b"abc")
        os.symlink(outside, self.path("parent"))
        self.assertEqual(self.pull("parent/secret", 3), (3, b""))
        self.assertEqual(self.pull("../outside/secret", 3), (3, b""))


if __name__ == "__main__":
    unittest.main()
