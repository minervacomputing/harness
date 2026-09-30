"""Google Calendar. Resources are calendars; what is allowed on a calendar covers its events."""

from connectors.base import (
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    OAuth2,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ResourceKind,
    ScopedRecord,
)
from connectors.google_calendar.client import GoogleCalendar, GoogleCalendarClient

CALENDAR = "calendar"
READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
FULL_SCOPE = "https://www.googleapis.com/auth/calendar"
MAX_CALENDAR_PAGES = 10


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


class GoogleCalendarConnector(Connector):
    slug = "google_calendar"
    name = "Google Calendar"
    kinds = (ResourceKind(CALENDAR, "Calendar", ("read",), wildcard=True),)
    actions = (ActionSpec("read", "Read events"),)
    auth = OAuth2(
        app="google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",  # noqa: S106
        scopes=("openid", "email", READ_SCOPE),
        # Google only issues a refresh token for offline access, and only on the consent screen.
        authorize_params=(("access_type", "offline"), ("prompt", "consent")),
    )

    _operations = (
        Operation(
            name="list_calendars",
            title="List calendars",
            description="List the Google calendars you may read.",
            input_model=ListCalendars,
            needs=((CALENDAR, "read"),),
            prepare=_prepare_list_calendars,
            consent=(frozenset({READ_SCOPE}), frozenset({FULL_SCOPE})),
        ),
    )

    @property
    def operations(self) -> tuple[Operation, ...]:
        return self._operations

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
        return DiscoveryPage([DiscoveryItem(c.id, c.name) for c in calendars])

    async def describe(self, client: GoogleCalendarClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        return {c.id: c.name for c in await _all_calendars(client) if c.id in wanted}
