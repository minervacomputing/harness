"""Live run updates for the browser as server-sent events.

`RunEvent` rows are the source of truth; Postgres NOTIFY only wakes streams up. One LISTEN connection
per web process fans notifications out to the streams it serves. Clients resume with `?after=<seq>` or
the `Last-Event-ID` header, so a dropped connection loses nothing.
"""

import asyncio
import json
import logging
from collections import defaultdict
from uuid import UUID

import psycopg
from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse, StreamingHttpResponse
from django.views.decorators.http import require_GET

from runs.models import Run, RunEvent
from runs.services import EVENTS_CHANNEL
from workspaces.models import Membership

log = logging.getLogger(__name__)
KEEPALIVE_SECONDS = 15


class Broker:
    def __init__(self) -> None:
        self._waiters: dict[str, set[asyncio.Event]] = defaultdict(set)
        self._task: asyncio.Task | None = None

    def subscribe(self, run_id: UUID) -> asyncio.Event:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._listen())
        event = asyncio.Event()
        self._waiters[str(run_id)].add(event)
        return event

    def unsubscribe(self, run_id: UUID, event: asyncio.Event) -> None:
        waiters = self._waiters.get(str(run_id))
        if waiters is not None:
            waiters.discard(event)
            if not waiters:
                del self._waiters[str(run_id)]

    def _wake(self, run_id: str | None = None) -> None:
        groups = [self._waiters.get(run_id, set())] if run_id else list(self._waiters.values())
        for group in groups:
            for event in group:
                event.set()

    async def _listen(self) -> None:
        while True:
            try:
                async with await psycopg.AsyncConnection.connect(
                    settings.DIRECT_DATABASE_URL, autocommit=True
                ) as conn:
                    await conn.execute(f"LISTEN {EVENTS_CHANNEL}")
                    self._wake()  # re-query after (re)connecting, in case notifications were missed
                    async for notify in conn.notifies():
                        self._wake(notify.payload.partition(":")[0])
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("Run event listener disconnected; reconnecting", exc_info=True)
                await asyncio.sleep(2)


broker = Broker()


def _frame(event: RunEvent) -> str:
    return f"id: {event.seq}\nevent: {event.type}\ndata: {json.dumps(event.data)}\n\n"


@require_GET
async def run_stream(request: HttpRequest, workspace_id: UUID, run_id: UUID) -> HttpResponse:
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({"detail": "Unauthorized"}, status=401)
    if not await Membership.objects.filter(workspace_id=workspace_id, user=user).aexists():
        return JsonResponse({"detail": "Not found"}, status=404)
    run = await Run.unscoped.filter(pk=run_id, workspace_id=workspace_id, user=user).afirst()
    if run is None:
        return JsonResponse({"detail": "Not found"}, status=404)
    raw_after = request.headers.get("Last-Event-ID") or request.GET.get("after") or "0"
    after = int(raw_after) if raw_after.isdigit() else 0

    async def stream():
        cursor = after
        wakeup = broker.subscribe(run_id)
        try:
            while True:
                wakeup.clear()
                async for event in RunEvent.unscoped.filter(run_id=run_id, seq__gt=cursor).order_by("seq")[
                    :500
                ]:
                    cursor = event.seq
                    yield _frame(event)
                current = await Run.unscoped.only("status", "event_seq").aget(pk=run_id)
                if current.status not in Run.ACTIVE and cursor >= current.event_seq:
                    yield "event: end\ndata: {}\n\n"
                    return
                if cursor < current.event_seq:
                    continue
                try:
                    await asyncio.wait_for(wakeup.wait(), timeout=KEEPALIVE_SECONDS)
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            broker.unsubscribe(run_id, wakeup)

    response = StreamingHttpResponse(stream(), content_type="text/event-stream")
    response["Cache-Control"] = "no-store"
    response["X-Accel-Buffering"] = "no"
    return response
