from django.conf import settings
from django.db import models

from workspaces.tenancy import TenantModel


class Run(TenantModel):
    """One agent turn executed in a sandbox.

    queued → provisioning → running → completed | failed | cancelled | timed_out

    The run token is valid only while the status is active and the deadline, if the run has one, has not
    passed, so every terminal transition revokes it. Permissions and tools are snapshotted when the run is
    created.
    """

    class Status(models.TextChoices):
        QUEUED = "queued"
        PROVISIONING = "provisioning"
        RUNNING = "running"
        COMPLETED = "completed"
        FAILED = "failed"
        CANCELLED = "cancelled"
        TIMED_OUT = "timed_out"

    ACTIVE = (Status.QUEUED, Status.PROVISIONING, Status.RUNNING)
    TOKEN_VALID = (Status.PROVISIONING, Status.RUNNING)

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="runs")
    agent = models.ForeignKey("agents.Agent", on_delete=models.CASCADE, related_name="runs")
    conversation = models.ForeignKey(
        "conversations.Conversation", on_delete=models.CASCADE, related_name="runs"
    )
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED, db_index=True)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.CharField(max_length=500, blank=True)

    permissions = models.JSONField()
    tools = models.JSONField()
    instructions = models.TextField(blank=True)
    model_alias = models.CharField(max_length=64)

    token_hash = models.CharField(max_length=64, null=True, blank=True, unique=True)
    # Set when the run is claimed, if the instance limits a turn's time (Config.run_time_limit); None: none.
    deadline = models.DateTimeField(null=True, blank=True)

    writes_uncertain = models.BooleanField(default=False)
    model_calls = models.PositiveIntegerField(default=0)
    tool_calls = models.PositiveIntegerField(default=0)
    input_tokens = models.PositiveBigIntegerField(default=0)
    output_tokens = models.PositiveBigIntegerField(default=0)
    # Calls whose stream ended before the provider reported usage; their tokens are not counted above.
    unmetered_model_calls = models.PositiveIntegerField(default=0)

    event_seq = models.PositiveIntegerField(default=0)
    worker_seq = models.PositiveIntegerField(default=0)

    # A worker that takes over after its predecessor died starts a new attempt. Requests authenticated
    # under an earlier attempt can no longer change the run.
    attempt = models.PositiveIntegerField(default=1)
    # When the current attempt was claimed or restarted. Its worker must ask for the run spec soon after.
    attempt_started_at = models.DateTimeField(null=True, blank=True)
    # The worker's saved state (RunCommit): the last commit's sequence number and the bytes stored.
    journal_seq = models.PositiveIntegerField(default=0)
    journal_bytes = models.PositiveBigIntegerField(default=0)

    sandbox_provider = models.CharField(max_length=32, blank=True)
    sandbox_handle = models.JSONField(null=True, blank=True)
    sandbox_released = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "created_at"], name="run_status_created")]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation"],
                condition=models.Q(status__in=["queued", "provisioning", "running"]),
                name="run_one_active_per_conversation",
            )
        ]

    @property
    def is_active(self) -> bool:
        return self.status in self.ACTIVE

    @staticmethod
    def unexpired(now) -> models.Q:
        """Runs whose deadline, if they have one, is after `now`."""
        return models.Q(deadline__isnull=True) | models.Q(deadline__gt=now)

    def expired(self, now) -> bool:
        return self.deadline is not None and self.deadline <= now


class RunEvent(TenantModel):
    """Append-only, ordered run events. The browser replays them from any sequence number."""

    class Type(models.TextChoices):
        STATUS = "status"
        PHASE = "phase"
        TEXT_DELTA = "text_delta"
        REASONING_DELTA = "reasoning_delta"
        TOOL_CALL = "tool_call"
        MESSAGE = "message"

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="events")
    seq = models.PositiveIntegerField()
    type = models.CharField(max_length=32, choices=Type.choices)
    data = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["seq"]
        constraints = [models.UniqueConstraint(fields=["run", "seq"], name="run_event_seq_unique")]


class RunWrite(TenantModel):
    """One write a run sent to a provider. Deduplicates identical writes and remembers their outcome.

    A write is dispatched before its request is sent, then settles as succeeded or uncertain. A write
    the provider refused is deleted, so it can be tried again. Only one write per run is in flight.
    """

    class Status(models.TextChoices):
        DISPATCHED = "dispatched"
        SUCCEEDED = "succeeded"
        UNCERTAIN = "uncertain"

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="writes")
    key = models.CharField(max_length=64)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DISPATCHED)
    result = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    # After this a dispatched write that never settled is assumed lost and marked uncertain.
    deadline_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["run", "key"], name="run_write_key_unique"),
            models.UniqueConstraint(
                fields=["run"], condition=models.Q(status="dispatched"), name="run_write_one_in_flight"
            ),
        ]


class RunCommit(TenantModel):
    """One commit of the worker's pi-durable journal, so that a new worker can resume the run.

    Only the worker writes it and only the same run's next worker reads it back: opaque, untrusted state,
    stored encrypted and deleted when the run ends. Nothing in it is shown to users or trusted by the
    backend.
    """

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="commits")
    seq = models.PositiveIntegerField()
    attempt = models.PositiveIntegerField()
    data = models.BinaryField()
    key_version = models.CharField(max_length=32)
    # Plaintext bytes, and their sha256, which tells a retried commit from a conflicting one.
    size = models.PositiveIntegerField()
    digest = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["run", "seq"], name="run_commit_seq_unique")]


class RunPageToken(TenantModel):
    """Opaque page tokens handed to the agent, bound to one run, operation, and query."""

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="page_tokens")
    token = models.CharField(max_length=64, unique=True)
    tool = models.CharField(max_length=128)
    query_hash = models.CharField(max_length=64)
    upstream_cursor = models.CharField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)
