"""Writes vectors.json: what today's Python computes for OneDrive's port (src/connectors/onedrive/):

- `zip`: zip archives (valid, odd and damaged, hand-built byte by byte or mutated) read as office.py reads them
  (`_Archive`): the part names, and for each part its length and SHA-256 or the kind of error;
- `office`: the text `office.extract` gives for Word, PowerPoint and Excel files (hand-written edge cases and
  mutations of their XML), or the error code it raises;
- `download_allowed`, `readable`, `search_cursor`, and the normalized arguments or validation message of the
  tool inputs.

Only connector modules are imported, which load no configuration. Run from cloudflare/:
cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/onedrive/generate.py

The committed file keeps a sample of the fuzz groups (XML_FUZZ, DAMAGED) to stay under about 500 KB; add `--full`
(after the script's path) for the whole set, about 2.5 MB, for a local run. Repetitive strings are written as
`$runs` recipes (vector_size.py), and the archives at the entry limit as `$crowd` ones: the test builds them.
"""

import base64
import hashlib
import io
import json
import random
import struct
import sys
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLOUDFLARE = HERE.parents[3]
BACKEND = CLOUDFLARE.parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

from vector_size import compact, sample  # noqa: E402

from pydantic import ValidationError  # noqa: E402

from connectors.base import OperationError  # noqa: E402
from connectors.onedrive import connector as onedrive  # noqa: E402
from connectors.onedrive import office  # noqa: E402
from connectors.onedrive.client import DriveItem, download_allowed  # noqa: E402

random.seed(20261012)

XML_FUZZ = sample(900, 45)  # mutated XML parts
DAMAGED = sample(300, 45)  # archives with bytes changed


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# ---------------------------------------------------------------------------------------------------------------
# Zip archives, byte by byte.

LOCAL = 0x04034B50
CENTRAL = 0x02014B50
END = 0x06054B50
END64 = 0x06064B50
END64_LOCATOR = 0x07064B50


def deflate(data: bytes) -> bytes:
    packer = zlib.compressobj(9, zlib.DEFLATED, -15)
    return packer.compress(data) + packer.flush()


def raw_zip(entries: list[dict], *, comment: bytes = b"", end64: bool = False) -> bytes:
    """An archive written field by field; each entry may set any field to a wrong value."""
    out = bytearray()
    central = bytearray()
    for e in entries:
        name: bytes = e["name"]
        data: bytes = e.get("data", b"")
        method: int = e.get("method", 8)
        packed: bytes = e.get("packed", deflate(data) if method == 8 else data)
        crc = e.get("crc", zlib.crc32(data))
        csize = e.get("csize", len(packed))
        usize = e.get("usize", len(data))
        flags = e.get("flags", 0)
        extra: bytes = e.get("extra", b"")
        offset = e.get("offset", len(out))
        version = e.get("version", 20)
        out += struct.pack(
            "<IHHHHHIIIHH", LOCAL, version, e.get("local_flags", flags), method, 0, 0x21, crc, csize, usize,
            len(e.get("local_name", name)), len(e.get("local_extra", b"")),
        )  # fmt: skip
        out += e.get("local_name", name) + e.get("local_extra", b"") + packed + e.get("gap", b"")
        z64 = e.get("zip64", ())
        header_extra = extra
        if z64:
            body = b""
            if "size" in z64:
                body += struct.pack("<Q", usize)
            if "csize" in z64:
                body += struct.pack("<Q", csize)
            if "offset" in z64:
                body += struct.pack("<Q", offset)
            header_extra = struct.pack("<HH", 1, len(body)) + body + extra
        central += struct.pack(
            "<IHHHHHHIIIHHHHHII", CENTRAL, version, version, flags, method, 0, 0x21, crc,
            0xFFFFFFFF if "csize" in z64 else csize, 0xFFFFFFFF if "size" in z64 else usize,
            len(name), len(header_extra), len(e.get("comment", b"")), 0, 0, 0,
            0xFFFFFFFF if "offset" in z64 else offset,
        )  # fmt: skip
        central += name + header_extra + e.get("comment", b"")
    directory = len(out)
    out += central
    count = len(entries)
    if end64:
        record = struct.pack("<IQHHIIQQQQ", END64, 44, 45, 45, 0, 0, count, count, len(central), directory)
        locator = struct.pack("<IIQI", END64_LOCATOR, 0, len(out), 1)
        out += record + locator
        out += struct.pack("<IHHHHIIH", END, 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, len(comment)) + comment
    else:
        out += struct.pack("<IHHHHIIH", END, 0, 0, count, count, len(central), directory, len(comment)) + comment
    return bytes(out)


def named(name: str, data: bytes = b"", **fields) -> dict:
    return {"name": name.encode(), "data": data, **fields}


def zipped(parts: dict[str, str | bytes], method: int = zipfile.ZIP_DEFLATED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", method) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return buffer.getvalue()


# ---------------------------------------------------------------------------------------------------------------
# Office files.

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
STRICT_R = "http://purl.oclc.org/ooxml/officeDocument/relationships"
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def rels(*relationships: tuple[str, str, str], external: str | None = None, base: str = R) -> str:
    items = "".join(f'<Relationship Id="{i}" Type="{base}/{t}" Target="{target}"/>' for i, t, target in relationships)
    if external:
        items += f'<Relationship Id="ext" Type="{base}/hyperlink" Target="{external}" TargetMode="External"/>'
    return f'<Relationships xmlns="{PACKAGE}">{items}</Relationships>'


def docx_parts(body: str, document: str | None = None) -> dict[str, str | bytes]:
    return {
        "_rels/.rels": rels(("rId1", "officeDocument", "word/document.xml")),
        "word/document.xml": document if document is not None else f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>',
    }


def docx(body: str) -> bytes:
    return zipped(docx_parts(body))


def slide(text: str) -> str:
    return (
        f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody>'
        f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
    )


def pptx_parts(ids: str | None = None, slides: dict[str, str] | None = None, relationships: str | None = None) -> dict[str, str | bytes]:
    return {
        "_rels/.rels": rels(("rId1", "officeDocument", "ppt/presentation.xml")),
        "ppt/presentation.xml": (
            f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>'
            + (ids if ids is not None else '<p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>')
            + "</p:sldIdLst></p:presentation>"
        ),
        "ppt/_rels/presentation.xml.rels": relationships
        if relationships is not None
        else rels(("rId2", "slide", "slides/slide1.xml"), ("rId3", "slide", "slides/slide2.xml")),
        **(slides if slides is not None else {"ppt/slides/slide1.xml": slide("Title"), "ppt/slides/slide2.xml": slide("Agenda")}),
    }


def xlsx_parts(sheet: str, strings: str | None = None, workbook: str | None = None, sheet_rels: str | None = None) -> dict[str, str | bytes]:
    parts: dict[str, str | bytes] = {
        "_rels/.rels": rels(("rId1", "officeDocument", "xl/workbook.xml")),
        "xl/workbook.xml": workbook
        if workbook is not None
        else f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": sheet_rels
        if sheet_rels is not None
        else rels(("rId2", "worksheet", "worksheets/sheet2.xml"), ("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId3", "sharedStrings", "sharedStrings.xml")),
        "xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData>{sheet}</sheetData></worksheet>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>',
    }
    if strings is not None:
        parts["xl/sharedStrings.xml"] = f'<sst xmlns="{S}">{strings}</sst>'
    return parts


def xlsx(sheet: str, strings: str | None = None) -> bytes:
    return zipped(xlsx_parts(sheet, strings))


def row(*cells: str) -> str:
    return "<row>" + "".join(cells) + "</row>"


def cell(ref: str | None, value: str, kind: str | None = None, tag: str = "v") -> str:
    r = f' r="{ref}"' if ref is not None else ""
    t = f' t="{kind}"' if kind is not None else ""
    return f"<c{r}{t}><{tag}>{value}</{tag}></c>"


OFFICE: list[tuple[str, str, bytes, int]] = []


CROWDED: dict[str, dict] = {}  # case name -> the `$crowd` recipe standing for its (very large) archive


def case(name: str, kind: str, data: bytes, limit: int = 10_000) -> None:
    OFFICE.append((name, kind, data, limit))


def word_cases() -> None:
    t = lambda text: f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"  # noqa: E731
    case("word basic", "docx", docx("<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>"))
    case("word paragraphs", "docx", docx(t("one") + t("two") + "<w:p/>" + t("three")))
    case("word tab br cr", "docx", docx("<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:t>d</w:t></w:r></w:p>"))
    case("word tab not in t", "docx", docx("<w:p><w:r><w:tab/><w:br/><w:cr/></w:r></w:p>"))
    case("word text outside t", "docx", docx("<w:p>ignored<w:r>kept?<w:t>x</w:t>ignored</w:r></w:p>"))
    case("word nested t", "docx", docx("<w:p><w:r><w:t>a<w:t>b</w:t>c</w:t></w:r></w:p>"))
    case("word entities", "docx", docx(t("&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#x1F600;")))
    case("word cdata", "docx", docx(t("<![CDATA[<raw> & text]]>after")))
    case("word cdata split", "docx", docx(t("a<![CDATA[b]]>c<![CDATA[]]>d")))
    case("word unknown entity", "docx", docx(t("&nbsp;")))
    case("word bad charref", "docx", docx(t("&#0;")))
    case("word bad charref surrogate", "docx", docx(t("&#xD800;")))
    case("word bad charref big", "docx", docx(t("&#x110000;")))
    case("word charref noncharacter", "docx", docx(t("&#xFFFE;")))
    case("word charref control", "docx", docx(t("&#1;")))
    case("word charref tab", "docx", docx(t("a&#9;b&#10;c&#13;d")))
    case("word raw cr lf", "docx", docx(t("a\r\nb\rc\nd")))
    case("word emoji", "docx", docx(t("\U0001f600\U0001f600\U0001f600")), 2)
    case("word emoji limit 3", "docx", docx(t("a\U0001f600\U0001f600b")), 3)
    case("word limit 1", "docx", docx(t("abc")), 1)
    case("word limit 0", "docx", docx(t("abc")), 0)
    case("word limit exact", "docx", docx(t("abc")), 4)
    case("word limit cut newline", "docx", docx(t("abc") + t("def")), 5)
    case("word long", "docx", docx("<w:p><w:r><w:t>" + "word " * 50_000 + "</w:t></w:r></w:p>"), 12)
    case("word long many paragraphs", "docx", docx(t("word") * 3000), 100)
    case("word default namespace", "docx", docx_zip_document(f'<document xmlns="{W}"><body><p><r><t>dflt</t></r></p></body></document>'))
    case("word other namespace t", "docx", docx_zip_document(f'<d xmlns:x="urn:x"><x:p><x:r><x:t>other</x:t></x:r></x:p></d>'))
    case("word no namespace", "docx", docx_zip_document("<d><p><t>plain</t></p></d>"))
    case("word prefix redeclared", "docx", docx_zip_document(f'<d xmlns:w="{W}"><w:p xmlns:w="urn:y"><w:t>y</w:t></w:p><w:p><w:t>z</w:t></w:p></d>'))
    case("word decl", "docx", docx_zip_document('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<d><p><t>decl</t></p></d>'))
    case("word decl utf8 lower", "docx", docx_zip_document('<?xml version="1.0" encoding="utf-8"?><d><p><t>decl</t></p></d>'))
    case("word decl no encoding", "docx", docx_zip_document('<?xml version="1.0"?><d><p><t>decl</t></p></d>'))
    case("word decl bad version", "docx", docx_zip_document('<?xml version="2.0"?><d><p><t>decl</t></p></d>'))
    case("word decl late", "docx", docx_zip_document(' <?xml version="1.0"?><d><p><t>decl</t></p></d>'))
    case("word decl second", "docx", docx_zip_document('<d><p><t>x</t></p><?xml version="1.0"?></d>'))
    case("word bom", "docx", docx_zip_document(b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?><d><p><t>bom</t></p></d>'))
    case("word bom no decl", "docx", docx_zip_document(b"\xef\xbb\xbf<d><p><t>bom</t></p></d>"))
    case("word utf16 le bom", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="UTF-16"?><d><p><t>sixteen \U0001f600</t></p></d>'.encode("utf-16-le")))
    case("word utf16 be bom", "docx", docx_zip_document(b"\xfe\xff" + '<?xml version="1.0" encoding="UTF-16"?><d><p><t>sixteen \U0001f600</t></p></d>'.encode("utf-16-be")))
    case("word utf16 le bom no decl", "docx", docx_zip_document(b"\xff\xfe" + "<d><p><t>sixteen</t></p></d>".encode("utf-16-le")))
    case("word utf16 odd length", "docx", docx_zip_document(b"\xff\xfe" + "<d><p><t>sixteen</t></p></d>".encode("utf-16-le") + b"x"))
    case("word utf16 lone surrogate", "docx", docx_zip_document(b"\xff\xfe" + "<d><p><t>".encode("utf-16-le") + b"\x00\xd8" + "</t></p></d>".encode("utf-16-le")))
    case("word utf8 decl but utf16", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="UTF-8"?><d/>'.encode("utf-16-le")))
    case("word utf16 decl but utf8", "docx", docx_zip_document('<?xml version="1.0" encoding="UTF-16"?><d><p><t>x</t></p></d>'))
    case("word utf16 le no bom", "docx", docx_zip_document('<?xml version="1.0"?><d><p><t>sixteen</t></p></d>'.encode("utf-16-le")))
    case("word utf16 be no bom", "docx", docx_zip_document('<?xml version="1.0"?><d><p><t>sixteen</t></p></d>'.encode("utf-16-be")))
    case("word utf16 le no bom no decl", "docx", docx_zip_document("<d><p><t>sixteen</t></p></d>".encode("utf-16-le")))
    case("word utf16 be no bom no decl", "docx", docx_zip_document("<d><p><t>sixteen</t></p></d>".encode("utf-16-be")))
    case("word utf16 no bom leading space", "docx", docx_zip_document(" <d><p><t>sixteen</t></p></d>".encode("utf-16-le")))
    case("word utf16 le declared le", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="utf-16le"?><d><p><t>x</t></p></d>'.encode("utf-16-le")))
    case("word utf16 le declared be", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="UTF-16BE"?><d><p><t>x</t></p></d>'.encode("utf-16-le")))
    case("word utf16 be declared be", "docx", docx_zip_document(b"\xfe\xff" + '<?xml version="1.0" encoding="UTF-16BE"?><d><p><t>x</t></p></d>'.encode("utf-16-be")))
    case("word utf16 be declared le", "docx", docx_zip_document(b"\xfe\xff" + '<?xml version="1.0" encoding="UTF-16LE"?><d><p><t>x</t></p></d>'.encode("utf-16-be")))
    case("word utf16 declared latin1", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="ISO-8859-1"?><d><p><t>x</t></p></d>'.encode("utf-16-le")))
    case("word utf16 declared lower case", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="1.0" encoding="Utf-16"?><d><p><t>x</t></p></d>'.encode("utf-16-le")))
    case("word utf16 declaration late", "docx", docx_zip_document(b"\xff\xfe" + ('<d>' + " " * 300 + '<?xml version="1.0" encoding="UTF-8"?><p><t>x</t></p></d>').encode("utf-16-le")))
    case("word utf16 long", "docx", docx_zip_document(b"\xff\xfe" + ('<?xml version="1.0" encoding="UTF-16"?><d>' + "<p><t>sixteen \U0001f600 text</t></p>" * 5000 + "</d>").encode("utf-16-le")), 100000)
    case("word utf16 surrogate pair split", "docx", docx_zip_document(b"\xff\xfe" + ("<d><p><t>" + "a" * 32767 + "\U0001f600</t></p></d>").encode("utf-16-le")), 100000)
    case("word latin1 declared", "docx", docx_zip_document('<?xml version="1.0" encoding="ISO-8859-1"?><d><p><t>caf\xe9 \xff \x80 \xa0</t></p></d>'.encode("latin1")))
    case("word latin1 declared lower", "docx", docx_zip_document('<?xml version="1.0" encoding="iso-8859-1"?><d><p><t>caf\xe9</t></p></d>'.encode("latin1")))
    case("word latin1 declared utf8 bytes", "docx", docx_zip_document('<?xml version="1.0" encoding="ISO-8859-1"?><d><p><t>caf\xe9</t></p></d>'.encode("utf-8")))
    case("word latin1 declared with bom", "docx", docx_zip_document(b"\xef\xbb\xbf" + '<?xml version="1.0" encoding="ISO-8859-1"?><d><p><t>caf\xe9</t></p></d>'.encode("latin1")))
    case("word latin1 control", "docx", docx_zip_document('<?xml version="1.0" encoding="ISO-8859-1"?><d><p><t>a\x01b</t></p></d>'.encode("latin1")))
    case("word ascii declared", "docx", docx_zip_document('<?xml version="1.0" encoding="US-ASCII"?><d><p><t>plain</t></p></d>'.encode()))
    case("word ascii declared lower", "docx", docx_zip_document('<?xml version="1.0" encoding="us-ascii"?><d><p><t>plain</t></p></d>'.encode()))
    case("word ascii declared high byte", "docx", docx_zip_document('<?xml version="1.0" encoding="US-ASCII"?><d><p><t>caf\xe9</t></p></d>'.encode("latin1")))
    case("word ascii declared utf8 bytes", "docx", docx_zip_document('<?xml version="1.0" encoding="US-ASCII"?><d><p><t>caf\xe9</t></p></d>'.encode("utf-8")))
    case("word declared cp1252", "docx", docx_zip_document('<?xml version="1.0" encoding="windows-1252"?><d><p><t>plain</t></p></d>'.encode()))
    case("word declared unknown", "docx", docx_zip_document('<?xml version="1.0" encoding="x-unknown"?><d><p><t>plain</t></p></d>'.encode()))
    case("word declared utf32", "docx", docx_zip_document('<?xml version="1.0" encoding="UTF-32"?><d><p><t>plain</t></p></d>'.encode()))
    case("word declared utf8 spaces", "docx", docx_zip_document("<?xml  version = '1.0'  encoding = 'UTF-8' ?><d><p><t>plain</t></p></d>"))
    case("word declared utf8 bom utf8", "docx", docx_zip_document(b"\xef\xbb\xbf\xef\xbb\xbf<d><p><t>plain</t></p></d>"))
    case("word utf8 bom inside text", "docx", docx_zip_document("<d><p><t>a" + chr(0xFEFF) + "b</t></p></d>"))
    case("word declared version odd", "docx", docx_zip_document('<?xml version="1.x"?><d><p><t>v</t></p></d>'))
    case("word declared version 1.1", "docx", docx_zip_document('<?xml version="1.1"?><d><p><t>v</t></p></d>'))
    case("word declared version empty", "docx", docx_zip_document('<?xml version=""?><d><p><t>v</t></p></d>'))
    case("word declared version 1.1 line ends", "docx", docx_zip_document('<?xml version="1.1"?><d><p><t>a\x85b' + chr(0x2028) + 'c</t></p></d>'))
    case("word declared version 1.1 control reference", "docx", docx_zip_document('<?xml version="1.1"?><d><p><t>a&#1;b</t></p></d>'))
    case("word declared version odd chars", "docx", docx_zip_document('<?xml version="1,0"?><d><p><t>v</t></p></d>'))
    case("word declared version letters", "docx", docx_zip_document('<?xml version="A_b-9"?><d><p><t>v</t></p></d>'))
    case("word declared version single quotes", "docx", docx_zip_document("<?xml version = '3.0' ?><d><p><t>v</t></p></d>"))
    case("word declared version mixed quotes", "docx", docx_zip_document("<?xml version='3.0\"?><d><p><t>v</t></p></d>"))
    case("word declared version tab", "docx", docx_zip_document('<?xml\tversion\t=\t"3.0"\r\n?><d><p><t>v</t></p></d>'))
    case("word declared version utf16", "docx", docx_zip_document(b"\xff\xfe" + '<?xml version="3.0" encoding="UTF-16"?><d><p><t>v</t></p></d>'.encode("utf-16-le")))
    case("word ns uri with space", "docx", docx_zip_document('<d xmlns:x="a b"><p><t>ns</t></p></d>'))
    case("word default ns uri with space", "docx", docx_zip_document('<d xmlns="a b"><p><t>ns</t></p></d>'))
    case("word ns uri with newline", "docx", docx_zip_document('<d xmlns:x="a\nb"><p><t>ns</t></p></d>'))
    case("word ns uri with tab reference", "docx", docx_zip_document('<d xmlns:x="a&#9;b"><p><t>ns</t></p></d>'))
    case("word ns uri with space reference", "docx", docx_zip_document('<d xmlns:x="a&#32;b"><p><t>ns</t></p></d>'))
    case("word ns uri with nbsp", "docx", docx_zip_document('<d xmlns:x="a' + chr(0xA0) + 'b"><p><t>ns</t></p></d>'))
    case("word plain attribute with space", "docx", docx_zip_document('<d a="x y"><p><t>ns</t></p></d>'))
    case("word invalid utf8", "docx", docx_zip_document(b"<d><p><t>caf\xe9</t></p></d>"))
    case("word truncated utf8", "docx", docx_zip_document(b"<d><p><t>caf\xc3</t></p></d>"))
    case("word cesu8", "docx", docx_zip_document(b"<d><p><t>\xed\xa0\x80</t></p></d>"))
    case("word overlong utf8", "docx", docx_zip_document(b"<d><p><t>\xc0\xaf</t></p></d>"))
    case("word noncharacter", "docx", docx_zip_document("<d><p><t>\ufffe</t></p></d>"))
    case("word noncharacter ffff", "docx", docx_zip_document("<d><p><t>\uffff</t></p></d>"))
    case("word control char", "docx", docx_zip_document("<d><p><t>\x01</t></p></d>"))
    case("word nul", "docx", docx_zip_document("<d><p><t>\x00</t></p></d>"))
    case("word c1 and separators", "docx", docx_zip_document("<d><p><t>\x85\u2028\u2029\x7f\x9f</t></p></d>"))
    case("word empty part", "docx", docx_zip_document(""))
    case("word whitespace part", "docx", docx_zip_document("  \n"))
    case("word only decl", "docx", docx_zip_document('<?xml version="1.0"?>'))
    case("word text before root", "docx", docx_zip_document("junk<d/>"))
    case("word text after root", "docx", docx_zip_document("<d/>junk"))
    case("word two roots", "docx", docx_zip_document("<d/><d/>"))
    case("word comment after root", "docx", docx_zip_document("<d/><!-- ok -->\n"))
    case("word unclosed", "docx", docx_zip_document("<d><p><t>x</t></p>"))
    case("word mismatched", "docx", docx_zip_document("<d><p><t>x</p></t></d>"))
    case("word lt in text", "docx", docx_zip_document("<d><p><t>a < b</t></p></d>"))
    case("word gt in text", "docx", docx_zip_document("<d><p><t>a > b</t></p></d>"))
    case("word cdata end in text", "docx", docx_zip_document("<d><p><t>a ]]> b</t></p></d>"))
    case("word bare amp", "docx", docx_zip_document("<d><p><t>a & b</t></p></d>"))
    case("word attr no quotes", "docx", docx_zip_document("<d a=1><p><t>x</t></p></d>"))
    case("word attr lt", "docx", docx_zip_document('<d a="<"><p><t>x</t></p></d>'))
    case("word attr dup", "docx", docx_zip_document('<d a="1" a="2"><p><t>x</t></p></d>'))
    case("word attr dup ns", "docx", docx_zip_document('<d xmlns:a="urn:x" xmlns:b="urn:x" a:k="1" b:k="2"><p><t>x</t></p></d>'))
    case("word attr same local different ns", "docx", docx_zip_document('<d xmlns:a="urn:x" xmlns:b="urn:y" a:k="1" b:k="2"><p><t>x</t></p></d>'))
    case("word unbound prefix", "docx", docx_zip_document("<w:d><w:p><w:t>x</w:t></w:p></w:d>"))
    case("word unbound attr prefix", "docx", docx_zip_document('<d w:k="1"><p><t>x</t></p></d>'))
    case("word empty ns decl", "docx", docx_zip_document('<d xmlns:w=""><w:p/></d>'))
    case("word empty default ns decl", "docx", docx_zip_document('<d xmlns=""><p><t>x</t></p></d>'))
    case("word xml prefix", "docx", docx_zip_document('<d xml:space="preserve"><p><t>x</t></p></d>'))
    case("word xml prefix rebound", "docx", docx_zip_document('<d xmlns:xml="urn:x"><p><t>x</t></p></d>'))
    case("word xmlns prefix", "docx", docx_zip_document('<xmlns:d xmlns:xmlns="urn:x"><p><t>x</t></p></xmlns:d>'))
    case("word xml prefix right uri", "docx", docx_zip_document('<d xmlns:xml="http://www.w3.org/XML/1998/namespace"><p><t>x</t></p></d>'))
    case("word colon names", "docx", docx_zip_document("<a:b:c><p><t>x</t></p></a:b:c>"))
    case("word name start colon", "docx", docx_zip_document("<:d><p><t>x</t></p></:d>"))
    case("word name digit", "docx", docx_zip_document("<1d><p><t>x</t></p></1d>"))
    case("word unicode names", "docx", docx_zip_document("<dé><p><t>x</t></p></dé>"))
    case("word space in tag", "docx", docx_zip_document("< d><p><t>x</t></p></d>"))
    case("word space in close tag", "docx", docx_zip_document("<d><p><t>x</t></p ></d >"))
    case("word comment", "docx", docx_zip_document("<d><!-- c --><p><t>x<!-- y -->z</t></p></d>"))
    case("word comment dashes", "docx", docx_zip_document("<d><!-- a -- b --><p><t>x</t></p></d>"))
    case("word comment end dash", "docx", docx_zip_document("<d><!-- a ---><p><t>x</t></p></d>"))
    case("word comment unterminated", "docx", docx_zip_document("<d><!-- a <p><t>x</t></p></d>"))
    case("word pi", "docx", docx_zip_document("<d><?php echo 1 ?><p><t>x</t></p></d>"))
    case("word pi xml", "docx", docx_zip_document("<d><?xml foo?><p><t>x</t></p></d>"))
    case("word pi XML upper", "docx", docx_zip_document("<d><?XML foo?><p><t>x</t></p></d>"))
    case("word pi in text", "docx", docx_zip_document("<d><p><t>a<?pi b?>c</t></p></d>"))
    case("word doctype simple", "docx", docx_zip_document("<!DOCTYPE d><d><p><t>x</t></p></d>"))
    case("word doctype system", "docx", docx_zip_document('<!DOCTYPE d SYSTEM "http://example.invalid/d.dtd"><d><p><t>x</t></p></d>'))
    case("word doctype public", "docx", docx_zip_document('<!DOCTYPE d PUBLIC "-//X//Y" "http://example.invalid/d.dtd"><d><p><t>x</t></p></d>'))
    case("word doctype empty subset", "docx", docx_zip_document("<!DOCTYPE d []><d><p><t>x</t></p></d>"))
    case("word doctype entity", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY a "aaaa">]><d><p><t>&a;</t></p></d>'))
    case("word doctype entity unused", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY a "aaaa">]><d><p><t>x</t></p></d>'))
    case("word doctype element decl", "docx", docx_zip_document("<!DOCTYPE d [<!ELEMENT d ANY>]><d><p><t>x</t></p></d>"))
    case("word doctype parameter entity", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY % p "x"> %p;]><d><p><t>x</t></p></d>'))
    case("word doctype external entity", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d><p><t>&x;</t></p></d>'))
    case("word doctype lowercase", "docx", docx_zip_document("<!doctype d><d><p><t>x</t></p></d>"))
    case("word doctype after root", "docx", docx_zip_document("<d><!DOCTYPE d></d>"))
    case("word doctype unterminated", "docx", docx_zip_document("<!DOCTYPE d [<!ENTITY a 'b'>"))
    case("word doctype with comment", "docx", docx_zip_document("<!DOCTYPE d [<!-- ]> --> ]><d/>"))
    case("word doctype quoted bracket", "docx", docx_zip_document("<!DOCTYPE d [<!ENTITY a \"]>\">]><d/>"))
    case("word predefined redeclared", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY lt "&#38;#60;">]><d><p><t>&lt;</t></p></d>'))
    case("word doctype after bom", "docx", docx_zip_document(b'\xef\xbb\xbf<!DOCTYPE d [<!ENTITY a "x">]><d><p><t>&a;</t></p></d>'))
    laughs = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">' + "".join(f'<!ENTITY e{n} "' + f"&e{n - 1};" * 10 + '">' for n in range(1, 8)).replace("&e0;", "&a;") + "]>"
    case("word billion laughs", "docx", docx_zip_document(laughs + '<d><p><t>&e7;</t></p></d>'))
    case("word quadratic blowup", "docx", docx_zip_document('<!DOCTYPE d [<!ENTITY a "' + "a" * 5000 + '">]><d><p><t>' + "&a;" * 5000 + "</t></p></d>"))
    case("word deep nesting", "docx", docx_zip_document("<d>" + "<p>" * 3000 + "<t>deep</t>" + "</p>" * 3000 + "</d>"))
    case("word many attributes", "docx", docx_zip_document("<d " + " ".join(f'a{n}="{n}"' for n in range(2000)) + "><p><t>attrs</t></p></d>"))
    case("word long name", "docx", docx_zip_document("<" + "x" * 100_000 + "><p><t>name</t></p></" + "x" * 100_000 + ">"))
    case("word self closing t", "docx", docx_zip_document("<d><p><t/></p></d>"))
    case("word t empty then text", "docx", docx_zip_document("<d><p><t></t>after</p></d>"))
    case("word p inside t", "docx", docx_zip_document("<d><t>a<p>b</p>c</t></d>"))
    case("word whitespace kept", "docx", docx_zip_document("<d><p><t>  a  b\t c  </t></p></d>"))
    case("word standalone", "docx", docx_zip_document('<?xml version="1.0" standalone="maybe"?><d/>'))
    case("word root is t", "docx", docx_zip_document("<t>root</t>"))
    # The main part is chosen by the package's relationships.
    for name, parts in {
        "missing rels": {"word/document.xml": "<d/>"},
        "strict namespace": {"_rels/.rels": rels(("rId1", "officeDocument", "word/document.xml"), base=STRICT_R), "word/document.xml": "<d><p><t>strict</t></p></d>"},
        "absolute target": {"_rels/.rels": rels(("rId1", "officeDocument", "/word/document.xml")), "word/document.xml": "<d><p><t>abs</t></p></d>"},
        "dot target": {"_rels/.rels": rels(("rId1", "officeDocument", "./word/../word/document.xml")), "word/document.xml": "<d><p><t>dots</t></p></d>"},
        "double slash target": {"_rels/.rels": rels(("rId1", "officeDocument", "word//document.xml")), "word/document.xml": "<d><p><t>slashes</t></p></d>"},
        "dotdot above root": {"_rels/.rels": rels(("rId1", "officeDocument", "../word/document.xml")), "word/document.xml": "<d><p><t>up</t></p></d>"},
        "absolute dotdot": {"_rels/.rels": rels(("rId1", "officeDocument", "/../word/document.xml")), "word/document.xml": "<d><p><t>up</t></p></d>"},
        "triple slash target": {"_rels/.rels": rels(("rId1", "officeDocument", "///word/document.xml")), "word/document.xml": "<d><p><t>up</t></p></d>"},
        "backslash target": {"_rels/.rels": rels(("rId1", "officeDocument", "word\\document.xml")), "word/document.xml": "<d><p><t>bs</t></p></d>"},
        "empty target": {"_rels/.rels": rels(("rId1", "officeDocument", "")), "word/document.xml": "<d/>"},
        "target is dot": {"_rels/.rels": rels(("rId1", "officeDocument", ".")), "word/document.xml": "<d/>"},
        "wrong type": {"_rels/.rels": rels(("rId1", "image", "word/document.xml")), "word/document.xml": "<d/>"},
        "type suffix only": {"_rels/.rels": f'<Relationships xmlns="{PACKAGE}"><Relationship Id="a" Type="x/officeDocument" Target="word/d.xml"/></Relationships>', "word/d.xml": "<d><p><t>suffix</t></p></d>"},
        "external first": {
            "_rels/.rels": f'<Relationships xmlns="{PACKAGE}"><Relationship Id="a" Type="{R}/officeDocument" Target="http://example.invalid/x" TargetMode="External"/><Relationship Id="b" Type="{R}/officeDocument" Target="word/d.xml"/></Relationships>',
            "word/d.xml": "<d><p><t>second</t></p></d>",
        },
        "two main": {
            "_rels/.rels": rels(("a", "officeDocument", "word/one.xml"), ("b", "officeDocument", "word/two.xml")),
            "word/one.xml": "<d><p><t>one</t></p></d>",
            "word/two.xml": "<d><p><t>two</t></p></d>",
        },
        "duplicate id": {
            "_rels/.rels": rels(("a", "officeDocument", "word/one.xml"), ("a", "officeDocument", "word/two.xml")),
            "word/one.xml": "<d><p><t>one</t></p></d>",
            "word/two.xml": "<d><p><t>two</t></p></d>",
        },
        "duplicate id other type": {
            "_rels/.rels": rels(("a", "officeDocument", "word/one.xml"), ("b", "image", "x.png"), ("a", "image", "y.png")),
            "word/one.xml": "<d><p><t>one</t></p></d>",
        },
        "missing attributes": {
            "_rels/.rels": f'<Relationships xmlns="{PACKAGE}"><Relationship Type="{R}/officeDocument" Target="word/d.xml"/><Relationship Id="b" Target="word/d.xml"/><Relationship Id="c" Type="{R}/officeDocument"/></Relationships>',
            "word/d.xml": "<d/>",
        },
        "namespaced attributes": {
            "_rels/.rels": f'<r:Relationships xmlns:r="{PACKAGE}" xmlns:q="urn:q"><r:Relationship q:Id="a" q:Type="{R}/officeDocument" q:Target="word/d.xml"/></r:Relationships>',
            "word/d.xml": "<d><p><t>ns</t></p></d>",
        },
        "both plain and namespaced attribute": {
            "_rels/.rels": f'<Relationships xmlns="{PACKAGE}" xmlns:q="urn:q"><Relationship q:Id="a" Id="b" Type="{R}/officeDocument" Target="word/d.xml"/></Relationships>',
            "word/d.xml": "<d><p><t>both</t></p></d>",
        },
        "target mode lower": {
            "_rels/.rels": f'<Relationships xmlns="{PACKAGE}"><Relationship Id="a" Type="{R}/officeDocument" Target="http://example.invalid/x" TargetMode="external"/></Relationships>',
        },
        "target missing in archive": {"_rels/.rels": rels(("rId1", "officeDocument", "word/gone.xml"))},
        "rels not xml": {"_rels/.rels": "not xml"},
        "rels with doctype": {"_rels/.rels": '<!DOCTYPE r><Relationships xmlns="' + PACKAGE + '"/>'},
        "main in folder": {
            "_rels/.rels": rels(("rId1", "officeDocument", "a/b/c.xml")),
            "a/b/c.xml": "<d><p><t>folder</t></p></d>",
        },
        "case sensitive": {"_rels/.rels": rels(("rId1", "officeDocument", "Word/document.xml")), "word/document.xml": "<d/>"},
    }.items():
        case(f"word package {name}", "docx", zipped(parts))
    case("word kind mismatch pptx", "pptx", docx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"))
    case("word kind mismatch xlsx", "xlsx", docx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"))
    case("not a zip", "docx", b"not a zip")
    case("empty file", "docx", b"")
    case("zip without parts", "docx", zipped({"word/document.xml": "<x/>"}))


def docx_zip_document(document: str | bytes) -> bytes:
    parts = docx_parts("", document if isinstance(document, str) else "")
    if isinstance(document, bytes):
        parts["word/document.xml"] = document
    return zipped(parts)


def powerpoint_cases() -> None:
    case("pptx basic", "pptx", zipped(pptx_parts()))
    case("pptx limit", "pptx", zipped(pptx_parts()), 9)
    case("pptx limit 1", "pptx", zipped(pptx_parts()), 1)
    case("pptx limit slide header", "pptx", zipped(pptx_parts()), 8)
    case("pptx limit exact", "pptx", zipped(pptx_parts()), 34)
    case("pptx br", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><a:p><a:r><a:t>a</a:t><a:br/><a:t>b</a:t></a:r></a:p></p:sld>', "ppt/slides/slide2.xml": "<s/>"})))
    case("pptx tab is not a mark", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": f'<s xmlns:a="{A}"><a:p><a:t>a</a:t><a:tab/><a:t>b</a:t></a:p></s>', "ppt/slides/slide2.xml": "<s/>"})))
    case("pptx no slides", "pptx", zipped(pptx_parts(ids="")))
    case("pptx missing relationship", "pptx", zipped(pptx_parts(ids='<p:sldId id="1" r:id="rId9"/><p:sldId id="257" r:id="rId3"/>')))
    case("pptx sldId without rid", "pptx", zipped(pptx_parts(ids='<p:sldId id="256"/><p:sldId id="257" r:id="rId3"/>')))
    case("pptx sldId plain id attribute only", "pptx", zipped(pptx_parts(ids='<p:sldId id="rId3"/>')))
    case("pptx rid in strict namespace", "pptx", zipped(pptx_parts(ids=f'<p:sldId id="1" s:id="rId3" xmlns:s="{STRICT_R}"/>')))
    case("pptx rid in other namespace", "pptx", zipped(pptx_parts(ids='<p:sldId id="1" s:id="rId3" xmlns:s="http://example.invalid/ns"/>')))
    case("pptx rid with slash suffix", "pptx", zipped(pptx_parts(ids='<p:sldId id="1" s:id="rId3" xmlns:s="http://example.invalid/relationships"/>')))
    case("pptx rid namespace with space-like", "pptx", zipped(pptx_parts(ids='<p:sldId id="1" s:id="rId3" xmlns:s="a b/relationships"/>')))
    case("pptx rid attribute named id in two namespaces", "pptx", zipped(pptx_parts(ids=f'<p:sldId id="1" s:id="rId3" t:id="rId2" xmlns:s="{R}" xmlns:t="{STRICT_R}"/>')))
    case("pptx duplicate slide", "pptx", zipped(pptx_parts(ids='<p:sldId r:id="rId3"/><p:sldId r:id="rId3"/>')))
    case("pptx sldId elsewhere", "pptx", zipped(pptx_parts(ids='<x><p:sldId r:id="rId3"/></x><sldId xmlns:r="' + R + '" r:id="rId2"/>')))
    case("pptx missing slide part", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": slide("only one")})))
    case("pptx no rels part", "pptx", zipped({k: v for k, v in pptx_parts().items() if k != "ppt/_rels/presentation.xml.rels"}))
    case("pptx external slide", "pptx", zipped(pptx_parts(relationships=f'<Relationships xmlns="{PACKAGE}"><Relationship Id="rId3" Type="{R}/slide" Target="http://example.invalid/s.xml" TargetMode="External"/><Relationship Id="rId2" Type="{R}/slide" Target="slides/slide1.xml"/></Relationships>')))
    case("pptx absolute slide", "pptx", zipped(pptx_parts(relationships=rels(("rId2", "slide", "/ppt/slides/slide1.xml"), ("rId3", "slide", "../ppt/slides/slide2.xml")))))
    case("pptx slide not xml", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": "oops", "ppt/slides/slide2.xml": "<s/>"})))
    case("pptx slide doctype", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": '<!DOCTYPE s [<!ENTITY a "b">]><s/>', "ppt/slides/slide2.xml": "<s/>"})))
    case("pptx unread slide not xml after limit", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": slide("x" * 100), "ppt/slides/slide2.xml": "oops"})), 20)
    case("pptx same slide twice in rels", "pptx", zipped(pptx_parts(relationships=rels(("rId2", "slide", "slides/slide1.xml"), ("rId3", "slide", "slides/slide1.xml")))))
    case("pptx presentation not xml", "pptx", zipped(pptx_parts() | {"ppt/presentation.xml": "nope"}))
    case("pptx whole presentation limit hit in slide", "pptx", zipped(pptx_parts(slides={"ppt/slides/slide1.xml": slide("x" * 100), "ppt/slides/slide2.xml": slide("y")})), 30)
    case("pptx hundred slides", "pptx", zipped(pptx_parts(
        ids="".join(f'<p:sldId id="{n}" r:id="r{n}"/>' for n in range(100)),
        relationships=rels(*[(f"r{n}", "slide", f"slides/s{n}.xml") for n in range(100)]),
        slides={f"ppt/slides/s{n}.xml": slide(f"text {n}") for n in range(100)},
    )), 1000)


def excel_cases() -> None:
    strings = "<si><t>Name</t></si><si><r><t>Ad</t></r><r><t>a</t></r><rPh><t>reading</t></rPh></si>"
    case("excel test workbook", "xlsx", zipped(xlsx_parts(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>a,b</t></is></c></row>'
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>40+2</f><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>', strings)))
    case("excel limit 8", "xlsx", zipped(xlsx_parts('<row><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row>')), 8)
    case("excel limit 100", "xlsx", zipped(xlsx_parts('<row><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row>')), 100)
    case("excel limit 12", "xlsx", zipped(xlsx_parts('<row><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row>')), 12)
    case("excel limit 11", "xlsx", zipped(xlsx_parts('<row><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row>')), 11)
    case("excel limit 2 rows", "xlsx", zipped(xlsx_parts(row(cell("A1", "ab")) + row(cell("A2", "cd")))), 4)
    case("excel limit 1", "xlsx", zipped(xlsx_parts(row(cell("A1", "ab")))), 1)
    case("excel limit 0", "xlsx", zipped(xlsx_parts(row(cell("A1", "ab")))), 0)
    for name, kind, value, shared in [
        ("s valid", "s", "0", "<si><t>zero</t></si><si><t>one</t></si>"),
        ("s one", "s", "1", "<si><t>zero</t></si><si><t>one</t></si>"),
        ("s out of range", "s", "2", "<si><t>zero</t></si><si><t>one</t></si>"),
        ("s negative", "s", "-1", "<si><t>zero</t></si>"),
        ("s fraction", "s", "1.5", "<si><t>zero</t></si>"),
        ("s spaces", "s", " 0 ", "<si><t>zero</t></si>"),
        ("s empty", "s", "", "<si><t>zero</t></si>"),
        ("s plus", "s", "+0", "<si><t>zero</t></si>"),
        ("s leading zeros", "s", "000", "<si><t>zero</t></si>"),
        ("s arabic indic digit", "s", "٠", "<si><t>zero</t></si>"),
        ("s fullwidth digit", "s", "０", "<si><t>zero</t></si>"),
        ("s superscript", "s", "²", "<si><t>zero</t></si>"),
        ("s circled", "s", "①", "<si><t>zero</t></si>"),
        ("s mixed digit only and decimal", "s", "1²", "<si><t>zero</t></si>"),
        ("s hex", "s", "0x1", "<si><t>zero</t></si>"),
        ("s underscore", "s", "1_0", "<si><t>zero</t></si>"),
        ("s huge", "s", "9" * 400, "<si><t>zero</t></si>"),
        ("s 4300 digits", "s", "0" * 4300, "<si><t>zero</t></si>"),
        ("s 4301 digits", "s", "0" * 4301, "<si><t>zero</t></si>"),
        ("s 4301 digits last", "s", "1" * 4301, "<si><t>zero</t></si>"),
        ("s unicode digits long", "s", "٣" * 5000, "<si><t>zero</t></si>"),
        ("s no shared part", "s", "0", None),
        ("b one", "b", "1", None),
        ("b zero", "b", "0", None),
        ("b two", "b", "2", None),
        ("b text", "b", "true", None),
        ("b empty", "b", "", None),
        ("str", "str", "formula text", None),
        ("e", "e", "#N/A", None),
        ("n", "n", "1.50", None),
        ("d", "d", "2026-10-01", None),
        ("unknown", "zz", "x", None),
    ]:
        case(f"excel cell {name}", "xlsx", zipped(xlsx_parts(row(cell("A1", value, kind)), shared)))
    case("excel inline strings", "xlsx", zipped(xlsx_parts(row(cell("A1", "a", "inlineStr", "is") .replace("<is>a</is>", "<is><t>a</t></is>"), '<c r="B1" t="inlineStr"><is><r><t>rich</t></r><r><t> text</t></r></is></c>', '<c r="C1" t="inlineStr"><is><t>x</t><rPh><t>y</t></rPh></is></c>'))))
    case("excel inline v and t", "xlsx", zipped(xlsx_parts(row('<c r="A1" t="inlineStr"><is><t>a</t></is><v>b</v></c>', '<c r="B1"><is><t>c</t></is></c>', '<c r="C1"><t>d</t></c>', '<c r="D1"><v>e<t>f</t>g</v></c>'))))
    case("excel nested v flags", "xlsx", zipped(xlsx_parts(row('<c r="A1"><v>a<x><v>b</v>c</x>d</v></c>', '<c r="B1"><is><t>a<t>b</t>c</t></is></c>'))))
    for name, refs in {
        "refs in order": ["A1", "B1", "C1"],
        "refs out of order": ["C1", "A1", "B1"],
        "refs with gaps": ["B1", "E1"],
        "refs duplicated": ["A1", "A1", "B1"],
        "refs lowercase": ["a1", "b1"],
        "refs three letters": ["AAA1", "B1"],
        "refs four letters": ["AAAA1", "B1"],
        "refs no digits": ["A", "B1"],
        "refs digit only": ["1", "B1"],
        "refs trailing junk": ["A1B", "B1"],
        "refs last column kept": ["GR1", "A1"],
        "refs first dropped column": ["GS1", "A1"],
        "refs far column": ["XFD1", "A1"],
        "refs only dropped": ["XFD1", "GS1"],
        "refs unicode digits": ["A١", "B٢"],
        "refs superscript digit": ["A²", "B1"],
        "refs newline": ["A1\n", "B1"],
        "refs spaces": [" A1", "B1"],
        "refs empty": ["", "B1"],
        "refs none": [None, None, "C1", None],
        "refs mixed none": ["B1", None, None],
        "refs fallback after high": ["F1", None, None],
        "refs fallback after dropped": ["XFD1", None],
    }.items():
        case(f"excel {name}", "xlsx", zipped(xlsx_parts(row(*[cell(ref, f"v{n}") for n, ref in enumerate(refs)]))))
    case("excel wide row", "xlsx", zipped(xlsx_parts(row(*[cell(None, str(n)) for n in range(300)]))))
    case("excel wide row letters", "xlsx", zipped(xlsx_parts(row(cell("A1", "first"), cell("GR1", "last199"), cell("GS1", "dropped200")))))
    case("excel empty row", "xlsx", zipped(xlsx_parts(row() + row(cell("A2", "x")))))
    case("excel row only empty cells", "xlsx", zipped(xlsx_parts(row(cell("A1", "")) + row(cell("A2", ""), cell("B2", "")) + row(cell("C3", "")))))
    case("excel row first cell empty", "xlsx", zipped(xlsx_parts(row(cell("A1", ""), cell("B1", "x")))))
    case("excel row only dropped cell", "xlsx", zipped(xlsx_parts(row(cell("XFD1", "x")) + row(cell("A2", "ok")))))
    case("excel no cell value", "xlsx", zipped(xlsx_parts(row('<c r="A1"/>', '<c r="B1"></c>', '<c r="C1"><f>1+1</f></c>'))))
    case("excel cell outside row", "xlsx", zipped(xlsx_parts(cell("A1", "lost"))))
    case("excel c inside c", "xlsx", zipped(xlsx_parts(row('<c r="A1"><c r="B1"><v>inner</v></c><v>outer</v></c>'))))
    case("excel row inside row", "xlsx", zipped(xlsx_parts('<row><c r="A1"><v>a</v></c><row><c r="B1"><v>b</v></c></row><c r="C1"><v>c</v></c></row>')))
    case("excel v outside c", "xlsx", zipped(xlsx_parts('<row><v>stray</v><c r="A1"><v>a</v></c></row>')))
    case("excel csv quoting", "xlsx", zipped(xlsx_parts(
        row(cell("A1", "plain"), cell("B1", "a,b"), cell("C1", "say &quot;hi&quot;"), cell("D1", "two&#10;lines"), cell("E1", "cr&#13;only"), cell("F1", " lead and trail "), cell("G1", "tab&#9;x"))
        + row(cell("A2", "&#13;&#10;"), cell("B2", "&quot;"), cell("C2", ",")))))
    case("excel csv single empty field", "xlsx", zipped(xlsx_parts(row(cell("A1", "")))))
    case("excel csv leading empty field", "xlsx", zipped(xlsx_parts(row(cell("B1", "x")))))
    case("excel csv space only", "xlsx", zipped(xlsx_parts(row(cell("A1", " ")))))
    case("excel csv unicode", "xlsx", zipped(xlsx_parts(row(cell("A1", "Zażółć"), cell("B1", "\U0001f600"), cell("C1", "\u2028"), cell("D1", "\x85"), cell("E1", "\xa0")))))
    case("excel csv cut mid quote", "xlsx", zipped(xlsx_parts(row(cell("A1", "a&quot;b&quot;c"), cell("B1", "d,e")))), 6)
    case("excel csv cut mid row", "xlsx", zipped(xlsx_parts(row(cell("A1", "abc"), cell("B1", "def"), cell("C1", "ghi")))), 6)
    case("excel csv cut emoji", "xlsx", zipped(xlsx_parts(row(cell("A1", "\U0001f600\U0001f600\U0001f600"), cell("B1", "x")))), 3)
    case("excel shared rich text", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space=\"preserve\"> plain</t></r><phoneticPr/></si>")))
    case("excel shared rph nested", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>keep</t><rPh sb=\"0\"><t>drop</t><rPh><t>drop2</t></rPh><t>drop3</t></rPh><t>kept</t></si>")))
    case("excel shared si nested t", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>a<t>b</t>c</t></si>")))
    case("excel shared reset", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s"), cell("B1", "1", "s")), "<si><t>one</t><si><t>two</t></si></si><si><t>three</t></si>")))
    case("excel shared outside si", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<t>stray</t><si><t>one</t></si>")))
    case("excel shared empty si", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s"), cell("B1", "1", "s")), "<si/><si><t/></si>")))
    case("excel shared unbalanced", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>x</si>")))
    case("excel shared 4MiB exact", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>" + "x" * (4 * 1024 * 1024) + "</t></si>")), 5)
    case("excel shared over 4MiB", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>" + "x" * (4 * 1024 * 1024 + 1) + "</t></si>")), 5)
    case("excel shared over 4MiB in two", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>" + "x" * (3 * 1024 * 1024) + "</t></si><si><t>" + "y" * (1024 * 1024 + 1) + "</t></si>")), 5)
    case("excel shared 4MiB with rph", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>a</t><rPh><t>" + "x" * (5 * 1024 * 1024) + "</t></rPh></si>")), 5)
    case("excel shared emoji count", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>" + "\U0001f600" * (2 * 1024 * 1024 + 1) + "</t></si>")), 5)
    case("excel shared not xml", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>x</t></si") | {}), 5)
    case("excel shared doctype", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s"))) | {"xl/sharedStrings.xml": '<!DOCTYPE s [<!ENTITY a "b">]><sst/>'}))
    case("excel shared part missing", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s"))) | {}))
    case("excel shared target not in archive", "xlsx", zipped({k: v for k, v in xlsx_parts(row(cell("A1", "0", "s")), "<si><t>x</t></si>").items() if k != "xl/sharedStrings.xml"}))
    case("excel shared external", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>x</t></si>", sheet_rels=f'<Relationships xmlns="{PACKAGE}"><Relationship Id="rId2" Type="{R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="{R}/sharedStrings" Target="http://example.invalid/s.xml" TargetMode="External"/></Relationships>')))
    case("excel two shared string parts", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>first</t></si>", sheet_rels=rels(("rId2", "worksheet", "worksheets/sheet2.xml"), ("a", "sharedStrings", "sharedStrings.xml"), ("b", "sharedStrings", "other.xml"))) | {"xl/other.xml": f'<sst xmlns="{S}"><si><t>second</t></si></sst>'}))
    case("excel first sheet is first in workbook", "xlsx", zipped(xlsx_parts(row(cell("A1", "summary")))))
    case("excel sheet without rid", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="a"/><sheet name="b" r:id="rId2"/></sheets></workbook>')))
    case("excel sheet rid missing in rels", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="a" r:id="nope"/><sheet name="b" r:id="rId2"/></sheets></workbook>')))
    case("excel no sheets", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}"><sheets/></workbook>')))
    case("excel sheet part missing", "xlsx", zipped({k: v for k, v in xlsx_parts(row(cell("A1", "x"))).items() if k != "xl/worksheets/sheet2.xml"}))
    case("excel sheet not xml", "xlsx", zipped(xlsx_parts(row(cell("A1", "x"))) | {"xl/worksheets/sheet2.xml": "nope"}))
    case("excel sheet truncated", "xlsx", zipped(xlsx_parts(row(cell("A1", "x"))) | {"xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData><row><c><v>x</v></c></row>'}))
    case("excel sheet truncated after limit", "xlsx", zipped(xlsx_parts(row(cell("A1", "x" * 50))) | {"xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData><row><c><v>' + "x" * 50 + "</v></c></row><row><c><v>x</v></c>"}), 10)
    case("excel sheet doctype", "xlsx", zipped(xlsx_parts(row(cell("A1", "x"))) | {"xl/worksheets/sheet2.xml": '<!DOCTYPE s [<!ENTITY a "b">]><worksheet/>'}))
    case("excel sheet rid in strict namespace", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}" xmlns:r="{STRICT_R}"><sheets><sheet name="a" r:id="rId2"/></sheets></workbook>')))
    case("excel sheet rid in other namespace", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}" xmlns:r="urn:other"><sheets><sheet name="a" r:id="rId2"/></sheets></workbook>')))
    case("excel sheet plain id attribute", "xlsx", zipped(xlsx_parts(row(cell("A1", "x")), workbook=f'<workbook xmlns="{S}"><sheets><sheet name="a" id="rId2"/></sheets></workbook>')))
    case("excel dates are numbers", "xlsx", zipped(xlsx_parts(row(cell("A1", "46296", None), cell("B1", "0.5")))))
    case("excel many rows", "xlsx", zipped(xlsx_parts("".join(row(cell(f"A{n}", str(n)), cell(f"B{n}", f"row {n}")) for n in range(1, 400)))), 1500)
    case("excel row cut across cells budget", "xlsx", zipped(xlsx_parts(row(*[cell(None, "abcdefghij") for _ in range(20)]))), 35)
    case("excel shared string repeated", "xlsx", zipped(xlsx_parts(row(*[cell(None, "0", "s") for _ in range(50)]), "<si><t>" + "z" * 1000 + "</t></si>")), 300)
    shared_long = "x" * (3 * 1024 * 1024)
    case("excel python test long shared", "xlsx", zipped(xlsx_parts(
        f'<row r="1">{"<c t=" + chr(34) + "s" + chr(34) + "><v>0</v></c>" * 200}</row><row r="2">{"<c t=" + chr(34) + "s" + chr(34) + "><v>0</v></c>" * 200}</row>', f"<si><t>{shared_long}</t></si>")), 1000)


def padding_cases() -> None:
    """Expansion bounded across parts: each part is small enough alone, the sum is not."""
    spaces = " " * (office.MAX_EXPANDED + 1)
    case("bomb one part", "docx", zipped(docx_parts("", f'<w:document xmlns:w="{W}">{spaces}</w:document>')), 1000)
    just_under = " " * (office.MAX_EXPANDED - 1000)
    case("bomb just under", "docx", zipped(docx_parts("", f'<w:document xmlns:w="{W}">{just_under}<w:p><w:r><w:t>end</w:t></w:r></w:p></w:document>')), 1000)
    half = " " * (office.MAX_EXPANDED // 2 + 100)
    case("bomb two parts", "xlsx", zipped(xlsx_parts(row(cell("A1", "0", "s")), "<si><t>x</t></si>" + "<!--" + "-" * 0 + half + "-->") | {"xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData>{row(cell("A1", "0", "s"))}</sheetData><!--{half}--></worksheet>'}), 1000)
    case("bomb in rels", "docx", zipped(docx_parts("", f'<d/>') | {"_rels/.rels": f'<Relationships xmlns="{PACKAGE}">' + " " * (office.MAX_EXPANDED + 1) + "</Relationships>"}), 1000)
    case("bomb limit reached first", "docx", zipped(docx_parts("", f'<w:document xmlns:w="{W}"><w:p><w:r><w:t>' + "a" * 100 + f"</w:t></w:r></w:p>{spaces}</w:document>")), 50)
    for count in (office.MAX_ENTRIES - 1, office.MAX_ENTRIES, office.MAX_ENTRIES + 1):
        # Thousands of entries are 600 KB of base64 each: the vector holds the recipe, and the test builds the archive.
        parts = {"_rels/.rels": rels(("rId1", "officeDocument", "word/document.xml")), "word/document.xml": "<d><p><t>crowd</t></p></d>"}
        filler = {f"p{n}.xml": "" for n in range(count - 2)}
        case(f"entries {count}", "docx", zipped({**parts, **filler}))
        CROWDED[f"entries {count}"] = {"$crowd": {"parts": parts, "empty": count - 2}}
    parts = {"_rels/.rels": rels(("rId1", "officeDocument", "word/document.xml")), "word/document.xml": "<d><p><t>many</t></p></d>"}
    case("many entries ok", "docx", zipped({**parts, **{f"p{n}.xml": "" for n in range(300)}}))
    CROWDED["many entries ok"] = {"$crowd": {"parts": parts, "empty": 300}}


def xml_fuzz_cases() -> None:
    vocabulary = [
        "<", ">", "</", "/>", "<t>", "</t>", "<p>", "</p>", "<c>", "</c>", "<v>", "</v>", "<si>", "</si>", "<row>", "</row>", "&", "&amp;", "&lt;",
        "&#65;", "&#x0;", "&#0;", "&#xD800;", "&#x10FFFF;", "&bogus;", "&#", "&#x", ";", "<!--", "-->", "--", "<![CDATA[", "]]>", "<?", "?>", "<?xml?>",
        "<!DOCTYPE d>", "<!", '"', "'", "=", ":", " ", "\n", "\r", "\t", "xmlns", 'xmlns:w="urn:x"', 'xml:space="preserve"', "w:", "x:", "\x01", "\ufffe",
        "\ufeff", "\u0085", "\u2028", "é", "\U0001f600", 'r="A1"', 't="s"', 'r:id="rId1"', "/", "\\", "[", "]", "!", "%", "#", "²", "٣",
    ]  # fmt: skip

    def mutate(text: str) -> str:
        for _ in range(random.randint(1, 3)):
            at = random.randint(0, len(text))
            kind = random.random()
            if kind < 0.45:
                text = text[:at] + random.choice(vocabulary) + text[at:]
            elif kind < 0.7:
                text = text[:at] + text[at + random.randint(1, 6) :]
            elif kind < 0.85:
                text = text[:at] + random.choice(vocabulary) + text[at + 1 :]
            else:
                end = min(len(text), at + random.randint(1, 20))
                text = text[:end] + text[at:end] + text[end:]
        return text

    strings = "<si><t>Name</t></si><si><r><t>Ad</t></r><r><t>a</t></r><rPh><t>reading</t></rPh></si>"
    sheet = (
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>a,b</t></is></c></row>'
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>40+2</f><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>'
    )
    templates = [
        ("docx", docx_parts("<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t><w:br/></w:r></w:p>"), "word/document.xml"),
        ("docx", docx_parts("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"), "_rels/.rels"),
        ("pptx", pptx_parts(), "ppt/presentation.xml"),
        ("pptx", pptx_parts(), "ppt/slides/slide1.xml"),
        ("pptx", pptx_parts(), "ppt/_rels/presentation.xml.rels"),
        ("xlsx", xlsx_parts(sheet, strings), "xl/worksheets/sheet2.xml"),
        ("xlsx", xlsx_parts(sheet, strings), "xl/sharedStrings.xml"),
        ("xlsx", xlsx_parts(sheet, strings), "xl/workbook.xml"),
        ("xlsx", xlsx_parts(sheet, strings), "xl/_rels/workbook.xml.rels"),
    ]
    for n in range(XML_FUZZ):
        kind, parts, target = templates[n % len(templates)]
        mutated = dict(parts)
        mutated[target] = mutate(str(parts[target]))
        case(f"xml fuzz {n}", kind, zipped(mutated), random.choice([10_000, 10_000, 10_000, 5, 20, 40]))


def zip_cases() -> list[tuple[str, bytes]]:
    base = docx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>")
    two = zipped({"a.xml": "<a>" + "x" * 300 + "</a>", "b.xml": "<b/>"})
    cases: list[tuple[str, bytes]] = [
        ("deflated", base),
        ("stored", zipped(docx_parts("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"), zipfile.ZIP_STORED)),
        ("two parts", two),
        ("empty archive", zipped({})),
        ("empty archive bytes", struct.pack("<IHHHHIIH", END, 0, 0, 0, 0, 0, 0, 0)),
        ("empty part", zipped({"a.xml": ""})),
        ("empty part stored", zipped({"a.xml": ""}, zipfile.ZIP_STORED)),
        ("not zip", b"not a zip"),
        ("empty", b""),
        ("short", b"PK"),
        ("comment", base[:-2] + struct.pack("<H", 10) + b"0123456789"),
        ("comment with signature", base[:-2] + struct.pack("<H", 8) + b"PK\x05\x06abcd"),
        ("comment length too short", base[:-2] + struct.pack("<H", 2) + b"0123456789"),
        ("comment length too long", base[:-2] + struct.pack("<H", 50) + b"0123456789"),
        ("comment 65535", raw_zip([named("a.xml", b"<a/>")], comment=b"c" * 65535)),
        ("comment 65536 trailing", raw_zip([named("a.xml", b"<a/>")], comment=b"c" * 10) + b"x" * 70000),
        ("trailing garbage", base + b"garbage"),
        ("trailing zeros", base + b"\x00" * 100),
        ("prefix", b"MZ" + b"\x00" * 100 + base),
        ("prefix large", b"x" * 5000 + base),
        ("two archives", base + base),
        ("junk then signature in prefix", b"PK\x05\x06" + b"\x00" * 18 + base),
    ]
    for length in (len(base) - 1, len(base) - 5, len(base) - 22, len(base) - 23, len(base) // 2, 60, 30, 22, 21):
        cases.append((f"truncated {length}", base[:length]))
    cases += [
        ("duplicate names", raw_zip([named("a.xml", b"<a/>"), named("a.xml", b"<b/>")])),
        ("names differing in case", raw_zip([named("a.xml", b"<a/>"), named("A.xml", b"<b/>")])),
        ("name with nul", raw_zip([named("a.xml\x00b", b"<a/>"), named("c.xml", b"<c/>")])),
        ("names equal after nul cut", raw_zip([named("a.xml\x00b", b"<a/>"), named("a.xml\x00c", b"<c/>")])),
        ("name nul first", raw_zip([named("\x00a", b"<a/>")])),
        ("name utf8 flagged", raw_zip([named("é/ü.xml", b"<a/>", flags=0x800)])),
        ("name utf8 not flagged", raw_zip([named("é/ü.xml", b"<a/>")])),
        ("name cp437", raw_zip([{"name": b"caf\x82.xml", "data": b"<a/>"}])),
        ("name cp437 all high", raw_zip([{"name": bytes(range(0x80, 0x100)) + b".xml", "data": b"<a/>"}])),
        ("name invalid utf8 flagged", raw_zip([{"name": b"caf\xe9.xml", "data": b"<a/>", "flags": 0x800}])),
        ("name empty", raw_zip([named("", b"<a/>")])),
        ("name slash", raw_zip([named("/a.xml", b"<a/>"), named("b/", b"")])),
        ("name long", raw_zip([named("n" * 60000 + ".xml", b"<a/>")])),
        ("name backslash", raw_zip([named("a\\b.xml", b"<a/>")])),
        ("name dotdot", raw_zip([named("../a.xml", b"<a/>")])),
        ("name emoji", raw_zip([named("\U0001f600.xml", b"<a/>", flags=0x800)])),
        ("name nfd nfc", raw_zip([named("e\u0301.xml", b"<a/>", flags=0x800), named("é.xml", b"<b/>", flags=0x800)])),
        ("local name differs", raw_zip([named("a.xml", b"<a/>", local_name=b"b.xml")])),
        ("local name longer", raw_zip([named("a.xml", b"<a/>", local_name=b"a.xmlx")])),
        ("local name utf8 flag differs", raw_zip([named("é.xml", b"<a/>", flags=0x800, local_flags=0)])),
        ("local name utf8 flag differs ascii", raw_zip([named("a.xml", b"<a/>", local_flags=0x800)])),
        ("local name invalid utf8", raw_zip([{"name": b"a.xml", "data": b"<a/>", "local_flags": 0x800, "local_name": b"\xff.xml"}])),
        ("local extra differs", raw_zip([named("a.xml", b"<a/>", local_extra=b"\x01\x02\x03\x04")])),
        ("local extra longer than file", raw_zip([named("a.xml", b"<a/>", local_extra=b"\x00" * 60000)])),
        ("local signature bad", raw_zip([named("a.xml", b"<a/>")]).replace(struct.pack("<I", LOCAL), b"PK\x03\x05", 1)),
        ("offset beyond file", raw_zip([named("a.xml", b"<a/>", offset=100000)])),
        ("offset into middle", raw_zip([named("a.xml", b"<a/>", offset=5)])),
        ("offset negative via prefix", raw_zip([named("a.xml", b"<a/>")])[4:]),
        ("method stored", raw_zip([named("a.xml", b"<a/>", method=0)])),
        ("method deflate64", raw_zip([named("a.xml", b"<a/>", method=9, packed=b"<a/>")])),
        ("method bzip2", raw_zip([named("a.xml", b"<a/>", method=12, packed=b"BZh9")])),
        ("method lzma", raw_zip([named("a.xml", b"<a/>", method=14, packed=b"\x09\x04\x05\x00")])),
        ("method aes", raw_zip([named("a.xml", b"<a/>", method=99, packed=b"\x00" * 20)])),
        ("method unknown", raw_zip([named("a.xml", b"<a/>", method=7, packed=b"<a/>")])),
        ("method stored in local only", raw_zip([named("a.xml", b"<a/>")])),
        ("flag encrypted", raw_zip([named("a.xml", b"<a/>", flags=1)])),
        ("flag encrypted local only", raw_zip([named("a.xml", b"<a/>", local_flags=1)])),
        ("flag strong encryption", raw_zip([named("a.xml", b"<a/>", flags=0x40)])),
        ("flag patched", raw_zip([named("a.xml", b"<a/>", flags=0x20)])),
        ("flag data descriptor", raw_zip([named("a.xml", b"<a/>", flags=0x8)])),
        ("flag data descriptor zero sizes", raw_zip([named("a.xml", b"<a/>", flags=0x8)])),
        ("flag reserved bits", raw_zip([named("a.xml", b"<a/>", flags=0xF000)])),
        ("flag 2 3 compression options", raw_zip([named("a.xml", b"<a/>", flags=0x6)])),
        ("crc wrong", raw_zip([named("a.xml", b"<a/>", crc=1)])),
        ("crc wrong stored", raw_zip([named("a.xml", b"<a/>", method=0, crc=1)])),
        ("crc zero on empty", raw_zip([named("a.xml", b"", crc=0)])),
        ("crc wrong on empty", raw_zip([named("a.xml", b"", crc=5)])),
        ("usize smaller", raw_zip([named("a.xml", b"<a>" + b"x" * 100 + b"</a>", usize=10)])),
        ("usize larger", raw_zip([named("a.xml", b"<a/>", usize=1000)])),
        ("usize larger stored", raw_zip([named("a.xml", b"<a/>", method=0, usize=1000)])),
        ("usize smaller stored", raw_zip([named("a.xml", b"<a>xxxxx</a>", method=0, usize=3)])),
        ("usize zero", raw_zip([named("a.xml", b"<a/>", usize=0)])),
        ("usize huge", raw_zip([named("a.xml", b"<a/>", usize=0xFFFFFFFE)])),
        ("csize smaller", raw_zip([named("a.xml", b"<a>" + b"xyz" * 100 + b"</a>", csize=10)])),
        ("csize zero", raw_zip([named("a.xml", b"<a/>", csize=0)])),
        ("csize larger", raw_zip([named("a.xml", b"<a/>", csize=500)])),
        ("csize larger with gap", raw_zip([named("a.xml", b"<a/>", gap=b"\x00" * 600, csize=500)])),
        ("csize larger with gap is next entry", raw_zip([named("a.xml", b"<a/>", csize=70), named("b.xml", b"<b/>")])),
        ("csize huge", raw_zip([named("a.xml", b"<a/>", csize=0xFFFFFFFE)])),
        ("csize stored smaller", raw_zip([named("a.xml", b"<a>xxxxx</a>", method=0, csize=4)])),
        ("gap after data", raw_zip([named("a.xml", b"<a/>", gap=b"\x00" * 20)])),
        ("trailing data after deflate stream", raw_zip([named("a.xml", b"<a/>", packed=deflate(b"<a/>") + b"junk", csize=len(deflate(b"<a/>")) + 4)])),
        ("deflate truncated", raw_zip([named("a.xml", b"<a>" + b"xyz" * 100 + b"</a>", packed=deflate(b"<a>" + b"xyz" * 100 + b"</a>")[:-5])])),
        ("deflate garbage", raw_zip([named("a.xml", b"<a/>", packed=b"\xff\xff\xff\xff\xff\xff", usize=4, crc=0)])),
        ("deflate bad block type", raw_zip([named("a.xml", b"<a/>", packed=b"\x07\x00\x00", usize=4, crc=0)])),
        ("deflate stored block bad length", raw_zip([named("a.xml", b"<a/>", packed=b"\x01\x03\x00\x00\x00<a/>", usize=3, crc=zlib.crc32(b"<a/>"))])),
        ("deflate stored block ok", raw_zip([named("a.xml", b"<a/>", packed=b"\x01\x04\x00\xfb\xff<a/>")])),
        ("deflate no final block", raw_zip([named("a.xml", b"<a/>", packed=b"\x00\x04\x00\xfb\xff<a/>")])),
        ("deflate two streams", raw_zip([named("a.xml", b"<a/><b/>", packed=deflate(b"<a/>") + deflate(b"<b/>"))])),
        ("deflate dist too far", raw_zip([named("a.xml", b"<a/>", packed=b"\x4b\x4c\x1c\x05\xa3\x60\x14\x0c\x77\x00\x00", usize=10, crc=0)])),
        ("deflate empty stream", raw_zip([named("a.xml", b"", packed=b"\x03\x00")])),
        ("deflate empty missing", raw_zip([named("a.xml", b"", packed=b"")])),
        ("deflate one zero byte", raw_zip([named("a.xml", b"", packed=b"\x00")])),
        ("deflate fixed huffman", raw_zip([named("a.xml", b"<a/>", packed=zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_FIXED).compress(b"<a/>") + zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_FIXED).flush())])),
        ("deflate compressed with dictionary", raw_zip([named("a.xml", b"<a/>", packed=(lambda c: c.compress(b"<a/>") + c.flush())(zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_DEFAULT_STRATEGY, b"<a/>")))])),
        ("bomb ratio", raw_zip([named("a.xml", b"\x00" * 5_000_000)])),
        ("bomb declared small", raw_zip([named("a.xml", b"\x00" * 5_000_000, usize=100)])),
        ("bomb declared large", raw_zip([named("a.xml", b"\x00" * 50_000, usize=5_000_000)])),
        ("extra corrupt length", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HH", 0x9999, 100) + b"xy")])),
        ("extra short header", raw_zip([named("a.xml", b"<a/>", extra=b"\x01\x02\x03")])),
        ("extra ok", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HH", 0x9999, 2) + b"xy")])),
        ("extra empty fields", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HH", 0x9999, 0) * 3)])),
        ("extra zip64 short", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HH", 1, 4) + b"abcd", csize=0xFFFFFFFF)])),
        ("extra zip64 not needed", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHQ", 1, 8, 5))])),
        ("extra zip64 size placeholder", raw_zip([named("a.xml", b"<a/>", zip64=("size", "csize"))])),
        ("extra zip64 all", raw_zip([named("a.xml", b"<a/>", zip64=("size", "csize", "offset"))])),
        ("extra zip64 end record", raw_zip([named("a.xml", b"<a/>", zip64=("size", "csize", "offset"))], end64=True)),
        ("extra zip64 end record only", raw_zip([named("a.xml", b"<a/>")], end64=True)),
        ("extra zip64 end record with comment", raw_zip([named("a.xml", b"<a/>")], end64=True, comment=b"hello")),
        ("extra zip64 only csize", raw_zip([named("a.xml", b"<a/>", zip64=("csize",))])),
        ("extra zip64 only offset", raw_zip([named("a.xml", b"<a/>", zip64=("offset",))])),
        ("extra zip64 size wrong", raw_zip([named("a.xml", b"<a/>", zip64=("size", "csize"), usize=1)])),
        ("extra zip64 order", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHQ", 1, 8, 4), usize=0xFFFFFFFF)])),
        ("extra two zip64", raw_zip([named("a.xml", b"<a/>", zip64=("size",), extra=struct.pack("<HHQ", 1, 8, 3))])),
        ("unicode path ok", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 5, 1, zlib.crc32(b"a.xml")) + b"b.xml")])),
        ("unicode path wrong crc", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 5, 1, 12345) + b"b.xml")])),
        ("unicode path wrong version", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 5, 2, zlib.crc32(b"a.xml")) + b"b.xml")])),
        ("unicode path empty", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5, 1, zlib.crc32(b"a.xml")))])),
        ("unicode path short", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBH", 0x7075, 3, 1, 5))])),
        ("unicode path invalid utf8", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 2, 1, zlib.crc32(b"a.xml")) + b"\xff\xfe")])),
        ("unicode path with nul", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 7, 1, zlib.crc32(b"a.xml")) + b"b.xml\x00c")])),
        ("unicode path non ascii", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 6, 1, zlib.crc32(b"a.xml")) + "é.xml".encode())])),
        ("unicode path duplicates", raw_zip([named("a.xml", b"<a/>", extra=struct.pack("<HHBI", 0x7075, 5 + 5, 1, zlib.crc32(b"a.xml")) + b"b.xml"), named("b.xml", b"<b/>")])),
        ("version 63", raw_zip([named("a.xml", b"<a/>", version=63)])),
        ("version 64", raw_zip([named("a.xml", b"<a/>", version=64)])),
        ("version 255", raw_zip([named("a.xml", b"<a/>", version=255)])),
        ("version 0", raw_zip([named("a.xml", b"<a/>", version=0)])),
        ("overlap two entries share data", raw_zip([named("a.xml", b"<a/>"), named("b.xml", b"<a/>", offset=0)])),
        ("overlap entry runs into next", raw_zip([named("a.xml", b"<a>" + b"x" * 100 + b"</a>", csize=60, packed=deflate(b"<a>" + b"x" * 100 + b"</a>") + b"\x00" * 100), named("b.xml", b"<b/>")])),
        ("overlap csize past directory", raw_zip([named("a.xml", b"<a/>", csize=2000, gap=b"\x00" * 3000)])),
        ("overlap central dir entry order differs", (lambda z: z)(raw_zip([named("b.xml", b"<b/>"), named("a.xml", b"<a/>")]))),
        ("many small entries", raw_zip([named(f"p{n}.xml", b"<p/>") for n in range(40)])),
        ("directory entry", raw_zip([named("dir/", b""), named("dir/a.xml", b"<a/>")])),
        ("directory entry with data", raw_zip([named("dir/", b"<a/>")])),
        ("central directory count too high", raw_zip([named("a.xml", b"<a/>")])[:-12] + struct.pack("<HH", 5, 5) + raw_zip([named("a.xml", b"<a/>")])[-8:]),
        ("central directory count too low", raw_zip([named("a.xml", b"<a/>"), named("b.xml", b"<b/>")])[:-12] + struct.pack("<HH", 1, 1) + raw_zip([named("a.xml", b"<a/>"), named("b.xml", b"<b/>")])[-8:]),
        ("central directory offset wrong", raw_zip([named("a.xml", b"<a/>")])[:-6] + struct.pack("<I", 7) + b"\x00\x00"),
        ("central directory size wrong", raw_zip([named("a.xml", b"<a/>")])[:-10] + struct.pack("<I", 1) + raw_zip([named("a.xml", b"<a/>")])[-6:]),
        ("central directory size too big", raw_zip([named("a.xml", b"<a/>")])[:-10] + struct.pack("<I", 90) + raw_zip([named("a.xml", b"<a/>")])[-6:]),
        ("central directory signature bad", raw_zip([named("a.xml", b"<a/>")]).replace(struct.pack("<I", CENTRAL), b"PK\x01\x03")),
        ("central directory truncated name", (lambda z: z[: z.index(struct.pack("<I", CENTRAL)) + 48] + z[-22:])(raw_zip([named("a.xml", b"<a/>")]))),
        ("disk number nonzero", raw_zip([named("a.xml", b"<a/>")])[:-18] + struct.pack("<HH", 1, 1) + raw_zip([named("a.xml", b"<a/>")])[-14:]),
        ("end record in middle", raw_zip([named("a.xml", b"<a/>")]) + raw_zip([named("b.xml", b"<b/>")])),
    ]
    # Damaged archives: bytes of a valid one changed at the places that matter, and at random.
    victims = [base, two, zipped({"a.xml": "<a/>"}, zipfile.ZIP_STORED)]
    for n in range(DAMAGED):
        data = bytearray(victims[n % len(victims)])
        for _ in range(random.randint(1, 3)):
            kind = random.random()
            if kind < 0.5:
                at = random.randrange(len(data)) if random.random() < 0.5 else random.choice([0, 4, 6, 8, 10, 14, 18, 22, 26, 28, 30, len(data) - 22, len(data) - 18, len(data) - 14, len(data) - 12, len(data) - 6, len(data) - 2]) + random.randint(0, 3)
                if 0 <= at < len(data):
                    data[at] = random.choice([0, 1, 0xFF, random.randrange(256), data[at] ^ (1 << random.randrange(8))])
            elif kind < 0.7:
                at = random.randrange(len(data))
                del data[at : at + random.randint(1, 4)]
            elif kind < 0.85:
                at = random.randrange(len(data) + 1)
                data[at:at] = bytes(random.randrange(256) for _ in range(random.randint(1, 4)))
            else:
                data = data[: random.randrange(len(data))]
        cases.append((f"damaged {n}", bytes(data)))
    return cases


def read_parts(data: bytes) -> dict:
    """What office.py's `_Archive` makes of the archive, and of each part it can read."""
    try:
        archive = office._Archive(data)
    except OperationError as error:
        return {"open": error.code}
    except Exception as error:
        return {"open": "raises", "error": type(error).__name__}
    parts: dict[str, dict] = {}
    for name, info in archive.infos.items():
        if info.flag_bits & 0x1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            parts[name] = {"error": "unreadable"}
            continue
        try:
            digest = hashlib.sha256()
            size = 0
            with archive.zip.open(info) as part:
                while chunk := part.read(office.CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    if size > 8 * 1024 * 1024:
                        break
            parts[name] = {"size": size, "sha256": digest.hexdigest()}
        except zipfile.BadZipFile, zlib.error, EOFError, ValueError, RuntimeError:
            parts[name] = {"error": "unreadable"}
        except Exception as error:
            parts[name] = {"error": "raises", "type": type(error).__name__}
    return {"open": "ok", "names": list(archive.infos), "parts": parts}


def extracted(kind: str, data: bytes, limit: int) -> dict:
    try:
        return {"text": office.extract(kind, data, limit)}
    except OperationError as error:
        return {"error": error.code, "message": error.message}
    except Exception as error:
        return {"raises": type(error).__name__}


# ---------------------------------------------------------------------------------------------------------------
# Download addresses, how files are read, search cursors and tool inputs.

URLS = [
    "https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1", "https://contoso-my.sharepoint.com/personal/x/download",
    "https://public.am.files.1drv.com/y4m", "https://my.microsoftpersonalcontent.com/x", "http://contoso.sharepoint.com/x",
    "https://sharepoint.com/x", "https://evilsharepoint.com/x", "https://contoso.sharepoint.com.evil.example/x",
    "https://user@contoso.sharepoint.com/x", "https://contoso.sharepoint.com:8443/x", "https://contoso.sharepoint.com\\@evil.example/x",
    "https://contoso.sharepoint.com/x y", "https://contoso.sharepoint.com/" + "x" * 8000, "file:///etc/passwd",
    "https://contoso.sharepoint.com/" + "x" * 7970, "https://CONTOSO.SharePoint.COM/x", "HTTPS://contoso.sharepoint.com/x",
    "https://contoso.sharepoint.com:443/x", "https://contoso.sharepoint.com:/x", "https://contoso.sharepoint.com:80/x",
    "https://contoso.sharepoint.com./x", "https://.sharepoint.com/x", "https://a..sharepoint.com/x", "https://contoso.sharepoint.com",
    "https://contoso.sharepoint.com?x=1", "https://contoso.sharepoint.com#x", "https://user:pw@contoso.sharepoint.com/x",
    "https://:@contoso.sharepoint.com/x", "https://@contoso.sharepoint.com/x", "https://evil.example@contoso.sharepoint.com/x",
    "https://contoso.sharepoint.com@evil.example/x", "https://contoso.sharepoint.com%40evil.example/x", "https://contoso.sharepoint.com%2f@evil.example/x",
    "https://contoso.sharepoint.com#@evil.example/x", "https://contoso.sharepoint.com?@evil.example/x", "https://evil.example/.sharepoint.com",
    "https://evil.example/x.sharepoint.com", "https://evil.example?.sharepoint.com", "https://evil.example#.sharepoint.com",
    "https://evil.example;.sharepoint.com/x", "https://evil.example:80@x.sharepoint.com/x", "https://x.sharepoint.com:99999/x",
    "https:/contoso.sharepoint.com/x", "https:contoso.sharepoint.com/x", "https:///contoso.sharepoint.com/x", "https:////contoso.sharepoint.com/x",
    "https://\u2024contoso.sharepoint.com/x", "https://contoso\u3002sharepoint\u3002com/x", "https://contoso\uff0esharepoint\uff0ecom/x",
    "https://contoso.sharepoint.com\u3002/x", "https://contoso.ｓharepoint.com/x", "https://contoso.shärepoint.com/x",
    "https://x.sharepoint.com\u2215evil.example/x", "https://x.sharepoint.com\uff0fevil.example/x", "https://x.sharepoint.com\uff1fevil/x",
    "https://x.sharepoint.com\ufe55evil/x", "https://x.sharepoint.com%2Fevil.example/x", "https://x.sharepoint.com%5Cevil.example/x",
    "https://x.share%70oint.com/x", "https://x.sharepoint%2Ecom/x", "https://%78.sharepoint.com/x", "https://x.sharepoint.com%00.evil/x",
    "https://x.sharepoint.com%0a.evil/x", "https://x.sharepoint.com\t/x", "https://x.sharepoint.com\n/x", "https://x.sharepoint.com\r/x",
    "https://x.sharepoint.com\x00/x", "https://x.sharepoint.com\x7f/x", "https://x.sharepoint.com/x\x7f", " https://x.sharepoint.com/x",
    "https://x.sharepoint.com/x ", "https://x.sharepoint.com/é", "https://x.sharepoint.com/%zz", "https://x.sharepoint.com/%",
    "https://x.sharepoint.com/😀", "https://caf\u00e9.sharepoint.com/x", "https://CAF\u00c9.sharepoint.com/x", "https://contoso-\u212a.sharepoint.com/x", "https://x.sharepoint.com:443/\u00e9", "https://[::1]/x", "https://[::1].sharepoint.com/x",
    "https://127.0.0.1/x", "https://127.0.0.1.sharepoint.com/x", "https://1.sharepoint.com/x", "https://0x7f.1/x", "https://2130706433/x",
    "https://x.sharepoint.com.attacker.example/x", "https://x.1drv.com/x", "https://1drv.com/x", "https://.1drv.com/x", "https://x.1drv.com.evil/x",
    "https://x.y.1drv.com/x", "https://x.microsoftpersonalcontent.com/x", "https://microsoftpersonalcontent.com/x", "https://x-microsoftpersonalcontent.com/x",
    "https://x.sharepoint.cn/x", "https://x.sharepoint.us/x", "https://x.sharepoint.de/x", "https://x.sharepoint-df.com/x", "ftp://x.sharepoint.com/x",
    "wss://x.sharepoint.com/x", "//x.sharepoint.com/x", "x.sharepoint.com/x", "", "https://", "https://x", "https:", "https://x.sharepoint.com:0/x",
    "https://x.sharepoint.com:-1/x", "https://x.sharepoint.com:1_0/x", "https://x.sharepoint.com:٣/x", "https://x.sharepoint.com:443:443/x",
    "https://x.sharepoint.com:abc/x", "https://xn--e1afmkfd.sharepoint.com/x", "https://xn--.sharepoint.com/x", "https://xn--a.sharepoint.com/x",
    "https://x.sharepoint.com/..%2f..%2f", "https://x.sharepoint.com/%2e%2e/", "https://x.sharepoint.com/;x", "https://x.sharepoint.com/\\x",
    "https://x.sharepoint.com/\"", "https://x.sharepoint.com/<>", "https://x.sharepoint.com/{}", "https://x.sharepoint.com/|", "https://x.sharepoint.com/^",
    "https://x.sharepoint.com/`", "https://" + "a" * 63 + ".sharepoint.com/x", "https://" + "a" * 64 + ".sharepoint.com/x", "https://" + "a" * 300 + ".sharepoint.com/x",
    "https://-x.sharepoint.com/x", "https://x-.sharepoint.com/x", "https://x_y.sharepoint.com/x", "https://x y.sharepoint.com/x", "https://x,y.sharepoint.com/x",
    "https://x!y.sharepoint.com/x", "https://x$y.sharepoint.com/x", "https://x&y.sharepoint.com/x", "https://x'y.sharepoint.com/x", "https://x(y).sharepoint.com/x",
    "https://x*y.sharepoint.com/x", "https://x+y.sharepoint.com/x", "https://x=y.sharepoint.com/x", "https://x<y.sharepoint.com/x", "https://x>y.sharepoint.com/x",
    "https://x[y.sharepoint.com/x", "https://x]y.sharepoint.com/x", "https://x^y.sharepoint.com/x", "https://x|y.sharepoint.com/x", "https://x~y.sharepoint.com/x",
]  # fmt: skip

READABLE = [
    # (mime type, name)
    ("text/plain", "a.txt"), ("TEXT/PLAIN", "a"), (" text/plain ", "a"), ("text/plain; charset=utf-8", "a"), ("text/", "a"), ("text", "a"),
    ("application/json", "a"), ("Application/JSON; x=y", "a"), ("application/xml", "a"), ("application/javascript", "a"), ("application/x-sh", "a"),
    ("application/sql", "a"), ("application/pdf", "a.pdf"), ("application/octet-stream", "a.md"), ("application/octet-stream", "a.MD"),
    ("application/octet-stream", "a.markdown"), ("application/octet-stream", "a.Markdown"), ("application/octet-stream", "a.Keys"),
    ("application/octet-stream", "a.marKdown"), ("application/octet-stream", "a.docx"), ("application/octet-stream", "a.DOCX"),
    ("application/octet-stream", "a.pptx"), ("application/octet-stream", "a.xlsx"), ("application/octet-stream", "a.xls"), ("application/octet-stream", "a.doc"),
    ("application/octet-stream", ".docx"), ("application/octet-stream", "..docx"), ("application/octet-stream", "a..docx"), ("application/octet-stream", "a.docx."),
    ("application/octet-stream", "a.docx.txt"), ("application/octet-stream", "a.txt.docx"), ("application/octet-stream", "dir.docx/file"),
    ("application/octet-stream", "dir.docx/"), ("application/octet-stream", "a.b/c"), ("application/octet-stream", "a/.docx"), ("application/octet-stream", "a/..docx"),
    ("application/octet-stream", "/a.docx"), ("application/octet-stream", "a.docx/"), ("application/octet-stream", "a. docx"), ("application/octet-stream", "a.docx "),
    ("application/octet-stream", "a.İ"), ("application/octet-stream", "a.pptx\u0307"), ("application/octet-stream", ""), ("application/octet-stream", "."),
    ("application/octet-stream", ".."), ("application/octet-stream", "..."), ("application/octet-stream", "a."), ("application/octet-stream", ".txt"),
    ("application/octet-stream", "..txt"), ("application/octet-stream", "x...txt"), ("application/octet-stream", "x.tar.gz"), ("application/octet-stream", "x.sh"),
    ("application/octet-stream", "x.py"), ("application/octet-stream", "x.ts"), ("application/octet-stream", "x.html"), ("application/octet-stream", "x.HTM"),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.bin"), ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.txt"),
    ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a"), ("APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET", "a"),
    ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=x", "a"), ("application/vnd.openxmlformats-officedocument.spreadsheetml.template", "a"),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.xlsx"), (None, "a.txt"), (None, "a"), ("", "a.pptx"), ("\u00a0text/plain", "a"),
    ("text/plain\u00a0", "a"), ("\ttext/plain\n", "a"), (";text/plain", "a"), ("x;text/plain", "a"), ("text/plain;", "a"), ("İmage/png", "a"),
]  # fmt: skip

CURSORS = [
    '{"page": "elsewhere"}', '{"page": "skip:3"}', '{"page":"x"}', '{"page": 1}', '{"page": null}', '{"page": ""}', "{}", '{"page": "a", "x": 1}',
    '{"x": "a"}', '["page"]', '"page"', "page", "", "null", "1", '{"page": "a"', '{"page": "a"}x', ' {"page": "a"} ', '\n{"page": "a"}\n', '{"page": "a", "page": "b"}',
    '{"page": "a\\u0000b"}', '{"page": "\\ud800"}', '{"page": "\\ud83d\\ude00"}', '{"\\u0070age": "a"}', '{"page": "a",}', "{'page': 'a'}", '{"page": NaN}',
    '{"page": Infinity}', '{"page": "a"} {"page": "b"}', "\ufeff" + '{"page": "a"}', '{"page": "a"}\x00', '{"page": "é"}', '{"page": "' + "a" * 2000 + '"}',
    '{"page":"token:abc=="}', '{"page": "skip:25"}', '{"__proto__": "a"}', '{"page": {"page": "a"}}', '{"page": ["a"]}', '{"page": true}', '{"page": 1e400}',
    "[" * 100000, '{"page": "a"' + ", " * 3 + "}",
]  # fmt: skip


def pack(value):
    """A long run of one character is stored as a recipe: {"$repeat": [character, count]}."""
    if isinstance(value, str) and len(value) > 1000 and len(set(value)) == 1:
        return {"$repeat": [value[0], len(value)]}
    if isinstance(value, dict):
        return {key: pack(item) for key, item in value.items()}
    return value


def validation_message(error: ValidationError) -> str:
    # connectors/executor.py validation_message, which imports Django.
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


def validated(model, raw):
    try:
        return {"data": pack(model.model_validate(raw).model_dump(mode="json"))}
    except ValidationError as error:
        return {"message": validation_message(error)}
    except (OverflowError, TypeError) as error:
        return {"raises": type(error).__name__}


FOLDER = "b!me:docs"
NAMES = [
    "a/b.txt", "a:b", "what?", "trailing.", "CON", "con.txt", "Lpt1.md", "desktop.ini", "~$lock.docx", "x_vti_y", "a\nb", "notes.txt", "Idea #1.md", "Zażółć.md", "a" * 200,
    "a" * 201, "", " ", " a ", "con", "CON.", "con .txt", "conx", "com0", "COM9.log", "com10", "lpt0", "LPT9", "Aux.tar.gz", "nul.", "prn", ".lock", ".LOCK", "Forms",
    "forms.txt", "desktop.INI", "Desktop.ini.txt", "~$", "a~$b", "~$a", "_vti_", "_VTI_bin", "a_vTi_b", 'a"b', "a*b", "a<b", "a>b", "a|b", "a\\b", "a\tb", "a\x00b", "a\rb",
    "K", "İ", "conİ", "\u00a0", ".", "..", "a.", "a..", ".a", "...", "name with spaces.txt", "\U0001f600.txt", "e\u0301.txt", "COM¹", "ＣＯＮ",
]  # fmt: skip
INPUTS = {
    "list_libraries": (onedrive.ListLibraries, [{}, {"x": 1}, []]),
    "list_folder": (onedrive.ListFolder, [
        {"folder_id": "root"}, {"folder_id": FOLDER}, {"folder_id": " root "}, {"folder_id": "ROOT"}, {"folder_id": "b!me:"}, {"folder_id": ":docs"}, {"folder_id": "b!me:a:b"},
        {"folder_id": "b!me:docs\n"}, {"folder_id": "b!me:" + "a" * 200}, {"folder_id": "b!me:" + "a" * 201}, {"folder_id": "a" * 200 + ":docs"}, {"folder_id": "a" * 201 + ":docs"},
        {"folder_id": "b!me:a.b-c_d=e!f"}, {"folder_id": "b!me:a b"}, {"folder_id": "b.me:docs"}, {"folder_id": "b!me:é"}, {"folder_id": "b!me:٣"},
        {"folder_id": FOLDER, "limit": 0}, {"folder_id": FOLDER, "limit": 1}, {"folder_id": FOLDER, "limit": 100}, {"folder_id": FOLDER, "limit": 101}, {"folder_id": FOLDER, "limit": "5"},
        {"folder_id": FOLDER, "limit": True}, {"folder_id": FOLDER, "cursor": "x" * 1000}, {"folder_id": FOLDER, "cursor": "x" * 1001},
        {"folder_id": FOLDER, "cursor": " skip:3 "}, {"folder_id": FOLDER, "cursor": None}, {"folder_id": FOLDER, "cursor": ""}, {}, {"folder_id": None}, {"folder_id": 5},
        {"folder_id": FOLDER, "extra": 1}, {"folder_id": "x" * 421}, {"folder_id": "b!me:docs", "limit": -1},
    ]),
    "search_files": (onedrive.SearchFiles, [
        {"text": "plan"}, {"text": " plan "}, {"text": ""}, {"text": "  "}, {"text": "x" * 200}, {"text": "x" * 201}, {"text": "a\nb"}, {"text": "a\tb"}, {"text": "it's"},
        {"text": 'KQL "quoted" AND (x OR y)'}, {"text": "\U0001f600" * 200}, {"text": "\U0001f600" * 201}, {"text": "a\u2028b"}, {"text": "a\x00b"}, {"text": "a\u00a0b"},
        {"text": "plan", "limit": 0}, {"text": "plan", "limit": 25}, {"text": "plan", "limit": 26}, {"text": "plan", "cursor": "skip:10"}, {"text": "plan", "cursor": None},
        {}, {"text": None}, {"text": 5}, {"text": "plan", "extra": 1},
    ]),
    "get_file": (onedrive.GetFile, [{"file_id": "b!me:plan"}, {"file_id": "root"}, {"file_id": ""}, {"file_id": "b!me"}, {}, {"file_id": "b!me:plan", "x": 1}]),
    "read_file": (onedrive.ReadFile, [
        {"file_id": "b!me:plan"}, {"file_id": "b!me:plan", "max_chars": 0}, {"file_id": "b!me:plan", "max_chars": 1}, {"file_id": "b!me:plan", "max_chars": 100000},
        {"file_id": "b!me:plan", "max_chars": 100001}, {"file_id": "b!me:plan", "max_chars": "9"}, {"file_id": "b!me:plan", "max_chars": 9.5}, 
        {"file_id": "b!me:plan", "max_chars": None}, {"file_id": "bad"},
    ]),
    "create_file": (onedrive.CreateFile, [
        *[{"folder_id": FOLDER, "name": name, "content": "x"} for name in NAMES],
        {"folder_id": FOLDER, "name": "a.txt", "content": ""}, {"folder_id": FOLDER, "name": "a.txt", "content": "x" * 1024 * 1024},
        {"folder_id": FOLDER, "name": "a.txt", "content": "x" * (1024 * 1024 + 1)}, {"folder_id": FOLDER, "name": "a.txt", "content": "é" * (512 * 1024)},
        {"folder_id": FOLDER, "name": "a.txt", "content": "é" * (512 * 1024 + 1)}, {"folder_id": FOLDER, "name": "a.txt", "content": "\U0001f600" * 262144},
        {"folder_id": FOLDER, "name": "a.txt", "content": "\U0001f600" * 262145}, {"folder_id": FOLDER, "name": "a.txt", "content": " padded \n"},
        {"folder_id": FOLDER, "name": "a.txt", "content": "Zażółć\nline two\r\n"}, {"folder_id": FOLDER, "name": "a.txt"}, {"folder_id": FOLDER, "content": "x"},
        {"name": "a.txt", "content": "x"}, {"folder_id": FOLDER, "name": 5, "content": "x"}, {"folder_id": FOLDER, "name": "a.txt", "content": 5},
        {"folder_id": "bad", "name": "a/b", "content": "x"},
    ]),
}  # fmt: skip


def item_of(mime, name):
    file = {"mimeType": mime} if mime is not None else {}
    return DriveItem.model_validate({"id": "x", "name": name, "file": file})


def allowed(url):
    try:
        return {"value": download_allowed(url)}
    except Exception as error:  # httpx's IDNA decoding raises on a malformed A-label; the caller does not catch it
        return {"raises": type(error).__name__}


def readable_outcome(mime, name):
    try:
        return {"value": onedrive._readable(item_of(mime, name))}
    except OperationError as error:
        return {"error": error.code, "message": error.message}


def cursor_outcome(cursor):
    try:
        return {"value": onedrive._search_cursor(cursor)}
    except OperationError as error:
        return {"error": error.code}
    except RecursionError:
        return {"raises": "RecursionError"}


def main() -> None:
    word_cases()
    powerpoint_cases()
    excel_cases()
    padding_cases()
    xml_fuzz_cases()
    archives = zip_cases()
    vectors = {
        "zip": [{"name": name, "data": b64(data), **read_parts(data)} for name, data in archives],
        "office": [{"name": name, "kind": kind, "limit": limit, "data": CROWDED.get(name) or b64(data), **extracted(kind, data, limit)} for name, kind, data, limit in OFFICE],
        "download_allowed": {url: allowed(url) for url in URLS},
        "readable": [{"mime": mime, "name": name, **readable_outcome(mime, name)} for mime, name in READABLE],
        "search_cursor": [{"cursor": pack(cursor), **cursor_outcome(cursor)} for cursor in CURSORS],
        "inputs": {tool: [{"args": pack(raw), **validated(model, raw)} for raw in cases] for tool, (model, cases) in INPUTS.items()},
    }
    (HERE / "vectors.json").write_text(json.dumps(compact(vectors), indent=None, ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
