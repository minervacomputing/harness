from django.core.management.base import BaseCommand, CommandError

from demo import services


class Command(BaseCommand):
    help = (
        "Publishes the owner's setup to visitors: shares every connection with the workspace, gives the "
        "agent all of them, and copies the owner's permissions to the ceiling and to every visitor."
    )

    def handle(self, *args, **options) -> None:
        site = services.site()
        if site is None:
            raise CommandError("No demo workspace. Set MINERVA_DEMO=true and run demo_setup first.")
        result = services.sync(site)
        self.stdout.write(", ".join(f"{key}: {value}" for key, value in result.items()))
