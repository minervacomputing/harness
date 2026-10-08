from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID


@dataclass(frozen=True)
class Limits:
    memory_mb: int = 1024
    cpus: float = 1.0
    pids: int = 256
    workspace_mb: int = 256


SandboxState = Literal["starting", "running", "exited", "missing"]


@dataclass(frozen=True)
class SandboxStatus:
    state: SandboxState
    exit_code: int | None = None


@dataclass(frozen=True)
class SandboxInfo:
    """One sandbox the provider manages. `since` is when it started if running, else when it exited."""

    run_id: str
    handle: dict
    running: bool
    since: datetime


class SandboxError(RuntimeError):
    pass


class SandboxProvider(Protocol):
    """Starts one worker per run. Its single security duty: the worker has one channel, to the gateway, and
    reaches nothing else: no other worker, no host service, no host credentials or readable host secrets.
    `local-process` is the development-only exception and isolates nothing. How the channel works is the
    provider's choice; `gateway_url` tells the worker where it is, and providers set it in the worker's
    environment themselves. `env` holds only GATEWAY_URL, RUN_TOKEN, and RUN_ID; a provider adds what its sandbox
    needs (WORKSPACE, the run's folder, empty at the start; TMPDIR; WORKER_KILL_STRAYS). Security never depends on
    `stop` succeeding; revoking the run token ends its access to data and tools, though a running worker can still
    hold connections open. `attempt` tells apart the workers of a run that
    was restarted. `command` overrides the image entrypoint; only the sandbox conformance check uses it."""

    name: str
    # As the worker reads GATEWAY_URL: an http(s) URL, or unix:<path> for a socket inside the sandbox.
    gateway_url: str

    def start(
        self,
        run_id: UUID,
        image: str,
        env: dict[str, str],
        limits: Limits,
        command: list[str] | None = None,
        *,
        attempt: int = 1,
    ) -> dict: ...

    def stop(self, handle: dict) -> None: ...

    def status(self, handle: dict) -> SandboxStatus: ...

    def sandboxes(self) -> list[SandboxInfo]:
        """Every sandbox this provider knows about, so the supervisor can remove ones no run tracks."""
        ...
