"""Message text as agents see it and write it.

Teams stores channel messages as HTML. Read text is the HTML turned into plain text, without what could
show another channel or team the agent may not read:
- a mention of a channel or team (`<at>` whose mention names a conversation) shows as "@[channel]"; people,
  tags and apps keep their names;
- a link to Teams shows as "[Teams link]": its label and its address can both carry a channel's name, and
  so does an address to Teams in the text itself;
- a quote (any `<blockquote>`: Teams quotes replied-to messages with one) shows as "[quoted message]";
- attachments (`<attachment>`), scripts and styles are left out.
Each of these drops everything inside the element, and an element that is never closed hides the rest of
the message rather than letting it through, and so does one written self-closing (`<at/>`), which browsers
read as open. A mention or link that repeats an attribute is hidden too, since readers disagree on which
value counts, and so is a mention whose id the list of mentions also gives to a channel. Images show as
"[image]" and emoji as their text.

Written text is escaped and sent as HTML, so it is shown literally: it cannot mention anyone (a mention
needs an `<at>` element and a list of mentions) or format anything. It may not link to Teams, in any
encoding: Teams can show a preview of a linked message or channel, which may be one the agent may not read.
"""

import html
import re
from html.parser import HTMLParser

from connectors.teams.client import Mention
from connectors.text import decoded, plain_text

_TEAMS = re.compile(
    r"teams\.(?:microsoft\.(?:com|us)|live\.com|cloud\.microsoft|microsoftonline\.cn|office\.com)|msteams:",
    re.IGNORECASE,
)
_WORD = re.compile(r"\S+")
_BLOCKS = frozenset({"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "ul", "ol", "table", "li"})
_DROPPED = frozenset({"attachment", "script", "style", "head", "title", "template"})


def _to_teams(text: str) -> bool:
    """Whether `text` addresses Teams in any encoding; browsers drop tabs and newlines inside addresses."""
    return _TEAMS.search(re.sub(r"[\t\n\r]", "", decoded(text))) is not None


def redact(text: str) -> str:
    """Plain text with every word that addresses Teams replaced."""
    return _WORD.sub(lambda m: "[Teams link]" if _to_teams(m.group()) else m.group(), text)


def _shown_mentions(mentions: list[Mention]) -> set[str]:
    """The `<at>` ids of mentions of people, tags and apps; any other mention, and any id also given to
    one, is hidden."""
    shown: set[str] = set()
    hidden: set[str] = set()
    for mention in mentions:
        if mention.id is None:
            continue
        target = mention.mentioned
        if target is None or target.conversation is not None:
            hidden.add(str(mention.id))
        elif target.user is not None or target.application is not None or target.tag is not None:
            shown.add(str(mention.id))
        else:
            hidden.add(str(mention.id))
    return shown - hidden


class _Reader(HTMLParser):
    def __init__(self, shown: set[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.shown = shown
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
        repeated = len(values) != len(attrs)
        if tag in _DROPPED:
            self._hide(tag, "")
        elif tag == "at":
            if values.get("id") in self.shown and not repeated:
                self._emit("@")
            else:
                self._hide(tag, "@[channel]")
        elif tag == "a":
            href = values.get("href", "")
            if repeated or _to_teams(href):
                self._hide(tag, "[Teams link]")
            else:
                self.links.append((href, []))
        elif tag == "blockquote":
            self._newline()
            self._hide(tag, "[quoted message]\n")
        elif tag == "img":
            self._emit("[image]")
        elif tag == "emoji":
            self._hide(tag, values.get("alt", ""))
        elif tag == "br":
            self._emit("\n")
        elif tag == "li":
            self._newline()
            self._emit("- ")
        elif tag in _BLOCKS:
            self._newline()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Browsers ignore the slash on elements that are not void, so `<at/>` stays open.
        if tag == "emoji" and self.hidden is None:
            self._emit(dict(attrs).get("alt") or "")
        else:
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


def read(content: str | None, content_type: str | None, mentions: list[Mention]) -> str:
    """The text an agent is shown."""
    if not content:
        return ""
    if (content_type or "").lower() == "text":
        return redact(content.strip())
    reader = _Reader(_shown_mentions(mentions))
    reader.feed(content)
    reader.close()
    return reader.text()


def check_written(text: str) -> str:
    """Refuses text that would do more than add words to a channel. Used as a field validator."""
    plain_text(text)
    if _to_teams(text):
        raise ValueError(
            "must not link to Teams: Teams may show the linked message or channel, which may be one you "
            "may not read"
        )
    return text


def written(text: str) -> str:
    """The HTML that shows `text` literally."""
    return html.escape(text).replace("\r\n", "\n").replace("\n", "<br>")
