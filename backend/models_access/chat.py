"""Chat Completions requests, rebuilt from validated parts before they reach the provider."""

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

# The Chat Completions limit.
MAX_STOP_SEQUENCES = 4

ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})
# Reasoning text that OpenAI-compatible servers (DeepSeek, vLLM, llama.cpp, OpenRouter) expect replayed.
REASONING_FIELDS = ("reasoning_content", "reasoning", "reasoning_text")


def _content(content: Any) -> Any:
    """Text only. An image, audio, or file part makes the provider fetch a URL or read a stored file."""
    if content is None or isinstance(content, str):
        return content
    parts = []
    for part in items(content, "Message content", MAX_INPUT_ITEMS):
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text":
            parts.append({"type": kind, "text": text(part.get("text"), "Text")})
        elif kind == "refusal":
            parts.append({"type": kind, "refusal": text(part.get("refusal"), "A refusal")})
        else:
            raise InvalidModelRequest("Only text content is accepted.")
    return parts


def _tool_call(call: Any) -> dict[str, Any]:
    if (
        not isinstance(call, dict)
        or call.get("type") != "function"
        or not isinstance(call.get("function"), dict)
    ):
        raise InvalidModelRequest("Only function tool calls are accepted.")
    return {
        "id": text(call.get("id"), "Tool call id"),
        "type": "function",
        "function": {
            "name": text(call["function"].get("name"), "Tool name"),
            "arguments": text(call["function"].get("arguments"), "Tool arguments"),
        },
    }


def _message(message: Any) -> dict[str, Any]:
    """Rebuilds one message from known fields. Others, such as `audio.id`, name state stored with the provider."""
    if not isinstance(message, dict):
        raise InvalidModelRequest("Each message must be an object.")
    role = message.get("role")
    if not isinstance(role, str) or role not in ROLES:
        raise InvalidModelRequest("Unknown message role.")
    out = {"role": role, "content": _content(message.get("content"))}
    copy_strings(message, out, "name", "tool_call_id", "refusal", *REASONING_FIELDS)
    if message.get("tool_calls") is not None:
        out["tool_calls"] = [_tool_call(c) for c in items(message["tool_calls"], "tool_calls", MAX_TOOLS)]
    if isinstance(message.get("reasoning_details"), list):
        out["reasoning_details"] = message["reasoning_details"]
    return out


def _function_of(item: Any) -> Any:
    """The `function` a chat tool or tool choice nests, if it is a function one."""
    return item.get("function") if isinstance(item, dict) and item.get("type") == "function" else None


def _tool(tool: Any) -> dict[str, Any]:
    # Custom (grammar) tools and anything else are refused, as for Responses.
    function = _function_of(tool)
    if not isinstance(function, dict):
        raise InvalidModelRequest("Only function tools are accepted.")
    out: dict[str, Any] = {"name": text(function.get("name"), "Tool name")}
    copy_strings(function, out, "description")
    if function.get("parameters") is not None:
        if not isinstance(function["parameters"], dict):
            raise InvalidModelRequest("Tool parameters must be an object.")
        out["parameters"] = function["parameters"]
    copy_typed(function, out, (bool,), "a boolean", "strict")
    return {"type": "function", "function": out}


def _tool_choice(choice: Any) -> Any:
    if isinstance(choice, str) and choice in {"auto", "none", "required"}:
        return choice
    function = _function_of(choice)
    if isinstance(function, dict):
        return {"type": "function", "function": {"name": text(function.get("name"), "Tool name")}}
    raise InvalidModelRequest("Unsupported tool_choice.")


def _response_format(value: Any) -> dict[str, Any]:
    kind = value.get("type") if isinstance(value, dict) else None
    if isinstance(kind, str) and kind in {"text", "json_object"}:
        return {"type": kind}
    schema = value.get("json_schema") if kind == "json_schema" else None
    if not isinstance(schema, dict):
        raise InvalidModelRequest("Unsupported response_format.")
    out: dict[str, Any] = {"name": text(schema.get("name"), "Schema name")}
    copy_strings(schema, out, "description")
    if schema.get("schema") is not None:
        if not isinstance(schema["schema"], dict):
            raise InvalidModelRequest("The response schema must be an object.")
        out["schema"] = schema["schema"]
    copy_typed(schema, out, (bool,), "a boolean", "strict")
    return {"type": kind, "json_schema": out}


def _stop(value: Any) -> str | list[str]:
    if isinstance(value, str):
        return value
    return [text(item, "A stop sequence") for item in items(value, "stop", MAX_STOP_SEQUENCES)]


def build_chat_payload(body: dict[str, Any], target: Route) -> dict[str, Any]:
    """A Chat Completions request as the gateway will send it: rebuilt from validated parts, as for
    Responses. Choices (n), storage, users and metadata, and the model are ours; unknown fields are dropped."""
    if body.get("stream") is not True:
        raise InvalidModelRequest(STREAM_REQUIRED)
    requested = body.get("max_completion_tokens") or body.get("max_tokens")
    payload: dict[str, Any] = {
        "model": target.model,
        "messages": [_message(m) for m in items(body.get("messages"), "messages", MAX_INPUT_ITEMS)],
        "n": 1,
        "store": False,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_completion_tokens": capped(requested, target.max_output_tokens),
    }
    if body.get("tools") is not None:
        # Kept even when empty: some compatible servers want `tools` whenever the history has tool calls.
        payload["tools"] = [_tool(tool) for tool in items(body["tools"], "tools", MAX_TOOLS)]
    if body.get("tool_choice") is not None:
        payload["tool_choice"] = _tool_choice(body["tool_choice"])
    if body.get("response_format") is not None:
        payload["response_format"] = _response_format(body["response_format"])
    if body.get("stop") is not None:
        payload["stop"] = _stop(body["stop"])
    copy_typed(body, payload, (bool,), "a boolean", "parallel_tool_calls")
    copy_typed(body, payload, (int, float), "a number", "temperature", "top_p")
    copy_typed(body, payload, (int,), "an integer", "seed")
    copy_typed(body, payload, (str,), "a string", "reasoning_effort")
    return payload
