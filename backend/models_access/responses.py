"""Responses requests, rebuilt from validated parts before they reach the provider."""

from typing import Any

from models_access.upstream import Route
from models_access.validate import (
    MAX_INPUT_ITEMS,
    MAX_TOOLS,
    STREAM_REQUIRED,
    InvalidModelRequest,
    capped,
    copy_strings,
    copy_typed,
    items,
    text,
)

# The Responses API refuses smaller output caps.
MIN_RESPONSES_OUTPUT_TOKENS = 16


def _response_part(part: Any, *, output: bool = False) -> dict[str, Any]:
    kind = part.get("type") if isinstance(part, dict) else None
    if kind == "input_text":
        return {"type": kind, "text": text(part.get("text"), "Text")}
    if kind == "output_text" and not output:
        return {"type": kind, "text": text(part.get("text"), "Text"), "annotations": []}
    if kind == "refusal" and not output:
        return {"type": kind, "refusal": text(part.get("refusal"), "A refusal")}
    # input_image, input_file, input_audio: the provider would fetch a URL or read a stored file.
    raise InvalidModelRequest("Only text content is accepted.")


def _input_item(item: Any) -> dict[str, Any]:
    """Rebuilds one input item from the fields Minerva uses, so nothing else reaches the provider.

    Items that point at state stored with the provider (item_reference, file ids, reasoning without its
    encrypted content) are refused: the gateway never stores, and the key may be shared with other apps.
    """
    if not isinstance(item, dict):
        raise InvalidModelRequest("Each input item must be an object.")
    kind = item.get("type", "message")
    if kind == "message":
        role = item.get("role")
        if not isinstance(role, str) or role not in {"user", "assistant", "system", "developer"}:
            raise InvalidModelRequest("Unknown message role.")
        content = item.get("content")
        parts = (
            content
            if isinstance(content, str)
            else [_response_part(p) for p in items(content, "Message content", MAX_INPUT_ITEMS)]
        )
        return copy_strings(
            item, {"type": "message", "role": role, "content": parts}, "id", "status", "phase"
        )
    if kind == "function_call":
        out = {
            "type": kind,
            "call_id": text(item.get("call_id"), "call_id"),
            "name": text(item.get("name"), "name"),
            "arguments": text(item.get("arguments"), "arguments"),
        }
        return copy_strings(item, out, "id", "status")
    if kind == "function_call_output":
        output = item.get("output")
        if not isinstance(output, str):
            output = [_response_part(p, output=True) for p in items(output, "Tool output", MAX_INPUT_ITEMS)]
        out = {"type": kind, "call_id": text(item.get("call_id"), "call_id"), "output": output}
        return copy_strings(item, out, "id", "status")
    if kind == "reasoning":
        summary = [
            {"type": "summary_text", "text": text(s.get("text") if isinstance(s, dict) else None, "Summary")}
            for s in items(item.get("summary", []), "Reasoning summary", MAX_INPUT_ITEMS)
        ]
        out = {
            "type": kind,
            "id": text(item.get("id"), "id"),
            "encrypted_content": text(item.get("encrypted_content"), "Reasoning content"),
            "summary": summary,
        }
        return copy_strings(item, out, "status")
    raise InvalidModelRequest(f"Input items of type {kind!r} are not accepted.")


def _function_tool(tool: Any) -> dict[str, Any]:
    # Hosted tools (web search, file search, code interpreter, remote MCP, ...) run outside the sandbox.
    if not isinstance(tool, dict) or tool.get("type") != "function":
        raise InvalidModelRequest("Only function tools are accepted.")
    parameters = tool.get("parameters")
    if not isinstance(parameters, dict):
        raise InvalidModelRequest("Tool parameters must be an object.")
    # The Responses API treats a missing `strict` as true, which rejects most MCP input schemas.
    out = {
        "type": "function",
        "name": text(tool.get("name"), "Tool name"),
        "parameters": parameters,
        "strict": tool.get("strict") is True,
    }
    return copy_strings(tool, out, "description")


def _tool_choice(choice: Any) -> Any:
    if isinstance(choice, str) and choice in {"auto", "none", "required"}:
        return choice
    if isinstance(choice, dict) and choice.get("type") == "function":
        return {"type": "function", "name": text(choice.get("name"), "Tool name")}
    raise InvalidModelRequest("Unsupported tool_choice.")


def build_responses_payload(body: dict[str, Any], target: Route) -> dict[str, Any]:
    """A Responses request as the gateway will send it: rebuilt from validated parts, never passed through.
    Server-side state (previous_response_id, conversation, background, stored prompts), billing
    (service_tier) and reasoning are ours."""
    payload: dict[str, Any] = {
        "model": target.model,
        "input": [_input_item(item) for item in items(body.get("input"), "input", MAX_INPUT_ITEMS)],
        "store": False,
        "max_output_tokens": capped(body.get("max_output_tokens"), target.max_output_tokens),
    }
    # Raising a request to the provider's minimum could exceed Minerva's cap, so a smaller one is refused.
    if payload["max_output_tokens"] < MIN_RESPONSES_OUTPUT_TOKENS:
        raise InvalidModelRequest(f"max_output_tokens must be at least {MIN_RESPONSES_OUTPUT_TOKENS}.")
    if body.get("tools") is not None:
        payload["tools"] = [_function_tool(tool) for tool in items(body["tools"], "tools", MAX_TOOLS)]
    if body.get("tool_choice") is not None:
        payload["tool_choice"] = _tool_choice(body["tool_choice"])
    copy_typed(body, payload, (bool,), "a boolean", "parallel_tool_calls", "stream")
    if payload.get("stream") is not True:
        raise InvalidModelRequest(STREAM_REQUIRED)
    copy_typed(body, payload, (int, float), "a number", "temperature", "top_p")
    key = body.get("prompt_cache_key")
    if isinstance(key, str) and 0 < len(key) <= 64:
        payload["prompt_cache_key"] = key
    if target.reasoning_effort:
        # Without storage, reasoning survives between tool calls only as encrypted content.
        payload["reasoning"] = {"effort": target.reasoning_effort}
        if target.reasoning_summary:
            payload["reasoning"]["summary"] = target.reasoning_summary
        payload["include"] = ["reasoning.encrypted_content"]
    return payload
