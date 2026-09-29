from django.conf import settings
from django.db import models

from workspaces.tenancy import TenantModel


class Agent(TenantModel):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="agents")
    name = models.CharField(max_length=120)
    instructions = models.TextField(blank=True, max_length=8000)
    connections = models.ManyToManyField("connections.Connection", blank=True, related_name="agents")
    model_alias = models.CharField(max_length=64, default="default")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self) -> str:
        return self.name
