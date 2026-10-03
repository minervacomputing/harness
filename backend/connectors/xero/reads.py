"""Xero's read operations: organisations, contacts, invoices and bills, accounts and tax rates."""

from datetime import date as Date
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
)
from connectors.text import single_line, truncate
from connectors.xero.client import (
    Address,
    Contact,
    Invoice,
    Outstanding,
    XeroClient,
    invoice_date,
    moment,
    next_page,
    page,
    uuid,
)
from connectors.xero.organisations import (
    ORGANISATION,
    ContactId,
    InvoiceId,
    OrganisationId,
    label,
    money,
    number,
    organisation_resource,
    resolve_organisation,
    short,
)

MAX_DESCRIPTION = 2_000
MAX_LINES = 200
MAX_PAYMENTS = 50
MAX_LISTED = 20
NEXT_PAGE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor."

Cursor = Annotated[str, Field(max_length=1000)]
SearchText = Annotated[str, Field(min_length=1, max_length=100), AfterValidator(single_line)]
# Xero's types for sales invoices and bills.
TYPES = {"sales": "ACCREC", "bill": "ACCPAY"}
KINDS = {value: key for key, value in TYPES.items()}


class ListOrganisations(OperationInput):
    pass


async def _prepare_list_organisations(binding: Binding, data: ListOrganisations) -> Prepared:
    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        records = [
            ScopedRecord(
                organisation_resource(binding, organisation.tenantId),
                {"id": organisation.tenantId, "name": label(organisation)},
            )
            for organisation in await client.organisations()
        ]
        return ProviderOutput(records)

    return Prepared([Enumerate(ORGANISATION, "read")], execute)


LIST_ORGANISATIONS = Operation(
    name="list_organisations",
    title="List organisations",
    description="List the Xero organisations you may read.",
    input_model=ListOrganisations,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_list_organisations,
)


def _address(address: Address) -> dict[str, Any]:
    lines = [address.AddressLine1, address.AddressLine2, address.AddressLine3, address.AddressLine4]
    return {
        "type": address.AddressType,
        "lines": [short(line) for line in lines if short(line)],
        "city": short(address.City),
        "region": short(address.Region),
        "postal_code": short(address.PostalCode),
        "country": short(address.Country),
    }


def _outstanding(found: Outstanding | None) -> dict[str, Any] | None:
    if found is None:
        return None
    return {"outstanding": money(found.Outstanding), "overdue": money(found.Overdue)}


def _contact(contact: Contact) -> dict[str, Any]:
    balances = contact.Balances
    phones = [
        " ".join(part for part in (p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber) if part)
        for p in contact.Phones
    ]
    return {
        "id": uuid(contact.ContactID),
        "name": short(contact.Name),
        "first_name": short(contact.FirstName),
        "last_name": short(contact.LastName),
        "email": short(contact.EmailAddress),
        "contact_number": short(contact.ContactNumber),
        "account_number": short(contact.AccountNumber),
        "status": contact.ContactStatus,
        "is_customer": contact.IsCustomer,
        "is_supplier": contact.IsSupplier,
        "default_currency": contact.DefaultCurrency,
        "tax_number": short(contact.TaxNumber),
        "addresses": [
            _address(a)
            for a in contact.Addresses
            if any(_address(a)[k] for k in ("lines", "city", "country"))
        ][:MAX_LISTED],
        "phones": [short(p) for p in phones if p.strip()][:MAX_LISTED],
        "people": [
            {
                "name": short(" ".join(n for n in (p.FirstName, p.LastName) if n)),
                "email": short(p.EmailAddress),
            }
            for p in contact.ContactPersons
        ][:MAX_LISTED],
        "balances": {
            "receivable": _outstanding(balances.AccountsReceivable) if balances else None,
            "payable": _outstanding(balances.AccountsPayable) if balances else None,
        },
    }


class SearchContacts(OperationInput):
    organisation: OrganisationId | None = None
    text: Annotated[
        SearchText | None,
        Field(description="Words in the contact's name, contact number or email address."),
    ] = None
    include_archived: bool = False
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_search_contacts(binding: Binding, data: SearchContacts) -> Prepared:
    resource, tenant = await resolve_organisation(binding, data.organisation)

    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        current = page(data.cursor)
        found = await client.contacts(
            tenant, page=current, size=data.limit, text=data.text, archived=data.include_archived
        )
        records = [ScopedRecord(resource, _contact(contact)) for contact in found.Contacts]
        return ProviderOutput(records, next_page(found.pagination, current, len(found.Contacts), data.limit))

    return Prepared([Need(resource, "read")], execute)


SEARCH_CONTACTS = Operation(
    name="search_contacts",
    title="Search contacts",
    description=(
        "Find customers and suppliers in a Xero organisation, by name, contact number or email address, sorted "
        "by name. Balances are Xero's totals and name no currency; for amounts in one currency, search the "
        "contact's invoices. Bank details are left out. " + NEXT_PAGE
    ),
    input_model=SearchContacts,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_search_contacts,
    paginated=True,
)


def _summary(invoice: Invoice) -> dict[str, Any]:
    contact = invoice.Contact
    return {
        "id": uuid(invoice.InvoiceID),
        "type": KINDS.get(invoice.Type or ""),
        "number": short(invoice.InvoiceNumber),
        "reference": short(invoice.Reference),
        "contact": {"id": uuid(contact.ContactID), "name": short(contact.Name)} if contact else None,
        "status": invoice.Status,
        "date": invoice_date(invoice.DateString, invoice.Date),
        "due_date": invoice_date(invoice.DueDateString, invoice.DueDate),
        "currency": invoice.CurrencyCode,
        "sub_total": money(invoice.SubTotal),
        "total_tax": money(invoice.TotalTax),
        "total": money(invoice.Total),
        "amount_due": money(invoice.AmountDue),
        "amount_paid": money(invoice.AmountPaid),
        "amount_credited": money(invoice.AmountCredited),
        "sent_to_contact": invoice.SentToContact,
        "updated": moment(invoice.UpdatedDateUTC),
    }


def _day(value: str) -> str:
    try:
        found = Date.fromisoformat(value)
    except ValueError:
        raise ValueError("must be a date such as 2026-10-01") from None
    if len(value) != 10 or not 1900 <= found.year <= 2200:
        raise ValueError("must be a date such as 2026-10-01, between the years 1900 and 2200")
    return value


Day = Annotated[str, Field(min_length=10, max_length=10, description="YYYY-MM-DD."), AfterValidator(_day)]
Status = Literal["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]


class SearchInvoices(OperationInput):
    organisation: OrganisationId | None = None
    type: Annotated[
        Literal["sales", "bill"] | None,
        Field(description="sales: invoices to customers; bill: bills from suppliers. Both when left out."),
    ] = None
    statuses: Annotated[list[Status] | None, Field(min_length=1, max_length=6)] = None
    contact: ContactId | None = None
    text: Annotated[SearchText | None, Field(description="Text in the invoice number or reference.")] = None
    date_from: Day | None = None
    date_to: Day | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


def _where(data: SearchInvoices) -> str | None:
    """Xero's filter, built from checked values only: a type from a fixed list and parsed dates."""
    terms = []
    if data.type is not None:
        terms.append(f'Type=="{TYPES[data.type]}"')
    for field, operator in ((data.date_from, ">="), (data.date_to, "<=")):
        if field is not None:
            day = Date.fromisoformat(field)
            terms.append(f"Date{operator}DateTime({day.year},{day.month:02d},{day.day:02d})")
    return " AND ".join(terms) or None


def _invoice_params(data: SearchInvoices, current: int) -> dict[str, Any]:
    params: dict[str, Any] = {
        "page": current,
        "pageSize": data.limit,
        "summaryOnly": "true",
        "order": "Date DESC",
    }
    if (where := _where(data)) is not None:
        params["where"] = where
    if data.statuses:
        params["Statuses"] = ",".join(dict.fromkeys(data.statuses))
    if data.contact is not None:
        params["ContactIDs"] = data.contact
    if data.text is not None:
        params["searchTerm"] = data.text
    return params


async def _prepare_search_invoices(binding: Binding, data: SearchInvoices) -> Prepared:
    if data.date_from and data.date_to and data.date_from > data.date_to:
        raise OperationError("INVALID_ARGUMENTS", "date_from must not be after date_to.")
    resource, tenant = await resolve_organisation(binding, data.organisation)

    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        current = page(data.cursor)
        try:
            found = await client.invoices(tenant, _invoice_params(data, current), data.limit)
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED" and data.cursor is not None:
                raise OperationError("INVALID_CURSOR", "This page token is invalid.") from None
            raise
        records = [ScopedRecord(resource, _summary(invoice)) for invoice in found.Invoices]
        return ProviderOutput(records, next_page(found.pagination, current, len(found.Invoices), data.limit))

    return Prepared([Need(resource, "read")], execute)


SEARCH_INVOICES = Operation(
    name="search_invoices",
    title="Search invoices and bills",
    description=(
        "Find sales invoices and bills in a Xero organisation by type, status, contact, date and text in the "
        "number or reference, newest first. Amounts are decimal strings in the invoice's currency. "
        + NEXT_PAGE
    ),
    input_model=SearchInvoices,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_search_invoices,
    paginated=True,
)


class GetInvoice(OperationInput):
    organisation: OrganisationId | None = None
    invoice: InvoiceId


def _lines(invoice: Invoice) -> list[dict[str, Any]]:
    lines = []
    for item in invoice.LineItems[:MAX_LINES]:
        description, cut = truncate(item.Description or None, MAX_DESCRIPTION)
        lines.append(
            {
                "description": description,
                "description_truncated": cut,
                "quantity": number(item.Quantity),
                "unit_amount": number(item.UnitAmount),
                "item_code": short(item.ItemCode),
                "account_code": short(item.AccountCode),
                "tax_type": short(item.TaxType),
                "tax_amount": money(item.TaxAmount),
                "line_amount": money(item.LineAmount),
                "discount_rate": number(item.DiscountRate),
                "discount_amount": money(item.DiscountAmount),
                "tracking": [{"category": short(t.Name), "option": short(t.Option)} for t in item.Tracking][
                    :MAX_LISTED
                ],
            }
        )
    return lines


async def _prepare_get_invoice(binding: Binding, data: GetInvoice) -> Prepared:
    resource, tenant = await resolve_organisation(binding, data.organisation)

    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        invoice = await client.invoice(tenant, data.invoice)
        record = _summary(invoice)
        record |= {
            "amounts_are": invoice.LineAmountTypes,
            "lines": _lines(invoice),
            "line_count": len(invoice.LineItems),
            "lines_truncated": len(invoice.LineItems) > MAX_LINES,
            "payments": [
                {
                    "date": invoice_date(None, p.Date),
                    "amount": money(p.Amount),
                    "reference": short(p.Reference),
                }
                for p in invoice.Payments[:MAX_PAYMENTS]
            ],
            "payment_count": len(invoice.Payments),
            "payments_truncated": len(invoice.Payments) > MAX_PAYMENTS,
            "has_attachments": invoice.HasAttachments,
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_INVOICE = Operation(
    name="get_invoice",
    title="Read an invoice or bill",
    description=(
        f"Read one sales invoice or bill in a Xero organisation: its totals, up to {MAX_LINES} lines and up to "
        f"{MAX_PAYMENTS} payments. Amounts are decimal strings in the invoice's currency."
    ),
    input_model=GetInvoice,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_get_invoice,
)


class ListAccounts(OperationInput):
    organisation: OrganisationId | None = None


async def _prepare_list_accounts(binding: Binding, data: ListAccounts) -> Prepared:
    resource, tenant = await resolve_organisation(binding, data.organisation)

    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        records = [
            ScopedRecord(
                resource,
                {
                    "code": short(account.Code),
                    "name": short(account.Name),
                    "type": account.Type,
                    "class": account.Class,
                    "tax_type": short(account.TaxType),
                    "description": short(account.Description, 300),
                },
            )
            for account in await client.accounts(tenant)
        ]
        return ProviderOutput(records)

    return Prepared([Need(resource, "read")], execute)


LIST_ACCOUNTS = Operation(
    name="list_accounts",
    title="List accounts",
    description=(
        "List the active accounts in a Xero organisation's chart of accounts, with their codes and default tax "
        "types, for the lines of draft invoices and bills. Bank account numbers are left out."
    ),
    input_model=ListAccounts,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_list_accounts,
)


class ListTaxRates(OperationInput):
    organisation: OrganisationId | None = None


async def _prepare_list_tax_rates(binding: Binding, data: ListTaxRates) -> Prepared:
    resource, tenant = await resolve_organisation(binding, data.organisation)

    async def execute() -> ProviderOutput:
        client: XeroClient = binding.client
        records = [
            ScopedRecord(
                resource,
                {
                    "tax_type": short(rate.TaxType),
                    "name": short(rate.Name),
                    "display_rate": number(rate.DisplayTaxRate),
                    "effective_rate": number(rate.EffectiveRate),
                    "for_sales": rate.CanApplyToRevenue,
                    "for_expenses": rate.CanApplyToExpenses,
                    "components": [
                        {
                            "name": short(c.Name),
                            "rate": number(c.Rate),
                            "compound": c.IsCompound,
                            "non_recoverable": c.IsNonRecoverable,
                        }
                        for c in rate.TaxComponents
                    ][:MAX_LISTED],
                },
            )
            for rate in await client.tax_rates(tenant)
        ]
        return ProviderOutput(records)

    return Prepared([Need(resource, "read")], execute)


LIST_TAX_RATES = Operation(
    name="list_tax_rates",
    title="List tax rates",
    description=(
        "List the active tax rates in a Xero organisation, as percentages, for the lines of draft invoices and "
        "bills. tax_type is the value lines take."
    ),
    input_model=ListTaxRates,
    needs=((ORGANISATION, "read"),),
    prepare=_prepare_list_tax_rates,
)
