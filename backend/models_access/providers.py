"""Model access behind one interface. The backend chooses upstream, model, key, and caps; the worker
only ever names an alias. Other providers (Anthropic SDK, in-process LiteLLM) plug in here."""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from minerva.config import config

# Chat Completions fields the worker may set. Everything else (model, n, store, user, metadata, ...) is ours.
ALLOWED_FIELDS = {
    "messages",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "temperature",
    "top_p",
    "stop",
    "response_format",
    "reasoning_effort",
    "max_completion_tokens",
    "max_tokens",
    "seed",
}


# Responses fields the worker may set. Server-side state (previous_response_id, conversation, background,
# stored prompts), billing (service_tier), and reasoning are ours.
RESPONSES_FIELDS = {
    "input",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "temperature",
    "top_p",
    "max_output_tokens",
    "prompt_cache_key",
}
MAX_INPUT_ITEMS = 500
MAX_TOOLS = 128
# The relay meters usage and screens provider errors event by event, so it relays streams only.
STREAM_REQUIRED = "Only streamed requests are accepted."
# The Responses API refuses smaller output caps.
MIN_RESPONSES_OUTPUT_TOKENS = 16


class ModelUnavailable(Exception):
    pass


class InvalidModelRequest(ValueError):
    """A worker request the gateway will not forward. The message is shown to the worker."""


@dataclass(frozen=True)
class Route:
    alias: str
    model: str
    max_output_tokens: int
    api: str = "responses"
    # None when the model does not reason: the gateway then asks for no reasoning.
    reasoning_effort: str | None = None


@dataclass
class UpstreamResponse:
    status: int
    content_type: str
    chunks: AsyncIterator[bytes]


class ModelProvider(Protocol):
    def chat_completions(self, payload: dict[str, Any]) -> Any:
        """Async context manager yielding an `UpstreamResponse` for an OpenAI-style chat request."""

    def responses(self, payload: dict[str, Any]) -> Any:
        """Async context manager yielding an `UpstreamResponse` for an OpenAI Responses request."""


class OpenAICompatibleProvider:
    def __init__(self, base_url: str, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.transport = transport

    def chat_completions(self, payload: dict[str, Any]):
        return self._post("/chat/completions", payload)

    def responses(self, payload: dict[str, Any]):
        return self._post("/responses", payload)

    @asynccontextmanager
    async def _post(self, path: str, payload: dict[str, Any]) -> AsyncIterator[UpstreamResponse]:
        timeout = httpx.Timeout(connect=10, read=120, write=30, pool=10)
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=False, transport=self.transport
        ) as client:
            request = client.build_request(
                "POST",
                f"{self.base_url}{path}",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            try:
                response = await client.send(request, stream=True)
            except httpx.HTTPError as error:
                raise ModelUnavailable("The model provider could not be reached.") from error
            try:
                yield UpstreamResponse(
                    status=response.status_code,
                    content_type=response.headers.get("content-type", "application/json"),
                    chunks=response.aiter_bytes(),
                )
            finally:
                await response.aclose()


def route(alias: str) -> tuple[ModelProvider, Route]:
    cfg = config()
    if alias != "default":
        raise ModelUnavailable(f"Unknown model {alias!r}.")
    if cfg.model_api_key is None:
        raise ModelUnavailable("No model API key is configured on this instance.")
    provider = OpenAICompatibleProvider(cfg.model_base_url, cfg.model_api_key.get_secret_value())
    target = Route(
        alias,
        cfg.model_name,
        cfg.model_max_output_tokens,
        cfg.model_api,
        cfg.model_reasoning_effort or None,
    )
    return provider, target


def _capped(requested: Any, cap: int) -> int:
    # bool is an int in Python; a request for True tokens is not a request.
    return min(cap, requested) if type(requested) is int and requested > 0 else cap


def _text(value: Any, what: str) -> str:
    if not isinstance(value, str):
        raise InvalidModelRequest(f"{what} must be a string.")
    return value


def _items(value: Any, what: str, limit: int) -> list:
    if not isinstance(value, list) or len(value) > limit:
        raise InvalidModelRequest(f"{what} must be a list of at most {limit} entries.")
    return value


CHAT_ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})
# Reasoning text that OpenAI-compatible servers (DeepSeek, vLLM, llama.cpp, OpenRouter) expect replayed.
CHAT_REASONING_FIELDS = ("reasoning_content", "reasoning", "reasoning_text")


def _chat_content(content: Any) -> Any:
    """Text only. An image, audio, or file part makes the provider fetch a URL or read a stored file."""
    if content is None or isinstance(content, str):
        return content
    parts = []
    for part in _items(content, "Message content", MAX_INPUT_ITEMS):
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text":
            parts.append({"type": kind, "text": _text(part.get("text"), "Text")})
        elif kind == "refusal":
            parts.append({"type": kind, "refusal": _text(part.get("refusal"), "A refusal")})
        else:
            raise InvalidModelRequest("Only text content is accepted.")
    return parts


def _chat_tool_call(call: Any) -> dict[str, Any]:
    if (
        not isinstance(call, dict)
        or call.get("type") != "function"
        or not isinstance(call.get("function"), dict)
    ):
        raise InvalidModelRequest("Only function tool calls are accepted.")
    return {
        "id": _text(call.get("id"), "Tool call id"),
        "type": "function",
        "function": {
            "name": _text(call["function"].get("name"), "Tool name"),
            "arguments": _text(call["function"].get("arguments"), "Tool arguments"),
        },
    }


def _chat_message(message: Any) -> dict[str, Any]:
    """Rebuilds one message from known fields. Others, such as `audio.id`, name state stored with the provider."""
    if not isinstance(message, dict):
        raise InvalidModelRequest("Each message must be an object.")
    role = message.get("role")
    if not isinstance(role, str) or role not in CHAT_ROLES:
        raise InvalidModelRequest("Unknown message role.")
    out = {"role": role, "content": _chat_content(message.get("content"))}
    _copy_strings(message, out, "name", "tool_call_id", "refusal", *CHAT_REASONING_FIELDS)
    if message.get("tool_calls") is not None:
        out["tool_calls"] = [
            _chat_tool_call(c) for c in _items(message["tool_calls"], "tool_calls", MAX_TOOLS)
        ]
    if isinstance(message.get("reasoning_details"), list):
        out["reasoning_details"] = message["reasoning_details"]
    return out


def build_payload(body: dict[str, Any], target: Route) -> dict[str, Any]:
    """A Chat Completions request as the gateway will send it."""
    messages = [_chat_message(m) for m in _items(body.get("messages"), "messages", MAX_INPUT_ITEMS)]
    payload = {key: value for key, value in body.items() if key in ALLOWED_FIELDS}
    requested = payload.pop("max_completion_tokens", None) or payload.pop("max_tokens", None)
    payload.pop("max_tokens", None)
    payload["max_completion_tokens"] = _capped(requested, target.max_output_tokens)
    payload["messages"] = messages
    payload["model"] = target.model
    payload["n"] = 1
    payload["store"] = False
    if payload.get("stream") is not True:
        raise InvalidModelRequest(STREAM_REQUIRED)
    payload["stream_options"] = {"include_usage": True}
    return payload


def _response_part(part: Any, *, output: bool = False) -> dict[str, Any]:
    kind = part.get("type") if isinstance(part, dict) else None
    if kind == "input_text":
        return {"type": kind, "text": _text(part.get("text"), "Text")}
    if kind == "output_text" and not output:
        return {"type": kind, "text": _text(part.get("text"), "Text"), "annotations": []}
    if kind == "refusal" and not output:
        return {"type": kind, "refusal": _text(part.get("refusal"), "A refusal")}
    # input_image, input_file, input_audio: the provider would fetch a URL or read a stored file.
    raise InvalidModelRequest("Only text content is accepted.")


def _copy_strings(item: dict[str, Any], out: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        if item.get(key) is not None:
            out[key] = _text(item[key], key)
    return out


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
            else [_response_part(p) for p in _items(content, "Message content", MAX_INPUT_ITEMS)]
        )
        return _copy_strings(
            item, {"type": "message", "role": role, "content": parts}, "id", "status", "phase"
        )
    if kind == "function_call":
        out = {
            "type": kind,
            "call_id": _text(item.get("call_id"), "call_id"),
            "name": _text(item.get("name"), "name"),
            "arguments": _text(item.get("arguments"), "arguments"),
        }
        return _copy_strings(item, out, "id", "status")
    if kind == "function_call_output":
        output = item.get("output")
        if not isinstance(output, str):
            output = [_response_part(p, output=True) for p in _items(output, "Tool output", MAX_INPUT_ITEMS)]
        out = {"type": kind, "call_id": _text(item.get("call_id"), "call_id"), "output": output}
        return _copy_strings(item, out, "id", "status")
    if kind == "reasoning":
        summary = [
            {"type": "summary_text", "text": _text(s.get("text") if isinstance(s, dict) else None, "Summary")}
            for s in _items(item.get("summary", []), "Reasoning summary", MAX_INPUT_ITEMS)
        ]
        out = {
            "type": kind,
            "id": _text(item.get("id"), "id"),
            "encrypted_content": _text(item.get("encrypted_content"), "Reasoning content"),
            "summary": summary,
        }
        return _copy_strings(item, out, "status")
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
        "name": _text(tool.get("name"), "Tool name"),
        "parameters": parameters,
        "strict": tool.get("strict") is True,
    }
    return _copy_strings(tool, out, "description")


def _tool_choice(choice: Any) -> Any:
    if isinstance(choice, str) and choice in {"auto", "none", "required"}:
        return choice
    if isinstance(choice, dict) and choice.get("type") == "function":
        return {"type": "function", "name": _text(choice.get("name"), "Tool name")}
    raise InvalidModelRequest("Unsupported tool_choice.")


def build_responses_payload(body: dict[str, Any], target: Route) -> dict[str, Any]:
    """A Responses request as the gateway will send it: rebuilt from validated parts, never passed through."""
    payload: dict[str, Any] = {
        "model": target.model,
        "input": [_input_item(item) for item in _items(body.get("input"), "input", MAX_INPUT_ITEMS)],
        "store": False,
        "max_output_tokens": _capped(body.get("max_output_tokens"), target.max_output_tokens),
    }
    # Raising a request to the provider's minimum could exceed Minerva's cap, so a smaller one is refused.
    if payload["max_output_tokens"] < MIN_RESPONSES_OUTPUT_TOKENS:
        raise InvalidModelRequest(f"max_output_tokens must be at least {MIN_RESPONSES_OUTPUT_TOKENS}.")
    if body.get("tools") is not None:
        payload["tools"] = [_function_tool(tool) for tool in _items(body["tools"], "tools", MAX_TOOLS)]
    if body.get("tool_choice") is not None:
        payload["tool_choice"] = _tool_choice(body["tool_choice"])
    for key in ("parallel_tool_calls", "stream"):
        if body.get(key) is not None:
            if not isinstance(body[key], bool):
                raise InvalidModelRequest(f"{key} must be a boolean.")
            payload[key] = body[key]
    if payload.get("stream") is not True:
        raise InvalidModelRequest(STREAM_REQUIRED)
    for key in ("temperature", "top_p"):
        value = body.get(key)
        if value is not None:
            if type(value) not in {int, float}:
                raise InvalidModelRequest(f"{key} must be a number.")
            payload[key] = value
    key = body.get("prompt_cache_key")
    if isinstance(key, str) and 0 < len(key) <= 64:
        payload["prompt_cache_key"] = key
    if target.reasoning_effort:
        # Without storage, reasoning survives between tool calls only as encrypted content.
        payload["reasoning"] = {"effort": target.reasoning_effort}
        payload["include"] = ["reasoning.encrypted_content"]
    return payload


class StreamTooLarge(Exception):
    pass


BOM = b"\xef\xbb\xbf"


class StreamTap:
    """Follows an OpenAI-style event stream as it is relayed: token usage and the visible assistant text,
    so the backend can stream progress without trusting the worker for it. Events pass through unchanged,
    except provider errors, whose diagnostics are replaced as they are for non-200 responses."""

    MAX_EVENT = 4_000_000
    ERROR_MESSAGE = "The model provider reported an error."

    def __init__(self) -> None:
        self._partial = b""
        self._started = False
        self._after_cr = False
        self._event: list[bytes] = []
        self._event_size = 0
        self._text: list[str] = []
        self.input_tokens = 0
        self.output_tokens = 0
        self.metered = False
        self.error_code: str | None = None

    def feed(self, chunk: bytes) -> bytes:
        """Returns the events completed by this chunk, as the worker should receive them. Line endings
        are relayed as LF: event streams may also end lines with CR or CRLF, and a stream may open with a
        byte order mark, and every form has to be screened alike."""
        # A CR ends its line at once; an LF right after it, even in the next chunk, is part of that end.
        if chunk and self._after_cr:
            chunk, self._after_cr = chunk.removeprefix(b"\n"), False
        if chunk:
            self._after_cr = chunk.endswith(b"\r")
        data = self._partial + chunk
        if not self._started:
            if BOM.startswith(data):
                self._partial = data
                return b""
            data, self._started = data.removeprefix(BOM), True
        *lines, self._partial = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
        out = []
        for line in lines:
            self._event.append(line + b"\n")
            self._event_size += len(line) + 1
            if not line:
                out.append(self._flush())
            elif self._event_size > self.MAX_EVENT:
                raise StreamTooLarge
        if self._event_size + len(self._partial) > self.MAX_EVENT:
            raise StreamTooLarge
        return b"".join(out)

    def finish(self) -> bytes:
        if self._partial:
            self._event.append(self._partial.removeprefix(BOM))
            self._partial = b""
        return self._flush() if self._event else b""

    def take_text(self) -> str:
        text = "".join(self._text)
        self._text.clear()
        return text

    def _flush(self) -> bytes:
        lines, self._event, self._event_size = self._event, [], 0
        # An event's data may span several lines, which clients join with newlines.
        data = [line.rstrip(b"\n")[5:] for line in lines if line.startswith(b"data:")]
        if not data:
            return b"".join(lines)
        try:
            body = json.loads(b"\n".join(item.removeprefix(b" ") for item in data))
        except ValueError:
            return b"".join(lines)
        replacement = self._read(body) if isinstance(body, dict) else None
        if replacement is None:
            return b"".join(lines)
        fields = b"".join(line for line in lines if not line.startswith(b"data:") and line.strip())
        return fields + b"data: " + json.dumps(replacement).encode() + b"\n\n"

    def _usage(self, usage: Any, input_key: str, output_key: str) -> None:
        if not isinstance(usage, dict):
            return
        counts = usage.get(input_key), usage.get(output_key)
        if all(type(count) is int and count >= 0 for count in counts):
            self.input_tokens, self.output_tokens = counts
            self.metered = True

    def _error(self, error: Any) -> None:
        code = error.get("code") if isinstance(error, dict) else None
        self.error_code = code if isinstance(code, str) else "unknown"

    def _read(self, body: dict) -> dict | None:
        """Takes what the tap needs from one event. Returns a replacement event, or None to relay it."""
        if body.get("error") is not None:
            self._error(body["error"])
            return {"error": {"message": self.ERROR_MESSAGE}}
        self._usage(body.get("usage"), "prompt_tokens", "completion_tokens")
        for choice in body.get("choices") or []:
            delta = choice.get("delta") if isinstance(choice, dict) else None
            content = delta.get("content") if isinstance(delta, dict) else None
            if isinstance(content, str) and content:
                self._text.append(content)
        return None


class ResponsesTap(StreamTap):
    """StreamTap for the Responses API: visible text is output_text only, never reasoning summaries."""

    TERMINAL = frozenset({"response.completed", "response.incomplete", "response.failed"})

    def _read(self, body: dict) -> dict | None:
        kind = body.get("type")
        # Screened alike: error events, and bare error envelopes some compatible servers send instead.
        if kind == "error" or (kind not in self.TERMINAL and body.get("error") is not None):
            self._error(body if kind == "error" else body["error"])
            return {
                "type": "error",
                "code": "provider_error",
                "message": self.ERROR_MESSAGE,
                "param": None,
                "sequence_number": body.get("sequence_number"),
            }
        if kind == "response.output_text.delta" and isinstance(body.get("delta"), str) and body["delta"]:
            self._text.append(body["delta"])
        elif kind in self.TERMINAL and isinstance(body.get("response"), dict):
            response = body["response"]
            self._usage(response.get("usage"), "input_tokens", "output_tokens")
            if response.get("error") is not None:
                self._error(response["error"])
                error = {"code": "provider_error", "message": self.ERROR_MESSAGE}
                return {**body, "response": {**response, "error": error}}
        return None
