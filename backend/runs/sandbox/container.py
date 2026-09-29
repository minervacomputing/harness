"""Docker/Podman provider. Workers join an internal network whose only other member is the gateway
(or a relay to it), run as an unprivileged user on a read-only root filesystem, and get no capabilities.

Set `MINERVA_SANDBOX_RUNTIME=runsc` to run workers under gVisor where it is installed."""

from datetime import UTC, datetime
from uuid import UUID

import docker
from docker.errors import DockerException, NotFound

from runs.sandbox.base import Limits, SandboxError, SandboxInfo, SandboxStatus

LABEL = "minerva.run"


def _parse_time(value: str | None) -> datetime | None:
    """Docker reports RFC 3339 times with nanoseconds, or year 1 for "never"."""
    if not value or value.startswith("0001-"):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class ContainerProvider:
    name = "container"

    def __init__(self, *, network: str, runtime: str | None = None) -> None:
        self.network = network
        self.runtime = runtime
        self._client: docker.DockerClient | None = None

    @property
    def client(self) -> docker.DockerClient:
        if self._client is None:
            try:
                self._client = docker.from_env()
            except DockerException as error:
                raise SandboxError("The container runtime is not reachable.") from error
        return self._client

    def start(
        self, run_id: UUID, image: str, env: dict[str, str], limits: Limits, command: list[str] | None = None
    ) -> dict:
        try:
            network = self.client.networks.get(self.network)
        except NotFound as error:
            raise SandboxError(f"Sandbox network {self.network!r} does not exist.") from error
        if not network.attrs.get("Internal"):
            raise SandboxError(f"Sandbox network {self.network!r} must be internal (no external route).")
        try:
            container = self.client.containers.run(
                image,
                command=command,
                entrypoint=["node"] if command else None,
                detach=True,
                name=f"minerva-run-{run_id}",
                labels={LABEL: str(run_id)},
                environment=env,
                network=self.network,
                runtime=self.runtime,
                user="1000:1000",
                read_only=True,
                tmpfs={
                    "/tmp": "rw,noexec,nosuid,size=64m",  # noqa: S108
                    "/workspace": f"rw,nosuid,size={limits.workspace_mb}m,uid=1000,gid=1000",
                },
                working_dir="/workspace",
                cap_drop=["ALL"],
                security_opt=["no-new-privileges"],
                pids_limit=limits.pids,
                mem_limit=f"{limits.memory_mb}m",
                memswap_limit=f"{limits.memory_mb}m",
                nano_cpus=int(limits.cpus * 1e9),
                ipc_mode="none",
                init=True,
                auto_remove=False,
            )
        except DockerException as error:
            raise SandboxError("The worker container could not start.") from error
        return {"container_id": container.id}

    def stop(self, handle: dict) -> None:
        try:
            container = self.client.containers.get(handle["container_id"])
        except NotFound:
            return
        try:
            container.remove(force=True)
        except NotFound:
            return

    def sandboxes(self) -> list[SandboxInfo]:
        try:
            containers = self.client.containers.list(all=True, filters={"label": LABEL})
        except DockerException as error:
            raise SandboxError("The container runtime is not reachable.") from error
        found = []
        for container in containers:
            state = container.attrs.get("State", {})
            running = bool(state.get("Running")) or state.get("Status") in {"created", "restarting"}
            stamp = state.get("StartedAt") if running else state.get("FinishedAt")
            since = _parse_time(stamp) or _parse_time(container.attrs.get("Created"))
            if since is None:
                continue
            found.append(SandboxInfo(container.labels[LABEL], {"container_id": container.id}, running, since))
        return found

    def logs(self, handle: dict) -> str:
        try:
            container = self.client.containers.get(handle["container_id"])
        except NotFound:
            return ""
        return container.logs(stdout=True, stderr=True, tail=500).decode("utf-8", errors="replace")

    def status(self, handle: dict) -> SandboxStatus:
        try:
            container = self.client.containers.get(handle["container_id"])
        except NotFound:
            return SandboxStatus("missing")
        state = container.attrs.get("State", {})
        if state.get("Running"):
            return SandboxStatus("running")
        if state.get("Status") in {"created", "restarting"}:
            return SandboxStatus("starting")
        return SandboxStatus("exited", state.get("ExitCode"))
