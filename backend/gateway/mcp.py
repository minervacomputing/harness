"""Integration tools for the worker over MCP (streamable HTTP, stateless, JSON responses).

Each request is authenticated by the run token before it reaches the MCP server. Tools come from the
run's snapshot, and every call goes through the permission executor. Tool events are recorded here, on
the trusted side, rather than trusting the worker to report them.
"""

import asyncio
import json
import logging
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import UUID

import mcp_types as types
from asgiref.sync import sync_to_async
from django.db import connection as db
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import Receive, Scope, Send

from connectors import registry
from connectors.base import OperationError
from connectors.executor import RESULT_SCHEMA, Executor, RunContext, public_error
from gateway.asgi_json import send_error
from gateway.auth import authenticate
from minerva.config import config
from runs import services
from runs.models import Run, RunEvent
from workspaces.tenancy import activate_workspace

log = logging.getLogger(__name__)
RUN_SCOPE_KEY = "minerva.run_id"
# The attempt current when the request was authenticated; the run may move on while the request runs.
ATTEMPT_SCOPE_KEY = "minerva.attempt"
DENIAL_CODES = {
    "POLICY_DENIED",
    "LIMIT_REACHED",
    "WRITE_UNCERTAIN",
    "WRITE_IN_PROGRESS",
    "INVALID_CURSOR",
    "CONSENT_REQUIRED",
    "OPERATION_CHANGED",
}
RUN_ENDED = "This run is no longer active."
# Semaphores of runs with calls in flight; a run's entry goes away with its last call.
_slots: weakref.WeakValueDictionary[UUID, asyncio.Semaphore] = weakref.WeakValueDictionary()


async def _context(ctx) -> RunContext:
    scope = ctx.request.scope
    run = await Run.unscoped.aget(pk=scope[RUN_SCOPE_KEY])
    activate_workspace(run.workspace_id)
    return RunContext.from_run(run, attempt=scope[ATTEMPT_SCOPE_KEY])


async def list_tools(ctx, params) -> types.ListToolsResult:
    context = await _context(ctx)
    tools = []
    for name, ref in context.tools.items():
        # A tool whose contract changed since the run started is left out; calling it says why.
        op = registry.resolve(ref.provider, ref.operation, ref.contract)
        if op is None:
            continue
        tools.append(
            types.Tool(
                name=name,
                title=op.title,
                description=op.description,
                input_schema=op.input_schema(),
                output_schema=RESULT_SCHEMA,
                # The worker runs writes one at a time; a second write in the same window would be refused.
                annotations=types.ToolAnnotations(read_only_hint=not op.mutates),
            )
        )
    return types.ListToolsResult(tools=tools)


def _label(context: RunContext, name: str) -> str:
    """How the tool is shown in the conversation, for example "Google Calendar: List calendars"."""
    ref = context.tools.get(name)
    try:
        connector = registry.get(ref.provider) if ref else None
    except LookupError:
        connector = None
    op = connector.operation(ref.operation) if connector and ref else None
    if not (connector and ref and op):
        return name
    # A second connection to the same provider is numbered: todoist2_list_tasks.
    number = ref.name.removesuffix(f"_{ref.operation}").removeprefix(ref.provider)
    return f"{connector.name}{f' ({number})' if number else ''}: {op.title}"


def _summary(arguments: dict[str, Any]) -> dict[str, Any]:
    text = json.dumps(arguments, default=str)
    return arguments if len(text) <= 2000 else {"truncated": text[:2000]}


def _write_id(context: RunContext, write_key: str) -> str:
    """Lets the chat match a repeated write to the write's own card, whose arguments may be shown cut short. Keyed, so
    it tells nothing about the arguments, and differs between runs."""
    return salted_hmac("minerva.gateway.write", f"{context.run_id}:{write_key}").hexdigest()[:32]


class ToolLimitReached(OperationError):
    def __init__(self, limit: int) -> None:
        super().__init__("LIMIT_REACHED", f"This run has reached its limit of {limit} tool calls.")


def _reserve_tool_call(context: RunContext, event: dict[str, Any]) -> datetime:
    """Counts the call and returns the run's deadline. One statement, so concurrent calls cannot both take
    the last one. The count stops one past the limit: the call that crosses it records its refusal in the
    same transaction, and later ones are refused without writing anything, so a worker that keeps calling
    cannot flood the conversation or the database. A replaced attempt's calls are refused as if the run had
    ended."""
    run_id = context.run_id
    params = [run_id, context.attempt, [status.value for status in Run.TOKEN_VALID]]
    with transaction.atomic(), db.cursor() as cursor:
        cursor.execute(
            "UPDATE runs_run SET tool_calls = tool_calls + 1"
            " WHERE id = %s AND attempt = %s AND status = ANY(%s) AND deadline > now()"
            " AND tool_calls <= max_tool_calls"
            " RETURNING tool_calls, max_tool_calls, deadline",
            params,
        )
        reserved = cursor.fetchone()
        if reserved is None:
            cursor.execute(
                "SELECT max_tool_calls FROM runs_run"
                " WHERE id = %s AND attempt = %s AND status = ANY(%s) AND deadline > now()",
                params,
            )
            refused = cursor.fetchone()
            if refused is None:
                raise OperationError("RUN_ENDED", RUN_ENDED)
            raise ToolLimitReached(refused[0])
        count, limit, deadline = reserved
        if count <= limit:
            return deadline
        refusal = ToolLimitReached(limit)
        denial = {"decision": "denied", "code": refusal.code, "message": refusal.message}
        services.append_event(run_id, RunEvent.Type.TOOL_CALL, {**event, **denial})
    raise refusal


@asynccontextmanager
async def _slot(run_id: UUID, deadline: datetime) -> AsyncIterator[None]:
    """Waits until fewer than run_tool_concurrency of the run's calls execute. The limit holds per gateway
    process; there is one in development and in the demo. The count limit holds across processes."""
    semaphore = _slots.get(run_id)
    if semaphore is None:
        semaphore = _slots[run_id] = asyncio.Semaphore(config().run_tool_concurrency)
    try:
        async with asyncio.timeout((deadline - timezone.now()).total_seconds()):
            await semaphore.acquire()
    except TimeoutError:
        raise OperationError("RUN_ENDED", RUN_ENDED) from None
    try:
        yield
    finally:
        semaphore.release()


async def call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
    context = await _context(ctx)
    arguments = params.arguments or {}
    event: dict[str, Any] = {
        "tool": params.name,
        "label": _label(context, params.name),
        "arguments": _summary(arguments),
    }
    try:
        deadline = await sync_to_async(_reserve_tool_call)(context, event)
        # A call that waited past a revocation is refused by the executor before it does anything.
        async with _slot(context.run_id, deadline):
            outcome = await Executor(context).invoke(params.name, arguments)
    except Exception as error:
        if not isinstance(error, OperationError):
            log.exception("Tool %s failed for run %s", params.name, context.run_id)
        message = public_error(error)
        code = error.code if isinstance(error, OperationError) else "FAILED"
        decision = "denied" if code in DENIAL_CODES else "error"
        event.update(decision=decision, code=code, message=message)
        # Refusals past the tool-call limit are recorded once, when the limit is crossed. A call refused
        # because the run ended, or its attempt was replaced, is not shown.
        if not isinstance(error, ToolLimitReached) and code != "RUN_ENDED":
            await _record(context, event)
        return types.CallToolResult(content=[types.TextContent(type="text", text=message)], is_error=True)
    event.update(decision="allowed", title=outcome.title, count=outcome.result.get("count"))
    if outcome.write_key:
        event["write"] = _write_id(context, outcome.write_key)
    if outcome.repeat:
        event["repeat"] = True
    await _record(context, event)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(outcome.result, default=str))],
        structured_content=outcome.result,
    )


async def _record(context: RunContext, event: dict[str, Any]) -> None:
    """Records a call that started under a replaced attempt too: what it did is still part of the run."""
    if await sync_to_async(services.is_token_valid)(context.run_id):
        await sync_to_async(services.append_event)(context.run_id, RunEvent.Type.TOOL_CALL, event)


server = Server("minerva-gateway", version="0.1.0", on_list_tools=list_tools, on_call_tool=call_tool)
_starlette = server.streamable_http_app(
    streamable_http_path="/mcp",
    json_response=True,
    stateless_http=True,
    # The run token authenticates every request; host/origin checks add nothing for non-browser workers.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    max_request_body_size=512 * 1024,
)


async def mcp_app(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] == "lifespan":
        await _starlette(scope, receive, send)
        return
    headers = {key.decode("latin-1"): value.decode("latin-1") for key, value in scope.get("headers", [])}
    run = await authenticate(headers.get("authorization"))
    if run is None:
        await _unauthorized(send)
        return
    await _starlette({**scope, RUN_SCOPE_KEY: run.id, ATTEMPT_SCOPE_KEY: run.attempt}, receive, send)


async def _unauthorized(send: Send) -> None:
    await send_error(send, 401, "Inactive run credential.")
