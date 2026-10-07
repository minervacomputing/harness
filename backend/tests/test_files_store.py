from datetime import timedelta

import pytest
from django.db import DatabaseError, connection, transaction
from django.utils import timezone
from files_support import (
    Background,
    age,
    conversation_in,
    counted,
    manifest,
    put,
    run_in,
    sha,
    stored_keys,
    upload,
    version,
    wait_until_blocked,
)

from conversations.models import Conversation
from files import manifest as manifests
from files import store
from files.limits import QuotaExceeded
from files.models import Blob, BlobDeletionRefused, FolderVersion, LooseObject, RunBlob
from minerva.config import config
from runs.models import Run
from workspaces.models import Workspace
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db(transaction=True)


def uploaded(run: Run) -> int:
    return Run.unscoped.values_list("uploaded_bytes", flat=True).get(pk=run.pk)


def loose_keys() -> list[str]:
    return sorted(LooseObject.objects.values_list("key", flat=True))


# Uploads


def test_an_upload_stores_new_contents_and_charges_the_workspace_once(
    tmp_path, files_storage, workspace, user
):
    run = run_in(conversation_in(workspace, user))
    blob = put(tmp_path, workspace.id, b"hello", run=run)
    assert (blob.sha256, blob.size) == (sha(b"hello"), 5)
    assert blob.storage_key.startswith(f"blobs/{workspace.id}/{blob.sha256}/")
    assert stored_keys(files_storage) == [blob.storage_key]
    with store.open_blob(blob) as stored:
        assert stored.read() == b"hello"
    assert loose_keys() == []
    assert counted(workspace) == 5
    assert RunBlob.unscoped.filter(run=run, blob=blob).exists()
    assert uploaded(run) == 5

    # The same contents again: no new object or charge to the workspace, but the run pays for the upload.
    again = put(tmp_path, workspace.id, b"hello", run=run)
    assert again.pk == blob.pk
    assert stored_keys(files_storage) == [blob.storage_key]
    assert counted(workspace) == 5
    assert uploaded(run) == 10
    assert RunBlob.unscoped.filter(run=run).count() == 1


def test_workspaces_do_not_share_contents(tmp_path, files_storage, workspace, other_user):
    ours = put(tmp_path, workspace.id, b"hello")
    theirs = put(tmp_path, other_user.personal_workspace.id, b"hello")
    assert ours.pk != theirs.pk
    assert stored_keys(files_storage) == sorted([ours.storage_key, theirs.storage_key])
    assert counted(workspace) == counted(other_user.personal_workspace) == 5


def test_store_blob_refuses_a_transaction_and_a_wrong_size(tmp_path, files_storage, workspace):
    with transaction.atomic(), pytest.raises(RuntimeError):
        put(tmp_path, workspace.id, b"hello")
    with pytest.raises(ValueError):
        store.store_blob(workspace.id, sha(b"hello"), 4, upload(tmp_path, b"hello"), lambda record: record())
    assert stored_keys(files_storage) == []
    assert loose_keys() == []


def test_a_failed_upload_deletes_its_object(tmp_path, files_storage, workspace):
    def transact(record):
        raise LookupError

    with pytest.raises(LookupError):
        store.store_blob(workspace.id, sha(b"hello"), 5, upload(tmp_path, b"hello"), transact)
    assert stored_keys(files_storage) == []
    assert loose_keys() == []
    assert not Blob.unscoped.exists()


def test_once_a_row_named_the_object_a_failure_leaves_it_to_the_sweep(tmp_path, files_storage, workspace):
    def transact(record):
        record()
        record()

    with pytest.raises(RuntimeError):
        store.store_blob(workspace.id, sha(b"hello"), 5, upload(tmp_path, b"hello"), transact)
    assert not Blob.unscoped.exists()
    assert counted(workspace) is None
    # The claim rolled back with the blob, so the loose row queues the object for the sweep.
    assert loose_keys() == stored_keys(files_storage)
    assert len(loose_keys()) == 1


def test_the_workspace_limit_refuses_new_contents_only(tmp_path, files_storage, workspace, monkeypatch):
    monkeypatch.setattr(config(), "files_workspace_bytes", 10)
    with pytest.raises(QuotaExceeded) as refused:
        put(tmp_path, workspace.id, b"x" * 11)
    assert refused.value.limit == "workspace"
    assert counted(workspace) is None

    put(tmp_path, workspace.id, b"y" * 6)
    put(tmp_path, workspace.id, b"z" * 4)
    assert counted(workspace) == 10
    with pytest.raises(QuotaExceeded):
        put(tmp_path, workspace.id, b"!")
    put(tmp_path, workspace.id, b"y" * 6)
    assert counted(workspace) == 10
    assert Blob.unscoped.count() == 2
    assert len(stored_keys(files_storage)) == 2
    assert loose_keys() == []


def test_the_run_upload_limit_counts_every_upload(tmp_path, files_storage, workspace, user, monkeypatch):
    monkeypatch.setattr(config(), "files_run_upload_bytes", 8)
    run = run_in(conversation_in(workspace, user))
    put(tmp_path, workspace.id, b"hello", run=run)
    put(tmp_path, workspace.id, b"abc", run=run)
    for data in (b"!", b"hello"):
        with pytest.raises(QuotaExceeded) as refused:
            put(tmp_path, workspace.id, data, run=run)
        assert refused.value.limit == "run_uploads"
    assert uploaded(run) == 8
    assert counted(workspace) == 8
    assert len(stored_keys(files_storage)) == 2
    assert loose_keys() == []


def test_a_concurrent_upload_of_the_same_contents_is_not_charged(
    tmp_path, files_storage, workspace, monkeypatch
):
    # Room for one copy: charging the second upload would refuse it.
    monkeypatch.setattr(config(), "files_workspace_bytes", 5)
    racing = {}

    def start_second():
        racing["upload"] = Background(put, tmp_path, workspace.id, b"hello")
        # The second upload staged its own object and now waits for our uncommitted row.
        wait_until_blocked()

    first = put(tmp_path, workspace.id, b"hello", after=start_second)
    second = racing["upload"].result()
    assert second.pk == first.pk
    assert counted(workspace) == 5
    assert stored_keys(files_storage) == [first.storage_key]
    assert loose_keys() == []


def test_an_upload_retries_when_its_blob_is_deleted_before_it_records(tmp_path, files_storage, workspace):
    old = put(tmp_path, workspace.id, b"hello")
    calls = []

    def delete_old():
        calls.append(1)
        if len(calls) == 1:
            Background(_delete_blob, old.pk).result()

    blob = put(tmp_path, workspace.id, b"hello", before=delete_old)
    assert len(calls) == 2
    assert blob.pk != old.pk and blob.storage_key != old.storage_key
    assert counted(workspace) == 5
    # The deleted blob's object waits for the sweep.
    assert loose_keys() == [old.storage_key]
    assert stored_keys(files_storage) == sorted([old.storage_key, blob.storage_key])


def test_an_upload_cannot_claim_an_object_the_sweep_has_taken(tmp_path, files_storage, workspace):
    taken = []

    def sweep_takes_it():
        if not taken:
            [key] = loose_keys()
            taken.append(key)
            Background(lambda: LooseObject.objects.filter(key=key).update(leases=1)).result()

    blob = put(tmp_path, workspace.id, b"hello", before=sweep_takes_it)
    assert blob.storage_key != taken[0]
    assert stored_keys(files_storage) == [blob.storage_key]
    assert loose_keys() == []
    assert counted(workspace) == 5


def _delete_blob(pk) -> None:
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM files_blob WHERE id = %s", [pk])


# Versions


def test_a_version_records_the_sizes_of_its_files(tmp_path, workspace, user):
    conversation = conversation_in(workspace, user)
    age(put(tmp_path, workspace.id, b"hello"), put(tmp_path, workspace.id, b"x" * 5000))
    recorded = version(conversation, **{"a.txt": b"hello", "big.bin": b"x" * 5000})
    assert recorded.entries["files"]["a.txt"] == {
        "sha256": sha(b"hello"),
        "size": 5,
        "mode": 0o644,
        "mtime": 0,
    }
    assert recorded.entries["files"]["big.bin"]["size"] == 5000
    assert recorded.hashes == sorted([sha(b"hello"), sha(b"x" * 5000)])
    assert recorded.size == 4096 + 8192
    assert recorded.file_count == 2
    assert recorded.digest == manifests.digest(recorded.entries)
    # Naming the blobs marked them used.
    assert not Blob.unscoped.filter(last_used_at__lt=timezone.now() - timedelta(hours=1)).exists()


def test_a_version_needs_every_blob_in_its_own_workspace(tmp_path, workspace, user, other_user):
    conversation = conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"ours")
    put(tmp_path, other_user.personal_workspace.id, b"theirs")
    with pytest.raises(store.UnknownBlob) as unknown:
        version(conversation, ours=b"ours", theirs=b"theirs", missing=b"missing")
    assert unknown.value.hashes == sorted([sha(b"theirs"), sha(b"missing")])
    assert not FolderVersion.unscoped.exists()


def test_a_version_takes_the_sizes_of_files_it_keeps_from_its_parent(tmp_path, workspace, user):
    conversation = conversation_in(workspace, user)
    kept = put(tmp_path, workspace.id, b"kept")
    first = version(conversation, a=b"kept")
    put(tmp_path, workspace.id, b"new")
    age(kept)
    second = version(conversation, "checkpoint", parent=first, a=b"kept", b=b"new")
    assert second.parent_id == first.pk
    assert second.entries["files"]["a"]["size"] == 4
    # Only blobs new relative to the parent are looked up (and marked used).
    assert Blob.unscoped.get(pk=kept.pk).last_used_at < timezone.now() - timedelta(hours=1)


def test_a_version_refuses_a_parent_that_is_gone_or_elsewhere(tmp_path, workspace, user):
    conversation, elsewhere = conversation_in(workspace, user), conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"hello")
    foreign = version(elsewhere, a=b"hello")
    with pytest.raises(store.StaleParent):
        version(conversation, parent=foreign, a=b"hello")
    gone = version(conversation, a=b"hello")
    FolderVersion.unscoped.filter(pk=gone.pk).delete()
    with pytest.raises(store.StaleParent):
        version(conversation, parent=gone, a=b"hello")


def test_a_version_is_limited_in_size(tmp_path, workspace, user, monkeypatch):
    monkeypatch.setattr(config(), "files_folder_bytes", 4096)
    conversation = conversation_in(workspace, user)
    put(tmp_path, workspace.id, b"a")
    put(tmp_path, workspace.id, b"b")
    version(conversation, a=b"a")
    with pytest.raises(QuotaExceeded) as refused:
        version(conversation, a=b"a", b=b"b")
    assert refused.value.limit == "folder_bytes"


def test_record_version_checks_its_arguments(workspace, user):
    conversation, other = conversation_in(workspace, user), conversation_in(workspace, user)
    with pytest.raises(RuntimeError):
        store.record_version(conversation, "turn", manifest())
    with pytest.raises(ValueError):
        version(conversation, "draft")
    with pytest.raises(ValueError):
        version(conversation, run=run_in(other))
    assert version(conversation).size == 0


# Integrity


def test_blob_identity_and_version_contents_cannot_change(tmp_path, workspace, user):
    blob = put(tmp_path, workspace.id, b"hello")
    recorded = version(conversation_in(workspace, user), "checkpoint", a=b"hello")
    for column, value in (("size", 1), ("sha256", "0" * 64), ("storage_key", "elsewhere")):
        with pytest.raises(DatabaseError):
            Blob.unscoped.filter(pk=blob.pk).update(**{column: value})
    with pytest.raises(DatabaseError):
        FolderVersion.unscoped.filter(pk=recorded.pk).update(entries={"files": {}, "dirs": []})
    with pytest.raises(DatabaseError):
        FolderVersion.unscoped.filter(pk=recorded.pk).update(size=0)
    # What a version is used for may change: publishing a checkpoint turns it into a turn version.
    FolderVersion.unscoped.filter(pk=recorded.pk).update(kind=FolderVersion.Kind.TURN)


def test_blobs_cannot_be_deleted_through_the_orm(tmp_path, workspace):
    blob = put(tmp_path, workspace.id, b"hello")
    with pytest.raises(BlobDeletionRefused):
        blob.delete()
    with pytest.raises(BlobDeletionRefused):
        Blob.unscoped.all().delete()
    with workspace_scope(workspace.id), pytest.raises(BlobDeletionRefused):
        Blob.objects.all().delete()
    assert Blob.unscoped.exists()


def _referenced_versions(tmp_path, workspace, user) -> Conversation:
    """A conversation whose versions are referenced from the conversation and from its runs."""
    conversation = conversation_in(workspace, user)
    finished = run_in(conversation, Run.Status.COMPLETED)
    run = run_in(conversation)
    put(tmp_path, workspace.id, b"hello", run=run)
    base = version(conversation, a=b"hello")
    checkpoint = version(conversation, "checkpoint", parent=base, run=run, a=b"hello")
    Run.unscoped.filter(pk=finished.pk).update(base_version=base, result_version=checkpoint)
    Run.unscoped.filter(pk=run.pk).update(base_version=base, checkpoint=checkpoint)
    Conversation.unscoped.filter(pk=conversation.pk).update(folder=checkpoint)
    return conversation


def test_deleting_a_conversation_or_agent_deletes_its_versions_but_not_blobs(tmp_path, workspace, user):
    conversation = _referenced_versions(tmp_path, workspace, user)
    with workspace_scope(workspace.id):
        conversation.delete()
    assert not FolderVersion.unscoped.exists()
    assert not RunBlob.unscoped.exists()
    assert Blob.unscoped.count() == 1

    conversation = _referenced_versions(tmp_path, workspace, user)
    with workspace_scope(workspace.id):
        conversation.agent.delete()
    assert not FolderVersion.unscoped.exists()
    assert Blob.unscoped.count() == 1
    assert loose_keys() == []


@pytest.mark.parametrize("how", ["instance", "queryset", "owner"])
def test_deleting_a_workspace_queues_its_objects(tmp_path, files_storage, workspace, user, other_user, how):
    _referenced_versions(tmp_path, workspace, user)
    put(tmp_path, workspace.id, b"other contents")
    kept = put(tmp_path, other_user.personal_workspace.id, b"hello")
    keys = sorted(Blob.unscoped.filter(workspace=workspace).values_list("storage_key", flat=True))
    if how == "instance":
        workspace.delete()
    elif how == "queryset":
        Workspace.objects.filter(pk=workspace.pk).delete()
    else:
        user.delete()
    assert list(Blob.unscoped.all()) == [kept]
    assert loose_keys() == keys
    assert counted(other_user.personal_workspace) == 5
    assert stored_keys(files_storage) == sorted([*keys, kept.storage_key])
