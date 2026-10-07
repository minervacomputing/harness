import asyncio
import json
import threading
from contextlib import asynccontextmanager

import pytest
from asgiref.sync import sync_to_async
from django.db import OperationalError, connection
from django.utils import timezone

from gateway import auth, mcp
from gateway.auth import ATTEMPT_SCOPE_KEY, RUN_SCOPE_KEY, require_run
from runs import services
from runs.models import Run, RunCommit

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("gateway_urls")]

INACTIVE = b'{"error": {"message": "Inactive run credential."}}'
BUSY = b'{"error": {"message": "The gateway is busy. Try again."}}'
INVENTED = "x" * 43
CHUNK = 64 * 1024
MCP_HEADERS = [(b"content-type", b"application/json"), (b"accept", b"application/json, text/event-stream")]


def bearer(token: str) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", f"Bearer {token}".encode())]


class Upload:
    """A request over raw ASGI whose body arrives in 64 KiB chunks; `reads` counts the calls to `receive`.
    While `flowing` is clear the client sends nothing after the first chunk, like a slow upload."""

    def __init__(
        self,
        headers: list[tuple[bytes, bytes]],
        *,
        method: str = "PUT",
        path: str = "/journal/1",
        body: bytes = b"",
    ) -> None:
        length = (b"content-length", str(len(body)).encode())
        self.scope = {
            "type": "http",
            "method": method,
            "path": path,
            "query_string": b"",
            "headers": [(b"host", b"testserver"), length, *headers],
        }
        self.chunks = [body[i : i + CHUNK] for i in range(0, len(body), CHUNK)] or [b""]
        self.reads = 0
        self.read = asyncio.Event()
        self.flowing = asyncio.Event()
        self.flowing.set()
        self.sent: list[dict] = []

    async def receive(self) -> dict:
        self.reads += 1
        self.read.set()
        if self.reads > 1:
            await self.flowing.wait()
        if self.reads > len(self.chunks):
            # The whole body was sent and the client stays connected.
            await asyncio.Event().wait()
        more = self.reads < len(self.chunks)
        return {"type": "http.request", "body": self.chunks[self.reads - 1], "more_body": more}

    async def send(self, message: dict) -> None:
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
        await asyncio.wait_for(app(self.scope, self.receive, self.send), 10)
        return self.status


class Reached:
    """An app that answers 200 and keeps the scopes it was called with."""

    def __init__(self) -> None:
        self.scopes: list[dict] = []

    async def __call__(self, scope, receive, send) -> None:
        self.scopes.append(scope)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


@pytest.fixture
def lookups(monkeypatch) -> list[str]:
    """The tokens looked up in the database, in order."""
    looked_up: list[str] = []

    def run_for_token(token: str) -> Run | None:
        looked_up.append(token)
        return services.run_for_token(token)

    monkeypatch.setattr(auth, "run_for_token", run_for_token)
    return looked_up


@pytest.mark.parametrize(
    "headers",
    [
        [],
        [(b"authorization", b"Basic YTpi")],
        [(b"authorization", b"Bearer  ")],
        bearer("x" * 201),
        # The in-flight limit answers these with 400; on its own the gate counts them as none.
        [*bearer(INVENTED), *bearer(INVENTED)],
    ],
)
async def test_a_request_without_a_usable_token_is_refused_without_a_lookup(headers, lookups):
    app = Reached()
    request = Upload(headers)
    assert await request.answer(require_run(app, 1)) == 401
    assert request.body == INACTIVE
    assert (request.reads, app.scopes, lookups) == (0, [], [])


async def test_only_an_active_runs_current_token_reaches_the_app(claimed):
    run, token = claimed
    app = Reached()
    gate = require_run(app, 1)
    assert await Upload(bearer(token)).answer(gate) == 200
    assert (app.scopes[0][RUN_SCOPE_KEY], app.scopes[0][ATTEMPT_SCOPE_KEY]) == (run.id, 1)

    _, replacement = await sync_to_async(services.restart)(run.id, 1)
    assert await Upload(bearer(token)).answer(gate) == 401
    assert await Upload(bearer(replacement)).answer(gate) == 200
    assert app.scopes[1][ATTEMPT_SCOPE_KEY] == 2

    await Run.unscoped.filter(pk=run.id).aupdate(deadline=timezone.now())
    for refused in (Upload(bearer(INVENTED)), Upload(bearer(token)), Upload(bearer(replacement))):
        assert await refused.answer(gate) == 401
        assert refused.body == INACTIVE and refused.reads == 0
    assert len(app.scopes) == 2


@pytest.mark.parametrize(
    "headers", [[], [(b"authorization", b"Basic YTpi")], bearer(INVENTED), bearer("x" * 201)]
)
async def test_an_upload_without_an_active_token_is_never_read(application, headers):
    uploads = [Upload(headers, body=b"x" * 1_000_000) for _ in range(4)]
    for upload in uploads:
        upload.flowing.clear()
    # Django's handler would wait for the rest of each body before any view could refuse it.
    assert await asyncio.gather(*(upload.answer(application) for upload in uploads)) == [401] * 4
    assert [(upload.reads, upload.body) for upload in uploads] == [(0, INACTIVE)] * 4


async def test_an_active_token_reaches_the_view_with_its_body(application, claimed, lookups):
    run, token = claimed
    upload = Upload(bearer(token), body=b"commit-one")
    assert await upload.answer(application) == 200
    assert json.loads(upload.body) == {"seq": 1}
    assert await RunCommit.unscoped.filter(run=run).acount() == 1
    # The view looks the token up again, once it has the body.
    assert lookups == [token, token]

    several = Upload([*bearer(token), *bearer(token)], path="/journal/2", body=b"commit-two")
    assert await several.answer(application) == 400
    assert several.reads == 0


@pytest.mark.parametrize(
    "end",
    [lambda run: services.cancel(run), lambda run: services.restart(run.id, run.attempt)],
    ids=["cancel", "restart"],
)
async def test_a_run_that_ends_during_the_upload_is_refused_by_the_view(application, claimed, end):
    run, token = claimed
    upload = Upload(bearer(token), body=b"x" * (3 * CHUNK))
    upload.flowing.clear()
    task = upload.start(application)
    await asyncio.wait_for(upload.read.wait(), 10)
    await sync_to_async(end)(run)
    upload.flowing.set()
    await asyncio.wait_for(task, 10)
    assert (upload.status, upload.body) == (401, INACTIVE)
    assert not await RunCommit.unscoped.filter(run=run).aexists()


@asynccontextmanager
async def serving(app):
    """Runs the app's lifespan around the block, as the server does around its requests."""
    messages: asyncio.Queue[dict] = asyncio.Queue()
    sent: list[str] = []
    started = asyncio.Event()

    async def send(message: dict) -> None:
        sent.append(message["type"])
        started.set()

    lifespan = asyncio.create_task(app({"type": "lifespan", "asgi": {"version": "3.0"}}, messages.get, send))
    await messages.put({"type": "lifespan.startup"})
    await asyncio.wait_for(started.wait(), 10)
    assert sent == ["lifespan.startup.complete"]
    try:
        yield
    finally:
        await messages.put({"type": "lifespan.shutdown"})
        await asyncio.wait_for(lifespan, 10)


@pytest.fixture
def mcp_server(monkeypatch):
    """A new MCP app for the gateway to route to, since an app's lifespan runs once."""
    monkeypatch.setattr(mcp.server, "_session_manager", None)
    monkeypatch.setattr(mcp, "_starlette", mcp._streamable_app())


def rpc(method: str, **params) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()


@pytest.mark.usefixtures("mcp_server")
async def test_mcp_requests_are_checked_once_before_their_body_is_read(application, claimed, lookups):
    _, token = claimed
    async with serving(application):
        listed = Upload([*bearer(token), *MCP_HEADERS], method="POST", path="/mcp", body=rpc("tools/list"))
        assert await listed.answer(application) == 200
        assert "todoist_list_tasks" in {tool["name"] for tool in json.loads(listed.body)["result"]["tools"]}
        # The MCP server takes the run from the gate rather than looking the token up again.
        assert lookups == [token]

        unread = Upload([*bearer(INVENTED), *MCP_HEADERS], method="POST", path="/mcp", body=rpc("tools/list"))
        unread.flowing.clear()
        assert await unread.answer(application) == 401
        assert (unread.reads, unread.body) == (0, INACTIVE)

        # Other methods are refused once the token is checked, without a read either.
        for credential, status in ((INVENTED, 401), (token, 405)):
            stream = Upload([*bearer(credential), *MCP_HEADERS], method="GET", path="/mcp")
            assert await stream.answer(application) == status
            assert stream.reads == 0


@pytest.mark.usefixtures("mcp_server")
@pytest.mark.parametrize("restart", [False, True], ids=["cancel", "restart"])
async def test_a_tool_call_whose_run_ends_during_the_upload_does_nothing(
    application, claimed, todoist, restart
):
    run, token = claimed
    # Padded so the body arrives in several parts.
    call = rpc(
        "tools/call", name="todoist_list_tasks", arguments={"project_id": "work"}, _meta={"pad": "x" * CHUNK}
    )
    async with serving(application):
        upload = Upload([*bearer(token), *MCP_HEADERS], method="POST", path="/mcp", body=call)
        upload.flowing.clear()
        task = upload.start(application)
        await asyncio.wait_for(upload.read.wait(), 10)
        if restart:
            _, replacement = await sync_to_async(services.restart)(run.id, 1)
        else:
            await sync_to_async(services.cancel)(run)
        upload.flowing.set()
        await asyncio.wait_for(task, 10)
        result = json.loads(upload.body)["result"]
        assert result["isError"] and "no longer active" in result["content"][0]["text"]
        assert todoist.calls == []

        if restart:
            # The call runs under the attempt its token was checked for, not the run's current one.
            again = Upload([*bearer(replacement), *MCP_HEADERS], method="POST", path="/mcp", body=call)
            assert await again.answer(application) == 200
            assert not json.loads(again.body)["result"].get("isError")
            assert todoist.calls


async def test_at_most_max_checking_checks_are_queued(monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow_lookup(token: str) -> None:
        started.set()
        release.wait(10)

    monkeypatch.setattr(auth, "run_for_token", slow_lookup)
    gate = require_run(Reached(), 2)
    waiting = [Upload(bearer(INVENTED)) for _ in range(2)]
    tasks = [request.start(gate) for request in waiting]
    try:
        await asyncio.to_thread(started.wait, 10)
        busy = Upload(bearer(INVENTED))
        assert await busy.answer(gate) == 503
        assert (busy.body, busy.reads) == (BUSY, 0)
        # A request without a usable token is refused without waiting, as always.
        for headers in ([], bearer("x" * 201)):
            assert await Upload(headers).answer(gate) == 401

        # A cancelled request's check still runs, and holds its place until it has: running or queued.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        assert await Upload(bearer(INVENTED)).answer(gate) == 503
    finally:
        release.set()
    # Queued behind both lookups on the shared thread.
    await asyncio.wait_for(sync_to_async(lambda: None)(), 10)
    await settle()
    assert [request.sent for request in waiting] == [[], []]
    assert await asyncio.gather(*(Upload(bearer(INVENTED)).answer(gate) for _ in range(2))) == [401, 401]


async def test_a_check_that_fails_gives_up_its_place(monkeypatch):
    def fails(token: str) -> None:
        raise OperationalError("the connection was lost")

    monkeypatch.setattr(auth, "run_for_token", fails)
    gate = require_run(Reached(), 1)
    with pytest.raises(OperationalError):
        await Upload(bearer(INVENTED)).answer(gate)
    monkeypatch.setattr(auth, "run_for_token", lambda token: None)
    assert await Upload(bearer(INVENTED)).answer(gate) == 401


def _backend_pid() -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        return cursor.fetchone()[0]


def _terminate(pid: int) -> None:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_terminate_backend(%s)", [pid])
    finally:
        connection.close()


async def test_a_dropped_connection_fails_one_check(claimed):
    """Tokens are checked on asgiref's shared thread, outside Django's request cycle, which is what closes a
    connection that failed."""
    run, token = claimed
    # The same thread as the checks: thread sensitive, with no request context.
    pid = await sync_to_async(_backend_pid)()
    await sync_to_async(_terminate, thread_sensitive=False)(pid)
    with pytest.raises(OperationalError):
        await auth.authenticate(f"Bearer {token}")
    assert (await auth.authenticate(f"Bearer {token}")).id == run.id
    assert await sync_to_async(_backend_pid)() != pid


async def test_other_scopes_pass_through():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    await require_run(app, 1)({"type": "lifespan"}, None, None)
    assert seen == ["lifespan"]
