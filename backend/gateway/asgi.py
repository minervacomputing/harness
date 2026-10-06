"""ASGI entry point for the gateway role: `uvicorn gateway.asgi:application`."""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")
os.environ["MINERVA_ROLE"] = "gateway"

from django.conf import settings
from django.core.asgi import get_asgi_application

from gateway.body_limit import limit_body
from minerva.config import config

django_app = limit_body(get_asgi_application(), settings.DATA_UPLOAD_MAX_MEMORY_SIZE)

from gateway.in_flight import limit_in_flight  # noqa: E402
from gateway.mcp import mcp_app  # noqa: E402


async def route(scope, receive, send) -> None:
    if scope["type"] == "lifespan" or (scope["type"] == "http" and scope["path"] == "/mcp"):
        await mcp_app(scope, receive, send)
    else:
        await django_app(scope, receive, send)


# Outermost, so a request it refuses reaches neither Django nor the MCP server.
application = limit_in_flight(route, config().run_max_requests_in_flight)
