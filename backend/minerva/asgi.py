"""ASGI entry point for the web role: `uvicorn minerva.asgi:application`."""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")

from django.conf import settings
from django.core.asgi import get_asgi_application

from gateway.body_limit import limit_body

django_asgi = get_asgi_application()

from files import upload_app  # noqa: E402


async def _too_large(send) -> None:
    await upload_app.refuse(send, 413, "The request is too large.")


# Django buffers a request's whole body before a view sees it, so bodies larger than it would read are refused first.
django_app = limit_body(django_asgi, settings.DATA_UPLOAD_MAX_MEMORY_SIZE, _too_large)


async def application(scope, receive, send) -> None:
    if upload_app.matches(scope):
        # Streamed to disk, never buffered by Django.
        await upload_app.upload_app(scope, receive, send)
    else:
        await django_app(scope, receive, send)
