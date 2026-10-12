// backend/tests/test_xero.py's FakeXero: Xero's identity and Accounting APIs behind an injected `fetch`.
//
// Ada connected Acme and Beta (whose name is secret); `/connections` also lists a Practice Manager tenant
// and Acme a second time, in capitals. Acme has a customer, a supplier and an archived contact. What the
// Python fake asserted about each request (the token, the host, the tenant header) is collected in
// `problems`, which the tests check is empty: an exception thrown from `fetch` would only reach them as
// PROVIDER_UNAVAILABLE.

import { XeroClient } from "../../../../src/connectors/xero/client.ts";
import { settingsIo } from "../../../../src/gateway/http.ts";
import { type Json, type JsonObject, parseJson } from "../../../../src/lib/json.ts";

export const SECRET = "SECRET acquisition";
export const ACME = "0a1b2c3d-0000-4000-8000-000000000001";
export const BETA = "0a1b2c3d-0000-4000-8000-000000000002";
export const UNREACHED = "0a1b2c3d-0000-4000-8000-000000000003";
export const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
export const SUPPLIER = "c0000000-0000-4000-8000-000000000002";
export const ARCHIVED = "c0000000-0000-4000-8000-000000000003";
export const INVOICE = "10000000-0000-4000-8000-000000000001";
export const TOKEN = "token";

type Fields = { [key: string]: Json };

export function contactOf(contactId: string, name: string, status = "ACTIVE", fields: Fields = {}): JsonObject {
	return {
		ContactID: contactId.toUpperCase(),
		Name: name,
		ContactStatus: status,
		EmailAddress: `${(name.split(" ")[0] as string).toLowerCase()}@example.com`,
		BankAccountDetails: "01-0123-0123456-00",
		Addresses: [],
		Phones: [],
		ContactPersons: [],
		...fields,
	};
}

export function invoiceOf(invoiceId: string, kind: string, contact: JsonObject, fields: Fields = {}): JsonObject {
	return {
		InvoiceID: invoiceId,
		Type: kind,
		InvoiceNumber: "INV-0001",
		Reference: "PO 7",
		Contact: { ContactID: contact.ContactID as string, Name: contact.Name as string },
		Status: "AUTHORISED",
		Date: "/Date(1788220800000+0000)/",
		DateString: "2026-09-01T00:00:00",
		DueDate: "/Date(1789430400000+0000)/",
		DueDateString: "2026-09-15T00:00:00",
		CurrencyCode: "EUR",
		LineAmountTypes: "Exclusive",
		SubTotal: 100.0,
		TotalTax: 20.0,
		Total: 120.0,
		AmountDue: 70.0,
		AmountPaid: 50.0,
		AmountCredited: 0,
		SentToContact: true,
		HasAttachments: false,
		UpdatedDateUTC: "/Date(1788307200000+0000)/",
		...fields,
	};
}

export function jsonResponse(status: number, body: Json): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A request as the fake saw it. */
export interface Seen {
	method: string;
	url: URL;
	headers: Headers;
	body: Json | null;
	text: string;
}

export type Hook = (method: string, path: string, params: { [name: string]: string }, body: Json | null) => Response | null;

export class FakeXero {
	me: JsonObject = { sub: "u-991", name: "Ada Lovelace", given_name: "Ada", family_name: "Lovelace", email: "ada@example.com" };
	connections: JsonObject[] = [
		{ id: "c1", tenantId: BETA, tenantType: "ORGANISATION", tenantName: SECRET },
		{ id: "c2", tenantId: ACME, tenantType: "ORGANISATION", tenantName: "Acme  Ltd" },
		{ id: "c3", tenantId: ACME.toUpperCase(), tenantType: "ORGANISATION", tenantName: "Acme" },
		{ id: "c4", tenantId: UNREACHED, tenantType: "PRACTICEMANAGER", tenantName: "Practice" },
		{ id: "c5", tenantId: "not-a-uuid", tenantType: "ORGANISATION", tenantName: "Odd" },
	];
	contacts: { [tenant: string]: JsonObject[] };
	invoices: { [tenant: string]: JsonObject[] };
	accounts: JsonObject[] = [
		{ Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT2", Description: "Income from sales" },
		{ Code: "090", Name: "Bank", Type: "BANK", Class: "ASSET", Status: "ACTIVE", BankAccountNumber: "01-0123-0123456-00" },
		{ Code: "999", Name: "Old", Type: "EXPENSE", Status: "ARCHIVED" },
	];
	taxRates: JsonObject[] = [
		{
			Name: "20% (VAT on Income)",
			TaxType: "OUTPUT2",
			Status: "ACTIVE",
			DisplayTaxRate: 20.0,
			EffectiveRate: 20.0,
			CanApplyToRevenue: true,
			CanApplyToExpenses: false,
			TaxComponents: [{ Name: "VAT", Rate: 20.0, IsCompound: false, IsNonRecoverable: false }],
		},
		{ Name: "Old", TaxType: "OLD", Status: "DELETED" },
	];
	readonly requests: Seen[] = [];
	readonly writes: [tenant: string, params: { [name: string]: string }, body: JsonObject][] = [];
	readonly problems: string[] = [];
	hook: Hook | null = null;

	constructor() {
		const customer = contactOf(CUSTOMER, "Carol Customer", "ACTIVE", {
			IsCustomer: true,
			Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 1", City: "Zurich", Country: "CH" }, { AddressType: "STREET" }],
			Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "123 45 67", PhoneAreaCode: "44", PhoneCountryCode: "41" }, { PhoneType: "FAX" }],
			ContactPersons: [{ FirstName: "Cy", LastName: "C", EmailAddress: "cy@example.com" }],
			Balances: { AccountsReceivable: { Outstanding: 70.0, Overdue: 0 } },
		});
		this.contacts = {
			[ACME]: [customer, contactOf(SUPPLIER, "Sam Supplier", "ACTIVE", { IsSupplier: true }), contactOf(ARCHIVED, "Old Customer", "ARCHIVED")],
			[BETA]: [contactOf(CUSTOMER, SECRET)],
		};
		this.invoices = { [ACME]: [invoiceOf(INVOICE, "ACCREC", customer)], [BETA]: [] };
	}

	static error(status: number, body: Json | null = null): Response {
		return jsonResponse(status, body ?? { Title: SECRET, Detail: SECRET });
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		const body = text ? parseJson(text) : null;
		this.requests.push({ method: request.method, url, headers: request.headers, body, text });
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) this.problems.push(`token ${request.headers.get("authorization")}`);
		if (url.host === "identity.xero.com") {
			if (url.pathname !== "/connect/userinfo") this.problems.push(`identity ${url.pathname}`);
			return jsonResponse(200, this.me);
		}
		if (url.host !== "api.xero.com") this.problems.push(`host ${url.host}`);
		const path = url.pathname;
		if (path === "/connections") {
			if (request.headers.has("xero-tenant-id")) this.problems.push("a tenant on /connections");
			return jsonResponse(200, this.connections);
		}
		const tenant = request.headers.get("xero-tenant-id") ?? "";
		if (tenant !== ACME && tenant !== BETA) {
			this.problems.push(`tenant ${tenant}`);
			return FakeXero.error(500);
		}
		const params = Object.fromEntries(url.searchParams);
		const hooked = this.hook?.(request.method, path, params, body) ?? null;
		if (hooked !== null) return hooked;
		const parts = path.replace(/^\/api\.xro\/2\.0\//, "").split("/");
		const [collection, id] = parts;
		if (request.method === "GET" && collection === "Contacts" && parts.length === 1) {
			const found = (this.contacts[tenant] ?? []).filter((contact) => params.includeArchived || contact.ContactStatus === "ACTIVE");
			return FakeXero.page("Contacts", found, params);
		}
		if (request.method === "GET" && collection === "Contacts" && parts.length === 2) {
			const found = (this.contacts[tenant] ?? []).filter((contact) => (contact.ContactID as string).toLowerCase() === id);
			return found.length ? jsonResponse(200, { Contacts: found }) : FakeXero.error(404);
		}
		if (request.method === "GET" && collection === "Invoices" && parts.length === 1) return FakeXero.page("Invoices", this.invoices[tenant] ?? [], params);
		if (request.method === "GET" && collection === "Invoices" && parts.length === 2) {
			const found = (this.invoices[tenant] ?? []).filter((invoice) => invoice.InvoiceID === id);
			return found.length ? jsonResponse(200, { Invoices: found }) : FakeXero.error(404);
		}
		if (request.method === "GET" && collection === "Accounts" && parts.length === 1) return jsonResponse(200, { Accounts: this.accounts });
		if (request.method === "GET" && collection === "TaxRates" && parts.length === 1) return jsonResponse(200, { TaxRates: this.taxRates });
		if (request.method === "PUT" && collection === "Invoices" && parts.length === 1) {
			this.writes.push([tenant, params, body as JsonObject]);
			const sent = ((body as JsonObject).Invoices as JsonObject[])[0] as JsonObject;
			return jsonResponse(200, { Invoices: [this.created(tenant, sent)] });
		}
		this.problems.push(`path ${request.method} ${path}`);
		return FakeXero.error(500);
	};

	static page(key: string, items: JsonObject[], params: { [name: string]: string }): Response {
		const current = Number(params.page ?? 1);
		const size = Number(params.pageSize ?? 100);
		const count = Math.ceil(items.length / size);
		const pagination = { page: current, pageSize: size, pageCount: count, itemCount: items.length };
		return jsonResponse(200, { pagination, [key]: items.slice((current - 1) * size, current * size) });
	}

	created(tenant: string, sent: JsonObject): JsonObject {
		const contactId = (sent.Contact as JsonObject).ContactID as string;
		const contact = (this.contacts[tenant] ?? []).find((item) => (item.ContactID as string).toLowerCase() === contactId) as JsonObject;
		const total = (sent.LineItems as JsonObject[]).reduce((sum, line) => sum + (line.Quantity as number) * (line.UnitAmount as number), 0);
		return invoiceOf(`20000000-0000-4000-8000-${String(this.writes.length).padStart(12, "0")}`, sent.Type as string, contact, {
			Status: sent.Status as string,
			InvoiceNumber: (sent.InvoiceNumber as string | undefined) ?? "INV-0002",
			Reference: (sent.Reference as string | undefined) ?? null,
			SubTotal: total,
			TotalTax: 0,
			Total: total,
			AmountDue: total,
			AmountPaid: 0,
			SentToContact: false,
			Warnings: [{ Message: "Account code '200' has been archived" }],
		});
	}

	/** The Accounting API's requests, of one organisation or all. */
	accounting(tenant: string | null = null): Seen[] {
		return this.requests.filter((request) => request.url.pathname.startsWith("/api.xro/") && (tenant === null || request.headers.get("xero-tenant-id") === tenant));
	}

	/** The query of the last Accounting API request. */
	lastParams(): { [name: string]: string } {
		const last = this.accounting().at(-1);
		return last === undefined ? {} : Object.fromEntries(last.url.searchParams);
	}

	client(): XeroClient {
		return new XeroClient(TOKEN, settingsIo(this.fetch));
	}
}
