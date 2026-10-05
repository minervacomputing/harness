from allauth.account.signals import user_logged_in
from django.dispatch import receiver

from demo import services


@receiver(user_logged_in, dispatch_uid="demo_record_lead")
def _record_lead(sender, request, user, sociallogin=None, **kwargs) -> None:
    if not services.is_visitor(user):
        return
    source = sociallogin.account.provider if sociallogin is not None else "email"
    services.record_lead(user, source=source, newsletter=services.newsletter_choice(request.session))
