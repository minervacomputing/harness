from django.conf import settings
from django.db import models

from minerva.models import UUIDModel


class DemoSite(UUIDModel):
    """The one shared workspace of a public demo instance. Visitors join it as members."""

    workspace = models.OneToOneField("workspaces.Workspace", on_delete=models.PROTECT)
    # Shown on the new-chat screen.
    suggestions = models.JSONField(default=list, blank=True)
    # Shown above the suggestions, set apart: a request that Minerva refuses.
    featured_suggestion = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Demo: {self.workspace}"


class DemoUsage(models.Model):
    """Chat turns a visitor started on one UTC day. Kept apart from runs, which deleting a chat removes."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    day = models.DateField()
    turns = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "day"], name="demo_usage_unique")]

    def __str__(self) -> str:
        return f"{self.user_id} on {self.day}: {self.turns}"


class DemoAdmission(UUIDModel):
    """A passed Turnstile check. The browser's session holds its id; each sign-in attempt spends a use."""

    newsletter = models.BooleanField()
    uses = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Admission {self.pk}: {self.uses} uses"


class DemoLead(UUIDModel):
    """Someone who signed in to the demo. No foreign key, so leads outlive accounts."""

    email = models.EmailField(max_length=254, unique=True)
    newsletter = models.BooleanField(default=False)
    source = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)
    # The newsletter provider the address was last added to ("bento" or "buttondown"), and when.
    synced_to = models.CharField(max_length=16, blank=True)
    synced_at = models.DateTimeField(null=True, blank=True)

    def __str__(self) -> str:
        return self.email
