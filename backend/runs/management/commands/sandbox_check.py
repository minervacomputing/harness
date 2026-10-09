"""Runs the worker image's conformance probe under the configured container sandbox.

Every check must pass before the sandbox is trusted with real runs. The gateway must be running.

Two workers run at once: one listens where a worker sharing its network namespace could reach it, and the other
runs the checks, including that it cannot reach the first."""

import json
import secrets
import time
import uuid

from django.core.management.base import BaseCommand, CommandError

from minerva.config import config
from runs.sandbox import SandboxError, limits, provider
from runs.sandbox.base import Limits, SandboxStatus
from runs.sandbox.container import ContainerProvider

PROBE = "/app/src/probe.ts"
# Exactly these, so that an image built before a check was added fails rather than passes.
CHECKS = {
    "nonRootUser",
    "onlyRunTokenInEnvironment",
    "workspaceWritable",
    "workspaceExecutable",
    "tmpNotExecutable",
    "workspaceSizeLimitHolds",
    "commandsWithoutRunToken",
    "commandStraysKilled",
    "rootFilesystemReadOnly",
    "gatewayReachable",
    "gatewayDirectoryReadOnly",
    "onlyLoopbackInterface",
    "internetIPv4Blocked",
    "internetIPv6Blocked",
    "metadataServiceBlocked",
    "publicDnsUnresolvable",
    "hostUnreachable",
    "databaseUnreachable",
    "otherWorkersUnreachable",
    "forkLimitHolds",
}
# Only runc limits the folder's entries; under gVisor the worker's scan does.
RUNC_CHECKS = {"workspaceEntryLimitHolds"}
LISTEN_TIMEOUT = 60
PROBE_TIMEOUT = 90


def _last_json(output: str) -> dict | None:
    lines = [line for line in output.splitlines() if line.startswith("{")]
    if not lines:
        return None
    try:
        result = json.loads(lines[-1])
    except ValueError:
        return None
    return result if isinstance(result, dict) else None


class Command(BaseCommand):
    help = "Verify that the container sandbox isolates workers as required."

    def handle(self, *args, **options):
        cfg = config()
        sandbox = provider()
        if not isinstance(sandbox, ContainerProvider):
            raise CommandError("The sandbox check applies to the container provider only.")
        # What real runs get, so the probe checks their limits.
        run_limits = limits()
        _, gvisor = sandbox._runtime()
        expected = CHECKS if gvisor else CHECKS | RUNC_CHECKS
        probe_args = [
            "--processes",
            str(run_limits.pids),
            "--folder-bytes",
            str(run_limits.workspace_bytes),
        ]
        if not gvisor:
            probe_args += ["--folder-entries", str(run_limits.workspace_entries)]
        peer = secrets.token_hex(8)
        handles = []
        try:
            listener = self._start(sandbox, cfg.sandbox_image, [PROBE, "--listen", peer], run_limits)
            handles.append(listener)
            self._wait_listening(sandbox, listener)
            probe = self._start(sandbox, cfg.sandbox_image, [PROBE, "--peer", peer, *probe_args], run_limits)
            handles.append(probe)
            status = self._wait_exit(sandbox, probe)
            output = sandbox.logs(probe)
            # Otherwise the peer may have failed to reach it only because it was gone.
            if sandbox.status(listener).state != "running":
                raise CommandError("The listening probe stopped before the checks finished.")
        finally:
            for handle in handles:
                sandbox.stop(handle)

        checks = _last_json(output)
        if checks is None:
            raise CommandError(f"The probe produced no result:\n{output}")
        names = sorted(expected | checks.keys())
        width = max(map(len, names))
        failed = []
        for name in names:
            if name not in expected:
                label = "UNEXPECTED"
            elif name not in checks:
                label = "MISSING"
            else:
                label = "pass" if checks[name] is True else "FAIL"
            if label != "pass":
                failed.append(name)
            style = self.style.SUCCESS if label == "pass" else self.style.ERROR
            self.stdout.write(f"{name.ljust(width)}  {style(label)}")
        if failed:
            raise CommandError(f"Sandbox checks failed: {', '.join(failed)}")
        if status.exit_code != 0:
            raise CommandError(f"The probe exited with status {status.exit_code}.")
        self.stdout.write(self.style.SUCCESS(f"All {len(expected)} sandbox checks passed."))

    def _start(self, sandbox: ContainerProvider, image: str, command: list[str], run_limits: Limits) -> dict:
        run_id = uuid.uuid4()
        env = {"RUN_TOKEN": f"probe-{secrets.token_urlsafe(24)}", "RUN_ID": str(run_id)}
        try:
            return sandbox.start(run_id, image, env, run_limits, command=command)
        except SandboxError as error:
            raise CommandError(str(error)) from error

    def _wait_listening(self, sandbox: ContainerProvider, handle: dict) -> None:
        """Waits until the first worker listens and has reached itself there."""
        deadline = time.monotonic() + LISTEN_TIMEOUT
        while True:
            output = sandbox.logs(handle)
            if (_last_json(output) or {}).get("listening") is True:
                return
            if sandbox.status(handle).state not in {"starting", "running"}:
                raise CommandError(f"The listening probe stopped before it was ready:\n{output}")
            if time.monotonic() > deadline:
                raise CommandError(f"The listening probe was not ready within {LISTEN_TIMEOUT} seconds.")
            time.sleep(0.5)

    def _wait_exit(self, sandbox: ContainerProvider, handle: dict) -> SandboxStatus:
        deadline = time.monotonic() + PROBE_TIMEOUT
        while (status := sandbox.status(handle)).state in {"starting", "running"}:
            if time.monotonic() > deadline:
                raise CommandError(f"The probe did not finish within {PROBE_TIMEOUT} seconds.")
            time.sleep(0.5)
        return status
