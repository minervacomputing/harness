import time

import pytest

from files import manifest
from files.limits import QuotaExceeded
from files.manifest import InvalidManifest, parse

A = "a" * 64
B = "b" * 64


def file(path, sha256=A, mode=0o644, mtime=0):
    return {"path": path, "sha256": sha256, "mode": mode, "mtime": mtime}


def test_a_manifest_counts_every_directory_including_implied_ones():
    parsed = parse(
        {"files": [file("docs/a/x.txt"), file("docs/b.txt", B)], "dirs": ["empty"]}, max_entries=10
    )
    assert set(parsed.files) == {"docs/a/x.txt", "docs/b.txt"}
    assert parsed.dirs == ("empty",)
    # Two files, docs, docs/a, empty.
    assert parsed.entry_count == 5
    assert parsed.hashes == {A, B}


@pytest.mark.parametrize(
    "path",
    [
        "/abs",
        "a//b",
        "a/",
        "./a",
        "a/../b",
        "..",
        "",
        "a\x00b",
        "a\nb",
        "é",  # not NFC
        "\udcff",  # not encodable as UTF-8
        "x" * 256,
        "/".join(["d"] * 33),
        "/".join(["x" * 200] * 6),  # over 1,024 bytes
        7,
    ],
)
def test_a_path_must_be_relative_normalised_and_bounded(path):
    with pytest.raises(InvalidManifest):
        parse({"files": [file(path)], "dirs": []}, max_entries=10)


def test_the_deepest_and_longest_paths_allowed_pass():
    deep = "/".join(["d"] * 32)
    long_name = "é" * 127  # 254 bytes
    parse({"files": [file(deep), file(long_name)], "dirs": []}, max_entries=100)


@pytest.mark.parametrize(
    "data",
    [
        [],
        {"files": []},
        {"files": [], "dirs": [], "extra": 1},
        {"files": {}, "dirs": []},
        {"files": [file("a") | {"size": 1}], "dirs": []},
        {"files": [file("a", sha256="A" * 64)], "dirs": []},
        {"files": [file("a", sha256="a" * 63)], "dirs": []},
        {"files": [file("a", mode=0o777)], "dirs": []},
        {"files": [file("a", mode=True)], "dirs": []},
        {"files": [file("a", mtime=-1)], "dirs": []},
        {"files": [file("a", mtime=1.5)], "dirs": []},
        {"files": [file("a", mtime=manifest.MAX_MTIME + 1)], "dirs": []},
        {"files": [file("a"), file("a", B)], "dirs": []},
        {"files": [file("a")], "dirs": ["a"]},
        {"files": [], "dirs": ["a", "a"]},
        {"files": [file("a"), file("a/b")], "dirs": []},
        {"files": [file("a/b")], "dirs": ["a"]},
    ],
)
def test_malformed_manifests_are_refused(data):
    with pytest.raises(InvalidManifest):
        parse(data, max_entries=10)


def test_the_entry_limit_counts_implied_directories():
    data = {"files": [file("a/b/c/d.txt")], "dirs": []}
    assert parse(data, max_entries=4).entry_count == 4
    with pytest.raises(QuotaExceeded) as refused:
        parse(data, max_entries=3)
    assert refused.value.limit == "folder_entries"


def test_an_oversized_manifest_is_refused_before_its_paths_are_checked():
    data = {"files": [{"path": None}] * 11, "dirs": []}
    with pytest.raises(QuotaExceeded):
        parse(data, max_entries=10)


def test_the_digest_ignores_order_and_the_size_rounds_up_to_pages():
    first = parse({"files": [file("a"), file("b", B)], "dirs": ["z", "y"]}, max_entries=10)
    second = parse({"files": [file("b", B), file("a")], "dirs": ["y", "z"]}, max_entries=10)
    sizes = {A: 1, B: 4097}
    entries = manifest.stored_entries(first, sizes)
    assert entries == manifest.stored_entries(second, sizes)
    assert manifest.digest(entries) == manifest.digest(manifest.stored_entries(second, sizes))
    assert entries["files"]["b"] == {"sha256": B, "size": 4097, "mode": 0o644, "mtime": 0}
    assert manifest.folder_bytes([0, 1, 4096, 4097]) == 0 + 4096 + 4096 + 8192


def test_a_manifest_at_the_entry_limit_is_checked_quickly():
    # Each file in its own directory: about 10,000 entries, every one an implied directory or a file.
    files = [file(f"d{i}/f") for i in range(4999)]
    started = time.perf_counter()
    assert parse({"files": files, "dirs": []}, max_entries=10_000).entry_count == 9998
    assert time.perf_counter() - started < 0.2
