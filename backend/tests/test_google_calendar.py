"""Google Calendar connector against an in-memory Calendar API, and one run through the executor."""

import httpx
import pytest
from asgiref.sync import sync_to_async

from agents.models import Agent
from connections.models import Connection
from connectors.base import OperationError
from connectors.executor import Executor, RunContext
from connectors.google_calendar import connector as calendar_module
from connectors.google_calendar.client import GoogleCalendarClient
from connectors.google_calendar.connector import READ_SCOPE, GoogleCalendarConnector
from conversations.models import Conversation
from permissions.services import GrantChange, apply_grant_changes
from runs import services
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
        self.requests: list[httpx.Request] = []
        self.error: tuple[int, dict] | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error:
            return httpx.Response(self.error[0], json=self.error[1])
        if request.url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"sub": "108", "email": PRIMARY, "name": "Ada"})
        if request.url.path == "/calendar/v3/users/me/calendarList":
            start = int(request.url.params.get("pageToken") or 0)
            end = start + self.page_size
            page = {"kind": "calendar#calendarList", "items": self.calendars[start:end]}
            if end < len(self.calendars):
                page["nextPageToken"] = str(end)
            return httpx.Response(200, json=page)
        return httpx.Response(404, json={})

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


@pytest.mark.django_db(transaction=True)
async def test_an_agent_lists_only_the_calendars_it_was_granted(scoped, user, google, monkeypatch):
    monkeypatch.setattr(GoogleCalendarConnector, "client", lambda self, token: google.client())

    def start(scopes: list[str]) -> Executor:
        with workspace_scope(scoped.id):
            connection = Connection.objects.filter(provider="google_calendar").first() or Connection(
                provider="google_calendar", owner=user, label=PRIMARY, external_account_id="108"
            )
            connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": scopes})
            connection.save()
            changes = [GrantChange("calendar", cid, ("read",)) for cid in (PRIMARY, UNIVERSITY)]
            apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})
            agent = Agent.objects.get()
            agent.connections.set([connection])
            conversation = Conversation.objects.create(agent=agent, user=user)
            _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
        services.claim_queued(10)
        run.refresh_from_db()
        return Executor(RunContext.from_run(run))

    executor = await sync_to_async(start)([READ_SCOPE, "openid", "email"])
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
    assert "google_calendar_list_calendars" not in (await sync_to_async(start)(["openid"])).context.tools
