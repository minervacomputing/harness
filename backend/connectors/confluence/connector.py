"""Confluence Cloud. Resources are sites and their spaces; agents read and search pages, comment on them and
create them.

One connection reaches the Confluence sites the user picked on Atlassian's consent screen (see
`atlassian`). Sites and spaces are one hierarchical kind: a site's id is its cloud id, a space's is
`<cloud id>/<space id>` with its site as ancestor (space ids repeat across sites). What is allowed on a site
covers every space in it, spaces created later included. Calls take an optional `site_id`; a connection
that reaches several sites must name one.

Spaces are named by key or id and resolved to the id; pages are named by id, resolved to the space they
are in now, and only current pages are used (drafts, archived and trashed pages are refused like unseen
ones). Just before reading or writing, the page is read again by id and refused if it moved
(`PAGE_MOVED`). Search takes fields, never CQL, which can select pages by their relations to content
elsewhere. It always names one space, searches titles only (text search also matches bodies, whose links
can carry other pages' titles), and reads each result again, since the search index can lag behind moves.
A page's parent is shown only when it is a page in the same space; child pages are not listed.

Text is Atlassian Document Format: reading and writing it is in `atlassian.adf`. Written text is plain,
without mentions or links to Atlassian, which Confluence can show as previews of pages the agent may not
read. Comments are root footer comments: replies and inline comments are neither read nor written. Pages
are not edited: plain text would replace their formatting.

What stays outside Minerva's reach: watchers are notified of changes, and a space's automation rules may
act on pages after an agent's change.

Reading needs `read:space:confluence`, `read:page:confluence`, `read:comment:confluence` and
`read:content-details:confluence` (search); the writes ask for `write:comment:confluence` or
`write:page:confluence` once the user allows one.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (sites,
names, where pages sit) is in `pages`.
"""

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
from connectors.confluence.client import BATCH_LIMIT, ConfluenceClient, Space
from connectors.confluence.pages import ID, SPACE, space_id
from connectors.confluence.reads import GET_PAGE, LIST_SPACES, SEARCH_PAGES
from connectors.confluence.writes import ADD_COMMENT, CREATE_PAGE

DISCOVERY_PAGE = 50
MAX_DESCRIBE = BATCH_LIMIT

_CURSOR = re.compile(r"\A(\d{1,2}):([\x21-\x7e]{0,990})\Z")


def _space_name(site: Site, space: Space, sites: list[Site]) -> str:
    name = f"{space.name or space.key} ({space.key})"
    if space.status == "archived":
        name += " · archived"
    return f"{name} · {site.name or site.host or site.id}" if len(sites) > 1 else name


def _cursor(cursor: str | None, sites: list[Site]) -> tuple[int, str | None]:
    if cursor is None:
        return 0, None
    match = _CURSOR.match(cursor)
    if match is None or int(match.group(1)) >= len(sites):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return int(match.group(1)), match.group(2) or None


class ConfluenceConnector(Connector):
    slug = "confluence"
    name = "Confluence"
    kinds = (
        ResourceKind(
            SPACE,
            "Space",
            ("read", "comment", "create"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Access to a site covers all its spaces, including spaces added later. Agents act as you: "
                "watchers are notified, and a space's automation rules may act on what they change."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read pages"),
        ActionSpec("comment", "Comment on pages", requires="read"),
        ActionSpec("create", "Create pages", requires="read"),
    )
    auth = oauth(
        "confluence",
        "read:space:confluence",
        "read:page:confluence",
        "read:comment:confluence",
        "read:content-details:confluence",
    )

    operations = (LIST_SPACES, SEARCH_PAGES, GET_PAGE, ADD_COMMENT, CREATE_PAGE)

    def client(self, access_token: str) -> ConfluenceClient:
        return ConfluenceClient(access_token)

    async def account(self, client: ConfluenceClient) -> Account:
        me = await client.me()
        if not await client.sites():
            raise OperationError(
                "UNSUPPORTED_ACCOUNT", "This Atlassian account gave Minerva no Confluence site."
            )
        label = f"{me.name} ({me.email})" if me.name and me.email else me.name or me.email or "Confluence"
        return Account(id=me.account_id, label=label)

    def manage_link(self) -> tuple[str, str] | None:
        return ("Atlassian connected apps", "https://id.atlassian.com/manage-profile/apps")

    async def discover(
        self, client: ConfluenceClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        """Sites first, then one page of one site's spaces per call. Confluence cannot filter spaces by name,
        so a query filters each page as it comes."""
        sites = await client.sites()
        index, token = _cursor(cursor, sites)
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
        spaces, after = await client.spaces(site.id, limit=DISCOVERY_PAGE, cursor=token)
        items += [
            DiscoveryItem(space_id(site, s.id), _space_name(site, s, sites))
            for s in spaces
            if ID.match(s.id) and (folded is None or folded in f"{s.name or ''} {s.key}".casefold())
        ]
        if after is not None:
            return DiscoveryPage(items, f"{index}:{after}")
        return DiscoveryPage(items, f"{index + 1}:" if index + 1 < len(sites) else None)

    async def describe(self, client: ConfluenceClient, kind: str, ids: list[str]) -> dict[str, str]:
        sites = await client.sites()
        by_id = {site.id: site for site in sites}
        names = {i: by_id[i].label for i in ids if CLOUD_ID.match(i) and i in by_id}
        wanted: dict[str, list[str]] = {}
        for resource_id in [i for i in ids if "/" in i][:MAX_DESCRIBE]:
            cloud_id, _, space = resource_id.partition("/")
            if cloud_id in by_id and ID.match(space):
                wanted.setdefault(cloud_id, []).append(space)
        for cloud_id, spaces in wanted.items():
            site = by_id[cloud_id]
            for found in await client.spaces_by(site.id, "ids", spaces):
                if found.id in spaces:
                    names[space_id(site, found.id)] = _space_name(site, found, sites)
        return names
