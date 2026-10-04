"""Issue and comment text as agents see it and write it.

Linear writes links to its own objects as plain linear.app addresses, and those carry titles: an issue's
address ends in its title, a project's or document's in its name. Such a link in an issue the agent may
read can name an issue in a team it may not read. Read text therefore shortens every linear.app address to
what identifies the object, and drops the label of a markdown link to one, which Linear fills with the
linked object's title.

Linear turns linear.app addresses in written text into mentions: mentioning a person notifies them, and
mentioning an issue adds a note to that issue's history. Text agents write may therefore link only to
issues, and `issue_links` names them so the connector can check each is in the team being written to. Text
may not show images from anywhere but Linear's own uploads, since a reader's browser would load them from
another site, nor use HTML that loads or links anything.
"""

import re

from connectors.text import decoded, plain_text

MAX_ISSUE_LINKS = 10

_ANY_LINEAR = re.compile(r"linear\.app", re.IGNORECASE)
# An address of an object in Linear; group 3 is the rest of its path.
_LINEAR_URL = re.compile(
    r"(?<![\w.@-])(?:https?://)?linear\.app/([A-Za-z0-9_-]+)(?:/([A-Za-z0-9_-]+))?((?:/[^\s()<>\[\]\"'`]*)?)",
    re.IGNORECASE,
)
# Punctuation that ends a sentence after an address rather than belonging to it.
_TRAILING = re.compile(r"[.,;:!?]+$")
# A markdown link or image to linear.app; group 1 is the address. Labels may hold escapes and one level of
# brackets, as Linear writes them for titles with brackets.
_LABELLED_LINK = re.compile(
    r"!?\[(?:\\.|[^\]\[\\\n]|\[(?:\\.|[^\]\[\\\n])*\])*\]"
    r"\(\s*<?((?:https?://)?linear\.app/[^\s()<>]*)>?"
    r"(?:\s+(?:\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?\s*\)",
    re.IGNORECASE,
)
_OWN_ID = re.compile(r"-([0-9a-f]{8,})$", re.IGNORECASE)
IDENTIFIER = re.compile(r"\A[A-Za-z0-9]{1,10}-\d{1,9}\Z")

# An issue address as agents may write it: workspace, identifier and optionally the title part.
_ISSUE_LINK = re.compile(
    r"https?://linear\.app/([A-Za-z0-9_-]+)/issue/([A-Za-z0-9]{1,10}-\d{1,9})(?:/[A-Za-z0-9-]*)?",
    re.IGNORECASE,
)
_SCHEME = re.compile(r"https?://$", re.IGNORECASE)
# All that any parser could take as part of an address: up to whitespace or an angle bracket.
_RUN = re.compile(r"[^\s<>]*")
# What may follow an address without being part of it: punctuation, closing brackets, emphasis, quotes.
_AFTER = re.compile(r"[.,;:!?)\]*_~'\"]+$")
_IMAGE = re.compile(r"!\[[^\]\n]*\]\(\s*<?https://uploads\.linear\.app/[^\s()<>]+>?(?:\s+\"[^\"\n]*\")?\s*\)")
_TAG = re.compile(r"<\s*/?\s*([A-Za-z][\w:-]*)([^<>]*)>")
_LINK_ATTRIBUTE = re.compile(r"\b(?:src|url|href|data|srcset|poster|action|background)\s*=", re.IGNORECASE)
_LOADING_TAGS = frozenset({"img", "image", "iframe", "embed", "object", "video", "audio", "source", "link"})


def _short(match: re.Match[str]) -> str:
    workspace, kind, rest = match[1], match[2], match[3] or ""
    end = _TRAILING.search(rest)
    trailing = end[0] if end else ""
    rest = rest[: len(rest) - len(trailing)]
    if kind is None:
        return f"https://linear.app/{workspace}{trailing}"
    segment = rest.strip("/").split("/", 1)[0]
    if kind.lower() == "issue" and IDENTIFIER.match(segment):
        return f"https://linear.app/{workspace}/issue/{segment.upper()}{trailing}"
    if own_id := _OWN_ID.search(segment):
        return f"https://linear.app/{workspace}/{kind}/{own_id[1].lower()}{trailing}"
    return f"https://linear.app/{workspace}/{kind}{trailing}"


def redact(text: str | None) -> str | None:
    """The text an agent is shown."""
    if text is None:
        return None
    text = _LABELLED_LINK.sub(lambda m: _LINEAR_URL.sub(_short, m[1]), text)
    return _LINEAR_URL.sub(_short, text)


def check_written(text: str) -> str:
    """Refuses text that would do more than add words to Linear. Used as a field validator."""
    plain_text(text)
    rest = _IMAGE.sub("", text)
    if len(_ANY_LINEAR.findall(decoded(rest))) > len(_ANY_LINEAR.findall(rest)):
        raise ValueError("must not write Linear addresses in an encoded form")
    if "![" in rest:
        raise ValueError("may show only images uploaded to Linear (https://uploads.linear.app/...)")
    for tag in _TAG.finditer(rest):
        if tag[1].lower() in _LOADING_TAGS or _LINK_ATTRIBUTE.search(tag[2]):
            raise ValueError("must not contain HTML that loads or links anything; use [text](url) links")
    if len(_links(rest)) > MAX_ISSUE_LINKS:
        raise ValueError(f"may link to at most {MAX_ISSUE_LINKS} Linear issues")
    return text


def _links(text: str) -> list[tuple[str, str]]:
    """The (workspace, identifier) of each Linear address in the text, refusing any that is not exactly an
    issue address. The whole run an address could extend over must be one, so that no path, query or
    fragment after it (`/../OPS-1`) can lead a browser or Linear elsewhere."""
    links = []
    for found in _ANY_LINEAR.finditer(text):
        scheme = _SCHEME.search(text, max(0, found.start() - 8), found.start())
        run = _RUN.match(text, found.start())
        address = text[scheme.start() if scheme else found.start() : run.end() if run else found.end()]
        address = _AFTER.sub("", address)
        link = _ISSUE_LINK.fullmatch(address.rstrip("/")) if scheme else None
        if link is None:
            raise ValueError(
                "may link to Linear only with issue addresses (https://linear.app/<workspace>/issue/<ID>), "
                "each followed by a space or the end of the link; Linear turns other Linear links into mentions"
            )
        links.append((link[1].lower(), link[2].upper()))
    return links


def issue_links(text: str) -> list[tuple[str, str]]:
    """The (workspace, identifier) of every Linear issue the text links to, once each."""
    return sorted(set(_links(_IMAGE.sub("", text))))
