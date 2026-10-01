"""Message text as agents see it and write it.

Slack writes links as control sequences, `<target|label>`. A link to a channel carries that channel's
name as its label (`<#C123|secret-plans>`), and so can a link to a message in Slack. Read text therefore
drops the label of every link to a channel or to Slack itself; the agent still sees the channel's id.

Written text is sent as words only. `&`, `<` and `>` are escaped, so text cannot form a control sequence:
no `<!channel>`, `<!here>` or `<!everyone>` that notifies a whole channel, no mention of a person or user
group, and no link with a label that hides where it goes. Text may not link to Slack at all: Slack shows
the content of a linked message, which could be in a channel the agent may not read, next to the post.
"""

import html
import re
import unicodedata
from urllib.parse import unquote, urlsplit

CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# A control sequence with a label; the label may hold anything but angle brackets.
_LABELLED = re.compile(r"<([^<>|]*)\|([^<>]*)>")
# Slack's hosts, GovSlack's included, and its own URI scheme (slack://channel?id=...).
_SLACK_HOST = re.compile(r"(?:^|\.)slack(?:-files|-gov|-files-gov)?\.com$", re.IGNORECASE)
_SLACK_NAME = re.compile(r"slack(?:-files|-gov|-files-gov)?\.com|slack:/", re.IGNORECASE)


def _decoded(text: str) -> str:
    """The text with the encodings a browser or Slack undoes in an address, undone."""
    for _ in range(3):
        text = unicodedata.normalize("NFKC", html.unescape(unquote(text)))
        text = "".join(c for c in text if unicodedata.category(c) != "Cf")
        text = re.sub("[\u3002\uff0e\uff61]", ".", text).replace("\\", "")
    return text


def _to_slack(target: str) -> bool:
    if target.startswith(("#", "@", "!")):
        return target.startswith("#")
    try:
        parts = urlsplit(target)
        if parts.scheme.lower() == "slack":
            return True
        host = parts.hostname or ""
    except ValueError:
        return True
    return bool(_SLACK_HOST.search(host)) or bool(_SLACK_NAME.search(_decoded(target)))


def redact(text: str | None) -> str | None:
    """The text an agent is shown."""
    if text is None:
        return None
    return _LABELLED.sub(lambda m: f"<{m[1]}>" if _to_slack(m[1]) else m[0], text)


def check_written(text: str) -> str:
    """Refuses text that would do more than add words to a channel. Used as a field validator."""
    if CONTROL.search(text):
        raise ValueError("must not contain control characters")
    if _SLACK_NAME.search(_decoded(text)):
        raise ValueError(
            "must not link to Slack: Slack would show the linked message, which may be in another channel"
        )
    return text


def escape(text: str) -> str:
    """Text as Slack shows it literally."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
