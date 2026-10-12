// backend/tests/test_stripe.py, case by case: money.py, the client's error names, the connector's key
// check, discovery and naming, and runs through the executor against FakeStripe behind an injected `fetch`
// (test/fixtures/connectors/stripe/fake.ts). Connecting with a key goes through the Workspace's
// saveConnection after the connector's account(), as the key routes of step 5 will; the routes themselves
// (the key's 1..500 length, a key for a provider without keys, PUT on an OAuth connection) come with them.

import { describe, expect, test } from "vitest";
import type { Caller, ConnectionId } from "../../src/contracts/common.ts";
import type { ConnectionOut } from "../../src/contracts/api.ts";
import type { Outcome } from "../../src/contracts/common.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import type { ToolCallOutcome } from "../../src/contracts/executor.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { classify } from "../../src/connectors/stripe/client.ts";
import { stripeConnector } from "../../src/connectors/stripe/connector.ts";
import * as money from "../../src/connectors/stripe/money.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { KeyRing } from "../../src/lib/fernet.ts";
import type { Json } from "../../src/lib/json.ts";
import { WorkspaceCore } from "../../src/workspace/core.ts";
import { ADA, EVE, FakeStripe, GONE, GRACE, KEY, LIVE_KEY, OTHER_KEY, SECRET } from "../fixtures/connectors/stripe/fake.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";
import {
	ADA as OWNER,
	FakeConversations,
	FakeObjects,
	FakeOAuth,
	FakeTimers,
	KEYS,
	SETTINGS,
	TokenEndpoint,
	WORKSPACE,
	USER as OWNER_ID,
	credentials,
	database,
	nodeSql,
	type Harness,
} from "./workspace-support.ts";

const STRIPE: ConnectionId = "0199a000-0000-7000-8000-0000000000d1";
const registry = await Registry.create([stripeConnector()]);

type Grant = [kind: string, id: string, actions: string[]];

function customer(id: string, actions: string[] = ["read"]): Grant {
	return ["customer", id, actions];
}

function amount(id: string, actions: string[] = ["refund"]): Grant {
	return ["amount", id, actions];
}

/** Starts and claims a run with the user's grants on the Stripe connection (test_stripe.py `start`). */
function start(stripe: FakeStripe, grants: Grant[], ceiling: GrantRow[] = []): Promise<Scenario> {
	return Scenario.start({
		connectors: [stripeConnector()],
		registry,
		connections: [{ id: STRIPE, provider: "stripe", payload: { kind: "api_key", key: KEY } }],
		user: userGrants(STRIPE, "customer", {}, grants),
		ceiling,
		fetch: stripe.fetch,
	});
}

/** connector_runs.py `ceiling`: a grant of the workspace ceiling on the Stripe connection. */
function ceiling(kind: string, resourceId: string, effect: GrantRow["effect"], actions: string[]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: STRIPE, kind, resourceId, resourceName: "", actions, effect };
}

function items(outcome: Extract<ToolCallOutcome, { ok: true }>): { [key: string]: Json }[] {
	return outcome.result.items;
}

function ids(outcome: Extract<ToolCallOutcome, { ok: true }>): Json[] {
	return items(outcome).map((item) => item.id as Json);
}

async function raised(promise: Promise<unknown>): Promise<OperationError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error;
		throw error;
	}
	throw new Error("Nothing was raised.");
}

describe("the declaration", () => {
	test("the registry accepts it, and its fingerprints are pinned", async () => {
		expect(() => validate([stripeConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(stripeConnector().operations.map((op) => [op.name, registry.contract("stripe", op.name)]));
		console.log("stripe fingerprints", fingerprints);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({
			list_customers: "725187553a3e6b83",
			get_customer: "540f6431d0407dd7",
			list_payments: "7a22a12cc6e5a2d0",
			list_invoices: "75f0e77395dac680",
			list_subscriptions: "2c4d64a5714ed232",
			refund_payment: "1ed8cb355fac0689",
			credit_customer: "80e367d7f8cf45c7",
		});
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("stripe");
		const served = await connectorRegistry();
		expect(served.get("stripe").operations.map((op) => op.name)).toEqual(registry.get("stripe").operations.map((op) => op.name));
		for (const op of served.get("stripe").operations) expect(served.contract("stripe", op.name)).toBe(registry.contract("stripe", op.name));
	});

	test("keys are managed in Stripe", () => {
		expect(stripeConnector().manageLink?.()).toEqual(["Manage keys in Stripe", "https://dashboard.stripe.com/apikeys"]);
	});
});

// Money

describe("money", () => {
	test("amounts are exact in the smallest unit", () => {
		expect(money.parse("12.5", "usd")).toBe(1250);
		expect(money.parse("12.50", "eur")).toBe(1250);
		expect(money.parse("1500", "jpy")).toBe(1500);
		expect(money.parse("1.25", "kwd")).toBe(1250);
		expect(money.parse("5000", "ugx")).toBe(500000);
		expect(money.parse("5", "isk")).toBe(500);
		for (const [value, currency] of [
			["12.555", "usd"],
			["1.5", "jpy"],
			["1.255", "kwd"],
			["5.5", "ugx"],
			["0", "usd"],
			["-1", "usd"],
			["1e3", "usd"],
			["1,50", "usd"],
			["1000000", "usd"],
			["NaN", "usd"],
		] as const) {
			expect(() => money.parse(value, currency)).toThrow(money.MoneyError);
		}
		expect(money.display(1250, "usd")).toBe("12.50 USD");
		expect(money.display(1500, "jpy")).toBe("1500 JPY");
		expect(money.display(1250, "kwd")).toBe("1.250 KWD");
		expect(money.display(500000, "ugx")).toBe("5000 UGX");
	});

	test("amounts sit inside every tier that covers them", () => {
		expect(money.ancestors("usd", 5000)).toEqual([
			...[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((t) => `usd<=${t}`),
			"usd>20",
			"usd>10",
			"usd>5",
			"usd>2",
			"usd>1",
			"usd",
		]);
		expect(money.ancestors("usd", 5001).slice(0, 2)).toEqual(["usd<=100", "usd<=200"]);
		expect(money.ancestors("usd", 5001)).toContain("usd>50");
		expect(money.ancestors("usd", 5000)).not.toContain("usd>50");
		expect(money.ancestors("jpy", 4000)[0]).toBe("jpy<=5000");
		expect(money.ancestors("ugx", 500000)[0]).toBe("ugx<=5000");
		expect(money.name("ugx<=5000")).toBe("Up to 5000 UGX");
		expect(money.ancestors("usd", 2_000_000)).toEqual([...[...money.LADDER].reverse().map((t) => `usd>${t}`), "usd"]);
		expect(money.ancestors("usd", 1).length).toBeLessThanOrEqual(64);
		expect(money.name("usd<=50")).toBe("Up to 50.00 USD");
		expect(money.name("jpy>1000")).toBe("More than 1000 JPY");
		expect(money.name("eur")).toBe("Any amount in EUR");
		for (const unnamed of ["usd<=3", "usd=5000", "usd<=050", "USD", "usd<=50 ", "*"]) expect(money.name(unnamed)).toBeNull();
	});
});

// Client

describe("the client", () => {
	test("Stripe's errors are named without its wording", () => {
		const named = (status: number, kind: string, code: string | null = null) => {
			const response = FakeStripe.error(status, kind, code);
			return classify("Stripe", response, JSON.stringify({ error: { type: kind, code, message: SECRET } }));
		};
		expect(named(403, "permission_error")?.code).toBe("PROVIDER_FORBIDDEN");
		expect(named(403, "permission_error")?.message).toContain("permissions");
		expect(named(404, "invalid_request_error", "resource_missing")?.code).toBe("NOT_FOUND");
		const refused = named(400, "invalid_request_error", "charge_already_refunded");
		expect(refused?.code).toBe("PROVIDER_REJECTED");
		expect(refused?.message).toContain("refunded in full");
		expect(named(400, "invalid_request_error", "parameter_unknown")?.message.endsWith("(parameter_unknown).")).toBe(true);
		expect(named(400, "invalid_request_error", "Not A Code<script>")).toBeNull();
		expect(named(401, "invalid_request_error")).toBeNull();
		for (const error of [named(403, "permission_error"), refused]) expect(error?.message).not.toContain(SECRET);
	});

	test("responses Minerva cannot read or place are refused", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer("*")]);
		// A charge without its customer field cannot be placed.
		delete (stripe.charges.ch_ada1 as { customer?: Json }).customer;
		expect(await run.error("stripe_list_payments", {})).toEqual({ code: "PROVIDER_FAILED", message: "Stripe returned an unexpected response." });
		(stripe.charges.ch_ada1 as { customer: Json }).customer = "not a customer";
		expect(await run.error("stripe_list_payments", {})).toEqual({ code: "PROVIDER_FAILED", message: "Stripe returned an unexpected response." });
		(stripe.charges.ch_ada1 as { customer: Json }).customer = ADA;
		// Nor can an object whose id is not one.
		stripe.charges = { "ch_ada1-x": { ...(stripe.charges.ch_ada1 as object), id: "ch_ada1-x" }, ch_ada2: stripe.charges.ch_ada2 as never };
		expect(await run.error("stripe_list_payments", { limit: 1 })).toEqual({ code: "PROVIDER_FAILED", message: "Stripe returned an unexpected response." });
		// A customer of such an id is left out, and no next page is built after it.
		stripe.customers = { "cus_odd-1": { id: "cus_odd-1" }, [ADA]: stripe.customers[ADA] as never };
		expect(await run.error("stripe_list_customers", { limit: 1 })).toEqual({ code: "PROVIDER_LIMIT", message: "Stripe returned an id Minerva does not accept." });
		expect(items(await run.ok("stripe_list_customers", { limit: 2 }))).toHaveLength(1);
		// More than Minerva reads.
		stripe.hook = () => new Response(`{"data": [], "pad": "${"x".repeat(4 * 1024 * 1024)}"}`, { status: 200 });
		expect(await run.error("stripe_list_invoices", {})).toEqual({ code: "RESPONSE_TOO_LARGE", message: "Stripe's response was too large to read." });
		// Invalid UTF-8.
		stripe.hook = () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 });
		expect(await run.error("stripe_list_invoices", {})).toEqual({ code: "PROVIDER_FAILED", message: "Stripe returned an unexpected response." });
		// A cursor that is not Stripe's never reaches it.
		stripe.hook = null;
		expect(await run.error("stripe_list_customers", { cursor: "cus_ada" })).toEqual({ code: "INVALID_CURSOR", message: "This page token is invalid or belongs to another request." });
	});

	test("only restricted keys reach Stripe", async () => {
		const stripe = new FakeStripe();
		const connector = stripeConnector();
		for (const key of [`sk_test_${"a".repeat(24)}`, "rk_test_short", `pk_live_${"a".repeat(24)}`, `rk_prod_${"a".repeat(24)}`]) {
			const error = await raised(connector.account(stripe.client(key)));
			expect(error.code).toBe("INVALID_KEY");
			expect(error.message).not.toContain(key);
		}
		expect(stripe.requests).toEqual([]);
		const testMode = await connector.account(stripe.client(KEY));
		const live = await connector.account(stripe.client(LIVE_KEY));
		expect([testMode.id, testMode.label]).toEqual(["acct_1:test", "Acme (test mode)"]);
		expect([live.id, live.label]).toEqual(["acct_1:live", "Acme"]);
		expect(stripe.requests[0]?.headers.get("Stripe-Version")).toBe("2025-08-27.basil");
		expect(stripe.requests[0]?.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
		expect(stripe.requests[0]?.url.href).toBe("https://api.stripe.com/v1/account");
		// A key Stripe does not know.
		const unknown = await raised(connector.account(stripe.client(`rk_live_${"z".repeat(24)}`)));
		expect([unknown.code, unknown.message]).toEqual(["INVALID_KEY", "Stripe did not accept this key."]);
		stripe.hook = () => FakeStripe.error(403, "permission_error");
		const forbidden = await raised(connector.account(stripe.client(KEY)));
		expect(forbidden.code).toBe("PROVIDER_FORBIDDEN");
		expect(forbidden.message).toContain("read the Stripe account");
	});
});

// Discovery

describe("discovery", () => {
	test("customers and amounts are discovered and described", async () => {
		const stripe = new FakeStripe();
		const connector = stripeConnector();
		const client = stripe.client();
		const page = await connector.discover(client, "customer", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[ADA, "Ada Lovelace <ada@example.com>"],
			[GRACE, "Grace Hopper <grace@example.com>"],
			[EVE, "eve@example.com"],
		]);
		expect(page.nextCursor).toBeNull();
		let found = await connector.discover(client, "customer", { query: 'hop"per', cursor: null });
		expect(found.items).toEqual([]);
		expect(stripe.requests.at(-1)?.url.searchParams.get("query")).toBe('email~"hopper" OR name~"hopper"');
		found = await connector.discover(client, "customer", { query: "example.com", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([ADA, GRACE, EVE]);
		const byId = await connector.discover(client, "customer", { query: GRACE, cursor: null });
		expect(byId.items.map((item) => item.id)).toEqual([GRACE]);
		for (const cursor of ["s:x y", "cus_1", "l:bad id"]) {
			expect((await raised(connector.discover(client, "customer", { query: null, cursor }))).code).toBe("INVALID_CURSOR");
		}
		expect(await connector.describe(client, "customer", [ADA, GONE, "cus_missing", "ch_ada1", "*"])).toEqual({ [ADA]: "Ada Lovelace <ada@example.com>" });

		const amounts = await connector.discover(client, "amount", { query: null, cursor: null });
		expect(amounts.items[0]?.id).toBe("usd");
		expect(amounts.items[1]?.name).toBe("Up to 1.00 USD");
		const euros = new Set((await connector.discover(client, "amount", { query: "EUR", cursor: null })).items.map((item) => item.id));
		for (const id of ["eur", "eur<=50", "eur>500"]) expect(euros.has(id)).toBe(true);
		expect((await connector.discover(client, "amount", { query: "euros", cursor: null })).items).toEqual([]);
		expect(await connector.describe(client, "amount", ["usd<=50", "usd=5000", "jpy>100", "usd<=7"])).toEqual({
			"usd<=50": "Up to 50.00 USD",
			"jpy>100": "More than 100 JPY",
		});
	});

	test("customer pages carry Stripe's cursors, which the settings page sends back", async () => {
		const stripe = new FakeStripe();
		const connector = stripeConnector();
		const client = stripe.client();
		for (let i = 0; i < 60; i++) stripe.customers[`cus_x${i}`] = { id: `cus_x${i}`, name: `Extra ${i}`, email: null };
		const first = await connector.discover(client, "customer", { query: null, cursor: null });
		expect(first.items).toHaveLength(50);
		expect(first.nextCursor).toBe(`l:${first.items[49]?.id}`);
		const second = await connector.discover(client, "customer", { query: null, cursor: first.nextCursor ?? null });
		expect(second.items).toHaveLength(13);
		expect(second.nextCursor).toBeNull();
		expect(stripe.requestsTo("/v1/customers").map((seen) => seen.url.searchParams.get("starting_after"))).toEqual([null, first.items[49]?.id]);
		// Search pages go on from Stripe's page token.
		const searched = await connector.discover(client, "customer", { query: "Extra", cursor: null });
		expect(searched.nextCursor).toBe("s:50");
		const next = await connector.discover(client, "customer", { query: "Extra", cursor: searched.nextCursor ?? null });
		expect(next.items).toHaveLength(10);
		expect(stripe.requestsTo("/v1/customers/search").at(-1)?.url.searchParams.get("page")).toBe("50");
		// A search shorter than three characters asks nothing.
		const before = stripe.requests.length;
		expect(await connector.discover(client, "customer", { query: ' "a" ', cursor: null })).toEqual({ items: [], nextCursor: null });
		expect(stripe.requests.length).toBe(before);
	});
});

// Reads

describe("reads", () => {
	test("listings show only allowed customers", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA)]);
		expect(ids(await run.ok("stripe_list_customers", {}))).toEqual([ADA]);
		const payments = items(await run.ok("stripe_list_payments", {}));
		expect(payments.map((payment) => payment.id)).toEqual(["ch_ada1", "ch_ada2", "ch_disputed", "ch_eur", "ch_yen"]);
		expect([payments[0]?.amount, payments[0]?.refundable]).toEqual(["50.00", "50.00"]);
		expect(payments.at(-1)?.amount).toBe("4000");
		expect(payments[0]?.card_last4).toBe("4242");
		expect(payments[0]).not.toHaveProperty("receipt_url");
		expect(JSON.stringify(payments)).not.toContain(SECRET);
		const invoices = items(await run.ok("stripe_list_invoices", {}));
		expect(invoices.map((invoice) => invoice.id)).toEqual(["in_ada"]);
		expect(invoices[0]?.amount_due).toBe("12.50");
		expect(invoices[0]).not.toHaveProperty("hosted_invoice_url");
		const subscriptions = items(await run.ok("stripe_list_subscriptions", { customer: ADA }));
		expect(subscriptions).toHaveLength(1);
		expect((subscriptions[0]?.items as { [key: string]: Json }[])[0]?.unit_amount).toBe("9.00");
		expect(await run.code("stripe_list_payments", { customer: GRACE })).toBe("POLICY_DENIED");
		expect(await run.code("stripe_get_customer", { customer: GRACE })).toBe("POLICY_DENIED");
		expect(await run.code("stripe_get_customer", { customer: "ada" })).toBe("INVALID_ARGUMENTS");
		expect(items(await run.ok("stripe_get_customer", { customer: ADA }))[0]?.balance).toBe("0.00");
	});

	test("guest payments need every customer", async () => {
		const stripe = new FakeStripe();
		let run = await start(stripe, [customer(ADA), customer(GRACE)]);
		expect(ids(await run.ok("stripe_list_payments", {}))).not.toContain("ch_guest");
		run = await start(stripe, [customer("*")]);
		expect(ids(await run.ok("stripe_list_payments", {}))).toContain("ch_guest");
		expect(await run.code("stripe_get_customer", { customer: GONE })).toBe("POLICY_DENIED");
		expect(await run.code("stripe_get_customer", { customer: "cus_missing" })).toBe("POLICY_DENIED");
	});

	test("customer lists page with run-bound cursors", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer("*")]);
		const first = await run.ok("stripe_list_customers", { limit: 2 });
		expect(ids(first)).toEqual([ADA, GRACE]);
		const cursor = first.result.next_cursor;
		expect(cursor).toBeDefined();
		expect(cursor).not.toBe(GRACE);
		const second = await run.ok("stripe_list_customers", { limit: 2, cursor: cursor as string });
		expect(ids(second)).toEqual([EVE]);
		expect(second.result).not.toHaveProperty("next_cursor");
		expect(stripe.requestsTo("/v1/customers").map((seen) => seen.url.searchParams.get("starting_after"))).toEqual([null, GRACE]);
	});

	test("a lookup by address does not hint at hidden customers", async () => {
		const stripe = new FakeStripe();
		(stripe.customers[GRACE] as { email: string }).email = "ada@example.com";
		const run = await start(stripe, [customer(EVE)]);
		for (const address of ["ada@example.com", "nobody@example.com"]) {
			const outcome = await run.ok("stripe_list_customers", { email: address, limit: 1 });
			expect(outcome.result).toEqual({ items: [], count: 0 });
		}
	});
});

// Refunds

function refund(payment: string, value: string, currency = "usd", fields: { [key: string]: Json } = {}): { [key: string]: Json } {
	return { payment, amount: value, currency, ...fields };
}

describe("refunds", () => {
	test("refunds are capped by amount", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA, ["read", "refund"]), amount("usd<=50")]);
		const [refunded] = items(await run.ok("stripe_refund_payment", refund("ch_ada2", "50", "usd", { reason: "requested_by_customer" })));
		expect(refunded).toEqual({
			id: "re_1",
			payment: "ch_ada2",
			amount: "50.00",
			currency: "usd",
			status: "succeeded",
			reason: "requested_by_customer",
			created: 1790000100,
		});
		expect(stripe.writes).toEqual([["/refunds", { charge: "ch_ada2", amount: "5000", reason: "requested_by_customer", "metadata[created_by]": "minerva" }]]);
		expect(stripe.requestsTo("/v1/refunds")[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		// As httpx encodes the form.
		expect(stripe.requestsTo("/v1/refunds")[0]?.body).toBe("charge=ch_ada2&amount=5000&reason=requested_by_customer&metadata%5Bcreated_by%5D=minerva");
		expect(await run.code("stripe_refund_payment", refund("ch_ada2", "50.01"))).toBe("POLICY_DENIED");
		expect(await run.code("stripe_refund_payment", refund("ch_ada2", "5", "eur"))).toBe("POLICY_DENIED");
		expect(await run.code("stripe_refund_payment", refund("ch_grace", "5"))).toBe("POLICY_DENIED");
		expect(await run.code("stripe_refund_payment", refund("ch_guest", "5"))).toBe("POLICY_DENIED");
		expect(await run.code("stripe_refund_payment", refund("ch_missing", "5"))).toBe("POLICY_DENIED");
		for (const bad of [refund("ch_ada2", "5.001"), refund("ch_ada2", "5", "us"), refund("ch_ada2", "5", "usd", { reason: "fraudulent" })]) {
			expect(await run.code("stripe_refund_payment", bad)).toBe("INVALID_ARGUMENTS");
		}
		expect(stripe.writes).toHaveLength(1);
	});

	test("a refund needs read and refund on the customer", async () => {
		const stripe = new FakeStripe();
		let run = await start(stripe, [customer(ADA, ["refund"]), amount("usd")]);
		expect(await run.code("stripe_refund_payment", refund("ch_ada1", "5"))).toBe("UNKNOWN_OPERATION");
		run = await start(stripe, [customer(ADA, ["read", "refund"]), customer(GRACE, ["refund"]), amount("usd")]);
		expect(await run.code("stripe_refund_payment", refund("ch_grace", "5"))).toBe("POLICY_DENIED");
		run = await start(stripe, [customer(ADA), amount("usd")]);
		expect(await run.code("stripe_refund_payment", refund("ch_ada1", "5"))).toBe("UNKNOWN_OPERATION");
		run = await start(stripe, [customer(ADA, ["read", "refund"])]);
		expect(await run.code("stripe_refund_payment", refund("ch_ada1", "5"))).toBe("UNKNOWN_OPERATION");
		expect(stripe.writes).toEqual([]);
	});

	test("a ceiling denies larger amounts whatever users allow", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer("*", ["read", "refund"]), amount("*")], [ceiling("amount", "usd>100", "deny", ["refund"])]);
		expect(await run.code("stripe_refund_payment", refund("ch_ada2", "100.01"))).toBe("POLICY_DENIED");
		await run.ok("stripe_refund_payment", refund("ch_ada2", "100"));
		await run.ok("stripe_refund_payment", refund("ch_guest", "10"));
		await run.ok("stripe_refund_payment", refund("ch_yen", "4000", "jpy"));
		expect(stripe.writes.map(([, form]) => form.amount)).toEqual(["10000", "1000", "4000"]);
	});

	test("refunds are checked against the payment before sending", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA, ["read", "refund"]), amount("*")]);
		expect(await run.error("stripe_refund_payment", refund("ch_eur", "5"))).toEqual({
			code: "CURRENCY_MISMATCH",
			message: "This is in EUR. Give the amount and currency in EUR.",
		});
		expect(await run.error("stripe_refund_payment", refund("ch_ada1", "50.01"))).toEqual({
			code: "REFUND_REFUSED",
			message: "Only 50.00 USD of this payment is left to refund.",
		});
		expect(await run.error("stripe_refund_payment", refund("ch_disputed", "1"))).toEqual({
			code: "REFUND_REFUSED",
			message: "This payment is disputed; Stripe does not refund disputed payments.",
		});
		(stripe.charges.ch_ada1 as { amount_refunded: number }).amount_refunded = 5000;
		expect(await run.error("stripe_refund_payment", refund("ch_ada1", "1"))).toEqual({ code: "REFUND_REFUSED", message: "This payment is already refunded in full." });
		(stripe.charges.ch_ada2 as { status: string }).status = "pending";
		expect(await run.error("stripe_refund_payment", refund("ch_ada2", "1"))).toEqual({
			code: "REFUND_REFUSED",
			message: "Only a successful, captured payment can be refunded.",
		});
		const calls: string[] = [];
		stripe.hook = (_method, path) => {
			if (path === "/charges/ch_eur") {
				calls.push(path);
				if (calls.length === 2) (stripe.charges.ch_eur as { customer: string }).customer = GRACE;
			}
			return null;
		};
		expect(await run.error("stripe_refund_payment", refund("ch_eur", "5", "eur"))).toEqual({
			code: "PAYMENT_CHANGED",
			message: "This payment changed since it was checked. Try again.",
		});
		expect(stripe.writes).toEqual([]);
		// Each refused write was forgotten, so none pauses the run.
		expect(run.writes()).toEqual([]);
	});

	test("a refund whose answer cannot be read was still applied", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA, ["read", "refund"]), amount("*")]);
		stripe.hook = (method) => (method === "POST" ? new Response("<html>", { status: 200 }) : null);
		const first = await run.ok("stripe_refund_payment", refund("ch_ada1", "5"));
		expect(first.result).toEqual({ items: [], count: 0, outcome: "applied_without_result" });
		// Remembered as a success: the same refund is not sent again.
		const again = await run.ok("stripe_refund_payment", refund("ch_ada1", "5"));
		expect(again.repeat).toBe(true);
		expect(stripe.requestsTo("/v1/refunds")).toHaveLength(1);
	});

	test("Stripe refusing a refund is not applied", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA, ["read", "refund"]), amount("*")]);
		stripe.hook = (method) => (method === "POST" ? FakeStripe.error(400, "invalid_request_error", "charge_already_refunded") : null);
		const error = await run.error("stripe_refund_payment", refund("ch_ada1", "5"));
		expect(error.code).toBe("PROVIDER_REJECTED");
		expect(error.message).not.toContain(SECRET);
		stripe.hook = null;
		await run.ok("stripe_refund_payment", refund("ch_ada1", "5"));
	});
});

// Credits

function credit(customerId: string, value: string, currency = "usd"): { [key: string]: Json } {
	return { customer: customerId, amount: value, currency, description: "Sorry for the outage" };
}

describe("credits", () => {
	test("credits are capped and match the customer's currency", async () => {
		const stripe = new FakeStripe();
		let run = await start(stripe, [customer(ADA, ["read", "credit"]), customer(EVE, ["read", "credit"]), amount("usd<=20", ["credit"])]);
		const [credited] = items(await run.ok("stripe_credit_customer", credit(ADA, "20")));
		expect([credited?.credit, credited?.ending_balance]).toEqual(["20.00", "-20.00"]);
		expect(stripe.writes.at(-1)).toEqual([`/customers/${ADA}/balance_transactions`, { amount: "-2000", currency: "usd", description: "Sorry for the outage" }]);
		expect(stripe.requestsTo(`/v1/customers/${ADA}/balance_transactions`)[0]?.body).toBe("amount=-2000&currency=usd&description=Sorry+for+the+outage");
		expect(await run.code("stripe_credit_customer", credit(ADA, "20.01"))).toBe("POLICY_DENIED");
		expect(await run.code("stripe_credit_customer", credit(GRACE, "1"))).toBe("POLICY_DENIED");
		(stripe.customers[ADA] as { currency: string }).currency = "eur";
		run = await start(stripe, [customer("*", ["read", "credit"]), amount("*", ["credit"])]);
		expect(await run.code("stripe_credit_customer", credit(ADA, "1"))).toBe("CURRENCY_MISMATCH");
		expect(await run.code("stripe_credit_customer", credit(GONE, "1"))).toBe("POLICY_DENIED");
		const bad = { ...credit(ADA, "1", "eur"), description: "a\nb" };
		expect(await run.code("stripe_credit_customer", bad)).toBe("INVALID_ARGUMENTS");
		await run.ok("stripe_credit_customer", credit(EVE, "1000", "jpy"));
		expect(stripe.writes.at(-1)?.[1].amount).toBe("-1000");
		expect(stripe.customers[EVE]?.currency).toBe("jpy");
		run = await start(stripe, [customer(ADA, ["read", "refund"]), amount("*", ["refund", "credit"])]);
		expect(await run.code("stripe_credit_customer", credit(ADA, "1", "eur"))).toBe("UNKNOWN_OPERATION");
	});

	test("an identical credit in a run is answered from its record", async () => {
		const stripe = new FakeStripe();
		const run = await start(stripe, [customer(ADA, ["read", "credit"]), amount("usd", ["credit"])]);
		const first = await run.ok("stripe_credit_customer", credit(ADA, "5"));
		// The same normalized arguments: the amount is a string as given, the currency lowercased.
		const again = await run.ok("stripe_credit_customer", { ...credit(ADA, "5", " USD "), customer: ` ${ADA} ` });
		expect(again.repeat).toBe(true);
		expect(again.result).toEqual(first.result);
		expect(stripe.writes).toHaveLength(1);
		// "5.00" is another write, as today's key is over the normalized fields.
		await run.ok("stripe_credit_customer", credit(ADA, "5.00"));
		expect(stripe.writes).toHaveLength(2);
	});
});

// Connecting with a key

/** The Workspace's core over node:sqlite with only the Stripe connector. */
async function workspace(): Promise<Pick<Harness, "core" | "sql" | "keys">> {
	const db = database();
	const sql = nodeSql(db);
	const keys = await KeyRing.parse(KEYS);
	const timers = new FakeTimers();
	const core = new WorkspaceCore({
		sql,
		timers,
		keys,
		registry,
		settings: SETTINGS,
		conversations: new FakeConversations(),
		objects: new FakeObjects(),
		oauth: new FakeOAuth(),
		fetch: new TokenEndpoint().fetch,
		log: () => {},
	});
	await core.init({ workspace: { id: WORKSPACE, jurisdiction: null }, kind: "personal", ownerId: OWNER_ID, createdAt: timers.now() });
	return { core, sql, keys };
}

/**
 * connections/services.py `save_api_key` and `save_connection`, as the key routes will call them: the
 * account from the connector with the new key (its errors are the 422's detail), then the Workspace's save.
 */
async function saveKey(core: WorkspaceCore, stripe: FakeStripe, caller: Caller, key: string, connectionId: ConnectionId | null = null): Promise<Outcome<ConnectionOut>> {
	const connector = registry.get("stripe");
	if (connector.auth.type !== "api_key") return { ok: false, refusal: { status: 422, detail: "This provider does not connect with a key." } };
	const client = connector.client(key, settingsIo(stripe.fetch));
	let account: { id: string; label: string };
	try {
		account = await connector.account(client);
	} catch (error) {
		if (error instanceof OperationError) return { ok: false, refusal: { status: 422, detail: error.message } };
		throw error;
	} finally {
		await client.close();
	}
	return core.saveConnection(caller, { provider: "stripe", account, credentials: { kind: "api_key", key }, connectionId });
}

describe("connecting with a key", () => {
	test("keys connect and are never returned", async () => {
		const stripe = new FakeStripe();
		const auth = registry.get("stripe").auth;
		expect(auth.type).toBe("api_key");
		if (auth.type !== "api_key") return;
		expect(auth.label).toBe("Restricted API key");
		expect(auth.hint).toContain("rk_live_");

		const { core, sql, keys } = await workspace();
		const refused = await saveKey(core, stripe, OWNER, `sk_live_${"s".repeat(24)}`);
		expect(refused.ok).toBe(false);
		expect(JSON.stringify(refused)).not.toContain("sk_live_");
		const tooLong = await saveKey(core, stripe, OWNER, `rk_test_${"x".repeat(600)}`);
		expect(tooLong.ok).toBe(false);
		expect(JSON.stringify(tooLong)).not.toContain("x".repeat(50));

		const created = await saveKey(core, stripe, OWNER, KEY);
		if (!created.ok) throw new Error(created.refusal.detail);
		expect([created.value.label, created.value.auth]).toEqual(["Acme (test mode)", "api_key"]);
		expect(JSON.stringify(created)).not.toContain(KEY);
		const live = await saveKey(core, stripe, OWNER, LIVE_KEY);
		if (!live.ok) throw new Error(live.refusal.detail);
		expect(live.value.id).not.toBe(created.value.id);
		const row = sql.exec<{ external_account_id: string }>("SELECT external_account_id FROM connections WHERE id = ?", created.value.id)[0];
		expect(row?.external_account_id).toBe("acct_1:test");
		const h = { sql, keys } as Harness;
		expect(await credentials(h, created.value.id)).toEqual({ kind: "api_key", key: KEY });

		const other = await saveKey(core, stripe, OWNER, OTHER_KEY, created.value.id);
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.refusal).toEqual({ status: 422, detail: "This key is for a different Stripe account. Use a key for Acme (test mode)." });
		expect((await saveKey(core, stripe, OWNER, LIVE_KEY, created.value.id)).ok).toBe(false);
		const renewed = `rk_test_${"d".repeat(24)}`;
		stripe.accounts.set(renewed, "acct_1");
		sql.exec("UPDATE connections SET status = 'error' WHERE id = ?", created.value.id);
		const replaced = await saveKey(core, stripe, OWNER, renewed, created.value.id);
		if (!replaced.ok) throw new Error(replaced.refusal.detail);
		expect(replaced.value.status).toBe("active");
		expect(JSON.stringify(replaced)).not.toContain(renewed);
		expect((await credentials(h, created.value.id)).key).toBe(renewed);
		// The connection shows where its keys are managed.
		expect([replaced.value.manage_label, replaced.value.manage_url]).toEqual(["Manage keys in Stripe", "https://dashboard.stripe.com/apikeys"]);
	});
});
