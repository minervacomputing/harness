from django.apps import AppConfig


class DemoConfig(AppConfig):
    name = "demo"

    def ready(self) -> None:
        from django.conf import settings

        # The gateway role runs without allauth.
        if "allauth.account" in settings.INSTALLED_APPS:
            from demo import signals  # noqa: F401
