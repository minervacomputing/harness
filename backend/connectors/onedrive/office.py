"""Text out of Word, PowerPoint and Excel files (Office Open XML), for reading only.

These files are zip archives of XML parts, and only the parts that hold the text are read. Each part is
streamed through expat, which keeps no tree. A document type declaration, and with it any entity, is
refused. Decompression is metered across all the parts read, and reading stops once the text reaches its
limit. Nothing a document refers to is fetched or opened: links, embedded objects and external
relationships are ignored. Formulas are not evaluated, so Excel cells give the values the file stored.

The work is synchronous and bounded; callers run it in a thread. It runs in Minerva's own process, so these
limits, not isolation, are what contain a hostile file.
"""

import csv
import io
import posixpath
import re
import zipfile
import zlib
from collections.abc import Callable
from xml.parsers import expat

from connectors.base import OperationError

MAX_ENTRIES = 5000
# Bytes decompressed across every part read, whatever the text they yield.
MAX_EXPANDED = 32 * 1024 * 1024
MAX_SHARED_TEXT = 4 * 1024 * 1024
MAX_SHARED_STRINGS = 1_000_000
MAX_SLIDES = 1000
MAX_COLUMNS = 200
CHUNK = 64 * 1024
_CELL = re.compile(r"\A([A-Z]{1,3})\d+\Z")

Start = Callable[[str, dict[str, str]], None]
End = Callable[[str], None]
Chars = Callable[[str], None]


def _unreadable() -> OperationError:
    return OperationError(
        "UNSUPPORTED_FILE",
        "Minerva could not read this file: it is damaged, protected, or not a valid Office file.",
    )


def _too_large() -> OperationError:
    return OperationError("FILE_TOO_LARGE", "This file expands to more than Minerva reads.")


class _Full(Exception):
    """The text reached its limit; reading stops."""


class _Text:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.parts: list[str] = []
        self.size = 0

    @property
    def full(self) -> bool:
        return self.size >= self.limit

    @property
    def remaining(self) -> int:
        return max(self.limit - self.size, 0)

    def add(self, value: str) -> None:
        if self.full:
            raise _Full
        value = value[: self.remaining]
        self.parts.append(value)
        self.size += len(value)

    def value(self) -> str:
        return "".join(self.parts)[: self.limit]


def _local(name: str) -> str:
    """An element or attribute name without its namespace (expat joins them with a space)."""
    return name.rpartition(" ")[2]


def _relationship_id(attrs: dict[str, str]) -> str | None:
    return next(
        (
            v
            for k, v in attrs.items()
            if " " in k and k.endswith(" id") and k.split(" ")[0].endswith("/relationships")
        ),
        None,
    )


class _Archive:
    def __init__(self, data: bytes) -> None:
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self.zip.infolist()
        except zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, EOFError:
            raise _unreadable() from None
        if len(infos) > MAX_ENTRIES:
            raise _unreadable()
        self.infos = {info.filename: info for info in infos}
        if len(self.infos) != len(infos):
            # Two entries with one name: which one is read is ambiguous.
            raise _unreadable()
        self.budget = MAX_EXPANDED

    def has(self, name: str) -> bool:
        return name in self.infos

    def parse(self, name: str, start: Start, end: End | None = None, chars: Chars | None = None) -> None:
        info = self.infos.get(name)
        if info is None:
            raise _unreadable()
        if info.flag_bits & 0x1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise _unreadable()

        def refuse(*_: object) -> None:
            raise _unreadable()

        parser = expat.ParserCreate(namespace_separator=" ")
        parser.buffer_text = True
        parser.StartDoctypeDeclHandler = refuse
        parser.EntityDeclHandler = refuse
        parser.StartElementHandler = lambda n, a: start(_local(n), {_local(k): v for k, v in a.items()} | a)
        if end is not None:
            parser.EndElementHandler = lambda n: end(_local(n))
        if chars is not None:
            parser.CharacterDataHandler = chars
        try:
            with self.zip.open(info) as part:
                while chunk := part.read(CHUNK):
                    self.budget -= len(chunk)
                    if self.budget < 0:
                        raise _too_large()
                    parser.Parse(chunk, False)
            parser.Parse(b"", True)
        except _Full:
            return
        except expat.ExpatError, zipfile.BadZipFile, zlib.error, EOFError, ValueError, RuntimeError:
            raise _unreadable() from None

    def relationships(self, part: str) -> dict[str, tuple[str, str]]:
        """The part's internal relationships: id -> (type, the target part's name)."""
        folder, base = posixpath.split(part)
        rels = posixpath.join(folder, "_rels", f"{base}.rels")
        found: dict[str, tuple[str, str]] = {}
        if not self.has(rels):
            return found

        def start(name: str, attrs: dict[str, str]) -> None:
            if name != "Relationship" or attrs.get("TargetMode") == "External":
                return
            rid, kind, target = attrs.get("Id"), attrs.get("Type"), attrs.get("Target")
            if rid and kind and target and len(found) < MAX_ENTRIES:
                path = target[1:] if target.startswith("/") else posixpath.join(folder, target)
                found[rid] = (kind, posixpath.normpath(path))

        self.parse(rels, start)
        return found

    def main(self) -> str:
        """The package's main part (the document, presentation or workbook)."""
        for kind, target in self.relationships("").values():
            if kind.endswith("/officeDocument"):
                return target
        raise _unreadable()


def _paragraphs(archive: _Archive, part: str, text: _Text, marks: dict[str, str]) -> None:
    """The text of `t` elements, a newline after each paragraph, and `marks` for the elements they name."""
    inside = False

    def start(name: str, attrs: dict[str, str]) -> None:
        nonlocal inside
        if name == "t":
            inside = True
        elif name in marks:
            text.add(marks[name])

    def end(name: str) -> None:
        nonlocal inside
        if name == "t":
            inside = False
        elif name == "p":
            text.add("\n")

    def chars(data: str) -> None:
        if inside:
            text.add(data)

    archive.parse(part, start, end, chars)


def _word(archive: _Archive, text: _Text) -> None:
    _paragraphs(archive, archive.main(), text, {"tab": "\t", "br": "\n", "cr": "\n"})


def _slides(archive: _Archive) -> list[str]:
    main = archive.main()
    relationships = archive.relationships(main)
    order: list[str] = []

    def start(name: str, attrs: dict[str, str]) -> None:
        if name == "sldId" and len(order) < MAX_SLIDES and (rid := _relationship_id(attrs)):
            order.append(rid)

    archive.parse(main, start)
    return [relationships[rid][1] for rid in order if rid in relationships]


def _powerpoint(archive: _Archive, text: _Text) -> None:
    for number, slide in enumerate(_slides(archive), start=1):
        if text.full:
            return
        text.add(f"{'\n' if number > 1 else ''}Slide {number}\n")
        _paragraphs(archive, slide, text, {"br": "\n"})


def _shared_strings(archive: _Archive, part: str) -> list[str]:
    strings: list[str] = []
    current: list[str] = []
    total = 0
    depth = {"t": 0, "rPh": 0}

    def start(name: str, attrs: dict[str, str]) -> None:
        if name == "si":
            current.clear()
        elif name in depth:
            depth[name] += 1

    def end(name: str) -> None:
        if name == "si":
            if len(strings) >= MAX_SHARED_STRINGS:
                raise _too_large()
            strings.append("".join(current))
        elif name in depth:
            depth[name] -= 1

    def chars(data: str) -> None:
        nonlocal total
        # Phonetic guides (rPh) repeat a reading of the text, not the text.
        if depth["t"] and not depth["rPh"]:
            total += len(data)
            if total > MAX_SHARED_TEXT:
                raise _too_large()
            current.append(data)

    archive.parse(part, start, end, chars)
    return strings


def _column(reference: str | None, fallback: int) -> int:
    if reference and (match := _CELL.match(reference)):
        index = 0
        for letter in match.group(1):
            index = index * 26 + ord(letter) - 64
        return index - 1
    return fallback


def _excel(archive: _Archive, text: _Text) -> None:
    """The first worksheet, in workbook order, as CSV."""
    main = archive.main()
    relationships = archive.relationships(main)
    first: list[str] = []

    def find(name: str, attrs: dict[str, str]) -> None:
        if name == "sheet" and not first and (rid := _relationship_id(attrs)):
            first.append(rid)

    archive.parse(main, find)
    if not first or first[0] not in relationships:
        raise _unreadable()
    shared = next(
        (target for kind, target in relationships.values() if kind.endswith("/sharedStrings")), None
    )
    strings = _shared_strings(archive, shared) if shared and archive.has(shared) else []

    row: dict[int, str] = {}
    cell: dict[str, str | int | None] = {}
    value: list[str] = []
    state = {"v": False, "is": False, "t": False}
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")

    def start(name: str, attrs: dict[str, str]) -> None:
        if name == "row":
            row.clear()
        elif name == "c":
            cell.clear()
            cell.update(type=attrs.get("t"), column=_column(attrs.get("r"), max(row, default=-1) + 1))
            value.clear()
        elif name in state:
            state[name] = True

    def end(name: str) -> None:
        if name in state:
            state[name] = False
        elif name == "c":
            column = cell.get("column")
            if isinstance(column, int) and 0 <= column < MAX_COLUMNS:
                row[column] = _cell(cell.get("type"), "".join(value), strings)
        elif name == "row" and row:
            # Cells are cut to what the text can still take before the row is built: one long shared
            # string may fill many cells.
            budget = text.remaining
            if not budget:
                raise _Full
            cells: list[str] = []
            for i in range(max(row) + 1):
                cells.append(row.get(i, "")[:budget])
                budget -= len(cells[-1]) + 1
                if budget <= 0:
                    break
            out.seek(0)
            out.truncate()
            writer.writerow(cells)
            text.add(out.getvalue())

    def chars(data: str) -> None:
        if state["v"] or (state["is"] and state["t"]):
            value.append(data)

    archive.parse(relationships[first[0]][1], start, end, chars)


def _cell(kind: object, raw: str, strings: list[str]) -> str:
    if kind == "s":
        index = int(raw) if raw.isdigit() else -1
        return strings[index] if 0 <= index < len(strings) else ""
    if kind == "b":
        return {"1": "TRUE", "0": "FALSE"}.get(raw, raw)
    return raw


READERS = {"docx": _word, "pptx": _powerpoint, "xlsx": _excel}


def extract(kind: str, data: bytes, limit: int) -> str:
    """The text of a .docx, .pptx or .xlsx file, at most `limit` characters."""
    text = _Text(limit)
    READERS[kind](_Archive(data), text)
    return text.value()
