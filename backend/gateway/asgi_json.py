"""Error responses for the gateway's raw ASGI paths, in the same shape as the views' JSON errors."""

import json
from collections.abc import Sequence

from starlette.types import Send


async def send_error(
    send: Send, status: int, message: str, headers: Sequence[tuple[bytes, bytes]] = ()
) -> None:
    body = json.dumps({"error": {"message": message}}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *headers]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
