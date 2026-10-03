"""The model relay: worker model calls, rebuilt, metered, and screened on their way to the provider."""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator

from asgiref.sync import sync_to_async
from django.core.exceptions import RequestDataTooBig
from django.db.models import F
from django.http import HttpRequest, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_POST

from gateway.auth import error_response, run_required
from models_access import upstream
from models_access.chat import build_chat_payload
from models_access.responses import build_responses_payload
from models_access.taps import ResponsesTap, StreamTap, StreamTooLarge
from models_access.upstream import ModelUnavailable, UpstreamResponse
from models_access.validate import InvalidModelRequest
from runs import services
from runs.models import Run, RunEvent

log = logging.getLogger(__name__)
REVOCATION_CHECK_SECONDS = 2.0
TEXT_FLUSH_SECONDS = 0.25
# Well above an output-capped response, including streamed reasoning.
MAX_RESPONSE_BYTES = 32_000_000


def _reserve_model_call(run_id) -> bool:
    active = Run.unscoped.filter(pk=run_id, status__in=Run.TOKEN_VALID, deadline__gt=timezone.now())
    return bool(active.filter(model_calls__lt=F("max_model_calls")).update(model_calls=F("model_calls") + 1))


def _publish_text(run_id, text: str) -> None:
    """Streaming progress comes from the trusted relay, not the worker. The final message still
    comes from the worker's completion, which replaces the draft."""
    if text and services.is_token_valid(run_id):
        services.append_event(run_id, RunEvent.Type.TEXT_DELTA, {"text": text})


def _settle(run_id, tap: StreamTap) -> None:
    _publish_text(run_id, tap.take_text())
    Run.unscoped.filter(pk=run_id).update(
        input_tokens=F("input_tokens") + tap.input_tokens,
        output_tokens=F("output_tokens") + tap.output_tokens,
        unmetered_model_calls=F("unmetered_model_calls") + (0 if tap.metered else 1),
    )


# Relays still reading from the provider. Tasks are held here so they are not collected mid-call.
_calls: set[asyncio.Task] = set()


async def _until_run_ends(run_id, task: asyncio.Task) -> bool:
    """Waits for the task. If the run ends first (stopped, finished, or past its deadline), cancels the
    task and returns False. Checked on a timer, so a run ends even while the provider is silent."""
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=REVOCATION_CHECK_SECONDS)
            if not task.done() and not await sync_to_async(services.is_token_valid)(run_id):
                task.cancel()
                await asyncio.wait({task})
                return False
    except asyncio.CancelledError:
        task.cancel()
        raise
    return True


async def _close(upstream_cm, run_id) -> None:
    try:
        await upstream_cm.__aexit__(None, None, None)
    except Exception:
        log.exception("Could not close the model call for run %s", run_id)


async def _abandon(opening: asyncio.Task, upstream_cm, run_id) -> None:
    """The call is given up before it is relayed. The provider may have answered meanwhile; if so, its
    response is closed. What had started is not metered."""
    try:
        # Cancelled, it may still be finishing; a call can complete despite its cancellation.
        await asyncio.wait({opening})
        if not opening.cancelled() and opening.exception() is None:
            await _close(upstream_cm, run_id)
    finally:
        await sync_to_async(_settle)(run_id, StreamTap())


class ModelCall:
    """One relayed model call. The provider's stream is read to its end by a task of its own, so usage
    is recorded even if the worker hangs up early. Only the run ending cuts the stream short; the call
    then counts as unmetered."""

    def __init__(self, run_id, tap: StreamTap, upstream_cm, upstream: UpstreamResponse):
        self.run_id = run_id
        self.tap = tap
        self._upstream_cm = upstream_cm
        self._upstream = upstream
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._delivering = True

    def start(self) -> None:
        task = asyncio.create_task(self._run())
        _calls.add(task)
        task.add_done_callback(_calls.discard)

    async def stream(self) -> AsyncIterator[bytes]:
        """What the worker receives."""
        try:
            while (data := await self._queue.get()) is not None:
                yield data
        finally:
            self._delivering = False

    def _send(self, data: bytes) -> None:
        if data and self._delivering:
            self._queue.put_nowait(data)

    def _drop(self) -> None:
        """The run ended: what the worker has not read yet is not delivered."""
        self._delivering = False
        while not self._queue.empty():
            self._queue.get_nowait()

    async def _run(self) -> None:
        reading = asyncio.create_task(self._read())
        try:
            if await _until_run_ends(self.run_id, reading):
                reading.result()
            else:
                self._drop()
        except StreamTooLarge:
            log.warning("Model response for run %s exceeded the size limit", self.run_id)
        except Exception:
            log.warning("Model stream interrupted for run %s", self.run_id, exc_info=True)
        finally:
            try:
                reading.cancel()
                await asyncio.wait({reading})
                await _close(self._upstream_cm, self.run_id)
                await self._record()
            finally:
                self._queue.put_nowait(None)

    async def _record(self) -> None:
        if self.tap.error_code:
            # Provider diagnostics stay private, as for non-200 responses.
            log.warning("Model provider reported %s for run %s", self.tap.error_code, self.run_id)
        try:
            await sync_to_async(_settle)(self.run_id, self.tap)
        except Exception:
            log.exception("Could not record the model call for run %s", self.run_id)

    async def _read(self) -> None:
        size = 0
        last_flush = time.monotonic()
        async for chunk in self._upstream.chunks:
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise StreamTooLarge
            self._send(self.tap.feed(chunk))
            if time.monotonic() - last_flush > TEXT_FLUSH_SECONDS:
                last_flush = time.monotonic()
                await sync_to_async(_publish_text)(self.run_id, self.tap.take_text())
        self._send(self.tap.finish())


@require_POST
@run_required
async def chat_completions(request: HttpRequest):
    return await _relay(request, "chat")


@require_POST
@run_required
async def responses(request: HttpRequest):
    return await _relay(request, "responses")


async def _relay(request: HttpRequest, api: str):
    run: Run = request.run  # type: ignore[attr-defined]
    try:
        body = json.loads(request.body)
    except RequestDataTooBig:
        return error_response("The request is too large.", 413)
    except ValueError:
        return error_response("Invalid JSON.", 400)
    if not isinstance(body, dict):
        return error_response("A JSON object is required.", 400)
    try:
        provider, target = upstream.route(run.model_alias)
    except ModelUnavailable as error:
        return error_response(str(error), 503)
    # One API per instance, so there is one validated path to the provider.
    if target.api != api:
        return error_response("This instance does not serve this model API.", 404)
    try:
        payload = build_chat_payload(body, target) if api == "chat" else build_responses_payload(body, target)
    except InvalidModelRequest as error:
        return error_response(str(error), 400)
    if not await sync_to_async(_reserve_model_call)(run.id):
        if not await sync_to_async(services.is_token_valid)(run.id):
            return error_response("This run has ended.", 401)
        return error_response("This run reached its model request limit.", 429)

    upstream_cm = provider.chat_completions(payload) if api == "chat" else provider.responses(payload)
    opening = asyncio.create_task(upstream_cm.__aenter__())
    try:
        opened = await _until_run_ends(run.id, opening)
    except asyncio.CancelledError:
        # The worker hung up before the provider answered.
        await _abandon(opening, upstream_cm, run.id)
        raise
    if not opened:
        await _abandon(opening, upstream_cm, run.id)
        return error_response("This run has ended.", 401)
    try:
        reply = opening.result()
    except ModelUnavailable as error:
        return error_response(str(error), 502)
    if reply.status != 200:
        await _close(upstream_cm, run.id)
        # Provider diagnostics stay private; nothing from the upstream body reaches the worker.
        log.warning("Model provider returned HTTP %s for run %s", reply.status, run.id)
        return error_response(f"The model provider rejected the request (HTTP {reply.status}).", 502)
    if reply.content_type.split(";")[0].strip().lower() != "text/event-stream":
        # Only streams are requested, and only event streams are screened. The provider answered, so the
        # call counts, unmetered.
        await _close(upstream_cm, run.id)
        await sync_to_async(_settle)(run.id, StreamTap())
        log.warning("Model provider answered %s for run %s", reply.content_type, run.id)
        return error_response("The model provider returned an unexpected response.", 502)

    call = ModelCall(run.id, StreamTap() if api == "chat" else ResponsesTap(), upstream_cm, reply)
    call.start()
    response = StreamingHttpResponse(call.stream(), content_type=reply.content_type)
    response["Cache-Control"] = "no-store"
    return response
