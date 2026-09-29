from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from workspaces.services import provision_personal_workspace


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="provision_personal_workspace")
def _provision(sender, instance, created: bool, raw: bool = False, **kwargs) -> None:
    if created and not raw:
        provision_personal_workspace(instance)
