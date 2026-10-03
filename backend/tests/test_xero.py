"""Xero connector against an in-memory Xero API, and runs through the executor."""

import json

import httpx
import pytest
from connector_runs import ceiling, refusal

from connectors import registry
from connectors.base import OperationError
from connectors.xero import client as client_module
from connectors.xero.client import XeroClient
from connectors.xero.connector import XeroConnector
from connectors.xero.writes import DraftBill, DraftInvoice, body
from permissions.models import Grant

SECRET = "SECRET acquisition"
ACME = "0a1b2c3d-0000-4000-8000-000000000001"
BETA = "0a1b2c3d-0000-4000-8000-000000000002"
UNREACHED = "0a1b2c3d-0000-4000-8000-000000000003"
CUSTOMER = "c0000000-0000-4000-8000-000000000001"
SUPPLIER = "c0000000-0000-4000-8000-000000000002"
ARCHIVED = "c0000000-0000-4000-8000-000000000003"
INVOICE = "10000000-0000-4000-8000-000000000001"
SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "accounting.invoices.read",
    "accounting.contacts.read",
    "accounting.settings.read",
    "accounting.invoices",
]


def _contact(contact_id: str, name: str, status: str = "ACTIVE", **fields) -> dict:
    return {
        "ContactID": contact_id.upper(),
        "Name": name,
        "ContactStatus": status,
        "EmailAddress": f"{name.split()[0].lower()}@example.com",
        "BankAccountDetails": "01-0123-0123456-00",
        "Addresses": [],
        "Phones": [],
        "ContactPersons": [],
    } | fields


def _invoice(invoice_id: str, kind: str, contact: dict, **fields) -> dict:
    return {
        "InvoiceID": invoice_id,
        "Type": kind,
        "InvoiceNumber": "INV-0001",
        "Reference": "PO 7",
        "Contact": {"ContactID": contact["ContactID"], "Name": contact["Name"]},
        "Status": "AUTHORISED",
        "Date": "/Date(1788220800000+0000)/",
        "DateString": "2026-09-01T00:00:00",
        "DueDate": "/Date(1789430400000+0000)/",
        "DueDateString": "2026-09-15T00:00:00",
        "CurrencyCode": "EUR",
        "LineAmountTypes": "Exclusive",
        "SubTotal": 100.0,
        "TotalTax": 20.0,
        "Total": 120.0,
        "AmountDue": 70.0,
        "AmountPaid": 50.0,
        "AmountCredited": 0,
        "SentToContact": True,
        "HasAttachments": False,
        "UpdatedDateUTC": "/Date(1788307200000+0000)/",
    } | fields


class FakeXero:
    """Xero's identity and Accounting APIs, served through httpx.MockTransport.

    Ada connected Acme and Beta (whose name is secret); `/connections` also lists a Practice Manager tenant
    and Acme a second time, in capitals. Acme has a customer, a supplier and an archived contact.
    """

    def __init__(self) -> None:
        self.me = {
            "sub": "u-991",
            "name": "Ada Lovelace",
            "given_name": "Ada",
            "family_name": "Lovelace",
            "email": "ada@example.com",
        }
        self.connections = [
            {"id": "c1", "tenantId": BETA, "tenantType": "ORGANISATION", "tenantName": SECRET},
            {"id": "c2", "tenantId": ACME, "tenantType": "ORGANISATION", "tenantName": "Acme  Ltd"},
            {"id": "c3", "tenantId": ACME.upper(), "tenantType": "ORGANISATION", "tenantName": "Acme"},
            {"id": "c4", "tenantId": UNREACHED, "tenantType": "PRACTICEMANAGER", "tenantName": "Practice"},
            {"id": "c5", "tenantId": "not-a-uuid", "tenantType": "ORGANISATION", "tenantName": "Odd"},
        ]
        customer = _contact(
            CUSTOMER,
            "Carol Customer",
            IsCustomer=True,
            Addresses=[
                {"AddressType": "POBOX", "AddressLine1": "PO Box 1", "City": "Zurich", "Country": "CH"},
                {"AddressType": "STREET"},
            ],
            Phones=[
                {
                    "PhoneType": "DEFAULT",
                    "PhoneNumber": "123 45 67",
                    "PhoneAreaCode": "44",
                    "PhoneCountryCode": "41",
                },
                {"PhoneType": "FAX"},
            ],
            ContactPersons=[{"FirstName": "Cy", "LastName": "C", "EmailAddress": "cy@example.com"}],
            Balances={"AccountsReceivable": {"Outstanding": 70.0, "Overdue": 0}},
        )
        self.contacts: dict[str, list[dict]] = {
            ACME: [
                customer,
                _contact(SUPPLIER, "Sam Supplier", IsSupplier=True),
                _contact(ARCHIVED, "Old Customer", "ARCHIVED"),
            ],
            BETA: [_contact(CUSTOMER, SECRET)],
        }
        self.invoices: dict[str, list[dict]] = {ACME: [_invoice(INVOICE, "ACCREC", customer)], BETA: []}
        self.accounts = [
            {
                "Code": "200",
                "Name": "Sales",
                "Type": "REVENUE",
                "Class": "REVENUE",
                "Status": "ACTIVE",
                "TaxType": "OUTPUT2",
                "Description": "Income from sales",
            },
            {
                "Code": "090",
                "Name": "Bank",
                "Type": "BANK",
                "Class": "ASSET",
                "Status": "ACTIVE",
                "BankAccountNumber": "01-0123-0123456-00",
            },
            {"Code": "999", "Name": "Old", "Type": "EXPENSE", "Status": "ARCHIVED"},
        ]
        self.tax_rates = [
            {
                "Name": "20% (VAT on Income)",
                "TaxType": "OUTPUT2",
                "Status": "ACTIVE",
                "DisplayTaxRate": 20.0,
                "EffectiveRate": 20.0,
                "CanApplyToRevenue": True,
                "CanApplyToExpenses": False,
                "TaxComponents": [
                    {"Name": "VAT", "Rate": 20.0, "IsCompound": False, "IsNonRecoverable": False}
                ],
            },
            {"Name": "Old", "TaxType": "OLD", "Status": "DELETED"},
        ]
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict, dict]] = []
        self.hook = None

    @staticmethod
    def _error(status: int, body: dict | None = None) -> httpx.Response:
        return httpx.Response(status, json=body or {"Title": SECRET, "Detail": SECRET})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["Authorization"] == "Bearer token"
        if request.url.host == "identity.xero.com":
            assert request.url.path == "/connect/userinfo"
            return httpx.Response(200, json=self.me)
        assert request.url.host == "api.xero.com"
        path = request.url.path
        if path == "/connections":
            assert "xero-tenant-id" not in request.headers
            return httpx.Response(200, json=self.connections)
        tenant = request.headers["xero-tenant-id"]
        assert tenant in (ACME, BETA)
        body = json.loads(request.content) if request.content else None
        params = dict(request.url.params)
        if self.hook is not None and (response := self.hook(request.method, path, params, body)) is not None:
            return response
        parts = path.removeprefix("/api.xro/2.0/").split("/")
        match request.method, parts:
            case "GET", ["Contacts"]:
                found = [
                    c
                    for c in self.contacts[tenant]
                    if params.get("includeArchived") or c["ContactStatus"] == "ACTIVE"
                ]
                return self._page("Contacts", found, params)
            case "GET", ["Contacts", contact_id]:
                found = [c for c in self.contacts[tenant] if c["ContactID"].lower() == contact_id]
                return httpx.Response(200, json={"Contacts": found}) if found else self._error(404)
            case "GET", ["Invoices"]:
                return self._page("Invoices", self.invoices[tenant], params)
            case "GET", ["Invoices", invoice_id]:
                found = [i for i in self.invoices[tenant] if i["InvoiceID"] == invoice_id]
                return httpx.Response(200, json={"Invoices": found}) if found else self._error(404)
            case "GET", ["Accounts"]:
                return httpx.Response(200, json={"Accounts": self.accounts})
            case "GET", ["TaxRates"]:
                return httpx.Response(200, json={"TaxRates": self.tax_rates})
            case "PUT", ["Invoices"]:
                self.writes.append((tenant, params, body))
                return httpx.Response(200, json={"Invoices": [self._created(tenant, body["Invoices"][0])]})
        raise AssertionError(path)

    @staticmethod
    def _page(key: str, items: list[dict], params: dict) -> httpx.Response:
        current, size = int(params.get("page", 1)), int(params.get("pageSize", 100))
        count = -(-len(items) // size)
        pagination = {"page": current, "pageSize": size, "pageCount": count, "itemCount": len(items)}
        return httpx.Response(
            200, json={"pagination": pagination, key: items[(current - 1) * size : current * size]}
        )

    def _created(self, tenant: str, sent: dict) -> dict:
        contact = next(
            c for c in self.contacts[tenant] if c["ContactID"].lower() == sent["Contact"]["ContactID"]
        )
        total = sum(line["Quantity"] * line["UnitAmount"] for line in sent["LineItems"])
        return _invoice(
            f"20000000-0000-4000-8000-{len(self.writes):012d}",
            sent["Type"],
            contact,
            Status=sent["Status"],
            InvoiceNumber=sent.get("InvoiceNumber", "INV-0002"),
            Reference=sent.get("Reference"),
            SubTotal=total,
            TotalTax=0,
            Total=total,
            AmountDue=total,
            AmountPaid=0,
            SentToContact=False,
            Warnings=[{"Message": "Account code '200' has been archived"}],
        )

    def accounting(self, tenant: str | None = None) -> list[httpx.Request]:
        return [
            r
            for r in self.requests
            if r.url.path.startswith("/api.xro/") and tenant in (None, r.headers["xero-tenant-id"])
        ]

    def client(self) -> XeroClient:
        return XeroClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def xero() -> FakeXero:
    return FakeXero()


@pytest.fixture
def start(connector_run, xero, monkeypatch):
    """Starts a run with the user's Xero connection, holding `grants` ({organisation: actions})."""
    monkeypatch.setattr(XeroConnector, "client", lambda self, token: xero.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = SCOPES):
        organisations = {("organisation", tenant): actions for tenant, actions in grants.items()}
        return connector_run(
            "xero",
            organisations,
            scopes=scopes,
            label="Ada Lovelace (ada@example.com)",
            external_account_id="u-991",
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _only_acme(xero: FakeXero) -> None:
    xero.connections = [c for c in xero.connections if c["tenantId"] == ACME]


# Connecting and discovery


async def test_the_account_is_the_xero_user(xero):
    connector = XeroConnector()
    account = await connector.account(xero.client())
    assert (account.id, account.label) == ("u-991", "Ada Lovelace (ada@example.com)")
    xero.me = {"sub": "u-991", "given_name": "Ada"}
    assert (await connector.account(xero.client())).label == "Ada"
    xero.me = {"name": "Ada"}
    with pytest.raises(OperationError) as caught:
        await connector.account(xero.client())
    assert caught.value.code == "PROVIDER_FAILED"
    xero.me = {"sub": "u-991"}
    xero.connections = [c for c in xero.connections if c["tenantType"] != "ORGANISATION"]
    with pytest.raises(OperationError) as caught:
        await connector.account(xero.client())
    assert caught.value.code == "UNSUPPORTED_ACCOUNT"


async def test_organisations_are_the_connected_tenants(xero):
    connector = XeroConnector()
    client = xero.client()
    page = await connector.discover(client, "organisation", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [(ACME, "Acme Ltd"), (BETA, SECRET)]
    assert page.next_cursor is None
    page = await connector.discover(client, "organisation", query="acme", cursor=None)
    assert [i.id for i in page.items] == [ACME]
    with pytest.raises(OperationError) as caught:
        await connector.discover(client, "organisation", query=None, cursor="2")
    assert caught.value.code == "INVALID_CURSOR"
    assert await connector.describe(client, "organisation", [ACME, UNREACHED, "x"]) == {ACME: "Acme Ltd"}
    # Read once per client.
    assert len([r for r in xero.requests if r.url.path == "/connections"]) == 1

    xero.connections = [
        {"tenantId": f"0a1b2c3d-0000-4000-8000-{n:012d}", "tenantType": "ORGANISATION"} for n in range(101)
    ]
    with pytest.raises(OperationError) as caught:
        await xero.client().organisations()
    assert caught.value.code == "PROVIDER_LIMIT"
    xero.connections = [{"tenantId": ACME, "tenantType": "ORGANISATION"}]
    assert (await connector.discover(xero.client(), "organisation", query=None, cursor=None)).items[
        0
    ].name == ("Organisation 0a1b2c3d")


def test_reading_and_drafting_ask_for_separate_scopes():
    connector = registry.get("xero")
    assert connector.auth.pkce is True and connector.auth.client_auth == "basic"
    assert "accounting.invoices" not in connector.auth.scopes
    assert {"accounting.invoices.read", "accounting.contacts.read", "offline_access"} <= set(
        connector.auth.scopes
    )
    consent = {op.name: op.consent for op in connector.operations}
    assert (
        consent["create_draft_invoice"]
        == consent["create_draft_bill"]
        == (frozenset({"accounting.invoices"}),)
    )
    assert all(not op.consent for op in connector.operations if not op.mutates)


def test_errors_pass_on_validation_messages_only():
    def classified(status: int, content: dict | bytes) -> OperationError | None:
        raw = content if isinstance(content, bytes) else json.dumps(content).encode()
        return client_module.classify("Xero", httpx.Response(status, content=raw))

    found = classified(
        400,
        {
            "ErrorNumber": 10,
            "Type": "ValidationException",
            "Message": SECRET,
            "Elements": [
                {"ValidationErrors": [{"Message": "Account code '999' is not a valid code."}]},
                {
                    "ValidationErrors": [
                        {"Message": "Account code '999' is not a valid code."},
                        {"Message": "x\ny"},
                    ]
                },
            ],
        },
    )
    assert (found.code, found.message) == (
        "PROVIDER_REJECTED",
        "Xero rejected this: Account code '999' is not a valid code.; x y",
    )
    long = classified(
        400,
        {"Type": "ValidationException", "ValidationErrors": [{"Message": str(n) * 400} for n in range(9)]},
    )
    assert long.message.count(";") == 4 and SECRET not in long.message
    assert classified(400, {"Type": "ValidationException"}).message == "Xero rejected this."
    assert classified(400, {"Type": "QueryParseException", "Message": SECRET}) is None
    assert classified(400, b"<html>") is None
    forbidden = classified(403, {"Detail": SECRET})
    assert forbidden.code == "PROVIDER_FORBIDDEN" and SECRET not in forbidden.message
    assert classified(500, {"Detail": SECRET}) is None


def test_a_success_holding_only_refusals_created_nothing():
    def judged(status: int, content: object):
        return client_module.judge(httpx.Response(status, content=json.dumps(content).encode()))

    refused = {"InvoiceID": client_module.ZERO_UUID, "HasErrors": True, "ValidationErrors": []}
    assert judged(200, {"Invoices": [refused]}) == client_module.Effect.NOT_APPLIED
    assert judged(200, {"Invoices": [refused | {"InvoiceID": INVOICE}]}) is None
    assert judged(200, {"Invoices": [{"InvoiceID": INVOICE}]}) is None
    assert judged(200, {"Invoices": []}) is None
    assert judged(200, [refused]) is None
    assert judged(400, {"Invoices": [refused]}) is None


def test_pages_and_dates():
    page, next_page = client_module.page, client_module.next_page
    assert page(None) == 1 and page("7") == 7
    for cursor in ("0", "01", "-1", "x", "100001", "1" * 7):
        with pytest.raises(OperationError) as caught:
            page(cursor)
        assert caught.value.code == "INVALID_CURSOR"
    known = client_module.Pagination(pageCount=3)
    assert next_page(known, 2, 10, 10) == "3" and next_page(known, 3, 10, 10) is None
    assert next_page(None, 1, 10, 10) == "2" and next_page(None, 1, 9, 10) is None
    assert next_page(None, client_module.MAX_PAGE, 10, 10) is None

    assert client_module.moment("/Date(1788220800000+0000)/") == "2026-09-01T00:00:00Z"
    assert client_module.moment("/Date(99999999999999999)/") is None
    assert client_module.moment("2026-09-01") is None
    assert client_module.invoice_date("2026-09-02T00:00:00", "/Date(1788220800000+0000)/") == "2026-09-02"
    assert client_module.invoice_date(None, "/Date(1788220800000)/") == "2026-09-01"
    assert client_module.invoice_date("soon", None) is None


# Organisations and grants


@pytest.mark.django_db(transaction=True)
async def test_only_granted_organisations_are_listed_or_read(start, xero):
    executor = await start({ACME: ("read",)})
    outcome = await executor.invoke("xero_list_organisations", {})
    assert _items(outcome) == [{"id": ACME, "name": "Acme Ltd"}]
    assert SECRET not in json.dumps(outcome.result)

    # Beta is reached but not granted; another organisation is not reached at all. Neither is read.
    for organisation in (BETA, UNREACHED, UNREACHED.upper()):
        for tool, args in (
            ("xero_search_contacts", {}),
            ("xero_search_invoices", {}),
            ("xero_get_invoice", {"invoice": INVOICE}),
            ("xero_list_accounts", {}),
            ("xero_list_tax_rates", {}),
        ):
            assert await refusal(executor, tool, args | {"organisation": organisation}) == "POLICY_DENIED"
    assert xero.accounting() == []

    # Two organisations are reached: a call names one.
    assert await refusal(executor, "xero_search_contacts", {}) == "INVALID_ARGUMENTS"
    outcome = await executor.invoke("xero_search_contacts", {"organisation": ACME.upper()})
    assert [c["name"] for c in _items(outcome)] == ["Carol Customer", "Sam Supplier"]
    assert {r.headers["xero-tenant-id"] for r in xero.accounting()} == {ACME}


@pytest.mark.django_db(transaction=True)
async def test_one_organisation_is_the_default(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read",)})
    outcome = await executor.invoke("xero_list_accounts", {})
    assert [a["code"] for a in _items(outcome)] == ["200", "090"]


@pytest.mark.django_db(transaction=True)
async def test_all_organisations_respects_the_ceiling(start, xero):
    await start({})
    await ceiling("xero", "organisation", BETA, Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("xero_list_organisations", {})
    assert [o["id"] for o in _items(outcome)] == [ACME]
    assert await refusal(executor, "xero_list_tax_rates", {"organisation": BETA}) == "POLICY_DENIED"
    assert xero.accounting(BETA) == []
    await executor.invoke("xero_list_tax_rates", {"organisation": ACME})


# Reading


@pytest.mark.django_db(transaction=True)
async def test_contacts_are_searched_and_shown_without_bank_details(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read",)})
    outcome = await executor.invoke("xero_search_contacts", {"text": "carol", "limit": 5})
    params = dict(xero.accounting()[-1].url.params)
    assert params == {"page": "1", "pageSize": "5", "order": "Name ASC", "searchTerm": "carol"}
    assert _items(outcome)[0] == {
        "id": CUSTOMER,
        "name": "Carol Customer",
        "first_name": None,
        "last_name": None,
        "email": "carol@example.com",
        "contact_number": None,
        "account_number": None,
        "status": "ACTIVE",
        "is_customer": True,
        "is_supplier": None,
        "default_currency": None,
        "tax_number": None,
        "addresses": [
            {
                "type": "POBOX",
                "lines": ["PO Box 1"],
                "city": "Zurich",
                "region": None,
                "postal_code": None,
                "country": "CH",
            }
        ],
        "phones": ["41 44 123 45 67"],
        "people": [{"name": "Cy C", "email": "cy@example.com"}],
        "balances": {"receivable": {"outstanding": "70.00", "overdue": "0.00"}, "payable": None},
    }
    assert "0123456" not in json.dumps(outcome.result)

    first = await executor.invoke("xero_search_contacts", {"include_archived": True, "limit": 2})
    assert [c["name"] for c in _items(first)] == ["Carol Customer", "Sam Supplier"]
    assert dict(xero.accounting()[-1].url.params)["includeArchived"] == "true"
    args = {"include_archived": True, "limit": 2, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("xero_search_contacts", args)
    assert [c["name"] for c in _items(second)] == ["Old Customer"] and "next_cursor" not in second.result
    assert dict(xero.accounting()[-1].url.params)["page"] == "2"
    # The cursor is bound to the other arguments.
    assert await refusal(executor, "xero_search_contacts", args | {"limit": 3}) == "INVALID_CURSOR"


@pytest.mark.django_db(transaction=True)
async def test_invoices_are_searched_with_a_filter_built_from_checked_values(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read",)})
    args = {
        "type": "sales",
        "statuses": ["AUTHORISED", "PAID", "AUTHORISED"],
        "contact": CUSTOMER.upper(),
        "text": "INV-0001",
        "date_from": "2026-01-01",
        "date_to": "2026-12-31",
        "limit": 10,
    }
    outcome = await executor.invoke("xero_search_invoices", args)
    assert dict(xero.accounting()[-1].url.params) == {
        "page": "1",
        "pageSize": "10",
        "summaryOnly": "true",
        "order": "Date DESC",
        "where": 'Type=="ACCREC" AND Date>=DateTime(2026,01,01) AND Date<=DateTime(2026,12,31)',
        "Statuses": "AUTHORISED,PAID",
        "ContactIDs": CUSTOMER,
        "searchTerm": "INV-0001",
    }
    assert _items(outcome) == [
        {
            "id": INVOICE,
            "type": "sales",
            "number": "INV-0001",
            "reference": "PO 7",
            "contact": {"id": CUSTOMER, "name": "Carol Customer"},
            "status": "AUTHORISED",
            "date": "2026-09-01",
            "due_date": "2026-09-15",
            "currency": "EUR",
            "sub_total": "100.00",
            "total_tax": "20.00",
            "total": "120.00",
            "amount_due": "70.00",
            "amount_paid": "50.00",
            "amount_credited": "0.00",
            "sent_to_contact": True,
            "updated": "2026-09-02T00:00:00Z",
        }
    ]
    for bad in (
        {"type": "credit"},
        {"statuses": ["SENT"]},
        {"date_from": "2026-02-30"},
        {"date_from": "26-01-01"},
        {"date_from": "1800-01-01"},
        {"text": "INV\n1"},
        {"contact": "Carol"},
        {"where": "Total>0"},
    ):
        assert await refusal(executor, "xero_search_invoices", bad) == "INVALID_ARGUMENTS", bad
    dates = {"date_from": "2026-02-01", "date_to": "2026-01-01"}
    assert await refusal(executor, "xero_search_invoices", dates) == "INVALID_ARGUMENTS"
    assert len(xero.accounting()) == 1


@pytest.mark.django_db(transaction=True)
async def test_invoice_pages_follow_xeros_page_count(start, xero):
    _only_acme(xero)
    contact = xero.contacts[ACME][0]
    xero.invoices[ACME] = [
        _invoice(f"10000000-0000-4000-8000-{n:012d}", "ACCREC", contact) for n in range(1, 4)
    ]
    executor = await start({ACME: ("read",)})
    first = await executor.invoke("xero_search_invoices", {"limit": 2})
    assert len(_items(first)) == 2
    args = {"limit": 2, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("xero_search_invoices", args)
    assert len(_items(second)) == 1 and "next_cursor" not in second.result

    # A page Xero no longer takes.
    xero.hook = lambda method, path, params, body: (
        FakeXero._error(400, {"Type": "QueryParseException"}) if params.get("page") == "2" else None
    )
    assert await refusal(executor, "xero_search_invoices", args) == "INVALID_CURSOR"
    xero.hook = lambda method, path, params, body: FakeXero._error(
        400, {"Type": "ValidationException", "Elements": [{"ValidationErrors": [{"Message": "bad"}]}]}
    )
    assert await refusal(executor, "xero_search_invoices", {"limit": 2}) == "PROVIDER_REJECTED"


@pytest.mark.django_db(transaction=True)
async def test_an_invoice_is_read_with_its_lines_and_payments(start, xero):
    _only_acme(xero)
    lines = [
        {
            "Description": "Consulting\nSeptember",
            "Quantity": 1.5,
            "UnitAmount": 80.1234,
            "AccountCode": "200",
            "TaxType": "OUTPUT2",
            "TaxAmount": 24.04,
            "LineAmount": 120.19,
            "DiscountRate": 0,
            "Tracking": [{"Name": "Region", "Option": "North"}],
        },
        {"Description": "x" * 2500, "Quantity": 1, "UnitAmount": 1},
    ] + [{"Description": "more", "Quantity": 1, "UnitAmount": 1}] * 200
    xero.invoices[ACME][0] |= {
        "LineItems": lines,
        "Payments": [
            {"PaymentID": "p", "Date": "/Date(1788393600000+0000)/", "Amount": 50.0, "Reference": "wire"}
        ],
    }
    executor = await start({ACME: ("read",)})
    [invoice] = _items(await executor.invoke("xero_get_invoice", {"invoice": INVOICE.upper()}))
    assert dict(xero.accounting()[-1].url.params) == {"unitdp": "4"}
    assert invoice["amounts_are"] == "Exclusive" and invoice["has_attachments"] is False
    assert (invoice["line_count"], invoice["lines_truncated"], len(invoice["lines"])) == (202, True, 200)
    assert invoice["lines"][0] == {
        "description": "Consulting\nSeptember",
        "description_truncated": False,
        "quantity": "1.5",
        "unit_amount": "80.1234",
        "item_code": None,
        "account_code": "200",
        "tax_type": "OUTPUT2",
        "tax_amount": "24.04",
        "line_amount": "120.19",
        "discount_rate": "0",
        "discount_amount": None,
        "tracking": [{"category": "Region", "option": "North"}],
    }
    assert invoice["lines"][1]["description_truncated"] is True
    assert invoice["payments"] == [{"date": "2026-09-03", "amount": "50.00", "reference": "wire"}]
    assert (invoice["payment_count"], invoice["payments_truncated"]) == (1, False)

    other = "10000000-0000-4000-8000-000000000009"
    assert await refusal(executor, "xero_get_invoice", {"invoice": other}) == "NOT_FOUND"
    xero.hook = lambda method, path, params, body: httpx.Response(
        200, json={"Invoices": [_invoice(other, "ACCREC", xero.contacts[ACME][0])]}
    )
    assert await refusal(executor, "xero_get_invoice", {"invoice": INVOICE}) == "PROVIDER_FAILED"


@pytest.mark.django_db(transaction=True)
async def test_accounts_and_tax_rates_are_the_active_ones(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read",)})
    accounts = await executor.invoke("xero_list_accounts", {})
    assert dict(xero.accounting()[-1].url.params) == {"where": 'Status=="ACTIVE"'}
    assert _items(accounts)[0] == {
        "code": "200",
        "name": "Sales",
        "type": "REVENUE",
        "class": "REVENUE",
        "tax_type": "OUTPUT2",
        "description": "Income from sales",
    }
    assert len(_items(accounts)) == 2 and "0123456" not in json.dumps(accounts.result)
    rates = await executor.invoke("xero_list_tax_rates", {})
    assert _items(rates) == [
        {
            "tax_type": "OUTPUT2",
            "name": "20% (VAT on Income)",
            "display_rate": "20",
            "effective_rate": "20",
            "for_sales": True,
            "for_expenses": False,
            "components": [{"name": "VAT", "rate": "20", "compound": False, "non_recoverable": False}],
        }
    ]
    xero.accounts = [{"Code": str(n), "Status": "ACTIVE"} for n in range(2001)]
    assert await refusal(executor, "xero_list_accounts", {}) == "PROVIDER_LIMIT"


# Drafting


DRAFT = {
    "contact": CUSTOMER,
    "date": "2026-10-01",
    "due_date": "2026-10-31",
    "currency": "EUR",
    "amounts_are": "inclusive",
    "number": "INV-0100",
    "reference": "PO 9",
    "lines": [
        {
            "description": "Consulting, October",
            "quantity": "1.50",
            "unit_amount": "80.1250",
            "account_code": "200",
            "tax_type": "OUTPUT2",
            "discount_rate": "10.0",
        },
        {"description": "Goodwill", "quantity": "1", "unit_amount": "-5"},
    ],
}


@pytest.mark.django_db(transaction=True)
async def test_a_draft_invoice_is_sent_field_by_field_and_always_a_draft(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read", "draft_sales")})
    outcome = await executor.invoke("xero_create_draft_invoice", DRAFT)
    [(tenant, params, sent)] = xero.writes
    assert tenant == ACME and params == {"summarizeErrors": "true", "unitdp": "4"}
    assert sent == {
        "Invoices": [
            {
                "Type": "ACCREC",
                "Status": "DRAFT",
                "Contact": {"ContactID": CUSTOMER},
                "LineAmountTypes": "Inclusive",
                "LineItems": [
                    {
                        "Description": "Consulting, October",
                        "Quantity": 1.5,
                        "UnitAmount": 80.125,
                        "AccountCode": "200",
                        "TaxType": "OUTPUT2",
                        "DiscountRate": 10,
                    },
                    {"Description": "Goodwill", "Quantity": 1, "UnitAmount": -5},
                ],
                "Date": "2026-10-01",
                "DueDate": "2026-10-31",
                "CurrencyCode": "EUR",
                "InvoiceNumber": "INV-0100",
                "Reference": "PO 9",
            }
        ]
    }
    assert _items(outcome) == [
        {
            "created": True,
            "id": "20000000-0000-4000-8000-000000000001",
            "type": "sales",
            "status": "DRAFT",
            "number": "INV-0100",
            "reference": "PO 9",
            "contact": {"id": CUSTOMER, "name": "Carol Customer"},
            "date": "2026-09-01",
            "due_date": "2026-09-15",
            "currency": "EUR",
            "sub_total": "115.1875",
            "total_tax": "0.00",
            "total": "115.1875",
            "warnings": ["Account code '200' has been archived"],
        }
    ]
    # The contact is read before writing, in the same organisation.
    assert [r.url.path for r in xero.accounting()][-2:] == [
        f"/api.xro/2.0/Contacts/{CUSTOMER}",
        "/api.xro/2.0/Invoices",
    ]

    for bad in (
        DRAFT | {"status": "AUTHORISED"},
        DRAFT | {"contact": {"Name": "New Co"}},
        DRAFT | {"lines": []},
        DRAFT | {"lines": [DRAFT["lines"][0] | {"Status": "PAID"}]},
        DRAFT | {"lines": [DRAFT["lines"][0] | {"quantity": 1.5}]},
        DRAFT | {"due_date": "2026-09-30"},
        DRAFT | {"currency": "eur"},
        DRAFT | {"number": "INV\n1"},
    ):
        assert await refusal(executor, "xero_create_draft_invoice", bad) == "INVALID_ARGUMENTS", bad
    assert len(xero.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_bills_and_sales_invoices_are_separate_permissions(start, xero):
    executor = await start({ACME: ("read", "draft_bills"), BETA: ("read", "draft_sales")})
    line = {"description": "Paper", "quantity": "2", "unit_amount": "4.20"}
    bill = {"organisation": ACME, "contact": SUPPLIER, "number": "S-77", "lines": [line]}
    outcome = await executor.invoke("xero_create_draft_bill", bill)
    assert _items(outcome)[0]["type"] == "bill" and _items(outcome)[0]["number"] == "S-77"
    assert xero.writes[-1][2]["Invoices"][0] == {
        "Type": "ACCPAY",
        "Status": "DRAFT",
        "Contact": {"ContactID": SUPPLIER},
        "LineAmountTypes": "Exclusive",
        "LineItems": [{"Description": "Paper", "Quantity": 2, "UnitAmount": 4.2}],
        "InvoiceNumber": "S-77",
    }
    sales = {"organisation": ACME, "contact": CUSTOMER, "lines": [line]}
    assert await refusal(executor, "xero_create_draft_invoice", sales) == "POLICY_DENIED"
    assert await refusal(executor, "xero_create_draft_bill", bill | {"organisation": BETA}) == "POLICY_DENIED"
    for bad in ({"reference": "x"}, {"lines": [line | {"discount_rate": "5"}]}):
        assert await refusal(executor, "xero_create_draft_bill", bill | bad) == "INVALID_ARGUMENTS"
    assert len(xero.writes) == 1 and xero.accounting(BETA) == []


@pytest.mark.django_db(transaction=True)
async def test_drafting_needs_its_consent(start, xero):
    _only_acme(xero)
    reading = [s for s in SCOPES if s != "accounting.invoices"]
    executor = await start({ACME: ("read", "draft_sales", "draft_bills")}, scopes=reading)
    assert {t for t in executor.context.tools if t.startswith("xero_")} == {
        "xero_list_organisations",
        "xero_search_contacts",
        "xero_search_invoices",
        "xero_get_invoice",
        "xero_list_accounts",
        "xero_list_tax_rates",
    }


@pytest.mark.django_db(transaction=True)
async def test_a_draft_needs_an_active_contact_in_the_organisation(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read", "draft_sales")})
    line = {"description": "x", "quantity": "1", "unit_amount": "1"}
    missing = "c0000000-0000-4000-8000-000000000009"
    assert (
        await refusal(executor, "xero_create_draft_invoice", {"contact": missing, "lines": [line]})
        == "INVALID_ARGUMENTS"
    )
    assert (
        await refusal(executor, "xero_create_draft_invoice", {"contact": ARCHIVED, "lines": [line]})
        == "INVALID_ARGUMENTS"
    )
    # A contact of another organisation is not one of this organisation's.
    xero.contacts[BETA].append(_contact(missing, SECRET))
    assert (
        await refusal(
            executor,
            "xero_create_draft_invoice",
            {"contact": missing, "lines": [line | {"description": "y"}]},
        )
        == "INVALID_ARGUMENTS"
    )
    assert xero.accounting(BETA) == []
    # A contact answered for another id is Xero's error.
    xero.hook = lambda method, path, params, body: (
        httpx.Response(200, json={"Contacts": [xero.contacts[ACME][1]]}) if method == "GET" else None
    )
    assert (
        await refusal(executor, "xero_create_draft_invoice", {"contact": CUSTOMER, "lines": [line]})
        == "PROVIDER_FAILED"
    )
    assert xero.writes == []


@pytest.mark.django_db(transaction=True)
async def test_refused_drafts_are_not_counted_and_odd_answers_are_shown_as_they_are(start, xero):
    _only_acme(xero)
    executor = await start({ACME: ("read", "draft_sales")})

    def draft(n: int) -> dict:
        return {"contact": CUSTOMER, "lines": [{"description": f"x{n}", "quantity": "1", "unit_amount": "1"}]}

    invalid = {
        "Type": "ValidationException",
        "Message": SECRET,
        "Elements": [{"ValidationErrors": [{"Message": "Invoice # must be unique."}]}],
    }
    xero.hook = lambda method, path, params, body: FakeXero._error(400, invalid) if method == "PUT" else None
    with pytest.raises(OperationError) as caught:
        await executor.invoke("xero_create_draft_invoice", draft(1))
    assert (caught.value.code, caught.value.message) == (
        "PROVIDER_REJECTED",
        "Xero rejected this: Invoice # must be unique.",
    )

    # A refusal answered with 200, as when summarizeErrors is ignored.
    refused = {
        "InvoiceID": client_module.ZERO_UUID,
        "HasErrors": True,
        "ValidationErrors": [{"Message": "Contact is archived."}],
    }
    xero.hook = lambda method, path, params, body: (
        httpx.Response(200, json={"Invoices": [refused]}) if method == "PUT" else None
    )
    with pytest.raises(OperationError) as caught:
        await executor.invoke("xero_create_draft_invoice", draft(2))
    assert caught.value.message == "Xero rejected this: Contact is archived."

    # Anything but the draft asked for is shown as Xero created it.
    def approved(method: str, path: str, params: dict, body: dict | None):
        if method == "PUT":
            created = xero._created(ACME, body["Invoices"][0]) | {"Status": "AUTHORISED"}
            return httpx.Response(200, json={"Invoices": [created]})
        return None

    xero.hook = approved
    outcome = await executor.invoke("xero_create_draft_invoice", draft(3))
    assert _items(outcome)[0]["status"] == "AUTHORISED"

    def elsewhere(method: str, path: str, params: dict, body: dict | None):
        if method == "PUT":
            created = xero._created(ACME, body["Invoices"][0])
            created["Contact"]["ContactID"] = SUPPLIER
            return httpx.Response(200, json={"Invoices": [created]})
        return None

    xero.hook = elsewhere
    outcome = await executor.invoke("xero_create_draft_invoice", draft(4))
    assert _items(outcome)[0]["contact"]["id"] == SUPPLIER

    xero.hook = lambda method, path, params, body: (
        httpx.Response(200, json={"Invoices": []}) if method == "PUT" else None
    )
    outcome = await executor.invoke("xero_create_draft_invoice", draft(5))
    assert outcome.result["outcome"] == "applied_without_result"

    # Three writes were applied, the run's limit; the two refusals were not counted, and nothing paused.
    xero.hook = None
    assert await refusal(executor, "xero_create_draft_invoice", draft(6)) == "LIMIT_REACHED"


def test_amounts_are_checked_decimals():
    def line(**fields) -> dict:
        return {"description": "x", "quantity": "1", "unit_amount": "1"} | fields

    def sent(**fields) -> dict:
        data = DraftInvoice.model_validate({"contact": CUSTOMER, "lines": [line(**fields)]})
        return body(data, "sales")["LineItems"][0]

    assert sent(quantity="2.500", unit_amount="-0.0") == {
        "Description": "x",
        "Quantity": 2.5,
        "UnitAmount": 0,
    }
    assert sent(unit_amount="9999999999.9999")["UnitAmount"] == 9999999999.9999
    assert sent(discount_rate="100")["DiscountRate"] == 100
    for fields in (
        {"quantity": "0"},
        {"quantity": "-1"},
        {"quantity": "1.00001"},
        {"quantity": "1e3"},
        {"unit_amount": "1,00"},
        {"unit_amount": "NaN"},
        {"unit_amount": "12345678901"},
        {"discount_rate": "100.01"},
        {"discount_rate": "-1"},
    ):
        with pytest.raises(ValueError):
            sent(**fields)
    data = DraftBill.model_validate({"contact": CUSTOMER, "lines": [line()]})
    assert body(data, "bill") == {
        "Type": "ACCPAY",
        "Status": "DRAFT",
        "Contact": {"ContactID": CUSTOMER},
        "LineAmountTypes": "Exclusive",
        "LineItems": [{"Description": "x", "Quantity": 1, "UnitAmount": 1}],
    }
