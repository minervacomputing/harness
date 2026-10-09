"""Files a user attaches to a message: uploaded first (files.upload_app), then added to the folder of the run that
answers the message, at its root.

An upload is a Blob named by an Upload row until it is attached or expires (files.sweep). Attaching records the
run's base version, which names the blob from then on, and deletes the Upload row in the same transaction.
"""

import os
import unicodedata
from dataclasses import dataclass
from uuid import UUID

from django.utils import timezone

from conversations.models import Conversation
from files import limits, store
from files.limits import QuotaExceeded
from files.manifest import MAX_SEGMENT_BYTES, InvalidManifest, parse
from files.models import FolderVersion, Upload
from runs.models import Run
from workspaces.models import Membership

# Uploads a user may hold in a workspace without attaching them.
PENDING_UPLOADS = 30
# The longest suffix kept as a file's extension when its name is shortened or numbered.
MAX_EXTENSION_CHARS = 16
SNIFF_BYTES = 8192

ZIP_TYPES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
}
TEXT_TYPES = {
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown",
    ".tsv": "text/tab-separated-values",
}


class NotMember(Exception):
    pass


class TooManyUploads(Exception):
    pass


class AttachmentsRefused(Exception):
    """`status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


@dataclass(frozen=True)
class Attached:
    version: FolderVersion | None
    # [{"path", "size", "media_type"}], in the order the uploads were given.
    attachments: list[dict]


def clean_name(raw: str) -> str:
    """A file name from the browser, made a valid name at the folder's root: its last segment, without control or
    formatting characters (which could disguise an extension), in NFC, at most 255 bytes."""
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(char for char in name if unicodedata.category(char) not in ("Cc", "Cf", "Cs", "Zl", "Zp"))
    name = unicodedata.normalize("NFC", name).strip()
    if name in ("", ".", ".."):
        name = "file"
    return _fit(*_split(name))


def numbered(name: str, taken: set[str]) -> str:
    """`name`, or the first of `name (2).ext`, `name (3).ext`, ... that is not taken."""
    if name not in taken:
        return name
    stem, extension = _split(name)
    n = 2
    while True:
        candidate = _fit(stem, extension, f" ({n})")
        if candidate not in taken:
            return candidate
        n += 1


def _split(name: str) -> tuple[str, str]:
    dot = name.rfind(".")
    if dot <= 0 or len(name) - dot > MAX_EXTENSION_CHARS:
        return name, ""
    return name[:dot], name[dot:]


def _fit(stem: str, extension: str, suffix: str = "") -> str:
    """stem + suffix + extension, with the stem shortened until the name fits in MAX_SEGMENT_BYTES."""
    # No more characters than the name has bytes, so the loop is short for any name the browser sends.
    stem = stem[:MAX_SEGMENT_BYTES]
    while True:
        name = unicodedata.normalize("NFC", stem.rstrip() + suffix + extension)
        if len(name.encode()) <= MAX_SEGMENT_BYTES and name not in ("", ".", ".."):
            return name
        if not stem:
            # Only the extension is too long, which _split prevents; keep what fits.
            return name.encode()[:MAX_SEGMENT_BYTES].decode(errors="ignore") or "file"
        stem = stem[:-1]


def sniff(head: bytes, name: str) -> str:
    """The media type of a file that starts with `head`, for display: from its contents, with the name only
    telling apart kinds of zip and of text."""
    extension = os.path.splitext(name)[1].lower()
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"PK\x03\x04"):
        return ZIP_TYPES.get(extension, "application/zip")
    if head.startswith(b"\x1f\x8b"):
        return "application/gzip"
    if _is_text(head):
        return TEXT_TYPES.get(extension, "text/plain")
    return "application/octet-stream"


def _is_text(head: bytes) -> bool:
    if b"\0" in head:
        return False
    # The sample may end inside a character.
    for cut in range(4):
        try:
            head[: len(head) - cut].decode()
        except UnicodeDecodeError:
            continue
        return True
    return False


def record_upload(
    workspace_id: UUID, user_id: UUID, *, name: str, media_type: str, path: str, sha256: str, size: int
) -> Upload:
    """Stores the file at `path` and records it as the user's upload. Outside any transaction (store_blob).

    Raises NotMember, TooManyUploads, QuotaExceeded("workspace")."""

    def transact(record):
        # The member's row, locked, so concurrent uploads count each other, and membership is checked as it is
        # now. Taken before the blob's lock, as nothing takes them the other way round.
        member = (
            Membership.objects.select_for_update()
            .filter(workspace_id=workspace_id, user_id=user_id)
            .values_list("pk", flat=True)
            .first()
        )
        if member is None:
            raise NotMember
        if Upload.unscoped.filter(workspace_id=workspace_id, user_id=user_id).count() >= PENDING_UPLOADS:
            raise TooManyUploads
        blob = record()
        return Upload.unscoped.create(
            workspace_id=workspace_id,
            user_id=user_id,
            blob=blob,
            name=name,
            media_type=media_type,
            size=size,
        )

    return store.store_blob(workspace_id, sha256, size, path, transact)


def attach(
    conversation: Conversation, run: Run, parent_id: UUID | None, user_id: UUID, upload_ids: list[UUID]
) -> Attached:
    """Adds the user's uploads to the folder at its root, as the run's base version, and deletes the uploads. In
    the transaction that starts the run, after the run's row exists. Raises AttachmentsRefused."""
    if not upload_ids:
        version = FolderVersion.unscoped.get(pk=parent_id) if parent_id else None
        return Attached(version, [])
    if len(upload_ids) > limits.message_attachments():
        raise AttachmentsRefused(400, f"Attach at most {limits.message_attachments()} files to a message.")
    if len(set(upload_ids)) != len(upload_ids):
        raise AttachmentsRefused(400, "A file is attached twice.")
    found = {
        upload.pk: upload
        for upload in Upload.unscoped.select_for_update(of=("self",))
        .select_related("blob")
        .filter(pk__in=upload_ids, workspace_id=conversation.workspace_id, user_id=user_id)
        .order_by("pk")
    }
    if len(found) != len(upload_ids):
        raise AttachmentsRefused(
            400, "An attached file is no longer available. Remove it and attach it again."
        )
    uploads = [found[pk] for pk in upload_ids]

    parent = FolderVersion.unscoped.get(pk=parent_id) if parent_id else None
    files = parent.entries["files"] if parent else {}
    dirs = parent.entries["dirs"] if parent else []
    wire_files = [
        {"path": path, "sha256": entry["sha256"], "mode": entry["mode"], "mtime": entry["mtime"]}
        for path, entry in files.items()
    ]
    taken = {path.split("/", 1)[0] for path in (*files, *dirs)}
    mtime = int(timezone.now().timestamp() * 1000)
    attachments = []
    for upload in uploads:
        path = numbered(upload.name, taken)
        taken.add(path)
        wire_files.append({"path": path, "sha256": upload.blob.sha256, "mode": 0o644, "mtime": mtime})
        attachments.append({"path": path, "size": upload.size, "media_type": upload.media_type})
    try:
        manifest = parse({"files": wire_files, "dirs": list(dirs)}, max_entries=limits.folder_entries())
        version = store.record_version(
            conversation, FolderVersion.Kind.BASE, manifest, parent=parent, run=run
        )
    except QuotaExceeded as error:
        raise AttachmentsRefused(413, _over(error.limit)) from None
    except (InvalidManifest, store.UnknownBlob, store.StaleParent) as error:
        raise AttachmentsRefused(400, f"The files could not be attached: {error}") from None
    Upload.unscoped.filter(pk__in=upload_ids).delete()
    return Attached(version, attachments)


def _over(limit: str) -> str:
    if limit == "folder_entries":
        return (
            "These files would put more than "
            f"{limits.folder_entries():,} files and folders in this conversation's folder."
        )
    return (
        f"These files would make this conversation's folder larger than {size_text(limits.folder_bytes())}."
    )


def size_text(n: int) -> str:
    if n >= 2**30:
        return f"{n / 2**30:g} GB"
    return f"{n / 2**20:g} MB"
