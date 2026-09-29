import secrets

from cryptography.fernet import Fernet
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Print fresh values for MINERVA_SECRET_KEY and MINERVA_ENCRYPTION_KEYS."
    requires_system_checks = []

    def handle(self, *args, **options) -> None:
        self.stdout.write(f"MINERVA_SECRET_KEY={secrets.token_urlsafe(50)}")
        self.stdout.write(f"MINERVA_ENCRYPTION_KEYS=v1:{Fernet.generate_key().decode()}")
