from django.conf import settings
from django.db import models
from django.db.models import Q

from workspaces.tenancy import TenantModel


class PermissionLayer(TenantModel):
    """One layer of the intersection that decides what an agent run may do.

    A restricted layer allows only what its allow grants list; an unrestricted layer passes everything
    through. Deny grants apply in either mode and always win.
    """

    class Level(models.TextChoices):
        CEILING = "ceiling"  # set by workspace admins
        USER = "user"  # set by each member for their own runs
        AGENT = "agent"  # set per agent

    level = models.CharField(max_length=16, choices=Level.choices)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE)
    agent = models.ForeignKey("agents.Agent", null=True, blank=True, on_delete=models.CASCADE)
    restricted = models.BooleanField()
    version = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(level="ceiling", user__isnull=True, agent__isnull=True)
                | Q(level="user", user__isnull=False, agent__isnull=True)
                | Q(level="agent", user__isnull=True, agent__isnull=False),
                name="permission_layer_subject_matches_level",
            ),
            models.UniqueConstraint(
                fields=["workspace"], condition=Q(level="ceiling"), name="permission_layer_one_ceiling"
            ),
            models.UniqueConstraint(
                fields=["workspace", "user"], condition=Q(level="user"), name="permission_layer_one_per_user"
            ),
            models.UniqueConstraint(
                fields=["agent"], condition=Q(level="agent"), name="permission_layer_one_per_agent"
            ),
        ]


class Grant(TenantModel):
    class Effect(models.TextChoices):
        ALLOW = "allow"
        DENY = "deny"

    layer = models.ForeignKey(PermissionLayer, on_delete=models.CASCADE, related_name="grants")
    connection = models.ForeignKey("connections.Connection", on_delete=models.CASCADE, related_name="grants")
    resource_kind = models.CharField(max_length=64)
    resource_id = models.CharField(max_length=200)
    actions = models.JSONField(default=list)
    effect = models.CharField(max_length=8, choices=Effect.choices, default=Effect.ALLOW)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["layer", "connection", "resource_kind", "resource_id", "effect"], name="grant_unique"
            )
        ]
