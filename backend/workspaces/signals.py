from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from minerva.config import config
from workspaces.services import provision_personal_workspace


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="provision_personal_workspace")
def _provision(sender, instance, created: bool, raw: bool = False, **kwargs) -> None:
    if not created or raw:
        return
    if config().demo:
        # Demo visitors get no workspace of their own, only the shared demo workspace.
        from demo.services import join

        join(instance)
    else:
        provision_personal_workspace(instance)
