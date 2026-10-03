"""Integration tools for the worker over MCP (streamable HTTP, stateless, JSON responses).

Each request is authenticated by the run token before it reaches the MCP server. Tools come from the
run's snapshot, and every call goes through the permission executor. Tool events are recorded here, on
the trusted side, rather than trusting the worker to report them.
"""

import json
import logging
from typing import Any

import mcp_types as types
from asgiref.sync import sync_to_async
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import Receive, Scope, Send

from connectors import registry
from connectors.base import OperationError
from connectors.executor import Executor, RunContext, public_error
from gateway.asgi_json import send_error
from gateway.auth import authenticate
from runs import services
from runs.models import Run, RunEvent
from workspaces.tenancy import activate_workspace

log = logging.getLogger(__name__)
RUN_SCOPE_KEY = "minerva.run_id"
DENIAL_CODES = {
    "POLICY_DENIED",
    "LIMIT_REACHED",
    "WRITE_UNCERTAIN",
    "WRITE_IN_PROGRESS",
    "INVALID_CURSOR",
    "CONSENT_REQUIRED",
    "OPERATION_CHANGED",
}


async def _context(ctx) -> RunContext:
    run_id = ctx.request.scope[RUN_SCOPE_KEY]
    run = await Run.unscoped.aget(pk=run_id)
    activate_workspace(run.workspace_id)
    return RunContext.from_run(run)


async def list_tools(ctx, params) -> types.ListToolsResult:
    context = await _context(ctx)
    tools = []
    for name, ref in context.tools.items():
        # A tool whose contract changed since the run started is left out; calling it says why.
        op = registry.resolve(ref.provider, ref.operation, ref.contract)
        if op is None:
            continue
        tools.append(
            types.Tool(name=name, title=op.title, description=op.description, input_schema=op.input_schema())
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


async def call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
    context = await _context(ctx)
    arguments = params.arguments or {}
    event: dict[str, Any] = {
        "tool": params.name,
        "label": _label(context, params.name),
        "arguments": _summary(arguments),
    }
    try:
        outcome = await Executor(context).invoke(params.name, arguments)
    except Exception as error:
        if not isinstance(error, OperationError):
            log.exception("Tool %s failed for run %s", params.name, context.run_id)
        message = public_error(error)
        code = error.code if isinstance(error, OperationError) else "FAILED"
        decision = "denied" if code in DENIAL_CODES else "error"
        event.update(decision=decision, code=code, message=message)
        await _record(context, event)
        return types.CallToolResult(content=[types.TextContent(type="text", text=message)], is_error=True)
    event.update(decision="allowed", title=outcome.title, count=outcome.result.get("count"))
    await _record(context, event)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(outcome.result, default=str))],
        structured_content=outcome.result,
    )


async def _record(context: RunContext, event: dict[str, Any]) -> None:
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
    await _starlette({**scope, RUN_SCOPE_KEY: run.id}, receive, send)


async def _unauthorized(send: Send) -> None:
    await send_error(send, 401, "Inactive run credential.")
