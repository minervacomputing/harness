// The Stripe connector: money, the client's error names, the key check, discovery and naming, and runs
// through the executor against FakeStripe behind an injected `fetch` (test/fixtures/connectors/stripe/fake.ts).
// Connecting with a key goes through the Workspace's saveConnection after the connector's account().

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { Charge, Customer, Invoice, StripeClient, Subscription, classify } from "../../src/connectors/stripe/client.ts";
import { stripeConnector } from "../../src/connectors/stripe/connector.ts";
import * as money from "../../src/connectors/stripe/money.ts";
import { chargeData, customerData, invoiceData, subscriptionData } from "../../src/connectors/stripe/reads.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { fromUtf8 } from "../../src/lib/bytes.ts";
import { EncryptionKeys } from "../../src/lib/encryption.ts";
import type { Json } from "../../src/lib/json.ts";
import type { Connection } from "@minerva/contract";
import type { Caller, ConnectionId, Outcome } from "../../src/shared/rpc.ts";
import { WorkspaceCore } from "../../src/workspace/core.ts";
import { ADA, EVE, FakeStripe, GONE, GRACE, KEY, LIVE_KEY, OTHER_KEY, SECRET } from "../fixtures/connectors/stripe/fake.ts";
import { validated } from "./connector-runs.ts";
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

/** Starts and claims a run with the user's grants on the Stripe connection. */
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

/** A grant of the workspace ceiling on the Stripe connection. */
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
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({
			list_customers: "436ae17bbd4b8c70",
			get_customer: "ae3447579e3b75a9",
			list_payments: "982a06c4e32c266a",
			list_invoices: "8da344413c1d1cf3",
			list_subscriptions: "778bf4158d0c027c",
			refund_payment: "d5c7998f4e10f721",
			credit_customer: "9358bbf6f13f3cab",
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

	test.each([
		["1", "usd", 100],
		["01", "usd", 100],
		["1.000", "usd", 100],
		["1.05", "usd", 105],
		["1.010", "usd", 101],
		["0.01", "usd", 1],
		["999999.99", "usd", 99_999_999],
		["1.0", "jpy", 1],
		["99999999", "jpy", 99_999_999],
		["0.01", "kwd", 10],
		["1.230", "kwd", 1230],
		["5000", "ugx", 500_000],
		["1", "isk", 100],
	] as const)("%s %s is %i in the smallest unit", (value, currency, minor) => {
		expect(money.parse(value, currency)).toBe(minor);
	});

	test.each([
		["0", "usd", "must be more than zero and at most Stripe's largest amount"],
		["1000000", "usd", "must be more than zero and at most Stripe's largest amount"],
		["100000000", "jpy", "must be more than zero and at most Stripe's largest amount"],
		["1.005", "usd", "has more decimals than USD has"],
		["999999999999.999", "usd", "has more decimals than USD has"],
		["1.5", "jpy", "has more decimals than JPY has"],
		["0.001", "kwd", "must be a multiple of 0.01 KWD"],
		...["1e3", "-1", "+1", "1,50", " 1", "1 ", "", ".", "1.", ".5", "1.2345", "NaN", "Infinity", "١", "１"].map(
			(value) => [value, "usd", "must be a positive decimal amount such as 12.50"] as const,
		),
	] as const)("%j %s is refused", (value, currency, message) => {
		expect(() => money.parse(value, currency)).toThrow(new money.MoneyError(message));
	});

	test("amounts read back as exact text in the major unit, negatives too", () => {
		const shown = (minor: number | bigint, currency: string) => [money.major(minor, currency), money.display(minor, currency)];
		expect(shown(0, "usd")).toEqual(["0.00", "0.00 USD"]);
		expect(shown(-5, "usd")).toEqual(["-0.05", "-0.05 USD"]);
		expect(shown(-2000, "usd")).toEqual(["-20.00", "-20.00 USD"]);
		expect(shown(-99, "jpy")).toEqual(["-99", "-99 JPY"]);
		expect(shown(-1, "kwd")).toEqual(["-0.001", "-0.001 KWD"]);
		// Whole-unit currencies keep their cents when Stripe sends some, and drop them when they are zero.
		expect(shown(550, "ugx")).toEqual(["5.50", "5.50 UGX"]);
		expect(shown(-100, "isk")).toEqual(["-1", "-1 ISK"]);
		expect(money.major(9007199254740993n, "usd")).toBe("90071992547409.93");
		expect(() => money.major(12.5, "usd")).toThrow(RangeError);
	});

	test("currency codes are three ASCII letters, read in lower case", () => {
		for (const [value, code] of [["usd", "usd"], ["USD", "usd"], ["Usd", "usd"], ["KWD", "kwd"]]) expect(money.currency(value as string)).toBe(code);
		for (const value of ["us", "usdd", "u1d", "ǅAB", "ÉUR"]) {
			expect(() => money.currency(value)).toThrow(new money.MoneyError("must be a three-letter currency code such as usd"));
		}
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

	test.each([
		[403, { error: { type: "invalid_request_error", code: "x" } }, "PROVIDER_FORBIDDEN"],
		[401, { error: { type: "permission_error" } }, "PROVIDER_FORBIDDEN"],
		[404, {}, "NOT_FOUND"],
		[402, { error: { type: "card_error", code: "balance_insufficient" } }, "PROVIDER_REJECTED"],
		[500, { error: { type: "api_error", code: "charge_disputed" } }, "PROVIDER_REJECTED"],
		[400, { error: { type: "invalid_request_error", code: "a".repeat(65) } }, null],
		[400, { error: { type: "invalid_request_error", code: 5 } }, null],
		[409, { error: { type: "idempotency_error", code: "idempotency_key_in_use" } }, null],
		[400, { error: null }, null],
		[400, { error: "charge_already_refunded" }, null],
		[403, ["x"], null],
		[400, null, null],
	] as const)("a %i answering %j is named %s", (status, body, code) => {
		const text = JSON.stringify(body);
		expect(classify("Stripe", new Response(text, { status }), text)?.code ?? null).toBe(code);
	});

	test("an error body that is not JSON names nothing; one with invalid UTF-8 is still read", () => {
		for (const [status, text] of [[400, "not json"], [403, "<html>Forbidden</html>"], [404, ""], [400, '{"error": {"code": "charge_disputed"}']] as const) {
			expect(classify("Stripe", new Response(text, { status }), text)).toBeNull();
		}
		const encoder = new TextEncoder();
		const body = Uint8Array.from([...encoder.encode('{"error":{"type":"permission_error","message":"'), 0xff, ...encoder.encode('"}}')]);
		expect(classify("Stripe", new Response(body, { status: 400 }), fromUtf8(body))?.code).toBe("PROVIDER_FORBIDDEN");
	});

	test("a failed read is named, and a read with a byte order mark is accepted", async () => {
		const answer = (response: () => Response) => new StripeClient(KEY, settingsIo(async () => response())).customer("cus_1");
		const refused = await raised(answer(() => new Response('{"error": {"type": "invalid_request_error", "code": "resource_missing"}}', { status: 404 })));
		expect([refused.code, refused.message]).toEqual(["NOT_FOUND", "Stripe did not find this object."]);
		const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"id": "cus_1", "name": "Ada"}')]);
		expect((await answer(() => new Response(bom, { status: 200 }))).name).toBe("Ada");
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
		// The form as Stripe reads it: brackets percent-encoded.
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
		// "5.00" is another write: the key is over the normalized fields.
		await run.ok("stripe_credit_customer", credit(ADA, "5.00"));
		expect(stripe.writes).toHaveLength(2);
	});
});

// Connecting with a key

/** The Workspace's core over node:sqlite with only the Stripe connector. */
async function workspace(): Promise<Pick<Harness, "core" | "sql" | "keys">> {
	const db = database();
	const sql = nodeSql(db);
	const keys = await EncryptionKeys.parse(KEYS);
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
 * Saving a key as the key routes do: the account from the connector with the new key (its errors are the
 * 422's detail), then the Workspace's save.
 */
async function saveKey(core: WorkspaceCore, stripe: FakeStripe, caller: Caller, key: string, connectionId: ConnectionId | null = null): Promise<Outcome<Connection>> {
	const connector = registry.get("stripe");
	if (connector.auth.type !== "api_key") return { ok: false, refusal: { code: "WRONG_CONNECTION_METHOD", detail: "This provider does not connect with a key." } };
	const client = connector.client(key, settingsIo(stripe.fetch));
	let account: { id: string; label: string };
	try {
		account = await connector.account(client);
	} catch (error) {
		if (error instanceof OperationError) return { ok: false, refusal: { code: "KEY_REFUSED", detail: error.message } };
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
		if (!other.ok) expect(other.refusal).toEqual({ code: "DIFFERENT_ACCOUNT", detail: "This key is for a different Stripe account. Use a key for Acme (test mode)." });
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
		expect([replaced.value.manageLabel, replaced.value.manageUrl]).toEqual(["Manage keys in Stripe", "https://dashboard.stripe.com/apikeys"]);
	});
});

// Inputs and records

describe("inputs", () => {
	const connector = stripeConnector();

	test("arguments are trimmed, defaulted and read in lower case; a null filter is no filter", async () => {
		const page = { limit: 10, cursor: null };
		expect(await validated(connector, "list_customers", null)).toEqual({ ok: { email: null, ...page } });
		expect(await validated(connector, "list_customers", { email: null })).toEqual({ ok: { email: null, ...page } });
		expect(await validated(connector, "list_customers", { email: "  ada@example.com  ", limit: 25, cursor: " tok " })).toEqual({ ok: { email: "ada@example.com", limit: 25, cursor: "tok" } });
		expect(await validated(connector, "get_customer", { customer: " cus_ada " })).toEqual({ ok: { customer: "cus_ada" } });
		expect(await validated(connector, "list_invoices", { status: "open", customer: "cus_ada" })).toEqual({ ok: { customer: "cus_ada", status: "open", ...page } });
		expect(await validated(connector, "refund_payment", { payment: "py_1", amount: " 50 ", currency: " USD " })).toEqual({ ok: { amount: "50", currency: "usd", payment: "py_1", reason: null } });
		expect(await validated(connector, "credit_customer", { customer: "cus_ada", amount: "5000", currency: "UGX", description: "x" })).toEqual({
			ok: { amount: "5000", currency: "ugx", customer: "cus_ada", description: "x" },
		});
		// The amount is kept as the text the model sent.
		for (const [amount, currency] of [["12.500", "usd"], ["1.230", "kwd"], ["5.00", "jpy"], ["99999999", "jpy"]] as const) {
			expect(await validated(connector, "refund_payment", { payment: "ch_ada2", amount, currency }), amount).toMatchObject({ ok: { amount } });
		}
	});

	test.each([
		["list_customers", { email: "a\tb@example.com" }, "email"],
		["list_customers", { email: "ab" }, "email"],
		["list_customers", { email: "x".repeat(513) }, "email"],
		["list_customers", { limit: 26 }, "limit"],
		["list_customers", { limit: 0 }, "limit"],
		["list_customers", { limit: "5" }, "limit"],
		["list_customers", { cursor: "x".repeat(201) }, "cursor"],
		["list_customers", { connection_id: "x" }, "input"],
		["list_customers", [], "input"],
		["list_customers", "x", "input"],
		["get_customer", { customer: "ada" }, "customer"],
		["get_customer", { customer: "cus_a-b" }, "customer"],
		["get_customer", { customer: "CUS_ada" }, "customer"],
		["get_customer", { customer: `cus_${"a".repeat(107)}` }, "customer"],
		["get_customer", {}, "customer"],
		["get_customer", { customer: null }, "customer"],
		["list_payments", { customer: "ch_1" }, "customer"],
		["list_invoices", { status: "closed" }, "status"],
		["list_invoices", { status: " open " }, "status"],
		["list_subscriptions", { status: "ended" }, "status"],
		["refund_payment", { payment: "ch_ada2", amount: "5", currency: "u1d" }, "currency"],
		["refund_payment", { payment: "ch_ada2", amount: "5", currency: "usd", reason: "fraudulent" }, "reason"],
		["refund_payment", { payment: "re_1", amount: "5", currency: "usd" }, "payment"],
		["refund_payment", { payment: "ch_ada2", amount: 5, currency: "usd" }, "amount"],
		["refund_payment", { payment: "ch_ada2", amount: "x".repeat(17), currency: "usd" }, "amount"],
		["refund_payment", { payment: "bad", amount: "5.001", currency: "usd" }, "payment"],
		["refund_payment", { payment: "ch_ada2", amount: "5", currency: "usd", extra: 1 }, "input"],
		["credit_customer", { customer: "cus_ada", amount: "1", currency: "eur", description: "a\nb" }, "description"],
		["credit_customer", { customer: "cus_ada", amount: "1", currency: "eur", description: "   " }, "description"],
		["credit_customer", { customer: "cus_ada", amount: "1", currency: "eur", description: "x".repeat(351) }, "description"],
	] as const)("%s %j is refused at %s", async (name, input, field) => {
		const result = await validated(connector, name, input as Json);
		expect(result).toHaveProperty("refused");
		expect((result as { refused: string }).refused).toMatch(new RegExp(`^Invalid arguments\\. ${field}: `));
	});

	test.each([
		[{ amount: "5.001", currency: "usd" }, "amount has more decimals than USD has"],
		[{ amount: "1.5", currency: "jpy" }, "amount has more decimals than JPY has"],
		[{ amount: "5.5", currency: "ugx" }, "amount must be a whole number of UGX"],
		[{ amount: "1.255", currency: "kwd" }, "amount must be a multiple of 0.01 KWD"],
		[{ amount: "0.00", currency: "usd" }, "amount must be more than zero and at most Stripe's largest amount"],
		[{ amount: "1000000", currency: "usd" }, "amount must be more than zero and at most Stripe's largest amount"],
		[{ amount: "５", currency: "usd" }, "amount must be a positive decimal amount such as 12.50"],
		[{ amount: "12345678901234", currency: "usd" }, "amount must be a positive decimal amount such as 12.50"],
	])("a refund of %j is refused as a whole", async (fields, message) => {
		expect(await validated(connector, "refund_payment", { payment: "ch_ada2", ...fields })).toEqual({ refused: `Invalid arguments. input: ${message}` });
	});

	test("a field's own refusal comes first, and the amount is checked only once it can be read", async () => {
		const refused = await validated(connector, "refund_payment", { payment: "ch_ada2", amount: "5.001", currency: "us" });
		expect(refused).toEqual({ refused: "Invalid arguments. currency: Too small: expected string to have >=3 characters" });
		expect(await validated(connector, "credit_customer", { customer: "cus_ada", amount: "0.001", currency: "eur", description: "x" })).toEqual({
			refused: "Invalid arguments. input: amount has more decimals than EUR has",
		});
	});
});

describe("records", () => {
	test("a customer's balance is text in its currency, and only with one", () => {
		expect(JSON.stringify(customerData(Customer.parse({ id: "cus_1", name: "Ada", email: "ada@example.com", currency: "usd", balance: -2000, created: 1790000000 })))).toBe(
			JSON.stringify({ id: "cus_1", name: "Ada", email: "ada@example.com", currency: "usd", balance: "-20.00", delinquent: null, created: 1790000000, description: null }),
		);
		expect(customerData(Customer.parse({ id: "cus_2", currency: null, balance: 500 })).balance).toBeNull();
		expect(customerData(Customer.parse({ id: "cus_3", currency: "", balance: 5 })).balance).toBeNull();
	});

	test("a charge's amounts are exact text, what is refundable too, and long texts are cut", () => {
		const charge = chargeData(
			Charge.parse({
				id: "ch_1",
				amount: 5000,
				amount_captured: 5000,
				amount_refunded: 1250,
				status: "succeeded",
				currency: "usd",
				customer: "cus_1",
				captured: true,
				payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
				billing_details: { name: "Ada", email: null },
				description: "Order",
				failure_message: "y".repeat(600),
			}),
		);
		expect(charge).toMatchObject({ amount: "50.00", amount_captured: "50.00", amount_refunded: "12.50", refundable: "37.50", payment_method: "card", card_brand: "visa", card_last4: "4242", billing_name: "Ada" });
		expect([(charge.failure_message as string).length, charge.failure_message_truncated]).toEqual([500, true]);
		// Past 2^53 the sum is still exact; a pending charge has nothing to refund.
		const large = chargeData(Charge.parse({ id: "ch_4", amount: 9007199254740991, amount_captured: 9007199254740991, amount_refunded: -2, status: "succeeded", currency: "usd", customer: null }));
		expect([large.amount, large.amount_refunded, large.refundable]).toEqual(["90071992547409.91", "-0.02", "90071992547409.93"]);
		const pending = chargeData(Charge.parse({ id: "ch_2", amount: 4000, amount_captured: 0, status: "pending", currency: "JPY", customer: null }));
		expect([pending.amount, pending.refundable, pending.currency]).toEqual(["4000", "0", "JPY"]);
	});

	test("an invoice's and a subscription's amounts are text, and a subscription shows its first 20 items", () => {
		const invoice = invoiceData(Invoice.parse({ id: "in_2", customer: null, currency: "ugx", total: 500000, amount_paid: 550 }));
		expect([invoice.total, invoice.amount_due, invoice.amount_paid]).toEqual(["5000", "0", "5.50"]);
		const prices = Array.from({ length: 25 }, (_, index) => ({ price: { id: `price_${index}`, unit_amount: index, currency: "eur" } }));
		const subscription = subscriptionData(Subscription.parse({ id: "sub_2", customer: "cus_2", status: "canceled", items: { data: prices } }));
		const shown = subscription.items as { [key: string]: Json }[];
		expect(shown.map((item) => item.unit_amount)).toEqual(Array.from({ length: 20 }, (_, index) => `0.${String(index).padStart(2, "0")}`));
		const mixed = subscriptionData(Subscription.parse({ id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ price: null }, { price: { id: "price_2", unit_amount: null, currency: "jpy" } }] } }));
		expect((mixed.items as { [key: string]: Json }[]).map((item) => [item.price, item.unit_amount, item.currency])).toEqual([
			[null, null, null],
			["price_2", null, "jpy"],
		]);
	});
});
