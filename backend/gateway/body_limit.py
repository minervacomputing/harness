"""Refuses oversized request bodies before Django reads them. Django's ASGI handler buffers the whole body
before any view or limit setting sees it."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from gateway.asgi_json import send_error


async def _refuse(send: Send) -> None:
    await send_error(send, 413, "The request is too large.")


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
