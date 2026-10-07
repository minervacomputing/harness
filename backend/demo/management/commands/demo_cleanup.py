import logging
import time

from django.core.management.base import BaseCommand, CommandError

from demo import newsletter, services

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Deletes visitors' idle conversations and syncs newsletter opt-ins to Buttondown or Bento."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--every", type=int, default=0, help="Repeat every N seconds (0: run once).")

    def handle(self, *args, every: int, **options) -> None:
        if services.site() is None:
            raise CommandError("No demo workspace. Set MINERVA_DEMO=true and run demo_setup first.")
        while True:
            try:
                deleted = services.cleanup(services.site())
                synced = newsletter.sync_leads()
                self.stdout.write(f"Deleted {deleted} conversations, synced {synced} newsletter leads.")
            except Exception:
                if not every:
                    raise
                log.exception("Demo cleanup failed.")
            if not every:
                return
            time.sleep(every)
