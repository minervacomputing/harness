"""Stripe's write operations: refunding a payment and crediting a customer's balance.

Each needs its action on the customer (and Read on it) and on the amount. The amount is authorized in the
currency the agent names, before Minerva has said anything about the payment or customer; the currency is
checked against Stripe's just before sending, and a mismatch is refused. A refund is checked against what
is left to refund at that moment, so an agent cannot ask Stripe for more than the payment has.
"""

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
    denied,
)
from connectors.stripe import money
from connectors.stripe.client import Charge, StripeClient
from connectors.stripe.scope import (
    AMOUNT,
    CUSTOMER,
    Amount,
    Currency,
    CustomerId,
    PaymentId,
    amount,
    billed,
    customer,
)
from connectors.text import single_line


class Money(OperationInput):
    amount: Amount
    currency: Currency

    @model_validator(mode="after")
    def _exact(self) -> Money:
        try:
            money.parse(self.amount, self.currency)
        except ValueError as error:
            raise ValueError(f"amount {error}") from None
        return self

    @property
    def minor(self) -> int:
        return money.parse(self.amount, self.currency)


async def _fetch_charge(client: StripeClient, payment: str) -> Charge:
    try:
        return await client.charge(payment)
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise denied() from None
        raise


def _refusal(message: str) -> OperationError:
    return OperationError("REFUND_REFUSED", message)


def _check_refund(charge: Charge, data: RefundPayment) -> None:
    if charge.currency.lower() != data.currency:
        raise money.mismatch(charge.currency.lower())
    if charge.status != "succeeded" or not charge.captured:
        raise _refusal("Only a successful, captured payment can be refunded.")
    if charge.disputed:
        raise _refusal("This payment is disputed; Stripe does not refund disputed payments.")
    left = charge.amount_captured - charge.amount_refunded
    if left <= 0:
        raise _refusal("This payment is already refunded in full.")
    if data.minor > left:
        raise _refusal(f"Only {money.display(left, data.currency)} of this payment is left to refund.")


class RefundPayment(Money):
    payment: PaymentId
    amount: Annotated[
        str,
        Field(
            min_length=1,
            max_length=16,
            description=(
                "How much to refund, in the currency's usual unit, as a decimal string: 12.50 for 12.50 USD. "
                "At most what is left to refund."
            ),
        ),
    ]
    currency: Annotated[
        str,
        Field(min_length=3, max_length=3, description="The payment's currency, such as usd."),
        AfterValidator(money.currency),
    ]
    reason: Literal["duplicate", "requested_by_customer"] | None = None


async def _prepare_refund(binding: Binding, data: RefundPayment) -> Prepared:
    client: StripeClient = binding.client
    charge = await _fetch_charge(client, data.payment)
    resource = billed(binding, charge.id, charge.customer)

    async def execute() -> ProviderOutput:
        current = await _fetch_charge(client, data.payment)
        if current.customer != charge.customer:
            raise OperationError("PAYMENT_CHANGED", "This payment changed since it was checked. Try again.")
        _check_refund(current, data)
        refund = await client.refund(charge=current.id, amount=data.minor, reason=data.reason)
        record: dict[str, Any] = {
            "id": refund.id,
            "payment": refund.charge,
            "amount": money.major(refund.amount, refund.currency.lower()),
            "currency": refund.currency,
            "status": refund.status,
            "reason": refund.reason,
            "created": refund.created,
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared(
        [
            Need(resource, "read"),
            Need(resource, "refund"),
            Need(amount(binding, data.currency, data.minor), "refund"),
        ],
        execute,
    )


REFUND_PAYMENT = Operation(
    name="refund_payment",
    title="Refund a payment",
    description=(
        "Refund part or all of a payment to the card or account it came from. Give the amount and the "
        "payment's currency; the refund goes through at once, and Stripe reports when it reaches the "
        "customer. Disputed payments cannot be refunded."
    ),
    input_model=RefundPayment,
    needs=((CUSTOMER, "read"), (CUSTOMER, "refund"), (AMOUNT, "refund")),
    prepare=_prepare_refund,
    output_action="refund",
    mutates=True,
)


class CreditCustomer(Money):
    customer: CustomerId
    amount: Annotated[
        str,
        Field(
            min_length=1,
            max_length=16,
            description="How much to credit, in the currency's usual unit, as a decimal string: 12.50.",
        ),
    ]
    currency: Annotated[
        str,
        Field(
            min_length=3,
            max_length=3,
            description="The customer's currency, such as usd. A customer has one currency once billed.",
        ),
        AfterValidator(money.currency),
    ]
    description: Annotated[
        str,
        Field(min_length=1, max_length=350, description="Why the credit is given; the customer may see it."),
        AfterValidator(single_line),
    ]


async def _prepare_credit(binding: Binding, data: CreditCustomer) -> Prepared:
    client: StripeClient = binding.client
    resource = customer(binding, data.customer)

    async def execute() -> ProviderOutput:
        try:
            found = await client.customer(data.customer)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise
        if found.deleted:
            raise denied()
        if found.currency is not None and found.currency.lower() != data.currency:
            raise money.mismatch(found.currency.lower())
        entry = await client.credit(
            customer=found.id, amount=data.minor, currency=data.currency, description=data.description
        )
        currency = entry.currency.lower()
        record = {
            "id": entry.id,
            "customer": entry.customer,
            "credit": money.major(-entry.amount, currency) if entry.amount < 0 else None,
            "currency": currency,
            # Negative is credit the customer has; it is applied to their next invoices.
            "ending_balance": money.major(entry.ending_balance, currency)
            if entry.ending_balance is not None
            else None,
            "description": entry.description,
            "created": entry.created,
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared(
        [
            Need(resource, "read"),
            Need(resource, "credit"),
            Need(amount(binding, data.currency, data.minor), "credit"),
        ],
        execute,
    )


CREDIT_CUSTOMER = Operation(
    name="credit_customer",
    title="Credit a customer",
    description=(
        "Add credit to a customer's balance, which Stripe takes off their next invoices. Nothing is paid "
        "out, and the customer is not notified. Give the amount in the customer's currency and a "
        "description of why."
    ),
    input_model=CreditCustomer,
    needs=((CUSTOMER, "read"), (CUSTOMER, "credit"), (AMOUNT, "credit")),
    prepare=_prepare_credit,
    output_action="credit",
    mutates=True,
)
