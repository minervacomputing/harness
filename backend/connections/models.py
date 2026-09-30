from django.conf import settings
from django.db import models

from connections import crypto
from minerva.models import UUIDModel
from workspaces.tenancy import TenantModel


class OAuthClient(UUIDModel):
    """Platform-level OAuth client for a provider, created by dynamic client registration when the
    operator has not configured one. Not tenant data."""

    provider = models.CharField(max_length=64)
    redirect_uri = models.CharField(max_length=500)
    client_id = models.CharField(max_length=200)
    secret_ciphertext = models.BinaryField()
    secret_key_version = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "redirect_uri"], name="oauth_client_provider_redirect"
            )
        ]

    def set_secret(self, secret: str) -> None:
        self.secret_ciphertext, self.secret_key_version = crypto.encrypt({"secret": secret})

    def secret(self) -> str:
        return crypto.decrypt(self.secret_ciphertext, self.secret_key_version)["secret"]


class Connection(TenantModel):
    """An account at an external provider, linked to a workspace.

    A personal connection (owner set) uses the owner's own OAuth grant, so the provider's own permissions
    bound what an agent can see. A shared connection (owner null) is set up by an admin (team feature).
    """

    class Status(models.TextChoices):
        ACTIVE = "active"
        ERROR = "error"
        REVOKED = "revoked"

    provider = models.CharField(max_length=64)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="connections"
    )
    label = models.CharField(max_length=200)
    external_account_id = models.CharField(max_length=200)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    credentials_ciphertext = models.BinaryField()
    credentials_key_version = models.CharField(max_length=32)
    # Bumped whenever the credentials change, so a failure seen with old credentials cannot mark new ones.
    credentials_generation = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "provider", "external_account_id"], name="connection_account_unique"
            )
        ]

    def __str__(self) -> str:
        return f"{self.provider}: {self.label}"

    def set_credentials(self, payload: dict) -> None:
        self.credentials_ciphertext, self.credentials_key_version = crypto.encrypt(payload)
        if self.credentials_generation is not None and not self._state.adding:
            self.credentials_generation += 1

    def credentials(self) -> dict:
        return crypto.decrypt(self.credentials_ciphertext, self.credentials_key_version)

    def usable_by(self, user_id) -> bool:
        return self.status == self.Status.ACTIVE and (self.owner_id is None or self.owner_id == user_id)
