"""Model access behind one interface. The backend chooses upstream, model, key, and caps; the worker
only ever names an alias. Other providers (Anthropic SDK, in-process LiteLLM) plug in here."""

import contextlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from minerva.config import config

# Request fields the worker may set. Everything else (model, n, store, user, metadata, ...) is ours.
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


class ModelUnavailable(Exception):
    pass


@dataclass(frozen=True)
class Route:
    alias: str
    model: str
    max_output_tokens: int


@dataclass
class UpstreamResponse:
    status: int
    content_type: str
    chunks: AsyncIterator[bytes]


class ModelProvider(Protocol):
    def chat_completions(self, payload: dict[str, Any]) -> Any:
        """Async context manager yielding an `UpstreamResponse` for an OpenAI-style chat request."""


class OpenAICompatibleProvider:
    def __init__(self, base_url: str, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.transport = transport

    @asynccontextmanager
    async def chat_completions(self, payload: dict[str, Any]) -> AsyncIterator[UpstreamResponse]:
        timeout = httpx.Timeout(connect=10, read=120, write=30, pool=10)
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=False, transport=self.transport
        ) as client:
            request = client.build_request(
                "POST",
                f"{self.base_url}/chat/completions",
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
    return provider, Route(alias, cfg.model_name, cfg.model_max_output_tokens)


def build_payload(body: dict[str, Any], target: Route) -> dict[str, Any]:
    payload = {key: value for key, value in body.items() if key in ALLOWED_FIELDS}
    requested = payload.pop("max_completion_tokens", None) or payload.pop("max_tokens", None)
    payload.pop("max_tokens", None)
    cap = target.max_output_tokens
    payload["max_completion_tokens"] = (
        min(cap, requested) if isinstance(requested, int) and requested > 0 else cap
    )
    payload["model"] = target.model
    payload["n"] = 1
    payload["store"] = False
    if payload.get("stream"):
        payload["stream_options"] = {"include_usage": True}
    return payload


class StreamTap:
    """Follows an OpenAI-style response while its bytes pass through unchanged: token usage and the
    visible assistant text, so the backend can stream progress without trusting the worker for it."""

    MAX_BUFFER = 4_000_000

    def __init__(self) -> None:
        self._partial = b""
        self._raw = bytearray()
        self._saw_sse = False
        self._text: list[str] = []
        self.input_tokens = 0
        self.output_tokens = 0

    def feed(self, chunk: bytes) -> None:
        if not self._saw_sse and len(self._raw) < self.MAX_BUFFER:
            self._raw += chunk
        self._partial += chunk
        *lines, self._partial = self._partial.split(b"\n")
        for line in lines:
            self._line(line.strip())
        if len(self._partial) > self.MAX_BUFFER:
            self._partial = b""

    def take_text(self) -> str:
        text = "".join(self._text)
        self._text.clear()
        return text

    def finish(self) -> None:
        if self._partial:
            self._line(self._partial.strip())
            self._partial = b""
        if not self._saw_sse and self._raw:
            with contextlib.suppress(ValueError):
                self._read(json.loads(self._raw), key="message")
            self._raw.clear()

    def _line(self, line: bytes) -> None:
        if not line.startswith(b"data:"):
            return
        self._saw_sse = True
        self._raw.clear()
        data = line[5:].strip()
        if data == b"[DONE]":
            return
        try:
            self._read(json.loads(data), key="delta")
        except ValueError:
            return

    def _read(self, body: Any, *, key: str) -> None:
        if not isinstance(body, dict):
            return
        usage = body.get("usage")
        if isinstance(usage, dict):
            self.input_tokens = int(usage.get("prompt_tokens") or 0)
            self.output_tokens = int(usage.get("completion_tokens") or 0)
        for choice in body.get("choices") or []:
            part = choice.get(key) if isinstance(choice, dict) else None
            content = part.get("content") if isinstance(part, dict) else None
            if isinstance(content, str) and content:
                self._text.append(content)
