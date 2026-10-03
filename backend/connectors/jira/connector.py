"""Jira Cloud. Resources are sites and their projects; agents read, search, comment on, create and move
issues.

One connection reaches the Jira sites the user picked on Atlassian's consent screen (see `atlassian`).
Sites and projects are one hierarchical kind: a site's id is its cloud id, a project's is
`<cloud id>/<project id>` with its site as ancestor (project ids repeat across sites). What is allowed on
a site covers every project in it, projects created later included. Calls take an optional `site_id`; a
connection that reaches several sites must name one.

Issues are named by key or id. Jira also answers to an issue's former keys, so `prepare` resolves the
issue to its id and the project it is in now, and authorizes there; just before reading or writing, the
issue is read again by id and refused if it moved (`ISSUE_MOVED`). Search takes fields, never JQL, which
has functions that select issues by their relations to other issues. It always names one project,
searches summaries only (text search also matches descriptions and comments, whose links can carry other
issues' titles), and reads each result again, since the search index can lag behind moves. Related issues
(parent, sub-tasks, links) are read to find their project: those in the same project are shown, the others
only counted.

Text is Atlassian Document Format: reading and writing it is in `atlassian.adf`. Written text is plain,
without mentions or links to Atlassian, which Jira can show as previews of issues the agent may not read.

What stays outside Minerva's reach: watchers and assignees are notified of changes, and a project's
automation rules may act on issues, in that project or others, after an agent's change.

Reading needs `read:jira-work`; the writes ask for `write:jira-work` once the user allows one.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (sites,
names, where issues sit) is in `issues`.
"""

import asyncio
import re

from connectors.atlassian import CLOUD_ID, Site, oauth
from connectors.base import (
    Account,
    ActionSpec,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    OperationError,
    ResourceKind,
)
from connectors.jira.client import JiraClient, Project
from connectors.jira.issues import ID, PROJECT, project_id, unseen
from connectors.jira.reads import GET_ISSUE, LIST_PROJECTS, SEARCH_ISSUES
from connectors.jira.writes import ADD_COMMENT, CREATE_ISSUE, TRANSITION_ISSUE

DISCOVERY_PAGE = 50
MAX_DESCRIBE = 100
CONCURRENCY = 8

_CURSOR = re.compile(r"^(\d{1,2}):(\d{1,6})$")


def _project_name(site: Site, project: Project, sites: list[Site]) -> str:
    name = f"{project.name or project.key} ({project.key})"
    return f"{name} · {site.name or site.host or site.id}" if len(sites) > 1 else name


def _cursor(cursor: str | None, sites: list[Site]) -> tuple[int, int]:
    if cursor is None:
        return 0, 0
    match = _CURSOR.match(cursor)
    if match is None or int(match.group(1)) >= len(sites):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return int(match.group(1)), int(match.group(2))


class JiraConnector(Connector):
    slug = "jira"
    name = "Jira"
    kinds = (
        ResourceKind(
            PROJECT,
            "Project",
            ("read", "comment", "create", "transition"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Access to a site covers all its projects, including projects added later. Agents act as "
                "you: watchers are notified, and a project's automation rules may act on what they change."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read issues"),
        ActionSpec("comment", "Comment on issues", requires="read"),
        ActionSpec("create", "Create issues", requires="read"),
        ActionSpec("transition", "Change status", requires="read"),
    )
    auth = oauth("jira", "read:jira-work")

    operations = (LIST_PROJECTS, SEARCH_ISSUES, GET_ISSUE, ADD_COMMENT, CREATE_ISSUE, TRANSITION_ISSUE)

    def client(self, access_token: str) -> JiraClient:
        return JiraClient(access_token)

    async def account(self, client: JiraClient) -> Account:
        me = await client.me()
        if not await client.sites():
            raise OperationError("UNSUPPORTED_ACCOUNT", "This Atlassian account gave Minerva no Jira site.")
        label = f"{me.name} ({me.email})" if me.name and me.email else me.name or me.email or "Jira"
        return Account(id=me.account_id, label=label)

    def manage_link(self) -> tuple[str, str] | None:
        return ("Atlassian connected apps", "https://id.atlassian.com/manage-profile/apps")

    async def discover(
        self, client: JiraClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        """Sites first, then one page of one site's projects per call."""
        sites = await client.sites()
        index, start = _cursor(cursor, sites)
        folded = query.casefold() if query else None
        items: list[DiscoveryItem] = []
        if cursor is None:
            items += [
                DiscoveryItem(site.id, site.label)
                for site in sites
                if folded is None or folded in site.label.casefold()
            ]
        if not sites:
            return DiscoveryPage(items)
        site = sites[index]
        projects, after = await client.projects(site.id, start=start, limit=DISCOVERY_PAGE, query=query)
        items += [DiscoveryItem(project_id(site, p.id), _project_name(site, p, sites)) for p in projects]
        if after is not None:
            return DiscoveryPage(items, f"{index}:{after}")
        return DiscoveryPage(items, f"{index + 1}:0" if index + 1 < len(sites) else None)

    async def describe(self, client: JiraClient, kind: str, ids: list[str]) -> dict[str, str]:
        sites = await client.sites()
        by_id = {site.id: site for site in sites}
        names = {i: by_id[i].label for i in ids if CLOUD_ID.match(i) and i in by_id}
        limit = asyncio.Semaphore(CONCURRENCY)

        async def name(resource_id: str) -> str | None:
            cloud_id, _, project = resource_id.partition("/")
            site = by_id.get(cloud_id)
            if site is None or not ID.match(project):
                return None
            async with limit:
                try:
                    found = await client.project(site.id, project)
                except OperationError as error:
                    if unseen(error):
                        return None
                    raise
            return _project_name(site, found, sites) if found.id == project else None

        wanted = [i for i in ids if "/" in i][:MAX_DESCRIBE]
        found = await asyncio.gather(*(name(i) for i in wanted))
        return names | {i: n for i, n in zip(wanted, found, strict=True) if n is not None}
