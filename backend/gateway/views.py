"""Worker-facing endpoints: the run spec, the worker's own events and its saved state. The worker only makes
outbound calls here, authenticated by its run token. The model relay is in gateway.relay, tools in
gateway.mcp."""

import logging
from typing import Annotated, Literal

from asgiref.sync import sync_to_async
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from connectors import registry
from gateway.auth import error_response, run_required, unauthorized
from minerva.config import config
from models_access import upstream
from models_access.upstream import ModelUnavailable
from runs import journal as journal_store
from runs import services
from runs.journal import Appended
from runs.models import Run, RunEvent

log = logging.getLogger(__name__)


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
        op = registry.resolve(item["provider"], item["operation"], item.get("contract", ""))
        if op is not None:
            tools.append({"name": item["name"], "title": op.title})
    try:
        _, target = upstream.route(run.model_alias)
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
            "model": {
                "alias": run.model_alias,
                "api": config().model_api,
                "max_output_tokens": max_output_tokens,
            },
            "limits": {
                "deadline": run.deadline.isoformat(),
                "max_model_calls": run.max_model_calls,
                "max_tool_calls": run.max_tool_calls,
            },
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
        return error_response("Invalid event batch.", 400)
    await sync_to_async(_apply_events)(request.run, batch.events)  # type: ignore[attr-defined]
    return JsonResponse({"accepted": True})


@require_GET
@run_required
async def journal(request: HttpRequest) -> JsonResponse:
    run: Run = request.run  # type: ignore[attr-defined]
    try:
        seq = await sync_to_async(journal_store.last)(run.id, run.attempt)
    except journal_store.Inactive:
        return unauthorized()
    return JsonResponse({"seq": seq})


@require_http_methods(["GET", "PUT"])
@run_required
async def journal_commit(request: HttpRequest, seq: int) -> HttpResponse:
    """GET returns commit `seq` as stored; PUT stores it. The body is opaque and is never parsed."""
    run: Run = request.run  # type: ignore[attr-defined]
    try:
        if request.method == "GET":
            data = await sync_to_async(journal_store.read)(run.id, run.attempt, seq)
            if data is None:
                return error_response("There is no such commit.", 404)
            return HttpResponse(data, content_type="application/octet-stream")
        appended = await sync_to_async(journal_store.append)(run.id, run.attempt, seq, request.body)
    except journal_store.Inactive:
        return unauthorized()
    match appended:
        case Appended.STORED | Appended.DUPLICATE:
            return JsonResponse({"seq": seq})
        case Appended.CONFLICT:
            return error_response("This commit does not follow the saved state.", 409)
        case Appended.TOO_LARGE:
            return error_response(journal_store.TOO_LARGE, 413)
        case Appended.EMPTY:
            return error_response("A commit cannot be empty.", 400)
