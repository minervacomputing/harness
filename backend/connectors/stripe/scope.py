"""What Stripe's operations share: the kinds, ids, and where an object sits.

Customers are one hierarchical kind. A customer's charges, invoices and subscriptions are resources of the
same kind inside it, keyed by their own id, so a grant on a customer covers what is billed to it. An object
billed to no customer (a guest payment) sits nowhere, and only allowing every customer covers it. Stripe
never moves an object to another customer, but writes still check the customer again just before sending.
"""

from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError
from connectors.stripe import money
from connectors.stripe.client import CHARGE_ID, CUSTOMER_ID, OBJECT_ID
from permissions.policy import Resource

CUSTOMER = "customer"
AMOUNT = money.AMOUNT


def _matching(pattern, message: str):
    def check(value: str) -> str:
        if not pattern.match(value):
            raise ValueError(message)
        return value

    return check


CustomerId = Annotated[
    str,
    Field(min_length=5, max_length=110, description="A customer id from list_customers, such as cus_123."),
    AfterValidator(_matching(CUSTOMER_ID, "must be a customer id such as cus_123")),
]
PaymentId = Annotated[
    str,
    Field(min_length=4, max_length=110, description="A payment id from list_payments, such as ch_123."),
    AfterValidator(_matching(CHARGE_ID, "must be a payment id from list_payments, such as ch_123")),
]
Currency = Annotated[
    str,
    Field(min_length=3, max_length=3, description="A three-letter currency code, such as usd."),
    AfterValidator(money.currency),
]
Amount = Annotated[
    str,
    Field(
        min_length=1,
        max_length=16,
        description="An amount in the currency's usual unit, as a decimal string: 12.50 for 12.50 USD.",
    ),
]
# The run's own page token; the executor swaps it for Stripe's before the call is prepared.
Cursor = Annotated[str, Field(max_length=200)]


def customer(binding: Binding, customer_id: str) -> Resource:
    return binding.resource(CUSTOMER, customer_id)


def billed(binding: Binding, object_id: str, customer_id: str | None) -> Resource:
    """An object inside the customer it is billed to; an object of no customer sits nowhere."""
    if not OBJECT_ID.match(object_id) or (customer_id is not None and not CUSTOMER_ID.match(customer_id)):
        raise OperationError("PROVIDER_FAILED", "Stripe returned an unexpected response.")
    return binding.resource(CUSTOMER, object_id, (customer_id,) if customer_id else ())


def amount(binding: Binding, currency: str, minor: int) -> Resource:
    return binding.resource(AMOUNT, money.amount_id(currency, minor), money.ancestors(currency, minor))


def cursor(value: str | None) -> str | None:
    if value is not None and not OBJECT_ID.match(value):
        raise OperationError("INVALID_CURSOR", "This cursor is not valid.")
    return value
