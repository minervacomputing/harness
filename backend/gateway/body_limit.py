"""Refuses oversized request bodies before Django reads them. Django's ASGI handler buffers the whole body,
unauthenticated, before any view or limit setting sees it."""

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

TOO_LARGE = json.dumps({"error": {"message": "The request is too large."}}).encode()


async def _refuse(send: Send) -> None:
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(TOO_LARGE)).encode())]
    await send({"type": "http.response.start", "status": 413, "headers": headers})
    await send({"type": "http.response.body", "body": TOO_LARGE})


def limit_body(app: ASGIApp, max_bytes: int) -> ASGIApp:
    async def limited(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        declared = dict(scope.get("headers", [])).get(b"content-length", b"0")
        if not declared.isdigit() or int(declared) > max_bytes:
            await _refuse(send)
            return
        received = 0
        started = refused = False

        async def send_unless_refused(message: Message) -> None:
            nonlocal started
            if refused:
                return
            started = True
            await send(message)

        async def receive_limited() -> Message:
            nonlocal received, refused
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                # A body longer than declared, or streamed without a length: answer 413 here, then tell
                # the app the client left, so it stops reading and sends nothing of its own.
                if received > max_bytes:
                    if not started and not refused:
                        refused = True
                        await _refuse(send)
                    return {"type": "http.disconnect"}
            return message

        await app(scope, receive_limited, send_unless_refused)

    return limited
