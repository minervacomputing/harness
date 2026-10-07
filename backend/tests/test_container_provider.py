import uuid

import pytest
from docker.errors import DockerException, NotFound

from runs.sandbox.base import Limits, SandboxError
from runs.sandbox.container import GATEWAY_DIRECTORY, GATEWAY_URL, ContainerProvider

VOLUME = "minerva-gateway-socket"


class FakeContainer:
    def __init__(self, client: FakeClient, kwargs: dict) -> None:
        self.client = client
        self.id = f"c{len(client.created)}"
        self.kwargs = kwargs
        self.started = False
        self.attrs = client.attrs_for(kwargs)

    def start(self) -> None:
        self.started = True

    def remove(self, force: bool = False) -> None:
        self.client.removed.append(self.id)


class FakeContainers:
    def __init__(self, client: FakeClient) -> None:
        self.client = client

    def create(self, image, **kwargs) -> FakeContainer:
        container = FakeContainer(self.client, kwargs)
        self.client.created.append(container)
        return container

    def get(self, container_id: str) -> FakeContainer:
        return next(c for c in self.client.created if c.id == container_id)


class FakeVolume:
    def __init__(self, driver: str) -> None:
        self.attrs = {"Driver": driver}


class FakeVolumes:
    def __init__(self, client: FakeClient) -> None:
        self.client = client

    def get(self, name: str) -> FakeVolume:
        if name not in self.client.volume_drivers:
            raise NotFound(name)
        return FakeVolume(self.client.volume_drivers[name])


class FakeClient:
    """Reports what Docker would: the network mode and mounts the container was created with."""

    def __init__(self) -> None:
        self.created: list[FakeContainer] = []
        self.removed: list[str] = []
        self.volume_drivers = {VOLUME: "local"}
        self.containers = FakeContainers(self)
        self.volumes = FakeVolumes(self)
        self.extra_mounts: list[dict] = []
        self.network_mode: str | None = None
        self.runtimes = {
            "runc": {"path": "runc"},
            "runsc-minerva": {"path": "/usr/local/bin/runsc", "runtimeArgs": ["--host-uds=open"]},
        }
        self.default_runtime = "runc"
        self.info_error: Exception | None = None

    def info(self) -> dict:
        if self.info_error:
            raise self.info_error
        return {"Runtimes": self.runtimes, "DefaultRuntime": self.default_runtime}

    def attrs_for(self, kwargs: dict) -> dict:
        mounts = [
            {
                "Type": mount["Type"],
                "Name": mount["Source"],
                "Destination": mount["Target"],
                "RW": not mount.get("ReadOnly", False),
            }
            for mount in kwargs.get("mounts", [])
        ]
        return {
            "HostConfig": {"NetworkMode": self.network_mode or kwargs.get("network_mode", "bridge")},
            "Mounts": mounts + self.extra_mounts,
        }


@pytest.fixture
def client() -> FakeClient:
    return FakeClient()


@pytest.fixture
def provider(client: FakeClient) -> ContainerProvider:
    sandbox = ContainerProvider(gateway_volume=VOLUME, runtime="runsc-minerva")
    sandbox._client = client  # type: ignore[assignment]
    return sandbox


def start(provider: ContainerProvider, env: dict | None = None) -> dict:
    return provider.start(
        uuid.uuid4(), "minerva-worker:test", env or {"RUN_TOKEN": "t", "RUN_ID": "r"}, Limits()
    )


def test_workers_get_no_network_and_only_the_gateway_socket_read_only(provider, client):
    handle = start(provider, {"GATEWAY_URL": "http://elsewhere:8001", "RUN_TOKEN": "t", "RUN_ID": "r"})
    (container,) = client.created
    assert handle == {"container_id": container.id}
    assert container.started
    kwargs = container.kwargs
    assert kwargs["network_mode"] == "none"
    assert "network" not in kwargs
    (mount,) = kwargs["mounts"]
    assert mount["Type"] == "volume"
    assert mount["Source"] == VOLUME
    assert mount["Target"] == GATEWAY_DIRECTORY
    assert mount["ReadOnly"] is True
    assert mount["VolumeOptions"]["NoCopy"] is True
    # The provider decides how the worker reaches the gateway, not the caller.
    assert kwargs["environment"]["GATEWAY_URL"] == GATEWAY_URL == provider.gateway_url
    assert kwargs["runtime"] == "runsc-minerva"
    assert kwargs["read_only"] is True
    assert kwargs["cap_drop"] == ["ALL"]


def test_a_missing_gateway_volume_refuses_to_start(provider, client):
    client.volume_drivers = {}
    with pytest.raises(SandboxError, match="does not exist"):
        start(provider)
    assert client.created == []


def test_a_gateway_volume_on_another_driver_refuses_to_start(provider, client):
    client.volume_drivers = {VOLUME: "some-plugin"}
    with pytest.raises(SandboxError, match="local driver"):
        start(provider)
    assert client.created == []


@pytest.mark.parametrize(
    "change",
    [
        lambda client: setattr(client, "network_mode", "bridge"),
        lambda client: client.extra_mounts.append(
            {"Type": "bind", "Name": "", "Destination": "/var/run/docker.sock", "RW": True}
        ),
    ],
    ids=["network", "extra-mount"],
)
def test_a_worker_created_otherwise_than_asked_is_removed_before_it_starts(provider, client, change):
    change(client)
    with pytest.raises(SandboxError, match="isolated"):
        start(provider)
    (container,) = client.created
    assert not container.started
    assert client.removed == [container.id]


def test_a_writable_gateway_mount_is_refused(provider, client):
    original = client.attrs_for

    def writable(kwargs):
        attrs = original(kwargs)
        attrs["Mounts"][0]["RW"] = True
        return attrs

    client.attrs_for = writable  # type: ignore[method-assign]
    with pytest.raises(SandboxError, match="isolated"):
        start(provider)
    assert not client.created[0].started


def test_under_gvisor_forks_are_limited_inside_the_sandbox_with_room_on_the_host(provider, client):
    start(provider)
    kwargs = client.created[0].kwargs
    (ulimit,) = kwargs["ulimits"]
    assert (ulimit.name, ulimit.soft, ulimit.hard) == ("nproc", 256, 256)
    assert kwargs["pids_limit"] == 64 + 3 * 256


def gvisor_detected(client, runtime: str | None) -> bool:
    sandbox = ContainerProvider(gateway_volume=VOLUME, runtime=runtime)
    sandbox._client = client  # type: ignore[assignment]
    start(sandbox)
    return "ulimits" in client.created[-1].kwargs


def test_gvisor_named_by_its_containerd_shim_is_recognised(client):
    assert gvisor_detected(client, "io.containerd.runsc.v1")


def test_gvisor_as_dockers_default_runtime_is_recognised(client):
    client.default_runtime = "runsc-minerva"
    assert gvisor_detected(client, None)


def test_dockers_default_runtime_is_pinned_so_the_limits_keep_matching_it(client):
    sandbox = ContainerProvider(gateway_volume=VOLUME)
    sandbox._client = client  # type: ignore[assignment]
    start(sandbox)
    client.default_runtime = "runsc-minerva"
    start(sandbox)
    assert [c.kwargs["runtime"] for c in client.created] == ["runc", "runc"]
    assert all("ulimits" not in c.kwargs for c in client.created)


def test_an_unreachable_docker_refuses_to_start_the_worker(client):
    client.info_error = DockerException("down")
    with pytest.raises(SandboxError, match="not reachable"):
        gvisor_detected(client, "runsc-minerva")
    assert not client.created


@pytest.mark.parametrize("runtime", [None, "runc", "unknown"])
def test_other_runtimes_get_only_the_pids_limit(client, runtime):
    assert not gvisor_detected(client, runtime)
    assert client.created[0].kwargs["pids_limit"] == 256
