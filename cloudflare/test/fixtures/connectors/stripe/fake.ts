// backend/tests/test_stripe.py's FakeStripe behind an injected `fetch`: the Stripe API for one account.
// Customers: Ada and Grace (USD), Eve (no currency yet) and a deleted one. Charges belong to Ada, Grace, or
// no customer (a guest payment). Ids and addresses are made up; addresses use reserved example domains.

import { StripeClient } from "../../../../src/connectors/stripe/client.ts";
import { settingsIo } from "../../../../src/gateway/http.ts";
import type { Json } from "../../../../src/lib/json.ts";

export const KEY = `rk_test_${"a".repeat(24)}`;
export const LIVE_KEY = `rk_live_${"b".repeat(24)}`;
export const OTHER_KEY = `rk_test_${"c".repeat(24)}`;
export const SECRET = "SECRET merger";
export const ADA = "cus_ada";
export const GRACE = "cus_grace";
export const GONE = "cus_gone";
export const EVE = "cus_eve";

export type StripeObject = { [key: string]: Json };

export function charge(id: string, customer: string | null, amount: number, fields: StripeObject = {}): StripeObject {
	return {
		id,
		object: "charge",
		amount,
		amount_captured: amount,
		amount_refunded: 0,
		captured: true,
		paid: true,
		refunded: false,
		disputed: false,
		status: "succeeded",
		currency: "usd",
		customer,
		created: 1790000000,
		description: "Order",
		receipt_url: "https://pay.stripe.example/receipts/secret",
		billing_details: { name: "Ada", email: "ada@example.com" },
		payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
		...fields,
	};
}

function json(status: number, body: Json): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A request as the fake saw it. */
export interface Seen {
	method: string;
	url: URL;
	headers: Headers;
	body: string;
}

export type Hook = (method: string, path: string, params: URLSearchParams) => Response | null;

/** `urllib.parse.parse_qs` as the Python fake reads a form: blank values dropped, the first of each kept. */
function parseForm(body: string): { [name: string]: string } {
	const form: { [name: string]: string } = {};
	for (const [name, value] of new URLSearchParams(body)) if (value !== "" && !Object.hasOwn(form, name)) form[name] = value;
	return form;
}

export class FakeStripe {
	accounts = new Map<string, string>([
		[KEY, "acct_1"],
		[LIVE_KEY, "acct_1"],
		[OTHER_KEY, "acct_2"],
	]);
	customers: { [id: string]: StripeObject } = {
		[ADA]: { id: ADA, name: "Ada Lovelace", email: "ada@example.com", currency: "usd", balance: 0 },
		[GRACE]: { id: GRACE, name: "Grace Hopper", email: "grace@example.com", currency: "usd" },
		[EVE]: { id: EVE, name: null, email: "eve@example.com", currency: null },
		[GONE]: { id: GONE, deleted: true },
	};
	charges: { [id: string]: StripeObject } = {
		ch_ada1: charge("ch_ada1", ADA, 5000),
		ch_ada2: charge("ch_ada2", ADA, 30000),
		ch_grace: charge("ch_grace", GRACE, 2000, { description: SECRET }),
		ch_guest: charge("ch_guest", null, 1000),
		ch_disputed: charge("ch_disputed", ADA, 1000, { disputed: true }),
		ch_eur: charge("ch_eur", ADA, 1000, { currency: "eur" }),
		ch_yen: charge("ch_yen", ADA, 4000, { currency: "jpy" }),
	};
	invoices: { [id: string]: StripeObject } = {
		in_ada: {
			id: "in_ada",
			customer: ADA,
			status: "open",
			currency: "usd",
			total: 1250,
			amount_due: 1250,
			hosted_invoice_url: "https://invoice.stripe.example/secret",
		},
		in_grace: { id: "in_grace", customer: GRACE, status: "paid", currency: "usd", total: 99 },
	};
	subscriptions: { [id: string]: StripeObject } = {
		sub_ada: {
			id: "sub_ada",
			customer: ADA,
			status: "active",
			currency: "usd",
			items: {
				data: [
					{
						quantity: 1,
						current_period_end: 1792000000,
						price: { id: "price_1", product: "prod_1", unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } },
					},
				],
			},
		},
	};
	requests: Seen[] = [];
	writes: [path: string, form: { [name: string]: string }][] = [];
	hook: Hook | null = null;

	static error(status: number, kind: string, code: string | null = null): Response {
		return json(status, { error: { type: kind, code, message: SECRET } });
	}

	#page(objects: StripeObject[], params: URLSearchParams): Json {
		let start = 0;
		const after = params.get("starting_after");
		if (after) {
			const index = objects.findIndex((object) => object.id === after);
			if (index < 0) throw new Error(`No object ${after}`);
			start = index + 1;
		}
		const size = Number(params.get("limit") ?? 10);
		return { object: "list", data: objects.slice(start, start + size), has_more: start + size < objects.length };
	}

	#search(params: URLSearchParams): Json {
		const value = (params.get("query") as string).split('"')[1] as string;
		const found = Object.values(this.customers).filter(
			(customer) => !customer.deleted && (String(customer.email ?? "").includes(value) || String(customer.name ?? "").includes(value)),
		);
		const start = Number(params.get("page") ?? "0");
		const size = Number(params.get("limit"));
		const more = start + size < found.length;
		return { data: found.slice(start, start + size), has_more: more, next_page: more ? String(start + size) : null };
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const body = await request.text();
		this.requests.push({ method: request.method, url, headers: request.headers, body });
		const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		if (!this.accounts.has(key)) return FakeStripe.error(401, "invalid_request_error");
		const path = url.pathname.replace(/^\/v1/, "");
		const params = url.searchParams;
		const hooked = this.hook?.(request.method, path, params) ?? null;
		if (hooked !== null) return hooked;
		if (request.method === "POST") {
			const form = parseForm(body);
			this.writes.push([path, form]);
			return this.#write(path, form);
		}
		const customer = params.get("customer");
		const mine = (objects: StripeObject[]) => objects.filter((object) => customer === null || object.customer === customer);
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (parts.length === 1 && parts[0] === "account") {
			return json(200, { id: this.accounts.get(key) as string, email: "billing@example.com", default_currency: "usd", business_profile: { name: "Acme" } });
		}
		if (parts.length === 1 && parts[0] === "customers") {
			let listed = Object.values(this.customers).filter((found) => !found.deleted);
			const email = params.get("email");
			if (email) listed = listed.filter((found) => found.email === email);
			return json(200, this.#page(listed, params));
		}
		if (parts.length === 2 && parts[0] === "customers" && parts[1] === "search") return json(200, this.#search(params));
		if (parts.length === 2 && parts[0] === "customers") {
			const found = this.customers[parts[1] as string];
			return found === undefined ? FakeStripe.error(404, "invalid_request_error", "resource_missing") : json(200, found);
		}
		if (parts.length === 1 && parts[0] === "charges") return json(200, this.#page(mine(Object.values(this.charges)), params));
		if (parts.length === 2 && parts[0] === "charges") {
			const found = this.charges[parts[1] as string];
			return found === undefined ? FakeStripe.error(404, "invalid_request_error", "resource_missing") : json(200, found);
		}
		if (parts.length === 1 && parts[0] === "invoices") {
			const status = params.get("status");
			const listed = mine(Object.values(this.invoices)).filter((invoice) => status === null || invoice.status === status);
			return json(200, this.#page(listed, params));
		}
		if (parts.length === 1 && parts[0] === "subscriptions") return json(200, this.#page(mine(Object.values(this.subscriptions)), params));
		throw new Error(`Unexpected path ${path}`);
	};

	#write(path: string, form: { [name: string]: string }): Response {
		if (path === "/refunds") {
			const refunded = this.charges[form.charge as string] as StripeObject;
			refunded.amount_refunded = (refunded.amount_refunded as number) + Number(form.amount);
			return json(200, {
				id: "re_1",
				amount: Number(form.amount),
				currency: refunded.currency as string,
				status: "succeeded",
				charge: refunded.id as string,
				reason: form.reason ?? null,
				created: 1790000100,
			});
		}
		const customerId = path.split("/")[2] as string;
		const customer = this.customers[customerId] as StripeObject;
		customer.currency = (customer.currency as string | null | undefined) || (form.currency as string);
		customer.balance = ((customer.balance as number | undefined) ?? 0) + Number(form.amount);
		return json(200, {
			id: "cbtxn_1",
			customer: customerId,
			amount: Number(form.amount),
			currency: form.currency as string,
			ending_balance: customer.balance,
			description: form.description as string,
			created: 1790000100,
		});
	}

	/** A client outside a run, as the access page and a key's check use it. */
	client(key: string = KEY): StripeClient {
		return new StripeClient(key, settingsIo(this.fetch));
	}

	/** The requests to `path`, in order. */
	requestsTo(path: string): Seen[] {
		return this.requests.filter((seen) => seen.url.pathname === path);
	}
}
