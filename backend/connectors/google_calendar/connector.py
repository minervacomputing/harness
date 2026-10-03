"""Google Calendar. Resources are calendars; what is allowed on a calendar covers its events."""

import json
import re
from datetime import UTC, date, datetime
from functools import cache
from typing import Annotated, Any, Self
from zoneinfo import available_timezones

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    DENIED,
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ResourceKind,
    ScopedRecord,
)
from connectors.google import oauth as google_oauth
from connectors.google_calendar.client import EventTime, GoogleCalendar, GoogleCalendarClient, GoogleEvent

CALENDAR = "calendar"
READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"
FULL_SCOPE = "https://www.googleapis.com/auth/calendar"
MAX_CALENDAR_PAGES = 10
PRIMARY = "primary"
MAX_DESCRIPTION = 4000
MAX_ATTENDEES = 50

# Every operation resolves its calendar through the calendar list, which the events scopes do not cover.
READ_CONSENT = (frozenset({READ_SCOPE}), frozenset({FULL_SCOPE}))
WRITE_CONSENT = (frozenset({READ_SCOPE, EVENTS_SCOPE}), frozenset({FULL_SCOPE}))

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$")


def _not_dots(value: str) -> str:
    if set(value) == {"."}:
        raise ValueError("is not a valid id")
    return value


def _date_time(value: str) -> str:
    if not DATE_TIME.match(value):
        raise ValueError("must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00")
    datetime.fromisoformat(value)
    return value


def _date_or_date_time(value: str) -> str:
    if DATE.match(value):
        date.fromisoformat(value)
        return value
    return _date_time(value)


@cache
def _zones() -> frozenset[str]:
    return frozenset(available_timezones())


def _time_zone(value: str) -> str:
    if value not in _zones():
        raise ValueError("must be an IANA time zone, like Europe/Berlin")
    return value


CalendarId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9._%+#@-]+$",
        description='A calendar id from list_calendars, or "primary" for the main calendar.',
    ),
    AfterValidator(_not_dots),
]
EventId = Annotated[
    str, Field(min_length=1, max_length=1024, pattern=r"^[A-Za-z0-9_@.-]+$"), AfterValidator(_not_dots)
]
DateTime = Annotated[str, Field(max_length=40), AfterValidator(_date_time)]
DateOrDateTime = Annotated[str, Field(max_length=40), AfterValidator(_date_or_date_time)]


async def _all_calendars(client: GoogleCalendarClient) -> list[GoogleCalendar]:
    calendars: list[GoogleCalendar] = []
    token: str | None = None
    for _ in range(MAX_CALENDAR_PAGES):
        page = await client.calendars(token)
        calendars.extend(page.items)
        if not page.next_page_token:
            return calendars
        token = page.next_page_token
    raise OperationError("PROVIDER_LIMIT", "This Google account has more calendars than Minerva can list.")


async def _calendar_id(client: GoogleCalendarClient, calendar_id: str) -> str:
    """The id the user's calendar list gives the calendar. Grants and records use it, never `primary` or
    another spelling Google also accepts, and calendars outside the list (which discovery never offers)
    are refused like calendars without a grant."""
    try:
        calendar = await client.calendar(calendar_id)
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise OperationError("POLICY_DENIED", DENIED) from None
        raise
    if calendar.id == PRIMARY:
        raise OperationError("PROVIDER_FAILED", "Google Calendar returned an unexpected response.")
    return calendar.id


def _time(value: EventTime | None) -> str | None:
    if value is None:
        return None
    return value.date_time or value.date


def _event(binding: Binding, calendar_id: str, event: GoogleEvent) -> ScopedRecord:
    description = event.description
    if description and len(description) > MAX_DESCRIPTION:
        description = description[:MAX_DESCRIPTION] + " [truncated]"
    attendees = [
        {"email": a.email, "name": a.display_name, "response": a.response_status}
        for a in event.attendees[:MAX_ATTENDEES]
    ]
    return ScopedRecord(
        binding.resource(CALENDAR, calendar_id),
        {
            "id": event.id,
            "calendar_id": calendar_id,
            "status": event.status,
            "summary": event.summary,
            "description": description,
            "location": event.location,
            "start": _time(event.start),
            "end": _time(event.end),
            "all_day": bool(event.start and event.start.date and not event.start.date_time),
            "time_zone": event.start.time_zone if event.start else None,
            "organizer": event.organizer.email if event.organizer else None,
            "attendees": attendees,
            # The attendee list is incomplete when Google or Minerva left some out.
            "attendees_incomplete": event.attendees_omitted or len(event.attendees) > MAX_ATTENDEES,
            "link": event.html_link,
            "recurring_event_id": event.recurring_event_id,
        },
    )


class ListCalendars(OperationInput):
    pass


async def _prepare_list_calendars(binding: Binding, _: ListCalendars) -> Prepared:
    async def execute() -> ProviderOutput:
        return ProviderOutput(
            [
                ScopedRecord(
                    binding.resource(CALENDAR, c.id),
                    {
                        "id": c.id,
                        "name": c.name,
                        "primary": c.primary,
                        "access_role": c.access_role,
                        "time_zone": c.time_zone,
                    },
                )
                for c in await _all_calendars(binding.client)
            ]
        )

    return Prepared([Enumerate(CALENDAR, "read")], execute)


LIST_CALENDARS = Operation(
    name="list_calendars",
    title="List calendars",
    description="List the Google calendars you may read.",
    input_model=ListCalendars,
    needs=((CALENDAR, "read"),),
    prepare=_prepare_list_calendars,
    consent=READ_CONSENT,
)


class ListEvents(OperationInput):
    calendar_id: CalendarId
    time_min: Annotated[DateTime | None, Field(description="Only events that end after this time.")] = None
    time_max: Annotated[DateTime | None, Field(description="Only events that start before this time.")] = None
    search: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Annotated[str, Field(max_length=300)] | None = None

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if (
            self.time_min
            and self.time_max
            and datetime.fromisoformat(self.time_max) <= datetime.fromisoformat(self.time_min)
        ):
            raise ValueError("time_max must be after time_min")
        return self


def _page_state(cursor: str) -> dict[str, Any]:
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    if not isinstance(state, dict) or not isinstance(state.get("page"), str):
        raise OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.")
    return state


async def _prepare_list_events(binding: Binding, data: ListEvents) -> Prepared:
    client: GoogleCalendarClient = binding.client
    calendar_id = await _calendar_id(client, data.calendar_id)
    # The upstream cursor is Minerva's own: Google's page token plus the time bound the first page used,
    # so later pages repeat the query exactly, even when the default bound ("now") was applied.
    state = _page_state(data.cursor) if data.cursor else None
    time_min = data.time_min
    if state is not None:
        time_min = state.get("time_min")
    elif time_min is None and data.time_max is None:
        time_min = datetime.now(UTC).isoformat(timespec="seconds")

    async def execute() -> ProviderOutput:
        page = await client.events(
            calendar_id,
            time_min=time_min,
            time_max=data.time_max,
            query=data.search,
            limit=data.limit,
            page_token=state["page"] if state else None,
        )
        next_cursor = None
        if page.next_page_token:
            next_cursor = json.dumps({"page": page.next_page_token, "time_min": time_min})
            if len(next_cursor) > 1000:
                raise OperationError(
                    "PROVIDER_LIMIT", "Google Calendar returned a page token that is too long."
                )
        return ProviderOutput([_event(binding, calendar_id, e) for e in page.items], next_cursor)

    return Prepared([Need(binding.resource(CALENDAR, calendar_id), "read")], execute)


LIST_EVENTS = Operation(
    name="list_events",
    title="List events",
    description=(
        "List events in one calendar you may read, ordered by start time, with recurring events "
        "expanded. Without time_min or time_max, lists events from now on. Times are RFC 3339 with "
        "an offset. To get the next page, repeat the call with identical arguments plus the "
        "returned next_cursor."
    ),
    input_model=ListEvents,
    needs=((CALENDAR, "read"),),
    prepare=_prepare_list_events,
    consent=READ_CONSENT,
    paginated=True,
)


class GetEvent(OperationInput):
    calendar_id: CalendarId
    event_id: EventId


async def _prepare_get_event(binding: Binding, data: GetEvent) -> Prepared:
    client: GoogleCalendarClient = binding.client
    calendar_id = await _calendar_id(client, data.calendar_id)

    async def execute() -> ProviderOutput:
        return ProviderOutput([_event(binding, calendar_id, await client.event(calendar_id, data.event_id))])

    return Prepared([Need(binding.resource(CALENDAR, calendar_id), "read")], execute)


GET_EVENT = Operation(
    name="get_event",
    title="Get an event",
    description="Read one event by calendar and event id.",
    input_model=GetEvent,
    needs=((CALENDAR, "read"),),
    prepare=_prepare_get_event,
    consent=READ_CONSENT,
)


class CreateEvent(OperationInput):
    calendar_id: CalendarId
    summary: Annotated[str, Field(min_length=1, max_length=300)]
    start: Annotated[
        DateOrDateTime,
        Field(description="YYYY-MM-DD for an all-day event, or an RFC 3339 date-time with an offset."),
    ]
    end: Annotated[
        DateOrDateTime,
        Field(description="Same format as start. For all-day events, the day after the last day."),
    ]
    time_zone: Annotated[str, Field(max_length=64), AfterValidator(_time_zone)] | None = None
    description: Annotated[str, Field(max_length=8000)] | None = None
    location: Annotated[str, Field(max_length=500)] | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        all_day = bool(DATE.match(self.start))
        if all_day != bool(DATE.match(self.end)):
            raise ValueError("start and end must both be dates or both be date-times")
        if all_day:
            ordered = date.fromisoformat(self.end) > date.fromisoformat(self.start)
        else:
            ordered = datetime.fromisoformat(self.end) > datetime.fromisoformat(self.start)
        if not ordered:
            raise ValueError("end must be after start")
        return self

    def body(self) -> dict[str, Any]:
        key = "date" if DATE.match(self.start) else "dateTime"
        start: dict[str, str] = {key: self.start}
        end: dict[str, str] = {key: self.end}
        if self.time_zone:
            start["timeZone"] = end["timeZone"] = self.time_zone
        body: dict[str, Any] = {"summary": self.summary, "start": start, "end": end}
        if self.description:
            body["description"] = self.description
        if self.location:
            body["location"] = self.location
        return body


async def _prepare_create_event(binding: Binding, data: CreateEvent) -> Prepared:
    client: GoogleCalendarClient = binding.client
    calendar_id = await _calendar_id(client, data.calendar_id)

    async def execute() -> ProviderOutput:
        event = await client.create_event(calendar_id, data.body())
        return ProviderOutput([_event(binding, calendar_id, event)])

    return Prepared([Need(binding.resource(CALENDAR, calendar_id), "create")], execute)


CREATE_EVENT = Operation(
    name="create_event",
    title="Create an event",
    description=(
        "Create one event in a calendar where you have create permission. The event has no guests, "
        "so no invitations are sent, but everyone who can see the calendar can see the event. "
        "The number of writes per run is limited."
    ),
    input_model=CreateEvent,
    needs=((CALENDAR, "create"),),
    prepare=_prepare_create_event,
    consent=WRITE_CONSENT,
    mutates=True,
)


class GoogleCalendarConnector(Connector):
    slug = "google_calendar"
    name = "Google Calendar"
    kinds = (ResourceKind(CALENDAR, "Calendar", ("read", "create"), wildcard=True),)
    actions = (
        ActionSpec("read", "Read events"),
        ActionSpec("create", "Create events", requires="read"),
    )
    # Reading is enough to connect; writing is asked for once the user allows an agent to write.
    auth = google_oauth(READ_SCOPE)

    operations = (LIST_CALENDARS, LIST_EVENTS, GET_EVENT, CREATE_EVENT)

    def client(self, access_token: str) -> GoogleCalendarClient:
        return GoogleCalendarClient(access_token)

    async def account(self, client: GoogleCalendarClient) -> Account:
        # The OpenID subject is stable; the email address can change.
        user = await client.user()
        return Account(id=user.sub, label=user.email or user.name or "Google")

    async def discover(
        self, client: GoogleCalendarClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        calendars = await _all_calendars(client)
        if query:
            text = query.casefold()
            calendars = [c for c in calendars if text in c.name.casefold()]
        return DiscoveryPage([DiscoveryItem(c.id, c.name) for c in calendars if len(c.id) <= 200])

    async def describe(self, client: GoogleCalendarClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        return {c.id: c.name for c in await _all_calendars(client) if c.id in wanted}
