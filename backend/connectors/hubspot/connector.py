"""HubSpot's CRM: contacts, companies and deals, through a public app installed with OAuth.

The connection is the HubSpot account (portal) the app was installed in. HubSpot's tokens carry the app's
scopes, not the installing user's HubSpot permissions: an agent reaches every contact, company and deal the
scopes cover, within what users allow in Minerva. Users choose among all contacts, all companies, all deals
and the deals of single pipelines (see `scope`), and actions: read, create, edit and log notes. Companies
are never created or edited, though notes can be logged on them. HubSpot's own automations (workflows, the setting that creates companies from contacts'
email domains) may act on what an agent changes, beyond Minerva's reach.

The APIs are pinned to a date version (`client.VERSION`). Every scope is requested on connecting, since
HubSpot refuses an install whose scopes differ from the app's required ones.

This module assembles the connector. The operations are in `reads` and `writes`; what they share is in
`scope`, and the HTTP client in `client`.
"""

from connectors.base import (
    Account,
    ActionSpec,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    OAuth2,
    ResourceKind,
)
from connectors.hubspot.client import HubSpotClient, Pipeline
from connectors.hubspot.reads import (
    GET_COMPANY,
    GET_CONTACT,
    GET_DEAL,
    LIST_PIPELINES,
    SEARCH_COMPANIES,
    SEARCH_CONTACTS,
    SEARCH_DEALS,
)
from connectors.hubspot.scope import COLLECTIONS, PIPELINE_PREFIX, RECORD
from connectors.hubspot.writes import ADD_NOTE, CREATE_CONTACT, CREATE_DEAL, UPDATE_CONTACT, UPDATE_DEAL

SCOPES = (
    "oauth",
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.companies.read",
    "crm.objects.deals.read",
    "crm.objects.deals.write",
)


def _pipeline_item(found: Pipeline) -> DiscoveryItem:
    return DiscoveryItem(f"{PIPELINE_PREFIX}{found.id}", f"Deals in {found.label}")


class HubSpotConnector(Connector):
    slug = "hubspot"
    name = "HubSpot"
    kinds = (
        ResourceKind(
            RECORD,
            "CRM records",
            ("read", "create", "edit", "note"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Choose all contacts, all companies, all deals, or the deals of one pipeline. Companies are "
                "never created or edited, but notes can be logged on them. Minerva reaches what the HubSpot app's scopes allow, whatever the HubSpot "
                "permissions of the person who connected it."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read"),
        ActionSpec("create", "Create contacts and deals", requires="read"),
        ActionSpec("edit", "Edit contacts and deals", requires="read"),
        ActionSpec("note", "Log notes", requires="read"),
    )
    auth = OAuth2(
        app="hubspot",
        authorize_url="https://app.hubspot.com/oauth/authorize",
        token_url="https://api.hubspot.com/oauth/2026-09/token",  # noqa: S106
        scopes=SCOPES,
        client_auth="post",
        pkce=False,
    )
    operations = (
        SEARCH_CONTACTS,
        GET_CONTACT,
        SEARCH_COMPANIES,
        GET_COMPANY,
        LIST_PIPELINES,
        SEARCH_DEALS,
        GET_DEAL,
        CREATE_CONTACT,
        UPDATE_CONTACT,
        CREATE_DEAL,
        UPDATE_DEAL,
        ADD_NOTE,
    )

    def client(self, access_token: str) -> HubSpotClient:
        return HubSpotClient(access_token)

    async def account(self, client: HubSpotClient) -> Account:
        found = await client.details()
        portal = str(found.portal_id)
        label = f"{found.portal_name} ({portal})" if found.portal_name else f"HubSpot {portal}"
        return Account(id=portal, label=label)

    async def discover(
        self, client: HubSpotClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        items = [DiscoveryItem(i, name) for i, name in COLLECTIONS.items()]
        items += [_pipeline_item(p) for p in await client.pipelines() if not p.archived]
        if query:
            folded = query.casefold()
            items = [item for item in items if folded in item.name.casefold()]
        return DiscoveryPage(items)

    async def describe(self, client: HubSpotClient, kind: str, ids: list[str]) -> dict[str, str]:
        names = dict(COLLECTIONS)
        if any(i.startswith(PIPELINE_PREFIX) for i in ids):
            names |= {item.id: item.name for item in map(_pipeline_item, await client.pipelines())}
        return {i: names[i] for i in ids if i in names}
