"""Outlook Calendar, through Microsoft Graph. Resources are calendars; what is allowed on a calendar covers
its events.

Minerva connects through the Entra app the Microsoft connectors share (see `connectors.microsoft`). The
base scopes are `offline_access User.Read Calendars.Read`; creating events asks for `Calendars.ReadWrite`.
Microsoft's permission covers every calendar the account lists, including calendars others shared with
it, so the calendar limits are Minerva's.

A calendar is named by the id Graph lists, or `primary` for the default calendar. Each call looks the
calendar up first and authorizes the id Graph answers with, so a grant cannot be reached under another
spelling, and a calendar Graph does not find is refused like one without a grant.

Events are read only through one calendar's view (`calendarView`), which lists that calendar's events.
There is no tool to read an event by id: Graph resolves event ids across the mailbox, whatever calendar the
request names, so an id alone does not show which calendar an event is in. Listings return whole events
instead.

Graph answers all-day events at midnight UTC whatever zone is asked for, and without the zone they were
made in, so listings give the date of that midnight. For a calendar in a zone ahead of UTC, Graph is
reported to answer with the day before; the tool description says so rather than guess a correction.

Created events have no attendees, so no invitations are sent, and are not online meetings. Timed events
are sent in UTC. All-day events need the calendar owner's time zone: Outlook shows an all-day event created
in another zone across two days to people in the owner's zone. Graph accepts only some IANA zone names
(`ZONES`). Not supported: changing, deleting or answering events, attendees, recurrence, and group
calendars.
"""

import json
import re
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Self
from zoneinfo import available_timezones

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
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
    denied,
)
from connectors.microsoft import ID, consent, oauth
from connectors.outlook_calendar.client import Calendar, CalendarClient, Event, Time
from connectors.text import plain_text, single_line, truncate

CALENDAR = "calendar"
PRIMARY = "primary"
MAX_CALENDAR_PAGES = 10
MAX_BODY = 4000
MAX_ATTENDEES = 50
DEFAULT_WINDOW = timedelta(days=30)
MAX_WINDOW = timedelta(days=366)

READ_CONSENT = consent("Calendars.Read", "Calendars.ReadWrite")
WRITE_CONSENT = consent("Calendars.ReadWrite")

# The IANA names Graph documents as accepted besides Windows names (dateTimeTimeZone, "Additional time
# zones"), as far as this system knows them.
_DOCUMENTED_ZONES = """
Etc/GMT+12 Etc/GMT+11 Pacific/Honolulu America/Anchorage America/Santa_Isabel America/Los_Angeles
America/Phoenix America/Chihuahua America/Denver America/Guatemala America/Chicago America/Mexico_City
America/Regina America/Bogota America/New_York America/Indiana/Indianapolis America/Caracas
America/Asuncion America/Halifax America/Cuiaba America/La_Paz America/Santiago America/St_Johns
America/Sao_Paulo America/Argentina/Buenos_Aires America/Cayenne America/Godthab America/Montevideo
America/Bahia Etc/GMT+2 Atlantic/Azores Atlantic/Cape_Verde Africa/Casablanca Etc/GMT Europe/London
Atlantic/Reykjavik Europe/Berlin Europe/Budapest Europe/Paris Europe/Warsaw Africa/Lagos Africa/Windhoek
Europe/Bucharest Asia/Beirut Africa/Cairo Asia/Damascus Africa/Johannesburg Europe/Kyiv Europe/Istanbul
Asia/Jerusalem Asia/Amman Asia/Baghdad Europe/Kaliningrad Asia/Riyadh Africa/Nairobi Asia/Tehran
Asia/Dubai Asia/Baku Europe/Moscow Indian/Mauritius Asia/Tbilisi Asia/Yerevan Asia/Kabul Asia/Karachi
Asia/Kolkata Asia/Colombo Asia/Kathmandu Asia/Dhaka Asia/Yekaterinburg Asia/Bangkok Asia/Novosibirsk
Asia/Shanghai Asia/Krasnoyarsk Asia/Singapore Australia/Perth Asia/Taipei Asia/Ulaanbaatar Asia/Irkutsk
Asia/Tokyo Asia/Seoul Australia/Adelaide Australia/Darwin Australia/Brisbane Australia/Sydney
Pacific/Port_Moresby Australia/Hobart Asia/Yakutsk Pacific/Guadalcanal Asia/Vladivostok Pacific/Auckland
Etc/GMT-12 Pacific/Fiji Asia/Magadan Pacific/Tongatapu Pacific/Apia Pacific/Kiritimati
""".split()  # noqa: SIM905
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$")
# Times are converted and windows widened here, so years stay well inside what Python's dates hold.
YEARS = range(1900, 3000)
ZONES = frozenset({"UTC", *(zone for zone in _DOCUMENTED_ZONES if zone in available_timezones())})


def _date_time(value: str) -> str:
    if not DATE_TIME.match(value):
        raise ValueError("must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00")
    if datetime.fromisoformat(value).year not in YEARS:
        raise ValueError("must be between the years 1900 and 2999")
    return value


def _date_or_date_time(value: str) -> str:
    if DATE.match(value):
        if date.fromisoformat(value).year not in YEARS:
            raise ValueError("must be between the years 1900 and 2999")
        return value
    return _date_time(value)


def _zone(value: str) -> str:
    if value not in ZONES:
        raise ValueError(
            "must be an IANA time zone Microsoft accepts, like Europe/Berlin or America/New_York"
        )
    return value


def _calendar_ref(value: str) -> str:
    if value != PRIMARY and not ID.match(value):
        raise ValueError('must be a calendar id from list_calendars, or "primary"')
    return value


CalendarRef = Annotated[
    str,
    Field(
        min_length=1,
        max_length=512,
        description='A calendar id from list_calendars, or "primary" for the default calendar.',
    ),
    AfterValidator(_calendar_ref),
]
DateTime = Annotated[str, Field(max_length=40), AfterValidator(_date_time)]
DateOrDateTime = Annotated[str, Field(max_length=40), AfterValidator(_date_or_date_time)]


def _utc(value: str) -> str:
    moment = datetime.fromisoformat(value).astimezone(UTC).replace(tzinfo=None)
    return f"{moment.isoformat(timespec='microseconds' if moment.microsecond else 'seconds')}Z"


async def _all_calendars(client: CalendarClient) -> list[Calendar]:
    calendars: list[Calendar] = []
    cursor: str | None = None
    for _ in range(MAX_CALENDAR_PAGES):
        page, cursor = await client.calendars(cursor)
        calendars += [c for c in page if ID.match(c.id)]
        if cursor is None:
            return calendars
    raise OperationError("PROVIDER_LIMIT", "This Microsoft account has more calendars than Minerva can list.")


async def _calendar_id(client: CalendarClient, ref: str) -> str:
    """The id Graph gives the calendar. Grants and requests use it, never `primary` or another spelling
    Graph also accepts; calendars Graph does not find or refuses are refused like calendars without a
    grant."""
    try:
        calendar = await client.calendar(None if ref == PRIMARY else ref)
    except OperationError as error:
        if error.code in ("NOT_FOUND", "PROVIDER_FORBIDDEN"):
            raise denied() from None
        raise
    if not ID.match(calendar.id):
        raise client.unexpected()
    return calendar.id


def _time(value: Time | None, all_day: bool) -> str | None:
    if value is None:
        return None
    moment = value.date_time[:19]
    if all_day:
        # Graph answers all-day events at midnight UTC, whatever zone was asked for (see the module).
        return moment[:10]
    if (value.time_zone or "").upper() == "UTC":
        return f"{moment}Z"
    return f"{moment} {value.time_zone}"


def _address(recipient: Any) -> str | None:
    return recipient.email_address.address if recipient and recipient.email_address else None


def _event(binding: Binding, calendar_id: str, event: Event) -> ScopedRecord:
    all_day = bool(event.is_all_day)
    body, cut = truncate(event.body.content if event.body else None, MAX_BODY)
    attendees = [
        {
            "email": a.email_address.address if a.email_address else None,
            "name": a.email_address.name if a.email_address else None,
            "type": a.type,
            "response": a.status.response if a.status else None,
        }
        for a in event.attendees[:MAX_ATTENDEES]
    ]
    return ScopedRecord(
        binding.resource(CALENDAR, calendar_id),
        {
            "id": event.id,
            "calendar_id": calendar_id,
            "subject": event.subject,
            "body": body,
            "body_truncated": cut,
            "start": _time(event.start, all_day),
            "end": _time(event.end, all_day),
            "all_day": all_day,
            "cancelled": bool(event.is_cancelled),
            "show_as": event.show_as,
            "sensitivity": event.sensitivity,
            "location": event.location.display_name if event.location else None,
            "organizer": _address(event.organizer),
            "attendees": attendees,
            "attendees_incomplete": len(event.attendees) > MAX_ATTENDEES,
            "online_meeting_url": event.online_meeting.join_url if event.online_meeting else None,
            "link": event.web_link,
            "type": event.type,
            "series_master_id": event.series_master_id,
            "categories": event.categories,
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
                        "default": bool(c.is_default_calendar),
                        "can_edit": c.can_edit,
                        "owner": c.owner.address if c.owner else None,
                    },
                )
                for c in await _all_calendars(binding.client)
            ]
        )

    return Prepared([Enumerate(CALENDAR, "read")], execute)


LIST_CALENDARS = Operation(
    name="list_calendars",
    title="List calendars",
    description="List the Outlook calendars you may read.",
    input_model=ListCalendars,
    needs=((CALENDAR, "read"),),
    prepare=_prepare_list_calendars,
    consent=READ_CONSENT,
)


class ListEvents(OperationInput):
    calendar_id: CalendarRef
    time_min: Annotated[DateTime | None, Field(description="Only events that end after this time.")] = None
    time_max: Annotated[DateTime | None, Field(description="Only events that start before this time.")] = None
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Annotated[str, Field(max_length=1000)] | None = None

    @model_validator(mode="after")
    def _window(self) -> Self:
        if self.time_min and self.time_max:
            span = datetime.fromisoformat(self.time_max) - datetime.fromisoformat(self.time_min)
            if span <= timedelta(0):
                raise ValueError("time_max must be after time_min")
            if span > MAX_WINDOW:
                raise ValueError("time_min and time_max may be at most 366 days apart")
        return self

    def window(self) -> tuple[str, str]:
        """The window in UTC: as given, or 30 days from or to the one bound given, or from now."""
        if self.time_min and self.time_max:
            return _utc(self.time_min), _utc(self.time_max)
        if self.time_min:
            start = datetime.fromisoformat(self.time_min)
            return _utc(self.time_min), _utc((start + DEFAULT_WINDOW).isoformat())
        if self.time_max:
            end = datetime.fromisoformat(self.time_max)
            return _utc((end - DEFAULT_WINDOW).isoformat()), _utc(self.time_max)
        now = datetime.now(UTC)
        return _utc(now.isoformat()), _utc((now + DEFAULT_WINDOW).isoformat())


def _page_state(cursor: str, calendar_id: str) -> dict[str, str]:
    """Minerva's cursor: Graph's page and the window the first page used, for the calendar it was for."""
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    keys = ("calendar", "page", "start", "end")
    if (
        not isinstance(state, dict)
        or set(state) != set(keys)
        or not all(isinstance(state[key], str) for key in keys)
        or state["calendar"] != calendar_id
    ):
        raise OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.")
    return state


async def _prepare_list_events(binding: Binding, data: ListEvents) -> Prepared:
    client: CalendarClient = binding.client
    calendar_id = await _calendar_id(client, data.calendar_id)
    state = _page_state(data.cursor, calendar_id) if data.cursor else None
    start, end = (state["start"], state["end"]) if state else data.window()

    async def execute() -> ProviderOutput:
        events, page = await client.view(
            calendar_id, start=start, end=end, limit=data.limit, cursor=state["page"] if state else None
        )
        next_cursor = None
        if page is not None:
            next_cursor = json.dumps({"calendar": calendar_id, "page": page, "start": start, "end": end})
            if len(next_cursor) > 1000:
                raise OperationError(
                    "PROVIDER_LIMIT", "Microsoft Graph returned a page token that is too long."
                )
        return ProviderOutput([_event(binding, calendar_id, e) for e in events], next_cursor)

    return Prepared([Need(binding.resource(CALENDAR, calendar_id), "read")], execute)


LIST_EVENTS = Operation(
    name="list_events",
    title="List events",
    description=(
        "List the events of one calendar you may read that overlap a window of time, ordered by start, "
        "with recurring events expanded and each event in full. Without time_min or time_max, lists the "
        "next 30 days; with one of them, 30 days from or to it. The window is at most 366 days. Times are "
        "returned in UTC; all-day events have dates, the end being the day after the last day, as "
        "Microsoft reports them: for a calendar in a time zone ahead of UTC they may be a day early. To get "
        "the next page, repeat the call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListEvents,
    needs=((CALENDAR, "read"),),
    prepare=_prepare_list_events,
    consent=READ_CONSENT,
    paginated=True,
)


class CreateEvent(OperationInput):
    calendar_id: CalendarRef
    subject: Annotated[str, Field(min_length=1, max_length=255), AfterValidator(single_line)]
    start: Annotated[
        DateOrDateTime,
        Field(description="YYYY-MM-DD for an all-day event, or an RFC 3339 date-time with an offset."),
    ]
    end: Annotated[
        DateOrDateTime,
        Field(description="Same format as start. For all-day events, the day after the last day."),
    ]
    time_zone: Annotated[
        Annotated[str, Field(max_length=64), AfterValidator(_zone)] | None,
        Field(
            description=(
                "Required for all-day events, and only for them: the calendar owner's IANA time zone, "
                "like Europe/Berlin."
            )
        ),
    ] = None
    body: Annotated[str, Field(max_length=8000), AfterValidator(plain_text)] | None = None
    location: Annotated[str, Field(max_length=500), AfterValidator(single_line)] | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        all_day = bool(DATE.match(self.start))
        if all_day != bool(DATE.match(self.end)):
            raise ValueError("start and end must both be dates or both be date-times")
        if all_day:
            ordered = date.fromisoformat(self.end) > date.fromisoformat(self.start)
            if self.time_zone is None:
                raise ValueError("time_zone is required for all-day events")
        else:
            ordered = datetime.fromisoformat(self.end) > datetime.fromisoformat(self.start)
            if self.time_zone is not None:
                raise ValueError("time_zone is only for all-day events; give timed events an offset")
        if not ordered:
            raise ValueError("end must be after start")
        return self

    def payload(self) -> dict[str, Any]:
        all_day = bool(DATE.match(self.start))
        if all_day:
            zone = self.time_zone
            start, end = f"{self.start}T00:00:00", f"{self.end}T00:00:00"
        else:
            zone = "UTC"
            start, end = _utc(self.start).removesuffix("Z"), _utc(self.end).removesuffix("Z")
        event: dict[str, Any] = {
            "subject": self.subject,
            "start": {"dateTime": start, "timeZone": zone},
            "end": {"dateTime": end, "timeZone": zone},
            "isAllDay": all_day,
            "attendees": [],
            "isOnlineMeeting": False,
        }
        if self.body:
            event["body"] = {"contentType": "text", "content": self.body}
        if self.location:
            event["location"] = {"displayName": self.location}
        return event


async def _prepare_create_event(binding: Binding, data: CreateEvent) -> Prepared:
    client: CalendarClient = binding.client
    calendar_id = await _calendar_id(client, data.calendar_id)

    async def execute() -> ProviderOutput:
        event = await client.create(calendar_id, data.payload())
        return ProviderOutput([_event(binding, calendar_id, event)])

    return Prepared([Need(binding.resource(CALENDAR, calendar_id), "create")], execute)


CREATE_EVENT = Operation(
    name="create_event",
    title="Create an event",
    description=(
        "Create one event in a calendar where you have create permission. The event has no attendees, "
        "so no invitations are sent, but everyone who can see the calendar can see the event. All-day "
        "events need the calendar owner's time zone. The number of writes per run is limited."
    ),
    input_model=CreateEvent,
    needs=((CALENDAR, "create"),),
    prepare=_prepare_create_event,
    consent=WRITE_CONSENT,
    mutates=True,
)


class OutlookCalendarConnector(Connector):
    slug = "outlook_calendar"
    name = "Outlook Calendar"
    kinds = (
        ResourceKind(
            CALENDAR,
            "Calendar",
            ("read", "create"),
            wildcard=True,
            note=(
                "Microsoft lets Minerva read every calendar of the account, including calendars others "
                "shared with it; Minerva limits agents to the calendars allowed here."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read events"),
        ActionSpec("create", "Create events", requires="read"),
    )
    # Reading is enough to connect; writing is asked for once the user allows an agent to write.
    auth = oauth("Calendars.Read")

    operations = (LIST_CALENDARS, LIST_EVENTS, CREATE_EVENT)

    def client(self, access_token: str) -> CalendarClient:
        return CalendarClient(access_token)

    async def account(self, client: CalendarClient) -> Account:
        user = await client.me()
        return Account(
            id=user.id, label=user.mail or user.user_principal_name or user.display_name or "Outlook"
        )

    async def discover(
        self, client: CalendarClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        calendars = await _all_calendars(client)
        if query:
            text = query.casefold()
            calendars = [c for c in calendars if text in c.name.casefold()]
        return DiscoveryPage([DiscoveryItem(c.id, c.name) for c in calendars])

    async def describe(self, client: CalendarClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        return {c.id: c.name for c in await _all_calendars(client) if c.id in wanted}
