import asyncio
import json
import tempfile
from datetime import timedelta
from urllib.parse import quote

import pytest
from asgiref.sync import sync_to_async
from django.middleware.csrf import _get_new_csrf_string
from django.test import AsyncClient, Client
from django.utils import timezone
from files_support import age, conversation_in, put, sha, version
from test_gateway_auth import Upload as Request

from conversations.models import Message
from files import limits, runs, sweep, upload_app, uploads
from files.models import Blob, FolderVersion, Upload
from minerva import asgi
from runs import services
from runs.models import Run

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def temp_dir(tmp_path, monkeypatch):
    """Where uploads stream to, so a test can check nothing is left behind."""
    directory = tmp_path / "uploads"
    directory.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(directory))
    return directory


def session(user) -> list[tuple[bytes, bytes]]:
    """A signed-in browser's headers: session and CSRF cookies, and the token."""
    client = Client()
    client.force_login(user)
    token = _get_new_csrf_string()
    cookie = f"sessionid={client.cookies['sessionid'].value}; csrftoken={token}"
    return [(b"cookie", cookie.encode()), (b"x-csrftoken", token.encode())]


def upload_request(workspace, headers, data: bytes, name: str | None = "report.pdf", **scope) -> Request:
    request = Request(headers, method="POST", path=f"/api/workspaces/{workspace.id}/uploads", body=data)
    if name is not None:
        request.scope["query_string"] = f"name={quote(name)}".encode()
    request.scope.update(scope)
    return request


async def send_upload(workspace, user, data: bytes, name: str = "report.pdf") -> Request:
    headers = await sync_to_async(session)(user)
    request = upload_request(workspace, headers, data, name)
    await request.answer(asgi.application)
    return request


def stored_upload(tmp_path, workspace, user, data: bytes, name: str = "notes.txt") -> Upload:
    path = tmp_path / f"upload-{sha(data)}-{name}"
    path.write_bytes(data)
    return uploads.record_upload(
        workspace.id,
        user.id,
        name=name,
        media_type=uploads.sniff(data, name),
        path=str(path),
        sha256=sha(data),
        size=len(data),
    )


# Names and types


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("report.pdf", "report.pdf"),
        ("C:\\Users\\ada\\report.pdf", "report.pdf"),
        ("../../etc/passwd", "passwd"),
        ("..", "file"),
        ("  ", "file"),
        ("evil\u202egnp.exe", "evilgnp.exe"),
        ("a\nb.txt", "ab.txt"),
        ("Cafe\u0301.txt", "Café.txt"),
        ("x" * 300 + ".txt", "x" * 251 + ".txt"),
    ],
)
def test_a_file_name_is_cleaned(raw, clean):
    assert uploads.clean_name(raw) == clean


def test_a_taken_name_is_numbered_before_its_extension():
    assert uploads.numbered("a.txt", set()) == "a.txt"
    assert uploads.numbered("a.txt", {"a.txt", "a (2).txt"}) == "a (3).txt"
    assert uploads.numbered("archive.tar.gz", {"archive.tar.gz"}) == "archive.tar (2).gz"
    assert uploads.numbered("README", {"README"}) == "README (2)"
    long = "x" * 251 + ".txt"
    assert uploads.numbered(long, {long}) == "x" * 247 + " (2).txt"


@pytest.mark.parametrize(
    ("head", "name", "media_type"),
    [
        (b"%PDF-1.7", "a.txt", "application/pdf"),
        (b"\x89PNG\r\n\x1a\n", "a.pdf", "image/png"),
        (b"PK\x03\x04", "a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        (b"PK\x03\x04", "a.zip", "application/zip"),
        (b"a,b\n1,2\n", "a.csv", "text/csv"),
        ("zażółć".encode()[:-1], "a.txt", "text/plain"),
        (b"a\0b", "a.txt", "application/octet-stream"),
        (b"<html><script>", "a.html", "text/plain"),
    ],
)
def test_the_media_type_comes_from_the_contents(head, name, media_type):
    assert uploads.sniff(head, name) == media_type


# Uploading


async def test_an_upload_streams_to_the_store_and_is_recorded(user, workspace, temp_dir):
    request = await send_upload(workspace, user, b"%PDF-1.7 hello", name="../Q3 report.pdf")
    assert request.status == 201
    body = json.loads(request.body)
    stored = await Upload.unscoped.select_related("blob").aget()
    assert body == {
        "id": str(stored.pk),
        "name": "Q3 report.pdf",
        "size": 14,
        "media_type": "application/pdf",
    }
    assert (stored.user_id, stored.workspace_id, stored.blob.sha256) == (
        user.id,
        workspace.id,
        sha(b"%PDF-1.7 hello"),
    )
    assert list(temp_dir.iterdir()) == []


async def test_an_upload_is_refused_before_its_body_is_read(user, other_user, workspace, temp_dir):
    signed_in = await sync_to_async(session)(user)
    stranger = await sync_to_async(session)(other_user)
    cases = [
        ([], {}, 401),
        ([h for h in signed_in if h[0] != b"x-csrftoken"], {}, 403),
        ([*signed_in, (b"origin", b"https://evil.example")], {}, 403),
        (stranger, {}, 401),
        (signed_in, {"method": "PUT"}, 405),
    ]
    for headers, scope, status in cases:
        request = upload_request(workspace, headers, b"x" * 200_000, **scope)
        assert await request.answer(asgi.application) == status, (headers, scope)
        assert request.reads == 0
    assert not await Upload.unscoped.aexists()
    assert list(temp_dir.iterdir()) == []


async def test_a_file_over_the_limit_or_without_a_name_is_refused(user, workspace, temp_dir, monkeypatch):
    monkeypatch.setattr(limits, "upload_bytes", lambda: 10)
    headers = await sync_to_async(session)(user)
    too_large = upload_request(workspace, headers, b"x" * 11)
    assert await too_large.answer(asgi.application) == 413
    assert too_large.reads == 0
    assert await upload_request(workspace, headers, b"x", name=None).answer(asgi.application) == 400
    short = upload_request(workspace, headers, b"hello")
    short.scope["headers"] = [h for h in short.scope["headers"] if h[0] != b"content-length"]
    short.scope["headers"].append((b"content-length", b"6"))
    assert await short.answer(asgi.application) == 400
    assert not await Upload.unscoped.aexists()
    assert list(temp_dir.iterdir()) == []


async def test_uploads_waiting_to_be_sent_are_capped(user, workspace, temp_dir, monkeypatch):
    monkeypatch.setattr(uploads, "PENDING_UPLOADS", 2)
    assert (await send_upload(workspace, user, b"one")).status == 201
    assert (await send_upload(workspace, user, b"two")).status == 201
    assert (await send_upload(workspace, user, b"three")).status == 429
    assert await Upload.unscoped.acount() == 2
    assert list(temp_dir.iterdir()) == []


async def test_a_user_has_few_uploads_in_flight(user, workspace, temp_dir, monkeypatch):
    monkeypatch.setattr(upload_app, "UPLOADS_PER_USER", 1)
    headers = await sync_to_async(session)(user)
    slow = upload_request(workspace, headers, b"x" * 200_000)
    slow.flowing.clear()
    task = slow.start(asgi.application)
    await asyncio.wait_for(slow.read.wait(), 5)
    second = upload_request(workspace, headers, b"y")
    assert await second.answer(asgi.application) == 429
    slow.flowing.set()
    await asyncio.wait_for(task, 10)
    assert slow.status == 201


async def test_an_upload_that_stalls_is_refused(user, workspace, temp_dir, monkeypatch):
    monkeypatch.setattr(upload_app, "IDLE_SECONDS", 0.2)
    headers = await sync_to_async(session)(user)
    stalled = upload_request(workspace, headers, b"x" * 200_000)
    stalled.flowing.clear()
    assert await asyncio.wait_for(stalled.answer(asgi.application), 10) == 408
    assert not await Upload.unscoped.aexists()
    assert list(temp_dir.iterdir()) == []


def test_an_upload_can_be_removed_by_its_owner_only(tmp_path, user, other_user, workspace, api):
    upload = stored_upload(tmp_path, workspace, user, b"hello")
    url = f"/api/workspaces/{workspace.id}/uploads/{upload.pk}"
    other = Client()
    other.force_login(other_user)
    assert other.delete(url).status_code == 401
    assert api.delete(url).status_code == 204
    assert not Upload.unscoped.exists()


def test_other_requests_with_large_bodies_are_refused_before_django_reads_them():
    request = Request([], method="POST", path="/api/workspaces", body=b"x" * 3_000_000)
    asyncio.run(request.answer(asgi.application))
    assert request.status == 413
    assert json.loads(request.body) == {"detail": "The request is too large."}


# Attaching


def post(api, conversation, content="", attachments=()):
    return api.post(
        f"/api/workspaces/{conversation.workspace_id}/conversations/{conversation.pk}/messages",
        {"content": content, "attachments": [str(a) for a in attachments]},
        content_type="application/json",
    )


def test_attachments_are_added_to_the_folder_the_run_starts_from(tmp_path, user, workspace, api):
    conversation = conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"old")
    first = version(conversation, **{"notes.txt": b"old"})
    conversation.folder = first
    conversation.save(update_fields=["folder"])
    a = stored_upload(tmp_path, workspace, user, b"new notes", name="notes.txt")
    b = stored_upload(tmp_path, workspace, user, b"a,b\n", name="data.csv")

    response = post(api, conversation, attachments=[a.pk, b.pk])
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["message"]["attachments"] == [
        {"path": "notes (2).txt", "size": 9, "media_type": "text/plain"},
        {"path": "data.csv", "size": 4, "media_type": "text/csv"},
    ]
    run = Run.unscoped.get()
    assert body["run"]["base_version_id"] == str(run.base_version_id)
    base = run.base_version
    assert (base.kind, base.parent_id, base.run_id) == (FolderVersion.Kind.BASE, first.pk, run.pk)
    assert {path: e["sha256"] for path, e in base.entries["files"].items()} == {
        "notes.txt": sha(b"old"),
        "notes (2).txt": sha(b"new notes"),
        "data.csv": sha(b"a,b\n"),
    }
    assert not Upload.unscoped.exists()
    assert Message.unscoped.get(role="user").content == ""
    conversation.refresh_from_db()
    assert conversation.title == "notes (2).txt, data.csv"
    assert (
        services.current_prompt(run)
        == "[The user attached notes (2).txt, data.csv to this message, in your folder.]"
    )


def test_attachments_that_cannot_be_added_leave_nothing(
    tmp_path, user, other_user, workspace, api, monkeypatch
):
    conversation = conversation_in(workspace, user)
    theirs = stored_upload(tmp_path, other_user.personal_workspace, other_user, b"theirs")
    mine = stored_upload(tmp_path, workspace, user, b"mine")

    assert post(api, conversation).status_code == 400
    assert post(api, conversation, "hi", [theirs.pk]).status_code == 400
    assert post(api, conversation, "hi", [mine.pk, mine.pk]).status_code == 400
    monkeypatch.setattr(limits, "folder_bytes", lambda: 3)
    response = post(api, conversation, "hi", [mine.pk])
    assert response.status_code == 413
    assert "larger than" in response.json()["detail"]
    assert not Run.unscoped.exists()
    assert not Message.unscoped.exists()
    assert Upload.unscoped.filter(pk=mine.pk).exists()


def test_a_message_without_attachments_starts_from_the_folder(tmp_path, user, workspace, api):
    conversation = conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"old")
    first = version(conversation, **{"notes.txt": b"old"})
    conversation.folder = first
    conversation.save(update_fields=["folder"])
    assert post(api, conversation, "hi").status_code == 201
    assert Run.unscoped.get().base_version_id == first.pk
    assert FolderVersion.unscoped.count() == 1


# What a turn changed


def test_a_turns_changes_list_files_and_directories():
    def entries(files, dirs=()):
        return {
            "files": {p: {"sha256": s, "mode": m, "size": 1} for p, (s, m) in files.items()},
            "dirs": list(dirs),
        }

    before = entries(
        {"a.txt": ("1", 0o644), "b.txt": ("2", 0o644), "sub/c.txt": ("3", 0o644)}, ["empty/inner"]
    )
    after = entries({"a.txt": ("1", 0o755), "b.txt": ("2", 0o644), "new/deep/d.txt": ("4", 0o644)}, ["x/y"])
    assert runs.folder_changes(before, after) == {
        "counts": {"added": 1, "modified": 1, "deleted": 1, "dirs_added": 4, "dirs_deleted": 3},
        "added": [{"path": "new/deep/d.txt", "size": 1}],
        "modified": [{"path": "a.txt", "size": 1}],
        "deleted": [{"path": "sub/c.txt", "size": 1}],
        "dirs_added": ["new", "new/deep", "x", "x/y"],
        "dirs_deleted": ["empty", "empty/inner", "sub"],
    }
    assert runs.folder_changes(after, after) is None


# Reading the folder


@pytest.fixture
def folder(tmp_path, user, workspace):
    conversation = conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"<script>alert(1)</script>")
    current = version(conversation, **{"zażółć report.html": b"<script>alert(1)</script>"})
    conversation.folder = current
    conversation.save(update_fields=["folder"])
    return conversation, current


def test_the_folder_is_listed_for_its_owner(folder, other_user, api):
    conversation, current = folder
    url = f"/api/workspaces/{conversation.workspace_id}/conversations/{conversation.pk}/files"
    body = api.get(url).json()
    assert body == {
        "version_id": str(current.pk),
        "files": [{"path": "zażółć report.html", "size": 25, "mtime": 0}],
        "dirs": [],
    }
    assert api.get(url, {"version": str(current.pk)}).json() == body
    elsewhere = version(conversation_in(conversation.workspace, conversation.user))
    assert api.get(url, {"version": str(elsewhere.pk)}).status_code == 404
    other = Client()
    other.force_login(other_user)
    assert other.get(url).status_code == 401


async def test_a_file_downloads_as_an_attachment_that_cannot_run(folder, user, other_user):
    conversation, _ = folder
    url = f"/api/workspaces/{conversation.workspace_id}/conversations/{conversation.pk}/files/download"
    client = AsyncClient()
    await sync_to_async(client.force_login)(user)
    response = await client.get(url, {"path": "zażółć report.html"})
    assert response.status_code == 200
    assert b"".join([chunk async for chunk in response.streaming_content]) == b"<script>alert(1)</script>"
    assert response["Content-Type"] == "application/octet-stream"
    assert response["Content-Length"] == "25"
    assert response["Content-Disposition"] == (
        "attachment; filename*=utf-8''za%C5%BC%C3%B3%C5%82%C4%87%20report.html"
    )
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Content-Security-Policy"] == "sandbox"
    assert response["Cache-Control"] == "private, no-store"

    assert (await client.get(url, {"path": "missing.txt"})).status_code == 404
    assert (await client.get(url, {"path": "zażółć report.html", "version": "nope"})).status_code == 404
    other = AsyncClient()
    await sync_to_async(other.force_login)(other_user)
    assert (await other.get(url, {"path": "zażółć report.html"})).status_code == 404
    assert (await AsyncClient().get(url, {"path": "zażółć report.html"})).status_code == 401


# Expiry


def test_an_upload_names_its_blob_until_it_expires(tmp_path, user, workspace):
    upload = stored_upload(tmp_path, workspace, user, b"hello")
    age(upload.blob)
    assert sweep.sweep()["blobs"] == 0
    Upload.unscoped.filter(pk=upload.pk).update(created_at=timezone.now() - timedelta(days=2))
    removed = sweep.sweep()
    assert (removed["uploads"], removed["blobs"]) == (1, 1)
    assert not Blob.unscoped.exists()


def test_an_attached_upload_is_named_by_the_base_version(tmp_path, user, workspace, scoped):
    conversation = conversation_in(workspace, user)
    upload = stored_upload(tmp_path, workspace, user, b"hello")
    services.start_run(conversation=conversation, user_id=user.id, content="", attachments=[upload.pk])
    age(Blob.unscoped.get())
    assert sweep.sweep()["blobs"] == 0
