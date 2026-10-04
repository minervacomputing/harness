"""Xero's Accounting API, and the identity endpoints that name the user and the organisations they connected.

Every accounting request names its organisation in the `xero-tenant-id` header, always one Minerva has
already authorized. Models mirror Xero's JSON, whose keys are in PascalCase; fields Xero leaves out stay None,
never zero or false. Reads are bounded. Xero's validation messages are passed on (shortened, one line each):
they describe the organisation's own data, in an organisation the call was allowed to use. Its other error
texts are not.
"""

import json
import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OperationError
from connectors.http import Effect, ProviderHTTP
from connectors.text import truncate

API_URL = "https://api.xero.com"
ACCOUNTING = "/api.xro/2.0"
USERINFO_URL = "https://identity.xero.com/connect/userinfo"
MAX_RESPONSE = 4 * 1024 * 1024
MAX_ORGANISATIONS = 100
MAX_ACCOUNTS = 2000
MAX_TAX_RATES = 500
MAX_MESSAGES = 5
MAX_MESSAGE = 300
MAX_PAGE = 100_000
# Xero's ids are UUIDs; Minerva keeps them in lower case.
UUID = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
ZERO_UUID = "00000000-0000-0000-0000-000000000000"
_PAGE = re.compile(r"\A[1-9][0-9]{0,5}\Z")
# Xero's JSON dates: /Date(1518685950940+0000)/, milliseconds since the epoch and an offset.
_JSON_DATE = re.compile(r"\A/Date\((-?\d{1,15})([+-]\d{4})?\)/\Z")
_DATE_STRING = re.compile(r"\A(\d{4}-\d{2}-\d{2})(T[0-9:.]+)?\Z")


def uuid(value: str | None) -> str | None:
    """The id in Minerva's spelling, or None when it is not a UUID."""
    lowered = (value or "").lower()
    return lowered if UUID.match(lowered) and lowered != ZERO_UUID else None


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class UserInfo(Model):
    sub: str
    name: str | None = None
    given_name: str | None = None
    family_name: str | None = None
    email: str | None = None


class Connection(Model):
    tenantId: str
    tenantType: str | None = None
    tenantName: str | None = None


class Pagination(Model):
    page: int | None = None
    pageSize: int | None = None
    pageCount: int | None = None
    itemCount: int | None = None


class Message(Model):
    Message: str | None = None


class Address(Model):
    AddressType: str | None = None
    AddressLine1: str | None = None
    AddressLine2: str | None = None
    AddressLine3: str | None = None
    AddressLine4: str | None = None
    City: str | None = None
    Region: str | None = None
    PostalCode: str | None = None
    Country: str | None = None


class Phone(Model):
    PhoneType: str | None = None
    PhoneNumber: str | None = None
    PhoneAreaCode: str | None = None
    PhoneCountryCode: str | None = None


class Person(Model):
    FirstName: str | None = None
    LastName: str | None = None
    EmailAddress: str | None = None


class Outstanding(Model):
    Outstanding: Decimal | None = None
    Overdue: Decimal | None = None


class BalanceSet(Model):
    AccountsReceivable: Outstanding | None = None
    AccountsPayable: Outstanding | None = None


class Contact(Model):
    ContactID: str
    Name: str | None = None
    FirstName: str | None = None
    LastName: str | None = None
    EmailAddress: str | None = None
    ContactNumber: str | None = None
    AccountNumber: str | None = None
    ContactStatus: str | None = None
    IsCustomer: bool | None = None
    IsSupplier: bool | None = None
    DefaultCurrency: str | None = None
    TaxNumber: str | None = None
    Addresses: list[Address] = []
    Phones: list[Phone] = []
    ContactPersons: list[Person] = []
    Balances: BalanceSet | None = None


class Contacts(Model):
    pagination: Pagination | None = None
    Contacts: list[Contact] = []


class ContactRef(Model):
    ContactID: str | None = None
    Name: str | None = None


class TrackingRef(Model):
    Name: str | None = None
    Option: str | None = None


class LineItem(Model):
    Description: str | None = None
    Quantity: Decimal | None = None
    UnitAmount: Decimal | None = None
    ItemCode: str | None = None
    AccountCode: str | None = None
    TaxType: str | None = None
    TaxAmount: Decimal | None = None
    LineAmount: Decimal | None = None
    DiscountRate: Decimal | None = None
    DiscountAmount: Decimal | None = None
    Tracking: list[TrackingRef] = []


class Payment(Model):
    Date: str | None = None
    Amount: Decimal | None = None
    Reference: str | None = None


class Invoice(Model):
    InvoiceID: str | None = None
    Type: str | None = None
    InvoiceNumber: str | None = None
    Reference: str | None = None
    Contact: ContactRef | None = None
    Status: str | None = None
    Date: str | None = None
    DateString: str | None = None
    DueDate: str | None = None
    DueDateString: str | None = None
    CurrencyCode: str | None = None
    LineAmountTypes: str | None = None
    SubTotal: Decimal | None = None
    TotalTax: Decimal | None = None
    Total: Decimal | None = None
    AmountDue: Decimal | None = None
    AmountPaid: Decimal | None = None
    AmountCredited: Decimal | None = None
    SentToContact: bool | None = None
    HasAttachments: bool | None = None
    UpdatedDateUTC: str | None = None
    LineItems: list[LineItem] = []
    Payments: list[Payment] = []
    HasErrors: bool | None = None
    ValidationErrors: list[Message] = []
    Warnings: list[Message] = []


class Invoices(Model):
    pagination: Pagination | None = None
    Invoices: list[Invoice] = []


class Account(Model):
    Code: str | None = None
    Name: str | None = None
    Type: str | None = None
    Class: str | None = None
    Status: str | None = None
    TaxType: str | None = None
    Description: str | None = None


class Accounts(Model):
    Accounts: list[Account] = []


class TaxComponent(Model):
    Name: str | None = None
    Rate: Decimal | None = None
    IsCompound: bool | None = None
    IsNonRecoverable: bool | None = None


class TaxRate(Model):
    Name: str | None = None
    TaxType: str | None = None
    Status: str | None = None
    DisplayTaxRate: Decimal | None = None
    EffectiveRate: Decimal | None = None
    CanApplyToRevenue: bool | None = None
    CanApplyToExpenses: bool | None = None
    TaxComponents: list[TaxComponent] = []


class TaxRates(Model):
    TaxRates: list[TaxRate] = []


class Element(Model):
    ValidationErrors: list[Message] = []


class Failure(Model):
    Type: str | None = None
    Elements: list[Element] = []
    ValidationErrors: list[Message] = []


def messages(found: list[Message]) -> list[str]:
    """Xero's validation messages, shortened, one line each."""
    shown = []
    for message in found:
        text = " ".join((message.Message or "").split())
        if text and text not in shown:
            shown.append(truncate(text, MAX_MESSAGE)[0] or "")
    return shown[:MAX_MESSAGES]


def rejected(found: list[Message]) -> OperationError:
    texts = messages(found)
    detail = f": {'; '.join(texts)}" if texts else "."
    return OperationError("PROVIDER_REJECTED", f"Xero rejected this{detail}")


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    if response.status_code == 400:
        try:
            failure = Failure.model_validate_json(response.content)
        except ValueError:
            return None
        if failure.Type != "ValidationException":
            return None
        found = failure.ValidationErrors + [m for e in failure.Elements for m in e.ValidationErrors]
        return rejected(found)
    if response.status_code == 403:
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "Xero refused this request. The connection may lack a permission (reconnect to give it), the user's "
            "role in this organisation may not allow it, or the organisation was disconnected from Minerva.",
        )
    return None


def judge(response: httpx.Response) -> Effect | None:
    """A 200 that holds only invoices Xero refused created nothing. Minerva asks Xero to answer refusals with
    400 (`summarizeErrors=true`); this covers an answer that ignores that."""
    if not response.is_success:
        return None
    try:
        body = json.loads(response.content)
    except ValueError:
        return None
    found = body.get("Invoices") if isinstance(body, dict) else None
    if not isinstance(found, list) or not found:
        return None
    if all(
        isinstance(item, dict) and item.get("HasErrors") is True and uuid(item.get("InvoiceID")) is None
        for item in found
    ):
        return Effect.NOT_APPLIED
    return None


def page(cursor: str | None) -> int:
    """The page a cursor names; the first page without one."""
    if cursor is None:
        return 1
    if not _PAGE.match(cursor) or int(cursor) > MAX_PAGE:
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return int(cursor)


def next_page(found: Pagination | None, current: int, count: int, size: int) -> str | None:
    """The next page's cursor. Xero says how many pages there are; without that, a full page may have more."""
    known = found.pageCount if found is not None else None
    more = known > current if known is not None else count >= size
    return str(current + 1) if more and current < MAX_PAGE else None


def date(value: str | None) -> str | None:
    """A date Xero gave as a string (2026-10-01T00:00:00), as YYYY-MM-DD."""
    match = _DATE_STRING.match(value or "")
    return match.group(1) if match else None


def moment(value: str | None) -> str | None:
    """A time in Xero's JSON date form, in ISO 8601 UTC."""
    match = _JSON_DATE.match(value or "")
    if match is None:
        return None
    try:
        found = datetime.fromtimestamp(int(match.group(1)) / 1000, UTC)
    except OverflowError, OSError, ValueError:
        return None
    return found.isoformat(timespec="seconds").replace("+00:00", "Z")


def invoice_date(text: str | None, raw: str | None) -> str | None:
    """An invoice's date or due date: the string form, else the JSON date's day."""
    return date(text) or (moment(raw) or "")[:10] or None


class XeroClient:
    def __init__(self, token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self._organisations: list[Connection] | None = None
        self._http = ProviderHTTP(
            "Xero",
            base_url=API_URL,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            transport=transport,
            classify=classify,
            judge=judge,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def _read[M: BaseModel](
        self, model: type[M], url: str, *, tenant: str | None = None, params: dict[str, Any] | None = None
    ) -> M:
        headers = {"xero-tenant-id": tenant} if tenant is not None else None
        response = await self._http.bounded(
            url,
            limit=MAX_RESPONSE,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Xero's response was too large to read."),
            headers=headers,
            params=params,
        )
        try:
            return model.model_validate_json(response.content)
        except ValueError as error:
            raise self.unexpected() from error

    async def me(self) -> UserInfo:
        return await self._read(UserInfo, USERINFO_URL)

    async def organisations(self) -> list[Connection]:
        """The organisations this connection reaches, once each, ordered by id. Practice Manager and other
        tenants that are not organisations are left out."""
        if self._organisations is None:
            response = await self._http.bounded(
                "/connections",
                limit=MAX_RESPONSE,
                too_large=OperationError("RESPONSE_TOO_LARGE", "Xero's response was too large to read."),
            )
            try:
                body = json.loads(response.content)
                found = [Connection.model_validate(item) for item in body] if isinstance(body, list) else None
            except ValueError as error:
                raise self.unexpected() from error
            if found is None:
                raise self.unexpected()
            kept: dict[str, Connection] = {}
            for connection in found:
                tenant = uuid(connection.tenantId)
                if tenant is not None and connection.tenantType == "ORGANISATION" and tenant not in kept:
                    kept[tenant] = connection.model_copy(update={"tenantId": tenant})
            if len(kept) > MAX_ORGANISATIONS:
                raise OperationError(
                    "PROVIDER_LIMIT", "This connection reaches more Xero organisations than Minerva reads."
                )
            self._organisations = [kept[key] for key in sorted(kept)]
        return self._organisations

    async def contacts(
        self, tenant: str, *, page: int, size: int, text: str | None, archived: bool
    ) -> Contacts:
        params: dict[str, Any] = {"page": page, "pageSize": size, "order": "Name ASC"}
        if text is not None:
            params["searchTerm"] = text
        if archived:
            params["includeArchived"] = "true"
        found = await self._read(Contacts, f"{ACCOUNTING}/Contacts", tenant=tenant, params=params)
        if len(found.Contacts) > size or any(uuid(c.ContactID) is None for c in found.Contacts):
            raise self.unexpected()
        return found

    async def contact(self, tenant: str, contact_id: str) -> Contact:
        found = await self._read(Contacts, f"{ACCOUNTING}/Contacts/{contact_id}", tenant=tenant)
        if len(found.Contacts) != 1 or uuid(found.Contacts[0].ContactID) != contact_id:
            raise self.unexpected()
        return found.Contacts[0]

    async def invoices(self, tenant: str, params: dict[str, Any], size: int) -> Invoices:
        found = await self._read(Invoices, f"{ACCOUNTING}/Invoices", tenant=tenant, params=params)
        if len(found.Invoices) > size or any(uuid(i.InvoiceID) is None for i in found.Invoices):
            raise self.unexpected()
        return found

    async def invoice(self, tenant: str, invoice_id: str) -> Invoice:
        found = await self._read(
            Invoices, f"{ACCOUNTING}/Invoices/{invoice_id}", tenant=tenant, params={"unitdp": 4}
        )
        if len(found.Invoices) != 1 or uuid(found.Invoices[0].InvoiceID) != invoice_id:
            raise self.unexpected()
        return found.Invoices[0]

    async def accounts(self, tenant: str) -> list[Account]:
        found = await self._read(
            Accounts, f"{ACCOUNTING}/Accounts", tenant=tenant, params={"where": 'Status=="ACTIVE"'}
        )
        if len(found.Accounts) > MAX_ACCOUNTS:
            raise OperationError("PROVIDER_LIMIT", "This organisation has more accounts than Minerva reads.")
        return [account for account in found.Accounts if account.Status in (None, "ACTIVE")]

    async def tax_rates(self, tenant: str) -> list[TaxRate]:
        found = await self._read(TaxRates, f"{ACCOUNTING}/TaxRates", tenant=tenant)
        if len(found.TaxRates) > MAX_TAX_RATES:
            raise OperationError("PROVIDER_LIMIT", "This organisation has more tax rates than Minerva reads.")
        return [rate for rate in found.TaxRates if rate.Status in (None, "ACTIVE")]

    async def create_invoice(self, tenant: str, invoice: dict[str, Any]) -> Invoice:
        """The one write: PUT creates and never updates (POST would update an invoice it matches). Refusals are
        asked for as 400s; a 200 that still carries them is refused here too."""
        found = await self._http.parsed(
            Invoices,
            "PUT",
            f"{ACCOUNTING}/Invoices",
            headers={"xero-tenant-id": tenant},
            params={"summarizeErrors": "true", "unitdp": 4},
            json={"Invoices": [invoice]},
        )
        if len(found.Invoices) != 1:
            raise self.unexpected()
        created = found.Invoices[0]
        if created.HasErrors:
            raise rejected(created.ValidationErrors)
        return created
