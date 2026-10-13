"""Unit tests for minerva-fs, run as `python3 -I -m unittest discover -s container/tests` (vitest runs them
from test/docker/sandbox-python.test.ts, with the image's Python in Docker as well when it is available).

Each case runs the helper as a separate process, as the sandbox does."""

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
    CHANGED = b'{"ok":false,"reason":"changed"}\n'

    def pull(self, *files):
        process = subprocess.run(
            [sys.executable, "-I", "-S", FS, "pull-many", self.root],
            input=json.dumps({"files": [list(file) for file in files]}).encode() + b"\n",
            capture_output=True,
            timeout=10,
        )
        return process.returncode, process.stdout

    def test_writes_exactly_the_file(self):
        data = os.urandom(3 * 1024 * 1024 + 5)
        self.write("d/big.bin", data)
        self.assertEqual(self.pull(("d/big.bin", len(data))), (0, b'{"ok":true}\n' + data))

    def test_many_files_in_order_stopping_at_one_that_changed(self):
        self.write("a", b"alpha")
        self.write("d/b", b"")
        self.write("c", b"gamma")
        self.assertEqual(self.pull(("a", 5), ("d/b", 0), ("c", 4), ("a", 5)), (0, b'{"ok":true}\nalpha{"ok":true}\n' + self.CHANGED))

    def test_refuses_a_changed_file_a_fifo_and_symlinks(self):
        self.write("a", b"abc")
        self.assertEqual(self.pull(("a", 4)), (0, self.CHANGED))
        os.mkfifo(self.path("pipe"))
        self.assertEqual(self.pull(("pipe", 0)), (0, self.CHANGED))
        os.symlink("a", self.path("link"))
        self.assertEqual(self.pull(("link", 3)), (0, self.CHANGED))
        outside = os.path.join(self.base, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "secret"), "wb") as file:
            file.write(b"abc")
        os.symlink(outside, self.path("parent"))
        self.assertEqual(self.pull(("parent/secret", 3)), (0, self.CHANGED))
        self.assertEqual(self.pull(("../outside/secret", 3)), (0, self.CHANGED))


if __name__ == "__main__":
    unittest.main()
