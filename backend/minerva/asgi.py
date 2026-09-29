"""ASGI entry point for the web role: `uvicorn minerva.asgi:application`."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")

application = get_asgi_application()
