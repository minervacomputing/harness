"""Folder manifests: validation of what a worker sends, and the form a version stores.

Wire format: `{"files": [{"path", "sha256", "mode", "mtime"}, ...], "dirs": [path, ...]}`. Lists rather than
objects, so a path listed twice is detected (a JSON object silently keeps the last duplicate key). `dirs` lists
empty directories only; the others are implied by the paths under them. Sizes are never taken from a manifest:
they come from the Blob rows (files.store.record_version).

The worker's scan applies the same path rules, so the limits on paths are constants rather than settings.
"""

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass

from files.limits import QuotaExceeded

MAX_PATH_BYTES = 1024
MAX_SEGMENT_BYTES = 255
MAX_DEPTH = 32
FILE_MODES = (0o644, 0o755)
# 9999-12-31T23:59:59.999Z, in milliseconds since the epoch.
MAX_MTIME = 253_402_300_799_999
PAGE_BYTES = 4096

_SHA256 = re.compile(r"[0-9a-f]{64}")
_FILE_KEYS = {"path", "sha256", "mode", "mtime"}


class InvalidManifest(ValueError):
    pass


@dataclass(frozen=True)
class FileEntry:
    sha256: str
    mode: int
    mtime: int


@dataclass(frozen=True)
class Manifest:
    files: dict[str, FileEntry]
    # Empty directories, sorted.
    dirs: tuple[str, ...]
    # Files plus every directory, listed or implied, apart from the root: each takes an inode.
    entry_count: int

    @property
    def hashes(self) -> set[str]:
        return {entry.sha256 for entry in self.files.values()}


def parse(data: object, *, max_entries: int) -> Manifest:
    """Validates a manifest from a worker. Raises InvalidManifest, or QuotaExceeded("folder_entries")."""
    if not isinstance(data, dict) or set(data) != {"files", "dirs"}:
        raise InvalidManifest('A manifest is an object with exactly "files" and "dirs".')
    raw_files, raw_dirs = data["files"], data["dirs"]
    if not isinstance(raw_files, list) or not isinstance(raw_dirs, list):
        raise InvalidManifest('"files" and "dirs" are lists.')
    # Checked first, so an oversized manifest costs nothing more.
    if len(raw_files) + len(raw_dirs) > max_entries:
        raise QuotaExceeded("folder_entries")

    files: dict[str, FileEntry] = {}
    for item in raw_files:
        if not isinstance(item, dict) or set(item) != _FILE_KEYS:
            raise InvalidManifest("A file entry has exactly path, sha256, mode and mtime.")
        path = _check_path(item["path"])
        sha256, mode, mtime = item["sha256"], item["mode"], item["mtime"]
        if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
            raise InvalidManifest(f"{path!r}: sha256 is 64 lowercase hex digits.")
        if not _is_int(mode) or mode not in FILE_MODES:
            raise InvalidManifest(f"{path!r}: mode is 0644 or 0755.")
        if not _is_int(mtime) or not 0 <= mtime <= MAX_MTIME:
            raise InvalidManifest(f"{path!r}: mtime is an integer number of milliseconds within range.")
        if path in files:
            raise InvalidManifest(f"{path!r} is listed twice.")
        files[path] = FileEntry(sha256=sha256, mode=mode, mtime=mtime)

    dirs: set[str] = set()
    for item in raw_dirs:
        path = _check_path(item)
        if path in files or path in dirs:
            raise InvalidManifest(f"{path!r} is listed twice.")
        dirs.add(path)

    # Every ancestor of a listed path is a directory. Counting stops as soon as the limit is passed.
    implied: set[str] = set()
    for path in (*files, *dirs):
        end = path.rfind("/")
        while end > 0:
            parent = path[:end]
            if parent in implied:
                break
            implied.add(parent)
            if len(files) + len(dirs | implied) > max_entries:
                raise QuotaExceeded("folder_entries")
            end = path.rfind("/", 0, end)
    for parent in implied:
        if parent in files:
            raise InvalidManifest(f"{parent!r} is both a file and a directory.")
        if parent in dirs:
            raise InvalidManifest(f"{parent!r} is listed as an empty directory but has entries.")
    entry_count = len(files) + len(dirs) + len(implied)
    if entry_count > max_entries:
        raise QuotaExceeded("folder_entries")
    return Manifest(files=files, dirs=tuple(sorted(dirs)), entry_count=entry_count)


def stored_entries(manifest: Manifest, sizes: dict[str, int]) -> dict:
    """The form a version keeps, with each file's size from its Blob row."""
    return {
        "files": {
            path: {
                "sha256": entry.sha256,
                "size": sizes[entry.sha256],
                "mode": entry.mode,
                "mtime": entry.mtime,
            }
            for path, entry in sorted(manifest.files.items())
        },
        "dirs": list(manifest.dirs),
    }


def digest(entries: dict) -> str:
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def folder_bytes(sizes: list[int]) -> int:
    """Bytes as tmpfs charges them: each file rounded up to whole pages (an empty file takes none)."""
    return sum(-(-size // PAGE_BYTES) * PAGE_BYTES for size in sizes)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_path(path: object) -> str:
    if not isinstance(path, str):
        raise InvalidManifest("A path is a string.")
    try:
        encoded = path.encode()
    except UnicodeEncodeError:
        raise InvalidManifest("A path is valid UTF-8.") from None
    if len(encoded) > MAX_PATH_BYTES:
        raise InvalidManifest(f"A path has at most {MAX_PATH_BYTES} bytes.")
    if not unicodedata.is_normalized("NFC", path):
        raise InvalidManifest(f"{path!r} is not in NFC.")
    if any(unicodedata.category(char) == "Cc" for char in path):
        raise InvalidManifest(f"{path!r} contains a control character.")
    segments = path.split("/")
    if len(segments) > MAX_DEPTH:
        raise InvalidManifest(f"{path!r} is more than {MAX_DEPTH} levels deep.")
    for segment in segments:
        if segment in ("", ".", ".."):
            raise InvalidManifest(f"{path!r} is not a relative path without empty, . or .. segments.")
        if len(segment.encode()) > MAX_SEGMENT_BYTES:
            raise InvalidManifest(f"{path!r} has a name longer than {MAX_SEGMENT_BYTES} bytes.")
    return path
