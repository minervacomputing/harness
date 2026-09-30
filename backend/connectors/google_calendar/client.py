from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.http import ProviderHTTP, default_forbidden

API_URL = "https://www.googleapis.com/calendar/v3"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
RATE_LIMITED = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})


def _forbidden(provider: str, response: httpx.Response) -> OperationError:
    """Google reports rate limits as 403 as well as 429."""
    try:
        error = response.json().get("error", {})
        reasons = {item.get("reason") for item in error.get("errors", [])}
    except ValueError, AttributeError, TypeError:
        reasons = set()
    if reasons & RATE_LIMITED:
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    return default_forbidden(provider, response)


class GoogleUser(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sub: str
    email: str | None = None
    name: str | None = None


class GoogleCalendar(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel)
    id: str
    summary: str = ""
    summary_override: str | None = None
    primary: bool = False
    access_role: str
    time_zone: str | None = None

    @property
    def name(self) -> str:
        return self.summary_override or self.summary or self.id


class CalendarPage(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel)
    items: list[GoogleCalendar] = []
    next_page_token: str | None = None


class GoogleCalendarClient:
    """Thin async client for the Google Calendar API v3. Responses are validated before use."""

    def __init__(
        self, access_token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._http = ProviderHTTP(
            "Google Calendar",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
            forbidden=_forbidden,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request[M: BaseModel](self, model: type[M], method: str, path: str, **kwargs: Any) -> M:
        data = await self._http.json(method, path, **kwargs)
        try:
            return model.model_validate(data)
        except ValidationError as error:
            raise self._http.unexpected() from error

    async def user(self) -> GoogleUser:
        return await self._request(GoogleUser, "GET", USERINFO_URL)

    async def calendars(self, page_token: str | None = None) -> CalendarPage:
        # Calendars shown only as free/busy cannot be read, so they are never offered.
        params: dict[str, Any] = {"minAccessRole": "reader", "maxResults": 250}
        if page_token:
            params["pageToken"] = page_token
        return await self._request(CalendarPage, "GET", "/users/me/calendarList", params=params)
