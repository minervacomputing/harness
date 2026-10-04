"""Stripe, through its REST API with a restricted key. Agents read customers and what is billed to them,
refund payments and credit customer balances, each within amount caps users choose.

Users connect with a restricted key (`rk_live_` or `rk_test_`) they create in Stripe with only the
permissions Minerva's operations use (docs/connectors.md), so Stripe limits the key as well as Minerva.
Secret keys are refused, since they can do anything in the account. The connection is the Stripe account in
the key's mode: a test key and a live key of one account are two connections, and a key never replaces one
of the other mode. Minerva reads the account (`GET /v1/account`) to name it, and to suggest its default
currency.

Customers are one hierarchical kind; a customer's payments, invoices and subscriptions sit inside it (see
`scope`). Listings are filtered per object after Stripe has listed them, so a page can come back with
fewer objects than asked for.

Amounts are a second hierarchical kind, `amount`, whose resources users choose as tiers of a fixed ladder
per currency (see `money`): allowing "Up to 50.00 USD" lets each refund or credit be at most that, and a
workspace ceiling that denies "More than 500.00 USD" refuses larger ones whatever members allow. A refund
or credit needs its action on both the customer and the amount. Caps are per call: Minerva keeps no budget
across calls, so a run can move at most its write limit times the cap, and separate runs add up.
"""

import asyncio
import re

from connectors.base import (
    Account,
    ActionSpec,
    ApiKey,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    OperationError,
    ResourceKind,
)
from connectors.stripe import money
from connectors.stripe.client import CUSTOMER_ID, KEY, SEARCH_PAGE, Customer, StripeClient, next_cursor
from connectors.stripe.reads import (
    GET_CUSTOMER,
    LIST_CUSTOMERS,
    LIST_INVOICES,
    LIST_PAYMENTS,
    LIST_SUBSCRIPTIONS,
)
from connectors.stripe.scope import AMOUNT, CUSTOMER, cursor
from connectors.stripe.writes import CREDIT_CUSTOMER, REFUND_PAYMENT

DESCRIBE_CONCURRENCY = 5
MAX_DESCRIBE = 100
DISCOVER_PAGE = 50
# Customer Search takes a quoted value; quotes and backslashes are dropped from what users type.
_UNQUOTED = re.compile(r'["\\]')


def _customer_name(found: Customer) -> str:
    if found.name and found.email:
        return f"{found.name} <{found.email}>"
    return found.name or found.email or found.id


class StripeConnector(Connector):
    slug = "stripe"
    name = "Stripe"
    kinds = (
        ResourceKind(
            CUSTOMER,
            "Customer",
            ("read", "refund", "credit"),
            wildcard=True,
            hierarchical=True,
            note=(
                "Access to a customer covers their payments, invoices and subscriptions. Payments without "
                "a customer are covered only by allowing every customer."
            ),
        ),
        ResourceKind(
            AMOUNT,
            "Amount",
            ("refund", "credit"),
            wildcard=True,
            hierarchical=True,
            note=(
                'Each refund or credit also needs its amount allowed: allow "Up to" a limit, or a whole '
                "currency. Limits apply to each refund or credit on its own; a run makes only a few writes, "
                "but separate runs add up. Search for a currency code, such as eur, to see its limits."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read"),
        ActionSpec("refund", "Refund payments"),
        ActionSpec("credit", "Credit balances"),
    )
    auth = ApiKey(
        "Restricted API key",
        hint=(
            "Create a restricted key in Stripe (Developers, API keys) with the permissions in Minerva's "
            "setup guide. Keys start with rk_live_ or rk_test_."
        ),
    )
    operations = (
        LIST_CUSTOMERS,
        GET_CUSTOMER,
        LIST_PAYMENTS,
        LIST_INVOICES,
        LIST_SUBSCRIPTIONS,
        REFUND_PAYMENT,
        CREDIT_CUSTOMER,
    )

    def client(self, secret: str) -> StripeClient:
        return StripeClient(secret)

    def manage_link(self) -> tuple[str, str] | None:
        return ("Manage keys in Stripe", "https://dashboard.stripe.com/apikeys")

    async def account(self, client: StripeClient) -> Account:
        if not KEY.match(client.key):
            raise OperationError(
                "INVALID_KEY",
                "Use a restricted key from Stripe, which starts with rk_live_ or rk_test_. Secret keys are "
                "not accepted.",
            )
        try:
            found = await client.account()
        except OperationError as error:
            if error.code == "PROVIDER_FORBIDDEN":
                raise OperationError(
                    "PROVIDER_FORBIDDEN",
                    "The key cannot read the Stripe account. Give it the permissions in Minerva's setup guide.",
                ) from None
            if error.code == "CONNECTION_UNAUTHORIZED":
                raise OperationError("INVALID_KEY", "Stripe did not accept this key.") from None
            raise
        dashboard = found.settings.dashboard if found.settings else None
        label = (
            (found.business_profile.name if found.business_profile else None)
            or (dashboard.display_name if dashboard else None)
            or found.email
            or found.id
        )
        mode = "test" if client.test_mode else "live"
        return Account(id=f"{found.id}:{mode}", label=f"{label} (test mode)" if client.test_mode else label)

    async def discover(
        self, client: StripeClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if kind == AMOUNT:
            return await self._amounts(client, query)
        if query and CUSTOMER_ID.match(query.strip()):
            described = await self.describe(client, CUSTOMER, [query.strip()])
            return DiscoveryPage([DiscoveryItem(i, name) for i, name in described.items()])
        if query:
            return await self._search(client, query, cursor)
        page = await client.customers(limit=DISCOVER_PAGE, cursor=_list_cursor(cursor))
        items = [DiscoveryItem(c.id, _customer_name(c)) for c in page.data if CUSTOMER_ID.match(c.id)]
        after = next_cursor(page)
        return DiscoveryPage(items, f"l:{after}" if after else None)

    async def _search(self, client: StripeClient, query: str, page_token: str | None) -> DiscoveryPage:
        value = _UNQUOTED.sub("", query).strip()[:100]
        if len(value) < 3:
            return DiscoveryPage([])
        if page_token is not None and not (page_token.startswith("s:") and SEARCH_PAGE.match(page_token[2:])):
            raise OperationError("INVALID_CURSOR", "This cursor is not valid.")
        page = await client.search_customers(
            f'email~"{value}" OR name~"{value}"',
            limit=DISCOVER_PAGE,
            page=page_token[2:] if page_token else None,
        )
        items = [
            DiscoveryItem(c.id, _customer_name(c))
            for c in page.data
            if CUSTOMER_ID.match(c.id) and not c.deleted
        ]
        following = page.next_page if page.has_more and page.next_page else None
        if following is not None and not SEARCH_PAGE.match(following):
            raise client.unexpected()
        return DiscoveryPage(items, f"s:{following}" if following else None)

    async def _amounts(self, client: StripeClient, query: str | None) -> DiscoveryPage:
        if query:
            try:
                currency = money.currency(query.strip())
            except ValueError:
                return DiscoveryPage([])
        else:
            currency = ((await client.account()).default_currency or "usd").lower()
            if not money.CURRENCY.match(currency):
                currency = "usd"
        return DiscoveryPage([DiscoveryItem(i, money.name(i) or i) for i in money.choices(currency)])

    async def describe(self, client: StripeClient, kind: str, ids: list[str]) -> dict[str, str]:
        if kind == AMOUNT:
            return {i: name for i in ids if (name := money.name(i)) is not None}
        wanted = [i for i in dict.fromkeys(ids) if CUSTOMER_ID.match(i)][:MAX_DESCRIBE]
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)

        async def fetch(customer_id: str) -> Customer | None:
            async with limit:
                try:
                    return await client.customer(customer_id)
                except OperationError as error:
                    if error.code != "NOT_FOUND":
                        raise
                    return None

        found = await asyncio.gather(*(fetch(i) for i in wanted))
        return {c.id: _customer_name(c) for c in found if c is not None and not c.deleted}


def _list_cursor(value: str | None) -> str | None:
    if value is None:
        return None
    if not value.startswith("l:"):
        raise OperationError("INVALID_CURSOR", "This cursor is not valid.")
    return cursor(value[2:])
