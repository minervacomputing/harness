"""ASGI entry point for the gateway role: `uvicorn gateway.asgi:application`."""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")
os.environ["MINERVA_ROLE"] = "gateway"

from django.conf import settings
from django.core.asgi import get_asgi_application

from gateway.body_limit import limit_body

django_app = limit_body(get_asgi_application(), settings.DATA_UPLOAD_MAX_MEMORY_SIZE)

from gateway.mcp import mcp_app  # noqa: E402


async def application(scope, receive, send) -> None:
    if scope["type"] == "lifespan" or (scope["type"] == "http" and scope["path"] == "/mcp"):
        await mcp_app(scope, receive, send)
    else:
        await django_app(scope, receive, send)
