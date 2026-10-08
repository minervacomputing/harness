import json
import tempfile
import time
import uuid
from pathlib import Path

from runs.sandbox import local
from runs.sandbox.base import Limits
from runs.sandbox.local import LocalProcessProvider

REPORT_ENV = "const { env } = process; require('fs').writeFileSync(process.argv[1], JSON.stringify(env))"


def wait_for_exit(provider: LocalProcessProvider, handle: dict) -> int | None:
    for _ in range(500):
        status = provider.status(handle)
        if status.state == "exited":
            return status.exit_code
        time.sleep(0.01)
    raise AssertionError("The worker did not exit.")


def test_a_local_worker_has_a_folder_and_temporary_files_of_its_own_until_it_is_stopped(tmp_path):
    provider = LocalProcessProvider(allowed=True, gateway_url="http://127.0.0.1:9")
    report = tmp_path / "env.json"
    handle = provider.start(
        uuid.uuid4(), "unused", {"RUN_ID": "run"}, Limits(), ["-e", REPORT_ENV, str(report)]
    )
    assert wait_for_exit(provider, handle) == 0
    env = json.loads(report.read_text())
    run_dir = Path(handle["dir"])
    assert (env["WORKSPACE"], env["TMPDIR"]) == (str(run_dir / "workspace"), str(run_dir / "tmp"))
    assert [path.name for path in sorted(run_dir.iterdir())] == ["tmp", "workspace"]
    assert not any((run_dir / "workspace").iterdir())
    # A worker on the host shares its processes with the user's, so it leaves strays alone.
    assert "WORKER_KILL_STRAYS" not in env
    assert [info.handle for info in provider.sandboxes()] == [handle]
    provider.stop(handle)
    assert not run_dir.exists()


def test_stopping_removes_only_a_directory_a_local_worker_was_given(tmp_path):
    other = Path(tempfile.mkdtemp(prefix="minerva-other-"))
    try:
        for path in (tmp_path, other, Path(tempfile.gettempdir())):
            local._remove(str(path))
            assert path.exists()
        local._remove(None)
    finally:
        other.rmdir()
