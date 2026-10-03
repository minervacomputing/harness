"""Linear. Resources are teams; what is allowed on a team also covers its sub-teams.

Teams are one hierarchical kind (Linear has sub-teams), keyed by Linear's team id. Every issue belongs to
one team, and everything about an issue is authorized on that team. Tools name teams by key ("ENG") and
issues by identifier ("ENG-123"); a name is resolved to the team once, before authorization, and a team or
issue the account cannot see is refused like one without a grant. Nothing that depends on what a call
wants to read or write is looked up until the call is authorized. Just before content is read or written,
the issue and its team's chain of parent teams are resolved again: a call whose issue or team moved in
between is refused (`ISSUE_MOVED`, `TEAM_MOVED`).

Text agents read hides the titles of other issues, which Linear writes into links (see `markdown`), and
related issues in other teams are shown only as existing. Search matches titles only: Linear's text search
also matches descriptions, so which issues matched would reveal words of other teams' titles held in their
links. Text agents write may mention only issues in the same team of the connected workspace, checked
after authorization. New issues skip the team's default template, which could add content Minerva did not
check.

Linear itself closes related issues in some cases (a parent whose sub-issues are all done, the open
sub-issues of a closed parent), so a status change that could reach an issue in another team is refused:
any status change when a parent issue at any level is in another team, and closing when an open sub-issue
within three levels is in another team or sub-issues go deeper. What stays outside Minerva's reach: other
Linear automations (triage rules, integrations), which may act on an issue an agent changed, and teams the
connected account cannot see at all.

Linear takes comma-separated scopes (`scope_separator=","`). The base scope is `read`; writes ask for
`issues:create`, `comments:create` or `write`, any of which older tokens may already cover.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (team
and issue names, where teams sit, page tokens) is in `teams`.
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
from connectors.linear.client import LinearClient, Team
from connectors.linear.reads import GET_ISSUE, GET_TEAM, LIST_ISSUES, LIST_TEAMS, SEARCH_ISSUES
from connectors.linear.teams import TEAM, UUID, checked_cursor, next_cursor
from connectors.linear.writes import ADD_COMMENT, CREATE_ISSUE, UPDATE_ISSUE

MAX_DISCOVERY_PAGES = 10
DESCRIBE_BATCH = 100


class LinearConnector(Connector):
    slug = "linear"
    name = "Linear"
    kinds = (
        ResourceKind(
            TEAM,
            "Team",
            ("read", "comment", "create", "edit"),
            wildcard=True,
            hierarchical=True,
            note=(
                "What is allowed on a team also covers its issues and its sub-teams. Minerva reaches the "
                "teams the connected Linear account can see. Where Linear does not show a team's whole chain "
                "of parent teams, blocking an action anywhere in this connection also blocks it there."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read issues"),
        ActionSpec("comment", "Comment on issues", requires="read"),
        ActionSpec("create", "Create issues", requires="read"),
        ActionSpec("edit", "Edit issues", requires="read"),
    )
    auth = OAuth2(
        app="linear",
        authorize_url="https://linear.app/oauth/authorize",
        token_url="https://api.linear.app/oauth/token",  # noqa: S106
        scopes=("read",),
        scope_separator=",",
        client_auth="post",
        pkce=True,
    )

    operations = (
        LIST_TEAMS,
        GET_TEAM,
        LIST_ISSUES,
        SEARCH_ISSUES,
        GET_ISSUE,
        CREATE_ISSUE,
        ADD_COMMENT,
        UPDATE_ISSUE,
    )

    def client(self, access_token: str) -> LinearClient:
        return LinearClient(access_token)

    async def account(self, client: LinearClient) -> Account:
        me = await client.me()
        return Account(id=me.viewer.id, label=f"{me.viewer.name} ({me.organization.name})")

    async def discover(
        self, client: LinearClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            found = await client.teams(first=100, after=checked_cursor(cursor))
            return DiscoveryPage([_item(team) for team in found.nodes], next_cursor(found.page_info))
        folded = query.casefold()
        matches: list[Team] = []
        after = None
        for _ in range(MAX_DISCOVERY_PAGES):
            found = await client.teams(first=100, after=after)
            matches.extend(
                t for t in found.nodes if folded in t.name.casefold() or folded in t.key.casefold()
            )
            after = next_cursor(found.page_info)
            if after is None:
                return DiscoveryPage([_item(team) for team in matches])
        raise OperationError("PROVIDER_LIMIT", "There are more teams than Minerva can search.")

    async def describe(self, client: LinearClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = [team_id for team_id in ids if UUID.match(team_id)]
        batches = [wanted[i : i + DESCRIBE_BATCH] for i in range(0, len(wanted), DESCRIBE_BATCH)]
        found = await asyncio.gather(
            *(client.teams(first=DESCRIBE_BATCH, after=None, ids=batch) for batch in batches)
        )
        names = {team.id.lower(): _item(team).name for page in found for team in page.nodes}
        return {team_id: names[team_id] for team_id in wanted if team_id in names}


def _item(team: Team) -> DiscoveryItem:
    return DiscoveryItem(team.id.lower(), f"{team.name} ({team.key})")
