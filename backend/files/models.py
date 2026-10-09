from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import GinIndex
from django.db import models
from django.db.models.functions import Now

from workspaces.tenancy import TenantManager, TenantModel


class BlobDeletionRefused(RuntimeError):
    pass


class BlobQuerySet(models.QuerySet):
    def delete(self):
        raise BlobDeletionRefused(
            "Blobs are deleted only by files.sweep, which checks that nothing names them."
        )


class Blob(TenantModel):
    """One file's contents in one workspace, stored under its own key.

    A blob is deleted only by the sweep (or with its workspace), since versions name blobs by hash rather than
    by foreign key. Its workspace, hash, size and key cannot change (a database trigger refuses). Deleting a row
    queues its object for deletion and subtracts its size from the workspace's counter (another trigger).
    """

    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    storage_key = models.CharField(max_length=200, unique=True)
    created_at = models.DateTimeField(db_default=Now())
    # Whatever starts to refer to the blob sets this while holding the row's lock.
    last_used_at = models.DateTimeField(db_default=Now(), db_index=True)

    objects = TenantManager.from_queryset(BlobQuerySet)()
    unscoped = models.Manager.from_queryset(BlobQuerySet)()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "sha256"], name="files_blob_workspace_sha256")
        ]

    def delete(self, *args, **kwargs):
        raise BlobDeletionRefused(
            "Blobs are deleted only by files.sweep, which checks that nothing names them."
        )


class RunBlob(TenantModel):
    """A blob a run uploaded, which it may read and name in its checkpoints until it ends."""

    run = models.ForeignKey("runs.Run", on_delete=models.CASCADE, related_name="+")
    blob = models.ForeignKey(Blob, on_delete=models.RESTRICT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["run", "blob"], name="files_runblob_run_blob")]


class Upload(TenantModel):
    """A file a user uploaded to attach to a message, until it is attached (which deletes the row: the run's base
    version then names its blob) or the sweep deletes it a day later."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    blob = models.ForeignKey(Blob, on_delete=models.RESTRICT, related_name="+")
    # A valid name for a file at the folder's root (files.uploads.clean_name).
    name = models.CharField(max_length=255)
    # Sniffed from the contents, for display only: downloads are always application/octet-stream.
    media_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)


class FolderVersion(TenantModel):
    """A conversation's folder at one point: a manifest of paths and the blobs they hold.

    The contents (entries, hashes, size) cannot change after insert (a database trigger refuses).
    """

    class Kind(models.TextChoices):
        TURN = "turn"
        BASE = "base"
        CHECKPOINT = "checkpoint"

    conversation = models.ForeignKey(
        "conversations.Conversation", on_delete=models.CASCADE, related_name="folder_versions"
    )
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    kind = models.CharField(max_length=16, choices=Kind.choices)
    run = models.ForeignKey("runs.Run", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    attempt = models.PositiveIntegerField(null=True, blank=True)
    # {"files": {path: {"sha256", "size", "mode", "mtime"}}, "dirs": [empty directories]}; see files.manifest.
    entries = models.JSONField()
    hashes = ArrayField(models.CharField(max_length=64))
    # sha256 of the canonical entries, so an identical folder is recognised without comparing manifests.
    digest = models.CharField(max_length=64)
    # Bytes as tmpfs charges them: each file rounded up to whole 4 KiB pages.
    size = models.PositiveBigIntegerField()
    file_count = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            GinIndex(fields=["hashes"], name="files_version_hashes"),
            models.Index(
                fields=["created_at"], condition=models.Q(kind="checkpoint"), name="files_version_checkpoints"
            ),
        ]


class WorkspaceStorage(models.Model):
    """The bytes of a workspace's blobs. Uploads add to it; the blob deletion trigger subtracts."""

    workspace = models.OneToOneField(
        "workspaces.Workspace", primary_key=True, on_delete=models.CASCADE, related_name="+"
    )
    bytes = models.PositiveBigIntegerField(default=0)

    def __str__(self) -> str:
        return f"{self.workspace_id}: {self.bytes} bytes"


class LooseObject(models.Model):
    """An object in storage that no Blob row names, yet or any more. The sweep deletes it after `delete_after`.

    Not tenant-owned: it outlives its workspace, whose deletion queues its objects here.
    """

    key = models.CharField(max_length=200, primary_key=True)
    delete_after = models.DateTimeField(db_index=True)
    # How often the sweep has taken the row to delete the object. An upload can claim its object (and record a
    # blob naming it) only while this is 0, so once the sweep has started on it, it is never named again.
    leases = models.PositiveIntegerField(default=0)
    # How often the sweep has deleted the object. It deletes twice, a day apart, in case a write was in flight.
    deletions = models.PositiveSmallIntegerField(default=0)

    def __str__(self) -> str:
        return self.key
