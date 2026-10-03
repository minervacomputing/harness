"""Intercom. Resources are inboxes; agents read and search conversations, add internal notes and reply to
customers.

A connection is one teammate (admin) in one Intercom workspace, and writes are sent as that teammate. The
kind is flat: an inbox is a team, keyed by its id, plus "none" for conversations no team is assigned to
(unassigned ones and ones assigned only to a teammate). A conversation is in the inbox of the team it is
assigned to, which assignment rules and teammates change all the time, so every call reads the conversation
by id and authorizes on the inbox that read shows; conversations the account cannot see are refused like
ungranted ones. Search names one inbox and reads each result again, since the search index can lag behind
reassignments. Tickets are not included.

Text is HTML: reading and writing it is in `html`. Links to Intercom are hidden with their labels, and parts
that are not messages (assignments, tags, state changes) are left out, since they name other teams. Written
text is plain, without formatting, mentions or links to Intercom.

Intercom's OAuth has no scopes: permissions are set on the app in Intercom's Developer Hub (Read
conversations, Write conversations, Read admins), and a missing one is Intercom's refusal. Tokens do not
expire; removing the app from the workspace revokes them.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (inboxes,
conversation names, where conversations are) is in `inboxes`.
"""

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
from connectors.intercom.client import ID, IntercomClient
from connectors.intercom.inboxes import INBOX, NO_TEAM, NO_TEAM_NAME
from connectors.intercom.reads import GET_CONVERSATION, LIST_INBOXES, SEARCH_CONVERSATIONS, short
from connectors.intercom.writes import ADD_NOTE, REPLY


class IntercomConnector(Connector):
    slug = "intercom"
    name = "Intercom"
    kinds = (
        ResourceKind(
            INBOX,
            "Inbox",
            ("read", "note", "reply"),
            wildcard=True,
            note=(
                'A team\'s inbox holds the conversations assigned to that team; "No team" holds unassigned '
                "conversations and those assigned only to a teammate. Conversations move between inboxes when "
                "they are reassigned, and one reassigned at the moment an agent writes can receive the write. "
                "Tickets are not included."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read conversations"),
        ActionSpec("note", "Add internal notes", requires="read"),
        ActionSpec("reply", "Reply to customers", requires="read"),
    )
    auth = OAuth2(
        app="intercom",
        authorize_url="https://app.intercom.com/oauth",
        token_url="https://api.intercom.io/auth/eagle/token",  # noqa: S106
        scopes=(),
        pkce=False,
    )

    operations = (LIST_INBOXES, SEARCH_CONVERSATIONS, GET_CONVERSATION, ADD_NOTE, REPLY)

    def client(self, access_token: str) -> IntercomClient:
        return IntercomClient(access_token)

    async def account(self, client: IntercomClient) -> Account:
        me = await client.me()
        if me.app is None or not me.app.id_code:
            raise client.unexpected()
        person = f"{me.name} ({me.email})" if me.name and me.email else me.name or me.email or "Intercom"
        label = f"{person} · {me.app.name}" if me.app.name else person
        return Account(id=f"{me.app.id_code}:{me.id}", label=label)

    async def _inboxes(self, client: IntercomClient) -> list[DiscoveryItem]:
        teams = [
            DiscoveryItem(team.id, short(team.name) or f"Team {team.id}") for team in await client.teams()
        ]
        return [*teams, DiscoveryItem(NO_TEAM, NO_TEAM_NAME)]

    async def discover(
        self, client: IntercomClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if cursor is not None:
            raise OperationError("INVALID_CURSOR", "This page token is invalid.")
        folded = query.casefold() if query else None
        items = await self._inboxes(client)
        return DiscoveryPage([i for i in items if folded is None or folded in i.name.casefold()])

    async def describe(self, client: IntercomClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = {i for i in ids if i == NO_TEAM or ID.match(i)}
        if not wanted:
            return {}
        return {item.id: item.name for item in await self._inboxes(client) if item.id in wanted}
