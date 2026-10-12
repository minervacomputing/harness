"""What the generators share to keep each vectors.json small enough to commit (about 500 KB at most).

- `FULL`: `--full` on the command line writes the whole randomized set, several MB, for a local run. Without
  it the committed file keeps a sample of each random or fuzz group, drawn with the same seed, and every
  hand-picked case. `sample(full, committed)` is a group's size.
- `compact(value)`: a long string that is mostly repetition (a deflated run of spaces, a 64 KB name, a
  base64 of zeros) is written as `{"$runs": [literal, [unit, count], literal, ...]}`, which
  test/fixtures/connectors/read-vectors.ts expands when it reads the file.

A generator imports this with `sys.path.insert(0, str(HERE.parent))`.
"""

import re
import sys

FULL = "--full" in sys.argv

# A unit of 1 to 64 characters repeated at least 4 times.
_RUN = re.compile(r"(.{1,64}?)\1{3,}", re.DOTALL)
# Only strings and runs this long are worth the recipe.
_LONG = 400


def sample(full: int, committed: int) -> int:
    """The size of a random or fuzz group: `full` with --full, else `committed`."""
    return full if FULL else min(full, committed)


def runs(text: str) -> list | None:
    """`text` as literals and [unit, count] runs, or None when that does not make it less than half as long."""
    parts: list = []
    last = 0
    for match in _RUN.finditer(text):
        if len(match.group(0)) < _LONG // 2:
            continue
        if match.start() > last:
            parts.append(text[last : match.start()])
        parts.append([match.group(1), len(match.group(0)) // len(match.group(1))])
        last = match.end()
    if not parts:
        return None
    if last < len(text):
        parts.append(text[last:])
    packed = sum(len(p) if isinstance(p, str) else len(p[0]) + 12 for p in parts) + 12 * len(parts)
    return parts if packed * 2 < len(text) else None


def compact(value):
    """`value` with every long, repetitive string (in lists and dict values) replaced by a `$runs` recipe."""
    if isinstance(value, str):
        if len(value) < _LONG:
            return value
        parts = runs(value)
        return {"$runs": parts} if parts is not None else value
    if isinstance(value, list):
        return [compact(item) for item in value]
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items()}
    return value
