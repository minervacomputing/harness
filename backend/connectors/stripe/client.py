"""A thin async client for the Stripe API, authenticated with a restricted key.

The API version is pinned, so response shapes do not change under Minerva. Responses are validated before
use. Stripe's errors carry a type and a code: a key without a permission is a `permission_error` (403), an
object that does not exist is `resource_missing` (404); refusals of a refund or credit are named by their
code, never by Stripe's wording.
"""

import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OperationError
from connectors.http import ProviderHTTP

API_URL = "https://api.stripe.com/v1"
API_VERSION = "2025-08-27.basil"
# A restricted key; secret keys (sk_) are refused, since they can do anything in the account.
KEY = re.compile(r"\Ark_(test|live)_[A-Za-z0-9]{10,250}\Z")
# Stripe object ids: a short prefix, an underscore and letters and digits.
OBJECT_ID = re.compile(r"\A[a-z]{2,8}_[A-Za-z0-9]{1,100}\Z")
CUSTOMER_ID = re.compile(r"\Acus_[A-Za-z0-9]{1,100}\Z")
CHARGE_ID = re.compile(r"\A(ch|py)_[A-Za-z0-9]{1,100}\Z")
SEARCH_PAGE = re.compile(r"\A[A-Za-z0-9_=+/:.-]{1,500}\Z")
_CODE = re.compile(r"\A[a-z0-9_]{1,64}\Z")
MAX_RESPONSE = 4 * 1024 * 1024

# Refusals of a write that say what to change, by Stripe's error code.
REFUSALS = {
    "charge_already_refunded": "This payment is already refunded in full.",
    "charge_disputed": "This payment is disputed; Stripe does not refund disputed payments.",
    "amount_too_large": "The amount is more than Stripe allows here.",
    "amount_too_small": "The amount is less than Stripe allows here.",
    "balance_insufficient": "The Stripe balance is too low for this refund.",
    "refund_disputed_payment": "This payment is disputed; Stripe does not refund disputed payments.",
}


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class BusinessProfile(Model):
    name: str | None = None


class Dashboard(Model):
    display_name: str | None = None


class Settings(Model):
    dashboard: Dashboard | None = None


class Account(Model):
    id: str
    email: str | None = None
    default_currency: str | None = None
    business_profile: BusinessProfile | None = None
    settings: Settings | None = None


class Customer(Model):
    id: str
    deleted: bool = False
    name: str | None = None
    email: str | None = None
    description: str | None = None
    currency: str | None = None
    balance: int = 0
    delinquent: bool | None = None
    created: int | None = None


class BillingDetails(Model):
    name: str | None = None
    email: str | None = None


class Card(Model):
    brand: str | None = None
    last4: str | None = None


class PaymentMethodDetails(Model):
    type: str | None = None
    card: Card | None = None


class Charge(Model):
    id: str
    amount: int
    amount_captured: int = 0
    amount_refunded: int = 0
    captured: bool = False
    paid: bool = False
    refunded: bool = False
    disputed: bool = False
    status: str
    currency: str
    # Required: a charge without the field is not one Minerva can place. Null means a guest payment.
    customer: str | None
    created: int | None = None
    description: str | None = None
    payment_intent: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    billing_details: BillingDetails | None = None
    payment_method_details: PaymentMethodDetails | None = None


class Refund(Model):
    id: str
    amount: int
    currency: str
    status: str | None = None
    charge: str | None = None
    reason: str | None = None
    created: int | None = None


class Invoice(Model):
    id: str
    customer: str | None
    number: str | None = None
    status: str | None = None
    currency: str
    total: int = 0
    amount_due: int = 0
    amount_paid: int = 0
    amount_remaining: int = 0
    created: int | None = None
    due_date: int | None = None
    description: str | None = None


class Recurring(Model):
    interval: str | None = None
    interval_count: int | None = None


class Price(Model):
    id: str
    nickname: str | None = None
    product: str | None = None
    unit_amount: int | None = None
    currency: str | None = None
    recurring: Recurring | None = None


class SubscriptionItem(Model):
    price: Price | None = None
    quantity: int | None = None
    current_period_end: int | None = None


class SubscriptionItems(Model):
    data: list[SubscriptionItem] = []


class Subscription(Model):
    id: str
    customer: str | None
    status: str
    currency: str | None = None
    created: int | None = None
    cancel_at_period_end: bool = False
    cancel_at: int | None = None
    canceled_at: int | None = None
    items: SubscriptionItems = SubscriptionItems()


class BalanceTransaction(Model):
    id: str
    customer: str | None
    amount: int
    currency: str
    ending_balance: int | None = None
    description: str | None = None
    created: int | None = None


class Page[T](Model):
    data: list[T] = []
    has_more: bool = False
    next_page: str | None = None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    try:
        error = response.json().get("error", {})
        kind, code = error.get("type"), error.get("code")
    except ValueError, AttributeError, TypeError:
        return None
    if kind == "permission_error" or response.status_code == 403:
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "The Stripe key does not have the permission this needs. Edit the restricted key in Stripe "
            "to give it the permissions in Minerva's setup guide.",
        )
    if response.status_code == 404:
        return OperationError("NOT_FOUND", "Stripe did not find this object.")
    if isinstance(code, str) and code in REFUSALS:
        return OperationError("PROVIDER_REJECTED", REFUSALS[code])
    if response.status_code == 400 and isinstance(code, str) and _CODE.match(code):
        return OperationError("PROVIDER_REJECTED", f"Stripe rejected this request ({code}).")
    return None


def next_cursor(page: Page) -> str | None:
    """The id after which the next page starts, as list endpoints take it."""
    if not page.has_more or not page.data:
        return None
    last = page.data[-1].id
    if not OBJECT_ID.match(last):
        raise OperationError("PROVIDER_LIMIT", "Stripe returned an id Minerva does not accept.")
    return last


def _params(**values: Any) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


class StripeClient:
    def __init__(
        self, key: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self.key = key
        self._http = ProviderHTTP(
            "Stripe",
            base_url=base_url,
            headers={"Authorization": f"Bearer {key}", "Stripe-Version": API_VERSION},
            transport=transport,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    @property
    def test_mode(self) -> bool:
        return self.key.startswith("rk_test_")

    async def _get[M: BaseModel](self, model: type[M], path: str, **params: Any) -> M:
        response = await self._http.bounded(
            path,
            limit=MAX_RESPONSE,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Stripe's response was too large to read."),
            params=_params(**params),
        )
        try:
            return model.model_validate_json(response.content)
        except ValueError as error:
            raise self.unexpected() from error

    async def account(self) -> Account:
        return await self._get(Account, "/account")

    async def customer(self, customer_id: str) -> Customer:
        found = await self._get(Customer, f"/customers/{customer_id}")
        if found.id != customer_id:
            raise self.unexpected()
        return found

    async def customers(
        self, *, email: str | None = None, limit: int, cursor: str | None = None
    ) -> Page[Customer]:
        return await self._get(Page[Customer], "/customers", email=email, limit=limit, starting_after=cursor)

    async def search_customers(self, query: str, *, limit: int, page: str | None = None) -> Page[Customer]:
        return await self._get(Page[Customer], "/customers/search", query=query, limit=limit, page=page)

    async def charge(self, charge_id: str) -> Charge:
        found = await self._get(Charge, f"/charges/{charge_id}")
        if found.id != charge_id:
            raise self.unexpected()
        return found

    async def charges(self, *, customer: str | None, limit: int, cursor: str | None) -> Page[Charge]:
        return await self._get(
            Page[Charge], "/charges", customer=customer, limit=limit, starting_after=cursor
        )

    async def invoices(
        self, *, customer: str | None, status: str | None, limit: int, cursor: str | None
    ) -> Page[Invoice]:
        return await self._get(
            Page[Invoice], "/invoices", customer=customer, status=status, limit=limit, starting_after=cursor
        )

    async def subscriptions(
        self, *, customer: str | None, status: str | None, limit: int, cursor: str | None
    ) -> Page[Subscription]:
        return await self._get(
            Page[Subscription],
            "/subscriptions",
            customer=customer,
            status=status,
            limit=limit,
            starting_after=cursor,
        )

    async def refund(self, *, charge: str, amount: int, reason: str | None) -> Refund:
        return await self._http.parsed(
            Refund,
            "POST",
            "/refunds",
            data=_params(charge=charge, amount=amount, reason=reason, **{"metadata[created_by]": "minerva"}),
        )

    async def credit(
        self, *, customer: str, amount: int, currency: str, description: str
    ) -> BalanceTransaction:
        return await self._http.parsed(
            BalanceTransaction,
            "POST",
            f"/customers/{customer}/balance_transactions",
            data={"amount": -amount, "currency": currency, "description": description},
        )
