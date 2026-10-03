"""Xero. Resources are organisations; agents read contacts, invoices, bills, accounts and tax rates, and create
draft sales invoices and draft bills.

A connection is one Xero user, and reaches the organisations they picked when connecting (Xero's
`/connections`); to add one, they connect again. The kind is flat and keyed by the organisation's tenant id.
An organisation the connection does not reach is refused like one without a grant, and nothing is read from
an organisation before the executor authorizes the call on it. Calls take an optional `organisation`; a
connection that reaches several must name one. Everything inside an organisation (contacts, invoices, the
chart of accounts) is covered by the grant on it.

Drafts are the only writes: see `writes`. Agents cannot approve, send, pay, void or change invoices.

Xero's scopes are granular. Reading needs `accounting.invoices.read`, `accounting.contacts.read` and
`accounting.settings.read`; drafting asks for `accounting.invoices` once the user allows it. The user's role
in each organisation still applies: Xero refuses what it does not allow. Access tokens last 30 minutes;
refresh tokens rotate.

This module assembles the connector. The operations are in `reads` and `writes`; what they share is in
`organisations`, and Xero's API in `client`.
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
from connectors.xero.client import XeroClient
from connectors.xero.organisations import ORGANISATION, label
from connectors.xero.reads import (
    GET_INVOICE,
    LIST_ACCOUNTS,
    LIST_ORGANISATIONS,
    LIST_TAX_RATES,
    SEARCH_CONTACTS,
    SEARCH_INVOICES,
)
from connectors.xero.writes import CREATE_DRAFT_BILL, CREATE_DRAFT_INVOICE


class XeroConnector(Connector):
    slug = "xero"
    name = "Xero"
    kinds = (
        ResourceKind(
            ORGANISATION,
            "Organisation",
            ("read", "draft_sales", "draft_bills"),
            wildcard=True,
            note=(
                "The organisations you picked when connecting Xero; to add one, connect again and pick it. "
                "Access to all organisations covers ones added later. Drafts are never sent or approved: a "
                "person approves them in Xero."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read invoices, bills and contacts"),
        ActionSpec("draft_sales", "Create draft sales invoices", requires="read"),
        ActionSpec("draft_bills", "Create draft bills", requires="read"),
    )
    auth = OAuth2(
        app="xero",
        authorize_url="https://login.xero.com/identity/connect/authorize",
        token_url="https://identity.xero.com/connect/token",  # noqa: S106
        scopes=(
            "openid",
            "profile",
            "email",
            "offline_access",
            "accounting.invoices.read",
            "accounting.contacts.read",
            "accounting.settings.read",
        ),
        client_auth="basic",
        pkce=True,
    )

    operations = (
        LIST_ORGANISATIONS,
        SEARCH_CONTACTS,
        SEARCH_INVOICES,
        GET_INVOICE,
        LIST_ACCOUNTS,
        LIST_TAX_RATES,
        CREATE_DRAFT_INVOICE,
        CREATE_DRAFT_BILL,
    )

    def client(self, access_token: str) -> XeroClient:
        return XeroClient(access_token)

    async def account(self, client: XeroClient) -> Account:
        me = await client.me()
        if not me.sub:
            raise client.unexpected()
        if not await client.organisations():
            raise OperationError(
                "UNSUPPORTED_ACCOUNT", "This Xero user connected no organisation to Minerva."
            )
        name = me.name or " ".join(n for n in (me.given_name, me.family_name) if n) or None
        person = f"{name} ({me.email})" if name and me.email else name or me.email or "Xero"
        return Account(id=me.sub, label=person)

    async def discover(
        self, client: XeroClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if cursor is not None:
            raise OperationError("INVALID_CURSOR", "This page token is invalid.")
        folded = query.casefold() if query else None
        items = [DiscoveryItem(o.tenantId, label(o)) for o in await client.organisations()]
        return DiscoveryPage([i for i in items if folded is None or folded in i.name.casefold()])

    async def describe(self, client: XeroClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        return {o.tenantId: label(o) for o in await client.organisations() if o.tenantId in wanted}
