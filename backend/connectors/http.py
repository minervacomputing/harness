"""Shared HTTP handling for provider clients.

Maps provider responses to owned errors, and accounts for writes: a mutating operation may send exactly
one mutating request, only from its execute step, and only before its deadline. What happened to that
request tells the executor whether a failed write was applied, so it can allow a retry or pause writes.
"""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import httpx

from connectors.base import OperationError

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# The provider refused these requests, so the write they carried was not applied.
REFUSED_STATUSES = frozenset({400, 401, 403, 404, 409, 412, 422, 429})
# Never start a write that could not finish before its deadline.
MIN_WRITE_SECONDS = 2.0


class Effect(StrEnum):
    NOT_APPLIED = "not_applied"
    APPLIED = "applied"
    UNKNOWN = "unknown"


@dataclass(slots=True)
class WriteAttempt:
    deadline: float  # time.monotonic()
    sent: bool = False
    effect: Effect | None = None
    # Set once the executor has judged the attempt; a request sent later (say, from a task the connector
    # left running) would not be accounted for, so it is refused.
    closed: bool = False

    def close(self) -> None:
        self.closed = True

    def outcome(self) -> Effect:
        """What a failed execute step did to the provider. Closes the attempt."""
        self.close()
        if not self.sent:
            return Effect.NOT_APPLIED
        return self.effect or Effect.UNKNOWN


_attempt: ContextVar[WriteAttempt | None] = ContextVar("minerva_write_attempt", default=None)


@contextmanager
def write_attempt(deadline: float) -> Iterator[WriteAttempt]:
    attempt = WriteAttempt(deadline)
    token = _attempt.set(attempt)
    try:
        yield attempt
    finally:
        attempt.close()
        _attempt.reset(token)


def default_forbidden(provider: str, response: httpx.Response) -> OperationError:
    return OperationError("PROVIDER_FORBIDDEN", f"{provider} refused this request for the connected account.")


class ProviderHTTP:
    def __init__(
        self,
        provider: str,
        *,
        base_url: str,
        headers: dict[str, str],
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 20.0,
        forbidden: Callable[[str, httpx.Response], OperationError] = default_forbidden,
    ) -> None:
        self.provider = provider
        self.timeout = timeout
        self._forbidden = forbidden
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout),
            follow_redirects=False,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def _begin_write(self) -> WriteAttempt:
        attempt = _attempt.get()
        if attempt is None or attempt.closed:
            raise RuntimeError(
                "Provider writes are only allowed in the execute step of a mutating operation."
            )
        if attempt.sent:
            raise RuntimeError("An operation may send only one provider write.")
        if attempt.deadline - time.monotonic() < MIN_WRITE_SECONDS:
            raise OperationError("TIMED_OUT", "The write was not sent because its time ran out.")
        attempt.sent = True
        return attempt

    async def request(
        self, method: str, path: str, *, mutating: bool | None = None, **kwargs: Any
    ) -> httpx.Response:
        """Send one request. `mutating` defaults by method; reads sent with POST must say so."""
        if mutating is None:
            mutating = method.upper() in MUTATING_METHODS
        attempt = self._begin_write() if mutating else None
        if attempt is not None:
            kwargs["timeout"] = httpx.Timeout(min(self.timeout, attempt.deadline - time.monotonic()))
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as error:
            if attempt is not None:
                # A connection that never opened carried nothing.
                refused = isinstance(error, httpx.ConnectError | httpx.ConnectTimeout)
                attempt.effect = Effect.NOT_APPLIED if refused else Effect.UNKNOWN
            raise OperationError("PROVIDER_UNAVAILABLE", f"{self.provider} could not be reached.") from error
        if attempt is not None:
            if response.is_success:
                attempt.effect = Effect.APPLIED
            elif response.status_code in REFUSED_STATUSES:
                attempt.effect = Effect.NOT_APPLIED
            else:
                attempt.effect = Effect.UNKNOWN
        if not response.is_success:
            raise self._error(response)
        return response

    async def json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self.request(method, path, **kwargs)
        try:
            return response.json()
        except ValueError as error:
            raise self.unexpected() from error

    def unexpected(self) -> OperationError:
        return OperationError("PROVIDER_FAILED", f"{self.provider} returned an unexpected response.")

    def _error(self, response: httpx.Response) -> OperationError:
        status = response.status_code
        if status == 401:
            return OperationError(
                "CONNECTION_UNAUTHORIZED", f"The {self.provider} connection is no longer authorized."
            )
        if status == 403:
            return self._forbidden(self.provider, response)
        if status == 404:
            return OperationError("NOT_FOUND", f"{self.provider} did not find this object.")
        if status == 429:
            return OperationError(
                "PROVIDER_RATE_LIMITED", f"{self.provider} is rate limiting requests. Try again later."
            )
        if 400 <= status < 500:
            return OperationError("PROVIDER_REJECTED", f"{self.provider} rejected this request.")
        return OperationError("PROVIDER_FAILED", f"{self.provider} could not complete this request.")
