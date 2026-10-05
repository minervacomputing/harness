from django.conf import settings
from django.db import models

from workspaces.tenancy import TenantModel


class Run(TenantModel):
    """One agent turn executed in a sandbox.

    queued → provisioning → running → completed | failed | cancelled | timed_out

    The run token is valid only while the status is active and the deadline has not passed, so every
    terminal transition revokes it. Permissions and tools are snapshotted when the run is created.
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
    deadline = models.DateTimeField(null=True, blank=True)

    max_writes = models.PositiveIntegerField()
    write_count = models.PositiveIntegerField(default=0)
    writes_uncertain = models.BooleanField(default=False)
    max_model_calls = models.PositiveIntegerField()
    model_calls = models.PositiveIntegerField(default=0)
    max_tool_calls = models.PositiveIntegerField()
    # Counts calls past the limit too, so only the first refused one is recorded.
    tool_calls = models.PositiveIntegerField(default=0)
    input_tokens = models.PositiveBigIntegerField(default=0)
    output_tokens = models.PositiveBigIntegerField(default=0)
    # Calls whose stream ended before the provider reported usage; their tokens are not counted above.
    unmetered_model_calls = models.PositiveIntegerField(default=0)

    event_seq = models.PositiveIntegerField(default=0)
    worker_seq = models.PositiveIntegerField(default=0)

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


class RunEvent(TenantModel):
    """Append-only, ordered run events. The browser replays them from any sequence number."""

    class Type(models.TextChoices):
        STATUS = "status"
        PHASE = "phase"
        TEXT_DELTA = "text_delta"
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
    the provider refused is deleted, which returns its quota. Only one write per run is in flight.
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


class RunPageToken(TenantModel):
    """Opaque page tokens handed to the agent, bound to one run, operation, and query."""

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="page_tokens")
    token = models.CharField(max_length=64, unique=True)
    tool = models.CharField(max_length=128)
    query_hash = models.CharField(max_length=64)
    upstream_cursor = models.CharField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)
