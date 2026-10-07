"""Corrects the workspaces' storage counters and, with --storage, deletes objects that no row names."""

from django.core.management.base import BaseCommand

from files import reconcile


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--storage",
            action="store_true",
            help="Also list the stored objects and delete those that no row names and that are over a day old.",
        )

    def handle(self, *args, **options) -> None:
        self.stdout.write(f"Counters corrected: {reconcile.counters()}")
        if options["storage"]:
            self.stdout.write(f"Untracked objects deleted: {reconcile.untracked_objects()}")
