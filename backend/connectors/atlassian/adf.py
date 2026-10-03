"""Atlassian Document Format (ADF) as agents read it and write it.

Jira and Confluence store rich text as ADF, a JSON tree. Read text is that tree as plain text, without what
could show an object the agent may not read:
- a smart link (`inlineCard`, `blockCard`, `embedCard`) or a link to Atlassian shows as "[Atlassian link]":
  Atlassian renders such links with the linked issue's or page's title, and fills a pasted link's label
  with it too, so the label is left out as well. A link counts as one to Atlassian when its address, in
  any encoding, names an Atlassian domain or one of the connection's sites, or is relative;
- an address to Atlassian in the text itself shows the same way;
- macros (`extension` nodes) and any node Minerva does not know show as "[unsupported content]", without
  what they hold.
Mentions of people keep the name ADF stores with them. Images and files show as "[attachment]". The tree
is read to a bounded depth and size; what lies beyond is left out and marked.

Written text is plain: it becomes paragraphs of text, without marks, mentions or cards, so it cannot notify
anyone or format anything. It may not contain an address to Atlassian in any encoding, since Atlassian may
show it as a smart link previewing something the agent may not read.
"""

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from connectors.base import OperationError
from connectors.text import decoded, plain_text

LINK = "[Atlassian link]"
UNSUPPORTED = "[unsupported content]"
MAX_DEPTH = 40
MAX_NODES = 20_000

_ATLASSIAN = re.compile(
    r"atlassian\.(?:net|com)|jira\.com|atlassian\.design|atl\.so|trello\.com|bitbucket\.org", re.IGNORECASE
)
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
_WORD = re.compile(r"\S+")

_BLOCKS = frozenset(
    {
        "paragraph",
        "heading",
        "blockquote",
        "bulletList",
        "orderedList",
        "codeBlock",
        "panel",
        "table",
        "tableRow",
        "expand",
        "nestedExpand",
        "layoutSection",
        "layoutColumn",
        "taskList",
        "decisionList",
        "mediaSingle",
        "mediaGroup",
    }
)
_CONTAINERS = frozenset({"doc", "tableCell", "tableHeader"}) | _BLOCKS
_CARDS = frozenset({"inlineCard", "blockCard", "embedCard"})
_MEDIA = frozenset({"media", "mediaInline"})
_MARKERS = ("- ", "- [x] ", "- [ ] ")


def _flattened(text: str) -> str:
    # Browsers drop tabs and newlines inside addresses.
    return re.sub(r"[\t\n\r]", "", decoded(text))


def internal(address: str, hosts: Iterable[str] = ()) -> bool:
    """Whether an address leads to Atlassian: an Atlassian domain or one of `hosts`, in any encoding, or a
    relative address, which resolves on the site showing it."""
    flat = _flattened(address).strip()
    if _ATLASSIAN.search(flat) or any(host and host in flat.lower() for host in hosts):
        return True
    return not _SCHEME.match(flat) or flat.startswith("//")


def redact(text: str, hosts: Iterable[str] = ()) -> str:
    """Plain text with every word that addresses Atlassian replaced."""
    hosts = tuple(hosts)

    def word(match: re.Match[str]) -> str:
        flat = _flattened(match.group())
        hit = _ATLASSIAN.search(flat) or any(host and host in flat.lower() for host in hosts)
        return LINK if hit else match.group()

    return _WORD.sub(word, text)


def _date(timestamp: Any) -> str:
    try:
        return datetime.fromtimestamp(int(timestamp) / 1000, UTC).date().isoformat()
    except TypeError, ValueError, OverflowError, OSError:
        return "[date]"


class _Reader:
    def __init__(self, hosts: tuple[str, ...]) -> None:
        self.hosts = hosts
        self.out: list[str] = []
        self.nodes = 0
        self.cut = False

    def _newline(self) -> None:
        # A list item's first paragraph stays on the line of its marker.
        if self.out and not self.out[-1].endswith("\n") and self.out[-1] not in _MARKERS:
            self.out.append("\n")

    def _attrs(self, node: dict) -> dict:
        attrs = node.get("attrs")
        return attrs if isinstance(attrs, dict) else {}

    def _text(self, value: Any) -> str:
        return value if isinstance(value, str) else ""

    def _link(self, node: dict) -> str | None:
        """The address of a text node's link mark; "" for a link without a usable address."""
        marks = node.get("marks")
        if not isinstance(marks, list):
            return None
        hrefs = [m for m in marks if isinstance(m, dict) and m.get("type") == "link"]
        if not hrefs:
            return None
        if len(hrefs) > 1:
            return ""
        return self._text(self._attrs(hrefs[0]).get("href"))

    def _children(self, node: dict, depth: int) -> None:
        content = node.get("content")
        if not isinstance(content, list):
            return
        # Consecutive text with the same link is one link.
        label: list[str] = []
        href: str | None = None
        for child in content:
            if self.cut:
                break
            current = self._link(child) if isinstance(child, dict) and child.get("type") == "text" else None
            if href is not None and current != href:
                self._flush(href, label)
                label, href = [], None
            if current is not None:
                # Within the same limits as any other node.
                self.nodes += 1
                if self.nodes > MAX_NODES or depth + 1 > MAX_DEPTH:
                    self.cut = True
                    break
                href = current
                label.append(self._text(child.get("text")))
                continue
            self._node(child, depth + 1)
        if href is not None:
            self._flush(href, label)

    def _flush(self, href: str, label: list[str]) -> None:
        text = "".join(label).strip()
        if not href or internal(href, self.hosts):
            self.out.append(LINK)
        elif text and text != href:
            self.out.append(f"{text} ({href})")
        else:
            self.out.append(href)

    def _node(self, node: Any, depth: int) -> None:
        if self.cut:
            return
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            self.cut = True
            return
        if not isinstance(node, dict):
            return
        kind = node.get("type")
        attrs = self._attrs(node)
        if kind == "text":
            self.out.append(self._text(node.get("text")))
        elif kind == "hardBreak":
            self.out.append("\n")
        elif kind == "rule":
            self._newline()
            self.out.append("---\n")
        elif kind == "mention":
            name = self._text(attrs.get("text")).lstrip("@")
            self.out.append(f"@{name}" if name else "@[someone]")
        elif kind == "emoji":
            self.out.append(self._text(attrs.get("text")) or self._text(attrs.get("shortName")))
        elif kind == "date":
            self.out.append(_date(attrs.get("timestamp")))
        elif kind == "status":
            self.out.append(f"[{self._text(attrs.get('text'))}]")
        elif kind in _CARDS:
            url = self._text(attrs.get("url"))
            self.out.append(LINK if not url or internal(url, self.hosts) else url)
        elif kind in _MEDIA:
            self.out.append("[attachment]")
        elif kind == "placeholder":
            pass
        elif kind == "listItem":
            self._newline()
            self.out.append("- ")
            self._children(node, depth)
            self._newline()
        elif kind in {"taskItem", "decisionItem"}:
            self._newline()
            self.out.append("- [x] " if attrs.get("state") == "DONE" and kind == "taskItem" else "- [ ] ")
            self._children(node, depth)
            self._newline()
        elif kind in {"tableCell", "tableHeader"}:
            self._children(node, depth)
            self.out.append("\t")
        elif kind in {"expand", "nestedExpand"}:
            self._newline()
            if title := self._text(attrs.get("title")):
                self.out.append(f"{title}\n")
            self._children(node, depth)
            self._newline()
        elif kind in _CONTAINERS:
            if kind in _BLOCKS:
                self._newline()
            self._children(node, depth)
            if kind in _BLOCKS:
                self._newline()
        else:
            # Macros and nodes Minerva does not know.
            self.out.append(UNSUPPORTED)

    def text(self) -> str:
        lines = "".join(self.out).replace("\xa0", " ").split("\n")
        joined = re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in lines)).strip()
        if self.cut:
            joined = f"{joined}\n[more content not shown]" if joined else "[more content not shown]"
        return redact(joined, self.hosts)


def read(document: Any, hosts: Iterable[str] = ()) -> str:
    """The text an agent is shown. `hosts` are the connection's sites, whose addresses count as Atlassian's."""
    if not isinstance(document, dict):
        return ""
    reader = _Reader(tuple(host.lower() for host in hosts))
    reader._node(document, 0)
    return reader.text()


def check_hosts(text: str, hosts: Iterable[str]) -> None:
    """Refuses written text naming one of the connection's sites, in any encoding (sites on their own
    domains are not covered by `check_written`)."""
    flat = _flattened(text).lower()
    if any(host and host.lower() in flat for host in hosts):
        raise OperationError(
            "INVALID_ARGUMENTS",
            "Text must not contain addresses of Atlassian sites: Atlassian may show them as previews.",
        )


def check_written(text: str) -> str:
    """Refuses text that would do more than add words. Used as a field validator."""
    plain_text(text)
    if _ATLASSIAN.search(_flattened(text)):
        raise ValueError(
            "must not contain Atlassian addresses: Atlassian may show them as previews of issues or pages "
            "you may not read"
        )
    return text


def written(text: str) -> dict[str, Any]:
    """An ADF document showing `text` literally: paragraphs at blank lines, line breaks within them."""
    paragraphs = []
    for block in re.split(r"\n[ \t]*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip()):
        content: list[dict[str, Any]] = []
        for line in block.split("\n"):
            if content:
                content.append({"type": "hardBreak"})
            if line:
                content.append({"type": "text", "text": line})
        if content:
            paragraphs.append({"type": "paragraph", "content": content})
    return {"type": "doc", "version": 1, "content": paragraphs}
