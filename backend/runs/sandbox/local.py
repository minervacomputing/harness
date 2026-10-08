"""Development-only provider: runs the worker as a plain child process with NO isolation.

The worker still holds only its run token, but it can read the host filesystem and reach the network.
It refuses to start unless MINERVA_SANDBOX_ALLOW_UNISOLATED=true.

Each worker gets a temporary directory of its own, holding the run's folder and the worker's temporary files,
removed when it is stopped. Processes its commands leave running are not killed: without a PID namespace of its
own, the worker cannot tell them from the user's other processes."""

import contextlib
import os
import shutil
import signal
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from minerva.config import REPO_ROOT
from runs.sandbox.base import Limits, SandboxError, SandboxInfo, SandboxStatus

RUN_DIR_PREFIX = "minerva-worker-"


class LocalProcessProvider:
    name = "local-process"

    def __init__(self, *, allowed: bool, gateway_url: str) -> None:
        self.allowed = allowed
        self.gateway_url = gateway_url
        self._children: dict[int, tuple[str, datetime, subprocess.Popen, str]] = {}

    def start(
        self,
        run_id: UUID,
        image: str,
        env: dict[str, str],
        limits: Limits,
        command: list[str] | None = None,
        *,
        attempt: int = 1,
    ) -> dict:
        if not self.allowed:
            raise SandboxError("The local-process sandbox is disabled; it provides no isolation.")
        worker = REPO_ROOT / "worker"
        run_dir = Path(tempfile.mkdtemp(prefix=RUN_DIR_PREFIX))
        try:
            (run_dir / "workspace").mkdir()
            (run_dir / "tmp").mkdir()
            child_env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(worker / ".local-home"),
                **env,
                "GATEWAY_URL": self.gateway_url,
                "WORKSPACE": str(run_dir / "workspace"),
                "TMPDIR": str(run_dir / "tmp"),
            }
            process = subprocess.Popen(  # noqa: S603
                ["node", *(command or ["src/main.ts"])],  # noqa: S607
                cwd=worker,
                env=child_env,
                start_new_session=True,
                stdin=subprocess.DEVNULL,
            )
        except OSError as error:
            _remove(str(run_dir))
            raise SandboxError("The local worker could not start.") from error
        self._children[process.pid] = (str(run_id), datetime.now(UTC), process, str(run_dir))
        return {"pid": process.pid, "dir": str(run_dir)}

    def stop(self, handle: dict) -> None:
        pid = handle["pid"]
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGKILL)
        child = self._children.pop(pid, None)
        if child is not None:
            child[2].wait(timeout=5)
        _remove(handle.get("dir"))

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
            SandboxInfo(run_id, {"pid": pid, "dir": run_dir}, process.poll() is None, started)
            for pid, (run_id, started, process, run_dir) in self._children.items()
        ]


def _remove(run_dir: object) -> None:
    """Removes a worker's directory, and nothing that start() did not make."""
    if not isinstance(run_dir, str):
        return
    path = Path(run_dir)
    if path.parent != Path(tempfile.gettempdir()) or not path.name.startswith(RUN_DIR_PREFIX):
        return
    shutil.rmtree(path, ignore_errors=True)
