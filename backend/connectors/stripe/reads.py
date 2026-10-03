"""Stripe's read operations: customers, and the payments, invoices and subscriptions billed to them."""

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Enumerate,
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
from connectors.stripe.client import (
    CUSTOMER_ID,
    Charge,
    Customer,
    Invoice,
    Page,
    StripeClient,
    Subscription,
    next_cursor,
)
from connectors.stripe.scope import CUSTOMER, Cursor, CustomerId, billed, cursor, customer
from connectors.text import single_line, truncate

MAX_TEXT = 500
Limit = Annotated[int, Field(ge=1, le=25)]
PAGE_NOTE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor."


def _money(minor: int | None, currency: str | None) -> str | None:
    if minor is None or currency is None:
        return None
    return money.major(minor, currency.lower())


def _text(record: dict[str, Any], name: str, value: str | None) -> None:
    record[name], cut = truncate(value, MAX_TEXT)
    if cut:
        record[f"{name}_truncated"] = True


def customer_data(found: Customer) -> dict[str, Any]:
    record = {
        "id": found.id,
        "name": found.name,
        "email": found.email,
        "currency": found.currency,
        # Negative is credit the customer has with you; positive is what they owe on their next invoice.
        "balance": _money(found.balance, found.currency) if found.currency else None,
        "delinquent": found.delinquent,
        "created": found.created,
    }
    _text(record, "description", found.description)
    return record


def _charge(found: Charge) -> dict[str, Any]:
    currency = found.currency
    card = found.payment_method_details.card if found.payment_method_details else None
    billing = found.billing_details
    refundable = found.amount_captured - found.amount_refunded if found.status == "succeeded" else 0
    record = {
        "id": found.id,
        "customer": found.customer,
        "amount": _money(found.amount, currency),
        "amount_captured": _money(found.amount_captured, currency),
        "amount_refunded": _money(found.amount_refunded, currency),
        "refundable": _money(max(refundable, 0), currency),
        "currency": currency,
        "status": found.status,
        "captured": found.captured,
        "refunded": found.refunded,
        "disputed": found.disputed,
        "created": found.created,
        "payment_intent": found.payment_intent,
        "payment_method": found.payment_method_details.type if found.payment_method_details else None,
        "card_brand": card.brand if card else None,
        "card_last4": card.last4 if card else None,
        "billing_name": billing.name if billing else None,
        "billing_email": billing.email if billing else None,
        "failure_code": found.failure_code,
    }
    _text(record, "description", found.description)
    _text(record, "failure_message", found.failure_message)
    return record


def _invoice(found: Invoice) -> dict[str, Any]:
    currency = found.currency
    record = {
        "id": found.id,
        "customer": found.customer,
        "number": found.number,
        "status": found.status,
        "currency": currency,
        "total": _money(found.total, currency),
        "amount_due": _money(found.amount_due, currency),
        "amount_paid": _money(found.amount_paid, currency),
        "amount_remaining": _money(found.amount_remaining, currency),
        "created": found.created,
        "due_date": found.due_date,
    }
    _text(record, "description", found.description)
    return record


def _subscription(found: Subscription) -> dict[str, Any]:
    items = []
    for item in found.items.data[:20]:
        price = item.price
        items.append(
            {
                "price": price.id if price else None,
                "nickname": price.nickname if price else None,
                "product": price.product if price else None,
                "unit_amount": _money(price.unit_amount, price.currency) if price else None,
                "currency": price.currency if price else None,
                "interval": price.recurring.interval if price and price.recurring else None,
                "interval_count": price.recurring.interval_count if price and price.recurring else None,
                "quantity": item.quantity,
                "current_period_end": item.current_period_end,
            }
        )
    return {
        "id": found.id,
        "customer": found.customer,
        "status": found.status,
        "currency": found.currency,
        "created": found.created,
        "cancel_at_period_end": found.cancel_at_period_end,
        "cancel_at": found.cancel_at,
        "canceled_at": found.canceled_at,
        "items": items,
    }


def _billed(binding: Binding, page: Page, data) -> ProviderOutput:
    records = [ScopedRecord(billed(binding, item.id, item.customer), data(item)) for item in page.data]
    return ProviderOutput(records, next_cursor(page))


def _scope(binding: Binding, customer_id: str | None) -> list:
    if customer_id is None:
        return [Enumerate(CUSTOMER, "read")]
    return [Need(customer(binding, customer_id), "read")]


class ListCustomers(OperationInput):
    email: Annotated[
        str | None,
        Field(
            min_length=3,
            max_length=512,
            description="Only customers with exactly this email address. Only one page is returned.",
        ),
        AfterValidator(single_line),
    ] = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_list_customers(binding: Binding, data: ListCustomers) -> Prepared:
    client: StripeClient = binding.client

    async def execute() -> ProviderOutput:
        page = await client.customers(email=data.email, limit=data.limit, cursor=cursor(data.cursor))
        records = [
            ScopedRecord(customer(binding, found.id), customer_data(found))
            for found in page.data
            if not found.deleted and CUSTOMER_ID.match(found.id)
        ]
        # A next page of customers all filtered out would tell an agent that hidden customers have the
        # address, so a lookup by address returns one page.
        return ProviderOutput(records, None if data.email else next_cursor(page))

    return Prepared([Enumerate(CUSTOMER, "read")], execute)


LIST_CUSTOMERS = Operation(
    name="list_customers",
    title="List customers",
    description=(
        "List the customers you may see, newest first, with their contact details and balance (negative "
        f"is credit they have, positive is what they owe). {PAGE_NOTE}"
    ),
    input_model=ListCustomers,
    needs=((CUSTOMER, "read"),),
    prepare=_prepare_list_customers,
    paginated=True,
)


class GetCustomer(OperationInput):
    customer: CustomerId


async def _prepare_get_customer(binding: Binding, data: GetCustomer) -> Prepared:
    resource = customer(binding, data.customer)

    async def execute() -> ProviderOutput:
        try:
            found = await binding.client.customer(data.customer)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise
        if found.deleted:
            raise denied()
        return ProviderOutput([ScopedRecord(resource, customer_data(found))])

    return Prepared([Need(resource, "read")], execute)


GET_CUSTOMER = Operation(
    name="get_customer",
    title="Get a customer",
    description="Get one customer: contact details, currency, balance and whether they are delinquent.",
    input_model=GetCustomer,
    needs=((CUSTOMER, "read"),),
    prepare=_prepare_get_customer,
)


class ListPayments(OperationInput):
    customer: Annotated[CustomerId | None, Field(description="Only this customer's payments.")] = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_list_payments(binding: Binding, data: ListPayments) -> Prepared:
    client: StripeClient = binding.client

    async def execute() -> ProviderOutput:
        page = await client.charges(customer=data.customer, limit=data.limit, cursor=cursor(data.cursor))
        return _billed(binding, page, _charge)

    return Prepared(_scope(binding, data.customer), execute)


LIST_PAYMENTS = Operation(
    name="list_payments",
    title="List payments",
    description=(
        "List payments (charges), newest first: amounts in the currency's usual unit, what was refunded "
        "and what is left to refund, status, dispute, card brand and last four digits. Payments without a "
        f"customer are shown only when every customer may be seen. {PAGE_NOTE}"
    ),
    input_model=ListPayments,
    needs=((CUSTOMER, "read"),),
    prepare=_prepare_list_payments,
    paginated=True,
)


class ListInvoices(OperationInput):
    customer: Annotated[CustomerId | None, Field(description="Only this customer's invoices.")] = None
    status: Literal["draft", "open", "paid", "uncollectible", "void"] | None = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_list_invoices(binding: Binding, data: ListInvoices) -> Prepared:
    client: StripeClient = binding.client

    async def execute() -> ProviderOutput:
        page = await client.invoices(
            customer=data.customer, status=data.status, limit=data.limit, cursor=cursor(data.cursor)
        )
        return _billed(binding, page, _invoice)

    return Prepared(_scope(binding, data.customer), execute)


LIST_INVOICES = Operation(
    name="list_invoices",
    title="List invoices",
    description=f"List invoices, newest first, with their status and amounts due, paid and remaining. {PAGE_NOTE}",
    input_model=ListInvoices,
    needs=((CUSTOMER, "read"),),
    prepare=_prepare_list_invoices,
    paginated=True,
)


class ListSubscriptions(OperationInput):
    customer: Annotated[CustomerId | None, Field(description="Only this customer's subscriptions.")] = None
    status: Annotated[
        Literal[
            "active",
            "past_due",
            "unpaid",
            "canceled",
            "incomplete",
            "incomplete_expired",
            "trialing",
            "paused",
            "all",
        ]
        | None,
        Field(description="Leave out for every subscription that is not canceled."),
    ] = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_list_subscriptions(binding: Binding, data: ListSubscriptions) -> Prepared:
    client: StripeClient = binding.client

    async def execute() -> ProviderOutput:
        page = await client.subscriptions(
            customer=data.customer, status=data.status, limit=data.limit, cursor=cursor(data.cursor)
        )
        return _billed(binding, page, _subscription)

    return Prepared(_scope(binding, data.customer), execute)


LIST_SUBSCRIPTIONS = Operation(
    name="list_subscriptions",
    title="List subscriptions",
    description=(
        "List subscriptions, newest first, with their status, prices and when the current period ends. "
        f"{PAGE_NOTE}"
    ),
    input_model=ListSubscriptions,
    needs=((CUSTOMER, "read"),),
    prepare=_prepare_list_subscriptions,
    paginated=True,
)
