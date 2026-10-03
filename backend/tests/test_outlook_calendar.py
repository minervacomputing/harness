"""Outlook Calendar connector against an in-memory Microsoft Graph, and runs through the executor."""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from connector_runs import ceiling, refusal

from connections import oauth as connection_oauth
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.outlook_calendar import connector as calendar_module
from connectors.outlook_calendar.client import CalendarClient
from connectors.outlook_calendar.connector import ZONES, OutlookCalendarConnector, _page_state
from permissions.models import Grant

SECRET = "SECRET merger"
DEFAULT, WORK, SHARED, PRIVATE = "AAMkCALDEFAULT", "AAMkCALWORK000", "AAMkCALSHARED0", "AAMkCALPRIVATE"
# Another id Graph accepts for Work (an id from before immutable ids), answered with Work's own id.
WORK_ALIAS = "AQMkLEGACYWORK"
USER_ID = "00000000-0000-0000-0000-00000000a0a0"
READ_SCOPES = ["Calendars.Read", "User.Read", "openid", "profile"]
WRITE_SCOPES = ["Calendars.ReadWrite", "User.Read", "openid", "profile"]


def _calendar(calendar_id: str, name: str, *, default: bool = False, owner: str = "me@contoso.com") -> dict:
    return {
        "id": calendar_id,
        "name": name,
        "isDefaultCalendar": default,
        "canEdit": owner == "me@contoso.com",
        "owner": {"name": owner, "address": owner},
    }


def _timed(event_id: str, start: str, end: str, **fields) -> dict:
    return {
        "id": event_id,
        "subject": event_id.title(),
        "body": {"contentType": "text", "content": "Agenda"},
        "start": {"dateTime": f"{start}.0000000", "timeZone": "UTC"},
        "end": {"dateTime": f"{end}.0000000", "timeZone": "UTC"},
        "isAllDay": False,
        "isCancelled": False,
        "showAs": "busy",
        "sensitivity": "normal",
        "location": {"displayName": "Room 1"},
        "organizer": {"emailAddress": {"name": "Grace", "address": "grace@example.com"}},
        "attendees": [],
        "webLink": f"https://outlook.office365.com/owa/?itemid={event_id}",
        "type": "singleInstance",
        "categories": [],
        **fields,
    }


class FakeGraph:
    """Microsoft Graph's calendar API, served through httpx.MockTransport.

    Calendars: the default one, Work, a calendar Grace shared, and Private. Graph also finds Work under an
    older id, and answers with the id it lists.
    """

    def __init__(self) -> None:
        self.calendars = {
            DEFAULT: _calendar(DEFAULT, "Calendar", default=True),
            WORK: _calendar(WORK, "Work"),
            SHARED: _calendar(SHARED, "Grace's calendar", owner="grace@example.com"),
            PRIVATE: _calendar(PRIVATE, "Private"),
        }
        attendees = [
            {
                "emailAddress": {"name": f"Person {i}", "address": f"p{i}@example.com"},
                "type": "required",
                "status": {"response": "accepted", "time": "0001-01-01T00:00:00Z"},
            }
            for i in range(52)
        ]
        self.events = {
            DEFAULT: [
                _timed(
                    "standup00001",
                    "2026-10-05T07:00:00",
                    "2026-10-05T07:15:00",
                    body={"contentType": "text", "content": "x" * 5000},
                    attendees=attendees,
                    onlineMeeting={"joinUrl": "https://teams.microsoft.com/l/meetup-join/1"},
                ),
                {
                    **_timed("holiday00001", "2026-10-06T00:00:00", "2026-10-08T00:00:00"),
                    "isAllDay": True,
                    "showAs": "free",
                },
                _timed("review000001", "2026-10-09T13:00:00", "2026-10-09T14:00:00"),
            ],
            WORK: [_timed("planning0001", "2026-10-05T09:00:00", "2026-10-05T10:00:00")],
            SHARED: [_timed("graces000001", "2026-10-05T11:00:00", "2026-10-05T12:00:00")],
            PRIVATE: [_timed("private00001", "2026-10-05T18:00:00", "2026-10-05T19:00:00", subject=SECRET)],
        }
        self.user = {
            "id": USER_ID,
            "displayName": "Me",
            "mail": "me@contoso.com",
            "userPrincipalName": "me@contoso.onmicrosoft.com",
        }
        self.page_size: int | None = None
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _not_found() -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "ErrorItemNotFound", "message": SECRET}})

    def _find(self, calendar_id: str) -> dict | None:
        return self.calendars.get(WORK if calendar_id == WORK_ALIAS else calendar_id)

    def _page(self, path: str, items: list, params: dict) -> dict:
        top = self.page_size or int(params.get("$top", 10))
        start = int(params.get("$skip", 0))
        body: dict = {"value": items[start : start + top]}
        if start + top < len(items):
            body["@odata.nextLink"] = f"https://graph.microsoft.com/v1.0{path}?$top={top}&$skip={start + top}"
        return body

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/v1.0")
        params = dict(request.url.params)
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        parts = path.strip("/").split("/")
        if request.method == "POST":
            event = json.loads(request.content)
            self.writes.append((path, event))
            match parts:
                case ["me", "calendars", calendar_id, "events"] if self._find(calendar_id):
                    created = {
                        **_timed("created00001", "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
                        "subject": event["subject"],
                        "start": event["start"],
                        "end": event["end"],
                        "isAllDay": event["isAllDay"],
                        "organizer": {"emailAddress": {"address": "me@contoso.com"}},
                    }
                    return httpx.Response(201, json=created)
            raise AssertionError(path)
        match parts:
            case ["me"]:
                return httpx.Response(200, json=self.user)
            case ["me", "calendar"]:
                return httpx.Response(200, json=self.calendars[DEFAULT])
            case ["me", "calendars"]:
                return httpx.Response(200, json=self._page(path, list(self.calendars.values()), params))
            case ["me", "calendars", calendar_id]:
                found = self._find(calendar_id)
                return httpx.Response(200, json=found) if found else self._not_found()
            case ["me", "calendars", calendar_id, "calendarView"]:
                found = self._find(calendar_id)
                if found is None:
                    return self._not_found()
                assert {"startDateTime", "endDateTime"} <= set(params)
                return httpx.Response(200, json=self._page(path, self.events[found["id"]], params))
        raise AssertionError(path)

    def views(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith("/calendarView")]

    def client(self) -> CalendarClient:
        return CalendarClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


@pytest.fixture
def start(connector_run, graph, monkeypatch):
    """Starts a run with the user's Outlook Calendar connection, holding `grants` ({calendar: actions})."""
    monkeypatch.setattr(OutlookCalendarConnector, "client", lambda self, token: graph.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = WRITE_SCOPES):
        calendars = {("calendar", calendar_id): actions for calendar_id, actions in grants.items()}
        return connector_run(
            "outlook_calendar", calendars, scopes=scopes, label="me@contoso.com", external_account_id=USER_ID
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


# Connecting and discovery


async def test_account_discovery_and_names(graph):
    connector = OutlookCalendarConnector()
    client = graph.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (USER_ID, "me@contoso.com")
    page = await connector.discover(client, "calendar", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (DEFAULT, "Calendar"),
        (WORK, "Work"),
        (SHARED, "Grace's calendar"),
        (PRIVATE, "Private"),
    ]
    found = await connector.discover(client, "calendar", query="GRACE", cursor=None)
    assert [i.id for i in found.items] == [SHARED]
    described = await connector.describe(
        client, "calendar", [WORK, WORK.lower(), WORK_ALIAS, "AAMkNOSUCHCAL", "primary"]
    )
    assert described == {WORK: "Work"}


async def test_calendar_pages_are_followed_up_to_a_cap(graph, monkeypatch):
    graph.page_size = 1
    page = await OutlookCalendarConnector().discover(graph.client(), "calendar", query=None, cursor=None)
    assert len(page.items) == 4
    assert [r.url.params.get("$skip") for r in graph.requests] == [None, "1", "2", "3"]
    monkeypatch.setattr(calendar_module, "MAX_CALENDAR_PAGES", 2)
    with pytest.raises(OperationError) as caught:
        await OutlookCalendarConnector().discover(graph.client(), "calendar", query=None, cursor=None)
    assert caught.value.code == "PROVIDER_LIMIT"


def test_calendar_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("outlook_calendar")
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    base = ["offline_access", "User.Read", "Calendars.Read"]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    assert connection_oauth.requested_scopes(connector, {"read", "create"}) == [*base, "Calendars.ReadWrite"]
    url = connection_oauth.authorization_url(
        {}, workspace_id=uuid4(), provider="outlook_calendar", scopes=base
    )
    assert url.startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset({"User.Read", "Calendars.Read"}), {"read", "create"}) == ["create"]
    # Read-write covers reading, in any of the spellings Microsoft reports.
    assert (
        needed(connector, frozenset({"https://graph.microsoft.com/calendars.readwrite"}), {"read", "create"})
        == []
    )
    assert needed(connector, frozenset({"calendars.read"}), {"read"}) == []
    assert needed(connector, frozenset({"Calendars.ReadBasic"}), {"read"}) == ["read"]


def test_only_documented_zones_are_offered():
    assert {"UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"} <= ZONES
    assert not {"Europe/Zurich", "US/Eastern", "CET", "Local"} & ZONES


def test_cursors_belong_to_their_calendar():
    state = {"calendar": WORK, "page": "skip:2", "start": "a", "end": "b"}
    assert _page_state(json.dumps(state), WORK) == state
    for cursor, calendar_id in (
        (json.dumps(state), DEFAULT),
        (json.dumps({**state, "extra": "x"}), WORK),
        (json.dumps({**state, "page": 2}), WORK),
        (json.dumps([state]), WORK),
        ("skip:2", WORK),
    ):
        with pytest.raises(OperationError) as caught:
            _page_state(cursor, calendar_id)
        assert caught.value.code == "INVALID_CURSOR"


# Reading


@pytest.mark.django_db(transaction=True)
async def test_calendars_without_a_grant_or_unknown_look_alike(start, graph):
    executor = await start({WORK: ("read",), SHARED: ("read",)})
    assert _ids(await executor.invoke("outlook_calendar_list_calendars", {})) == [WORK, SHARED]
    shared = _items(await executor.invoke("outlook_calendar_list_calendars", {}))[1]
    assert shared == {
        "id": SHARED,
        "name": "Grace's calendar",
        "default": False,
        "can_edit": False,
        "owner": "grace@example.com",
    }
    for calendar_id in (PRIVATE, "primary", "AAMkNOSUCHCAL"):
        args = {"calendar_id": calendar_id}
        assert await refusal(executor, "outlook_calendar_list_events", args) == "POLICY_DENIED"
    assert not graph.views()
    # Another id Graph accepts for a granted calendar is that calendar.
    outcome = await executor.invoke("outlook_calendar_list_events", {"calendar_id": WORK_ALIAS})
    assert {e["calendar_id"] for e in _items(outcome)} == {WORK}
    assert graph.views()[-1].url.path == f"/v1.0/me/calendars/{WORK}/calendarView"
    for calendar_id in ("Work", "../me", "short", "AAMk/CAL/WORK"):
        args = {"calendar_id": calendar_id}
        assert await refusal(executor, "outlook_calendar_list_events", args) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_a_deny_holds_under_every_id_graph_accepts(start, graph):
    await start({})
    await ceiling("outlook_calendar", "calendar", DEFAULT, Grant.Effect.DENY)
    await ceiling("outlook_calendar", "calendar", WORK, Grant.Effect.DENY, actions=("create",))
    executor = await start({"*": ("read", "create")})
    assert (
        await refusal(executor, "outlook_calendar_list_events", {"calendar_id": "primary"}) == "POLICY_DENIED"
    )
    assert (
        await refusal(executor, "outlook_calendar_list_events", {"calendar_id": DEFAULT}) == "POLICY_DENIED"
    )
    assert DEFAULT not in _ids(await executor.invoke("outlook_calendar_list_calendars", {}))
    assert not graph.views()
    event = {"subject": "x", "start": "2026-10-05T10:00:00Z", "end": "2026-10-05T11:00:00Z"}
    for calendar_id in ("primary", WORK, WORK_ALIAS):
        args = {"calendar_id": calendar_id, **event}
        assert await refusal(executor, "outlook_calendar_create_event", args) == "POLICY_DENIED"
    assert not graph.writes
    await executor.invoke("outlook_calendar_list_events", {"calendar_id": WORK_ALIAS})
    await executor.invoke("outlook_calendar_create_event", {"calendar_id": SHARED, **event})
    assert [path for path, _ in graph.writes] == [f"/me/calendars/{SHARED}/events"]


@pytest.mark.django_db(transaction=True)
async def test_events_are_read_in_utc_and_in_full(start, graph):
    executor = await start({DEFAULT: ("read",)})
    args = {
        "calendar_id": "primary",
        "time_min": "2026-10-01T00:00:00+02:00",
        "time_max": "2026-10-31T00:00:00Z",
    }
    standup, holiday, review = _items(await executor.invoke("outlook_calendar_list_events", args))
    [request] = graph.views()
    assert request.url.path == f"/v1.0/me/calendars/{DEFAULT}/calendarView"
    params = request.url.params
    assert (params["startDateTime"], params["endDateTime"]) == (
        "2026-09-30T22:00:00Z",
        "2026-10-31T00:00:00Z",
    )
    assert params["$orderby"] == "start/dateTime" and params["$top"] == "25"
    prefer = request.headers["Prefer"]
    assert 'outlook.timezone="UTC"' in prefer and 'outlook.body-content-type="text"' in prefer
    assert 'IdType="ImmutableId"' in prefer

    assert (standup["start"], standup["end"], standup["all_day"]) == (
        "2026-10-05T07:00:00Z",
        "2026-10-05T07:15:00Z",
        False,
    )
    assert standup["calendar_id"] == DEFAULT
    assert len(standup["body"]) <= 4000 and standup["body_truncated"]
    assert len(standup["attendees"]) == 50 and standup["attendees_incomplete"]
    assert standup["attendees"][0] == {
        "email": "p0@example.com",
        "name": "Person 0",
        "type": "required",
        "response": "accepted",
    }
    assert standup["online_meeting_url"] == "https://teams.microsoft.com/l/meetup-join/1"
    assert standup["organizer"] == "grace@example.com" and standup["location"] == "Room 1"
    assert (holiday["start"], holiday["end"], holiday["all_day"]) == ("2026-10-06", "2026-10-08", True)
    assert review["body"] == "Agenda" and not review["body_truncated"] and not review["attendees_incomplete"]


@pytest.mark.django_db(transaction=True)
async def test_the_window_defaults_to_thirty_days(start, graph):
    executor = await start({DEFAULT: ("read",)})

    def window() -> tuple[datetime, datetime]:
        params = graph.views()[-1].url.params
        return datetime.fromisoformat(params["startDateTime"]), datetime.fromisoformat(params["endDateTime"])

    before = datetime.now(UTC).replace(microsecond=0)
    await executor.invoke("outlook_calendar_list_events", {"calendar_id": DEFAULT})
    start_at, end_at = window()
    assert before <= start_at <= datetime.now(UTC) and end_at - start_at == timedelta(days=30)
    await executor.invoke(
        "outlook_calendar_list_events", {"calendar_id": DEFAULT, "time_min": "2026-10-01T09:00:00+02:00"}
    )
    assert window() == (datetime(2026, 10, 1, 7, tzinfo=UTC), datetime(2026, 10, 31, 7, tzinfo=UTC))
    await executor.invoke(
        "outlook_calendar_list_events", {"calendar_id": DEFAULT, "time_max": "2026-10-31T00:00:00Z"}
    )
    assert window() == (datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 10, 31, tzinfo=UTC))
    # Fractions of a second are kept.
    bounds = {"time_min": "2026-10-01T00:00:00.5+02:00", "time_max": "2026-10-01T00:00:00.75+02:00"}
    await executor.invoke("outlook_calendar_list_events", {"calendar_id": DEFAULT, **bounds})
    params = graph.views()[-1].url.params
    assert (params["startDateTime"], params["endDateTime"]) == (
        "2026-09-30T22:00:00.500000Z",
        "2026-09-30T22:00:00.750000Z",
    )

    for bounds in (
        {"time_min": "2026-10-02T00:00:00Z", "time_max": "2026-10-01T00:00:00Z"},
        {"time_min": "2026-01-01T00:00:00Z", "time_max": "2027-01-03T00:00:00Z"},
        {"time_min": "2026-10-01"},
        {"time_min": "2026-10-01T09:00:00"},
        {"time_min": "2026-W40-1T09:00:00Z"},
        {"time_min": "2026-10-01T09:00:00+00:99"},
        {"time_min": "9999-12-31T00:00:00Z"},
        {"time_max": "0001-01-01T00:00:00Z"},
    ):
        args = {"calendar_id": DEFAULT, **bounds}
        assert await refusal(executor, "outlook_calendar_list_events", args) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_later_pages_repeat_the_first_pages_window(start, graph):
    executor = await start({DEFAULT: ("read",)})
    args = {"calendar_id": DEFAULT, "time_min": "2026-10-01T00:00:00Z", "limit": 2}
    first = await executor.invoke("outlook_calendar_list_events", args)
    assert _ids(first) == ["standup00001", "holiday00001"]
    token = first.result["next_cursor"]
    assert "skip" not in token
    first_params = graph.views()[-1].url.params
    second = await executor.invoke("outlook_calendar_list_events", {**args, "cursor": token})
    assert _ids(second) == ["review000001"] and "next_cursor" not in second.result
    params = graph.views()[-1].url.params
    assert params["$skip"] == "2"
    assert 'outlook.timezone="UTC"' in graph.views()[-1].headers["Prefer"]
    assert (params["startDateTime"], params["endDateTime"]) == (
        first_params["startDateTime"],
        first_params["endDateTime"],
    )
    replay = {**args, "calendar_id": "primary", "cursor": token}
    assert await refusal(executor, "outlook_calendar_list_events", replay) == "INVALID_CURSOR"


# Creating


@pytest.mark.django_db(transaction=True)
async def test_creating_needs_the_create_grant_and_read_write_consent(start, graph):
    executor = await start({DEFAULT: ("read",), WORK: ("read", "create")})
    event = {"subject": "Focus", "start": "2026-10-05T10:00:00+02:00", "end": "2026-10-05T11:00:00+02:00"}
    for calendar_id in ("primary", DEFAULT, PRIVATE, "AAMkNOSUCHCAL"):
        args = {"calendar_id": calendar_id, **event}
        assert await refusal(executor, "outlook_calendar_create_event", args) == "POLICY_DENIED"
    assert not graph.writes

    # The user allowed it, but Microsoft has not given Minerva write access yet: the tool is not offered.
    executor = await start({WORK: ("read", "create")}, scopes=READ_SCOPES)
    assert "outlook_calendar_list_events" in executor.context.tools
    assert "outlook_calendar_create_event" not in executor.context.tools
    args = {"calendar_id": WORK, **event}
    assert await refusal(executor, "outlook_calendar_create_event", args) == "UNKNOWN_OPERATION"
    assert not graph.writes


@pytest.mark.django_db(transaction=True)
async def test_timed_events_are_sent_in_utc_without_attendees(start, graph):
    executor = await start({WORK: ("read", "create")})
    args = {
        "calendar_id": WORK_ALIAS,
        "subject": "Focus",
        "start": "2026-10-05T10:00:00+02:00",
        "end": "2026-10-05T11:30:00+02:00",
        "body": "Deep work\nNo meetings",
        "location": "Home",
    }
    [created] = _items(await executor.invoke("outlook_calendar_create_event", args))
    [(path, payload)] = graph.writes
    assert path == f"/me/calendars/{WORK}/events"
    assert payload == {
        "subject": "Focus",
        "start": {"dateTime": "2026-10-05T08:00:00", "timeZone": "UTC"},
        "end": {"dateTime": "2026-10-05T09:30:00", "timeZone": "UTC"},
        "isAllDay": False,
        "attendees": [],
        "isOnlineMeeting": False,
        "body": {"contentType": "text", "content": "Deep work\nNo meetings"},
        "location": {"displayName": "Home"},
    }
    assert 'outlook.timezone="UTC"' in graph.requests[-1].headers["Prefer"]
    assert (created["calendar_id"], created["subject"]) == (WORK, "Focus")
    assert (created["start"], created["end"]) == ("2026-10-05T08:00:00Z", "2026-10-05T09:30:00Z")


@pytest.mark.django_db(transaction=True)
async def test_all_day_events_are_created_in_the_owners_zone(start, graph):
    executor = await start({WORK: ("read", "create")})
    args = {
        "calendar_id": WORK,
        "subject": "Offsite",
        "start": "2026-10-12",
        "end": "2026-10-14",
        "time_zone": "Europe/Berlin",
    }
    await executor.invoke("outlook_calendar_create_event", args)
    [(_, payload)] = graph.writes
    assert payload["start"] == {"dateTime": "2026-10-12T00:00:00", "timeZone": "Europe/Berlin"}
    assert payload["end"] == {"dateTime": "2026-10-14T00:00:00", "timeZone": "Europe/Berlin"}
    assert payload["isAllDay"] is True and "body" not in payload and "location" not in payload

    for changes in (
        {"time_zone": None},
        {"time_zone": "Europe/Zurich"},
        {"time_zone": "Mars/Olympus"},
        {"end": "2026-10-12"},
        {"end": "2026-10-14T00:00:00Z"},
        {"start": "2026-10-12T09:00:00Z", "end": "2026-10-12T10:00:00Z"},
        {"subject": "Two\nlines"},
        {"subject": ""},
        {"start": "1899-12-31", "end": "1900-01-01"},
        {"start": "2026-10-12T09:00:00+24:00", "end": "2026-10-12T10:00:00Z", "time_zone": None},
        {"start": "2026-10-12T09:00:00.9Z", "end": "2026-10-12T09:00:00.1Z", "time_zone": None},
    ):
        attempt = {k: v for k, v in {**args, **changes}.items() if v is not None}
        assert await refusal(executor, "outlook_calendar_create_event", attempt) == "INVALID_ARGUMENTS"
    assert len(graph.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_write_outcomes_follow_graphs_status(start, graph):
    executor = await start({WORK: ("read", "create")})
    event = {"calendar_id": WORK, "start": "2026-10-05T10:00:00Z", "end": "2026-10-05T11:00:00Z"}

    def answer(response: httpx.Response):
        graph.hook = lambda method, path, params: response if method == "POST" else None

    answer(httpx.Response(400, json={"error": {"code": "ErrorInvalidRequest", "message": SECRET}}))
    assert (
        await refusal(executor, "outlook_calendar_create_event", {**event, "subject": "a"})
        == "PROVIDER_REJECTED"
    )
    answer(httpx.Response(403, json={"error": {"code": "ErrorAccessDenied", "message": SECRET}}))
    assert (
        await refusal(executor, "outlook_calendar_create_event", {**event, "subject": "b"})
        == "PROVIDER_FORBIDDEN"
    )
    # Created, but the answer cannot be read: the write counts, with nothing more to show.
    answer(httpx.Response(201, content=b"<html>"))
    applied = await executor.invoke("outlook_calendar_create_event", {**event, "subject": "c"})
    assert applied.result["outcome"] == "applied_without_result" and _items(applied) == []
    # A server error may follow the write: unknown, and further writes pause.
    answer(httpx.Response(500, json={"error": {"code": "x", "message": SECRET}}))
    assert (
        await refusal(executor, "outlook_calendar_create_event", {**event, "subject": "d"})
        == "WRITE_UNCERTAIN"
    )
    graph.hook = None
    assert (
        await refusal(executor, "outlook_calendar_create_event", {**event, "subject": "e"})
        == "WRITE_UNCERTAIN"
    )
