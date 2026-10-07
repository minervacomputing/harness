"""Worker-facing endpoints: the run spec, the worker's own events and its saved state. The worker only makes
outbound calls here, authenticated by its run token. The model relay is in gateway.relay, tools in
gateway.mcp."""

import logging
from typing import Annotated, Literal

from asgiref.sync import sync_to_async
from django.db import transaction
from django.db.models import F
from django.db.models.functions import Coalesce
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from connectors import registry
from files import limits as file_limits
from files import runs as folder
from gateway.auth import error_response, run_required, unauthorized
from minerva.config import config
from models_access import upstream
from models_access.upstream import ModelUnavailable
from runs import journal as journal_store
from runs import services
from runs.journal import Appended
from runs.models import Run, RunEvent

log = logging.getLogger(__name__)
# Tools the worker runs in the sandbox's folder. Every run has all of them for now.
LOCAL_TOOLS = ["read", "write", "edit", "bash"]


@require_GET
@run_required
async def run_spec(request: HttpRequest) -> JsonResponse:
    run: Run = request.run  # type: ignore[attr-defined]
    await sync_to_async(_start)(run.id, run.attempt)
    prompt = await sync_to_async(services.current_prompt)(run)
    history = await sync_to_async(services.history)(run)
    version = await sync_to_async(folder.hydrate_version)(run)
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
                "deadline": run.deadline.isoformat() if run.deadline is not None else None,
                "folder_bytes": file_limits.folder_bytes(),
                "folder_entries": file_limits.folder_entries(),
            },
            # The version to hydrate: the run's last checkpoint, else the one it started from. Its id is the
            # parent of the attempt's first checkpoint.
            "folder": {"version": str(version.id) if version else None, **folder.wire_entries(version)},
            "local_tools": LOCAL_TOOLS,
        }
    )


def _start(run_id, attempt: int) -> None:
    """The attempt's worker asked for its spec, so it is running. A run that restarts keeps its first start
    time."""
    with transaction.atomic():
        started = Run.unscoped.filter(pk=run_id, attempt=attempt, status=Run.Status.PROVISIONING).update(
            status=Run.Status.RUNNING, started_at=Coalesce(F("started_at"), timezone.now())
        )
        if started:
            services.append_event(run_id, RunEvent.Type.STATUS, {"status": Run.Status.RUNNING})


class WorkerEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seq: Annotated[int, Field(ge=1)]
    type: Literal["phase", "completed", "failed"]
    text: Annotated[str, Field(max_length=100_000)] = ""


class WorkerEvents(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: Annotated[list[WorkerEvent], Field(max_length=100)]


def _accept_worker_seq(run_id, attempt: int, seq: int) -> bool:
    """Each attempt's worker numbers its events from 1; the count restarts with the attempt."""
    runs = Run.unscoped.filter(pk=run_id, attempt=attempt, worker_seq__lt=seq)
    return bool(runs.update(worker_seq=seq))


def _apply_events(run: Run, events: list[WorkerEvent]) -> None:
    """Only the attempt that authenticated the request is heard; an earlier attempt's events are dropped. An
    event is accepted together with its effect, so a worker that retries after a failure is heard again."""
    for event in sorted(events, key=lambda item: item.seq):
        with transaction.atomic():
            if not _accept_worker_seq(run.id, run.attempt, event.seq):
                continue
            if not services.is_current(run.id, run.attempt):
                return
            _apply_event(run, event)


def _apply_event(run: Run, event: WorkerEvent) -> None:
    match event.type:
        case "phase":
            services.append_event(
                run.id, RunEvent.Type.PHASE, {"text": event.text[:300]}, attempt=run.attempt
            )
        case "completed":
            services.complete(run.id, event.text, attempt=run.attempt)
        case "failed":
            log.info("Worker reported failure for run %s: %s", run.id, event.text[:500])
            services.finish(
                run.id,
                Run.Status.FAILED,
                code="worker_failed",
                message="The agent could not finish this run. Try again.",
                attempt=run.attempt,
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
