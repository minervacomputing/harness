from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from connectors.google import USERINFO_URL, GoogleUser, forbidden, segment
from connectors.http import ProviderHTTP

API_URL = "https://www.googleapis.com/calendar/v3"


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class GoogleCalendar(Model):
    id: str
    summary: str = ""
    summary_override: str | None = None
    primary: bool = False
    access_role: str
    time_zone: str | None = None

    @property
    def name(self) -> str:
        return self.summary_override or self.summary or self.id


class CalendarPage(Model):
    items: list[GoogleCalendar] = []
    next_page_token: str | None = None


class EventTime(Model):
    date: str | None = None
    date_time: str | None = None
    time_zone: str | None = None


class Person(Model):
    email: str | None = None
    display_name: str | None = None
    response_status: str | None = None


class GoogleEvent(Model):
    # Cancelled and private events can carry little more than an id.
    id: str
    status: str | None = None
    summary: str | None = None
    description: str | None = None
    location: str | None = None
    start: EventTime | None = None
    end: EventTime | None = None
    organizer: Person | None = None
    attendees: list[Person] = []
    attendees_omitted: bool = False
    html_link: str | None = None
    recurring_event_id: str | None = None


class EventPage(Model):
    items: list[GoogleEvent] = []
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
            forbidden=forbidden,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def user(self) -> GoogleUser:
        return await self._http.parsed(GoogleUser, "GET", USERINFO_URL)

    async def calendars(self, page_token: str | None = None) -> CalendarPage:
        # Calendars shown only as free/busy cannot be read, so they are never offered.
        params: dict[str, Any] = {"minAccessRole": "reader", "maxResults": 250}
        if page_token:
            params["pageToken"] = page_token
        return await self._http.parsed(CalendarPage, "GET", "/users/me/calendarList", params=params)

    async def calendar(self, calendar_id: str) -> GoogleCalendar:
        return await self._http.parsed(
            GoogleCalendar, "GET", f"/users/me/calendarList/{segment(calendar_id)}"
        )

    async def events(
        self,
        calendar_id: str,
        *,
        time_min: str | None,
        time_max: str | None,
        query: str | None,
        limit: int,
        page_token: str | None,
    ) -> EventPage:
        # Recurring events are expanded into instances, so they can be ordered by start time.
        params: dict[str, Any] = {"singleEvents": "true", "orderBy": "startTime", "maxResults": limit}
        if time_min:
            params["timeMin"] = time_min
        if time_max:
            params["timeMax"] = time_max
        if query:
            params["q"] = query
        if page_token:
            params["pageToken"] = page_token
        return await self._http.parsed(
            EventPage, "GET", f"/calendars/{segment(calendar_id)}/events", params=params
        )

    async def event(self, calendar_id: str, event_id: str) -> GoogleEvent:
        path = f"/calendars/{segment(calendar_id)}/events/{segment(event_id)}"
        return await self._http.parsed(GoogleEvent, "GET", path)

    async def create_event(self, calendar_id: str, body: dict[str, Any]) -> GoogleEvent:
        # Never notify anyone: the event has no attendees, and sendUpdates=none keeps it that way.
        return await self._http.parsed(
            GoogleEvent,
            "POST",
            f"/calendars/{segment(calendar_id)}/events",
            params={"sendUpdates": "none"},
            json=body,
        )
