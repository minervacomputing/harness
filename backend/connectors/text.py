"""Text helpers that several connectors share: input validation, cutting long text, decoding addresses."""

import html
import re
import unicodedata
from urllib.parse import unquote

# C0 control characters and DEL, except tab and newlines.
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def no_controls(value: str) -> str:
    """Refuses C0 control characters, tab and newlines included. DEL is allowed."""
    if any(ord(c) < 32 for c in value):
        raise ValueError("must not contain control characters")
    return value


def no_controls_or_del(value: str) -> str:
    """Refuses C0 control characters, tab and newlines included, and DEL."""
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters")
    return value


def single_line(value: str) -> str:
    """Refuses newlines and the characters in CONTROL; tab is allowed."""
    if CONTROL.search(value) or "\n" in value or "\r" in value:
        raise ValueError("must be a single line without control characters")
    return value


def truncate(value: str | None, limit: int) -> tuple[str | None, bool]:
    """The text cut to `limit` characters, and whether it was cut."""
    if value is None or len(value) <= limit:
        return value, False
    return value[:limit], True


def decoded(text: str) -> str:
    """The text with the encodings a browser or renderer undoes in an address, undone."""
    for _ in range(3):
        text = unicodedata.normalize("NFKC", html.unescape(unquote(text)))
        text = "".join(c for c in text if unicodedata.category(c) != "Cf")
        text = re.sub(r"[\u3002\uff0e\uff61]", ".", text).replace("\\", "")
    return text
