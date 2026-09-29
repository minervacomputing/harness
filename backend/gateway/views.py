"""Worker-facing endpoints. The worker only makes outbound calls here, authenticated by its run token."""

import asyncio
import json
import logging
import time
from typing import Annotated, Literal

from asgiref.sync import sync_to_async
from django.db.models import F
from django.http import HttpRequest, JsonResponse, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from connectors import registry
from gateway.auth import run_required
from models_access.providers import ModelUnavailable, StreamTap, build_payload, route
from runs import services
from runs.models import Run, RunEvent

log = logging.getLogger(__name__)
REVOCATION_CHECK_SECONDS = 2.0
TEXT_FLUSH_SECONDS = 0.25


def _error(message: str, status: int) -> JsonResponse:
    return JsonResponse({"error": {"message": message}}, status=status)


@require_GET
@run_required
async def run_spec(request: HttpRequest) -> JsonResponse:
    run: Run = request.run  # type: ignore[attr-defined]
    started = await Run.unscoped.filter(pk=run.pk, status=Run.Status.PROVISIONING).aupdate(
        status=Run.Status.RUNNING, started_at=timezone.now()
    )
    if started:
        await sync_to_async(services.append_event)(
            run.id, RunEvent.Type.STATUS, {"status": Run.Status.RUNNING}
        )
    prompt = await sync_to_async(services.current_prompt)(run)
    history = await sync_to_async(services.history)(run)
    tools = []
    for item in run.tools:
        op = registry.get(item["provider"]).operation(item["operation"])
        if op is not None:
            tools.append({"name": item["name"], "title": op.title})
    try:
        _, target = route(run.model_alias)
        max_output_tokens = target.max_output_tokens
    except ModelUnavailable:
        max_output_tokens = 4096
    return JsonResponse(
        {
            "run_id": str(run.id),
            "prompt": prompt,
            "history": history,
            "instructions": run.instructions,
            "tools": tools,
            "model": {"alias": run.model_alias, "max_output_tokens": max_output_tokens},
            "limits": {"deadline": run.deadline.isoformat(), "max_model_calls": run.max_model_calls},
        }
    )


class WorkerEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seq: Annotated[int, Field(ge=1)]
    type: Literal["phase", "completed", "failed"]
    text: Annotated[str, Field(max_length=100_000)] = ""


class WorkerEvents(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: Annotated[list[WorkerEvent], Field(max_length=100)]


def _accept_worker_seq(run_id, seq: int) -> bool:
    return bool(Run.unscoped.filter(pk=run_id, worker_seq__lt=seq).update(worker_seq=seq))


def _apply_events(run: Run, events: list[WorkerEvent]) -> None:
    for event in sorted(events, key=lambda item: item.seq):
        if not _accept_worker_seq(run.id, event.seq):
            continue
        if not services.is_token_valid(run.id):
            return
        match event.type:
            case "phase":
                services.append_event(run.id, RunEvent.Type.PHASE, {"text": event.text[:300]})
            case "completed":
                services.complete(run.id, event.text)
            case "failed":
                log.info("Worker reported failure for run %s: %s", run.id, event.text[:500])
                services.finish(
                    run.id,
                    Run.Status.FAILED,
                    code="worker_failed",
                    message="The agent could not finish this run. Try again.",
                )


@require_POST
@run_required
async def events(request: HttpRequest) -> JsonResponse:
    try:
        batch = WorkerEvents.model_validate_json(request.body)
    except ValidationError:
        return _error("Invalid event batch.", 400)
    await sync_to_async(_apply_events)(request.run, batch.events)  # type: ignore[attr-defined]
    return JsonResponse({"accepted": True})


def _reserve_model_call(run_id) -> bool:
    return bool(
        Run.unscoped.filter(pk=run_id, model_calls__lt=F("max_model_calls")).update(
            model_calls=F("model_calls") + 1
        )
    )


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
    )


@require_POST
@run_required
async def chat_completions(request: HttpRequest):
    run: Run = request.run  # type: ignore[attr-defined]
    try:
        body = json.loads(request.body)
    except ValueError:
        return _error("Invalid JSON.", 400)
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("messages"), list)
        or len(body["messages"]) > 500
    ):
        return _error("A messages list is required.", 400)
    try:
        provider, target = route(run.model_alias)
    except ModelUnavailable as error:
        return _error(str(error), 503)
    if not await sync_to_async(_reserve_model_call)(run.id):
        return _error("This run reached its model request limit.", 429)

    payload = build_payload(body, target)
    upstream_cm = provider.chat_completions(payload)
    try:
        upstream = await upstream_cm.__aenter__()
    except ModelUnavailable as error:
        return _error(str(error), 502)
    if upstream.status != 200:
        await upstream_cm.__aexit__(None, None, None)
        # Provider diagnostics stay private; nothing from the upstream body reaches the worker.
        log.warning("Model provider returned HTTP %s for run %s", upstream.status, run.id)
        return _error(f"The model provider rejected the request (HTTP {upstream.status}).", 502)

    async def relay():
        tap = StreamTap()
        last_check = last_flush = time.monotonic()
        try:
            async for chunk in upstream.chunks:
                tap.feed(chunk)
                now = time.monotonic()
                if now - last_check > REVOCATION_CHECK_SECONDS:
                    last_check = now
                    if not await sync_to_async(services.is_token_valid)(run.id):
                        return
                if now - last_flush > TEXT_FLUSH_SECONDS:
                    last_flush = now
                    await sync_to_async(_publish_text)(run.id, tap.take_text())
                yield chunk
        except asyncio.CancelledError, GeneratorExit:
            raise
        except Exception:
            log.warning("Model stream interrupted for run %s", run.id, exc_info=True)
        finally:
            await upstream_cm.__aexit__(None, None, None)
            tap.finish()
            await sync_to_async(_settle)(run.id, tap)

    response = StreamingHttpResponse(relay(), content_type=upstream.content_type)
    response["Cache-Control"] = "no-store"
    return response
