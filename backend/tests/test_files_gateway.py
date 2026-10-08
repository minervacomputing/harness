import asyncio
import io
import json
import tempfile
import threading

import pytest
from asgiref.sync import async_to_sync, sync_to_async
from django.db import transaction
from django.test import AsyncClient, Client
from files_support import Background, conversation_in, put, run_in, sha, stored_keys, wait_until_blocked
from test_gateway_auth import CHUNK, Upload, bearer

from conversations.models import Conversation
from files import runs as folder
from files import store
from files.models import Blob, FolderVersion, RunBlob
from gateway import files
from minerva.config import config
from runs import services
from runs.models import Run
from workspaces.tenancy import workspace_scope

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("gateway_urls")]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def entry(path: str, data: bytes, mode: int = 0o644, mtime: int = 0) -> dict:
    return {"path": path, "sha256": sha(data), "mode": mode, "mtime": mtime}


def put_checkpoint(token: str, parent, *files: dict, dirs=(), **extra) -> tuple[int, dict]:
    body = {"parent": str(parent) if parent else None, "entries": {"files": list(files), "dirs": list(dirs)}}
    body |= extra
    response = Client().put(
        "/checkpoint", json.dumps(body), content_type="application/json", headers=auth(token)
    )
    return response.status_code, response.json()


async def read_all(response) -> bytes:
    return b"".join([chunk async for chunk in response.streaming_content])


def reload(run: Run) -> Run:
    return Run.unscoped.get(pk=run.pk)


async def until(condition) -> None:
    """Waits up to five seconds for something a blob I/O thread does."""
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Timed out.")


@pytest.fixture
def temp_dir(tmp_path, monkeypatch):
    """Where uploads stream to, so a test can check nothing is left behind."""
    directory = tmp_path / "uploads"
    directory.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(directory))
    return directory


async def upload(application, token: str, data: bytes) -> Upload:
    request = Upload(bearer(token), path=f"/blobs/{sha(data)}", body=data)
    await request.answer(application)
    return request


# The run spec


def test_the_spec_names_the_folder_its_limits_and_the_local_tools(claimed):
    _run, token = claimed
    spec = Client().get("/run", headers=auth(token)).json()
    assert spec["folder"] == {"version": None, "files": [], "dirs": []}
    assert spec["limits"]["folder_bytes"] == config().files_folder_bytes
    assert spec["limits"]["folder_entries"] == config().files_folder_entries
    assert spec["local_tools"] == ["read", "write", "edit", "bash"]


# Uploads


async def test_an_upload_is_stored_charged_and_granted_to_the_run(application, claimed, temp_dir):
    run, token = claimed
    request = await upload(application, token, b"hello")
    assert request.status == 200
    assert json.loads(request.body) == {"sha256": sha(b"hello"), "size": 5}
    blob = await Blob.unscoped.aget(sha256=sha(b"hello"))
    assert await RunBlob.unscoped.filter(run_id=run.id, blob=blob).aexists()
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == 5
    # Again: the bytes are received and hashed, and charged to the run.
    assert (await upload(application, token, b"hello")).status == 200
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == 10
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    ("data", "kwargs", "status", "charged"),
    [
        (b"hello", {"sha256": sha(b"other")}, 400, 5),
        (b"hello", {"sha256": "A" * 64}, 404, 0),
        (b"hello", {"length": b"4"}, 400, 5),
        (b"hello", {"length": b"6"}, 400, 5),
        (b"hello", {"length": b""}, 411, 0),
        (b"hello", {"length": b"-5"}, 400, 0),
    ],
    ids=["wrong hash", "malformed hash", "longer", "shorter", "no length", "invalid length"],
)
async def test_a_bad_upload_is_refused_and_leaves_nothing(
    application, claimed, temp_dir, files_storage, data, kwargs, status, charged
):
    run, token = claimed
    request = Upload(bearer(token), path=f"/blobs/{kwargs.get('sha256', sha(data))}", body=data)
    if "length" in kwargs:
        headers = [header for header in request.scope["headers"] if header[0] != b"content-length"]
        if kwargs["length"]:
            headers.append((b"content-length", kwargs["length"]))
        request.scope["headers"] = headers
    assert await request.answer(application) == status
    assert not await Blob.unscoped.aexists()
    # Bytes the gateway received count against the run's budget, stored or not.
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == charged
    assert list(temp_dir.iterdir()) == []
    assert stored_keys(files_storage) == []


async def test_an_upload_that_ends_early_leaves_nothing(application, claimed, temp_dir):
    _run, token = claimed
    request = Upload(bearer(token), path=f"/blobs/{sha(b'x' * 200_000)}", body=b"x" * 200_000)

    async def receive():
        message = await Upload.receive(request)
        return message if request.reads < 2 else {"type": "http.disconnect"}

    await asyncio.wait_for(application(request.scope, receive, request.send), 10)
    assert request.sent == []
    assert not await Blob.unscoped.aexists()
    assert list(temp_dir.iterdir()) == []


async def test_uploads_are_limited_by_the_folder_and_the_run(
    application, claimed, temp_dir, files_storage, monkeypatch
):
    _, token = claimed
    monkeypatch.setattr(config(), "files_folder_bytes", 8)
    request = await upload(application, token, b"123456789")
    assert (request.status, json.loads(request.body)["error"]["limit"]) == (413, "folder_bytes")
    assert request.reads == 0
    # Four times the folder: 32 bytes.
    for _ in range(4):
        assert (await upload(application, token, b"12345678")).status == 200
    # Over the budget, an upload is refused before its body is read, and nothing reaches storage.
    stored = stored_keys(files_storage)
    request = await upload(application, token, b"1")
    assert (request.status, json.loads(request.body)["error"]["limit"]) == (413, "run_uploads")
    assert request.reads == 0
    assert stored_keys(files_storage) == stored
    assert list(temp_dir.iterdir()) == []


async def test_uploads_that_fail_their_hash_use_up_the_budget(application, claimed, monkeypatch):
    run, token = claimed
    monkeypatch.setattr(config(), "files_folder_bytes", 8)
    for _ in range(4):
        request = Upload(bearer(token), path=f"/blobs/{sha(b'other')}", body=b"12345678")
        assert await request.answer(application) == 400
    request = Upload(bearer(token), path=f"/blobs/{sha(b'other')}", body=b"12345678")
    assert await request.answer(application) == 413
    assert request.reads == 0
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == 32


async def test_a_run_has_a_few_transfers_at_once(application, claimed, temp_dir):
    run, token = claimed
    data = b"x" * 200_000
    slow = [
        Upload(bearer(token), path=f"/blobs/{sha(data)}", body=data) for _ in range(files.TRANSFERS_PER_RUN)
    ]
    tasks = []
    for request in slow:
        request.flowing.clear()
        tasks.append(request.start(application))
        await asyncio.wait_for(request.read.wait(), 10)
    refused = await upload(application, token, b"hello")
    assert refused.status == 429
    response = await AsyncClient().get(f"/blobs/{sha(data)}", headers=auth(token))
    assert response.status_code in (404, 429)
    for request in slow:
        request.flowing.set()
    await asyncio.wait_for(asyncio.gather(*tasks), 10)
    assert [request.status for request in slow] == [200] * files.TRANSFERS_PER_RUN
    assert files._transfers == {}

    # A download holds its place until Django closes the response.
    response = await AsyncClient().get(f"/blobs/{sha(data)}", headers=auth(token))
    assert files._transfers == {run.id: 1}
    assert len(await read_all(response)) == 200_000
    await sync_to_async(response.close)()
    await until(lambda: files._transfers == {})


async def test_a_cancelled_upload_keeps_its_place_until_its_write_has_finished(
    application, claimed, temp_dir, monkeypatch
):
    run, token = claimed
    writing, release = [], threading.Event()
    write = files._write

    def slow_write(*args):
        writing.append(True)
        release.wait(10)
        write(*args)

    monkeypatch.setattr(files, "_write", slow_write)
    data = b"x" * 200_000
    tasks = []
    for count in range(1, files.TRANSFERS_PER_RUN + 1):
        tasks.append(Upload(bearer(token), path=f"/blobs/{sha(data)}", body=data).start(application))
        await until(lambda count=count: len(writing) == count)
    for task in tasks:
        task.cancel()
    await asyncio.sleep(0.05)
    # The threads still write, so the run's places stay taken.
    assert files._transfers == {run.id: files.TRANSFERS_PER_RUN}
    assert (await upload(application, token, b"hello")).status == 429

    release.set()
    results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 10)
    assert all(isinstance(result, asyncio.CancelledError) for result in results)
    assert files._transfers == {}
    assert list(temp_dir.iterdir()) == []
    assert not await Blob.unscoped.aexists()
    # Each upload's first chunk was received, and charged once.
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == files.TRANSFERS_PER_RUN * CHUNK


async def test_an_upload_cancelled_while_it_is_recorded_is_charged_once(
    application, claimed, temp_dir, monkeypatch
):
    run, token = claimed
    recording, release = threading.Event(), threading.Event()
    store_blob = store.store_blob

    def slow_store_blob(*args):
        recording.set()
        release.wait(10)
        return store_blob(*args)

    monkeypatch.setattr(store, "store_blob", slow_store_blob)
    task = Upload(bearer(token), path=f"/blobs/{sha(b'hello')}", body=b"hello").start(application)
    await until(recording.is_set)
    task.cancel()
    await asyncio.sleep(0.05)
    assert files._transfers == {run.id: 1}

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)
    assert files._transfers == {}
    assert list(temp_dir.iterdir()) == []
    # Stored, and charged as stored only.
    assert await RunBlob.unscoped.filter(run_id=run.id, blob__sha256=sha(b"hello")).aexists()
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == 5


def test_an_uploads_cleanup_takes_every_step_when_one_fails(claimed, temp_dir):
    run, _token = claimed
    staged = files._Staged()
    staged.open()
    staged.received = 5
    opened = staged.file

    class Full:
        def close(self):
            opened.close()
            raise OSError("No space left on device.")

    staged.file = Full()
    with pytest.raises(OSError):
        files._discard(staged, run.id, run.attempt)
    assert list(temp_dir.iterdir()) == []
    assert reload(run).uploaded_bytes == 5


async def test_a_download_closed_while_reading_keeps_its_place_until_the_read_has_finished(
    application, claimed, temp_dir, monkeypatch
):
    run, token = claimed
    assert (await upload(application, token, b"hello")).status == 200
    reading, release = threading.Event(), threading.Event()

    class Slow(io.BytesIO):
        def read(self, size=-1):
            reading.set()
            release.wait(10)
            return super().read(size)

    stream = Slow(b"hello")
    monkeypatch.setattr(store, "open_blob", lambda blob: stream)
    response = await AsyncClient().get(f"/blobs/{sha(b'hello')}", headers=auth(token))
    reader = asyncio.ensure_future(anext(aiter(response.streaming_content)))
    await until(reading.is_set)
    reader.cancel()
    await sync_to_async(response.close)()
    await asyncio.sleep(0.05)
    assert files._transfers == {run.id: 1}
    assert not stream.closed

    release.set()
    await until(lambda: files._transfers == {})
    assert stream.closed


async def test_an_upload_streaming_when_the_attempt_changed_is_refused(application, claimed, temp_dir):
    run, token = claimed
    data = b"x" * 200_000
    request = Upload(bearer(token), path=f"/blobs/{sha(data)}", body=data)
    request.flowing.clear()
    task = request.start(application)
    await asyncio.wait_for(request.read.wait(), 10)
    await sync_to_async(services.restart)(run.id, 1)
    request.flowing.set()
    await asyncio.wait_for(task, 10)
    assert request.status == 401
    assert not await Blob.unscoped.aexists()
    assert (await Run.unscoped.aget(pk=run.id)).uploaded_bytes == 0
    assert list(temp_dir.iterdir()) == []


# Downloads


async def test_a_run_reads_only_blobs_it_uploaded_or_its_folder_holds(
    application, claimed, tmp_path, workspace, user, other_user
):
    _, token = claimed
    assert (await upload(application, token, b"mine")).status == 200
    client = AsyncClient()
    response = await client.get(f"/blobs/{sha(b'mine')}", headers=auth(token))
    assert response.status_code == 200
    assert await read_all(response) == b"mine"
    assert response["Content-Length"] == "4"

    # Another conversation's blob, in the same workspace, and another workspace's: known only by hash.
    elsewhere = await sync_to_async(conversation_in)(workspace, user)
    await sync_to_async(put)(tmp_path, workspace.id, b"theirs", run=await sync_to_async(run_in)(elsewhere))
    with workspace_scope(other_user.personal_workspace.id):
        await sync_to_async(put)(tmp_path, other_user.personal_workspace.id, b"other workspace")
    for data in (b"theirs", b"other workspace", b"never stored"):
        assert (await client.get(f"/blobs/{sha(data)}", headers=auth(token))).status_code == 404
    assert (await client.get("/blobs/not-a-hash", headers=auth(token))).status_code == 404


# Checkpoints


async def test_checkpoints_build_on_each_other(application, claimed):
    run, token = claimed
    assert (await upload(application, token, b"one")).status == 200
    assert (await upload(application, token, b"two")).status == 200

    status, body = await sync_to_async(put_checkpoint)(token, None, entry("a.txt", b"one"), dirs=["empty"])
    assert status == 200
    first = await FolderVersion.unscoped.aget(pk=body["version"])
    assert (first.kind, first.run_id, first.attempt, first.parent_id) == ("checkpoint", run.id, 1, None)
    assert (await Run.unscoped.aget(pk=run.id)).checkpoint_id == first.id

    # The same folder again: the same version.
    assert await sync_to_async(put_checkpoint)(token, first.id, entry("a.txt", b"one"), dirs=["empty"]) == (
        200,
        {"version": str(first.id)},
    )
    status, body = await sync_to_async(put_checkpoint)(
        token, first.id, entry("a.txt", b"one"), entry("dir/b.py", b"two", mode=0o755)
    )
    assert status == 200
    second = await FolderVersion.unscoped.aget(pk=body["version"])
    # A run keeps only its last checkpoint, built on its base version (none here).
    assert second.parent_id is None
    assert not await FolderVersion.unscoped.filter(pk=first.id).aexists()
    assert second.entries["files"]["dir/b.py"] == {
        "sha256": sha(b"two"),
        "size": 3,
        "mode": 0o755,
        "mtime": 0,
    }

    # Not on top of the last checkpoint.
    status, body = await sync_to_async(put_checkpoint)(token, first.id, entry("a.txt", b"one"))
    assert (status, body["error"]["code"]) == (409, "conflict")
    status, body = await sync_to_async(put_checkpoint)(token, None)
    assert (status, body["error"]["code"]) == (409, "conflict")
    assert (await Run.unscoped.aget(pk=run.id)).checkpoint_id == second.id


def test_a_checkpoint_names_only_blobs_the_run_may_read(claimed, tmp_path, workspace, user, other_user):
    run, token = claimed
    elsewhere = run_in(conversation_in(workspace, user), status=Run.Status.COMPLETED)
    put(tmp_path, run.workspace_id, b"theirs", run=elsewhere)
    with workspace_scope(other_user.personal_workspace.id):
        put(tmp_path, other_user.personal_workspace.id, b"other")
    for data in (b"theirs", b"other", b"missing"):
        status, body = put_checkpoint(token, None, entry("f", data))
        assert (status, body["error"]["code"]) == (403, "unknown_blob")
    assert not FolderVersion.unscoped.exists()


@pytest.mark.parametrize(
    "body",
    [
        {"parent": None},
        {"parent": "not-a-uuid", "entries": {"files": [], "dirs": []}},
        {
            "parent": None,
            "entries": {"files": [{"path": "../x", "sha256": "a" * 64, "mode": 420, "mtime": 0}]},
        },
        {"parent": None, "entries": {"files": [], "dirs": ["/abs"]}},
        [],
    ],
)
def test_a_malformed_checkpoint_is_refused(claimed, body):
    _run, token = claimed
    response = Client().put(
        "/checkpoint", json.dumps(body), content_type="application/json", headers=auth(token)
    )
    assert (response.status_code, response.json()["error"]["code"]) == (400, "invalid_manifest")


def test_a_checkpoint_is_limited_in_size_and_entries(claimed, tmp_path, monkeypatch):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"x" * 5000, run=run)
    monkeypatch.setattr(config(), "files_folder_bytes", 8192)
    # Two files of 5,000 bytes take two pages each.
    status, body = put_checkpoint(token, None, entry("a", b"x" * 5000), entry("b", b"x" * 5000))
    assert (status, body["error"]["code"], body["error"]["limit"]) == (413, "quota", "folder_bytes")
    monkeypatch.setattr(config(), "files_folder_entries", 2)
    status, body = put_checkpoint(token, None, entry("d/e/f", b"x" * 5000))
    assert (status, body["error"]["limit"]) == (413, "folder_entries")
    assert put_checkpoint(token, None, entry("d/f", b"x" * 5000))[0] == 200


def test_a_checkpoint_records_what_the_worker_left_out(claimed, tmp_path):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    # The worker shows a control character in a name as U+FFFD.
    items = [{"path": "link", "reason": "symlink"}, {"path": "a\ufffdb", "reason": "invalid_name"}]
    left_out = {"total": 3, "items": items}
    status, body = put_checkpoint(token, None, entry("a", b"one"), warnings=left_out)
    assert status == 200
    assert reload(run).folder_warnings == left_out
    # The same folder with less left out is the same version, with the new warnings.
    version = body["version"]
    assert put_checkpoint(token, version, entry("a", b"one"), warnings={"total": 0, "items": []}) == (
        200,
        {"version": version},
    )
    assert reload(run).folder_warnings == {"total": 0, "items": []}
    # A checkpoint without warnings leaves them as they were.
    assert put_checkpoint(token, version, entry("a", b"one"))[0] == 200
    assert reload(run).folder_warnings == {"total": 0, "items": []}


@pytest.mark.parametrize(
    "warnings",
    [
        [],
        {"total": 0},
        {"total": 0, "items": [], "more": 1},
        {"total": True, "items": []},
        {"total": 0, "items": [{"path": "a", "reason": "symlink"}]},
        {"total": 2**31, "items": []},
        {"total": 101, "items": [{"path": "a", "reason": "symlink"}] * 101},
        {"total": 1, "items": [{"path": "a", "reason": "deleted"}]},
        {"total": 1, "items": [{"path": "a", "reason": []}]},
        {"total": 1, "items": [{"path": "a", "reason": {}}]},
        {"total": 1, "items": [{"path": "a", "reason": "symlink", "size": 1}]},
        {"total": 1, "items": [{"path": "", "reason": "symlink"}]},
        {"total": 1, "items": [{"path": "a\nb", "reason": "symlink"}]},
        {"total": 1, "items": [{"path": "a" * 1025, "reason": "too_long"}]},
        {"total": 1, "items": [{"path": 1, "reason": "symlink"}]},
    ],
)
def test_malformed_warnings_refuse_the_checkpoint(claimed, warnings):
    run, token = claimed
    status, body = put_checkpoint(token, None, warnings=warnings)
    assert (status, body["error"]["code"]) == (400, "invalid_manifest")
    run = reload(run)
    assert (run.checkpoint_id, run.folder_warnings) == (None, None)


def test_an_earlier_attempt_cannot_checkpoint(claimed, tmp_path):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    _status, body = put_checkpoint(token, None, entry("a", b"one"))
    services.restart(run.id, 1)
    with pytest.raises(folder.CheckpointRefused) as refused:
        folder.checkpoint(run.id, 1, body["version"], {"files": [], "dirs": []})
    assert refused.value.code == "stale"
    # The new attempt hydrates the checkpoint and builds on it.
    assert folder.checkpoint(run.id, 2, reload(run).checkpoint_id, {"files": [], "dirs": []}) is not None


def test_a_run_keeps_only_its_last_checkpoint(claimed, tmp_path, user):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    _, body = put_checkpoint(token, None, entry("a", b"one"))
    services.complete(run.id, "Done.", attempt=1)
    base = body["version"]
    conversation = Conversation.unscoped.get(pk=run.conversation_id)
    services.start_run(conversation=conversation, user_id=user.id, content="Again")
    [(second, token)] = services.claim_queued(1)
    put(tmp_path, run.workspace_id, b"two", run=second)

    parent = base
    for entries in ([entry("a", b"one"), entry("b", b"two")], [entry("b", b"two")], [entry("a", b"one")]):
        status, body = put_checkpoint(token, parent, *entries)
        assert status == 200
        parent = body["version"]
    [last] = FolderVersion.unscoped.filter(run=second)
    assert (str(last.id), last.kind, str(last.parent_id)) == (parent, "checkpoint", base)
    # What the replaced checkpoints held stays readable: it is the base version's, or uploaded by the run.
    assert folder.unreadable(reload(second), {sha(b"one"), sha(b"two")}) == []
    assert put_checkpoint(token, parent, entry("b", b"two"))[0] == 200

    # A new attempt starts from the last one.
    _, token = services.restart(second.id, 1)
    spec = Client().get("/run", headers=auth(token)).json()
    assert spec["folder"]["version"] == str(reload(second).checkpoint_id)
    assert [file["path"] for file in spec["folder"]["files"]] == ["b"]
    assert FolderVersion.unscoped.filter(run=second).count() == 1


# Ending and starting runs


def finish_failed(run):
    services.finish(run.id, Run.Status.FAILED, code="worker_failed", message="Failed.")


def finish_timed_out(run):
    services.finish(run.id, Run.Status.TIMED_OUT, code="timed_out", message="Too long.")


@pytest.mark.parametrize(
    "end",
    [
        lambda run: services.complete(run.id, "Done.", attempt=run.attempt),
        services.cancel,
        finish_failed,
        finish_timed_out,
        lambda run: services.revoke_active_runs(user_id=run.user_id, reason="permissions_changed"),
    ],
    ids=["complete", "cancel", "fail", "time out", "revoke"],
)
def test_every_way_a_run_ends_publishes_its_last_checkpoint(claimed, tmp_path, end):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    put(tmp_path, run.workspace_id, b"two", run=run)
    _, first = put_checkpoint(token, None, entry("a", b"one"))
    _, last = put_checkpoint(token, first["version"], entry("a", b"two"))
    end(reload(run))

    run = reload(run)
    assert not run.is_active
    assert run.result_version_id == run.checkpoint_id == FolderVersion.unscoped.get(pk=last["version"]).pk
    published = run.result_version
    assert (published.kind, published.parent_id) == ("turn", None)
    assert Conversation.unscoped.get(pk=run.conversation_id).folder_id == published.pk
    # No checkpoint after the run ended.
    status, _ = put_checkpoint(token, published.pk, entry("a", b"one"))
    assert status == 401
    with pytest.raises(folder.CheckpointRefused):
        folder.checkpoint(run.id, run.attempt, published.pk, {"files": [], "dirs": []})


def test_the_next_run_starts_from_the_published_folder(claimed, tmp_path, user):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    _, body = put_checkpoint(token, None, entry("a", b"one"))
    services.complete(run.id, "Done.", attempt=1)
    published = body["version"]

    conversation = Conversation.unscoped.get(pk=run.conversation_id)
    _, second = services.start_run(conversation=conversation, user_id=user.id, content="Again")
    assert str(second.base_version_id) == published
    [(second, second_token)] = services.claim_queued(1)
    spec = Client().get("/run", headers=auth(second_token)).json()
    assert spec["folder"]["version"] == published
    assert spec["folder"]["files"] == [
        {"path": "a", "sha256": sha(b"one"), "size": 3, "mode": 0o644, "mtime": 0}
    ]
    # It may read its base version's blobs, but has uploaded nothing.
    response = Client().get(f"/blobs/{sha(b'one')}", headers=auth(second_token))
    assert async_to_sync(read_all)(response) == b"one"

    # A run that changes nothing publishes the version it started from.
    services.cancel(second)
    second = reload(second)
    assert str(second.result_version_id) == published
    assert str(Conversation.unscoped.get(pk=run.conversation_id).folder_id) == published
    assert FolderVersion.unscoped.get(pk=published).kind == "turn"

    # A checkpoint on top of the base version becomes a turn whose parent is that base.
    _, third = services.start_run(conversation=conversation, user_id=user.id, content="Once more")
    [(third, third_token)] = services.claim_queued(1)
    status, body = put_checkpoint(third_token, published)
    assert status == 200
    services.complete(third.id, "Emptied.", attempt=1)
    result = reload(third).result_version
    assert (result.kind, str(result.parent_id), result.file_count) == ("turn", published, 0)


def test_a_run_without_files_publishes_nothing(claimed):
    run, token = claimed
    assert put_checkpoint(token, None) == (200, {"version": None})
    services.complete(run.id, "Done.", attempt=1)
    run = reload(run)
    assert run.result_version_id is None
    assert Conversation.unscoped.get(pk=run.conversation_id).folder_id is None


def test_a_checkpoint_waiting_for_the_run_lock_is_refused_once_the_run_ended(claimed, tmp_path):
    run, _token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    with transaction.atomic():
        Run.unscoped.select_for_update().get(pk=run.id)
        waiting = Background(folder.checkpoint, run.id, 1, None, {"files": [entry("a", b"one")], "dirs": []})
        wait_until_blocked()
        services.cancel(reload(run))
    with pytest.raises(folder.CheckpointRefused) as refused:
        waiting.result()
    assert refused.value.code == "stale"
    assert reload(run).result_version_id is None


def test_a_run_ending_while_a_checkpoint_is_recorded_publishes_it(claimed, tmp_path):
    run, _token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    with transaction.atomic():
        version = folder.checkpoint(run.id, 1, None, {"files": [entry("a", b"one")], "dirs": []})
        ending = Background(services.cancel, reload(run))
        wait_until_blocked()
    assert ending.result() is True
    assert reload(run).result_version_id == version.pk


def test_a_run_reads_its_base_and_uploads_whatever_its_checkpoints_drop(claimed, tmp_path, user):
    run, token = claimed
    put(tmp_path, run.workspace_id, b"one", run=run)
    _, body = put_checkpoint(token, None, entry("a", b"one"))
    services.complete(run.id, "Done.", attempt=1)
    conversation = Conversation.unscoped.get(pk=run.conversation_id)
    services.start_run(conversation=conversation, user_id=user.id, content="Again")
    [(second, second_token)] = services.claim_queued(1)
    put(tmp_path, run.workspace_id, b"two", run=second)

    # Empty the folder, then bring back the base version's file and the upload.
    _, emptied = put_checkpoint(second_token, body["version"])
    status, _ = put_checkpoint(second_token, emptied["version"], entry("a", b"one"), entry("b", b"two"))
    assert status == 200
    assert folder.unreadable(reload(second), {sha(b"one"), sha(b"two"), sha(b"three")}) == [sha(b"three")]
    assert folder.unreadable(reload(second), {sha(b"one")}) == []
    assert folder.unreadable(reload(second), {sha(b"three")}) == [sha(b"three")]
