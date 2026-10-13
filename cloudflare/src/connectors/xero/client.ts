// Xero's Accounting API, and the identity endpoints that name the user and the organisations they connected.
//
// Every accounting request names its organisation in the `xero-tenant-id` header, always one Minerva has
// already authorized. Models mirror Xero's JSON, whose keys are in PascalCase; fields Xero leaves out stay
// null, never zero or false. Reads are bounded. Xero's validation messages are passed on (shortened, one line
// each): they describe the organisation's own data, in an organisation the call was allowed to use. Its other
// error texts are not.
//
// Responses are strict UTF-8 JSON, a byte order mark dropped. Fields not named here are dropped, and amounts
// become exact decimals (decimal.ts). A field of another type (a number or boolean sent as a string, an
// integral amount of 2^53 or more, which JSON parsing may already have rounded) makes the response unexpected.

import { z } from "zod";
import { OperationError, type OperationErrorShape, type ProviderClient } from "../../gateway/connector.ts";
import { type Effect, ProviderHTTP, type ProviderIo, type ProviderRequest } from "../../gateway/http.ts";
import { isDict, type Json, parseJson, parseJsonBytes } from "../../lib/json.ts";
import { truncate } from "../../lib/text.ts";
import { type Decimal, fromNumber } from "./decimal.ts";

export const API_URL = "https://api.xero.com";
export const ACCOUNTING = "/api.xro/2.0";
export const USERINFO_URL = "https://identity.xero.com/connect/userinfo";
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_ORGANISATIONS = 100;
export const MAX_ACCOUNTS = 2000;
export const MAX_TAX_RATES = 500;
export const MAX_MESSAGES = 5;
export const MAX_MESSAGE = 300;
export const MAX_PAGE = 100_000;
/** Xero's ids are UUIDs; Minerva keeps them in lower case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const PAGE = /^[1-9][0-9]{0,5}$/;
// Xero's JSON dates: /Date(1518685950940+0000)/, milliseconds since the epoch and an offset, in ASCII digits.
const JSON_DATE = /^\/Date\((-?\d{1,15})([+-]\d{4})?\)\/$/u;
const DATE_STRING = /^(\d{4}-\d{2}-\d{2})(T[0-9:.]+)?$/u;
const TOO_LARGE = (): OperationError => new OperationError("RESPONSE_TOO_LARGE", "Xero's response was too large to read.");

/** The id in Minerva's spelling, or null when it is not a UUID. */
export function uuid(value: string | null | undefined): string | null {
	const lowered = (value ?? "").toLowerCase();
	return UUID.test(lowered) && lowered !== ZERO_UUID ? lowered : null;
}

// A missing field takes its default; fields not named are dropped.
const text = () => z.string().nullable().default(null);
const flag = () => z.boolean().nullable().default(null);
const integer = () => z.int().nullable().default(null);
/** A decimal, read exactly from the JSON number (decimal.ts), or null. */
const decimal = () =>
	z
		.number()
		.nullable()
		.default(null)
		.transform((value, ctx): Decimal | null => {
			if (value === null) return null;
			const found = fromNumber(value);
			if (found === null) {
				ctx.issues.push({ code: "custom", message: "not an exact decimal", input: value });
				return z.NEVER;
			}
			return found;
		});

export const UserInfo = z.object({
	sub: z.string(),
	name: text(),
	given_name: text(),
	family_name: text(),
	email: text(),
});
export type UserInfo = z.output<typeof UserInfo>;

export const Connection = z.object({ tenantId: z.string(), tenantType: text(), tenantName: text() });
export type Connection = z.output<typeof Connection>;

export const Pagination = z.object({ page: integer(), pageSize: integer(), pageCount: integer(), itemCount: integer() });
export type Pagination = z.output<typeof Pagination>;

export const Message = z.object({ Message: text() });
export type Message = z.output<typeof Message>;

export const Address = z.object({
	AddressType: text(),
	AddressLine1: text(),
	AddressLine2: text(),
	AddressLine3: text(),
	AddressLine4: text(),
	City: text(),
	Region: text(),
	PostalCode: text(),
	Country: text(),
});
export type Address = z.output<typeof Address>;

const Phone = z.object({ PhoneType: text(), PhoneNumber: text(), PhoneAreaCode: text(), PhoneCountryCode: text() });
const Person = z.object({ FirstName: text(), LastName: text(), EmailAddress: text() });

export const Outstanding = z.object({ Outstanding: decimal(), Overdue: decimal() });
export type Outstanding = z.output<typeof Outstanding>;

const BalanceSet = z.object({ AccountsReceivable: Outstanding.nullable().default(null), AccountsPayable: Outstanding.nullable().default(null) });

export const Contact = z.object({
	ContactID: z.string(),
	Name: text(),
	FirstName: text(),
	LastName: text(),
	EmailAddress: text(),
	ContactNumber: text(),
	AccountNumber: text(),
	ContactStatus: text(),
	IsCustomer: flag(),
	IsSupplier: flag(),
	DefaultCurrency: text(),
	TaxNumber: text(),
	Addresses: z.array(Address).default([]),
	Phones: z.array(Phone).default([]),
	ContactPersons: z.array(Person).default([]),
	Balances: BalanceSet.nullable().default(null),
});
export type Contact = z.output<typeof Contact>;

export const Contacts = z.object({ pagination: Pagination.nullable().default(null), Contacts: z.array(Contact).default([]) });
export type Contacts = z.output<typeof Contacts>;

const ContactRef = z.object({ ContactID: text(), Name: text() });
const TrackingRef = z.object({ Name: text(), Option: text() });

const LineItem = z.object({
	Description: text(),
	Quantity: decimal(),
	UnitAmount: decimal(),
	ItemCode: text(),
	AccountCode: text(),
	TaxType: text(),
	TaxAmount: decimal(),
	LineAmount: decimal(),
	DiscountRate: decimal(),
	DiscountAmount: decimal(),
	Tracking: z.array(TrackingRef).default([]),
});

const Payment = z.object({ Date: text(), Amount: decimal(), Reference: text() });

export const Invoice = z.object({
	InvoiceID: text(),
	Type: text(),
	InvoiceNumber: text(),
	Reference: text(),
	Contact: ContactRef.nullable().default(null),
	Status: text(),
	Date: text(),
	DateString: text(),
	DueDate: text(),
	DueDateString: text(),
	CurrencyCode: text(),
	LineAmountTypes: text(),
	SubTotal: decimal(),
	TotalTax: decimal(),
	Total: decimal(),
	AmountDue: decimal(),
	AmountPaid: decimal(),
	AmountCredited: decimal(),
	SentToContact: flag(),
	HasAttachments: flag(),
	UpdatedDateUTC: text(),
	LineItems: z.array(LineItem).default([]),
	Payments: z.array(Payment).default([]),
	HasErrors: flag(),
	ValidationErrors: z.array(Message).default([]),
	Warnings: z.array(Message).default([]),
});
export type Invoice = z.output<typeof Invoice>;

export const Invoices = z.object({ pagination: Pagination.nullable().default(null), Invoices: z.array(Invoice).default([]) });
export type Invoices = z.output<typeof Invoices>;

export const Account = z.object({
	Code: text(),
	Name: text(),
	Type: text(),
	Class: text(),
	Status: text(),
	TaxType: text(),
	Description: text(),
});
export type Account = z.output<typeof Account>;

const Accounts = z.object({ Accounts: z.array(Account).default([]) });

const TaxComponent = z.object({ Name: text(), Rate: decimal(), IsCompound: flag(), IsNonRecoverable: flag() });

export const TaxRate = z.object({
	Name: text(),
	TaxType: text(),
	Status: text(),
	DisplayTaxRate: decimal(),
	EffectiveRate: decimal(),
	CanApplyToRevenue: flag(),
	CanApplyToExpenses: flag(),
	TaxComponents: z.array(TaxComponent).default([]),
});
export type TaxRate = z.output<typeof TaxRate>;

const TaxRates = z.object({ TaxRates: z.array(TaxRate).default([]) });

const Element = z.object({ ValidationErrors: z.array(Message).default([]) });
const Failure = z.object({ Type: text(), Elements: z.array(Element).default([]), ValidationErrors: z.array(Message).default([]) });

/** Xero's validation messages, shortened, one line each. */
export function messages(found: readonly Message[]): string[] {
	const shown: string[] = [];
	for (const message of found) {
		const line = (message.Message ?? "").trim().replace(/\s+/g, " ");
		// The whole line is compared with what was kept, which is each line cut to MAX_MESSAGE.
		if (line && !shown.includes(line)) shown.push(truncate(line, MAX_MESSAGE)[0]);
	}
	return shown.slice(0, MAX_MESSAGES);
}

export function rejected(found: readonly Message[]): OperationError {
	const texts = messages(found);
	const detail = texts.length ? `: ${texts.join("; ")}` : ".";
	return new OperationError("PROVIDER_REJECTED", `Xero rejected this${detail}`);
}

function parsedBody(body: string): Json | undefined {
	try {
		return parseJson(body);
	} catch {
		return undefined;
	}
}

export const FORBIDDEN =
	"Xero refused this request. The connection may lack a permission (reconnect to give it), the user's role in this organisation may not allow it, or the organisation was disconnected from Minerva.";

/** Xero's validation messages for a 400, and what a 403 may mean. */
export function classify(_provider: string, response: Response, _body: string, bytes: Uint8Array): OperationErrorShape | null {
	if (response.status === 400) {
		let data: Json;
		try {
			data = parseJsonBytes(bytes);
		} catch {
			return null;
		}
		const failure = Failure.safeParse(data);
		if (!failure.success || failure.data.Type !== "ValidationException") return null;
		const found = [...failure.data.ValidationErrors, ...failure.data.Elements.flatMap((element) => element.ValidationErrors)];
		return rejected(found);
	}
	if (response.status === 403) return new OperationError("PROVIDER_FORBIDDEN", FORBIDDEN);
	return null;
}

/**
 * A 200 that holds only invoices Xero refused created nothing. Minerva asks Xero to answer refusals with 400
 * (`summarizeErrors=true`); this covers an answer that ignores that.
 */
export function judge(response: Response, body: string): Effect | null {
	if (!response.ok) return null;
	const data = parsedBody(body);
	const found = isDict(data) ? data.Invoices : undefined;
	if (!Array.isArray(found) || found.length === 0) return null;
	let refused = true;
	for (const item of found) {
		if (!isDict(item) || item.HasErrors !== true) {
			refused = false;
			continue;
		}
		// A refused invoice has no id (or the zero UUID); an id of another type leaves the write unknown.
		const id = item.InvoiceID;
		if (id === undefined || id === null) continue;
		if (typeof id !== "string") return "unknown";
		if (uuid(id) !== null) refused = false;
	}
	return refused ? "not_applied" : null;
}

export function invalidPage(): OperationError {
	return new OperationError("INVALID_CURSOR", "This page token is invalid.");
}

/** The page a cursor names; the first page without one. */
export function page(cursor: string | null): number {
	if (cursor === null) return 1;
	if (!PAGE.test(cursor) || Number(cursor) > MAX_PAGE) throw invalidPage();
	return Number(cursor);
}

/** The next page's cursor. Xero says how many pages there are; without that, a full page may have more. */
export function nextPage(found: Pagination | null, current: number, count: number, size: number): string | null {
	const known = found !== null ? found.pageCount : null;
	const more = known !== null ? known > current : count >= size;
	return more && current < MAX_PAGE ? String(current + 1) : null;
}

/** A date Xero gave as a string (2026-10-01T00:00:00), as YYYY-MM-DD. */
export function date(value: string | null): string | null {
	const match = DATE_STRING.exec(value ?? "");
	return match === null ? null : (match[1] as string);
}

/** The first and last second of the years 1 to 9999, which ISO 8601 writes with four digits. */
const MIN_SECONDS = -62135596800;
const MAX_SECONDS = 253402300799;

/** A time in Xero's JSON date form, in ISO 8601 UTC. */
export function moment(value: string | null): string | null {
	const match = JSON_DATE.exec(value ?? "");
	if (match === null) return null;
	// Shown to the second the instant falls in. At most 15 digits, so the milliseconds are a safe integer.
	const milliseconds = Number(match[1]);
	const seconds = (milliseconds - (((milliseconds % 1000) + 1000) % 1000)) / 1000;
	if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) return null;
	return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

/** An invoice's date or due date: the string form, else the JSON date's day. */
export function invoiceDate(text: string | null, raw: string | null): string | null {
	return date(text) || (moment(raw) ?? "").slice(0, 10) || null;
}

type Query = NonNullable<ProviderRequest["query"]>;

export class XeroClient implements ProviderClient {
	readonly #http: ProviderHTTP;
	#organisations: Connection[] | null = null;

	constructor(token: string, io: ProviderIo) {
		this.#http = new ProviderHTTP(io, {
			provider: "Xero",
			baseUrl: API_URL,
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			classify,
			judge,
		});
	}

	close(): Promise<void> {
		return this.#http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.#http.unexpected(cause);
	}

	async #bounded(url: string, tenant: string | null, params?: Query): Promise<Uint8Array> {
		const request: ProviderRequest = { method: "GET", path: url };
		if (tenant !== null) request.headers = { "xero-tenant-id": tenant };
		if (params !== undefined) request.query = params;
		const response = await this.#http.bounded(request, MAX_RESPONSE, TOO_LARGE());
		return new Uint8Array(await response.arrayBuffer());
	}

	/** The body fitted to `schema`, or an unexpected response. */
	async #read<T>(schema: z.ZodType<T>, url: string, tenant: string | null = null, params?: Query): Promise<T> {
		const bytes = await this.#bounded(url, tenant, params);
		let data: Json;
		try {
			data = parseJsonBytes(bytes);
		} catch (error) {
			throw this.unexpected(error);
		}
		const found = schema.safeParse(data);
		if (!found.success) throw this.unexpected(found.error);
		return found.data;
	}

	me(): Promise<UserInfo> {
		return this.#read(UserInfo, USERINFO_URL);
	}

	/**
	 * The organisations this connection reaches, once each, ordered by id. Practice Manager and other tenants
	 * that are not organisations are left out.
	 */
	async organisations(): Promise<Connection[]> {
		if (this.#organisations === null) {
			const found = await this.#read(z.array(Connection), "/connections");
			const kept = new Map<string, Connection>();
			for (const connection of found) {
				const tenant = uuid(connection.tenantId);
				if (tenant !== null && connection.tenantType === "ORGANISATION" && !kept.has(tenant)) kept.set(tenant, { ...connection, tenantId: tenant });
			}
			if (kept.size > MAX_ORGANISATIONS) throw new OperationError("PROVIDER_LIMIT", "This connection reaches more Xero organisations than Minerva reads.");
			this.#organisations = [...kept.keys()].sort().map((key) => kept.get(key) as Connection);
		}
		return this.#organisations;
	}

	async contacts(tenant: string, options: { page: number; size: number; text: string | null; archived: boolean }): Promise<Contacts> {
		const params: Query = { page: options.page, pageSize: options.size, order: "Name ASC" };
		if (options.text !== null) params.searchTerm = options.text;
		if (options.archived) params.includeArchived = "true";
		const found = await this.#read(Contacts, `${ACCOUNTING}/Contacts`, tenant, params);
		if (found.Contacts.length > options.size || found.Contacts.some((contact) => uuid(contact.ContactID) === null)) throw this.unexpected();
		return found;
	}

	async contact(tenant: string, contactId: string): Promise<Contact> {
		const found = await this.#read(Contacts, `${ACCOUNTING}/Contacts/${contactId}`, tenant);
		const only = found.Contacts[0];
		if (found.Contacts.length !== 1 || only === undefined || uuid(only.ContactID) !== contactId) throw this.unexpected();
		return only;
	}

	async invoices(tenant: string, params: Query, size: number): Promise<Invoices> {
		const found = await this.#read(Invoices, `${ACCOUNTING}/Invoices`, tenant, params);
		if (found.Invoices.length > size || found.Invoices.some((invoice) => uuid(invoice.InvoiceID) === null)) throw this.unexpected();
		return found;
	}

	async invoice(tenant: string, invoiceId: string): Promise<Invoice> {
		const found = await this.#read(Invoices, `${ACCOUNTING}/Invoices/${invoiceId}`, tenant, { unitdp: 4 });
		const only = found.Invoices[0];
		if (found.Invoices.length !== 1 || only === undefined || uuid(only.InvoiceID) !== invoiceId) throw this.unexpected();
		return only;
	}

	async accounts(tenant: string): Promise<Account[]> {
		const found = await this.#read(Accounts, `${ACCOUNTING}/Accounts`, tenant, { where: 'Status=="ACTIVE"' });
		if (found.Accounts.length > MAX_ACCOUNTS) throw new OperationError("PROVIDER_LIMIT", "This organisation has more accounts than Minerva reads.");
		return found.Accounts.filter((account) => account.Status === null || account.Status === "ACTIVE");
	}

	async taxRates(tenant: string): Promise<TaxRate[]> {
		const found = await this.#read(TaxRates, `${ACCOUNTING}/TaxRates`, tenant);
		if (found.TaxRates.length > MAX_TAX_RATES) throw new OperationError("PROVIDER_LIMIT", "This organisation has more tax rates than Minerva reads.");
		return found.TaxRates.filter((rate) => rate.Status === null || rate.Status === "ACTIVE");
	}

	/**
	 * The one write: PUT creates and never updates (POST would update an invoice it matches). Refusals are
	 * asked for as 400s; a 200 that still carries them is refused here too. `body` is the request's JSON text,
	 * whose amounts are written as their decimals (writes.ts `jsonBody`).
	 */
	async createInvoice(tenant: string, body: string): Promise<Invoice> {
		const found = await this.#http.parsed(
			{
				method: "PUT",
				path: `${ACCOUNTING}/Invoices`,
				headers: { "xero-tenant-id": tenant, "Content-Type": "application/json" },
				query: { summarizeErrors: "true", unitdp: 4 },
				body,
			},
			Invoices,
		);
		const created = found.Invoices[0];
		if (found.Invoices.length !== 1 || created === undefined) throw this.unexpected();
		if (created.HasErrors) throw rejected(created.ValidationErrors);
		return created;
	}
}
