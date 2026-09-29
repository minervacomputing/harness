"""Development-only provider: runs the worker as a plain child process with NO isolation.

The worker still holds only its run token, but it can read the host filesystem and reach the network.
It refuses to start unless MINERVA_SANDBOX_ALLOW_UNISOLATED=true."""

import contextlib
import os
import signal
import subprocess
from datetime import UTC, datetime
from uuid import UUID

from minerva.config import REPO_ROOT
from runs.sandbox.base import Limits, SandboxError, SandboxInfo, SandboxStatus


class LocalProcessProvider:
    name = "local-process"

    def __init__(self, *, allowed: bool, gateway_url: str) -> None:
        self.allowed = allowed
        self.gateway_url = gateway_url
        self._children: dict[int, tuple[str, datetime, subprocess.Popen]] = {}

    def start(
        self, run_id: UUID, image: str, env: dict[str, str], limits: Limits, command: list[str] | None = None
    ) -> dict:
        if not self.allowed:
            raise SandboxError("The local-process sandbox is disabled; it provides no isolation.")
        worker = REPO_ROOT / "worker"
        child_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(worker / ".local-home"),
            **env,
            "GATEWAY_URL": self.gateway_url,
        }
        try:
            process = subprocess.Popen(  # noqa: S603
                ["node", *(command or ["src/main.ts"])],  # noqa: S607
                cwd=worker,
                env=child_env,
                start_new_session=True,
                stdin=subprocess.DEVNULL,
            )
        except OSError as error:
            raise SandboxError("The local worker could not start.") from error
        self._children[process.pid] = (str(run_id), datetime.now(UTC), process)
        return {"pid": process.pid}

    def stop(self, handle: dict) -> None:
        pid = handle["pid"]
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGKILL)
        child = self._children.pop(pid, None)
        if child is not None:
            child[2].wait(timeout=5)

    def status(self, handle: dict) -> SandboxStatus:
        pid = handle["pid"]
        child = self._children.get(pid)
        if child is not None:
            code = child[2].poll()
            return SandboxStatus("running") if code is None else SandboxStatus("exited", code)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return SandboxStatus("missing")
        return SandboxStatus("running")

    def sandboxes(self) -> list[SandboxInfo]:
        return [
            SandboxInfo(run_id, {"pid": pid}, process.poll() is None, started)
            for pid, (run_id, started, process) in self._children.items()
        ]
