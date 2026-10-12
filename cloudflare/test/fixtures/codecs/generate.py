"""Writes vectors.json: what today's Python decodes, for the codecs of src/lib/codecs.ts and
src/lib/punycode.ts that the connector review found missing or fragile:
- punycode with "strict" and "replace": encodings of real text, seeded random digit strings, and deltas
  large enough to overflow 64-bit positions;
- unicode_escape and raw_unicode_escape with the three error handlers;
- gb2312, hz, iso2022_kr and johab on text, damaged bytes and seeded random ones, and a digest of every
  two-byte input (after "~{" for hz, after a KS X 1001 designation and shift for iso2022_kr) with the three
  error handlers, so the whole of each table is checked without being stored, and a digest of which code
  points each of them and the escape codecs can encode;
and writes src/lib/cjk-table.ts: Python's GB 2312 and KS X 1001 tables and johab's Hangul indexes.

Run from cloudflare/:
  cd ../backend && uv run python -I ../cloudflare/test/fixtures/codecs/generate.py
"""

import hashlib
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLOUDFLARE = HERE.parents[2]
RANDOM = random.Random(6)
HANDLERS = ("strict", "replace", "surrogateescape")


def raised(error: BaseException) -> str:
    for kind in (UnicodeDecodeError, UnicodeError, LookupError, OverflowError, ValueError):
        if isinstance(error, kind):
            return kind.__name__
    return "other:" + type(error).__name__


def answer(data: bytes, name: str, errors: str) -> dict:
    try:
        return {"ok": data.decode(name, errors)}
    except BaseException as error:  # noqa: BLE001
        return {"error": raised(error)}


def record(data: bytes, name: str, handlers=HANDLERS) -> dict:
    return {"name": name, "data": data.hex(), **{errors: answer(data, name, errors) for errors in handlers}}


def punycode_cases() -> list[dict]:
    texts = ["bücher", "münchen", "ñ", "日本語", "abc", "a-b-c", "\U0001f600x", "Ä" * 30, "ü-ö", "\udc80a", "ʻOkina"]
    samples = [text.encode("punycode") for text in texts]
    samples += [b"", b"-", b"--", b"a-", b"-a", b"abc-", b"\xff-a", b"a\xff-b", b"b\xff", b"a!", b"9", b"999",
                b"9" * 400 + b"b", b"9" * 400 + b"a", b"9" * 40 + b"b", b"9" * 11 + b"b", b"9" * 10 + b"b",
                b"x-" + b"9" * 60 + b"b", b"9" * 20 + b"a" + b"9" * 20 + b"a", b"zz" * 30 + b"a",
                b"x" * 200 + b"-" + b"9" * 40 + b"b", b"9" * 13 + b"a" + b"bcd", b"9" * 17 + b"ba"]
    alphabet = b"abcxyz0189-9AZ"
    for _ in range(300):
        samples.append(bytes(RANDOM.choice(alphabet) for _ in range(RANDOM.randint(1, 24))))
    return [record(data, "punycode", ("strict", "replace")) for data in samples]


def escape_cases() -> list[dict]:
    samples = [b"", b"plain", b"caf\xe9", b"\\", b"abc\\", b"\\\\", b"\\\\u0041", b"a\\u00e9", b"\\u12", b"\\u12x4",
               b"\\U0001F600", b"\\U00110000", b"\\Ux", b"\\x", b"\\x4", b"\\x41", b"\\xg1", b"\\N", b"\\N{", b"\\N{}",
               b"\\N{nope}", b"\\Nx", b"\\777", b"\\0", b"\\08", b"\\12a", b"\\q", b"\\\n", b"\\a\\b\\f\\n\\r\\t\\v",
               b"\\'\\\"", b"\\ud800", b"\\udc00\\ud800", b"\\U0000d800", b"\\u00e9\\U0001F600\xff", b"\\u004", b"\\U0010FFFF"]
    alphabet = b"\\uUxN{}0189aAfFgz\n'\x80\xff"
    for _ in range(200):
        samples.append(bytes(RANDOM.choice(alphabet) for _ in range(RANDOM.randint(1, 14))))
    return [record(data, name) for name in ("unicode_escape", "raw_unicode_escape", "unicode-escape") for data in samples]


CJK_TEXT = "中文 GB2312 ~ 混合 abc 한국어 텍스트 ㄱㅏ 漢字 ①"


def cjk_cases() -> list[dict]:
    samples: dict[str, list[bytes]] = {}
    for name in ("gb2312", "hz", "iso2022_kr", "johab"):
        found = []
        for text in (CJK_TEXT, "中文", "한국어", "~{}", "plain\nlines", "가\n나"):
            try:
                found.append(text.encode(name))
            except UnicodeEncodeError:
                pass
        samples[name] = found
    samples["gb2312"] += [b"\x81\x40", b"\xa1", b"a\xa1", b"\xa1\xa1", b"\xa1\x41", b"\xf8\xa1", b"\xaa\xa1", b"\xa2\xa1", b"\xd6\xd0\xce"]
    samples["hz"] += [b"~", b"~~", b"~{", b"~}", b"~{VP", b"~{VPND~}", b"~{VPND", b"~{V", b"~{\n~}", b"~\n", b"~x", b"\x80", b"~{\x80~}",
                      b"~{~~~}", b"~{~{~}", b"~}~{VP~}", b"~{!!~}", b"~{\x7f\x7f~}", b"a~{VP~}b"]
    samples["iso2022_kr"] += [b"\x1b$)C", b"\x1b$)C\x0e!!\x0f", b"\x0e!!", b"\x1b", b"\x1b$", b"\x1b$)", b"\x1bxyzA", b"\x1b(B",
                              b"\x1b$)A\x0e!!", b"\x1b$)C\x0e\n!!", b"\x1b$)C\x0e\x01!", b"\x1b$)C\x0e!", b"\x1b$)C\x0e\x80",
                              b"\x1b$)C\x0e \x21", b"\x1b$)C\x0e\x7f\x7f", b"\x1b\x80\xffZ", b"\x1b$(C", b"\x1b)C"]
    samples["johab"] += [b"\x88\x61", b"\x84\x41", b"\x84\x44", b"\xd8\x31", b"\xd9\x31", b"\xdf\x31", b"\xfa\x31", b"\xe0\x31",
                         b"\xda\xa1", b"\xd9\x7f", b"\xd9\x80", b"\xd9\x91", b"\x88", b"a\x88"]
    escapes = {"gb2312": b"\xa1\xa2\xb0\xd6\xd0\x81\x40a~", "hz": b"~{}VPND!\n\x80a", "iso2022_kr": b"\x1b$)C(B\x0e\x0f!\x7f\n\x80a",
               "johab": b"\x88\x61\x84\xd9\xe0\x31\x91\xfea"}
    for name, alphabet in escapes.items():
        for _ in range(150):
            samples[name].append(bytes(RANDOM.choice(alphabet) for _ in range(RANDOM.randint(1, 12))))
    return [record(data, name) for name, found in samples.items() for data in found]


def digest(name: str, prefix: bytes) -> str:
    """sha256 over every two-byte input after `prefix`, each answer as UTF-16-LE (lone surrogates kept) or the error's class."""
    hashed = hashlib.sha256()
    for pair in range(0x10000):
        data = prefix + bytes([pair >> 8, pair & 0xFF])
        for errors in HANDLERS:
            result = answer(data, name, errors)
            text = result["ok"] if "ok" in result else "!" + result["error"]
            hashed.update(text.encode("utf-16-le", "surrogatepass") + b"\x00\x00")
    return hashed.hexdigest()


def table(name: str, prefix: bytes, suffix: bytes, first: int) -> str:
    """A 94x94 table: row r, column c at r * 94 + c, as the codec decodes bytes first + r, first + c; U+FFFE for nothing."""
    out = []
    for row in range(94):
        for column in range(94):
            try:
                text = (prefix + bytes([first + row, first + column]) + suffix).decode(name)
            except UnicodeDecodeError:
                text = "\ufffe"
            assert len(text) == 1, (name, row, column, text)
            out.append(text)
    return "".join(out)


def johab_indexes() -> dict[str, list[int]]:
    """Johab's Hangul: each five-bit field's index (-1: none, -2: fill) and the compatibility jamo it shows alone."""
    def decoded(cho: int, jung: int, jong: int) -> str | None:
        code = 0x8000 | cho << 10 | jung << 5 | jong
        try:
            return bytes([code >> 8, code & 0xFF]).decode("johab")
        except UnicodeDecodeError:
            return None
    found: dict[str, list[int]] = {key: [-1] * 32 for key in ("cho", "jung", "jong", "cho_jamo", "jung_jamo", "jong_jamo")}
    found["cho"][1] = found["jung"][2] = found["jong"][1] = -2
    for x in range(32):
        for y in range(32):
            for z in range(32):
                text = decoded(x, y, z)
                if text is None or not 0xAC00 <= ord(text) <= 0xD7A3:
                    continue
                n = ord(text) - 0xAC00
                for key, field, value in (("cho", x, n // 588), ("jung", y, n % 588 // 28), ("jong", z, n % 28 if z != 1 else -2)):
                    assert found[key][field] in (-1, value), (key, field)
                    found[key][field] = value
    for x in range(32):
        text = decoded(x, 2, 1) if x != 1 else None
        found["cho_jamo"][x] = ord(text) if text else -1
    for y in range(32):
        text = decoded(1, y, 1) if y != 2 else None
        found["jung_jamo"][y] = ord(text) if text else -1
    for z in range(32):
        text = decoded(1, 2, z) if z != 1 else None
        found["jong_jamo"][z] = ord(text) if text else -1
    return found


def write_table() -> None:
    gb2312 = table("gb2312", b"", b"", 0xA1)
    ksx1001 = table("iso2022_kr", b"\x1b$)C\x0e", b"", 0x21)
    lines = [
        f"// Generated by test/fixtures/codecs/generate.py from Python {sys.version.split()[0]}'s codecs; do not edit.",
        "",
        "/** GB 2312 as Python's gb2312 codec decodes it: bytes 0xA1 + r, 0xA1 + c at r * 94 + c; U+FFFE where it decodes nothing. */",
        f"export const GB2312 = {json.dumps(gb2312, ensure_ascii=False)};",
        "/** KS X 1001 as Python's iso2022_kr codec decodes it: bytes 0x21 + r, 0x21 + c at r * 94 + c; U+FFFE where it decodes nothing. */",
        f"export const KSX1001 = {json.dumps(ksx1001, ensure_ascii=False)};",
        "/** Johab's Hangul fields (choseong, jungseong, jongseong): each five-bit value's index (a jongseong's counts from 1),",
        "    -1 for none, -2 for the fill; and the compatibility jamo each shows with the other two filled, -1 for none. */",
    ]
    for key, value in johab_indexes().items():
        lines.append(f"export const JOHAB_{key.upper()}: readonly number[] = {json.dumps(value)};")
    lines.append("")
    (CLOUDFLARE / "src/lib/cjk-table.ts").write_text("\n".join(lines))


ENCODABLE_SAMPLES = [*range(0x10000), 0x10000, 0x1F600, 0x20000, 0x10FFFF]


def encodable(name: str) -> str:
    """sha256 over one byte per sample code point: whether `chr(point).encode(name)` succeeds."""
    marks = bytearray()
    for point in ENCODABLE_SAMPLES:
        try:
            chr(point).encode(name)
            marks.append(1)
        except UnicodeEncodeError:
            marks.append(0)
    return hashlib.sha256(marks).hexdigest()


def main() -> None:
    write_table()
    vectors = {
        "punycode": punycode_cases(),
        "escapes": escape_cases(),
        "cjk": cjk_cases(),
        "digests": [
            {"name": "gb2312", "prefix": "", "sha256": digest("gb2312", b"")},
            {"name": "johab", "prefix": "", "sha256": digest("johab", b"")},
            {"name": "hz", "prefix": b"~{".hex(), "sha256": digest("hz", b"~{")},
            {"name": "iso2022_kr", "prefix": b"\x1b$)C\x0e".hex(), "sha256": digest("iso2022_kr", b"\x1b$)C\x0e")},
            {"name": "iso2022_kr", "prefix": "", "sha256": digest("iso2022_kr", b"")},
            {"name": "hz", "prefix": "", "sha256": digest("hz", b"")},
        ],
        "encodable": [
            {"name": name, "sha256": encodable(name)}
            for name in ("gb2312", "hz", "iso2022_kr", "johab", "unicode_escape", "raw_unicode_escape")
        ],
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
