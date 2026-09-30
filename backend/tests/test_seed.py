import pytest
from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from django.core.management import CommandError, call_command

from accounts.management.commands.seed import SEED_ACCOUNTS, SEED_PASSWORD
from accounts.models import User


def test_seed_creates_verified_accounts_with_workspaces(db, settings):
    settings.DEBUG = True
    call_command("seed")
    Authenticator.objects.create(user=User.objects.get(email=SEED_ACCOUNTS[0][0]), type="totp", data={})
    call_command("seed")  # idempotent, and resets two-factor
    assert not Authenticator.objects.exists()

    for email, _ in SEED_ACCOUNTS:
        user = User.objects.get(email=email)
        assert user.check_password(SEED_PASSWORD)
        assert EmailAddress.objects.get(user=user, email=email).verified
        assert user.personal_workspace is not None


def test_seed_refuses_outside_debug(db, settings):
    settings.DEBUG = False
    with pytest.raises(CommandError):
        call_command("seed")
    assert not User.objects.exists()
