"""ASGI entry point for the gateway role: `uvicorn gateway.asgi:application`."""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")
os.environ["MINERVA_ROLE"] = "gateway"

from django.core.asgi import get_asgi_application

django_app = get_asgi_application()

from gateway.mcp import mcp_app  # noqa: E402


async def application(scope, receive, send) -> None:
    if scope["type"] == "lifespan" or (scope["type"] == "http" and scope["path"] == "/mcp"):
        await mcp_app(scope, receive, send)
    else:
        await django_app(scope, receive, send)
