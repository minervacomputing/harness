"""Microsoft Graph, for the signed-in user's calendars.

Event reads ask for times in UTC and bodies as text. Graph answers all-day events at midnight UTC whatever
the requested zone (see the connector for their dates). Creating an event is judged by status: Graph
answers 201 with the event.
"""

import json
from typing import Any

import httpx

from connectors.microsoft import API_URL, IMMUTABLE_IDS, Graph, Model, page_param, segment

EVENT_READ = f'{IMMUTABLE_IDS}, outlook.timezone="UTC", outlook.body-content-type="text"'
CALENDAR_FIELDS = "id,name,isDefaultCalendar,canEdit,owner"
EVENT_FIELDS = (
    "id,subject,body,start,end,isAllDay,isCancelled,showAs,sensitivity,location,organizer,attendees,"
    "onlineMeeting,webLink,type,seriesMasterId,categories"
)


class EmailAddress(Model):
    name: str | None = None
    address: str | None = None


class Recipient(Model):
    email_address: EmailAddress | None = None


class Calendar(Model):
    id: str
    name: str = ""
    is_default_calendar: bool | None = None
    can_edit: bool | None = None
    owner: EmailAddress | None = None


class Body(Model):
    content_type: str | None = None
    content: str = ""


class Time(Model):
    date_time: str
    time_zone: str | None = None


class Location(Model):
    display_name: str | None = None


class Response(Model):
    response: str | None = None


class Attendee(Model):
    email_address: EmailAddress | None = None
    type: str | None = None
    status: Response | None = None


class OnlineMeeting(Model):
    join_url: str | None = None


class Event(Model):
    id: str
    subject: str | None = None
    body: Body | None = None
    start: Time | None = None
    end: Time | None = None
    is_all_day: bool | None = None
    is_cancelled: bool | None = None
    show_as: str | None = None
    sensitivity: str | None = None
    location: Location | None = None
    organizer: Recipient | None = None
    attendees: list[Attendee] = []
    online_meeting: OnlineMeeting | None = None
    web_link: str | None = None
    type: str | None = None
    series_master_id: str | None = None
    categories: list[str] = []


class CalendarClient(Graph):
    """Thin async client for the parts of Microsoft Graph Outlook Calendar uses. Responses are validated."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        super().__init__("Outlook Calendar", access_token, base_url=base_url, transport=transport)

    async def calendars(self, cursor: str | None) -> tuple[list[Calendar], str | None]:
        params = {"$select": CALENDAR_FIELDS, "$top": "100", **(page_param(cursor) if cursor else {})}
        return self._page(Calendar, await self.get("/me/calendars", params=params))

    async def calendar(self, calendar_id: str | None) -> Calendar:
        """A calendar by id, or the default calendar."""
        path = f"/me/calendars/{segment(calendar_id)}" if calendar_id else "/me/calendar"
        return self._parse(Calendar, await self.get(path, params={"$select": CALENDAR_FIELDS}))

    async def view(
        self, calendar_id: str, *, start: str, end: str, limit: int, cursor: str | None
    ) -> tuple[list[Event], str | None]:
        """The events of one calendar that overlap the window, recurring events expanded."""
        params = {
            "startDateTime": start,
            "endDateTime": end,
            "$select": EVENT_FIELDS,
            "$orderby": "start/dateTime",
            "$top": str(limit),
            **(page_param(cursor) if cursor else {}),
        }
        body = await self.get(
            f"/me/calendars/{segment(calendar_id)}/calendarView", params=params, prefer=EVENT_READ
        )
        return self._page(Event, body)

    async def create(self, calendar_id: str, event: dict[str, Any]) -> Event:
        """The one write of an operation."""
        return await self._http.parsed(
            Event,
            "POST",
            f"/me/calendars/{segment(calendar_id)}/events",
            content=json.dumps(event).encode(),
            headers={"Content-Type": "application/json; charset=utf-8", "Prefer": EVENT_READ},
        )
