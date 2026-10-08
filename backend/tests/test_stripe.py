"""Stripe connector against an in-memory Stripe API, runs through the executor, and the API key endpoints."""

import json
from urllib.parse import parse_qs

import httpx
import pytest
from connector_runs import ceiling, refusal
from pydantic import SecretStr

from connections.models import Connection
from connectors.base import OperationError
from connectors.stripe import money
from connectors.stripe.client import StripeClient, classify
from connectors.stripe.connector import StripeConnector
from minerva.config import config
from workspaces.tenancy import workspace_scope

KEY = "rk_test_" + "a" * 24
LIVE_KEY = "rk_live_" + "b" * 24
OTHER_KEY = "rk_test_" + "c" * 24
SECRET = "SECRET merger"
ADA, GRACE, GONE, EVE = "cus_ada", "cus_grace", "cus_gone", "cus_eve"


def _charge(charge_id: str, customer: str | None, amount: int, **fields) -> dict:
    return {
        "id": charge_id,
        "object": "charge",
        "amount": amount,
        "amount_captured": amount,
        "amount_refunded": 0,
        "captured": True,
        "paid": True,
        "refunded": False,
        "disputed": False,
        "status": "succeeded",
        "currency": "usd",
        "customer": customer,
        "created": 1790000000,
        "description": "Order",
        "receipt_url": "https://pay.stripe.com/receipts/secret",
        "billing_details": {"name": "Ada", "email": "ada@example.com"},
        "payment_method_details": {"type": "card", "card": {"brand": "visa", "last4": "4242"}},
        **fields,
    }


class FakeStripe:
    """The Stripe API for one account, served through httpx.MockTransport.

    Customers: Ada and Grace (USD), Eve (no currency yet) and a deleted one. Charges belong to Ada,
    Grace, or no customer (a guest payment).
    """

    def __init__(self) -> None:
        self.accounts = {KEY: "acct_1", LIVE_KEY: "acct_1", OTHER_KEY: "acct_2"}
        self.customers = {
            ADA: {
                "id": ADA,
                "name": "Ada Lovelace",
                "email": "ada@example.com",
                "currency": "usd",
                "balance": 0,
            },
            GRACE: {"id": GRACE, "name": "Grace Hopper", "email": "grace@example.com", "currency": "usd"},
            EVE: {"id": EVE, "name": None, "email": "eve@example.com", "currency": None},
            GONE: {"id": GONE, "deleted": True},
        }
        self.charges = {
            "ch_ada1": _charge("ch_ada1", ADA, 5000),
            "ch_ada2": _charge("ch_ada2", ADA, 30000),
            "ch_grace": _charge("ch_grace", GRACE, 2000, description=SECRET),
            "ch_guest": _charge("ch_guest", None, 1000),
            "ch_disputed": _charge("ch_disputed", ADA, 1000, disputed=True),
            "ch_eur": _charge("ch_eur", ADA, 1000, currency="eur"),
            "ch_yen": _charge("ch_yen", ADA, 4000, currency="jpy"),
        }
        self.invoices = {
            "in_ada": {
                "id": "in_ada",
                "customer": ADA,
                "status": "open",
                "currency": "usd",
                "total": 1250,
                "amount_due": 1250,
                "hosted_invoice_url": "https://invoice.stripe.com/secret",
            },
            "in_grace": {
                "id": "in_grace",
                "customer": GRACE,
                "status": "paid",
                "currency": "usd",
                "total": 99,
            },
        }
        self.subscriptions = {
            "sub_ada": {
                "id": "sub_ada",
                "customer": ADA,
                "status": "active",
                "currency": "usd",
                "items": {
                    "data": [
                        {
                            "quantity": 1,
                            "current_period_end": 1792000000,
                            "price": {
                                "id": "price_1",
                                "product": "prod_1",
                                "unit_amount": 900,
                                "currency": "usd",
                                "recurring": {"interval": "month", "interval_count": 1},
                            },
                        }
                    ]
                },
            },
        }
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def error(status: int, kind: str, code: str | None = None) -> httpx.Response:
        return httpx.Response(status, json={"error": {"type": kind, "code": code, "message": SECRET}})

    def _page(self, objects: list[dict], params: httpx.QueryParams) -> dict:
        start = 0
        if after := params.get("starting_after"):
            start = [o["id"] for o in objects].index(after) + 1
        size = int(params.get("limit", 10))
        return {
            "object": "list",
            "data": objects[start : start + size],
            "has_more": start + size < len(objects),
        }

    def _search(self, params: httpx.QueryParams) -> dict:
        query = params["query"]
        value = query.split('"')[1]
        found = [
            c
            for c in self.customers.values()
            if not c.get("deleted") and (value in (c.get("email") or "") or value in (c.get("name") or ""))
        ]
        start = int(params.get("page", "0"))
        size = int(params["limit"])
        more = start + size < len(found)
        return {
            "data": found[start : start + size],
            "has_more": more,
            "next_page": str(start + size) if more else None,
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = request.headers["Authorization"].removeprefix("Bearer ")
        if key not in self.accounts:
            return self.error(401, "invalid_request_error")
        path = request.url.path.removeprefix("/v1")
        params = request.url.params
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        if request.method == "POST":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.writes.append((path, form))
            return self._write(path, form)
        customer = params.get("customer")

        def mine(objects):
            return [o for o in objects if customer is None or o["customer"] == customer]

        match path.strip("/").split("/"):
            case ["account"]:
                return httpx.Response(
                    200,
                    json={
                        "id": self.accounts[key],
                        "email": "billing@example.com",
                        "default_currency": "usd",
                        "business_profile": {"name": "Acme"},
                    },
                )
            case ["customers"]:
                listed = [c for c in self.customers.values() if not c.get("deleted")]
                if email := params.get("email"):
                    listed = [c for c in listed if c.get("email") == email]
                return httpx.Response(200, json=self._page(listed, params))
            case ["customers", "search"]:
                return httpx.Response(200, json=self._search(params))
            case ["customers", customer_id]:
                if customer_id not in self.customers:
                    return self.error(404, "invalid_request_error", "resource_missing")
                return httpx.Response(200, json=self.customers[customer_id])
            case ["charges"]:
                return httpx.Response(200, json=self._page(mine(self.charges.values()), params))
            case ["charges", charge_id]:
                if charge_id not in self.charges:
                    return self.error(404, "invalid_request_error", "resource_missing")
                return httpx.Response(200, json=self.charges[charge_id])
            case ["invoices"]:
                listed = [
                    i for i in mine(self.invoices.values()) if params.get("status") in (None, i["status"])
                ]
                return httpx.Response(200, json=self._page(listed, params))
            case ["subscriptions"]:
                return httpx.Response(200, json=self._page(mine(self.subscriptions.values()), params))
        raise AssertionError(path)

    def _write(self, path: str, form: dict) -> httpx.Response:
        if path == "/refunds":
            charge = self.charges[form["charge"]]
            charge["amount_refunded"] += int(form["amount"])
            return httpx.Response(
                200,
                json={
                    "id": "re_1",
                    "amount": int(form["amount"]),
                    "currency": charge["currency"],
                    "status": "succeeded",
                    "charge": charge["id"],
                    "reason": form.get("reason"),
                    "created": 1790000100,
                },
            )
        customer_id = path.split("/")[2]
        customer = self.customers[customer_id]
        customer["currency"] = customer.get("currency") or form["currency"]
        customer["balance"] = customer.get("balance", 0) + int(form["amount"])
        return httpx.Response(
            200,
            json={
                "id": "cbtxn_1",
                "customer": customer_id,
                "amount": int(form["amount"]),
                "currency": form["currency"],
                "ending_balance": customer["balance"],
                "description": form["description"],
                "created": 1790000100,
            },
        )

    def client(self, key: str = KEY) -> StripeClient:
        return StripeClient(key, transport=httpx.MockTransport(self.handler))


@pytest.fixture
def stripe(monkeypatch) -> FakeStripe:
    fake = FakeStripe()
    monkeypatch.setattr(StripeConnector, "client", lambda self, key: fake.client(key))
    return fake


@pytest.fixture
def start(connector_run, stripe):
    def start_(grants: dict[tuple[str, str], tuple[str, ...]]):
        return connector_run(
            "stripe", grants, access_token=KEY, label="Acme (test mode)", external_account_id="acct_1:test"
        )

    return start_


def customer(resource: str, actions=("read",)):
    return {("customer", resource): actions}


def amount(resource: str, actions=("refund",)):
    return {("amount", resource): actions}


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


# Money


def test_amounts_are_exact_in_the_smallest_unit():
    assert money.parse("12.5", "usd") == 1250
    assert money.parse("12.50", "eur") == 1250
    assert money.parse("1500", "jpy") == 1500
    assert money.parse("1.25", "kwd") == 1250
    assert money.parse("5000", "ugx") == 500000
    assert money.parse("5", "isk") == 500
    for value, currency in [
        ("12.555", "usd"),
        ("1.5", "jpy"),
        ("1.255", "kwd"),
        ("5.5", "ugx"),
        ("0", "usd"),
        ("-1", "usd"),
        ("1e3", "usd"),
        ("1,50", "usd"),
        ("1000000", "usd"),
        ("NaN", "usd"),
    ]:
        with pytest.raises(ValueError):
            money.parse(value, currency)
    assert money.display(1250, "usd") == "12.50 USD"
    assert money.display(1500, "jpy") == "1500 JPY"
    assert money.display(1250, "kwd") == "1.250 KWD"
    assert money.display(500000, "ugx") == "5000 UGX"


def test_amounts_sit_inside_every_tier_that_covers_them():
    assert money.ancestors("usd", 5000) == (
        *(f"usd<={t}" for t in (50, 100, 200, 500, 1000, 2000, 5000, 10000)),
        "usd>20",
        "usd>10",
        "usd>5",
        "usd>2",
        "usd>1",
        "usd",
    )
    assert money.ancestors("usd", 5001)[:2] == ("usd<=100", "usd<=200")
    assert "usd>50" in money.ancestors("usd", 5001) and "usd>50" not in money.ancestors("usd", 5000)
    assert money.ancestors("jpy", 4000)[0] == "jpy<=5000"
    assert money.ancestors("ugx", 500000)[0] == "ugx<=5000"
    assert money.name("ugx<=5000") == "Up to 5000 UGX"
    assert money.ancestors("usd", 2_000_000) == (*(f"usd>{t}" for t in reversed(money.LADDER)), "usd")
    assert len(money.ancestors("usd", 1)) <= 64
    assert money.name("usd<=50") == "Up to 50.00 USD"
    assert money.name("jpy>1000") == "More than 1000 JPY"
    assert money.name("eur") == "Any amount in EUR"
    for unnamed in ("usd<=3", "usd=5000", "usd<=050", "USD", "usd<=50 ", "*"):
        assert money.name(unnamed) is None


# Client


def test_stripe_errors_are_named_without_its_wording():
    def named(status, kind, code=None):
        return classify("Stripe", FakeStripe.error(status, kind, code))

    assert named(403, "permission_error").code == "PROVIDER_FORBIDDEN"
    assert "permissions" in named(403, "permission_error").message
    assert named(404, "invalid_request_error", "resource_missing").code == "NOT_FOUND"
    refused = named(400, "invalid_request_error", "charge_already_refunded")
    assert refused.code == "PROVIDER_REJECTED" and "refunded in full" in refused.message
    assert named(400, "invalid_request_error", "parameter_unknown").message.endswith("(parameter_unknown).")
    assert named(400, "invalid_request_error", "Not A Code<script>") is None
    assert named(401, "invalid_request_error") is None
    for error in (named(403, "permission_error"), refused):
        assert SECRET not in error.message


async def test_only_restricted_keys_reach_stripe(stripe):
    connector = StripeConnector()
    for key in ("sk_test_" + "a" * 24, "rk_test_short", "pk_live_" + "a" * 24, "rk_prod_" + "a" * 24):
        with pytest.raises(OperationError) as caught:
            await connector.account(stripe.client(key))
        assert caught.value.code == "INVALID_KEY"
    assert stripe.requests == []
    test = await connector.account(stripe.client(KEY))
    live = await connector.account(stripe.client(LIVE_KEY))
    assert (test.id, test.label) == ("acct_1:test", "Acme (test mode)")
    assert (live.id, live.label) == ("acct_1:live", "Acme")
    assert stripe.requests[0].headers["Stripe-Version"] == "2025-08-27.basil"
    stripe.hook = lambda method, path, params: FakeStripe.error(403, "permission_error")
    with pytest.raises(OperationError) as caught:
        await connector.account(stripe.client(KEY))
    assert caught.value.code == "PROVIDER_FORBIDDEN" and "read the Stripe account" in caught.value.message


# Discovery


async def test_customers_and_amounts_are_discovered_and_described(stripe):
    connector = StripeConnector()
    client = stripe.client()
    page = await connector.discover(client, "customer", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (ADA, "Ada Lovelace <ada@example.com>"),
        (GRACE, "Grace Hopper <grace@example.com>"),
        (EVE, "eve@example.com"),
    ]
    assert page.next_cursor is None
    found = await connector.discover(client, "customer", query='hop"per', cursor=None)
    assert [i.id for i in found.items] == []
    assert stripe.requests[-1].url.params["query"] == 'email~"hopper" OR name~"hopper"'
    found = await connector.discover(client, "customer", query="example.com", cursor=None)
    assert [i.id for i in found.items] == [ADA, GRACE, EVE]
    by_id = await connector.discover(client, "customer", query=GRACE, cursor=None)
    assert [i.id for i in by_id.items] == [GRACE]
    for cursor in ("s:x y", "cus_1", "l:bad id"):
        with pytest.raises(OperationError) as caught:
            await connector.discover(client, "customer", query=None, cursor=cursor)
        assert caught.value.code == "INVALID_CURSOR"
    assert await connector.describe(client, "customer", [ADA, GONE, "cus_missing", "ch_ada1", "*"]) == {
        ADA: "Ada Lovelace <ada@example.com>"
    }

    amounts = await connector.discover(client, "amount", query=None, cursor=None)
    assert amounts.items[0].id == "usd" and amounts.items[1].name == "Up to 1.00 USD"
    assert {i.id for i in (await connector.discover(client, "amount", query="EUR", cursor=None)).items} >= {
        "eur",
        "eur<=50",
        "eur>500",
    }
    assert (await connector.discover(client, "amount", query="euros", cursor=None)).items == []
    assert await connector.describe(client, "amount", ["usd<=50", "usd=5000", "jpy>100", "usd<=7"]) == {
        "usd<=50": "Up to 50.00 USD",
        "jpy>100": "More than 100 JPY",
    }


# Reads


@pytest.mark.django_db(transaction=True)
async def test_listings_show_only_allowed_customers(start, stripe):
    executor = await start(customer(ADA))
    assert _ids(await executor.invoke("stripe_list_customers", {})) == [ADA]
    payments = _items(await executor.invoke("stripe_list_payments", {}))
    assert [p["id"] for p in payments] == ["ch_ada1", "ch_ada2", "ch_disputed", "ch_eur", "ch_yen"]
    assert payments[0]["amount"] == "50.00" and payments[0]["refundable"] == "50.00"
    assert payments[-1]["amount"] == "4000"
    assert payments[0]["card_last4"] == "4242" and "receipt_url" not in payments[0]
    assert SECRET not in json.dumps(payments)
    invoices = _items(await executor.invoke("stripe_list_invoices", {}))
    assert [i["id"] for i in invoices] == ["in_ada"] and invoices[0]["amount_due"] == "12.50"
    assert "hosted_invoice_url" not in invoices[0]
    [subscription] = _items(await executor.invoke("stripe_list_subscriptions", {"customer": ADA}))
    assert subscription["items"][0]["unit_amount"] == "9.00"
    assert await refusal(executor, "stripe_list_payments", {"customer": GRACE}) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_get_customer", {"customer": GRACE}) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_get_customer", {"customer": "ada"}) == "INVALID_ARGUMENTS"
    assert _items(await executor.invoke("stripe_get_customer", {"customer": ADA}))[0]["balance"] == "0.00"


@pytest.mark.django_db(transaction=True)
async def test_guest_payments_need_every_customer(start, stripe):
    executor = await start({**customer(ADA), **customer(GRACE)})
    assert "ch_guest" not in _ids(await executor.invoke("stripe_list_payments", {}))
    executor = await start(customer("*"))
    assert "ch_guest" in _ids(await executor.invoke("stripe_list_payments", {}))
    assert await refusal(executor, "stripe_get_customer", {"customer": GONE}) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_get_customer", {"customer": "cus_missing"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_customer_lists_page_with_run_bound_cursors(start, stripe):
    executor = await start(customer("*"))
    first = await executor.invoke("stripe_list_customers", {"limit": 2})
    assert _ids(first) == [ADA, GRACE]
    cursor = first.result["next_cursor"]
    assert cursor != GRACE
    second = await executor.invoke("stripe_list_customers", {"limit": 2, "cursor": cursor})
    assert _ids(second) == [EVE] and "next_cursor" not in second.result
    listed = [r for r in stripe.requests if r.url.path == "/v1/customers"]
    assert [r.url.params.get("starting_after") for r in listed] == [None, GRACE]


@pytest.mark.django_db(transaction=True)
async def test_a_lookup_by_address_does_not_hint_at_hidden_customers(start, stripe):
    stripe.customers[GRACE]["email"] = "ada@example.com"
    executor = await start(customer(EVE))
    for address in ("ada@example.com", "nobody@example.com"):
        outcome = await executor.invoke("stripe_list_customers", {"email": address, "limit": 1})
        assert outcome.result == {"items": [], "count": 0}


# Refunds


def _refund(payment: str, value: str, currency: str = "usd", **fields) -> dict:
    return {"payment": payment, "amount": value, "currency": currency, **fields}


@pytest.mark.django_db(transaction=True)
async def test_refunds_are_capped_by_amount(start, stripe):
    executor = await start({**customer(ADA, ("read", "refund")), **amount("usd<=50")})
    [refund] = _items(
        await executor.invoke(
            "stripe_refund_payment", _refund("ch_ada2", "50", reason="requested_by_customer")
        )
    )
    assert refund == {
        "id": "re_1",
        "payment": "ch_ada2",
        "amount": "50.00",
        "currency": "usd",
        "status": "succeeded",
        "reason": "requested_by_customer",
        "created": 1790000100,
    }
    assert stripe.writes == [
        (
            "/refunds",
            {
                "charge": "ch_ada2",
                "amount": "5000",
                "reason": "requested_by_customer",
                "metadata[created_by]": "minerva",
            },
        )
    ]
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada2", "50.01")) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada2", "5", "eur")) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_grace", "5")) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_guest", "5")) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_missing", "5")) == "POLICY_DENIED"
    for bad in (
        _refund("ch_ada2", "5.001"),
        _refund("ch_ada2", "5", "us"),
        _refund("ch_ada2", "5", reason="fraudulent"),
    ):
        assert await refusal(executor, "stripe_refund_payment", bad) == "INVALID_ARGUMENTS"
    assert len(stripe.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_a_refund_needs_read_and_refund_on_the_customer(start, stripe):
    executor = await start({**customer(ADA, ("refund",)), **amount("usd")})
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada1", "5")) == "UNKNOWN_OPERATION"
    executor = await start(
        {**customer(ADA, ("read", "refund")), **customer(GRACE, ("refund",)), **amount("usd")}
    )
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_grace", "5")) == "POLICY_DENIED"
    executor = await start({**customer(ADA), **amount("usd")})
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada1", "5")) == "UNKNOWN_OPERATION"
    executor = await start(customer(ADA, ("read", "refund")))
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada1", "5")) == "UNKNOWN_OPERATION"
    assert stripe.writes == []


@pytest.mark.django_db(transaction=True)
async def test_a_ceiling_denies_larger_amounts_whatever_users_allow(start, stripe):
    await start({})
    await ceiling("stripe", "amount", "usd>100", "deny", actions=("refund",))
    executor = await start({**customer("*", ("read", "refund")), **amount("*")})
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada2", "100.01")) == "POLICY_DENIED"
    await executor.invoke("stripe_refund_payment", _refund("ch_ada2", "100"))
    await executor.invoke("stripe_refund_payment", _refund("ch_guest", "10"))
    await executor.invoke("stripe_refund_payment", _refund("ch_yen", "4000", "jpy"))
    assert [form["amount"] for _, form in stripe.writes] == ["10000", "1000", "4000"]


@pytest.mark.django_db(transaction=True)
async def test_refunds_are_checked_against_the_payment_before_sending(start, stripe):
    executor = await start({**customer(ADA, ("read", "refund")), **amount("*")})
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_eur", "5")) == "CURRENCY_MISMATCH"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada1", "50.01")) == "REFUND_REFUSED"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_disputed", "1")) == "REFUND_REFUSED"
    stripe.charges["ch_ada1"]["amount_refunded"] = 5000
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada1", "1")) == "REFUND_REFUSED"
    stripe.charges["ch_ada2"]["status"] = "pending"
    assert await refusal(executor, "stripe_refund_payment", _refund("ch_ada2", "1")) == "REFUND_REFUSED"
    calls = []

    def move(method, path, params):
        if path == "/charges/ch_eur":
            calls.append(path)
            if len(calls) == 2:
                stripe.charges["ch_eur"]["customer"] = GRACE
        return None

    stripe.hook = move
    assert (
        await refusal(executor, "stripe_refund_payment", _refund("ch_eur", "5", "eur")) == "PAYMENT_CHANGED"
    )
    assert stripe.writes == []


@pytest.mark.django_db(transaction=True)
async def test_stripe_refusing_a_refund_is_not_applied(start, stripe):
    executor = await start({**customer(ADA, ("read", "refund")), **amount("*")})
    stripe.hook = lambda method, path, params: (
        FakeStripe.error(400, "invalid_request_error", "charge_already_refunded")
        if method == "POST"
        else None
    )
    with pytest.raises(OperationError) as caught:
        await executor.invoke("stripe_refund_payment", _refund("ch_ada1", "5"))
    assert caught.value.code == "PROVIDER_REJECTED" and SECRET not in caught.value.message
    stripe.hook = None
    await executor.invoke("stripe_refund_payment", _refund("ch_ada1", "5"))


# Credits


def _credit(customer_id: str, value: str, currency: str = "usd") -> dict:
    return {
        "customer": customer_id,
        "amount": value,
        "currency": currency,
        "description": "Sorry for the outage",
    }


@pytest.mark.django_db(transaction=True)
async def test_credits_are_capped_and_match_the_customers_currency(start, stripe):
    executor = await start(
        {
            **customer(ADA, ("read", "credit")),
            **customer(EVE, ("read", "credit")),
            **amount("usd<=20", ("credit",)),
        }
    )
    [credit] = _items(await executor.invoke("stripe_credit_customer", _credit(ADA, "20")))
    assert credit["credit"] == "20.00" and credit["ending_balance"] == "-20.00"
    assert stripe.writes[-1] == (
        f"/customers/{ADA}/balance_transactions",
        {"amount": "-2000", "currency": "usd", "description": "Sorry for the outage"},
    )
    assert await refusal(executor, "stripe_credit_customer", _credit(ADA, "20.01")) == "POLICY_DENIED"
    assert await refusal(executor, "stripe_credit_customer", _credit(GRACE, "1")) == "POLICY_DENIED"
    stripe.customers[ADA]["currency"] = "eur"
    executor = await start({**customer("*", ("read", "credit")), **amount("*", ("credit",))})
    assert await refusal(executor, "stripe_credit_customer", _credit(ADA, "1")) == "CURRENCY_MISMATCH"
    assert await refusal(executor, "stripe_credit_customer", _credit(GONE, "1")) == "POLICY_DENIED"
    bad = {**_credit(ADA, "1", "eur"), "description": "a\nb"}
    assert await refusal(executor, "stripe_credit_customer", bad) == "INVALID_ARGUMENTS"
    await executor.invoke("stripe_credit_customer", _credit(EVE, "1000", "jpy"))
    assert stripe.writes[-1][1]["amount"] == "-1000" and stripe.customers[EVE]["currency"] == "jpy"
    executor = await start({**customer(ADA, ("read", "refund")), **amount("*", ("refund", "credit"))})
    assert await refusal(executor, "stripe_credit_customer", _credit(ADA, "1", "eur")) == "UNKNOWN_OPERATION"


# Connecting with a key


def _post(api, url: str, body: dict, method: str = "post"):
    return getattr(api, method)(url, data=json.dumps(body), content_type="application/json")


@pytest.mark.django_db
def test_keys_connect_and_are_never_returned(api, workspace, stripe, monkeypatch):
    # Gmail is offered only with a Google client.
    monkeypatch.setattr(config(), "google_client_id", "gid")
    monkeypatch.setattr(config(), "google_client_secret", SecretStr("gs"))
    connectors = {c["slug"]: c for c in api.get(f"/api/workspaces/{workspace.id}/connectors").json()}
    assert connectors["stripe"]["auth"] == "api_key"
    assert (
        connectors["stripe"]["key_label"] == "Restricted API key"
        and "rk_live_" in connectors["stripe"]["key_hint"]
    )
    assert connectors["gmail"]["key_label"] is None

    url = f"/api/workspaces/{workspace.id}/connections/stripe/key"
    refused = _post(api, url, {"key": "sk_live_" + "s" * 24})
    assert refused.status_code == 422 and "sk_live_" not in refused.content.decode()
    too_long = _post(api, url, {"key": "rk_test_" + "x" * 600})
    assert too_long.status_code == 422 and "x" * 50 not in too_long.content.decode()
    assert (
        _post(api, f"/api/workspaces/{workspace.id}/connections/gmail/key", {"key": KEY}).status_code == 422
    )

    created = _post(api, url, {"key": KEY})
    assert created.status_code == 200, created.content
    body = created.json()
    assert body["label"] == "Acme (test mode)" and body["auth"] == "api_key"
    assert KEY not in created.content.decode()
    live = _post(api, url, {"key": LIVE_KEY}).json()
    assert live["id"] != body["id"]
    with workspace_scope(workspace.id):
        connection = Connection.objects.get(pk=body["id"])
        assert connection.external_account_id == "acct_1:test"
        assert connection.credentials() == {"kind": "api_key", "key": KEY}

    replace = f"/api/workspaces/{workspace.id}/connections/{body['id']}/key"
    other = _post(api, replace, {"key": OTHER_KEY}, method="put")
    assert other.status_code == 422 and "different Stripe account" in other.json()["detail"]
    assert _post(api, replace, {"key": LIVE_KEY}, method="put").status_code == 422
    renewed = "rk_test_" + "d" * 24
    stripe.accounts[renewed] = "acct_1"
    with workspace_scope(workspace.id):
        Connection.objects.filter(pk=body["id"]).update(status=Connection.Status.ERROR)
    replaced = _post(api, replace, {"key": renewed}, method="put")
    assert replaced.status_code == 200 and replaced.json()["status"] == "active"
    assert renewed not in replaced.content.decode()
    with workspace_scope(workspace.id):
        assert Connection.objects.get(pk=body["id"]).credentials()["key"] == renewed


@pytest.mark.django_db
def test_only_key_connections_take_a_key(api, workspace, connection):
    url = f"/api/workspaces/{workspace.id}/connections/{connection.id}/key"
    assert _post(api, url, {"key": KEY}, method="put").status_code == 422
