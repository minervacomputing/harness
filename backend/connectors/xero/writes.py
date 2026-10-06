"""Xero's write operations: draft sales invoices and draft bills.

Both create one invoice with status DRAFT, which Xero neither sends nor posts to the accounts: a person approves
it in Xero. Nothing else is written. The request is built field by field from checked input, the status is
fixed, the contact is named by id only (a contact named by name would be created), and it is sent with PUT,
which only creates (POST would update an invoice it matches). The contact is read first, after the organisation
is authorized: it must exist and be active.

Amounts are taken as decimal strings and sent as JSON numbers. They have at most 14 significant digits, so the
number's text is the decimal itself.
"""

import logging
import re
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
)
from connectors.text import plain_text, single_line
from connectors.xero.client import Invoice, XeroClient, invoice_date, messages, uuid
from connectors.xero.organisations import (
    ORGANISATION,
    ContactId,
    OrganisationId,
    money,
    resolve_organisation,
    short,
)
from connectors.xero.reads import KINDS, TYPES, Day

logger = logging.getLogger(__name__)

MAX_LINES = 100
WRITE_CONSENT = (frozenset({"accounting.invoices"}),)
# Xero's line amount types: whether unit amounts include tax.
AMOUNTS = {"exclusive": "Exclusive", "inclusive": "Inclusive", "no_tax": "NoTax"}


def _decimal(pattern: str, *, positive: bool = False, most: Decimal | None = None):
    compiled = re.compile(pattern)

    def check(value: str) -> str:
        if not compiled.match(value):
            raise ValueError("must be a decimal number written like 12.50")
        found = Decimal(value)
        if positive and found <= 0:
            raise ValueError("must be more than 0")
        if most is not None and found > most:
            raise ValueError(f"must be at most {most}")
        shown = f"{found.normalize():f}"
        return "0" if shown in {"0", "-0"} else shown

    return check


Quantity = Annotated[
    str,
    Field(min_length=1, max_length=15, description="A decimal string, more than 0, up to 4 decimal places."),
    AfterValidator(_decimal(r"\A[0-9]{1,9}(\.[0-9]{1,4})?\Z", positive=True)),
]
UnitAmount = Annotated[
    str,
    Field(
        min_length=1,
        max_length=16,
        description="A decimal string, up to 4 decimal places; negative for a discount line.",
    ),
    AfterValidator(_decimal(r"\A-?[0-9]{1,10}(\.[0-9]{1,4})?\Z")),
]
DiscountRate = Annotated[
    str,
    Field(min_length=1, max_length=6, description="A percentage, 0 to 100, as a decimal string."),
    AfterValidator(_decimal(r"\A[0-9]{1,3}(\.[0-9]{1,2})?\Z", most=Decimal(100))),
]
Code = Annotated[str, Field(min_length=1, max_length=50), AfterValidator(single_line)]
Description = Annotated[str, Field(min_length=1, max_length=4000), AfterValidator(plain_text)]
Reference = Annotated[str, Field(min_length=1, max_length=255), AfterValidator(single_line)]
Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$", description="An ISO 4217 code, such as EUR.")]


class Line(OperationInput):
    description: Description
    quantity: Quantity
    unit_amount: UnitAmount
    account_code: Annotated[Code | None, Field(description="An account's code, from list_accounts.")] = None
    tax_type: Annotated[Code | None, Field(description="A tax rate's tax_type, from list_tax_rates.")] = None
    item_code: Annotated[Code | None, Field(description="An item's code in Xero.")] = None


class SalesLine(Line):
    discount_rate: DiscountRate | None = None


class Draft(OperationInput):
    organisation: OrganisationId | None = None
    contact: ContactId
    date: Annotated[Day | None, Field(description="YYYY-MM-DD; Xero uses today when left out.")] = None
    due_date: Annotated[
        Day | None, Field(description="YYYY-MM-DD; the contact's or organisation's terms when left out.")
    ] = None
    currency: Currency | None = None
    amounts_are: Annotated[
        Literal["exclusive", "inclusive", "no_tax"],
        Field(description="Whether unit amounts exclude tax, include it, or carry none."),
    ] = "exclusive"


class DraftInvoice(Draft):
    lines: Annotated[list[SalesLine], Field(min_length=1, max_length=MAX_LINES)]
    number: Annotated[
        Reference | None,
        Field(description="The invoice number; Xero numbers it in sequence when left out."),
    ] = None
    reference: Reference | None = None


class DraftBill(Draft):
    lines: Annotated[list[Line], Field(min_length=1, max_length=MAX_LINES)]
    number: Annotated[
        Reference | None,
        Field(description="The supplier's invoice number, shown in Xero as the bill's reference."),
    ] = None


def _line(line: Line) -> dict[str, Any]:
    body: dict[str, Any] = {
        "Description": line.description,
        "Quantity": float(line.quantity),
        "UnitAmount": float(line.unit_amount),
    }
    if line.account_code is not None:
        body["AccountCode"] = line.account_code
    if line.tax_type is not None:
        body["TaxType"] = line.tax_type
    if line.item_code is not None:
        body["ItemCode"] = line.item_code
    if isinstance(line, SalesLine) and line.discount_rate is not None:
        body["DiscountRate"] = float(line.discount_rate)
    return body


def body(data: DraftInvoice | DraftBill, kind: Literal["sales", "bill"]) -> dict[str, Any]:
    """The invoice sent to Xero: only these fields, and always a draft."""
    invoice: dict[str, Any] = {
        "Type": TYPES[kind],
        "Status": "DRAFT",
        "Contact": {"ContactID": data.contact},
        "LineAmountTypes": AMOUNTS[data.amounts_are],
        "LineItems": [_line(line) for line in data.lines],
    }
    if data.date is not None:
        invoice["Date"] = data.date
    if data.due_date is not None:
        invoice["DueDate"] = data.due_date
    if data.currency is not None:
        invoice["CurrencyCode"] = data.currency
    if data.number is not None:
        invoice["InvoiceNumber"] = data.number
    if isinstance(data, DraftInvoice) and data.reference is not None:
        invoice["Reference"] = data.reference
    return invoice


def _record(invoice: Invoice) -> dict[str, Any]:
    contact = invoice.Contact
    return {
        "created": True,
        "id": uuid(invoice.InvoiceID),
        "type": KINDS.get(invoice.Type or ""),
        "status": invoice.Status,
        "number": short(invoice.InvoiceNumber),
        "reference": short(invoice.Reference),
        "contact": {"id": uuid(contact.ContactID), "name": short(contact.Name)} if contact else None,
        "date": invoice_date(invoice.DateString, invoice.Date),
        "due_date": invoice_date(invoice.DueDateString, invoice.DueDate),
        "currency": invoice.CurrencyCode,
        "sub_total": money(invoice.SubTotal),
        "total_tax": money(invoice.TotalTax),
        "total": money(invoice.Total),
        "warnings": messages(invoice.Warnings),
    }


def _prepare(kind: Literal["sales", "bill"], action: str):
    async def prepare(binding: Binding, data: DraftInvoice | DraftBill) -> Prepared:
        if data.date and data.due_date and data.due_date < data.date:
            raise OperationError("INVALID_ARGUMENTS", "due_date must not be before date.")
        resource, tenant = await resolve_organisation(binding, data.organisation)

        async def execute() -> ProviderOutput:
            client: XeroClient = binding.client
            try:
                contact = await client.contact(tenant, data.contact)
            except OperationError as error:
                if error.code == "NOT_FOUND":
                    raise OperationError(
                        "INVALID_ARGUMENTS", "This organisation has no contact with that id."
                    ) from None
                raise
            if contact.ContactStatus != "ACTIVE":
                raise OperationError("INVALID_ARGUMENTS", "This contact is archived in Xero.")
            created = await client.create_invoice(tenant, body(data, kind))
            if (
                created.Status != "DRAFT"
                or created.Type != TYPES[kind]
                or created.Contact is None
                or uuid(created.Contact.ContactID) != data.contact
            ):
                # The request asked for a draft for this contact; anything else is Xero's doing. The record shows
                # what Xero created, inside the organisation the call was allowed to write.
                logger.error(
                    "Xero answered a draft %s with status %s, type %s", kind, created.Status, created.Type
                )
            return ProviderOutput([ScopedRecord(resource, _record(created))])

        return Prepared([Need(resource, action)], execute)

    return prepare


WRITE_NOTE = (
    "Xero neither sends drafts nor posts them to the accounts; a person reviews and approves them in Xero. A "
    "draft is not deduplicated across runs."
)

CREATE_DRAFT_INVOICE = Operation(
    name="create_draft_invoice",
    title="Create a draft sales invoice",
    description=(
        "Create a draft sales invoice to a customer in a Xero organisation where you may draft sales invoices. "
        "Lines take an account code and tax type from list_accounts and list_tax_rates, or the defaults of "
        "their item, contact or organisation. " + WRITE_NOTE
    ),
    input_model=DraftInvoice,
    needs=((ORGANISATION, "draft_sales"),),
    prepare=_prepare("sales", "draft_sales"),
    consent=WRITE_CONSENT,
    mutates=True,
)

CREATE_DRAFT_BILL = Operation(
    name="create_draft_bill",
    title="Create a draft bill",
    description=(
        "Create a draft bill from a supplier in a Xero organisation where you may draft bills. Lines take an "
        "account code and tax type from list_accounts and list_tax_rates, or the defaults of their item, "
        "contact or organisation. " + WRITE_NOTE
    ),
    input_model=DraftBill,
    needs=((ORGANISATION, "draft_bills"),),
    prepare=_prepare("bill", "draft_bills"),
    consent=WRITE_CONSENT,
    mutates=True,
)
