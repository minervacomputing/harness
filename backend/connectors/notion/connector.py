"""Notion. Resources are pages and databases; what is allowed on one covers everything inside it.

Minerva connects as a public integration (`owner=user`). Notion itself decides which pages the integration
can reach: the user picks them when connecting. Notion has no scopes, so the connector declares no
consent. Notion's token endpoint takes HTTP Basic client authentication with a JSON body and no PKCE
(`client_auth="basic"`, `json_body=True`, `pkce=False`). The workspace id is the account id.

Pages and databases are one hierarchical kind, keyed by Notion's id; tools also accept links, which are
reduced to the id before authorization. Each call resolves where the pages it touches sit (their chain of
parent pages and databases, through any blocks in between such as columns, and from a database row
through its data source to its database, up to the workspace) and hands that to the policy. Ancestry that
cannot be resolved completely (a parent Notion does not show, a limit reached) is marked partial, and the
policy then treats it conservatively. Ancestry is resolved again just before content is read or written:
a call whose page moved in between is refused (`PAGE_MOVED`). Rows of a linked database belong to the
database they come from, which grants on this one do not cover, so they are refused.

Page text hides what belongs to other pages (see `markdown`), and database rows show only their own values
(see `properties`). Database filters and sorts may use only the properties agents are shown, since
filtering on a hidden value reveals it, and a row is dropped when a text property they use mentions another
page, since Notion matches the mention's title. What stays outside Minerva's reach: Notion automations,
which may act on a row or page an agent changed, and the integration's own capabilities, which the
operator sets in Notion.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (ids,
where pages and databases sit, how they are shown) is in `pages`.
"""

import asyncio
import re

from pydantic import ValidationError

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
from connectors.notion.client import DataSource, NotionClient, Page
from connectors.notion.pages import PAGE, canonical
from connectors.notion.reads import GET_DATABASE, GET_PAGE, LIST_COMMENTS, QUERY_DATABASE, READ_PAGE, SEARCH
from connectors.notion.writes import (
    ADD_COMMENT,
    APPEND_TO_PAGE,
    CREATE_DATABASE_ROW,
    CREATE_PAGE,
    EDIT_PAGE,
    UPDATE_PAGE_PROPERTIES,
)

DESCRIBE_CONCURRENCY = 8
_CURSOR = re.compile(r"^[A-Za-z0-9_=-]{1,300}$")


def _discovery_cursor(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return cursor


class NotionConnector(Connector):
    slug = "notion"
    name = "Notion"
    kinds = (
        ResourceKind(
            PAGE,
            "Page or database",
            ("read", "comment", "create", "edit"),
            wildcard=True,
            hierarchical=True,
            note=(
                "What is allowed on a page or database also covers the pages inside it. Notion decides "
                "which pages Minerva can reach at all: they are chosen when connecting Notion, and "
                "connecting again changes them. Where Notion does not show where a page sits, blocking an "
                "action anywhere in this connection also blocks it there."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read pages"),
        ActionSpec("comment", "Comment on pages", requires="read"),
        ActionSpec("create", "Create pages", requires="read"),
        ActionSpec("edit", "Edit pages", requires="read"),
    )
    auth = OAuth2(
        app="notion",
        authorize_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",  # noqa: S106
        scopes=(),
        authorize_params=(("owner", "user"),),
        client_auth="basic",
        json_body=True,
        pkce=False,
    )

    operations = (
        SEARCH,
        GET_PAGE,
        READ_PAGE,
        GET_DATABASE,
        QUERY_DATABASE,
        LIST_COMMENTS,
        CREATE_PAGE,
        CREATE_DATABASE_ROW,
        UPDATE_PAGE_PROPERTIES,
        EDIT_PAGE,
        APPEND_TO_PAGE,
        ADD_COMMENT,
    )

    def client(self, access_token: str) -> NotionClient:
        return NotionClient(access_token)

    async def account(self, client: NotionClient) -> Account:
        # The workspace is what the connection reaches; the bot id may change when the user reconnects.
        me = await client.me()
        workspace_id = canonical(me.bot.workspace_id) if me.bot else None
        if workspace_id is None:
            raise OperationError("PROVIDER_FAILED", "Notion did not say which workspace was connected.")
        return Account(id=workspace_id, label=(me.bot.workspace_name if me.bot else None) or "Notion")

    async def discover(
        self, client: NotionClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        found = await client.search(query or None, limit=100, cursor=_discovery_cursor(cursor))
        items: list[DiscoveryItem] = []
        seen: set[str] = set()
        for item in found.results:
            try:
                if item.get("object") == "page":
                    page = Page.model_validate(item)
                    object_id, name = canonical(page.id), page.title or "Untitled"
                elif item.get("object") == "data_source":
                    source = DataSource.model_validate(item)
                    object_id, name = canonical(source.database_id), f"{source.name or 'Untitled'} (database)"
                else:
                    continue
            except ValidationError:
                continue
            if object_id is not None and object_id not in seen:
                seen.add(object_id)
                items.append(DiscoveryItem(object_id, name))
        next_cursor = found.next_cursor if found.has_more else None
        return DiscoveryPage(items, _discovery_cursor(next_cursor))

    async def describe(self, client: NotionClient, kind: str, ids: list[str]) -> dict[str, str]:
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)
        hidden = {"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"}

        async def name(object_id: str) -> str | None:
            if canonical(object_id) != object_id:
                return None
            async with limit:
                try:
                    return (await client.page(object_id)).title or "Untitled"
                except OperationError as error:
                    if error.code not in hidden:
                        raise
                try:
                    return f"{(await client.database(object_id)).name or 'Untitled'} (database)"
                except OperationError as error:
                    if error.code not in hidden:
                        raise
            return None

        names = await asyncio.gather(*(name(object_id) for object_id in ids))
        return {object_id: n for object_id, n in zip(ids, names, strict=True) if n is not None}
