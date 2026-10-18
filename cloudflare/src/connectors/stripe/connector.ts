// Stripe, through its REST API with a restricted key.
// Agents read customers and what is billed to them, refund payments and credit customer balances, each
// within amount caps users choose.
//
// Users connect with a restricted key (`rk_live_` or `rk_test_`) they create in Stripe with only the
// permissions Minerva's operations use (docs/connectors.md), so Stripe limits the key as well as Minerva.
// Secret keys are refused, since they can do anything in the account. The connection is the Stripe account in
// the key's mode: a test key and a live key of one account are two connections, and a key never replaces one
// of the other mode. Minerva reads the account (`GET /v1/account`) to name it, and to suggest its default
// currency.
//
// Customers are one hierarchical kind; a customer's payments, invoices and subscriptions sit inside it (see
// scope.ts). Listings are filtered per object after Stripe has listed them, so a page can come back with
// fewer objects than asked for.
//
// Amounts are a second hierarchical kind, `amount`, whose resources users choose as tiers of a fixed ladder
// per currency (see money.ts): allowing "Up to 50.00 USD" lets each refund or credit be at most that, and a
// workspace ceiling that denies "More than 500.00 USD" refuses larger ones whatever members allow. A refund
// or credit needs its action on both the customer and the amount. Caps are per call: Minerva keeps no budget
// across calls, so each refund or credit is capped but their number is not, in a run or across runs.

import { type Account, type Connector, type DiscoveryItem, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { sliceText } from "../../lib/text.ts";
import { CUSTOMER_ID, type Customer, KEY, SEARCH_PAGE, StripeClient, nextCursor } from "./client.ts";
import * as money from "./money.ts";
import { GET_CUSTOMER, LIST_CUSTOMERS, LIST_INVOICES, LIST_PAYMENTS, LIST_SUBSCRIPTIONS } from "./reads.ts";
import { AMOUNT, CUSTOMER, cursor } from "./scope.ts";
import { CREDIT_CUSTOMER, REFUND_PAYMENT } from "./writes.ts";

export const DESCRIBE_CONCURRENCY = 5;
export const MAX_DESCRIBE = 100;
export const DISCOVER_PAGE = 50;
/** Customer Search takes a quoted value; quotes and backslashes are dropped from what users type. */
const UNQUOTED = /["\\]/g;

function invalidCursor(): OperationError {
	return new OperationError("INVALID_CURSOR", "This cursor is not valid.");
}

function customerName(found: Customer): string {
	if (found.name && found.email) return `${found.name} <${found.email}>`;
	return found.name || found.email || found.id;
}

/** A settings cursor of the customer listing: `l:` and a Stripe object id. */
function listCursor(value: string | null): string | null {
	if (value === null) return null;
	if (!value.startsWith("l:")) throw invalidCursor();
	return cursor(value.slice(2));
}

/** `work` for each item, at most `concurrency` at once, results in the items' order; the first failure stops it. */
async function gathered<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await work(items[index] as T);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

async function describe(client: StripeClient, kind: string, ids: string[]): Promise<{ [id: string]: string }> {
	const names: { [id: string]: string } = {};
	if (kind === AMOUNT) {
		for (const id of ids) {
			const name = money.name(id);
			if (name !== null) names[id] = name;
		}
		return names;
	}
	const wanted = [...new Set(ids)].filter((id) => CUSTOMER_ID.test(id)).slice(0, MAX_DESCRIBE);
	const found = await gathered(wanted, DESCRIBE_CONCURRENCY, async (id): Promise<Customer | null> => {
		try {
			return await client.customer(id);
		} catch (error) {
			if (error instanceof OperationError && error.code === "NOT_FOUND") return null;
			throw error;
		}
	});
	for (const item of found) if (item !== null && !item.deleted) names[item.id] = customerName(item);
	return names;
}

async function search(client: StripeClient, query: string, pageToken: string | null): Promise<DiscoveryPage> {
	const value = sliceText(query.replace(UNQUOTED, "").trim(), 0, 100);
	if (value.length < 3) return { items: [], nextCursor: null };
	if (pageToken !== null && !(pageToken.startsWith("s:") && SEARCH_PAGE.test(pageToken.slice(2)))) throw invalidCursor();
	const page = await client.searchCustomers(`email~"${value}" OR name~"${value}"`, {
		limit: DISCOVER_PAGE,
		page: pageToken ? pageToken.slice(2) : null,
	});
	const items = page.data.filter((found) => CUSTOMER_ID.test(found.id) && !found.deleted).map((found) => ({ id: found.id, name: customerName(found) }));
	const following = page.has_more && page.next_page ? page.next_page : null;
	if (following !== null && !SEARCH_PAGE.test(following)) throw client.unexpected();
	return { items, nextCursor: following ? `s:${following}` : null };
}

async function amounts(client: StripeClient, query: string | null): Promise<DiscoveryPage> {
	let currency: string;
	if (query) {
		try {
			currency = money.currency(query.trim());
		} catch (error) {
			if (!(error instanceof money.MoneyError)) throw error;
			return { items: [], nextCursor: null };
		}
	} else {
		currency = ((await client.account()).default_currency || "usd").toLowerCase();
		if (!money.CURRENCY.test(currency)) currency = "usd";
	}
	return { items: money.choices(currency).map((id): DiscoveryItem => ({ id, name: money.name(id) ?? id })), nextCursor: null };
}

export function stripeConnector(): Connector<StripeClient> {
	return {
		slug: "stripe",
		name: "Stripe",
		kinds: [
			{
				id: CUSTOMER,
				label: "Customer",
				actions: ["read", "refund", "credit"],
				wildcard: true,
				hierarchical: true,
				note: "Access to a customer covers their payments, invoices and subscriptions. Payments without a customer are covered only by allowing every customer.",
			},
			{
				id: AMOUNT,
				label: "Amount",
				actions: ["refund", "credit"],
				wildcard: true,
				hierarchical: true,
				note: 'Each refund or credit also needs its amount allowed: allow "Up to" a limit, or a whole currency. Limits apply to each refund or credit on its own; a run makes only a few writes, but separate runs add up. Search for a currency code, such as eur, to see its limits.',
			},
		],
		actions: [
			{ id: "read", label: "Read" },
			{ id: "refund", label: "Refund payments" },
			{ id: "credit", label: "Credit balances" },
		],
		tenancy: { kind: "account", label: "Stripe account" },
		auth: {
			type: "api_key",
			label: "Restricted API key",
			hint: "Create a restricted key in Stripe (Developers, API keys) with the permissions in Minerva's setup guide. Keys start with rk_live_ or rk_test_.",
		},
		operations: [LIST_CUSTOMERS, GET_CUSTOMER, LIST_PAYMENTS, LIST_INVOICES, LIST_SUBSCRIPTIONS, REFUND_PAYMENT, CREDIT_CUSTOMER],

		client(secret, io) {
			return new StripeClient(secret, io);
		},

		manageLink() {
			return ["Manage keys in Stripe", "https://dashboard.stripe.com/apikeys"];
		},

		async account(client): Promise<Account> {
			if (!KEY.test(client.key)) {
				throw new OperationError("INVALID_KEY", "Use a restricted key from Stripe, which starts with rk_live_ or rk_test_. Secret keys are not accepted.");
			}
			let found: Awaited<ReturnType<StripeClient["account"]>>;
			try {
				found = await client.account();
			} catch (error) {
				if (error instanceof OperationError && error.code === "PROVIDER_FORBIDDEN") {
					throw new OperationError("PROVIDER_FORBIDDEN", "The key cannot read the Stripe account. Give it the permissions in Minerva's setup guide.");
				}
				if (error instanceof OperationError && error.code === "CONNECTION_UNAUTHORIZED") throw new OperationError("INVALID_KEY", "Stripe did not accept this key.");
				throw error;
			}
			const dashboard = found.settings ? found.settings.dashboard : null;
			const label = (found.business_profile ? found.business_profile.name : null) || (dashboard ? dashboard.display_name : null) || found.email || found.id;
			const mode = client.testMode ? "test" : "live";
			// Test-mode and live keys of one account are one tenant.
			return { id: `${found.id}:${mode}`, label: client.testMode ? `${label} (test mode)` : label, tenants: [{ id: found.id, name: label }] };
		},

		async discover(client, kind, { query, cursor: pageCursor }): Promise<DiscoveryPage> {
			if (kind === AMOUNT) return amounts(client, query);
			if (query && CUSTOMER_ID.test(query.trim())) {
				const described = await describe(client, CUSTOMER, [query.trim()]);
				return { items: Object.entries(described).map(([id, name]) => ({ id, name })), nextCursor: null };
			}
			if (query) return search(client, query, pageCursor);
			const page = await client.customers({ limit: DISCOVER_PAGE, cursor: listCursor(pageCursor) });
			const items = page.data.filter((found) => CUSTOMER_ID.test(found.id)).map((found) => ({ id: found.id, name: customerName(found) }));
			const after = nextCursor(page);
			return { items, nextCursor: after ? `l:${after}` : null };
		},

		describe,
	};
}
