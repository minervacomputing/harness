from django.core.management.base import BaseCommand

from runs.supervisor import serve_forever


class Command(BaseCommand):
    help = "Run the supervisor process role: start, watch, and clean up sandboxed agent runs."

    def handle(self, *args, **options) -> None:
        serve_forever()
