"""Bounds the requests one run token has in flight. A response stays in memory until the client reads it, so
without a bound a worker could pin many large ones (run specs, saved state) by sending requests and not
reading the answers. The count is per gateway process."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from gateway.asgi_json import send_error
from gateway.auth import bearer
from runs.services import hash_token


def limit_in_flight(app: ASGIApp, max_requests: int) -> ASGIApp:
    # Requests in flight by token hash; a token's entry goes away with its last request.
    in_flight: dict[str, int] = {}

    async def limited(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        headers = [value for name, value in scope.get("headers", []) if name.lower() == b"authorization"]
        if len(headers) > 1:
            # The MCP server reads the last one and Django joins them, so a request could otherwise be
            # counted under one token and authenticated by another.
            await send_error(send, 400, "Send one Authorization header.")
            return
        token = bearer(headers[0].decode("latin-1")) if headers else None
        if token is None:
            # require_run refuses these at once.
            await app(scope, receive, send)
            return
        # The token as authentication reads it, so spelling the header differently gains no slots.
        key = hash_token(token)
        count = in_flight.get(key, 0)
        if count >= max_requests:
            # Nothing has been read yet, so the body is never buffered.
            await send_error(send, 429, "This run has too many requests in flight.")
            return
        in_flight[key] = count + 1

        async def send_and_wait(message: Message) -> None:
            # The server waits for a client that is not reading before it writes a message, not after. Ending
            # the response with an empty message keeps the slot until the client has read all but the
            # server's write buffer.
            last = message["type"] == "http.response.body" and not message.get("more_body")
            if last and message.get("body"):
                await send({**message, "more_body": True})
                message = {"type": "http.response.body"}
            await send(message)

        try:
            await app(scope, receive, send_and_wait)
        finally:
            if in_flight[key] > 1:
                in_flight[key] -= 1
            else:
                del in_flight[key]

    return limited
