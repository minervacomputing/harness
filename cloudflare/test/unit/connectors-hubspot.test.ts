// backend/tests/test_hubspot.py, case by case: the HubSpot connector against an in-memory HubSpot CRM API
// behind an injected `fetch`, runs through the executor (test/unit/executor-fakes.ts's Scenario, the port of
// connector_runs.py), and its tokens; then what the port adds: the registry and its fingerprints, limits and
// refusals the Python tests leave to the code.

import { describe, expect, test } from "vitest";
import type { GrantRow } from "../../src/contracts/policy.ts";
import type { ToolCallOutcome } from "../../src/contracts/executor.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { classify } from "../../src/connectors/hubspot/client.ts";
import { SCOPES, hubspotConnector } from "../../src/connectors/hubspot/connector.ts";
import { DEAL_PROPERTIES, after } from "../../src/connectors/hubspot/scope.ts";
import { noteHtml } from "../../src/connectors/hubspot/writes.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { MAX_ALIAS_SUFFIX, MAX_TOOL_NAME, Registry } from "../../src/gateway/registry.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { type OAuth2, planRefresh, tokenBody, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { Scenario, type ScenarioConnection, USER } from "./executor-fakes.ts";

const HUBSPOT = "0199a000-0000-7000-8000-0000000000b5";
const TOKEN = "hubspot-token";
const SECRET = "SECRET merger";
const PREFIX = "/crm/objects/2026-09/";
const [ADA, GRACE, MERGED] = ["101", "102", "103"];
const [ACME, INITECH] = ["201", "202"];
const [BIG, PARTNER, SMALL] = ["301", "302", "303"];
const SINGULAR: { [name: string]: string } = { contact: "contacts", company: "companies", deal: "deals" };

type Properties = { [name: string]: string | null };

function stage(id: string, order: number, archived = false): JsonObject {
	return {
		id,
		label: id.charAt(0).toUpperCase() + id.slice(1),
		displayOrder: order,
		archived,
		metadata: { probability: "0.5", isClosed: id === "closedwon" ? "true" : "false" },
	};
}

function json(status: number, body: Json): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A request as the fake saw it. */
interface Seen {
	method: string;
	url: URL;
	headers: Headers;
	body: JsonObject;
}

/**
 * HubSpot's CRM for one account (test_hubspot.py `FakeHubSpot`).
 *
 * Pipelines: Sales ("default"), Partners ("200") and an archived one ("300"). Contacts Ada and Grace (and one
 * merged into Ada), companies Acme and Initech, and deals Big and Small in Sales and Partner in Partners. Ada
 * works at Acme; Big is associated with both, Partner with Grace.
 */
class FakeHubSpot {
	pipelines = new Map<string, JsonObject>([
		["default", { id: "default", label: "Sales", displayOrder: 0, archived: false, stages: [stage("qualified", 1), stage("closedwon", 2), stage("retired", 3, true)] }],
		["200", { id: "200", label: "Partners", displayOrder: 1, archived: false, stages: [stage("signed", 1)] }],
		["300", { id: "300", label: "Old", displayOrder: 2, archived: true, stages: [] }],
	]);
	records: { [type: string]: Map<string, Properties> } = {
		contacts: new Map<string, Properties>([
			[ADA, { email: "ada@example.com", firstname: "Ada", lastname: "Lovelace" }],
			[GRACE, { email: "grace@example.com", firstname: "Grace", jobtitle: SECRET }],
		]),
		companies: new Map<string, Properties>([
			[ACME, { name: "Acme", domain: "acme.example", description: "x".repeat(3000) }],
			[INITECH, { name: "Initech", domain: "initech.example" }],
		]),
		deals: new Map<string, Properties>([
			[BIG, { dealname: "Big", pipeline: "default", dealstage: "qualified", amount: "9000" }],
			[PARTNER, { dealname: SECRET, pipeline: "200", dealstage: "signed" }],
			[SMALL, { dealname: "Small", pipeline: "default", dealstage: "closedwon" }],
		]),
		notes: new Map(),
	};
	merged = new Map([[`contacts:${MERGED}`, ADA]]);
	associations = new Set([pair(["deals", BIG], ["contacts", ADA]), pair(["deals", BIG], ["companies", ACME]), pair(["deals", PARTNER], ["contacts", GRACE]), pair(["contacts", ADA], ["companies", ACME])]);
	/** Where the search index still places a deal, if not where it is. */
	indexed = new Map<string, string>();
	/** A deal that moves to another pipeline once it has been read. */
	moves = new Map<string, string>();
	requests: Seen[] = [];
	writes: [method: string, path: string, body: JsonObject][] = [];
	hook: ((request: Seen) => Response | null | undefined | void) | null = null;
	nextId = 900;

	static error(status: number, category: string): Response {
		return json(status, { status: "error", category, message: SECRET });
	}

	static record(id: string, properties: Properties, wanted: readonly string[]): JsonObject {
		return { id, properties: Object.fromEntries(wanted.map((name) => [name, properties[name] ?? null])), archived: false };
	}

	table(type: string): Map<string, Properties> {
		const table = this.records[type];
		if (table === undefined) throw new Error(`No ${type}`);
		return table;
	}

	#matches(type: string, id: string, properties: Properties, body: JsonObject): boolean {
		const query = String(body.query ?? "").toLowerCase();
		if (query && !Object.values(properties).some((value) => String(value ?? "None").toLowerCase().includes(query))) return false;
		for (const group of (body.filterGroups ?? []) as { filters: { propertyName: string; value: string }[] }[]) {
			for (const filter of group.filters) {
				if (filter.propertyName.startsWith("associations.")) {
					const other = SINGULAR[filter.propertyName.slice("associations.".length)] as string;
					if (!this.associations.has(pair([type, id], [other, filter.value]))) return false;
				} else if (properties[filter.propertyName] !== filter.value) return false;
			}
		}
		return true;
	}

	#search(type: string, body: JsonObject): JsonObject {
		const found: JsonObject[] = [];
		for (const [id, properties] of this.table(type)) {
			const seen = { ...properties };
			if (type === "deals" && this.indexed.has(id)) seen.pipeline = this.indexed.get(id) as string;
			if (this.#matches(type, id, seen, body)) found.push(FakeHubSpot.record(id, seen, body.properties as string[]));
		}
		const start = Number(body.after ?? 0);
		const size = body.limit as number;
		const page: JsonObject = { total: found.length, results: found.slice(start, start + size) };
		if (start + size < found.length) page.paging = { next: { after: String(start + size) } };
		return page;
	}

	#get(type: string, requested: string, wanted: string[]): Response {
		const id = this.merged.get(`${type}:${requested}`) ?? requested;
		const properties = this.table(type).get(id);
		if (properties === undefined) return FakeHubSpot.error(404, "OBJECT_NOT_FOUND");
		const response = json(200, FakeHubSpot.record(id, properties, wanted));
		const move = this.moves.get(id);
		if (type === "deals" && move !== undefined) {
			properties.pipeline = move;
			this.moves.delete(id);
		}
		return response;
	}

	#taken(email: Json | undefined, id: string | null): boolean {
		return email !== undefined && email !== null && [...this.table("contacts")].some(([other, contact]) => contact.email === email && other !== id);
	}

	#write(method: string, path: string, body: JsonObject): Response {
		this.writes.push([method, path, body]);
		const parts = path.slice(PREFIX.length).split("/");
		const type = parts[0] as string;
		const changes = body.properties as Properties;
		let id: string;
		if (method === "PATCH") {
			id = this.merged.get(`${type}:${parts[1]}`) ?? (parts[1] as string);
			const properties = this.table(type).get(id);
			if (properties === undefined) return FakeHubSpot.error(404, "OBJECT_NOT_FOUND");
			if (type === "contacts" && this.#taken(changes.email, id)) return FakeHubSpot.error(409, "CONFLICT");
			Object.assign(properties, changes);
		} else {
			if (type === "contacts" && this.#taken(changes.email, null)) return FakeHubSpot.error(409, "CONFLICT");
			this.nextId += 1;
			id = String(this.nextId);
			this.table(type).set(id, { ...changes });
		}
		// HubSpot answers an update with the properties it changed, and a creation with all it set.
		return json(200, FakeHubSpot.record(id, this.table(type).get(id) as Properties, Object.keys(changes)));
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		const seen: Seen = { method: request.method, url, headers: request.headers, body: text ? (parseJson(text) as JsonObject) : {} };
		this.requests.push(seen);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return FakeHubSpot.error(401, "INVALID_AUTHENTICATION");
		const hooked = this.hook?.(seen);
		if (hooked) return hooked;
		const path = url.pathname;
		if (path === "/account-info/2026-09/details") return json(200, { portalId: 4242, portalName: "Acme Corp", uiDomain: "x" });
		if (path === "/crm/pipelines/2026-09/deals") return json(200, { results: [...this.pipelines.values()] });
		if (path.startsWith("/crm/pipelines/2026-09/deals/")) {
			const found = this.pipelines.get(path.split("/").pop() as string);
			return found ? json(200, found) : FakeHubSpot.error(404, "OBJECT_NOT_FOUND");
		}
		if (!path.startsWith(PREFIX)) throw new Error(path);
		const parts = path.slice(PREFIX.length).split("/");
		const [type] = parts as [string];
		if (request.method === "POST" && parts.length === 2 && parts[1] === "search") return json(200, this.#search(type, seen.body));
		if (request.method === "POST" && parts.length === 3 && parts[1] === "batch" && parts[2] === "read") {
			const table = this.table(type);
			const found = (seen.body.inputs as { id: string }[])
				.filter((item) => table.has(item.id))
				.map((item) => FakeHubSpot.record(item.id, table.get(item.id) as Properties, seen.body.properties as string[]));
			return json(200, { status: "COMPLETE", results: found });
		}
		if (request.method === "GET" && parts.length === 2) return this.#get(type, parts[1] as string, (url.searchParams.get("properties") ?? "").split(","));
		if ((request.method === "POST" && parts.length === 1) || (request.method === "PATCH" && parts.length === 2)) return this.#write(request.method, path, seen.body);
		throw new Error(path);
	};

	client(token = TOKEN) {
		return hubspotConnector().client(token, settingsIo(this.fetch));
	}
}

function pair(a: [string, string], b: [string, string]): string {
	return JSON.stringify([a.join(":"), b.join(":")].sort());
}

function connection(): ScenarioConnection {
	return { id: HUBSPOT, provider: "hubspot", payload: { kind: "oauth2", access_token: TOKEN, refresh_token: null, scopes: [...SCOPES] } };
}

/** User grants on records ({resource: actions}), as test_hubspot.py's `record` builds them. */
function records(grants: { [resource: string]: string[] }): GrantRow[] {
	return Object.entries(grants).map(([resourceId, actions]) => ({
		layer: "user",
		subject: USER,
		connectionId: HUBSPOT,
		kind: "record",
		resourceId,
		resourceName: "",
		actions,
		effect: "allow",
	}));
}

/** Starts and claims a run with these grants (test_hubspot.py `start`). */
function start(hubspot: FakeHubSpot, grants: { [resource: string]: string[] }): Promise<Scenario> {
	return Scenario.start({ connectors: [hubspotConnector()], connections: [connection()], user: records(grants), fetch: hubspot.fetch });
}

const READ = ["read"];

function items(outcome: Extract<ToolCallOutcome, { ok: true }>): JsonObject[] {
	return outcome.result.items;
}

function ids(outcome: Extract<ToolCallOutcome, { ok: true }>): Json[] {
	return items(outcome).map((item) => item.id as Json);
}

function searches(hubspot: FakeHubSpot, type: string): JsonObject[] {
	return hubspot.requests.filter((request) => request.url.pathname === `${PREFIX}${type}/search`).map((request) => request.body);
}

function errorOf(response: Response, body: string): OperationError | null {
	return classify("HubSpot", response, body);
}

async function hubspotError(status: number, category: string): Promise<[Response, string]> {
	const response = FakeHubSpot.error(status, category);
	return [response, await response.text()];
}

describe("the client and connecting", () => {
	test("HubSpot's errors are named without its wording", async () => {
		const missing = errorOf(...(await hubspotError(403, "MISSING_SCOPES")));
		expect(missing?.code).toBe("PROVIDER_FORBIDDEN");
		expect(missing?.message).toContain("Reconnect HubSpot");
		const conflict = errorOf(...(await hubspotError(409, "CONFLICT")));
		expect(conflict?.code).toBe("PROVIDER_REJECTED");
		expect(errorOf(...(await hubspotError(403, "FORBIDDEN")))).toBeNull();
		expect(errorOf(new Response("<html>", { status: 409 }), "<html>")?.code).toBe("PROVIDER_REJECTED");
		for (const error of [missing, conflict]) expect(error?.message).not.toContain(SECRET);
	});

	test("search offsets stop where HubSpot does", () => {
		expect(after(null, 10)).toBeNull();
		expect(after("9990", 10)).toBe("9990");
		for (const value of ["9991", "010", "-1", "1e3", "abc", "100000"]) {
			let code: string | null = null;
			try {
				after(value, 10);
			} catch (error) {
				code = error instanceof OperationError ? error.code : null;
			}
			expect(code).toBe("INVALID_CURSOR");
		}
	});

	test("notes only show their text", () => {
		expect(noteHtml('<a href="x">hi</a> & bye\r\nnext')).toBe("&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt; &amp; bye<br>next");
	});

	test("the connection is the HubSpot account", async () => {
		const hubspot = new FakeHubSpot();
		const connector = hubspotConnector();
		expect(await connector.account(hubspot.client())).toEqual({ id: "4242", label: "Acme Corp (4242)" });
		await expect(connector.account(hubspot.client("other"))).rejects.toMatchObject({ code: "CONNECTION_UNAUTHORIZED" });
		// Without a name, the account is named by its number.
		hubspot.hook = (request) => (request.url.pathname.startsWith("/account-info/") ? json(200, { portalId: "007", portalName: "" }) : null);
		expect(await connector.account(hubspot.client())).toEqual({ id: "7", label: "HubSpot 7" });
	});

	test("HubSpot's tokens carry their scopes (test_hubspot_tokens_carry_their_scopes)", async () => {
		// The code exchange itself is the web API's (plan step 5); its parts are here: the request to the
		// declared token URL with the client in the form, no PKCE verifier, and the scopes HubSpot lists.
		const oauth = hubspotConnector().auth as OAuth2;
		expect(oauth.tokenUrl).toBe("https://api.hubspot.com/oauth/2026-09/token");
		expect(oauth.pkce).toBe(false);
		const creds = { clientId: "id", clientSecret: "secret", redirectUri: "https://x/cb" };
		const request = tokenRequest(oauth, creds, [
			["code", "c"],
			["redirect_uri", creds.redirectUri],
			["grant_type", "authorization_code"],
		]);
		const form = new URLSearchParams(request.body as string);
		expect([...form.keys()]).toEqual(["client_id", "client_secret", "code", "redirect_uri", "grant_type"]);
		expect(form.get("client_id")).toBe("id");
		expect(form.get("client_secret")).toBe("secret");
		const issued = { token_type: "bearer", access_token: "a", refresh_token: "r", expires_in: 1800, hub_id: 4242, scopes: [...SCOPES] };
		const body = tokenBody(JSON.stringify(issued));
		expect(body).not.toBeNull();
		const tokens = tokenPayload(body as JsonObject, Date.UTC(2026, 9, 11));
		expect(tokens.scopes).toEqual([...SCOPES].sort());
		expect(tokens.expires_at).toBe(Date.UTC(2026, 9, 11) / 1000 + 1800);

		// A refresh goes to the same endpoint, and keeps the scopes HubSpot lists.
		const sent: { url: string; body: string }[] = [];
		const plan = await planRefresh(
			hubspotConnector(),
			{ kind: "oauth2", access_token: "a", refresh_token: "r", scopes: [...SCOPES], client_id: "id" },
			{
				clients: { configured: () => ({ clientId: "id", clientSecret: "secret" }), stored: async () => null },
				siteUrl: "https://minerva.example",
				fetch: async (input, init) => {
					sent.push({ url: String(input), body: String(init?.body) });
					return json(200, { ...issued, access_token: "a2", scopes: ["oauth", "crm.objects.contacts.read"] });
				},
				now: () => Date.UTC(2026, 9, 11),
				log: () => {},
			},
			HUBSPOT,
		);
		if (plan.kind !== "send") throw new Error("HubSpot's tokens refresh.");
		const refreshed = await plan.send();
		expect(sent).toEqual([{ url: "https://api.hubspot.com/oauth/2026-09/token", body: "client_id=id&client_secret=secret&grant_type=refresh_token&refresh_token=r" }]);
		expect(refreshed.kind === "refreshed" && refreshed.payload.scopes).toEqual(["crm.objects.contacts.read", "oauth"]);
	});
});

describe("discovery", () => {
	test("collections and pipelines are offered, but never single records", async () => {
		const hubspot = new FakeHubSpot();
		const connector = hubspotConnector();
		const client = hubspot.client();
		const page = await connector.discover(client, "record", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			["contacts", "All contacts"],
			["companies", "All companies"],
			["deals", "All deals"],
			["pipeline:default", "Deals in Sales"],
			["pipeline:200", "Deals in Partners"],
		]);
		const found = await connector.discover(client, "record", { query: "partn", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual(["pipeline:200"]);
		const described = await connector.describe(client, "record", ["deals", "pipeline:300", "pipeline:nope", `contact:${ADA}`, "deal:301", "*"]);
		expect(described).toEqual({ deals: "All deals", "pipeline:300": "Deals in Old" });
		const requests = hubspot.requests.length;
		expect(await connector.describe(client, "record", ["contacts"])).toEqual({ contacts: "All contacts" });
		expect(hubspot.requests.length).toBe(requests);
	});

	test("a search ignores case", async () => {
		const hubspot = new FakeHubSpot();
		hubspot.pipelines.set("400", { id: "400", label: "Großkunden", displayOrder: 3, archived: false, stages: [] });
		const connector = hubspotConnector();
		const found = await connector.discover(hubspot.client(), "record", { query: "GROß", cursor: null });
		expect(found.items).toEqual([{ id: "pipeline:400", name: "Deals in Großkunden" }]);
	});

	test("more pipelines than Minerva reads are refused; ids HubSpot would not take are left out", async () => {
		const hubspot = new FakeHubSpot();
		hubspot.pipelines.set("a b", { id: "a b", label: "Spaced", displayOrder: 4, archived: false, stages: [] });
		const connector = hubspotConnector();
		const page = await connector.discover(hubspot.client(), "record", { query: "spaced", cursor: null });
		expect(page.items).toEqual([]);
		// 100 are read (the four above and 96 more), 101 are not.
		for (let i = 0; i < 96; i++) hubspot.pipelines.set(`p${i}`, { id: `p${i}`, label: `P${i}`, archived: false });
		expect((await connector.discover(hubspot.client(), "record", { query: null, cursor: null })).items).toHaveLength(3 + 2 + 96);
		hubspot.pipelines.set("p96", { id: "p96", label: "P96" });
		await expect(connector.discover(hubspot.client(), "record", { query: null, cursor: null })).rejects.toMatchObject({
			code: "PROVIDER_LIMIT",
			message: "There are more deal pipelines than Minerva reads.",
		});
	});
});

describe("reads", () => {
	test("contacts and companies are read as collections", async () => {
		const hubspot = new FakeHubSpot();
		let run = await start(hubspot, { contacts: READ });
		const contacts = items(await run.ok("hubspot_search_contacts", { query: "example.com" }));
		expect(contacts.map((contact) => contact.id)).toEqual([ADA, GRACE]);
		expect(contacts[0]?.email).toBe("ada@example.com");
		expect(Object.hasOwn(contacts[0] as JsonObject, "mobilephone")).toBe(true);
		const [search, ...others] = searches(hubspot, "contacts");
		expect(others).toEqual([]);
		expect(search?.sorts).toEqual([{ propertyName: "lastmodifieddate", direction: "DESCENDING" }]);
		expect(search?.query).toBe("example.com");
		expect(search?.filterGroups).toEqual([]);
		expect(ids(await run.ok("hubspot_search_contacts", { email: "grace@example.com" }))).toEqual([GRACE]);
		// A merged contact answers under the contact it was merged into.
		expect(ids(await run.ok("hubspot_get_contact", { contact_id: MERGED }))).toEqual([ADA]);
		expect(await run.code("hubspot_get_contact", { contact_id: "999" })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_get_contact", { contact_id: "0101" })).toBe("INVALID_ARGUMENTS");
		expect(await run.code("hubspot_search_companies", {})).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_get_company", { company_id: ACME })).toBe("POLICY_DENIED");

		run = await start(hubspot, { companies: READ });
		const acme = items(await run.ok("hubspot_get_company", { company_id: ACME }))[0] as JsonObject;
		expect((acme.description as string).length).toBe(2000);
		expect(acme.description_truncated).toBe(true);
		expect(await run.code("hubspot_get_contact", { contact_id: ADA })).toBe("POLICY_DENIED");
	});

	test("association filters need Read on both sides", async () => {
		const hubspot = new FakeHubSpot();
		let run = await start(hubspot, { contacts: READ });
		expect(await run.code("hubspot_search_contacts", { company_id: ACME })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_search_contacts", { deal_id: BIG })).toBe("POLICY_DENIED");
		run = await start(hubspot, { contacts: READ, companies: READ, "pipeline:default": READ });
		expect(ids(await run.ok("hubspot_search_contacts", { company_id: ACME }))).toEqual([ADA]);
		expect(ids(await run.ok("hubspot_search_contacts", { deal_id: BIG }))).toEqual([ADA]);
		expect(searches(hubspot, "contacts").at(-1)?.filterGroups).toEqual([{ filters: [{ propertyName: "associations.deal", operator: "EQ", value: BIG }] }]);
		expect(ids(await run.ok("hubspot_search_companies", { contact_id: ADA }))).toEqual([ACME]);
		// A deal in a pipeline that is not allowed is refused like one that does not exist.
		expect(await run.code("hubspot_search_contacts", { deal_id: PARTNER })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_search_contacts", { deal_id: "999" })).toBe("POLICY_DENIED");
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default", company_id: ACME }))).toEqual([BIG]);
		expect(ids(await run.ok("hubspot_search_companies", { deal_id: BIG }))).toEqual([ACME]);
	});

	test("a pipeline grant shows only its deals", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { "pipeline:default": READ });
		const listed = items(await run.ok("hubspot_list_pipelines", {}));
		expect(listed.map((pipeline) => pipeline.id)).toEqual(["default"]);
		const stages = (listed[0] as JsonObject).stages as JsonObject[];
		expect(stages.map((item) => item.id)).toEqual(["qualified", "closedwon"]);
		expect(stages[1]?.closed).toBe(true);
		expect(ids(await run.ok("hubspot_search_deals", {}))).toEqual([BIG, SMALL]);
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default" }))).toEqual([BIG, SMALL]);
		expect(await run.code("hubspot_search_deals", { pipeline: "200" })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_get_deal", { deal_id: PARTNER })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_get_deal", { deal_id: "999" })).toBe("POLICY_DENIED");
		const big = items(await run.ok("hubspot_get_deal", { deal_id: BIG }))[0] as JsonObject;
		expect(big.dealname).toBe("Big");
		expect(big.amount).toBe("9000");
		expect(await run.code("hubspot_search_contacts", {})).toBe("POLICY_DENIED");
		// Narrowed across pipelines, where allowed deals land would tell whether hidden ones match.
		for (const narrowed of [{ query: "Big" }, { stage: "signed" }, { contact_id: GRACE }] as JsonObject[]) expect(await run.code("hubspot_search_deals", narrowed)).toBe("POLICY_DENIED");
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default", query: "Big" }))).toEqual([BIG]);

		// The search index still places Partner in Sales; the deal read again is in Partners.
		hubspot.indexed.set(PARTNER, "default");
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default" }))).toEqual([BIG, SMALL]);
		expect(JSON.stringify(items(await run.ok("hubspot_search_deals", {})))).not.toContain(SECRET);
	});

	test("deal searches page, unless a hidden deal could be hinted at", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { deals: READ });
		const first = await run.ok("hubspot_search_deals", { pipeline: "default", limit: 1 });
		expect(ids(first)).toEqual([BIG]);
		const cursor = first.result.next_cursor;
		expect(cursor).toBeDefined();
		expect(cursor).not.toBe("1");
		const second = await run.ok("hubspot_search_deals", { pipeline: "default", limit: 1, cursor: cursor as string });
		expect(ids(second)).toEqual([SMALL]);
		expect(second.result).not.toHaveProperty("next_cursor");
		expect(searches(hubspot, "deals").map((search) => search.after)).toEqual([undefined, "1"]);
		const narrowed = await run.ok("hubspot_search_deals", { query: "a", limit: 1 });
		expect(ids(narrowed)).toHaveLength(1);
		expect(narrowed.result).toHaveProperty("next_cursor");
		expect((await run.ok("hubspot_search_deals", { limit: 1 })).result).toHaveProperty("next_cursor");

		hubspot.hook = (request) => (request.url.pathname.endsWith("/search") ? json(200, { total: 20000, results: [], paging: { next: { after: "9995" } } }) : null);
		const stopped = await run.ok("hubspot_search_deals", { pipeline: "default", limit: 10 });
		expect(stopped.result.incomplete).toBe(true);
		expect(stopped.result).not.toHaveProperty("next_cursor");
	});
});

describe("writes", () => {
	test("contacts are created and edited", async () => {
		const hubspot = new FakeHubSpot();
		// Creating deals offers the tool, but not on contacts.
		let run = await start(hubspot, { contacts: READ, deals: ["read", "create"] });
		expect(await run.code("hubspot_create_contact", { email: "new@example.com" })).toBe("POLICY_DENIED");
		run = await start(hubspot, { contacts: ["read", "create", "edit"] });
		const created = items(await run.ok("hubspot_create_contact", { email: "new@example.com", firstname: "Nia" }));
		expect(created[0]?.email).toBe("new@example.com");
		expect(hubspot.writes.at(-1)).toEqual(["POST", `${PREFIX}contacts`, { properties: { email: "new@example.com", firstname: "Nia" }, associations: [] }]);
		const taken = await run.error("hubspot_create_contact", { email: "ada@example.com" });
		expect(taken.code).toBe("PROVIDER_REJECTED");
		expect(taken.message).toContain("already exists");
		expect(await run.code("hubspot_update_contact", { contact_id: ADA })).toBe("INVALID_ARGUMENTS");
		const edited = await run.ok("hubspot_update_contact", { contact_id: ADA, jobtitle: "Analyst" });
		expect(items(edited)).toEqual([{ id: ADA, jobtitle: "Analyst" }]);
		expect(hubspot.table("contacts").get(ADA)?.jobtitle).toBe("Analyst");
		expect(await run.code("hubspot_update_contact", { contact_id: "999", phone: "1" })).toBe("POLICY_DENIED");
		// The port's own: another contact's address, in the operation's words; a refused write is forgotten.
		expect(await run.error("hubspot_update_contact", { contact_id: ADA, email: "grace@example.com" })).toEqual({
			code: "PROVIDER_REJECTED",
			message: "Another contact already has this email address.",
		});
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded", "succeeded"]);
	});

	test("deals are created in an allowed pipeline, with associations that may be read", async () => {
		const hubspot = new FakeHubSpot();
		let run = await start(hubspot, { "pipeline:default": ["read", "create"], contacts: READ });
		const args = { pipeline: "default", stage: "qualified", name: "New", amount: "1500.50" };
		expect(await run.code("hubspot_create_deal", { ...args, company_ids: [ACME] })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_create_deal", { ...args, pipeline: "200", stage: "signed" })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_create_deal", { ...args, stage: "retired" })).toBe("INVALID_STAGE");
		expect(await run.code("hubspot_create_deal", { ...args, stage: "signed" })).toBe("INVALID_STAGE");
		expect(await run.code("hubspot_create_deal", { ...args, amount: "1,500" })).toBe("INVALID_ARGUMENTS");
		expect(await run.code("hubspot_create_deal", { ...args, close_date: "2026-2-1" })).toBe("INVALID_ARGUMENTS");
		expect(hubspot.writes).toEqual([]);
		const created = await run.ok("hubspot_create_deal", { ...args, close_date: "2026-12-31", contact_ids: [ADA, ADA] });
		expect(items(created)[0]?.dealname).toBe("New");
		expect(hubspot.writes).toHaveLength(1);
		const [[method, path, body]] = hubspot.writes as [[string, string, JsonObject]];
		expect([method, path]).toEqual(["POST", `${PREFIX}deals`]);
		expect(body.properties).toEqual({ pipeline: "default", dealstage: "qualified", dealname: "New", amount: "1500.50", closedate: "2026-12-31T00:00:00Z" });
		expect(body.associations).toEqual([{ to: { id: ADA }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }]);

		run = await start(hubspot, { deals: ["read", "create"], companies: READ });
		await run.ok("hubspot_create_deal", { ...args, company_ids: [ACME] });
		expect(((hubspot.writes.at(-1)?.[2].associations as JsonObject[])[0]?.types as JsonObject[])[0]?.associationTypeId).toBe(341);
	});

	test("deals are edited within their pipeline", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { "pipeline:default": ["read", "edit"] });
		expect(await run.code("hubspot_update_deal", { deal_id: PARTNER, name: "x" })).toBe("POLICY_DENIED");
		expect(await run.code("hubspot_update_deal", { deal_id: BIG, stage: "signed" })).toBe("INVALID_STAGE");
		expect(hubspot.writes).toEqual([]);
		await run.ok("hubspot_update_deal", { deal_id: BIG, stage: "closedwon", amount: "10" });
		expect(hubspot.writes.at(-1)).toEqual(["PATCH", `${PREFIX}deals/${BIG}`, { properties: { dealstage: "closedwon", amount: "10" } }]);

		// A workflow moves the deal to Partners as it is changed: it is not returned.
		hubspot.hook = (request) => {
			if (request.method === "PATCH") (hubspot.table("deals").get(BIG) as Properties).pipeline = "200";
		};
		expect(items(await run.ok("hubspot_update_deal", { deal_id: BIG, name: "Renamed" }))).toEqual([]);
		hubspot.hook = null;
		// The deal moves to Partners after it was authorized in Sales.
		hubspot.moves.set(SMALL, "200");
		expect(await run.code("hubspot_update_deal", { deal_id: SMALL, name: "x" })).toBe("DEAL_MOVED");
		expect(hubspot.writes).toHaveLength(2);
	});

	test("notes are logged as text on one allowed record", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { contacts: ["read", "note"], "pipeline:default": ["read", "note"] });
		expect(await run.code("hubspot_add_note", { body: "hi" })).toBe("INVALID_ARGUMENTS");
		expect(await run.code("hubspot_add_note", { contact_id: ADA, deal_id: BIG, body: "hi" })).toBe("INVALID_ARGUMENTS");
		expect(await run.code("hubspot_add_note", { company_id: ACME, body: "hi" })).toBe("POLICY_DENIED");
		const logged = await run.ok("hubspot_add_note", { contact_id: ADA, body: "<b>Call</b>\nback" });
		expect(items(logged)[0]?.logged_on).toBe(`contact:${ADA}`);
		const [method, path, body] = hubspot.writes.at(-1) as [string, string, JsonObject];
		expect([method, path]).toEqual(["POST", `${PREFIX}notes`]);
		const properties = body.properties as JsonObject;
		expect(properties.hs_note_body).toBe("&lt;b&gt;Call&lt;/b&gt;<br>back");
		expect(properties.hs_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(((body.associations as JsonObject[])[0]?.types as JsonObject[])[0]?.associationTypeId).toBe(202);
		await run.ok("hubspot_add_note", { deal_id: BIG, body: "Signed" });
		expect((hubspot.writes.at(-1)?.[2].associations as JsonObject[])[0]).toEqual({
			to: { id: BIG },
			types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
		});
		hubspot.moves.set(SMALL, "200");
		expect(await run.code("hubspot_add_note", { deal_id: SMALL, body: "x" })).toBe("DEAL_MOVED");
		expect(hubspot.writes).toHaveLength(2);
	});
});

describe("the port's own", () => {
	test("the registry accepts HubSpot's declarations; their fingerprints", async () => {
		const registry = await Registry.create([hubspotConnector()]);
		const connector = registry.get("hubspot");
		const fingerprints = Object.fromEntries(connector.operations.map((op) => [op.name, registry.contract("hubspot", op.name)]));
		console.log("hubspot fingerprints", fingerprints);
		expect(Object.keys(fingerprints)).toHaveLength(12);
		for (const fingerprint of Object.values(fingerprints)) expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
		for (const op of connector.operations) expect(`hubspot${MAX_ALIAS_SUFFIX}_${op.name}`.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
		// The same declaration means the same tools in every deploy of a version.
		const again = await Registry.create([hubspotConnector()]);
		for (const [name, fingerprint] of Object.entries(fingerprints)) expect(again.contract("hubspot", name)).toBe(fingerprint);
		// Registered in the registry the Workspace and the executor share.
		expect(CONNECTORS.map((item) => item.slug)).toContain("hubspot");
		const shared = await connectorRegistry();
		for (const [name, fingerprint] of Object.entries(fingerprints)) expect(shared.contract("hubspot", name)).toBe(fingerprint);
	});

	test("tools are offered by what could be allowed", async () => {
		const hubspot = new FakeHubSpot();
		const read = await start(hubspot, { contacts: READ });
		expect(read.tools).toEqual([
			"hubspot_search_contacts",
			"hubspot_get_contact",
			"hubspot_search_companies",
			"hubspot_get_company",
			"hubspot_list_pipelines",
			"hubspot_search_deals",
			"hubspot_get_deal",
		]);
		const note = await start(hubspot, { companies: ["read", "note"] });
		expect(note.tools).toContain("hubspot_add_note");
		expect(note.tools).not.toContain("hubspot_create_contact");
		expect(note.tools).not.toContain("hubspot_update_deal");
	});

	test("a token without the scope an operation needs is named, and the connection stays", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { contacts: READ });
		hubspot.hook = () => FakeHubSpot.error(403, "MISSING_SCOPES");
		const refused = await run.error("hubspot_search_contacts", {});
		expect(refused.code).toBe("PROVIDER_FORBIDDEN");
		expect(refused.message).not.toContain(SECRET);
		expect(run.credentials.status(HUBSPOT)).toBe("active");
		hubspot.hook = () => FakeHubSpot.error(401, "INVALID_AUTHENTICATION");
		expect(await run.error("hubspot_get_contact", { contact_id: ADA })).toEqual({ code: "CONNECTION_UNAUTHORIZED", message: "The HubSpot connection is no longer authorized." });
		expect(run.credentials.status(HUBSPOT)).toBe("error");
	});

	test("responses that do not fit are unexpected; large ones are refused", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { contacts: READ, "pipeline:default": READ });
		// A record id HubSpot would not write that way.
		hubspot.hook = (request) => (request.method === "GET" ? json(200, { id: "0101", properties: {} }) : null);
		expect(await run.error("hubspot_get_contact", { contact_id: ADA })).toEqual({ code: "PROVIDER_FAILED", message: "HubSpot returned an unexpected response." });
		hubspot.hook = (request) => (request.method === "GET" ? json(200, { id: ADA, properties: { email: 5 } }) : null);
		expect(await run.code("hubspot_get_contact", { contact_id: ADA })).toBe("PROVIDER_FAILED");
		hubspot.hook = (request) => (request.method === "GET" ? new Response(`{"id":"${ADA}","properties":{"email":"${"x".repeat(4 * 1024 * 1024)}"}}`, { status: 200 }) : null);
		expect(await run.error("hubspot_get_contact", { contact_id: ADA })).toEqual({ code: "RESPONSE_TOO_LARGE", message: "HubSpot's response was too large to read." });
		// A deal without a pipeline cannot be placed.
		hubspot.hook = (request) => (request.method === "GET" ? json(200, { id: BIG, properties: { pipeline: null } }) : null);
		expect(await run.code("hubspot_get_deal", { deal_id: BIG })).toBe("PROVIDER_FAILED");
		hubspot.hook = null;
		// A search page whose offset HubSpot would not write.
		hubspot.hook = (request) => (request.url.pathname.endsWith("/search") ? json(200, { results: [], paging: { next: { after: "010" } } }) : null);
		expect(await run.code("hubspot_search_contacts", {})).toBe("PROVIDER_FAILED");
		// A lone surrogate escape fails a read anywhere, as Pydantic's JSON parser refuses it, even in a field
		// the model ignores; a write's answer is read with json.loads, which keeps it.
		hubspot.hook = (request) => (request.method === "GET" ? new Response(`{"id":"${ADA}","unused":"\\ud800"}`, { status: 200 }) : null);
		expect(await run.code("hubspot_get_contact", { contact_id: ADA })).toBe("PROVIDER_FAILED");
		const writer = await start(hubspot, { contacts: ["read", "create"] });
		hubspot.hook = (request) => (request.method === "POST" && request.url.pathname === `${PREFIX}contacts` ? new Response('{"id":"960","properties":{"email":"\\udc00"}}', { status: 200 }) : null);
		expect(items(await writer.ok("hubspot_create_contact", { email: "lone@example.com" }))[0]?.email).toBe("\udc00");
	});

	test("deals are read again where they are used: moved, archived, or gone after a write", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { contacts: READ, companies: READ, "pipeline:default": ["read", "edit"] });
		// Authorized with Big in Sales; it moves before the search is sent, which is then refused.
		hubspot.moves.set(BIG, "200");
		expect(await run.code("hubspot_search_contacts", { deal_id: BIG })).toBe("DEAL_MOVED");
		expect(searches(hubspot, "contacts")).toEqual([]);
		hubspot.table("deals").set(BIG, { dealname: "Big", pipeline: "default", dealstage: "qualified", amount: "9000" });
		hubspot.moves.set(BIG, "200");
		expect(await run.code("hubspot_search_companies", { deal_id: BIG })).toBe("DEAL_MOVED");
		hubspot.table("deals").set(BIG, { dealname: "Big", pipeline: "default", dealstage: "qualified", amount: "9000" });
		// A deal the batch read finds archived is left out.
		hubspot.hook = (request) => {
			if (!request.url.pathname.endsWith("/batch/read")) return null;
			const results = (request.body.inputs as { id: string }[]).map((input) => ({ ...FakeHubSpot.record(input.id, hubspot.table("deals").get(input.id) as Properties, DEAL_PROPERTIES), archived: input.id === SMALL }));
			return json(200, { results });
		};
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default" }))).toEqual([BIG]);
		hubspot.hook = null;
		expect(ids(await run.ok("hubspot_search_deals", { pipeline: "default", stage: "closedwon" }))).toEqual([SMALL]);
		expect(searches(hubspot, "deals").at(-1)?.filterGroups).toEqual([
			{
				filters: [
					{ propertyName: "pipeline", operator: "EQ", value: "default" },
					{ propertyName: "dealstage", operator: "EQ", value: "closedwon" },
				],
			},
		]);
		// The deal cannot be read back after its change: the write succeeded, and nothing is shown.
		let patched = false;
		hubspot.hook = (request) => {
			if (request.method === "PATCH") patched = true;
			else if (patched && request.method === "GET") return FakeHubSpot.error(404, "OBJECT_NOT_FOUND");
			return null;
		};
		const renamed = await run.ok("hubspot_update_deal", { deal_id: BIG, name: "Renamed" });
		expect(renamed.result).toEqual({ items: [], count: 0 });
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
	});

	test("a write is one request, in execute; a pipeline that is archived or gone is refused before it", async () => {
		const hubspot = new FakeHubSpot();
		const run = await start(hubspot, { deals: ["read", "create", "edit"] });
		const args = { pipeline: "300", stage: "s", name: "Old" };
		expect(await run.error("hubspot_create_deal", args)).toEqual({ code: "PIPELINE_ARCHIVED", message: "This pipeline is archived. See list_pipelines." });
		expect(await run.code("hubspot_create_deal", { ...args, pipeline: "gone" })).toBe("POLICY_DENIED");
		expect(hubspot.writes).toEqual([]);
		expect(run.writes()).toEqual([]);
		// A new deal is where HubSpot says it put it, and shown only if allowed there.
		const sales = await start(hubspot, { "pipeline:default": ["read", "create"] });
		hubspot.hook = (request) => (request.method === "POST" && request.url.pathname === `${PREFIX}deals` ? json(200, { id: "950", properties: { pipeline: "200", dealname: "Placed" } }) : null);
		expect((await sales.ok("hubspot_create_deal", { pipeline: "default", stage: "qualified", name: "Placed" })).result).toEqual({ items: [], count: 0 });
		hubspot.hook = (request) => (request.method === "POST" && request.url.pathname === `${PREFIX}deals` ? json(200, { id: "951", properties: { dealname: "Unplaced" } }) : null);
		expect(ids(await sales.ok("hubspot_create_deal", { pipeline: "default", stage: "qualified", name: "Unplaced" }))).toEqual(["951"]);
		// A write HubSpot answered with a server error has an unknown outcome and pauses later writes.
		hubspot.hook = (request) => (request.method === "PATCH" ? new Response("{}", { status: 502 }) : null);
		expect(await run.code("hubspot_update_deal", { deal_id: BIG, name: "x" })).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
	});
});
