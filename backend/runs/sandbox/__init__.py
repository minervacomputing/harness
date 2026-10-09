from functools import cache

from files.manifest import PAGE_BYTES
from minerva.config import config
from runs.sandbox.base import Limits, SandboxError, SandboxProvider, SandboxStatus

__all__ = ["Limits", "SandboxError", "SandboxProvider", "SandboxStatus", "limits", "provider"]


def limits() -> Limits:
    """What each run's worker gets: a folder of the size the gateway allows a conversation.

    tmpfs rounds its size up to whole pages, and the gateway charges files in whole pages, so the folder is rounded
    down: a folder that fills it is exactly the largest the gateway accepts.
    """
    cfg = config()
    return Limits(
        workspace_bytes=cfg.files_folder_bytes // PAGE_BYTES * PAGE_BYTES,
        workspace_entries=cfg.files_folder_entries,
    )


@cache
def provider() -> SandboxProvider:
    cfg = config()
    if cfg.sandbox_provider == "container":
        from runs.sandbox.container import ContainerProvider

        return ContainerProvider(
            gateway_volume=cfg.sandbox_gateway_volume,
            runtime=cfg.sandbox_runtime,
            allow_runc=cfg.sandbox_allow_runc,
        )
    from runs.sandbox.local import LocalProcessProvider

    return LocalProcessProvider(allowed=cfg.sandbox_allow_unisolated, gateway_url="http://127.0.0.1:8001")
