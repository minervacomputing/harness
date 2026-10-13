// The Xero connector: exact amounts, dates and pages, the client's error names, and runs through the executor
// against FakeXero behind an injected `fetch` (test/fixtures/connectors/xero/fake.ts), with the user's grants,
// the workspace ceiling and the connection's scopes (executor-fakes.ts `Scenario`).

import { afterEach, describe, expect, test, vi } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { MAX_PAGE, Message, Pagination, ZERO_UUID, classify, date, invoiceDate, judge, messages, moment, nextPage, page } from "../../src/connectors/xero/client.ts";
import { fromNumber, money, number } from "../../src/connectors/xero/decimal.ts";
import { short } from "../../src/connectors/xero/organisations.ts";
import { xeroConnector } from "../../src/connectors/xero/connector.ts";
import { DraftBill, DraftInvoice, body } from "../../src/connectors/xero/writes.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import type { ConnectionId } from "../../src/shared/rpc.ts";
import { planRefresh } from "../../src/workspace/credentials.ts";
import { ACME, ARCHIVED, BETA, CUSTOMER, FakeXero, INVOICE, SECRET, SUPPLIER, TOKEN, UNREACHED, contactOf, invoiceOf, jsonResponse } from "../fixtures/connectors/xero/fake.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

const XERO: ConnectionId = "0199a000-0000-7000-8000-0000000000e1";
const SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"accounting.invoices.read",
	"accounting.contacts.read",
	"accounting.settings.read",
	"accounting.invoices",
];
const registry = await Registry.create([xeroConnector()]);
const fakes: FakeXero[] = [];

function fake(): FakeXero {
	const xero = new FakeXero();
	fakes.push(xero);
	return xero;
}

afterEach(() => {
	// What FakeXero checked about each request.
	for (const xero of fakes.splice(0)) expect(xero.problems).toEqual([]);
	vi.restoreAllMocks();
});

/** Starts a run with the user's Xero connection, holding `grants` ({organisation: actions}). */
function start(xero: FakeXero, grants: { [organisation: string]: string[] }, options: { scopes?: string[]; ceiling?: GrantRow[] } = {}): Promise<Scenario> {
	return Scenario.start({
		connectors: [xeroConnector()],
		registry,
		connections: [{ id: XERO, provider: "xero", payload: { kind: "oauth2", access_token: TOKEN, refresh_token: null, scopes: options.scopes ?? SCOPES } }],
		user: userGrants(XERO, "organisation", grants),
		ceiling: options.ceiling ?? [],
		fetch: xero.fetch,
	});
}

/** A grant of the workspace ceiling on the Xero connection. */
function ceiling(resourceId: string, effect: GrantRow["effect"], actions = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: XERO, kind: "organisation", resourceId, resourceName: "", actions, effect };
}

function items(outcome: Extract<ToolCallOutcome, { ok: true }>): JsonObject[] {
	return outcome.result.items;
}

function onlyAcme(xero: FakeXero): void {
	xero.connections = xero.connections.filter((connection) => connection.tenantId === ACME);
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
	test("the registry accepts it, and its fingerprints are pinned", () => {
		expect(() => validate([xeroConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(xeroConnector().operations.map((op) => [op.name, registry.contract("xero", op.name)]));
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({
			list_organisations: "9005b0f2eccd570e",
			search_contacts: "be8cf28317bf278b",
			search_invoices: "19fc33df9deac894",
			get_invoice: "0373e3519954cc89",
			list_accounts: "0575e50fe99e934e",
			list_tax_rates: "0575e50fe99e934e",
			create_draft_invoice: "10ce1dffc230fb1a",
			create_draft_bill: "f177b05caf11d57d",
		});
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("xero");
		const served = await connectorRegistry();
		expect(served.get("xero").operations.map((op) => op.name)).toEqual(registry.get("xero").operations.map((op) => op.name));
		for (const op of served.get("xero").operations) expect(served.contract("xero", op.name)).toBe(registry.contract("xero", op.name));
	});
});

// Connecting and discovery

describe("connecting and discovery", () => {
	test("the account is the Xero user", async () => {
		const xero = fake();
		const connector = xeroConnector();
		const account = await connector.account(xero.client());
		expect([account.id, account.label]).toEqual(["u-991", "Ada Lovelace (ada@example.com)"]);
		xero.me = { sub: "u-991", given_name: "Ada" };
		expect((await connector.account(xero.client())).label).toBe("Ada");
		xero.me = { name: "Ada" };
		expect((await raised(connector.account(xero.client()))).code).toBe("PROVIDER_FAILED");
		xero.me = { sub: 991, given_name: "Ada" };
		expect((await raised(connector.account(xero.client()))).code).toBe("PROVIDER_FAILED");
		xero.me = { sub: "u-991" };
		xero.connections = xero.connections.filter((connection) => connection.tenantType !== "ORGANISATION");
		expect((await raised(connector.account(xero.client()))).code).toBe("UNSUPPORTED_ACCOUNT");
	});

	test("organisations are the connected tenants", async () => {
		const xero = fake();
		const connector = xeroConnector();
		const client = xero.client();
		let found = await connector.discover(client, "organisation", { query: null, cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([
			[ACME, "Acme Ltd"],
			[BETA, SECRET],
		]);
		expect(found.nextCursor ?? null).toBeNull();
		found = await connector.discover(client, "organisation", { query: "acme", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([ACME]);
		expect((await raised(connector.discover(client, "organisation", { query: null, cursor: "2" }))).code).toBe("INVALID_CURSOR");
		expect(await connector.describe(client, "organisation", [ACME, UNREACHED, "x"])).toEqual({ [ACME]: "Acme Ltd" });
		// Read once per client.
		expect(xero.requests.filter((request) => request.url.pathname === "/connections")).toHaveLength(1);

		xero.connections = Array.from({ length: 101 }, (_, n) => ({ tenantId: `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`, tenantType: "ORGANISATION" }));
		expect((await raised(xero.client().organisations())).code).toBe("PROVIDER_LIMIT");
		xero.connections = [{ tenantId: ACME, tenantType: "ORGANISATION" }];
		expect((await connector.discover(xero.client(), "organisation", { query: null, cursor: null })).items[0]?.name).toBe("Organisation 0a1b2c3d");
	});

	test("reading and drafting ask for separate scopes", () => {
		const connector = registry.get("xero");
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Xero connects with OAuth.");
		expect([auth.pkce, auth.clientAuth]).toEqual([true, "basic"]);
		expect(auth.scopes).not.toContain("accounting.invoices");
		for (const scope of ["accounting.invoices.read", "accounting.contacts.read", "offline_access"]) expect(auth.scopes).toContain(scope);
		const consent = Object.fromEntries(connector.operations.map((op) => [op.name, op.consent ?? null]));
		expect(consent.create_draft_invoice).toEqual([["accounting.invoices"]]);
		expect(consent.create_draft_bill).toEqual([["accounting.invoices"]]);
		for (const op of connector.operations.filter((item) => !item.mutates)) expect(op.consent ?? null).toBeNull();
	});

	test("a refresh authenticates with HTTP Basic and keeps the rotated token", async () => {
		// The token request `clientAuth: "basic"` declares, through the Workspace's refresh, with a refresh token
		// that rotates.
		const sent: Request[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			sent.push(new Request(input as RequestInfo, init as RequestInit));
			return jsonResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800, token_type: "Bearer", scope: "openid offline_access accounting.invoices.read" });
		};
		const plan = await planRefresh(
			xeroConnector(),
			{ kind: "oauth2", access_token: "old", refresh_token: "old-refresh", scopes: SCOPES, client_id: "client-id" },
			{
				clients: { configured: () => ({ clientId: "client-id", clientSecret: "client-secret" }), stored: async () => null },
				siteUrl: "https://minerva.example",
				fetch,
				now: () => Date.UTC(2026, 9, 11),
				log: () => {},
			},
			XERO,
		);
		if (plan.kind !== "send") throw new Error("The refresh was not planned.");
		expect(plan.tokenUrl).toBe("https://identity.xero.com/connect/token");
		const result = await plan.send();
		const request = sent[0] as Request;
		expect(request.headers.get("authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
		const form = new URLSearchParams(await request.text());
		expect([...form.keys()]).toEqual(["grant_type", "refresh_token"]);
		expect(form.get("refresh_token")).toBe("old-refresh");
		if (result.kind !== "refreshed") throw new Error(`The refresh failed: ${result.kind}`);
		expect(result.payload).toMatchObject({
			access_token: "new-access",
			refresh_token: "new-refresh",
			scopes: ["accounting.invoices.read", "offline_access", "openid"],
			client_id: "client-id",
			token_url: "https://identity.xero.com/connect/token",
		});
	});

	test("errors pass on validation messages only", () => {
		const classified = (status: number, content: Json | string) => {
			const raw = typeof content === "string" ? content : JSON.stringify(content);
			return classify("Xero", new Response(raw, { status }), raw, new TextEncoder().encode(raw));
		};
		const found = classified(400, {
			ErrorNumber: 10,
			Type: "ValidationException",
			Message: SECRET,
			Elements: [
				{ ValidationErrors: [{ Message: "Account code '999' is not a valid code." }] },
				{ ValidationErrors: [{ Message: "Account code '999' is not a valid code." }, { Message: "x\ny" }] },
			],
		});
		expect([found?.code, found?.message]).toEqual(["PROVIDER_REJECTED", "Xero rejected this: Account code '999' is not a valid code.; x y"]);
		const long = classified(400, { Type: "ValidationException", ValidationErrors: Array.from({ length: 9 }, (_, n) => ({ Message: String(n).repeat(400) })) });
		expect(long?.message.split(";").length).toBe(5);
		expect(long?.message).not.toContain(SECRET);
		expect(classified(400, { Type: "ValidationException" })?.message).toBe("Xero rejected this.");
		expect(classified(400, { Type: "QueryParseException", Message: SECRET })).toBeNull();
		expect(classified(400, "<html>")).toBeNull();
		// Bytes that are not UTF-8 are not Xero's JSON.
		const latin = Uint8Array.from('{"Type":"ValidationException","Message":"caf\u00e9"}', (char) => char.charCodeAt(0));
		expect(classify("Xero", new Response(latin, { status: 400 }), "", latin)).toBeNull();
		const forbidden = classified(403, { Detail: SECRET });
		expect(forbidden?.code).toBe("PROVIDER_FORBIDDEN");
		expect(forbidden?.message).not.toContain(SECRET);
		expect(classified(500, { Detail: SECRET })).toBeNull();
	});

	test("a success holding only refusals created nothing", () => {
		const judged = (status: number, content: Json) => {
			const raw = JSON.stringify(content);
			return judge(new Response(raw, { status }), raw);
		};
		const refused = { InvoiceID: ZERO_UUID, HasErrors: true, ValidationErrors: [] };
		expect(judged(200, { Invoices: [refused] })).toBe("not_applied");
		expect(judged(200, { Invoices: [{ ...refused, InvoiceID: INVOICE }] })).toBeNull();
		expect(judged(200, { Invoices: [{ InvoiceID: INVOICE }] })).toBeNull();
		// An id of another type leaves the write unknown.
		expect(judged(200, { Invoices: [{ ...refused, InvoiceID: 5 }] })).toBe("unknown");
		expect(judged(200, { Invoices: [{ ...refused, InvoiceID: null }] })).toBe("not_applied");
		expect(judged(200, { Invoices: [] })).toBeNull();
		expect(judged(200, [refused])).toBeNull();
		expect(judged(400, { Invoices: [refused] })).toBeNull();
	});

	test("pages and dates", () => {
		expect([page(null), page("7")]).toEqual([1, 7]);
		for (const cursor of ["0", "01", "-1", "x", "100001", "1".repeat(7)]) {
			let caught: unknown = null;
			try {
				page(cursor);
			} catch (error) {
				caught = error;
			}
			expect((caught as OperationError).code).toBe("INVALID_CURSOR");
		}
		const known = Pagination.parse({ pageCount: 3 });
		expect([nextPage(known, 2, 10, 10), nextPage(known, 3, 10, 10)]).toEqual(["3", null]);
		expect([nextPage(null, 1, 10, 10), nextPage(null, 1, 9, 10)]).toEqual(["2", null]);
		expect(nextPage(null, MAX_PAGE, 10, 10)).toBeNull();

		expect(moment("/Date(1788220800000+0000)/")).toBe("2026-09-01T00:00:00Z");
		expect(moment("/Date(99999999999999999)/")).toBeNull();
		expect(moment("2026-09-01")).toBeNull();
		expect(invoiceDate("2026-09-02T00:00:00", "/Date(1788220800000+0000)/")).toBe("2026-09-02");
		expect(invoiceDate(null, "/Date(1788220800000)/")).toBe("2026-09-01");
		expect(invoiceDate("soon", null)).toBeNull();
	});

	test.each([
		["/Date(1788220800999+0000)/", "2026-09-01T00:00:00Z"],
		["/Date(1788307200000-0700)/", "2026-09-02T00:00:00Z"],
		["/Date(0)/", "1970-01-01T00:00:00Z"],
		["/Date(-1)/", "1969-12-31T23:59:59Z"],
		["/Date(-1000)/", "1969-12-31T23:59:59Z"],
		["/Date(-1001)/", "1969-12-31T23:59:58Z"],
		["/Date(253402300799999)/", "9999-12-31T23:59:59Z"],
		["/Date(253402300800000)/", null],
		["/Date(-62135596800000)/", "0001-01-01T00:00:00Z"],
		["/Date(-62135596800001)/", null],
		["/Date(999999999999999)/", null],
		["/Date(١٧٨٨٢٢٠٨٠٠٠٠٠)/", null],
		["/Date(1788220800000+00)/", null],
		["/Date(1788220800000 +0000)/", null],
		["/Date(+1788220800000)/", null],
		["/Date()/", null],
		["/Date(1788220800000+0000)/\n", null],
		["Date(1788220800000)", null],
	])("the moment %j is %s, to the second it falls in", (value, shown) => {
		expect(moment(value)).toBe(shown);
	});

	test.each([
		["2026-09-01T00:00:00", "2026-09-01"],
		["2026-09-01", "2026-09-01"],
		["2026-09-01T00:00:00.123", "2026-09-01"],
		["2026-09-01T", null],
		["2026-09-01T00:00:00Z", null],
		["2026-09-01 00:00:00", null],
		["２０２６-09-01", null],
		["2026-9-01", null],
		["2026-09-01\n", null],
	])("the date %j is %s", (value, shown) => {
		expect(date(value)).toBe(shown);
	});

	test("an invoice's date is the string form, else the JSON date's day", () => {
		expect(invoiceDate(null, null)).toBeNull();
		expect(invoiceDate("2026-09-02T00:00:00", "/Date(x)/")).toBe("2026-09-02");
		expect(invoiceDate("soon", "/Date(1788220800000+0000)/")).toBe("2026-09-01");
		expect(invoiceDate("soon", "/Date(x)/")).toBeNull();
	});

	test.each([
		["0", "0.00", "0"],
		["-0", "0.00", "0"],
		["-0.0", "0.00", "0"],
		["-1", "-1.00", "-1"],
		["1E2", "100.00", "100"],
		["70.0", "70.00", "70"],
		["0.1", "0.10", "0.1"],
		["0.30000000000000004", "0.30000000000000004", "0.30000000000000004"],
		["1e-7", "0.0000001", "0.0000001"],
		["-1e-7", "-0.0000001", "-0.0000001"],
		["1e-400", "0.00", "0"],
		["80.1234", "80.1234", "80.1234"],
		["-0.005", "-0.005", "-0.005"],
		["2.675", "2.675", "2.675"],
		["1.5e15", "1500000000000000.00", "1500000000000000"],
		["-9007199254740991", "-9007199254740991.00", "-9007199254740991"],
		["4503599627370496.5", "4503599627370496.00", "4503599627370496"],
		["1.10", "1.10", "1.1"],
	])("Xero's %s is the amount %s and the number %s", (text, amount, shown) => {
		const value = fromNumber(parseJson(text) as number);
		expect([money(value), number(value)]).toEqual([amount, shown]);
	});

	test("what a JSON number cannot hold exactly is refused", () => {
		for (const value of [2 ** 53, -(2 ** 53), 1e16, 1e300, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN]) expect(fromNumber(value)).toBeNull();
		expect(number(fromNumber(5e-324))).toBe(`0.${"0".repeat(323)}5`);
		expect([money(fromNumber(4503599627370495.5)), number(fromNumber(4503599627370495.5))]).toEqual(["4503599627370495.50", "4503599627370495.5"]);
	});

	test("texts are shown on one line, cut, and Xero's messages once each", () => {
		for (const blank of [null, "", "   "]) expect(short(blank)).toBeNull();
		expect(short("\tAcme\nLtd  　x​")).toBe("Acme Ltd x​");
		expect(short("x".repeat(501))).toBe("x".repeat(500));
		expect(short("x".repeat(301), 300)).toBe("x".repeat(300));
		const shown = (texts: (string | null)[]) => messages(texts.map((text) => Message.parse({ Message: text })));
		expect(shown(["one", "one", " one "])).toEqual(["one"]);
		expect(shown(["x\ny", null, "", "  "])).toEqual(["x y"]);
	});
});

// Organisations and grants

describe("organisations and grants", () => {
	test("only granted organisations are listed or read", async () => {
		const xero = fake();
		const run = await start(xero, { [ACME]: ["read"] });
		const outcome = await run.ok("xero_list_organisations", {});
		expect(items(outcome)).toEqual([{ id: ACME, name: "Acme Ltd" }]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);

		// Beta is reached but not granted; another organisation is not reached at all. Neither is read.
		for (const organisation of [BETA, UNREACHED, UNREACHED.toUpperCase()]) {
			for (const [tool, args] of [
				["xero_search_contacts", {}],
				["xero_search_invoices", {}],
				["xero_get_invoice", { invoice: INVOICE }],
				["xero_list_accounts", {}],
				["xero_list_tax_rates", {}],
			] as const) {
				expect(await run.code(tool, { ...args, organisation })).toBe("POLICY_DENIED");
			}
		}
		expect(xero.accounting()).toEqual([]);

		// Two organisations are reached: a call names one.
		expect(await run.code("xero_search_contacts", {})).toBe("INVALID_ARGUMENTS");
		const contacts = await run.ok("xero_search_contacts", { organisation: ACME.toUpperCase() });
		expect(items(contacts).map((contact) => contact.name)).toEqual(["Carol Customer", "Sam Supplier"]);
		expect(new Set(xero.accounting().map((request) => request.headers.get("xero-tenant-id")))).toEqual(new Set([ACME]));
	});

	test("one organisation is the default", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read"] });
		const outcome = await run.ok("xero_list_accounts", {});
		expect(items(outcome).map((account) => account.code)).toEqual(["200", "090"]);
	});

	test("all organisations respects the ceiling", async () => {
		const xero = fake();
		const run = await start(xero, { "*": ["read"] }, { ceiling: [ceiling(BETA, "deny")] });
		const outcome = await run.ok("xero_list_organisations", {});
		expect(items(outcome).map((organisation) => organisation.id)).toEqual([ACME]);
		expect(await run.code("xero_list_tax_rates", { organisation: BETA })).toBe("POLICY_DENIED");
		expect(xero.accounting(BETA)).toEqual([]);
		await run.ok("xero_list_tax_rates", { organisation: ACME });
	});
});

// Reading

describe("reading", () => {
	test("contacts are searched and shown without bank details", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read"] });
		const outcome = await run.ok("xero_search_contacts", { text: "carol", limit: 5 });
		expect(xero.lastParams()).toEqual({ page: "1", pageSize: "5", order: "Name ASC", searchTerm: "carol" });
		expect(items(outcome)[0]).toEqual({
			id: CUSTOMER,
			name: "Carol Customer",
			first_name: null,
			last_name: null,
			email: "carol@example.com",
			contact_number: null,
			account_number: null,
			status: "ACTIVE",
			is_customer: true,
			is_supplier: null,
			default_currency: null,
			tax_number: null,
			addresses: [{ type: "POBOX", lines: ["PO Box 1"], city: "Zurich", region: null, postal_code: null, country: "CH" }],
			phones: ["41 44 123 45 67"],
			people: [{ name: "Cy C", email: "cy@example.com" }],
			balances: { receivable: { outstanding: "70.00", overdue: "0.00" }, payable: null },
		});
		expect(JSON.stringify(outcome.result)).not.toContain("0123456");

		const first = await run.ok("xero_search_contacts", { include_archived: true, limit: 2 });
		expect(items(first).map((contact) => contact.name)).toEqual(["Carol Customer", "Sam Supplier"]);
		expect(xero.lastParams().includeArchived).toBe("true");
		const args = { include_archived: true, limit: 2, cursor: first.result.next_cursor as string };
		const second = await run.ok("xero_search_contacts", args);
		expect(items(second).map((contact) => contact.name)).toEqual(["Old Customer"]);
		expect(second.result).not.toHaveProperty("next_cursor");
		expect(xero.lastParams().page).toBe("2");
		// The cursor is bound to the other arguments.
		expect(await run.code("xero_search_contacts", { ...args, limit: 3 })).toBe("INVALID_CURSOR");
	});

	test("invoices are searched with a filter built from checked values", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read"] });
		const args = {
			type: "sales",
			statuses: ["AUTHORISED", "PAID", "AUTHORISED"],
			contact: CUSTOMER.toUpperCase(),
			text: "INV-0001",
			date_from: "2026-01-01",
			date_to: "2026-12-31",
			limit: 10,
		};
		const outcome = await run.ok("xero_search_invoices", args);
		expect(xero.lastParams()).toEqual({
			page: "1",
			pageSize: "10",
			summaryOnly: "true",
			order: "Date DESC",
			where: 'Type=="ACCREC" AND Date>=DateTime(2026,01,01) AND Date<=DateTime(2026,12,31)',
			Statuses: "AUTHORISED,PAID",
			ContactIDs: CUSTOMER,
			searchTerm: "INV-0001",
		});
		expect(items(outcome)).toEqual([
			{
				id: INVOICE,
				type: "sales",
				number: "INV-0001",
				reference: "PO 7",
				contact: { id: CUSTOMER, name: "Carol Customer" },
				status: "AUTHORISED",
				date: "2026-09-01",
				due_date: "2026-09-15",
				currency: "EUR",
				sub_total: "100.00",
				total_tax: "20.00",
				total: "120.00",
				amount_due: "70.00",
				amount_paid: "50.00",
				amount_credited: "0.00",
				sent_to_contact: true,
				updated: "2026-09-02T00:00:00Z",
			},
		]);
		const invalid: JsonObject[] = [
			{ type: "credit" },
			{ statuses: ["SENT"] },
			{ date_from: "2026-02-30" },
			{ date_from: "26-01-01" },
			{ date_from: "1800-01-01" },
			{ text: "INV\n1" },
			{ contact: "Carol" },
			{ where: "Total>0" },
		];
		for (const bad of invalid) {
			expect([bad, await run.code("xero_search_invoices", bad)]).toEqual([bad, "INVALID_ARGUMENTS"]);
		}
		expect(await run.code("xero_search_invoices", { date_from: "2026-02-01", date_to: "2026-01-01" })).toBe("INVALID_ARGUMENTS");
		expect(xero.accounting()).toHaveLength(1);
	});

	test("invoice pages follow Xero's page count", async () => {
		const xero = fake();
		onlyAcme(xero);
		const contact = xero.contacts[ACME]?.[0] as JsonObject;
		xero.invoices[ACME] = [1, 2, 3].map((n) => invoiceOf(`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`, "ACCREC", contact));
		const run = await start(xero, { [ACME]: ["read"] });
		const first = await run.ok("xero_search_invoices", { limit: 2 });
		expect(items(first)).toHaveLength(2);
		const args = { limit: 2, cursor: first.result.next_cursor as string };
		const second = await run.ok("xero_search_invoices", args);
		expect(items(second)).toHaveLength(1);
		expect(second.result).not.toHaveProperty("next_cursor");

		// A page Xero no longer takes.
		xero.hook = (_method, _path, params) => (params.page === "2" ? FakeXero.error(400, { Type: "QueryParseException" }) : null);
		expect(await run.code("xero_search_invoices", args)).toBe("INVALID_CURSOR");
		xero.hook = () => FakeXero.error(400, { Type: "ValidationException", Elements: [{ ValidationErrors: [{ Message: "bad" }] }] });
		expect(await run.code("xero_search_invoices", { limit: 2 })).toBe("PROVIDER_REJECTED");
	});

	test("an invoice is read with its lines and payments", async () => {
		const xero = fake();
		onlyAcme(xero);
		const lines: JsonObject[] = [
			{
				Description: "Consulting\nSeptember",
				Quantity: 1.5,
				UnitAmount: 80.1234,
				AccountCode: "200",
				TaxType: "OUTPUT2",
				TaxAmount: 24.04,
				LineAmount: 120.19,
				DiscountRate: 0,
				Tracking: [{ Name: "Region", Option: "North" }],
			},
			{ Description: "x".repeat(2500), Quantity: 1, UnitAmount: 1 },
			...Array.from({ length: 200 }, () => ({ Description: "more", Quantity: 1, UnitAmount: 1 })),
		];
		const stored = xero.invoices[ACME]?.[0] as JsonObject;
		stored.LineItems = lines;
		stored.Payments = [{ PaymentID: "p", Date: "/Date(1788393600000+0000)/", Amount: 50.0, Reference: "wire" }];
		const run = await start(xero, { [ACME]: ["read"] });
		const [invoice] = items(await run.ok("xero_get_invoice", { invoice: INVOICE.toUpperCase() })) as [JsonObject];
		expect(xero.lastParams()).toEqual({ unitdp: "4" });
		expect([invoice.amounts_are, invoice.has_attachments]).toEqual(["Exclusive", false]);
		expect([invoice.line_count, invoice.lines_truncated, (invoice.lines as Json[]).length]).toEqual([202, true, 200]);
		expect((invoice.lines as JsonObject[])[0]).toEqual({
			description: "Consulting\nSeptember",
			description_truncated: false,
			quantity: "1.5",
			unit_amount: "80.1234",
			item_code: null,
			account_code: "200",
			tax_type: "OUTPUT2",
			tax_amount: "24.04",
			line_amount: "120.19",
			discount_rate: "0",
			discount_amount: null,
			tracking: [{ category: "Region", option: "North" }],
		});
		expect((invoice.lines as JsonObject[])[1]?.description_truncated).toBe(true);
		expect(invoice.payments).toEqual([{ date: "2026-09-03", amount: "50.00", reference: "wire" }]);
		expect([invoice.payment_count, invoice.payments_truncated]).toEqual([1, false]);

		const other = "10000000-0000-4000-8000-000000000009";
		expect(await run.code("xero_get_invoice", { invoice: other })).toBe("NOT_FOUND");
		xero.hook = () => jsonResponse(200, { Invoices: [invoiceOf(other, "ACCREC", xero.contacts[ACME]?.[0] as JsonObject)] });
		expect(await run.code("xero_get_invoice", { invoice: INVOICE })).toBe("PROVIDER_FAILED");
	});

	test("accounts and tax rates are the active ones", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read"] });
		const accounts = await run.ok("xero_list_accounts", {});
		expect(xero.lastParams()).toEqual({ where: 'Status=="ACTIVE"' });
		expect(items(accounts)[0]).toEqual({ code: "200", name: "Sales", type: "REVENUE", class: "REVENUE", tax_type: "OUTPUT2", description: "Income from sales" });
		expect(items(accounts)).toHaveLength(2);
		expect(JSON.stringify(accounts.result)).not.toContain("0123456");
		const rates = await run.ok("xero_list_tax_rates", {});
		expect(items(rates)).toEqual([
			{
				tax_type: "OUTPUT2",
				name: "20% (VAT on Income)",
				display_rate: "20",
				effective_rate: "20",
				for_sales: true,
				for_expenses: false,
				components: [{ name: "VAT", rate: "20", compound: false, non_recoverable: false }],
			},
		]);
		xero.accounts = Array.from({ length: 2001 }, (_, n) => ({ Code: String(n), Status: "ACTIVE" }));
		expect(await run.code("xero_list_accounts", {})).toBe("PROVIDER_LIMIT");
		xero.accounts = Array.from({ length: 2000 }, (_, n) => ({ Code: String(n), Status: n % 2 ? "ACTIVE" : "ARCHIVED" }));
		expect(items(await run.ok("xero_list_accounts", {}))).toHaveLength(1000);
		xero.taxRates = Array.from({ length: 501 }, () => ({ Name: "r" }));
		expect(await run.error("xero_list_tax_rates", {})).toEqual({ code: "PROVIDER_LIMIT", message: "This organisation has more tax rates than Minerva reads." });
		xero.taxRates = Array.from({ length: 500 }, () => ({ Name: "r" }));
		expect(items(await run.ok("xero_list_tax_rates", {}))).toHaveLength(500);
	});

	test("responses Minerva cannot read exactly or in full are refused", async () => {
		// The read limit, and amounts JSON parsing may have rounded (client.ts).
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read"] });
		xero.hook = () => new Response(`{"Accounts": [], "pad": "${"x".repeat(4 * 1024 * 1024)}"}`, { status: 200 });
		expect(await run.error("xero_list_accounts", {})).toEqual({ code: "RESPONSE_TOO_LARGE", message: "Xero's response was too large to read." });
		xero.hook = () => {
			const found = invoiceOf(INVOICE, "ACCREC", contactOf(CUSTOMER, "C"));
			return new Response(`{"Invoices": [${JSON.stringify(found).replace('"Total":120', '"Total":9007199254740993')}]}`, { status: 200 });
		};
		expect(await run.error("xero_get_invoice", { invoice: INVOICE })).toEqual({ code: "PROVIDER_FAILED", message: "Xero returned an unexpected response." });
		xero.hook = () => {
			const found = invoiceOf(INVOICE, "ACCREC", contactOf(CUSTOMER, "C"));
			return new Response(`{"Invoices": [${JSON.stringify(found).replace('"Total":120', '"Total":"120.00"')}]}`, { status: 200 });
		};
		// An amount sent as a string is not Xero's: Xero sends numbers.
		expect(await run.error("xero_get_invoice", { invoice: INVOICE })).toEqual({ code: "PROVIDER_FAILED", message: "Xero returned an unexpected response." });
		xero.hook = () => {
			const found = invoiceOf(INVOICE, "ACCREC", contactOf(CUSTOMER, "C"));
			return new Response(`{"Invoices": [${JSON.stringify(found).replace('"Total":120', '"Total":9007199254740991.0')}]}`, { status: 200 });
		};
		expect(items(await run.ok("xero_get_invoice", { invoice: INVOICE }))[0]?.total).toBe("9007199254740991.00");
		// A byte order mark is dropped; bytes that are not UTF-8, or a list that is null, are not Xero's answer.
		xero.hook = (method, path) => (method === "GET" && path.endsWith("/Accounts") ? new Response(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"Accounts": [{"Code": "200"}]}')]), { status: 200 }) : null);
		expect(items(await run.ok("xero_list_accounts", {}))[0]?.code).toBe("200");
		xero.hook = (method, path) => (method === "GET" && path.endsWith("/Accounts") ? new Response(Uint8Array.from([0x7b, 0xff, 0x7d]), { status: 200 }) : null);
		expect(await run.error("xero_list_accounts", {})).toEqual({ code: "PROVIDER_FAILED", message: "Xero returned an unexpected response." });
		xero.hook = (method, path) => (method === "GET" && path.endsWith("/Contacts") ? jsonResponse(200, { Contacts: null }) : null);
		expect(await run.error("xero_search_contacts", {})).toEqual({ code: "PROVIDER_FAILED", message: "Xero returned an unexpected response." });
		xero.hook = (method, path) => (method === "GET" && path.endsWith("/Contacts") ? FakeXero.error(429) : null);
		expect(await run.error("xero_search_contacts", { text: "x" })).toEqual({ code: "PROVIDER_RATE_LIMITED", message: "Xero is rate limiting requests. Try again later." });
	});
});

// Drafting

const DRAFT_LINES: JsonObject[] = [
	{ description: "Consulting, October", quantity: "1.50", unit_amount: "80.1250", account_code: "200", tax_type: "OUTPUT2", discount_rate: "10.0" },
	{ description: "Goodwill", quantity: "1", unit_amount: "-5" },
];
const DRAFT: JsonObject = {
	contact: CUSTOMER,
	date: "2026-10-01",
	due_date: "2026-10-31",
	currency: "EUR",
	amounts_are: "inclusive",
	number: "INV-0100",
	reference: "PO 9",
	lines: DRAFT_LINES,
};

describe("drafting", () => {
	test("a draft invoice is sent field by field and always a draft", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read", "draft_sales"] });
		const outcome = await run.ok("xero_create_draft_invoice", DRAFT);
		expect(xero.writes).toHaveLength(1);
		const [tenant, params, sent] = xero.writes[0] as [string, { [name: string]: string }, JsonObject];
		expect([tenant, params]).toEqual([ACME, { summarizeErrors: "true", unitdp: "4" }]);
		expect(sent).toEqual({
			Invoices: [
				{
					Type: "ACCREC",
					Status: "DRAFT",
					Contact: { ContactID: CUSTOMER },
					LineAmountTypes: "Inclusive",
					LineItems: [
						{ Description: "Consulting, October", Quantity: 1.5, UnitAmount: 80.125, AccountCode: "200", TaxType: "OUTPUT2", DiscountRate: 10 },
						{ Description: "Goodwill", Quantity: 1, UnitAmount: -5 },
					],
					Date: "2026-10-01",
					DueDate: "2026-10-31",
					CurrencyCode: "EUR",
					InvoiceNumber: "INV-0100",
					Reference: "PO 9",
				},
			],
		});
		// The amounts are written as their decimals.
		const text = xero.requests.find((request) => request.method === "PUT")?.text ?? "";
		expect(text).toContain('"Quantity":1.5,"UnitAmount":80.125,');
		expect(text).toContain('"DiscountRate":10}');
		expect(text).toContain('"Quantity":1,"UnitAmount":-5}');
		expect(xero.requests.find((request) => request.method === "PUT")?.headers.get("content-type")).toBe("application/json");
		expect(items(outcome)).toEqual([
			{
				created: true,
				id: "20000000-0000-4000-8000-000000000001",
				type: "sales",
				status: "DRAFT",
				number: "INV-0100",
				reference: "PO 9",
				contact: { id: CUSTOMER, name: "Carol Customer" },
				date: "2026-09-01",
				due_date: "2026-09-15",
				currency: "EUR",
				sub_total: "115.1875",
				total_tax: "0.00",
				total: "115.1875",
				warnings: ["Account code '200' has been archived"],
			},
		]);
		// The contact is read before writing, in the same organisation.
		expect(xero.accounting().map((request) => request.url.pathname).slice(-2)).toEqual([`/api.xro/2.0/Contacts/${CUSTOMER}`, "/api.xro/2.0/Invoices"]);

		const line = DRAFT_LINES[0] as JsonObject;
		const invalid: JsonObject[] = [
			{ ...DRAFT, status: "AUTHORISED" },
			{ ...DRAFT, contact: { Name: "New Co" } },
			{ ...DRAFT, lines: [] },
			{ ...DRAFT, lines: [{ ...line, Status: "PAID" }] },
			{ ...DRAFT, lines: [{ ...line, quantity: 1.5 }] },
			{ ...DRAFT, due_date: "2026-09-30" },
			{ ...DRAFT, currency: "eur" },
			{ ...DRAFT, number: "INV\n1" },
		];
		for (const bad of invalid) {
			expect([bad, await run.code("xero_create_draft_invoice", bad)]).toEqual([bad, "INVALID_ARGUMENTS"]);
		}
		expect(xero.writes).toHaveLength(1);
		// The same draft again is answered from the run's record, and sends nothing.
		const again = await run.ok("xero_create_draft_invoice", { ...DRAFT, lines: [{ ...line, quantity: "1.5" }, DRAFT_LINES[1] as JsonObject] });
		expect([again.repeat, items(again)]).toEqual([true, items(outcome)]);
		expect(xero.writes).toHaveLength(1);
	});

	test("bills and sales invoices are separate permissions", async () => {
		const xero = fake();
		const run = await start(xero, { [ACME]: ["read", "draft_bills"], [BETA]: ["read", "draft_sales"] });
		const line = { description: "Paper", quantity: "2", unit_amount: "4.20" };
		const bill = { organisation: ACME, contact: SUPPLIER, number: "S-77", lines: [line] };
		const outcome = await run.ok("xero_create_draft_bill", bill);
		expect([items(outcome)[0]?.type, items(outcome)[0]?.number]).toEqual(["bill", "S-77"]);
		expect(((xero.writes.at(-1)?.[2] as JsonObject).Invoices as JsonObject[])[0]).toEqual({
			Type: "ACCPAY",
			Status: "DRAFT",
			Contact: { ContactID: SUPPLIER },
			LineAmountTypes: "Exclusive",
			LineItems: [{ Description: "Paper", Quantity: 2, UnitAmount: 4.2 }],
			InvoiceNumber: "S-77",
		});
		const sales = { organisation: ACME, contact: CUSTOMER, lines: [line] };
		expect(await run.code("xero_create_draft_invoice", sales)).toBe("POLICY_DENIED");
		expect(await run.code("xero_create_draft_bill", { ...bill, organisation: BETA })).toBe("POLICY_DENIED");
		const invalid: JsonObject[] = [{ reference: "x" }, { lines: [{ ...line, discount_rate: "5" }] }];
		for (const bad of invalid) {
			expect(await run.code("xero_create_draft_bill", { ...bill, ...bad })).toBe("INVALID_ARGUMENTS");
		}
		expect(xero.writes).toHaveLength(1);
		expect(xero.accounting(BETA)).toEqual([]);
	});

	test("drafting needs its consent", async () => {
		const xero = fake();
		onlyAcme(xero);
		const reading = SCOPES.filter((scope) => scope !== "accounting.invoices");
		const run = await start(xero, { [ACME]: ["read", "draft_sales", "draft_bills"] }, { scopes: reading });
		expect(new Set(run.tools.filter((tool) => tool.startsWith("xero_")))).toEqual(
			new Set(["xero_list_organisations", "xero_search_contacts", "xero_search_invoices", "xero_get_invoice", "xero_list_accounts", "xero_list_tax_rates"]),
		);
	});

	test("a draft needs an active contact in the organisation", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read", "draft_sales"] });
		const line = { description: "x", quantity: "1", unit_amount: "1" };
		const missing = "c0000000-0000-4000-8000-000000000009";
		expect(await run.error("xero_create_draft_invoice", { contact: missing, lines: [line] })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "This organisation has no contact with that id.",
		});
		expect(await run.error("xero_create_draft_invoice", { contact: ARCHIVED, lines: [line] })).toEqual({ code: "INVALID_ARGUMENTS", message: "This contact is archived in Xero." });
		// A contact of another organisation is not one of this organisation's.
		xero.contacts[BETA]?.push(contactOf(missing, SECRET));
		expect(await run.code("xero_create_draft_invoice", { contact: missing, lines: [{ ...line, description: "y" }] })).toBe("INVALID_ARGUMENTS");
		expect(xero.accounting(BETA)).toEqual([]);
		// A contact answered for another id is Xero's error.
		xero.hook = (method) => (method === "GET" ? jsonResponse(200, { Contacts: [xero.contacts[ACME]?.[1] as JsonObject] }) : null);
		expect(await run.code("xero_create_draft_invoice", { contact: CUSTOMER, lines: [line] })).toBe("PROVIDER_FAILED");
		expect(xero.writes).toEqual([]);
		expect(run.writes()).toEqual([]);
	});

	test("refused drafts pause nothing and odd answers are shown as they are", async () => {
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read", "draft_sales"] });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const draft = (n: number) => ({ contact: CUSTOMER, lines: [{ description: `x${n}`, quantity: "1", unit_amount: "1" }] });

		const invalid = { Type: "ValidationException", Message: SECRET, Elements: [{ ValidationErrors: [{ Message: "Invoice # must be unique." }] }] };
		xero.hook = (method) => (method === "PUT" ? FakeXero.error(400, invalid) : null);
		expect(await run.error("xero_create_draft_invoice", draft(1))).toEqual({ code: "PROVIDER_REJECTED", message: "Xero rejected this: Invoice # must be unique." });

		// A refusal answered with 200, as when summarizeErrors is ignored.
		const refused = { InvoiceID: ZERO_UUID, HasErrors: true, ValidationErrors: [{ Message: "Contact is archived." }] };
		xero.hook = (method) => (method === "PUT" ? jsonResponse(200, { Invoices: [refused] }) : null);
		expect((await run.error("xero_create_draft_invoice", draft(2))).message).toBe("Xero rejected this: Contact is archived.");

		// Anything but the draft asked for is shown as Xero created it.
		xero.hook = (method, _path, _params, sent) =>
			method === "PUT" ? jsonResponse(200, { Invoices: [{ ...xero.created(ACME, ((sent as JsonObject).Invoices as JsonObject[])[0] as JsonObject), Status: "AUTHORISED" }] }) : null;
		expect(items(await run.ok("xero_create_draft_invoice", draft(3)))[0]?.status).toBe("AUTHORISED");
		expect(errors).toHaveBeenLastCalledWith("Xero answered a draft sales with status AUTHORISED, type ACCREC");

		xero.hook = (method, _path, _params, sent) => {
			if (method !== "PUT") return null;
			const created = xero.created(ACME, ((sent as JsonObject).Invoices as JsonObject[])[0] as JsonObject);
			return jsonResponse(200, { Invoices: [{ ...created, Contact: { ...(created.Contact as JsonObject), ContactID: SUPPLIER } }] });
		};
		expect((items(await run.ok("xero_create_draft_invoice", draft(4)))[0]?.contact as JsonObject).id).toBe(SUPPLIER);

		xero.hook = (method) => (method === "PUT" ? jsonResponse(200, { Invoices: [] }) : null);
		const outcome = await run.ok("xero_create_draft_invoice", draft(5));
		expect(outcome.result.outcome).toBe("applied_without_result");

		// The two refusals paused nothing.
		xero.hook = null;
		expect(items(await run.ok("xero_create_draft_invoice", draft(6)))).not.toHaveLength(0);
		expect(run.paused()).toBe(false);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
	});

	test("a draft Xero may or may not have made pauses later drafts", async () => {
		// A write whose outcome is unknown (a 500) makes the run uncertain.
		const xero = fake();
		onlyAcme(xero);
		const run = await start(xero, { [ACME]: ["read", "draft_sales"] });
		const draft = (n: number) => ({ contact: CUSTOMER, lines: [{ description: `x${n}`, quantity: "1", unit_amount: "1" }] });
		xero.hook = (method) => (method === "PUT" ? FakeXero.error(500) : null);
		expect((await run.error("xero_create_draft_invoice", draft(1))).code).toBe("WRITE_UNCERTAIN");
		xero.hook = null;
		expect((await run.error("xero_create_draft_invoice", draft(2))).code).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
		expect(xero.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
	});

	test("amounts are checked decimals", async () => {
		const line = (fields: JsonObject = {}): JsonObject => ({ description: "x", quantity: "1", unit_amount: "1", ...fields });
		const sent = async (fields: JsonObject): Promise<string> => {
			const validated = await validateInput(DraftInvoice, { contact: CUSTOMER, lines: [line(fields)] });
			if (!validated.ok) throw new Error(validated.message);
			const items = body(validated.data as unknown as DraftInvoice, "sales").LineItems as Json[];
			return JSON.stringify(items[0]);
		};
		expect(await sent({ quantity: "2.500", unit_amount: "-0.0" })).toBe('{"Description":"x","Quantity":2.5,"UnitAmount":0}');
		expect(parseJson(await sent({ unit_amount: "9999999999.9999" }))).toMatchObject({ UnitAmount: 9999999999.9999 });
		expect(await sent({ unit_amount: "9999999999.9999" })).toContain('"UnitAmount":9999999999.9999');
		expect(await sent({ discount_rate: "100" })).toContain('"DiscountRate":100}');
		const refused: JsonObject[] = [
			{ quantity: "0" },
			{ quantity: "-1" },
			{ quantity: "1.00001" },
			{ quantity: "1e3" },
			{ unit_amount: "1,00" },
			{ unit_amount: "NaN" },
			{ unit_amount: "12345678901" },
			{ discount_rate: "100.01" },
			{ discount_rate: "-1" },
		];
		for (const fields of refused) {
			await expect(sent(fields)).rejects.toThrow(/^Invalid arguments\. lines\.0\./);
		}
		const validated = await validateInput(DraftBill, { contact: CUSTOMER, lines: [line()] });
		if (!validated.ok) throw new Error(validated.message);
		expect(JSON.stringify(body(validated.data as unknown as DraftBill, "bill"))).toBe(
			`{"Type":"ACCPAY","Status":"DRAFT","Contact":{"ContactID":"${CUSTOMER}"},"LineAmountTypes":"Exclusive","LineItems":[{"Description":"x","Quantity":1,"UnitAmount":1}]}`,
		);
	});
});
