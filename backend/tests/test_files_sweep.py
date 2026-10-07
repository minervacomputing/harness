import os
import time
from datetime import timedelta

import boto3
import pytest
from django.core.management import call_command
from django.db import connection, transaction
from django.utils import timezone
from files_support import (
    Background,
    age,
    conversation_in,
    counted,
    make_due,
    manifest,
    put,
    run_in,
    stored_keys,
    version,
    wait_until_blocked,
)
from moto import mock_aws
from storages.backends.s3 import S3File

from conversations.models import Conversation
from files import reconcile, store, sweep
from files.models import Blob, FolderVersion, LooseObject, RunBlob, WorkspaceStorage
from runs.models import Run

pytestmark = pytest.mark.django_db(transaction=True)


def test_an_unused_blob_is_deleted_and_its_object_deleted_twice(tmp_path, files_storage, workspace):
    blob = put(tmp_path, workspace.id, b"hello")
    age(blob)
    removed = sweep.sweep()
    assert removed == {"checkpoints": 0, "grants": 0, "blobs": 1, "loose": 0}
    assert not Blob.unscoped.exists()
    assert counted(workspace) == 0
    assert stored_keys(files_storage) == []
    # Its directory held only it.
    assert list((files_storage / "blobs" / str(workspace.id)).iterdir()) == []
    loose = LooseObject.objects.get()
    assert (loose.key, loose.leases, loose.deletions) == (blob.storage_key, 1, 1)
    assert loose.delete_after > timezone.now() + timedelta(hours=23)

    # A write still in flight could have recreated it: it is deleted once more a day later.
    (files_storage / blob.storage_key).parent.mkdir()
    (files_storage / blob.storage_key).write_bytes(b"late")
    assert sweep.sweep()["loose"] == 0
    make_due()
    assert sweep.sweep()["loose"] == 1
    assert stored_keys(files_storage) == []
    assert not LooseObject.objects.exists()


def test_recent_and_named_blobs_are_kept(tmp_path, files_storage, workspace, user, other_user):
    conversation = conversation_in(workspace, user)
    run = run_in(conversation)
    recent = put(tmp_path, workspace.id, b"recent")
    named = put(tmp_path, workspace.id, b"named")
    granted = put(tmp_path, workspace.id, b"granted", run=run)
    # Named only by another workspace's version.
    unnamed = put(tmp_path, workspace.id, b"theirs")
    theirs = put(tmp_path, other_user.personal_workspace.id, b"theirs")
    version(conversation_in(other_user.personal_workspace, other_user), a=b"theirs")
    version(conversation, a=b"named")
    age(named, granted, unnamed, theirs)

    assert sweep.sweep()["blobs"] == 1
    assert set(Blob.unscoped.all()) == {recent, named, granted, theirs}

    # A grant lasts as long as its run.
    Run.unscoped.filter(pk=run.pk).update(status=Run.Status.COMPLETED)
    removed = sweep.sweep()
    assert (removed["grants"], removed["blobs"]) == (1, 1)
    assert not RunBlob.unscoped.exists()
    assert set(Blob.unscoped.all()) == {recent, named, theirs}
    assert counted(workspace) == len(b"recent") + len(b"named")


def test_unreferenced_checkpoints_of_finished_runs_are_deleted(tmp_path, workspace, user):
    conversation = conversation_in(workspace, user)
    finished = run_in(conversation, Run.Status.COMPLETED)
    active = run_in(conversation)
    put(tmp_path, workspace.id, b"hello")
    deleted = [
        version(conversation, "checkpoint", run=finished, a=b"hello"),
        version(conversation, "checkpoint", a=b"hello"),
    ]
    of_active_run = version(conversation, "checkpoint", run=active, a=b"hello")
    run_checkpoint = version(conversation, "checkpoint", run=finished, a=b"hello")
    conversation_folder = version(conversation, "checkpoint", a=b"hello")
    turn = version(conversation, a=b"hello")
    Run.unscoped.filter(pk=finished.pk).update(checkpoint=run_checkpoint)
    Conversation.unscoped.filter(pk=conversation.pk).update(folder=conversation_folder)

    assert sweep.sweep()["checkpoints"] == len(deleted)
    assert set(FolderVersion.unscoped.all()) == {of_active_run, run_checkpoint, conversation_folder, turn}


def test_referenced_rows_do_not_hold_up_the_rest(tmp_path, workspace, user, monkeypatch):
    monkeypatch.setattr(sweep, "BATCH", 2)
    conversation = conversation_in(workspace, user)
    finished = run_in(conversation, Run.Status.COMPLETED)
    named = [put(tmp_path, workspace.id, data) for data in (b"a", b"b", b"c")]
    checkpoints = [version(conversation, "checkpoint", **{name: name.encode()}) for name in "abc"]
    Run.unscoped.filter(pk=finished.pk).update(
        base_version=checkpoints[0], checkpoint=checkpoints[1], result_version=checkpoints[2]
    )
    # Unused for longer than the others, so first in line, and never deletable.
    age(*named, hours=5)
    unnamed = [put(tmp_path, workspace.id, data) for data in (b"d", b"e", b"f", b"g", b"h")]
    age(*unnamed)
    unreferenced = [version(conversation, "checkpoint") for _ in range(3)]

    removed = sweep.sweep()
    assert (removed["checkpoints"], removed["blobs"]) == (len(unreferenced), len(unnamed))
    assert set(Blob.unscoped.all()) == set(named)
    assert set(FolderVersion.unscoped.all()) == set(checkpoints)


def test_a_version_waiting_for_the_sweep_does_not_name_a_deleted_blob(tmp_path, workspace, user, monkeypatch):
    conversation = conversation_in(workspace, user)
    age(put(tmp_path, workspace.id, b"hello"))
    # The sweep stops between locking the blobs and deleting them, until we let it go on.
    monkeypatch.setattr(sweep, "LOCK_COUNTERS", "SELECT pg_advisory_xact_lock(4242), %s::uuid[]")
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_lock(4242)")
        sweeping = Background(sweep.sweep)
        wait_until_blocked()
        recording = Background(version, conversation, a=b"hello")
        wait_until_blocked(2)
        cursor.execute("SELECT pg_advisory_unlock(4242)")
    assert sweeping.result()["blobs"] == 1
    with pytest.raises(store.UnknownBlob):
        recording.result()
    assert not FolderVersion.unscoped.exists()


def test_the_sweep_checks_references_again_once_it_holds_the_locks(tmp_path, workspace, user, monkeypatch):
    conversation = conversation_in(workspace, user)
    blob = put(tmp_path, workspace.id, b"hello")
    age(blob)
    monkeypatch.setattr(sweep, "LOCK_COUNTERS", "SELECT pg_advisory_xact_lock(4242), %s::uuid[]")
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_lock(4242)")
        sweeping = Background(sweep.sweep)
        wait_until_blocked()
        # A reference that commits after the sweep chose the blob, without taking the blob's lock.
        FolderVersion.unscoped.create(
            workspace_id=workspace.id,
            conversation=conversation,
            kind=FolderVersion.Kind.TURN,
            entries={
                "files": {"a": {"sha256": blob.sha256, "size": 5, "mode": 0o644, "mtime": 0}},
                "dirs": [],
            },
            hashes=[blob.sha256],
            digest="0" * 64,
            size=4096,
            file_count=1,
        )
        cursor.execute("SELECT pg_advisory_unlock(4242)")
    assert sweeping.result()["blobs"] == 0
    assert Blob.unscoped.exists()


def test_the_sweep_passes_over_a_blob_being_named(tmp_path, workspace, user):
    conversation = conversation_in(workspace, user)
    age(put(tmp_path, workspace.id, b"hello"))
    with transaction.atomic():
        store.record_version(conversation, "turn", manifest(a=b"hello"))
        assert Background(sweep.sweep).result()["blobs"] == 0
    assert sweep.sweep()["blobs"] == 0
    assert Blob.unscoped.exists()


def test_the_sweep_does_not_wait_for_a_locked_counter(tmp_path, workspace):
    age(put(tmp_path, workspace.id, b"hello"))
    with transaction.atomic():
        WorkspaceStorage.objects.select_for_update().get(workspace=workspace)
        started = time.monotonic()
        assert Background(sweep.sweep).result()["blobs"] == 0
        assert time.monotonic() - started < 2
    assert sweep.sweep()["blobs"] == 1


def test_an_object_that_cannot_be_deleted_stays_queued(tmp_path, files_storage, workspace, monkeypatch):
    blob = put(tmp_path, workspace.id, b"hello")
    age(blob)
    storage = store.storage()

    def refuse(name):
        raise OSError("storage unavailable")

    monkeypatch.setattr(storage, "delete", refuse)
    assert sweep.sweep()["blobs"] == 1
    loose = LooseObject.objects.get()
    assert (loose.leases, loose.deletions) == (1, 0)
    assert stored_keys(files_storage) == [blob.storage_key]

    monkeypatch.undo()
    make_due()
    sweep.sweep()
    assert LooseObject.objects.get().deletions == 1
    assert stored_keys(files_storage) == []


def test_a_sweep_whose_lease_ran_out_leaves_the_row_alone():
    LooseObject.objects.create(key="blobs/x", delete_after=timezone.now(), leases=2)
    sweep._finish("blobs/x", 1)
    assert LooseObject.objects.filter(key="blobs/x").exists()
    sweep._finish("blobs/x", 2)
    assert not LooseObject.objects.exists()


def test_a_loose_row_for_an_object_a_blob_names_does_not_delete_it(tmp_path, files_storage, workspace):
    blob = put(tmp_path, workspace.id, b"hello")
    LooseObject.objects.create(key=blob.storage_key, delete_after=timezone.now())
    make_due()
    sweep.sweep()
    assert stored_keys(files_storage) == [blob.storage_key]
    assert not LooseObject.objects.exists()


def test_the_sweep_refuses_a_transaction():
    with transaction.atomic(), pytest.raises(RuntimeError):
        sweep.sweep()


# Reconciliation


def test_reconcile_corrects_the_counters(tmp_path, workspace, other_user):
    theirs = other_user.personal_workspace
    put(tmp_path, workspace.id, b"hello")
    put(tmp_path, theirs.id, b"abc")
    WorkspaceStorage.objects.filter(workspace=workspace).update(bytes=99)
    WorkspaceStorage.objects.filter(workspace=theirs).delete()
    assert reconcile.counters() == 2
    assert (counted(workspace), counted(theirs)) == (5, 3)
    assert reconcile.counters() == 0


def test_reconcile_deletes_old_objects_no_row_names(tmp_path, files_storage, workspace, capsys):
    named = put(tmp_path, workspace.id, b"hello")
    queued = LooseObject.objects.create(key="blobs/queued", delete_after=timezone.now() + timedelta(hours=1))
    two_days_ago = time.time() - 2 * 86400
    for key in ("blobs/queued", "blobs/a/b/untracked", "blobs/young"):
        path = files_storage / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    for key in (named.storage_key, queued.key, "blobs/a/b/untracked"):
        os.utime(files_storage / key, (two_days_ago, two_days_ago))

    call_command("files_reconcile", "--storage")
    assert "Untracked objects deleted: 1" in capsys.readouterr().out
    assert stored_keys(files_storage) == sorted([named.storage_key, "blobs/queued", "blobs/young"])


@pytest.fixture
def s3(settings):
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="minerva-files")
        settings.STORAGES = {
            **settings.STORAGES,
            "files": {
                "BACKEND": "storages.backends.s3.S3Storage",
                "OPTIONS": {
                    "bucket_name": "minerva-files",
                    "region_name": "us-east-1",
                    "access_key": "test",
                    "secret_key": "test",
                    "file_overwrite": True,
                },
            },
        }
        yield boto3.resource("s3", region_name="us-east-1").Bucket("minerva-files")


def test_s3_storage(tmp_path, workspace, s3, monkeypatch):
    def keys():
        return sorted(summary.key for summary in s3.objects.all())

    blob = put(tmp_path, workspace.id, b"hello")
    assert keys() == [blob.storage_key]
    with store.open_blob(blob) as stored:
        assert stored.read() == b"hello"

    s3.put_object(Key="blobs/untracked", Body=b"x")
    monkeypatch.setattr(reconcile, "UNTRACKED_AGE", timedelta(0))
    assert reconcile.untracked_objects() == 1
    assert keys() == [blob.storage_key]

    age(blob)
    sweep.sweep()
    assert keys() == []
    assert LooseObject.objects.get().deletions == 1


def test_s3_downloads_stream(tmp_path, workspace, s3):
    data = os.urandom(3 * 1024 * 1024)
    blob = put(tmp_path, workspace.id, data)
    with store.open_blob(blob) as stored:
        # The response body, read as it arrives: an S3File downloads the whole object on its first read.
        assert not isinstance(stored, S3File)
        assert stored.read(1024) == data[:1024]
        assert stored.read() == data[1024:]
