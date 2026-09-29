from django.apps import AppConfig


class WorkspacesConfig(AppConfig):
    name = "workspaces"

    def ready(self) -> None:
        from workspaces import signals  # noqa: F401
