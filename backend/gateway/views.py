"""Worker-facing endpoints: the run spec and the worker's own events. The worker only makes outbound calls
here, authenticated by its run token. The model relay is in gateway.relay, tools in gateway.mcp."""

import logging
from typing import Annotated, Literal

from asgiref.sync import sync_to_async
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from connectors import registry
from gateway.auth import error_response, run_required
from minerva.config import config
from models_access import upstream
from models_access.upstream import ModelUnavailable
from runs import services
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
            "code_mode": run.code_mode,
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
