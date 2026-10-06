"""Model access behind one interface. The backend chooses upstream, model, key, and caps; the worker
only ever names an alias. Other providers (Anthropic SDK, in-process LiteLLM) plug in here."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from minerva.config import config


class ModelUnavailable(Exception):
    pass


@dataclass(frozen=True)
class Route:
    alias: str
    model: str
    max_output_tokens: int
    api: str = "responses"
    # None when the model does not reason: the gateway then asks for no reasoning.
    reasoning_effort: str | None = None
    # A summary of the reasoning to stream, or None for none. Only asked for with a reasoning effort.
    reasoning_summary: str | None = None


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
        cfg.model_reasoning_summary or None,
    )
    return provider, target
