from functools import cache

from minerva.config import config
from runs.sandbox.base import Limits, SandboxError, SandboxProvider, SandboxStatus

__all__ = ["Limits", "SandboxError", "SandboxProvider", "SandboxStatus", "provider"]


@cache
def provider() -> SandboxProvider:
    cfg = config()
    if cfg.sandbox_provider == "container":
        from runs.sandbox.container import ContainerProvider

        return ContainerProvider(gateway_volume=cfg.sandbox_gateway_volume, runtime=cfg.sandbox_runtime)
    from runs.sandbox.local import LocalProcessProvider

    return LocalProcessProvider(allowed=cfg.sandbox_allow_unisolated, gateway_url="http://127.0.0.1:8001")
