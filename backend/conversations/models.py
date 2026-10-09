from django.conf import settings
from django.db import models

from workspaces.tenancy import TenantModel


class Conversation(TenantModel):
    agent = models.ForeignKey("agents.Agent", on_delete=models.CASCADE, related_name="conversations")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="conversations")
    title = models.CharField(max_length=200, blank=True)
    # The conversation's files: the version the last turn produced. Null until it has any.
    folder = models.ForeignKey(
        "files.FolderVersion", null=True, blank=True, on_delete=models.RESTRICT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]


class Message(TenantModel):
    class Role(models.TextChoices):
        USER = "user"
        ASSISTANT = "assistant"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=Role.choices)
    content = models.TextField(max_length=100_000)
    run = models.ForeignKey(
        "runs.Run", null=True, blank=True, on_delete=models.SET_NULL, related_name="messages"
    )
    # A user message's files, as they were added to the folder of its run's base version: [{"path", "size",
    # "media_type"}].
    attachments = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
