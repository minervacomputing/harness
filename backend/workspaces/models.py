from django.conf import settings
from django.db import models

from minerva.models import UUIDModel


class Workspace(UUIDModel):
    """The tenant. A personal workspace has exactly one member; a team workspace has many."""

    class Kind(models.TextChoices):
        PERSONAL = "personal"
        TEAM = "team"

    kind = models.CharField(max_length=16, choices=Kind.choices)
    name = models.CharField(max_length=120)
    personal_owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="personal_workspace",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(kind="personal", personal_owner__isnull=False))
                | (models.Q(kind="team", personal_owner__isnull=True)),
                name="workspace_personal_owner_matches_kind",
            )
        ]

    def __str__(self) -> str:
        return self.name


class Membership(UUIDModel):
    class Role(models.TextChoices):
        OWNER = "owner"
        ADMIN = "admin"
        MEMBER = "member"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=16, choices=Role.choices)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="membership_unique")]

    def __str__(self) -> str:
        return f"{self.user} in {self.workspace} ({self.role})"

    @property
    def is_admin(self) -> bool:
        return self.role in {self.Role.OWNER, self.Role.ADMIN}
