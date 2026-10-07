"""Docker/Podman provider. Workers have no network: their only way out is the gateway socket, in a volume they
mount read-only. They run as an unprivileged user on a read-only root filesystem, and get no capabilities.

To run workers under gVisor, register a runtime that may connect to host sockets (`runsc install
--runtime=runsc-minerva -- --host-uds=open`) and set `MINERVA_SANDBOX_RUNTIME=runsc-minerva`. That runtime lets a
worker connect to any host socket it can see, so the gateway volume must hold nothing else."""

import contextlib
from datetime import UTC, datetime
from pathlib import PurePosixPath
from uuid import UUID

import docker
from docker.errors import DockerException, NotFound
from docker.types import Mount, Ulimit

from runs.sandbox.base import Limits, SandboxError, SandboxInfo, SandboxStatus

LABEL = "minerva.run"
ATTEMPT_LABEL = "minerva.attempt"
GATEWAY_DIRECTORY = "/run/minerva/gateway"
GATEWAY_URL = f"unix:{GATEWAY_DIRECTORY}/gateway.sock"
# Under gVisor each process in the sandbox also costs about two host processes, and the sandbox itself about 34.
GVISOR_HOST_PIDS_BASE = 64
GVISOR_HOST_PIDS_PER_PROCESS = 3


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
    gateway_url = GATEWAY_URL

    def __init__(self, *, gateway_volume: str, runtime: str | None = None) -> None:
        self.gateway_volume = gateway_volume
        self.runtime = runtime
        self._client: docker.DockerClient | None = None
        self._resolved: tuple[str | None, bool] | None = None

    @property
    def client(self) -> docker.DockerClient:
        if self._client is None:
            try:
                self._client = docker.from_env()
            except DockerException as error:
                raise SandboxError("The container runtime is not reachable.") from error
        return self._client

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
        self._check_gateway_volume()
        runtime, gvisor = self._runtime()
        process_limits = self._process_limits(limits, gvisor=gvisor)
        try:
            container = self.client.containers.create(
                image,
                command=command,
                entrypoint=["node"] if command else None,
                name=f"minerva-run-{run_id}-{attempt}",
                labels={LABEL: str(run_id), ATTEMPT_LABEL: str(attempt)},
                # The worker reaches the gateway the one way this provider offers, whatever the caller passed.
                environment={**env, "GATEWAY_URL": GATEWAY_URL},
                network_mode="none",
                # The directory, not the socket file: a relay that restarts makes a new socket, which workers see.
                mounts=[Mount(GATEWAY_DIRECTORY, self.gateway_volume, read_only=True, no_copy=True)],
                runtime=runtime,
                user="1000:1000",
                read_only=True,
                tmpfs={
                    "/tmp": "rw,noexec,nosuid,size=64m",  # noqa: S108
                    "/workspace": f"rw,nosuid,size={limits.workspace_mb}m,uid=1000,gid=1000",
                },
                working_dir="/workspace",
                cap_drop=["ALL"],
                security_opt=["no-new-privileges"],
                **process_limits,
                mem_limit=f"{limits.memory_mb}m",
                memswap_limit=f"{limits.memory_mb}m",
                nano_cpus=int(limits.cpus * 1e9),
                ipc_mode="none",
                init=True,
                auto_remove=False,
            )
        except DockerException as error:
            raise SandboxError("The worker container could not be created.") from error
        handle = {"container_id": container.id}
        try:
            self._check_isolation(container)
            container.start()
        except (DockerException, SandboxError) as error:
            # A container left behind is removed later by the supervisor's sweep of untracked sandboxes.
            with contextlib.suppress(SandboxError):
                self.stop(handle)
            if isinstance(error, SandboxError):
                raise
            raise SandboxError("The worker container could not start.") from error
        return handle

    def _check_gateway_volume(self) -> None:
        try:
            volume = self.client.volumes.get(self.gateway_volume)
        except NotFound as error:
            raise SandboxError(
                f"The gateway socket volume {self.gateway_volume!r} does not exist."
            ) from error
        except DockerException as error:
            raise SandboxError("The container runtime is not reachable.") from error
        # A volume driver could put anything behind the mount; a local volume holds what the relay put there.
        if volume.attrs.get("Driver") != "local":
            raise SandboxError(
                f"The gateway socket volume {self.gateway_volume!r} must use the local driver."
            )

    def _process_limits(self, limits: Limits, *, gvisor: bool) -> dict:
        """Under runc, Docker's pids limit makes a fork past it fail with EAGAIN. Under gVisor every process in the
        sandbox also costs host processes, so a fork loop would reach that limit on the host side first and end the
        whole sandbox. There the limit is RLIMIT_NPROC, which gVisor counts per sandbox, with room above it on the
        host. Not under runc, where RLIMIT_NPROC counts every process of the worker's uid on the host."""
        if not gvisor:
            return {"pids_limit": limits.pids}
        return {
            "pids_limit": GVISOR_HOST_PIDS_BASE + GVISOR_HOST_PIDS_PER_PROCESS * limits.pids,
            "ulimits": [Ulimit(name="nproc", soft=limits.pids, hard=limits.pids)],
        }

    def _runtime(self) -> tuple[str | None, bool]:
        """The runtime workers run under, and whether it is gVisor. Without a configured runtime it is Docker's
        default when the first worker starts, named on every container after that, so that the limits keep matching
        the runtime. gVisor is its containerd shim by name, or a runtime whose binary is runsc (as `runsc install`
        registers it). Docker does not report which shim an alias stands for, so an alias for gVisor's shim is not
        recognised."""
        if self._resolved is None:
            try:
                info = self.client.info()
            except DockerException as error:
                raise SandboxError("The container runtime is not reachable.") from error
            name = self.runtime or info.get("DefaultRuntime") or None
            entry = (info.get("Runtimes") or {}).get(name or "") or {}
            gvisor = (name or "").startswith("io.containerd.runsc.") or PurePosixPath(
                entry.get("path") or ""
            ).name == "runsc"
            self._resolved = (name, gvisor)
        return self._resolved

    def _check_isolation(self, container) -> None:
        """Refuses, before it starts, a worker that Docker created with a network or another mount than asked for."""
        attrs = container.attrs
        mounts = [
            (mount.get("Type"), mount.get("Name"), mount.get("Destination"), mount.get("RW"))
            for mount in attrs.get("Mounts") or []
        ]
        isolated = attrs.get("HostConfig", {}).get("NetworkMode") == "none" and mounts == [
            ("volume", self.gateway_volume, GATEWAY_DIRECTORY, False)
        ]
        if not isolated:
            raise SandboxError("The worker container did not start isolated.")

    def stop(self, handle: dict) -> None:
        try:
            self.client.containers.get(handle["container_id"]).remove(force=True)
        except NotFound:
            return
        except DockerException as error:
            raise SandboxError("The worker container could not be removed.") from error

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
