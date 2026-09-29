import uuid

from django.db import models


class UUIDModel(models.Model):
    """Time-ordered UUIDv7 primary keys: unguessable across tenants, index-friendly."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid7, editable=False)

    class Meta:
        abstract = True
