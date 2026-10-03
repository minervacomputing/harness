"""Sentry, read-only. Resources are projects; agents list projects, search issues and read issues and their
events.

A connection is one user in one Sentry organisation: Sentry's consent screen asks which organisation, and
the token reaches only that one (see `client`). The account is the organisation and the user together, so
one user can connect several organisations. The kind is flat: a project is keyed by its numeric id. Only
sentry.io is supported, not self-hosted Sentry.

Reading needs `org:read project:read event:read`. Sentry shows a member the projects of their teams, or all
of them when the organisation allows open membership; what Sentry refuses is refused like what is not
granted.

This module assembles the connector. The operations are in `reads`.
"""

import asyncio

from connectors.base import (
    Account,
    ActionSpec,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    OAuth2,
    OperationError,
    ResourceKind,
)
from connectors.sentry.client import ID, Project, SentryClient
from connectors.sentry.reads import (
    GET_ISSUE,
    GET_ISSUE_EVENT,
    LIST_PROJECTS,
    PROJECT,
    SEARCH_ISSUES,
    short,
    unseen,
)

MAX_DESCRIBE = 100
CONCURRENCY = 8


def _name(project: Project) -> str:
    name = short(project.name)
    return f"{name} ({project.slug})" if name and name != project.slug else project.slug


class SentryConnector(Connector):
    slug = "sentry"
    name = "Sentry"
    kinds = (
        ResourceKind(
            PROJECT,
            "Project",
            ("read",),
            wildcard=True,
            note="Agents read issues and events: stack traces, the source lines around them, and tags.",
        ),
    )
    actions = (ActionSpec("read", "Read issues and events"),)
    auth = OAuth2(
        app="sentry",
        authorize_url="https://sentry.io/oauth/authorize/",
        token_url="https://sentry.io/oauth/token/",  # noqa: S106
        scopes=("org:read", "project:read", "event:read"),
    )

    operations = (LIST_PROJECTS, SEARCH_ISSUES, GET_ISSUE, GET_ISSUE_EVENT)

    def client(self, access_token: str) -> SentryClient:
        return SentryClient(access_token)

    async def account(self, client: SentryClient) -> Account:
        user = await client.user()
        organisations = await client.organisations()
        if len(organisations) != 1:
            raise OperationError(
                "UNSUPPORTED_ACCOUNT", "Sentry did not name the one organisation this connection reaches."
            )
        organisation = organisations[0]
        person = f"{user.name} ({user.email})" if user.name and user.email else user.name or user.email
        org = short(organisation.name) or organisation.slug
        return Account(id=f"{organisation.id}:{user.id}", label=f"{short(person)} · {org}" if person else org)

    def manage_link(self) -> tuple[str, str] | None:
        return ("Sentry authorized applications", "https://sentry.io/settings/account/api/authorizations/")

    async def discover(
        self, client: SentryClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        projects, after = await client.projects(query=query, after=cursor)
        return DiscoveryPage([DiscoveryItem(p.id, _name(p)) for p in projects], after)

    async def describe(self, client: SentryClient, kind: str, ids: list[str]) -> dict[str, str]:
        limit = asyncio.Semaphore(CONCURRENCY)

        async def name(project_id: str) -> str | None:
            async with limit:
                try:
                    found = await client.project(project_id)
                except OperationError as error:
                    if unseen(error):
                        return None
                    raise
            return _name(found)

        wanted = [i for i in dict.fromkeys(ids) if ID.match(i)][:MAX_DESCRIBE]
        found = await asyncio.gather(*(name(i) for i in wanted))
        return {i: n for i, n in zip(wanted, found, strict=True) if n is not None}
