import asyncio
import json

import pytest
from django.core.handlers.asgi import ASGIHandler

from gateway.in_flight import limit_in_flight

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("gateway_urls")]

TOO_MANY = b'{"error": {"message": "This run has too many requests in flight."}}'


def bearer(token: str) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", f"Bearer {token}".encode())]


class Request:
    """One request over raw ASGI. Its client reads the response body only once `reading` is set, and hangs up
    when `hang_up` is set. Like uvicorn, `send` takes a message at once and waits for the client only before
    the next one, while the client has not read what was sent."""

    def __init__(self, headers: list[tuple[bytes, bytes]], path: str = "/run") -> None:
        headers = [(b"host", b"testserver"), *headers]
        self.scope = {"type": "http", "method": "GET", "path": path, "query_string": b"", "headers": headers}
        self.sent: list[dict] = []
        self.reads = 0
        self.reading = asyncio.Event()
        self.reading.set()
        self.hang_up = asyncio.Event()
        self.stalled = asyncio.Event()

    async def receive(self) -> dict:
        self.reads += 1
        if self.reads == 1:
            return {"type": "http.request", "body": b""}
        await self.hang_up.wait()
        return {"type": "http.disconnect"}

    async def send(self, message: dict) -> None:
        if message["type"] == "http.response.body" and any("body" in sent for sent in self.sent):
            if not self.reading.is_set():
                self.stalled.set()
            await self.reading.wait()
        self.sent.append(message)

    @property
    def status(self) -> int | None:
        return self.sent[0]["status"] if self.sent else None

    @property
    def body(self) -> bytes:
        return b"".join(message.get("body", b"") for message in self.sent[1:])

    def start(self, app) -> asyncio.Task:
        return asyncio.create_task(app(self.scope, self.receive, self.send))

    async def answer(self, app) -> int | None:
        await app(self.scope, self.receive, self.send)
        return self.status


class Held:
    """An app that holds every request until `release` is set, then answers 200."""

    def __init__(self) -> None:
        self.reached = 0
        self.release = asyncio.Event()

    async def __call__(self, scope, receive, send) -> None:
        self.reached += 1
        await receive()
        await self.release.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_a_token_has_at_most_the_limit_of_requests_in_flight():
    app = Held()
    limited = limit_in_flight(app, 2)
    held = [Request(bearer("a" * 40)).start(limited) for _ in range(2)]
    await settle()
    assert app.reached == 2

    refused = Request(bearer("a" * 40))
    assert await refused.answer(limited) == 429
    assert refused.body == TOO_MANY
    # Refused before anything was read, so neither Django nor the MCP server buffers the body.
    assert refused.reads == 0 and app.reached == 2

    # Another token, and a request that no endpoint would authenticate, are not held back.
    others = [Request(bearer("b" * 40)).start(limited), Request([]).start(limited)]
    await settle()
    assert app.reached == 4

    app.release.set()
    await asyncio.gather(*held, *others)
    again = [Request(bearer("a" * 40)) for _ in range(2)]
    assert [await request.answer(limited) for request in again] == [200, 200]


@pytest.mark.parametrize(
    "header",
    [
        (b"authorization", b"Bearer  token-token-token-token "),
        (b"Authorization", b"Bearer token-token-token-token"),
    ],
)
async def test_spellings_of_one_token_share_its_slots(header):
    app = Held()
    limited = limit_in_flight(app, 1)
    held = Request(bearer("token-token-token-token")).start(limited)
    await settle()
    assert await Request([header]).answer(limited) == 429
    app.release.set()
    await held


@pytest.mark.parametrize(
    "headers",
    [
        [(b"authorization", b"Bearer one-one-one-one"), (b"authorization", b"Bearer two-two-two-two")],
        [(b"authorization", b"Bearer two-two-two-two"), (b"Authorization", b"Bearer one-one-one-one")],
        [(b"authorization", b"Bearer one-one-one-one"), (b"authorization", b"Bearer one-one-one-one")],
    ],
)
async def test_two_authorization_headers_are_refused(headers):
    app = Held()
    request = Request(headers)
    assert await request.answer(limit_in_flight(app, 1)) == 400
    assert app.reached == 0 and request.reads == 0


async def test_a_slot_is_freed_when_its_request_fails_or_is_cancelled():
    calls = 0

    async def fails_once(scope, receive, send):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    limited = limit_in_flight(fails_once, 1)
    with pytest.raises(RuntimeError):
        await Request(bearer("token-token-token-token")).answer(limited)
    assert await Request(bearer("token-token-token-token")).answer(limited) == 200

    app = Held()
    limited = limit_in_flight(app, 1)
    held = Request(bearer("token-token-token-token")).start(limited)
    await settle()
    held.cancel()
    with pytest.raises(asyncio.CancelledError):
        await held
    app.release.set()
    assert await Request(bearer("token-token-token-token")).answer(limited) == 200


async def test_other_scopes_pass_through():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    await limit_in_flight(app, 1)({"type": "lifespan"}, None, None)
    assert seen == ["lifespan"]


async def test_the_end_of_a_response_is_sent_on_its_own():
    """The server waits for a client that is not reading before it writes, so an empty last message gives it
    the chance to hold the request until the client has read the rest."""

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"part", "more_body": True})
        await send({"type": "http.response.body", "body": b"rest"})

    request = Request(bearer("token-token-token-token"))
    assert await request.answer(limit_in_flight(app, 1)) == 200
    assert request.sent[1:] == [
        {"type": "http.response.body", "body": b"part", "more_body": True},
        {"type": "http.response.body", "body": b"rest", "more_body": True},
        {"type": "http.response.body"},
    ]


async def test_a_response_holds_its_slot_until_the_client_has_read_it(claimed):
    _, token = claimed
    limited = limit_in_flight(ASGIHandler(), 1)
    unread = Request(bearer(token))
    unread.reading.clear()
    task = unread.start(limited)
    # The view has answered and the server holds the body; the client has not read it.
    await asyncio.wait_for(unread.stalled.wait(), 10)
    assert unread.status == 200

    assert await Request(bearer(token)).answer(limited) == 429
    unread.reading.set()
    await task
    assert json.loads(unread.body)["prompt"] == "List my tasks"
    assert await Request(bearer(token)).answer(limited) == 200


async def test_a_client_that_hangs_up_frees_its_slot(claimed):
    _, token = claimed
    limited = limit_in_flight(ASGIHandler(), 1)
    unread = Request(bearer(token))
    unread.reading.clear()
    task = unread.start(limited)
    await asyncio.wait_for(unread.stalled.wait(), 10)
    unread.hang_up.set()
    await task
    assert await Request(bearer(token)).answer(limited) == 200
