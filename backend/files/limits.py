"""The limits on agent files, from the instance's configuration (minerva.config)."""

from minerva.config import config


class QuotaExceeded(Exception):
    """A limit would be passed: "folder_bytes", "folder_entries", "run_uploads" or "workspace"."""

    def __init__(self, limit: str) -> None:
        super().__init__(f"The {limit} limit would be exceeded.")
        self.limit = limit


def folder_bytes() -> int:
    return config().files_folder_bytes


def folder_entries() -> int:
    return config().files_folder_entries


def run_upload_bytes() -> int:
    return config().files_run_upload_bytes or 4 * folder_bytes()


def workspace_bytes() -> int | None:
    return config().files_workspace_bytes


def upload_bytes() -> int:
    return config().files_upload_bytes


def message_attachments() -> int:
    return config().files_message_attachments
