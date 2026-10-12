"""Writes unicode.json: what Python 3.14 (Unicode 16.0) does with every code point, for test/unit/unicode.test.ts.

The runtime's Unicode (17.0 in Node 24 and in workerd) answers for case folding, lowercasing, `\\w` and
repr() in src/lib; src/lib/unicode.ts lists the code points Unicode 17 assigned, which are left out so that
the results are Python 3.14's. This file is the oracle: the code points Python leaves unassigned, the ones
it changes by `casefold()` and `lower()`, `\\w` and `\\d` in a str pattern, a digest of `repr()` of each, and
digests of `lower()` of each beside a capital sigma (where the final-sigma rule reads its neighbours).

Run from cloudflare/ with Python 3.14 (it stops on any other Unicode version; the stdlib is enough):
  /opt/homebrew/bin/python3.14 -I test/fixtures/unicode/generate.py
"""

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent

if unicodedata.unidata_version != "16.0.0":
    raise SystemExit(f"Python {sys.version.split()[0]} has Unicode {unicodedata.unidata_version}; the oracle is 16.0.0")

POINTS = [point for point in range(0x110000) if not 0xD800 <= point <= 0xDFFF]

# `{}` is the code point. A sigma ends a word ("ς") when a letter, perhaps with marks between, comes before it
# and none comes after it; each template puts the code point where that rule looks.
SIGMA = ["A{}\u03a3", "{}\u03a3", "A\u03a3{}", "A\u03a3{}A", "{}\u03a3A"]


def ranges(points: list[int]) -> str:
    """`<first>-<last>` runs, or one code point, in hex, joined by commas."""
    out: list[str] = []
    start = previous = None
    for point in [*points, None]:
        if start is not None and point is not None and point == previous + 1:
            previous = point
            continue
        if start is not None:
            out.append(f"{start:x}" if start == previous else f"{start:x}-{previous:x}")
        start = previous = point
    return ",".join(out)


def hexes(text: str) -> str:
    return " ".join(f"{ord(char):x}" for char in text)


def main() -> None:
    word = re.compile(r"\w")
    digit = re.compile(r"\d")
    unassigned = [p for p in POINTS if unicodedata.category(chr(p)) == "Cn"]
    casefold = {f"{p:x}": hexes(chr(p).casefold()) for p in POINTS if chr(p).casefold() != chr(p)}
    lower = {f"{p:x}": hexes(chr(p).lower()) for p in POINTS if chr(p).lower() != chr(p)}
    wordy = [p for p in POINTS if word.fullmatch(chr(p))]
    digits = [p for p in POINTS if digit.fullmatch(chr(p))]
    reprs = hashlib.sha256("\n".join(f"{p:x} {chr(p)!r}" for p in POINTS).encode("utf-8")).hexdigest()
    sigma = {
        template: hashlib.sha256("\n".join(f"{p:x} {hexes(template.replace('{}', chr(p)).lower())}" for p in POINTS).encode("utf-8")).hexdigest()
        for template in SIGMA
    }
    vectors = {
        "python": sys.version.split()[0],
        "unicode": unicodedata.unidata_version,
        "unassigned": ranges(unassigned),
        "casefold": casefold,
        "lower": lower,
        "word": ranges(wordy),
        "digit": ranges(digits),
        "repr_sha256": reprs,
        "sigma_sha256": sigma,
    }
    (HERE / "unicode.json").write_text(json.dumps(vectors, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
