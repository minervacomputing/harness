"""Google Calendar connector against an in-memory Calendar API, and one run through the executor."""

import json
from urllib.parse import parse_qs, unquote, urlparse

import httpx
import pytest
from asgiref.sync import sync_to_async
from django.test import Client

from agents.models import Agent
from connections import services as connection_services
from connections.models import Connection
from connections.services import ClientCredentials
from connectors.base import OperationError
from connectors.executor import Executor, RunContext
from connectors.google_calendar import connector as calendar_module
from connectors.google_calendar.client import GoogleCalendarClient
from connectors.google_calendar.connector import (
    EVENTS_SCOPE,
    FULL_SCOPE,
    READ_SCOPE,
    GoogleCalendarConnector,
)
from conversations.models import Conversation
from permissions.models import Grant, PermissionLayer
from permissions.services import GrantChange, apply_grant_changes
from runs import services
from workspaces.models import Membership
from workspaces.tenancy import workspace_scope

PRIMARY = "ada@example.com"
UNIVERSITY = "uni@group.calendar.google.com"
HOLIDAYS = "de.german#holiday@group.v.calendar.google.com"


class FakeCalendar:
    """Google Calendar API v3 and the OpenID userinfo endpoint, served through httpx.MockTransport."""

    def __init__(self) -> None:
        self.calendars = [
            {
                "id": PRIMARY,
                "summary": PRIMARY,
                "primary": True,
                "accessRole": "owner",
                "timeZone": "Europe/Berlin",
            },
            {"id": UNIVERSITY, "summary": "Uni", "summaryOverride": "University", "accessRole": "owner"},
            {"id": HOLIDAYS, "summary": "Holidays in Germany", "accessRole": "reader"},
        ]
        self.page_size = 250
        self.sub = "108"
        self.events: dict[str, list[dict]] = {
            PRIMARY: [
                {
                    "id": f"e{i}",
                    "summary": f"Lecture {i}",
                    "start": {"dateTime": f"2026-10-0{i + 1}T09:00:00+02:00", "timeZone": "Europe/Berlin"},
                    "end": {"dateTime": f"2026-10-0{i + 1}T10:00:00+02:00", "timeZone": "Europe/Berlin"},
                }
                for i in range(3)
            ],
            UNIVERSITY: [{"id": "exam", "summary": "Exam", "start": {"date": "2026-10-10"}}],
            HOLIDAYS: [{"id": "unity", "status": "cancelled"}],
        }
        self.created: list[tuple[httpx.Request, dict]] = []
        self.requests: list[httpx.Request] = []
        self.error: tuple[int, dict] | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error:
            return httpx.Response(self.error[0], json=self.error[1])
        if request.url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"sub": self.sub, "email": PRIMARY, "name": "Ada"})
        if request.url.path == "/calendar/v3/users/me/calendarList":
            start = int(request.url.params.get("pageToken") or 0)
            end = start + self.page_size
            page = {"kind": "calendar#calendarList", "items": self.calendars[start:end]}
            if end < len(self.calendars):
                page["nextPageToken"] = str(end)
            return httpx.Response(200, json=page)
        # Calendar ids contain `#` and `@`, so segments are compared decoded.
        parts = [unquote(part) for part in request.url.raw_path.decode().split("?")[0].split("/")]
        match parts[3:]:
            case ["users", "me", "calendarList", calendar_id]:
                # Google also accepts other spellings of an id, such as a differently cased address.
                wanted = next(
                    (
                        c
                        for c in self.calendars
                        if c["id"].casefold() == calendar_id.casefold()
                        or (calendar_id == "primary" and c.get("primary"))
                    ),
                    None,
                )
                if wanted:
                    return httpx.Response(200, json=wanted)
            case ["calendars", calendar_id, "events"] if request.method == "GET":
                events = self.events.get(calendar_id, [])
                start = int((request.url.params.get("pageToken") or "google-0").removeprefix("google-"))
                end = start + int(request.url.params["maxResults"])
                page = {"items": events[start:end]}
                if end < len(events):
                    page["nextPageToken"] = f"google-{end}"
                return httpx.Response(200, json=page)
            case ["calendars", calendar_id, "events"] if request.method == "POST":
                body = json.loads(request.content)
                self.created.append((request, body))
                return httpx.Response(
                    200, json={**body, "id": f"new{len(self.created)}", "status": "confirmed"}
                )
            case ["calendars", calendar_id, "events", event_id]:
                found = next((e for e in self.events.get(calendar_id, []) if e["id"] == event_id), None)
                if found:
                    return httpx.Response(200, json=found)
        return httpx.Response(404, json={"error": {"code": 404, "message": "Not Found"}})

    def client(self) -> GoogleCalendarClient:
        return GoogleCalendarClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def google() -> FakeCalendar:
    return FakeCalendar()


def _google_error(reason: str) -> dict:
    return {"error": {"code": 403, "message": "no", "errors": [{"reason": reason, "domain": "usageLimits"}]}}


async def test_the_account_is_the_openid_subject(google):
    account = await GoogleCalendarConnector().account(google.client())
    assert (account.id, account.label) == ("108", PRIMARY)
    assert google.requests[0].headers["Authorization"] == "Bearer token"


async def test_discovery_pages_through_readable_calendars_and_filters_by_name(google):
    google.page_size = 2
    connector = GoogleCalendarConnector()
    page = await connector.discover(google.client(), "calendar", query=None, cursor=None)
    assert [(item.id, item.name) for item in page.items] == [
        (PRIMARY, PRIMARY),
        (UNIVERSITY, "University"),
        (HOLIDAYS, "Holidays in Germany"),
    ]
    assert len(google.requests) == 2
    assert google.requests[0].url.params["minAccessRole"] == "reader"
    page = await connector.discover(google.client(), "calendar", query="UNIVERS", cursor=None)
    assert [item.id for item in page.items] == [UNIVERSITY]
    names = await connector.describe(google.client(), "calendar", [UNIVERSITY, "gone"])
    assert names == {UNIVERSITY: "University"}


async def test_an_account_with_too_many_calendars_is_refused(google, monkeypatch):
    monkeypatch.setattr(calendar_module, "MAX_CALENDAR_PAGES", 2)
    google.page_size = 1
    with pytest.raises(OperationError) as caught:
        await GoogleCalendarConnector().discover(google.client(), "calendar", query=None, cursor=None)
    assert caught.value.code == "PROVIDER_LIMIT"


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (403, _google_error("rateLimitExceeded"), "PROVIDER_RATE_LIMITED"),
        (403, _google_error("userRateLimitExceeded"), "PROVIDER_RATE_LIMITED"),
        (403, _google_error("insufficientPermissions"), "PROVIDER_FORBIDDEN"),
        (403, {"unexpected": True}, "PROVIDER_FORBIDDEN"),
        (200, {"items": [{"summary": "no id"}]}, "PROVIDER_FAILED"),
    ],
)
async def test_provider_errors_are_mapped(google, status, body, code):
    google.error = (status, body)
    with pytest.raises(OperationError) as caught:
        await google.client().calendars()
    assert caught.value.code == code


BASE_SCOPES = ["openid", "email", READ_SCOPE]


@pytest.fixture
def start(scoped, user, google, monkeypatch):
    """Starts a run for an agent with the user's calendar connection, holding `scopes` and `grants`."""
    monkeypatch.setattr(GoogleCalendarConnector, "client", lambda self, token: google.client())

    def start_(scopes: list[str], grants: dict[str, tuple[str, ...]]) -> Executor:
        with workspace_scope(scoped.id):
            connection = Connection.objects.filter(provider="google_calendar").first() or Connection(
                provider="google_calendar", owner=user, label=PRIMARY, external_account_id="108"
            )
            connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": scopes})
            connection.save()
            Grant.objects.filter(connection=connection, layer__level=PermissionLayer.Level.USER).delete()
            changes = [GrantChange("calendar", cid, actions) for cid, actions in grants.items()]
            if changes:
                apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})
            agent = Agent.objects.get()
            agent.connections.set([connection])
            conversation = Conversation.objects.create(agent=agent, user=user)
            _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
        services.claim_queued(10)
        run.refresh_from_db()
        return Executor(RunContext.from_run(run))

    return sync_to_async(start_)


READS = {PRIMARY: ("read",), UNIVERSITY: ("read",)}


@pytest.mark.django_db(transaction=True)
async def test_an_agent_lists_only_the_calendars_it_was_granted(start):
    executor = await start(BASE_SCOPES, READS)
    outcome = await executor.invoke("google_calendar_list_calendars", {})
    assert [item["id"] for item in outcome.result["items"]] == [PRIMARY, UNIVERSITY]
    assert outcome.result["items"][1]["name"] == "University"

    # Without consent to calendar access the tool is refused, and no longer offered.
    def revoke_consent() -> None:
        connection = Connection.unscoped.get(provider="google_calendar")
        connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": ["openid", "email"]})
        connection.save()

    await sync_to_async(revoke_consent)()
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_calendar_list_calendars", {})
    assert caught.value.code == "CONSENT_REQUIRED"
    assert "google_calendar_list_calendars" not in (await start(["openid"], READS)).context.tools


@pytest.mark.django_db(transaction=True)
async def test_events_are_listed_only_from_granted_calendars(start, google):
    executor = await start(BASE_SCOPES, READS)
    outcome = await executor.invoke("google_calendar_list_events", {"calendar_id": UNIVERSITY})
    assert [(e["id"], e["all_day"], e["calendar_id"]) for e in outcome.result["items"]] == [
        ("exam", True, UNIVERSITY)
    ]
    params = google.requests[-1].url.params
    assert (params["singleEvents"], params["orderBy"]) == ("true", "startTime")
    # Without bounds, events are listed from now on.
    assert "timeMin" in params and "timeMax" not in params
    with pytest.raises(OperationError) as denied:
        await executor.invoke("google_calendar_list_events", {"calendar_id": HOLIDAYS})
    assert denied.value.code == "POLICY_DENIED"
    assert all(HOLIDAYS not in r.url.raw_path.decode() for r in google.requests if "events" in r.url.path)


@pytest.mark.django_db(transaction=True)
async def test_primary_resolves_to_the_real_calendar_and_its_grant(start, google):
    executor = await start(BASE_SCOPES, {UNIVERSITY: ("read",)})
    with pytest.raises(OperationError) as denied:
        await executor.invoke("google_calendar_list_events", {"calendar_id": "primary"})
    assert denied.value.code == "POLICY_DENIED"

    executor = await start(BASE_SCOPES, {PRIMARY: ("read",)})
    outcome = await executor.invoke("google_calendar_get_event", {"calendar_id": "primary", "event_id": "e1"})
    [event] = outcome.result["items"]
    assert (event["calendar_id"], event["summary"], event["time_zone"]) == (
        PRIMARY,
        "Lecture 1",
        "Europe/Berlin",
    )
    assert unquote(google.requests[-1].url.raw_path.decode()).endswith(f"/calendars/{PRIMARY}/events/e1")


@pytest.mark.django_db(transaction=True)
async def test_other_spellings_of_a_calendar_id_meet_its_grants(start, google):
    def deny_university() -> None:
        Grant.objects.create(
            layer=PermissionLayer.unscoped.get(level=PermissionLayer.Level.CEILING),
            connection=Connection.unscoped.get(provider="google_calendar"),
            resource_kind="calendar",
            resource_id=UNIVERSITY,
            actions=["read"],
            effect=Grant.Effect.DENY,
        )

    await start(BASE_SCOPES, {})
    await sync_to_async(deny_university)()
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    for spelling in (UNIVERSITY, UNIVERSITY.upper()):
        with pytest.raises(OperationError) as denied:
            await executor.invoke("google_calendar_list_events", {"calendar_id": spelling})
        assert denied.value.code == "POLICY_DENIED"
    # Calendars outside the user's list are refused even under a wildcard grant.
    with pytest.raises(OperationError) as unlisted:
        await executor.invoke("google_calendar_list_events", {"calendar_id": "eve@example.com"})
    assert unlisted.value.code == "POLICY_DENIED"
    assert not [r for r in google.requests if r.url.path.endswith("/events")]
    outcome = await executor.invoke("google_calendar_list_events", {"calendar_id": PRIMARY.upper()})
    assert {e["calendar_id"] for e in outcome.result["items"]} == {PRIMARY}


@pytest.mark.django_db(transaction=True)
async def test_later_pages_repeat_the_first_pages_time_bound(start, google):
    executor = await start(BASE_SCOPES, READS)
    args = {"calendar_id": PRIMARY, "limit": 2, "search": "Lecture"}
    first = await executor.invoke("google_calendar_list_events", args)
    assert [e["id"] for e in first.result["items"]] == ["e0", "e1"]
    token = first.result["next_cursor"]
    assert "google-" not in token
    first_request = google.requests[-1].url.params
    assert first_request["q"] == "Lecture"
    second = await executor.invoke("google_calendar_list_events", {**args, "cursor": token})
    assert [e["id"] for e in second.result["items"]] == ["e2"]
    assert "next_cursor" not in second.result
    params = google.requests[-1].url.params
    assert (params["pageToken"], params["timeMin"]) == ("google-2", first_request["timeMin"])
    with pytest.raises(OperationError) as replay:
        await executor.invoke("google_calendar_list_events", {**args, "search": "Exam", "cursor": token})
    assert replay.value.code == "INVALID_CURSOR"


@pytest.mark.django_db(transaction=True)
async def test_creating_an_event_needs_the_create_grant_and_the_events_scope(start, google):
    event = {
        "calendar_id": UNIVERSITY,
        "summary": "Study group",
        "start": "2026-10-02T14:00:00+02:00",
        "end": "2026-10-02T15:00:00+02:00",
        "time_zone": "Europe/Berlin",
    }
    executor = await start(BASE_SCOPES, {UNIVERSITY: ("read", "create")})
    # The user allowed it, but Google has not given Minerva write access yet: the tool is not offered.
    assert "google_calendar_create_event" not in executor.context.tools
    with pytest.raises(OperationError) as consent:
        await executor.invoke("google_calendar_create_event", event)
    assert consent.value.code == "UNKNOWN_OPERATION"

    # Creating is allowed on another calendar only.
    executor = await start([*BASE_SCOPES, EVENTS_SCOPE], {**READS, PRIMARY: ("read", "create")})
    with pytest.raises(OperationError) as denied:
        await executor.invoke("google_calendar_create_event", event)
    assert denied.value.code == "POLICY_DENIED"
    assert google.created == []

    executor = await start([*BASE_SCOPES, EVENTS_SCOPE], {UNIVERSITY: ("read", "create")})
    outcome = await executor.invoke("google_calendar_create_event", event)
    assert outcome.result["items"][0]["id"] == "new1"
    [(request, body)] = google.created
    assert request.url.params["sendUpdates"] == "none"
    assert body == {
        "summary": "Study group",
        "start": {"dateTime": event["start"], "timeZone": "Europe/Berlin"},
        "end": {"dateTime": event["end"], "timeZone": "Europe/Berlin"},
    }
    # Guests cannot be invited: attendees are not an input.
    with pytest.raises(OperationError) as extra:
        await executor.invoke("google_calendar_create_event", {**event, "attendees": ["eve@example.com"]})
    assert extra.value.code == "INVALID_ARGUMENTS"

    # Full calendar access also covers it.
    executor = await start(["openid", "email", FULL_SCOPE], {"*": ("read", "create")})
    all_day = {"calendar_id": "primary", "summary": "Trip", "start": "2026-10-05", "end": "2026-10-07"}
    await executor.invoke("google_calendar_create_event", all_day)
    assert google.created[-1][1]["start"] == {"date": "2026-10-05"}
    assert unquote(google.created[-1][0].url.raw_path.decode()).startswith(
        f"/calendar/v3/calendars/{PRIMARY}/"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"start": "2026-10-02", "end": "2026-10-02T15:00:00+02:00"},
        {"start": "2026-10-02T15:00:00", "end": "2026-10-02T16:00:00"},
        {"start": "2026-10-02T15:00:00+02:00", "end": "2026-10-02T15:00:00+02:00"},
        {"start": "2026-10-03", "end": "2026-10-02"},
        {"start": 1790000000, "end": 1790003600},
        {"start": "2026-02-30", "end": "2026-03-02"},
        {"time_zone": "Mars/Olympus"},
        {"calendar_id": "a/b"},
        {"calendar_id": ".."},
        {"summary": ""},
    ],
)
def test_event_input_is_validated(change):
    event = {
        "calendar_id": UNIVERSITY,
        "summary": "Study group",
        "start": "2026-10-02T14:00:00+02:00",
        "end": "2026-10-02T15:00:00+02:00",
        **change,
    }
    op = next(o for o in GoogleCalendarConnector().operations if o.name == "create_event")
    with pytest.raises(ValueError):
        op.input_model.model_validate(event)


def test_event_listing_bounds_are_validated():
    op = next(o for o in GoogleCalendarConnector().operations if o.name == "list_events")
    with pytest.raises(ValueError):
        op.input_model.model_validate(
            {"calendar_id": PRIMARY, "time_min": "2026-10-02T00:00:00Z", "time_max": "2026-10-01T00:00:00Z"}
        )
    with pytest.raises(ValueError):
        op.input_model.model_validate({"calendar_id": PRIMARY, "time_min": "2026-10-02"})


@pytest.mark.django_db(transaction=True)
async def test_a_disabled_calendar_api_is_explained_and_the_connection_kept(start, google):
    executor = await start(BASE_SCOPES, READS)
    google.error = (
        403,
        {
            "error": {
                "code": 403,
                "message": "Google Calendar API has not been used in project 1 before or it is disabled.",
                "errors": [{"reason": "accessNotConfigured", "domain": "usageLimits"}],
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "SERVICE_DISABLED"}
                ],
            }
        },
    )
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_calendar_list_events", {"calendar_id": UNIVERSITY})
    assert caught.value.code == "PROVIDER_NOT_CONFIGURED"
    assert "not enabled" in caught.value.message
    connection = await Connection.unscoped.aget(provider="google_calendar")
    assert connection.status == Connection.Status.ACTIVE


@pytest.fixture
def oauth(monkeypatch, google):
    """Google's OAuth endpoints: every code exchange returns `tokens`, and the account is `google.sub`."""
    creds = ClientCredentials("client", "secret", "https://minerva.test/api/oauth/google_calendar/callback")
    tokens = {
        "kind": "oauth2",
        "access_token": "new",
        "refresh_token": None,
        "scopes": BASE_SCOPES,
        "client_id": "client",
    }
    monkeypatch.setattr(connection_services, "client_credentials", lambda connector: creds)
    monkeypatch.setattr(connection_services, "exchange_code", lambda connector, code, flow: dict(tokens))
    monkeypatch.setattr(GoogleCalendarConnector, "client", lambda self, token: google.client())
    return tokens


@pytest.fixture
def calendar(scoped, user) -> Connection:
    connection = Connection(provider="google_calendar", owner=user, label=PRIMARY, external_account_id="108")
    connection.set_credentials(
        {
            "kind": "oauth2",
            "access_token": "old",
            "refresh_token": "r",
            "scopes": BASE_SCOPES,
            "client_id": "client",
        }
    )
    connection.save()
    return connection


def _post(client, url: str, body: dict | None = None):
    return client.post(url, data=json.dumps(body or {}), content_type="application/json")


def _connections(api, workspace) -> dict:
    return {c["id"]: c for c in api.get(f"/api/workspaces/{workspace.id}/connections").json()}


def test_allowed_actions_the_provider_has_not_granted_are_reported(api, workspace, user, calendar):
    assert _connections(api, workspace)[str(calendar.id)]["consent_needed"] == []
    changes = [GrantChange("calendar", UNIVERSITY, ("read", "create"))]
    apply_grant_changes(user_id=user.id, connection=calendar, changes=changes, names={})
    assert _connections(api, workspace)[str(calendar.id)]["consent_needed"] == ["create"]
    calendar.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": ["openid", FULL_SCOPE]})
    calendar.save()
    assert _connections(api, workspace)[str(calendar.id)]["consent_needed"] == []
    # Unknown scopes (the provider did not say what it granted) need nothing: Google will refuse instead.
    calendar.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": None})
    calendar.save()
    assert _connections(api, workspace)[str(calendar.id)]["consent_needed"] == []


def test_reconnecting_asks_only_for_what_allowed_actions_lack(api, workspace, user, calendar, oauth):
    url = f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect"
    params = parse_qs(urlparse(_post(api, url).json()["url"]).query)
    assert params["scope"] == [" ".join(BASE_SCOPES)]
    assert params["include_granted_scopes"] == ["true"]
    assert params["login_hint"] == ["108"]

    params = parse_qs(urlparse(_post(api, url, {"actions": ["create"]}).json()["url"]).query)
    assert params["scope"][0].split() == [*BASE_SCOPES, EVENTS_SCOPE]
    assert _post(api, url, {"actions": ["delete"]}).status_code == 422

    changes = [GrantChange("calendar", "*", ("read", "create"))]
    apply_grant_changes(user_id=user.id, connection=calendar, changes=changes, names={})
    params = parse_qs(urlparse(_post(api, url).json()["url"]).query)
    assert params["scope"][0].split() == [*BASE_SCOPES, EVENTS_SCOPE]


def test_reconnecting_asks_again_for_everything_allowed(api, workspace, user, calendar, oauth):
    # Google forgets the grant when the user revokes access, even if the stored credentials still list it.
    calendar.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": [*BASE_SCOPES, EVENTS_SCOPE]})
    calendar.save()
    changes = [GrantChange("calendar", UNIVERSITY, ("read", "create"))]
    apply_grant_changes(user_id=user.id, connection=calendar, changes=changes, names={})
    url = f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect"
    params = parse_qs(urlparse(_post(api, url).json()["url"]).query)
    assert params["scope"][0].split() == [*BASE_SCOPES, EVENTS_SCOPE]


def _callback(client, reconnect: str):
    state = parse_qs(urlparse(_post(client, reconnect).json()["url"]).query)["state"][0]
    response = client.get("/api/oauth/google_calendar/callback", {"state": state, "code": "c"})
    return parse_qs(urlparse(response["Location"]).query)


def test_reconnecting_updates_the_same_connection_with_the_new_grant(api, workspace, calendar, oauth):
    oauth["scopes"] = [*BASE_SCOPES, EVENTS_SCOPE]
    result = _callback(api, f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect")
    assert result["connected"] == [str(calendar.id)]
    calendar.refresh_from_db()
    assert calendar.credentials()["scopes"] == [*BASE_SCOPES, EVENTS_SCOPE]
    # Google sent no new refresh token, so the old one is kept.
    assert calendar.credentials()["refresh_token"] == "r"
    assert Connection.objects.count() == 1


def test_reconnecting_as_another_account_changes_nothing(api, workspace, calendar, oauth, google):
    google.sub = "999"
    result = _callback(api, f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect")
    assert "different Google Calendar account" in result["error"][0]
    calendar.refresh_from_db()
    assert calendar.credentials()["access_token"] == "old"
    assert Connection.objects.count() == 1


def test_a_connection_removed_during_the_flow_is_not_recreated(api, workspace, calendar, oauth):
    reconnect = f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect"
    state = parse_qs(urlparse(_post(api, reconnect).json()["url"]).query)["state"][0]
    calendar.delete()
    response = api.get("/api/oauth/google_calendar/callback", {"state": state, "code": "c"})
    assert "was removed" in parse_qs(urlparse(response["Location"]).query)["error"][0]
    assert not Connection.objects.exists()


def test_only_the_owner_reconnects_a_personal_connection_and_admins_a_shared_one(
    workspace, calendar, other_user, oauth
):
    Membership.objects.create(workspace=workspace, user=other_user, role=Membership.Role.MEMBER)
    client = Client(enforce_csrf_checks=False)
    client.force_login(other_user)
    url = f"/api/workspaces/{workspace.id}/connections/{calendar.id}/reconnect"
    assert _post(client, url).status_code == 404
    calendar.owner = None
    calendar.save()
    assert _post(client, url).status_code == 403
    Membership.objects.filter(user=other_user).update(role=Membership.Role.ADMIN)
    result = _callback(client, url)
    assert result["connected"] == [str(calendar.id)]
    calendar.refresh_from_db()
    assert calendar.owner_id is None
