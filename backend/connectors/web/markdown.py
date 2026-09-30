"""Readable text from HTML, in a Markdown-like form.

Built on the standard library's tolerant parser, since pages are hostile input. Scripts, styles, frames,
forms and navigation are dropped. Links keep absolute http(s) targets; images keep only their alt text,
so the conversation never gains a remote image that could carry data out when shown.
"""

import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

# Content inside these is dropped.
SKIPPED = frozenset(
    {
        "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed", "canvas",
        "nav", "footer", "select", "button", "textarea", "dialog", "audio", "video", "picture",
    }
)  # fmt: skip
BLOCKS = frozenset(
    {
        "p", "div", "section", "article", "main", "header", "aside", "ul", "ol", "li", "table", "tr",
        "blockquote", "pre", "dl", "dt", "dd", "figure", "figcaption", "form", "fieldset", "details",
        "summary", "address", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br",
    }
)  # fmt: skip
VOID = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
)
MAX_LINK = 500
MAX_DEPTH = 20


class _Converter(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.out: list[str] = []
        # Open skipped elements, and how many of each, so closing one never scans the whole stack.
        self.skip: list[str] = []
        self.skip_open: dict[str, int] = dict.fromkeys(SKIPPED, 0)
        self.lists: list[list[int]] = []  # per open list: [ordered, counter]
        self.pre = 0
        self.links: list[tuple[int, str | None]] = []
        self.title: list[str] = []
        self.in_title = False

    def _newline(self, count: int = 1) -> None:
        """Ends the line, with at least `count` line breaks in a row."""
        tail = "".join(self.out[-6:]).rstrip(" ")
        have = len(tail) - len(tail.rstrip("\n")) if tail.strip() else count
        if have < count:
            self.out.append("\n" * (count - have))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in SKIPPED:
            if tag not in VOID:
                self.skip.append(tag)
                self.skip_open[tag] += 1
            return
        if self.skip:
            return
        if tag == "title":
            self.in_title = True
            return
        values = dict(attrs)
        if tag in BLOCKS:
            self._newline(self._gap(tag))
        if len(tag) == 2 and tag[0] == "h" and tag[1] in "123456":
            self.out.append("#" * int(tag[1]) + " ")
        elif tag in {"ul", "ol"} and len(self.lists) < MAX_DEPTH:
            self.lists.append([tag == "ol", 0])
        elif tag == "li":
            indent = "  " * max(len(self.lists) - 1, 0)
            if self.lists and self.lists[-1][0]:
                self.lists[-1][1] += 1
                self.out.append(f"{indent}{self.lists[-1][1]}. ")
            else:
                self.out.append(f"{indent}- ")
        elif tag == "pre":
            self.pre += 1
            self.out.append("```\n")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag in {"strong", "b"}:
            self.out.append("**")
        elif tag in {"em", "i"}:
            self.out.append("*")
        elif tag == "blockquote":
            self.out.append("> ")
        elif tag in {"td", "th"}:
            self.out.append(" | ")
        elif tag == "hr":
            self.out.append("---\n")
        elif tag == "img":
            alt = (values.get("alt") or "").strip()
            if alt:
                self.out.append(f"[image: {_squash(alt)}]")
        elif tag == "a":
            # Links do not nest: a new one closes the open one, as browsers do. This also keeps each
            # piece of text inside at most one link, so closing links stays linear in the page size.
            if self.links:
                self.close_link()
            self.links.append((len(self.out), _link(self.base_url, values.get("href"))))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.skip:
            if self.skip_open.get(tag):
                # Unbalanced markup closes everything opened after the nearest matching tag.
                while (popped := self.skip.pop()) != tag:
                    self.skip_open[popped] -= 1
                self.skip_open[tag] -= 1
            return
        if tag == "title":
            self.in_title = False
            return
        if tag in {"ul", "ol"} and self.lists:
            self.lists.pop()
        elif tag == "pre" and self.pre:
            self.pre -= 1
            self.out.append("\n```")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag in {"strong", "b"}:
            self.out.append("**")
        elif tag in {"em", "i"}:
            self.out.append("*")
        elif tag == "a" and self.links:
            self.close_link()
        if tag in BLOCKS:
            self._newline(self._gap(tag))

    def close_link(self) -> None:
        start, href = self.links.pop()
        text = _squash("".join(self.out[start:]))
        del self.out[start:]
        if href and text and text != href:
            self.out.append(f"[{text}]({href})")
        else:
            self.out.append(text)

    def _gap(self, tag: str) -> int:
        """Line breaks around a block: a blank line around paragraphs and lists, but not nested lists."""
        if tag in {"ul", "ol"}:
            return 1 if self.lists else 2
        return 2 if tag in {"p", "table", "blockquote", "pre"} else 1

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title.append(data)
            return
        if self.skip:
            return
        if self.pre:
            self.out.append(data)
            return
        text = re.sub(r"\s+", " ", data)
        if not self.out or self.out[-1].endswith("\n"):
            text = text.lstrip(" ")
        if text:
            self.out.append(text)


def _link(base_url: str, href: str | None) -> str | None:
    if not href:
        return None
    try:
        absolute = urljoin(base_url, href.strip())
        parts = urlsplit(absolute)
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or len(absolute) > MAX_LINK:
        return None
    # Brackets and spaces would break the Markdown link.
    return absolute.replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _tidy(text: str) -> str:
    cleaned: list[str] = []
    code = False
    for line in text.split("\n"):
        line = line.rstrip()
        if line.lstrip(" ").startswith("```"):
            code = not code
            cleaned.append(line.lstrip(" "))
            continue
        if code:
            cleaned.append(line)
            continue
        stripped = line.lstrip(" ")
        # Leading spaces left over from collapsed whitespace, except list indentation.
        line = line if re.match(r"^\s*([-*]|\d+\.) ", line) else stripped
        if line.startswith("| "):
            line = line[2:]
        cleaned.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()


def html_to_text(html: str, base_url: str) -> tuple[str, str | None]:
    """(text, title) of an HTML page."""
    converter = _Converter(base_url)
    converter.feed(html)
    converter.close()
    # A link still open when the page ended, even inside an unclosed script.
    if converter.links:
        converter.close_link()
    title = _squash("".join(converter.title)) or None
    return _tidy("".join(converter.out)), title
