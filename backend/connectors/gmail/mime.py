"""Reading and writing mail as Gmail carries it: MIME parts, headers and raw RFC 5322 messages.

Reading takes the text of a message from its MIME tree: plain text where a part offers it, otherwise HTML
converted to text with the Web connector's converter (which drops images and keeps only absolute http(s)
links, so text shown to the model cannot load anything). Attachments, and messages attached to this one
(`message/rfc822`, read as a whole subtree), are named, never read. Gmail can keep a large body part apart
from the message (`attachmentId`); such a body is reported as unavailable rather than empty.

Address headers are parsed strictly: a header that appears twice, or holds anything that is not a plain
address Minerva accepts (see `connectors.addresses`), is not guessed at.
"""

import base64
import binascii
import re
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.message import Message as MimeMessage
from email.policy import SMTP, default

from connectors import addresses
from connectors.base import OperationError
from connectors.gmail.client import Part
from connectors.web.markdown import html_to_text

MAX_DEPTH = 10
MAX_PARTS = 200
MAX_ATTACHMENTS = 20
MAX_HEADER = 2000
MAX_FILENAME = 200
MAX_REFERENCES = 20
# A Message-ID or a reference to one: angle brackets around two runs of printable ASCII, without spaces or
# angle brackets, joined by one @.
MESSAGE_ID = re.compile(r"\A<[!-;=?A-~]{1,200}@[!-;=?A-~]{1,200}>\Z")
_SPACE = re.compile(r"\s+")


@dataclass(slots=True)
class Content:
    text: str = ""
    # A body part Gmail keeps apart from the message, or could not be decoded: the text is incomplete.
    unavailable: bool = False
    attachments: list[dict] = field(default_factory=list)
    parts: int = 0


def header_text(value: str | None) -> str | None:
    """A header's value for display: encoded words decoded, on one line, cut to a bounded length."""
    if value is None:
        return None
    with suppress(ValueError, LookupError, UnicodeError):
        value = str(make_header(decode_header(value)))
    value = "".join(c if c.isprintable() else " " for c in value)
    return _SPACE.sub(" ", value).strip()[:MAX_HEADER]


def _header(part: Part, name: str) -> str | None:
    folded = name.lower()
    return next((h.value for h in part.headers if h.name.lower() == folded), None)


def _content_type(part: Part) -> MimeMessage:
    """The part's Content-Type and Content-Disposition, parsed by the standard library."""
    parsed = MimeMessage()
    for name in ("Content-Type", "Content-Disposition"):
        value = _header(part, name)
        if value is not None:
            parsed[name] = value
    return parsed


def _decode(part: Part) -> str | None:
    """The part's body as text, or None when Gmail keeps it apart or it cannot be decoded."""
    body = part.body
    if body is None or body.attachment_id:
        return None
    if body.data is None:
        return "" if not body.size else None
    try:
        data = base64.b64decode(body.data + "=" * (-len(body.data) % 4), altchars=b"-_", validate=True)
    except binascii.Error, ValueError:
        return None
    charset = _content_type(part).get_content_charset() or "utf-8"
    try:
        return data.decode(charset, errors="replace")
    except LookupError, UnicodeError:
        # The sender names the charset: one Python lacks, or a codec that cannot replace errors (idna).
        return data.decode("utf-8", errors="replace")


def _is_attachment(part: Part) -> bool:
    disposition = _content_type(part).get_content_disposition()
    return bool(part.filename) or disposition == "attachment"


def _attachment(content: Content, part: Part) -> None:
    if len(content.attachments) < MAX_ATTACHMENTS:
        content.attachments.append(
            {
                "filename": header_text(part.filename)[:MAX_FILENAME] if part.filename else None,
                "mime_type": part.mime_type.lower()[:100] or None,
                "size": part.body.size if part.body else None,
            }
        )


def _render(content: Content, part: Part, depth: int) -> str | None:
    content.parts += 1
    if content.parts > MAX_PARTS or depth > MAX_DEPTH:
        content.unavailable = True
        return None
    mime_type = part.mime_type.lower()
    # An attachment is never read, whatever it holds, including a multipart one.
    if mime_type == "message/rfc822" or _is_attachment(part):
        _attachment(content, part)
        return None
    if mime_type == "multipart/alternative":
        # Plain text where the sender offered it; otherwise the richest alternative, which comes last.
        ordered = sorted(part.parts[::-1], key=lambda child: child.mime_type.lower() != "text/plain")
        for child in ordered:
            text = _render(content, child, depth + 1)
            if text is not None:
                return text
        return None
    if mime_type == "multipart/related" and part.parts:
        # The document is the root part (`start`, or else the first); the rest are resources it uses.
        start = _content_type(part).get_param("start")
        root = next((child for child in part.parts if start and _header(child, "Content-ID") == start), None)
        return _render(content, root or part.parts[0], depth + 1)
    if mime_type.startswith("multipart/"):
        texts = [text for child in part.parts if (text := _render(content, child, depth + 1))]
        return "\n\n".join(texts) if texts else None
    if mime_type not in {"text/plain", "text/html"}:
        if mime_type.startswith(("image/", "audio/", "video/", "application/")):
            _attachment(content, part)
        return None
    text = _decode(part)
    if text is None:
        content.unavailable = True
        return None
    if mime_type == "text/html":
        # No base address: relative links, which mean nothing outside the sender's mail client, are dropped.
        text, _ = html_to_text(text, "")
    return text.replace("\r\n", "\n").strip()


def content(payload: Part | None) -> Content:
    found = Content()
    if payload is not None:
        found.text = _render(found, payload, 0) or ""
    return found


def mailboxes(values: list[str]) -> list[str] | None:
    """The canonical addresses in one address header, or None when it appears more than once, the
    standard library's parser finds any defect in it, an address is not one Minerva accepts, or it names
    no address at all."""
    if len(values) != 1:
        return None
    try:
        header = default.header_factory("reply-to", values[0])
    except ValueError, IndexError, TypeError:
        return None
    if header.defects:
        return None
    found: list[str] = []
    for mailbox in header.addresses:
        try:
            address = addresses.parse(mailbox.addr_spec)
        except OperationError:
            return None
        if address not in found:
            found.append(address)
    return found or None


def message_id(value: str | None) -> str | None:
    value = value.strip() if value else None
    return value if value and MESSAGE_ID.match(value) else None


def threading(message_ids: list[str], references: list[str]) -> tuple[str, str] | None:
    """In-Reply-To and References for a reply: the original's Message-ID, after the last well-formed ids
    its References header names. None when the original has no single well-formed Message-ID."""
    if len(message_ids) != 1 or (original := message_id(message_ids[0])) is None:
        return None
    # A References header that appears twice is left out rather than guessed at.
    named = references[0].split() if len(references) == 1 else []
    chain = [ref for ref in named if MESSAGE_ID.match(ref) and ref != original]
    return original, " ".join([*chain[-(MAX_REFERENCES - 1) :], original])


def reply_subject(subject: str | None) -> str:
    subject = header_text(subject) or ""
    if subject[:3].casefold() == "re:":
        return subject[:900]
    return f"Re: {subject}"[:900]


def raw(
    *,
    to: Sequence[str],
    cc: Sequence[str] = (),
    bcc: Sequence[str] = (),
    subject: str,
    body: str,
    in_reply_to: tuple[str, str] | None = None,
) -> str:
    """A plain text message as Gmail takes it (base64url). It has no From: Gmail sends from the account's
    default address. Bcc stays in the message Gmail is given; Gmail leaves it out of what it delivers."""
    message = EmailMessage(policy=SMTP)
    if to:
        message["To"] = ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    if bcc:
        message["Bcc"] = ", ".join(bcc)
    message["Subject"] = subject
    if in_reply_to is not None:
        message["In-Reply-To"], message["References"] = in_reply_to
    message.set_content(body, charset="utf-8", cte="quoted-printable")
    return base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
