"""Brave Search API: web results as titles, addresses and snippets, never page contents.

The key is the operator's. A key Brave refuses means search is unavailable on this instance, not that
the user's connection needs attention, so its errors never mark the connection for reconnecting.
"""

import html
import logging
import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from connectors.base import OperationError
from connectors.http import ProviderHTTP

log = logging.getLogger(__name__)

BASE_URL = "https://api.search.brave.com/res/v1/"
# Brave pages by result page, from 0.
MAX_PAGE = 9


class BraveResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = ""
    url: str
    description: str = ""
    age: str | None = None


class _Web(BaseModel):
    model_config = ConfigDict(extra="ignore")
    results: list[BraveResult] = []


class _Query(BaseModel):
    model_config = ConfigDict(extra="ignore")
    more_results_available: bool = False


class BraveResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    web: _Web = _Web()
    query: _Query = _Query()


def plain(text: str) -> str:
    """Snippets may carry markup for highlighting; keep only the text."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", text))).strip()


def _unavailable() -> OperationError:
    return OperationError(
        "SEARCH_UNAVAILABLE", "Web search is not available on this Minerva instance right now."
    )


class BraveSearch:
    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = ProviderHTTP(
            "Brave Search",
            base_url=BASE_URL,
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
            transport=transport,
            timeout=15.0,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def search(
        self, query: str, *, count: int, page: int, country: str | None, freshness: str | None
    ) -> BraveResponse:
        params: dict[str, Any] = {
            "q": query,
            "count": count,
            "offset": page,
            "safesearch": "moderate",
            "text_decorations": "false",
            "result_filter": "web",
        }
        if country:
            params["country"] = country
        if freshness:
            params["freshness"] = freshness
        try:
            body = await self._http.json("GET", "web/search", params=params)
        except OperationError as error:
            if error.code in {"CONNECTION_UNAUTHORIZED", "PROVIDER_FORBIDDEN"}:
                log.error("Brave Search refused the configured API key (%s).", error.code)
                raise _unavailable() from None
            raise
        try:
            return BraveResponse.model_validate(body)
        except ValidationError as error:
            raise self._http.unexpected() from error
