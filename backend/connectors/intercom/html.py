"""Message text as agents see it and write it.

Intercom stores messages as HTML. Read text is the HTML turned into plain text:
- a link to Intercom (the app, the API, its file hosts or help centers), or a relative one, which Intercom
  shows on its own host, shows as "[Intercom link]", label included, since a label can name another
  conversation; so does an address to Intercom in the text itself;
- images show as "[image]"; scripts, styles and other elements that are not text are left out, with what is
  inside them;
- other links show as "label (address)".
An element left out that is never closed hides the rest of the message rather than letting it through.

Written text is escaped and sent as HTML paragraphs, so it is shown literally: it cannot format anything or
mention a teammate. It may not address Intercom in any encoding.
"""

import html
import re
from html.parser import HTMLParser

from connectors.text import decoded, plain_text

# Intercom's hosts: the app and API, file hosts (intercomcdn, intercomassets, intercomusercontent,
# intercom-attachments) and help centers, in every region. Other hosts that start with "intercom" are hidden too.
_INTERCOM = re.compile(r"intercom[a-z0-9-]*\.[a-z]{2}|intercom:", re.IGNORECASE)
# Links shown with their address. Others, relative ones included (Intercom shows them on its own host), are hidden.
_SHOWN_LINK = re.compile(r"^(?:https?://|mailto:|tel:)", re.IGNORECASE)
_WORD = re.compile(r"\S+")
_BLOCKS = frozenset(
    {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "ul", "ol", "table", "li", "blockquote"}
)
_DROPPED = frozenset(
    {"script", "style", "head", "title", "template", "iframe", "object", "embed", "svg", "math", "noscript"}
)
LINK = "[Intercom link]"


def _to_intercom(text: str) -> bool:
    """Whether `text` addresses Intercom in any encoding; browsers drop tabs and newlines inside addresses."""
    return _INTERCOM.search(re.sub(r"[\t\n\r]", "", decoded(text))) is not None


def redact(text: str) -> str:
    """Plain text with every word that addresses Intercom replaced."""
    return _WORD.sub(lambda m: LINK if _to_intercom(m.group()) else m.group(), text)


class _Reader(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        # A link being read: its address and the text of its label.
        self.links: list[tuple[str, list[str]]] = []
        # The element whose content is dropped, and how deep the same element nests inside it.
        self.hidden: tuple[str, int] | None = None

    def _emit(self, text: str) -> None:
        if text:
            (self.links[-1][1] if self.links else self.out).append(text)

    def _hide(self, tag: str, replacement: str) -> None:
        self._emit(replacement)
        self.hidden = (tag, 1)

    def _newline(self) -> None:
        target = self.links[-1][1] if self.links else self.out
        if target and not target[-1].endswith("\n"):
            target.append("\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.hidden is not None:
            name, depth = self.hidden
            if tag == name:
                self.hidden = (name, depth + 1)
            return
        values = {k: v or "" for k, v in attrs}
        if tag in _DROPPED:
            self._hide(tag, "")
        elif tag == "a":
            href = values.get("href") or ""
            address = re.sub(r"[\x00-\x20]", "", decoded(href))
            # Readers disagree on which of repeated attributes counts. An empty href is the page itself.
            linked = "href" in values
            if len(values) != len(attrs) or _to_intercom(href) or (linked and not _SHOWN_LINK.match(address)):
                self._hide(tag, LINK)
            else:
                self.links.append((href, []))
        elif tag == "img":
            self._emit("[image]")
        elif tag == "br":
            self._emit("\n")
        elif tag == "li":
            self._newline()
            self._emit("- ")
        elif tag in _BLOCKS:
            self._newline()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Browsers ignore the slash on elements that are not void, so `<script/>` stays open.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if self.hidden is not None:
            name, depth = self.hidden
            if tag == name:
                self.hidden = (name, depth - 1) if depth > 1 else None
            return
        if tag == "a" and self.links:
            href, label = self.links.pop()
            text = "".join(label).strip()
            self._emit(f"{text} ({href})" if text and href and text != href else text or href)
        elif tag in {"td", "th"}:
            self._emit("\t")
        elif tag in _BLOCKS:
            self._newline()

    def handle_data(self, data: str) -> None:
        if self.hidden is None:
            self._emit(data)

    def text(self) -> str:
        # A link never closed is shown as text, without its address.
        for _, label in reversed(self.links):
            self.out.extend(label)
        lines = "".join(self.out).replace("\xa0", " ").split("\n")
        joined = "\n".join(line.rstrip() for line in lines)
        return redact(re.sub(r"\n{3,}", "\n\n", joined).strip())


def read(content: str | None) -> str:
    """The text an agent is shown."""
    if not content:
        return ""
    reader = _Reader()
    reader.feed(content)
    reader.close()
    return reader.text()


def check_written(text: str) -> str:
    """Refuses text that would do more than add words to a conversation. Used as a field validator."""
    plain_text(text)
    if _to_intercom(text):
        raise ValueError("must not link to Intercom")
    return text


def written(text: str) -> str:
    """The HTML that shows `text` literally: a paragraph per blank-line-separated block."""
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip())
    return "".join(
        f"<p>{html.escape(block).replace(chr(10), '<br>')}</p>" for block in blocks if block.strip()
    )
