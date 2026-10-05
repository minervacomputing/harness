from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialApp
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from ninja import Router, Schema, Status
from ninja.errors import HttpError
from ninja.security import APIKeyCookie

from accounts.models import User
from demo import services, turnstile
from minerva.config import config

router = Router(tags=["demo"])


class CsrfChecked(APIKeyCookie):
    """No login, but Django's CSRF check, which Ninja otherwise skips for anonymous endpoints."""

    param_name = settings.CSRF_COOKIE_NAME

    def authenticate(self, request, key):
        return True


csrf_checked = CsrfChecked()


class DemoConfigOut(Schema):
    enabled: bool
    turnstile_site_key: str | None
    providers: list[str]


class GateIn(Schema):
    token: str
    newsletter: bool


class EmailIn(Schema):
    email: str


def _providers() -> list[str]:
    configured = set(getattr(settings, "SOCIALACCOUNT_PROVIDERS", {}))
    configured |= set(SocialApp.objects.values_list("provider", flat=True))
    return [p for p in ("google", "apple") if p in configured]


@router.get("/demo/config", response=DemoConfigOut)
def demo_config(request):
    if not services.enabled():
        return {"enabled": False, "turnstile_site_key": None, "providers": []}
    return {
        "enabled": True,
        "turnstile_site_key": config().turnstile_site_key,
        "providers": _providers(),
    }


@router.post("/demo/gate", response={204: None}, auth=csrf_checked)
def demo_gate(request, payload: GateIn):
    """Admits this browser to sign in after a Turnstile check, and remembers the newsletter choice."""
    if not services.enabled():
        raise HttpError(404, "Not found.")
    if not turnstile.verify(payload.token, request.headers.get("CF-Connecting-IP")):
        raise HttpError(403, "The security check failed. Reload the page and try again.")
    services.admit(request.session, newsletter=payload.newsletter)
    return Status(204, None)


@router.post("/demo/email", response={204: None}, auth=csrf_checked)
def demo_email(request, payload: EmailIn):
    """Creates a passwordless account for the address if there is none, so a sign-in code can be sent.

    Answers the same whether or not the account existed.
    """
    if not services.enabled():
        raise HttpError(404, "Not found.")
    email = payload.email.strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        raise HttpError(422, "Enter a valid email address.") from None
    if not services.use_admission(request.session):
        raise HttpError(403, "The security check expired. Reload the page and try again.")
    if not User.objects.filter(email=email).exists():
        try:
            with transaction.atomic():
                user = User.objects.create_user(email)
                EmailAddress.objects.create(user=user, email=email, primary=True, verified=False)
        except IntegrityError:
            pass  # Created by a concurrent request for the same address.
    return Status(204, None)
