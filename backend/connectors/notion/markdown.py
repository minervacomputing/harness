"""Page text as agents see it and write it.

Notion's page markdown names other pages: child pages and databases with their titles, mentions with the
mentioned page's title, links whose address carries the page's title, and synced blocks with content that
lives on another page. The agent may not be allowed to read those, so their titles and synced content are
hidden when a page is read, and Notion links are shortened to the page's id. Hiding fails closed: synced
content is hidden up to the last closing tag, and a title tag left open hides the rest of the page.

Edits are made so their outcome depends only on the text the agent was shown: an edit is widened to whole
lines that hold nothing hidden, until it matches exactly once. Such text can only match where the agent
could see it too, so a refused or applied edit tells nothing about what was hidden. Pages that show synced
content from elsewhere are not edited at all.

Text the agent writes may not create child pages or databases (an existing one named there might be moved
into this page), copy synced content, mention people (which notifies them), or embed anything that Notion
or a reader's browser would load from another site. An edit may not produce such content by joining its
text with the page's either, nor turn text the page shows as code into markup: the edited lines must hold
none of it afterwards, the page as a whole may gain none, and the edit may not change code fences or the
parity of backticks.
"""

import re
from collections import Counter

from connectors.base import OperationError

# Tags whose content is another object's title.
TITLED = ("page", "database", "mention-page", "mention-database", "mention-data-source", "mention-agent")
_TITLED_OPEN = re.compile(r"<(" + "|".join(TITLED) + r")(?=[\s/>])([^<>]*)>", re.IGNORECASE)
_URL_ATTRIBUTE = re.compile(r'\burl="([^"<>]*)"')
SYNCED_OPEN = "<synced_block_reference"
SYNCED_CLOSE = "</synced_block_reference>"
SYNCED_HIDDEN = "(Synced content from another page. Minerva does not show it.)"
# Anything on a line that makes an edit there depend on hidden text.
_HIDDEN_MARK = re.compile(r"</?(?:" + "|".join(TITLED) + r"|synced_block_reference)\b", re.IGNORECASE)

# Tags agents may not write.
DENIED_TAGS = frozenset(
    {
        "page",
        "database",
        "synced_block",
        "synced_block_reference",
        "mention-user",
        "mention-agent",
        "mention-data-source",
        "img",
        "image",
        "video",
        "audio",
        "file",
        "pdf",
        "embed",
        "bookmark",
        "iframe",
        "link-preview",
        "link_preview",
        "object",
        "source",
        "form",
        "meeting-notes",
        "meeting_notes",
    }
)
_TAG = re.compile(r"<\s*/?\s*([A-Za-z][\w:-]*)([^<>]*)>")
_LINK_ATTRIBUTE = re.compile(r"\b(?:src|url|href|data|srcset|poster|action)\s*=", re.IGNORECASE)
_NOTION_MENTION = re.compile(
    r'\s+url="https://(?:www\.)?notion\.so/[^"\s<>]*"\s*/?\s*'
    r'|\s+url="https://[a-z0-9-]+\.notion\.site/[^"\s<>]*"\s*/?\s*'
)
MENTIONS = frozenset({"mention-page", "mention-database"})
MAX_WIDENING = 20
# A Notion page address; the part before the id is the page's title.
_NOTION_URL = re.compile(
    r"https://(?:(?:www\.)?notion\.so|[a-z0-9-]+\.notion\.site)/[^\s\"'<>()\[\]]*?([0-9a-f]{32})"
    r"(?![0-9a-f])[^\s\"'<>()\[\]]*",
    re.IGNORECASE,
)
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})", re.MULTILINE)


def _redact_synced(markdown: str) -> str:
    """Hides everything from the first synced reference to the last closing tag: synced content may
    itself contain the closing tag as text, so no earlier one can be trusted to end it."""
    start = markdown.find(SYNCED_OPEN)
    if start == -1:
        return markdown
    end = markdown.rfind(SYNCED_CLOSE)
    hidden = f"{SYNCED_OPEN}>{SYNCED_HIDDEN}{SYNCED_CLOSE}"
    if end < start:
        return markdown[:start] + hidden
    return markdown[:start] + hidden + markdown[end + len(SYNCED_CLOSE) :]


def _redact_titled(markdown: str) -> str:
    """Empties tags that hold another object's title, keeping only their address. A tag left open hides
    the rest of the page."""
    parts: list[str] = []
    position = 0
    while match := _TITLED_OPEN.search(markdown, position):
        name = match[1].lower()
        url = _URL_ATTRIBUTE.search(match[2])
        tag = f'<{name} url="{url[1]}"' if url else f"<{name}"
        parts.append(markdown[position : match.start()])
        if match[2].rstrip().endswith("/"):
            parts.append(f"{tag}/>")
            position = match.end()
            continue
        parts.append(f"{tag}></{name}>")
        close = re.compile(rf"</{re.escape(name)}\s*>", re.IGNORECASE).search(markdown, match.end())
        if close is None:
            return "".join(parts)
        position = close.end()
    parts.append(markdown[position:])
    return "".join(parts)


def redact(markdown: str) -> str:
    """The page text an agent is shown."""
    text = _redact_titled(_redact_synced(markdown))
    return _NOTION_URL.sub(lambda m: f"https://www.notion.so/{m[1].lower()}", text)


def shows_synced_content(markdown: str) -> bool:
    return SYNCED_OPEN in markdown


def _refusals(text: str) -> list[tuple[str, str]]:
    """What in the text would do more than add words to a page: (the text itself, why it is refused)."""
    found = [("![", "must not contain images")] * text.count("![")
    for match in _TAG.finditer(text):
        name = match[1].lower()
        attributes = match[2]
        if name in DENIED_TAGS:
            found.append((match[0], f"must not contain <{name}> tags"))
        elif name in MENTIONS:
            if attributes.strip() and not _NOTION_MENTION.fullmatch(attributes):
                found.append((match[0], f"<{name}> must link to a notion.so page"))
        elif _LINK_ATTRIBUTE.search(attributes):
            found.append((match[0], "must not contain tags that link to other sites; use [text](url) links"))
    return found


def check_written(text: str) -> str:
    """Refuses text that would do more than add words to a page. Used as a field validator."""
    if refused := _refusals(text):
        raise ValueError(refused[0][1])
    return text


def _not_applied(message: str) -> OperationError:
    return OperationError("EDIT_NOT_APPLIED", message)


def _once(text: str, part: str) -> bool:
    first = text.find(part)
    return first != -1 and text.find(part, first + 1) == -1


def _update(markdown: str, old: str, new: str) -> dict[str, str]:
    visible = redact(markdown)
    if not _once(visible, old):
        raise _not_applied("The text to replace must appear exactly once in the page, as read_page shows it.")
    start = visible.index(old)
    end = start + len(old)
    line_start = visible.rfind("\n", 0, start) + 1
    line_end = visible.find("\n", end)
    line_end = len(visible) if line_end == -1 else line_end
    for _ in range(MAX_WIDENING):
        if _HIDDEN_MARK.search(visible, line_start, line_end):
            raise _not_applied(
                "Minerva does not edit lines that link to child pages, databases or mentioned pages, "
                "or next to synced content. Choose text on other lines."
            )
        lead = 1 if line_start > 0 else 0
        trail = 1 if line_end < len(visible) else 0
        anchored = visible[line_start - lead : line_end + trail]
        if _once(visible, anchored):
            replaced = visible[line_start - lead : start] + new + visible[end : line_end + trail]
            # Whole lines without hidden text read the same in the page itself, unless they hold Notion
            # links, which are shown shortened.
            if not _once(markdown, anchored):
                raise _not_applied(
                    "Minerva cannot edit these lines: they link to Notion pages, or the page changed. "
                    "Read the page again, or choose text on other lines."
                )
            _check_edit(anchored, replaced)
            return {"old_str": anchored, "new_str": replaced}
        if line_start == 0 and line_end == len(visible):
            break
        if line_start > 0:
            line_start = visible.rfind("\n", 0, line_start - 1) + 1
        if line_end < len(visible):
            following = visible.find("\n", line_end + 1)
            line_end = len(visible) if following == -1 else following
    raise _not_applied("The lines around this text repeat in the page. Include more of the text to replace.")


def _check_edit(old: str, new: str) -> None:
    if _refusals(new):
        raise _not_applied(
            "Minerva does not edit lines that hold images, embeds or other content it does not write, "
            "nor make such content from the page's text. Choose text on other lines."
        )
    if _FENCE.findall(old) != _FENCE.findall(new) or old.count("`") % 2 != new.count("`") % 2:
        raise _not_applied(
            "Minerva does not add or remove code fences or single backticks in an edit, since that changes "
            "how the rest of the page reads. Keep backticks paired."
        )


def plan_edits(markdown: str, edits: list[tuple[str, str]]) -> list[dict[str, str]]:
    """Notion content updates for the agent's edits, applied in order."""
    before = Counter(text for text, _ in _refusals(markdown))
    updates = []
    for old, new in edits:
        update = _update(markdown, old, new)
        markdown = markdown.replace(update["old_str"], update["new_str"], 1)
        updates.append(update)
    if Counter(text for text, _ in _refusals(markdown)) - before:
        raise _not_applied(
            "These edits would join text into an image, embed or other content Minerva does not write."
        )
    return updates
