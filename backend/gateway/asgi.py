"""ASGI entry point for the gateway role: `uvicorn gateway.asgi:application`."""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")
os.environ["MINERVA_ROLE"] = "gateway"

from django.conf import settings
from django.core.asgi import get_asgi_application

from gateway.body_limit import limit_body
from minerva.config import config

django_app = limit_body(get_asgi_application(), settings.DATA_UPLOAD_MAX_MEMORY_SIZE)

from gateway.auth import require_run  # noqa: E402
from gateway.in_flight import limit_in_flight  # noqa: E402
from gateway.mcp import mcp_app  # noqa: E402


async def route(scope, receive, send) -> None:
    if scope["type"] == "lifespan" or (scope["type"] == "http" and scope["path"] == "/mcp"):
        await mcp_app(scope, receive, send)
    else:
        await django_app(scope, receive, send)


# The in-flight limit is outermost, so a request it refuses reaches neither Django nor the MCP server, and costs no
# query. A request without an active run's token is refused next, before anything reads its body.
gated = require_run(route, config().gateway_max_unauthenticated_in_flight)
application = limit_in_flight(gated, config().run_max_requests_in_flight)
