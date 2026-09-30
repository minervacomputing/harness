from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import User

# Known credentials, so they must never exist outside development.
SEED_PASSWORD = "password"  # noqa: S105
SEED_ACCOUNTS = [
    ("ada@example.com", "Ada Lovelace"),
    ("grace@example.com", "Grace Hopper"),
]


class Command(BaseCommand):
    help = "Create verified development accounts with a known password. Refuses unless MINERVA_DEBUG is on."

    def handle(self, *args, **options) -> None:
        if not settings.DEBUG:
            raise CommandError("Seed accounts have a known password; this only runs with MINERVA_DEBUG=true.")

        with transaction.atomic():
            for email, name in SEED_ACCOUNTS:
                user, created = User.objects.get_or_create(email=email, defaults={"name": name})
                # Re-running resets the password and removes two-factor, so the documented credentials always work.
                user.set_password(SEED_PASSWORD)
                user.save()
                Authenticator.objects.filter(user=user).delete()
                EmailAddress.objects.update_or_create(
                    user=user, email=email, defaults={"verified": True, "primary": True}
                )
                self.stdout.write(f"{'created' if created else 'reset'}  {email}")

        self.stdout.write(f"Password for all seed accounts: {SEED_PASSWORD}")
