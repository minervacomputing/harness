// A thin client for the Stripe API, authenticated with a restricted key.
//
// The API version is pinned, so response shapes do not change under Minerva. Responses are validated before
// use. Stripe's errors carry a type and a code: a key without a permission is a `permission_error` (403), an
// object that does not exist is `resource_missing` (404); refusals of a refund or credit are named by their
// code, never by Stripe's wording.
//
// Requests go through ProviderHTTP: reads are bounded GETs with their parameters in the query, and the two
// writes are form-encoded POSTs, the one mutating request of their operation's execute step. Responses are
// strict UTF-8 JSON; fields not named here are dropped, and a field of another type (a number sent as a
// string, an integer beyond 2^53) makes the response unexpected.

import { z } from "zod";
import type { OperationErrorShape, ProviderClient, ProviderIo, ProviderRequest } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { isDict, type Json, parseJson } from "../../lib/json.ts";

export const API_URL = "https://api.stripe.com/v1";
export const API_VERSION = "2025-08-27.basil";
/** A restricted key; secret keys (sk_) are refused, since they can do anything in the account. */
export const KEY = /^rk_(test|live)_[A-Za-z0-9]{10,250}$/;
/** Stripe object ids: a short prefix, an underscore and letters and digits. */
export const OBJECT_ID = /^[a-z]{2,8}_[A-Za-z0-9]{1,100}$/;
export const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,100}$/;
export const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{1,100}$/;
export const SEARCH_PAGE = /^[A-Za-z0-9_=+/:.-]{1,500}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
export const MAX_RESPONSE = 4 * 1024 * 1024;

/** Refusals of a write that say what to change, by Stripe's error code. */
export const REFUSALS: ReadonlyMap<string, string> = new Map([
	["charge_already_refunded", "This payment is already refunded in full."],
	["charge_disputed", "This payment is disputed; Stripe does not refund disputed payments."],
	["amount_too_large", "The amount is more than Stripe allows here."],
	["amount_too_small", "The amount is less than Stripe allows here."],
	["balance_insufficient", "The Stripe balance is too low for this refund."],
	["refund_disputed_payment", "This payment is disputed; Stripe does not refund disputed payments."],
]);

// A missing field takes its default; fields not named are dropped.
const text = () => z.string().nullable().default(null);
const integer = () => z.int().nullable().default(null);

const BusinessProfile = z.object({ name: text() });
const Dashboard = z.object({ display_name: text() });
const Settings = z.object({ dashboard: Dashboard.nullable().default(null) });

export const Account = z.object({
	id: z.string(),
	email: text(),
	default_currency: text(),
	business_profile: BusinessProfile.nullable().default(null),
	settings: Settings.nullable().default(null),
});
export type Account = z.output<typeof Account>;

export const Customer = z.object({
	id: z.string(),
	deleted: z.boolean().default(false),
	name: text(),
	email: text(),
	description: text(),
	currency: text(),
	balance: z.int().default(0),
	delinquent: z.boolean().nullable().default(null),
	created: integer(),
});
export type Customer = z.output<typeof Customer>;

const BillingDetails = z.object({ name: text(), email: text() });
const Card = z.object({ brand: text(), last4: text() });
const PaymentMethodDetails = z.object({ type: text(), card: Card.nullable().default(null) });

export const Charge = z.object({
	id: z.string(),
	amount: z.int(),
	amount_captured: z.int().default(0),
	amount_refunded: z.int().default(0),
	captured: z.boolean().default(false),
	paid: z.boolean().default(false),
	refunded: z.boolean().default(false),
	disputed: z.boolean().default(false),
	status: z.string(),
	currency: z.string(),
	// Required: a charge without the field is not one Minerva can place. Null means a guest payment.
	customer: z.string().nullable(),
	created: integer(),
	description: text(),
	payment_intent: text(),
	failure_code: text(),
	failure_message: text(),
	billing_details: BillingDetails.nullable().default(null),
	payment_method_details: PaymentMethodDetails.nullable().default(null),
});
export type Charge = z.output<typeof Charge>;

export const Refund = z.object({
	id: z.string(),
	amount: z.int(),
	currency: z.string(),
	status: text(),
	charge: text(),
	reason: text(),
	created: integer(),
});
export type Refund = z.output<typeof Refund>;

export const Invoice = z.object({
	id: z.string(),
	customer: z.string().nullable(),
	number: text(),
	status: text(),
	currency: z.string(),
	total: z.int().default(0),
	amount_due: z.int().default(0),
	amount_paid: z.int().default(0),
	amount_remaining: z.int().default(0),
	created: integer(),
	due_date: integer(),
	description: text(),
});
export type Invoice = z.output<typeof Invoice>;

const Recurring = z.object({ interval: text(), interval_count: integer() });
const Price = z.object({
	id: z.string(),
	nickname: text(),
	product: text(),
	unit_amount: integer(),
	currency: text(),
	recurring: Recurring.nullable().default(null),
});
const SubscriptionItem = z.object({ price: Price.nullable().default(null), quantity: integer(), current_period_end: integer() });
const SubscriptionItems = z.object({ data: z.array(SubscriptionItem).default([]) });

export const Subscription = z.object({
	id: z.string(),
	customer: z.string().nullable(),
	status: z.string(),
	currency: text(),
	created: integer(),
	cancel_at_period_end: z.boolean().default(false),
	cancel_at: integer(),
	canceled_at: integer(),
	items: SubscriptionItems.default({ data: [] }),
});
export type Subscription = z.output<typeof Subscription>;

export const BalanceTransaction = z.object({
	id: z.string(),
	customer: z.string().nullable(),
	amount: z.int(),
	currency: z.string(),
	ending_balance: integer(),
	description: text(),
	created: integer(),
});
export type BalanceTransaction = z.output<typeof BalanceTransaction>;

/** A list or search page. */
export function Page<T extends z.ZodType<{ id: string }>>(item: T) {
	return z.object({ data: z.array(item).default([]), has_more: z.boolean().default(false), next_page: text() });
}
export interface Page<T> {
	data: T[];
	has_more: boolean;
	next_page: string | null;
}

/** Stripe's error named by its type and code, never by its message. A body that is not a JSON object names nothing. */
export function classify(_provider: string, response: Response, body: string): OperationErrorShape | null {
	let error: Json | undefined;
	try {
		const parsed = parseJson(body);
		if (!isDict(parsed)) return null;
		error = Object.hasOwn(parsed, "error") ? parsed.error : {};
		if (!isDict(error)) return null;
	} catch {
		return null;
	}
	const kind = error.type;
	const code = error.code;
	if (kind === "permission_error" || response.status === 403) {
		return new OperationError(
			"PROVIDER_FORBIDDEN",
			"The Stripe key does not have the permission this needs. Edit the restricted key in Stripe to give it the permissions in Minerva's setup guide.",
		);
	}
	if (response.status === 404) return new OperationError("NOT_FOUND", "Stripe did not find this object.");
	if (typeof code === "string" && REFUSALS.has(code)) return new OperationError("PROVIDER_REJECTED", REFUSALS.get(code) as string);
	if (response.status === 400 && typeof code === "string" && CODE.test(code)) return new OperationError("PROVIDER_REJECTED", `Stripe rejected this request (${code}).`);
	return null;
}

/** The id after which the next page starts, as list endpoints take it. */
export function nextCursor(page: Page<{ id: string }>): string | null {
	if (!page.has_more || page.data.length === 0) return null;
	const last = (page.data[page.data.length - 1] as { id: string }).id;
	if (!OBJECT_ID.test(last)) throw new OperationError("PROVIDER_LIMIT", "Stripe returned an id Minerva does not accept.");
	return last;
}

type Params = { [name: string]: string | number | null | undefined };

/** Query parameters; null and undefined ones are left out. */
function params(values: Params): ProviderRequest["query"] {
	const out: { [name: string]: string | number } = {};
	for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) out[key] = value;
	return out;
}

export class StripeClient implements ProviderClient {
	readonly key: string;
	readonly #http: ProviderHTTP;

	constructor(key: string, io: ProviderIo, baseUrl: string = API_URL) {
		this.key = key;
		this.#http = new ProviderHTTP(io, {
			provider: "Stripe",
			baseUrl,
			headers: { Authorization: `Bearer ${key}`, "Stripe-Version": API_VERSION },
			classify,
		});
	}

	async close(): Promise<void> {
		await this.#http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.#http.unexpected(cause);
	}

	get testMode(): boolean {
		return this.key.startsWith("rk_test_");
	}

	async #get<T>(schema: z.ZodType<T>, path: string, query: Params = {}): Promise<T> {
		const response = await this.#http.bounded(
			{ method: "GET", path, query: params(query) },
			MAX_RESPONSE,
			new OperationError("RESPONSE_TOO_LARGE", "Stripe's response was too large to read."),
		);
		let data: Json;
		try {
			data = parseJson(fromUtf8Strict(new Uint8Array(await response.arrayBuffer())));
		} catch (error) {
			throw this.unexpected(error);
		}
		const result = await schema.safeParseAsync(data);
		if (!result.success) throw this.unexpected(result.error);
		return result.data;
	}

	account(): Promise<Account> {
		return this.#get(Account, "/account");
	}

	async customer(customerId: string): Promise<Customer> {
		const found = await this.#get(Customer, `/customers/${customerId}`);
		if (found.id !== customerId) throw this.unexpected();
		return found;
	}

	customers(options: { email?: string | null; limit: number; cursor?: string | null }): Promise<Page<Customer>> {
		return this.#get(Page(Customer), "/customers", { email: options.email, limit: options.limit, starting_after: options.cursor });
	}

	searchCustomers(query: string, options: { limit: number; page?: string | null }): Promise<Page<Customer>> {
		return this.#get(Page(Customer), "/customers/search", { query, limit: options.limit, page: options.page });
	}

	async charge(chargeId: string): Promise<Charge> {
		const found = await this.#get(Charge, `/charges/${chargeId}`);
		if (found.id !== chargeId) throw this.unexpected();
		return found;
	}

	charges(options: { customer: string | null; limit: number; cursor: string | null }): Promise<Page<Charge>> {
		return this.#get(Page(Charge), "/charges", { customer: options.customer, limit: options.limit, starting_after: options.cursor });
	}

	invoices(options: { customer: string | null; status: string | null; limit: number; cursor: string | null }): Promise<Page<Invoice>> {
		return this.#get(Page(Invoice), "/invoices", {
			customer: options.customer,
			status: options.status,
			limit: options.limit,
			starting_after: options.cursor,
		});
	}

	subscriptions(options: { customer: string | null; status: string | null; limit: number; cursor: string | null }): Promise<Page<Subscription>> {
		return this.#get(Page(Subscription), "/subscriptions", {
			customer: options.customer,
			status: options.status,
			limit: options.limit,
			starting_after: options.cursor,
		});
	}

	refund(options: { charge: string; amount: number; reason: string | null }): Promise<Refund> {
		const form: { [name: string]: string } = { charge: options.charge, amount: String(options.amount) };
		if (options.reason !== null) form.reason = options.reason;
		form["metadata[created_by]"] = "minerva";
		return this.#http.parsed({ method: "POST", path: "/refunds", form }, Refund);
	}

	credit(options: { customer: string; amount: number; currency: string; description: string }): Promise<BalanceTransaction> {
		return this.#http.parsed(
			{
				method: "POST",
				path: `/customers/${options.customer}/balance_transactions`,
				form: { amount: String(-options.amount), currency: options.currency, description: options.description },
			},
			BalanceTransaction,
		);
	}
}
