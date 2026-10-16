// The Confluence connector against an in-memory Atlassian API behind an injected `fetch`, and runs through
// the executor.

import { afterEach, describe, expect, test } from "vitest";
import { BodyModel, ConfluenceClient, ListingModel, document, nextCursor, pageParams } from "../../src/connectors/confluence/client.ts";
import { confluenceConnector, discoveryCursor } from "../../src/connectors/confluence/connector.ts";
import { MAX_SPACE_PAGES, searchWords } from "../../src/connectors/confluence/reads.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { askedScopes, catalogEntry, uncovered } from "./catalog-support.ts";
import { ceilingRow, startRun } from "./connector-runs.ts";
import { type Scenario, jsonResponse } from "./executor-fakes.ts";

const SECRET = "SECRET merger";
const ACCOUNT_ID = "5b10ac8d82e05b22cc7d4ef5";
const ACME = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";
const JIRA = "33333333-3333-3333-3333-333333333333";
const ENG = `${ACME}/100`;
const FIN = `${ACME}/101`;
const OPS = `${BETA}/100`;
const READ_SCOPES = ["read:space:confluence", "read:page:confluence", "read:comment:confluence", "read:content-details:confluence"];
const SCOPES = ["offline_access", "read:me", ...READ_SCOPES, "write:comment:confluence", "write:page:confluence"];
/** Confluence's cursors are opaque; some are not URL-safe. */
const TOKEN = "eyJ+a/b=";

function doc(...content: Json[]): JsonObject {
	return { type: "doc", version: 1, content };
}

function paragraph(...content: Json[]): Json {
	return { type: "paragraph", content };
}

function text(value: string, href?: string): JsonObject {
	return href === undefined ? { type: "text", text: value } : { type: "text", text: value, marks: [{ type: "link", attrs: { href } }] };
}

/** A body as Confluence sends it: the ADF document as a JSON string. */
function body(document: Json): JsonObject {
	return { atlas_doc_format: { representation: "atlas_doc_format", value: JSON.stringify(document) } };
}

function space(id: string, key: string, name: string, fields: JsonObject = {}): JsonObject {
	return { id, key, name, type: "global", status: "current", ...fields };
}

function page(id: string, spaceId: string, title: string, fields: JsonObject = {}): JsonObject {
	return {
		id,
		status: "current",
		title,
		spaceId,
		parentId: null,
		parentType: null,
		createdAt: "2026-10-01T09:00:00.000Z",
		version: { number: 3, createdAt: "2026-10-02T09:00:00.000Z" },
		body: body(doc(paragraph(text(`About ${title}`)))),
		...fields,
	};
}

function without(object: JsonObject, key: string): JsonObject {
	return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

interface Recorded {
	method: string;
	path: string;
	params: { [name: string]: string };
}

type Hook = (method: string, path: string, params: { [name: string]: string }) => Response | null;

interface FakeSite {
	spaces: JsonObject[];
	pages: { [id: string]: JsonObject };
	comments: { [id: string]: JsonObject[] };
}

const fakes: FakeConfluence[] = [];

/**
 * Atlassian's API for Confluence. Acme (acme.atlassian.net) has spaces
 * ENG (100) and FIN (101); Beta (beta.atlassian.net) has OPS, whose id repeats ENG's. Page 500 in ENG links
 * to page 501 in FIN and has a child 502; page 504 in ENG names 501 as its parent, and 505 is a draft.
 */
class FakeConfluence {
	me: JsonObject = { account_id: ACCOUNT_ID, name: "Ada", email: "ada@example.com" };
	resources: JsonObject[] = [
		{ id: BETA.toUpperCase(), name: "Beta", url: "https://beta.atlassian.net", scopes: SCOPES },
		{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: SCOPES },
		// The same site again (Atlassian lists a site once per product), and a site without Confluence.
		{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:jira-work"] },
		{ id: JIRA, name: "Tracker", url: "https://tracker.atlassian.net", scopes: ["read:jira-work"] },
	];
	sites: { [id: string]: FakeSite };
	pageSize: number | null = null;
	/** Ids search returns before the pages it names (an index that lags behind moves). */
	stale: string[] = [];
	requests: Recorded[] = [];
	writes: [string, JsonObject][] = [];
	hook: Hook | null = null;
	problems: string[] = [];

	constructor() {
		fakes.push(this);
		const runbook = doc(
			paragraph(text("See "), text(SECRET, "https://acme.atlassian.net/wiki/spaces/FIN/pages/501"), text(" and "), text("docs", "https://example.com/docs")),
			{ type: "inlineCard", attrs: { url: "https://acme.atlassian.net/wiki/x/501" } },
			{ type: "extension", attrs: { extensionKey: "children", text: SECRET } },
		);
		this.sites = {
			[ACME]: {
				spaces: [space("100", "ENG", "Engineering"), space("101", "FIN", SECRET), space("102", "~ada", "Ada", { type: "personal" })],
				pages: {
					"500": page("500", "100", "Runbook", { body: body(runbook) }),
					"501": page("501", "101", SECRET),
					"502": page("502", "100", "Child", { parentId: "500", parentType: "page" }),
					"504": page("504", "100", "Adopted", { parentId: "501", parentType: "page" }),
					"505": page("505", "100", "Draft", { status: "draft" }),
				},
				comments: {
					"500": [0, 1, 2].map((n) => ({
						id: String(700 + n),
						status: "current",
						version: { number: 1, createdAt: `2026-10-01T${String(n).padStart(2, "0")}:00:00.000Z` },
						body: body(doc(paragraph(text(`comment ${n}`)))),
					})),
				},
			},
			[BETA]: { spaces: [space("100", "OPS", "Operations")], pages: { "500": page("500", "100", "Keys") }, comments: {} },
		};
	}

	static missing(): Response {
		return jsonResponse(404, { errors: [{ title: SECRET }] });
	}

	/** One page of `items`, with Confluence's link to the next page. */
	#listing(path: string, items: Json[], params: { [name: string]: string }): JsonObject {
		const size = this.pageSize ?? Number(params.limit ?? 25);
		let start = 0;
		if ("cursor" in params) {
			const cursor = params.cursor as string;
			if (!cursor.startsWith(TOKEN)) this.problems.push(`unexpected cursor ${cursor}`);
			start = Number(cursor.slice(TOKEN.length));
		}
		const end = start + size;
		const links: JsonObject = {};
		if (end < items.length) links.next = `${path}?${new URLSearchParams({ ...without(params, "cursor"), cursor: `${TOKEN}${end}` } as { [name: string]: string })}`;
		return { results: items.slice(start, end), _links: links };
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname);
		const params = Object.fromEntries(url.searchParams);
		this.requests.push({ method: request.method, path, params });
		if (url.host !== "api.atlassian.com" || request.redirect !== "manual") this.problems.push(`unexpected request ${request.url}`);
		const hooked = this.hook?.(request.method, path, params) ?? null;
		if (hooked !== null) return hooked;
		if (path === "/me") return jsonResponse(200, this.me);
		if (path === "/oauth/token/accessible-resources") return jsonResponse(200, this.resources);
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (parts[0] !== "ex" || parts[1] !== "confluence" || parts[3] !== "wiki") {
			this.problems.push(`unexpected path ${path}`);
			return jsonResponse(500, {});
		}
		const site = this.sites[parts[2] as string];
		if (site === undefined) return FakeConfluence.missing();
		if (parts.slice(4, 7).join("/") === "rest/api/search") return this.#search(site, params);
		if (parts.slice(4, 6).join("/") !== "api/v2") {
			this.problems.push(`unexpected path ${path}`);
			return jsonResponse(500, {});
		}
		const rest = parts.slice(6);
		const route = rest.join("/");
		if (request.method === "POST") {
			const sent = parseJson(await request.text()) as JsonObject;
			this.writes.push([route, sent]);
			if (route === "footer-comments") return jsonResponse(200, { id: "709", version: { number: 1, createdAt: "2026-10-03T09:00:00.000Z" } });
			if (route === "pages") {
				if (Object.values(site.pages).some((item) => item.title === sent.title)) return jsonResponse(400, { errors: [{ title: SECRET }] });
				const created = page("509", sent.spaceId as string, sent.title as string, { parentId: sent.parentId ?? null });
				site.pages["509"] = created;
				return jsonResponse(200, created);
			}
			this.problems.push(`unexpected write ${path}`);
			return jsonResponse(500, {});
		}
		if (route === "spaces") {
			let spaces = site.spaces;
			if ("ids" in params) spaces = spaces.filter((item) => (params.ids as string).split(",").includes(item.id as string));
			if ("keys" in params) spaces = spaces.filter((item) => (params.keys as string).split(",").includes(item.key as string));
			return jsonResponse(200, this.#listing("/wiki/api/v2/spaces", spaces, params));
		}
		if (rest[0] === "spaces" && rest.length === 2) {
			const found = site.spaces.find((item) => item.id === rest[1]);
			return found ? jsonResponse(200, found) : FakeConfluence.missing();
		}
		if (route === "pages") {
			if (params.status !== "current") this.problems.push("pages listed without status=current");
			const ids = (params.id as string).split(",");
			const pages = [...ids]
				.sort((a, b) => Number(a) - Number(b))
				.filter((id) => Object.hasOwn(site.pages, id) && site.pages[id]?.status === "current")
				.map((id) => without(site.pages[id] as JsonObject, "body"));
			return jsonResponse(200, this.#listing("/wiki/api/v2/pages", pages, params));
		}
		if (rest[0] === "pages" && rest.length === 2) {
			let found = site.pages[rest[1] as string];
			if (found === undefined) return FakeConfluence.missing();
			if (params["body-format"] !== "atlas_doc_format") found = without(found, "body");
			return jsonResponse(200, found);
		}
		if (rest[0] === "pages" && rest[2] === "footer-comments" && rest.length === 3) {
			if (params.sort !== "-created-date") this.problems.push("comments not newest first");
			const comments = [...(site.comments[rest[1] as string] ?? [])].reverse();
			return jsonResponse(200, this.#listing(`/wiki/api/v2/pages/${rest[1]}/footer-comments`, comments, params));
		}
		this.problems.push(`unexpected read ${path}`);
		return jsonResponse(500, {});
	};

	#search(site: FakeSite, params: { [name: string]: string }): Response {
		const key = /type = page AND space = "([^"]+)"/.exec(params.cql as string)?.[1];
		const target = site.spaces.find((item) => item.key === key) as JsonObject;
		// Most recently changed first: here, the highest id.
		const matching = Object.entries(site.pages)
			.filter(([, found]) => found.spaceId === target.id && found.status === "current")
			.map(([id]) => id)
			.sort((a, b) => Number(b) - Number(a));
		const results: Json[] = [
			...this.stale.map((id) => ({ content: { id, type: "page" } })),
			...matching.map((id) => ({ content: { id, type: "page", title: SECRET }, excerpt: SECRET })),
		];
		return jsonResponse(200, this.#listing("/rest/api/search", results, params));
	}

	reads(suffix: string): Recorded[] {
		return this.requests.filter((request) => request.method === "GET" && request.path.endsWith(suffix));
	}

	client(): ConfluenceClient {
		return new ConfluenceClient("token", settingsIo(this.fetch));
	}

	oneSite(): void {
		this.resources = this.resources.filter((resource) => resource.id !== BETA.toUpperCase());
	}

	acme(): FakeSite {
		return this.sites[ACME] as FakeSite;
	}
}

afterEach(() => {
	for (const fake of fakes.splice(0)) expect(fake.problems).toEqual([]);
});

/** Starts and claims a run with the user's Confluence connection, holding `grants` ({site or space: actions}). */
function start(confluence: FakeConfluence, grants: { [id: string]: string[] }, options: { scopes?: string[]; ceiling?: GrantRow[] } = {}): Promise<Scenario> {
	const rows = Object.fromEntries(Object.entries(grants).map(([id, actions]) => [`space:${id}`, actions]));
	return startRun(confluenceConnector(), confluence.fetch, { scopes: options.scopes ?? SCOPES, grants: rows, ceiling: options.ceiling ?? [] });
}

/** A deny in the workspace ceiling. */
function ceilingDeny(resourceId: string, actions: string[] = ["read"]): GrantRow {
	return ceilingRow("space", resourceId, "deny", actions);
}

async function items(run: Scenario, tool: string, args: Json): Promise<JsonObject[]> {
	return (await run.ok(tool, args)).result.items as JsonObject[];
}

describe("connecting and discovery", () => {
	test("the account and its Confluence sites", async () => {
		const confluence = new FakeConfluence();
		const connector = confluenceConnector();
		const client = confluence.client();
		expect(await connector.account(client)).toEqual({ id: ACCOUNT_ID, label: "Ada (ada@example.com)" });
		expect((await client.sites()).map((site) => site.id)).toEqual([ACME, BETA]);
		confluence.resources = confluence.resources.slice(2);
		await expect(connector.account(confluence.client())).rejects.toMatchObject({
			code: "UNSUPPORTED_ACCOUNT",
			message: "This Atlassian account gave Minerva no Confluence site.",
		});
		// Labels without both a name and an email.
		confluence.resources = [{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: SCOPES }];
		for (const [me, label] of [
			[{ account_id: ACCOUNT_ID, name: "Ada" }, "Ada"],
			[{ account_id: ACCOUNT_ID, email: "ada@example.com" }, "ada@example.com"],
			[{ account_id: ACCOUNT_ID, name: null, email: null }, "Confluence"],
		] as const) {
			confluence.me = me;
			expect((await connector.account(confluence.client())).label).toBe(label);
		}
	});

	test("discovery lists sites, then each site's spaces", async () => {
		const confluence = new FakeConfluence();
		const connector = confluenceConnector();
		const client = confluence.client();
		const page = await connector.discover(client, "space", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[ACME, "Acme (acme.atlassian.net)"],
			[BETA, "Beta (beta.atlassian.net)"],
			[ENG, "Engineering (ENG) · Acme"],
			[FIN, `${SECRET} (FIN) · Acme`],
			[`${ACME}/102`, "Ada (~ada) · Acme"],
		]);
		const second = await connector.discover(client, "space", { query: null, cursor: page.nextCursor ?? null });
		expect([second.items.map((item) => [item.id, item.name]), second.nextCursor]).toEqual([[[OPS, "Operations (OPS) · Beta"]], null]);
		confluence.pageSize = 1;
		const first = await connector.discover(client, "space", { query: "eng", cursor: null });
		expect([first.items.map((item) => item.id), first.nextCursor]).toEqual([[ENG], `0:${TOKEN}1`]);
		const following = await connector.discover(client, "space", { query: "eng", cursor: first.nextCursor ?? null });
		expect([following.items, following.nextCursor]).toEqual([[], `0:${TOKEN}2`]);
		for (const cursor of ["x", "2:", "0:a b", `0:${"a".repeat(991)}`]) {
			await expect(connector.discover(client, "space", { query: null, cursor }), cursor).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		}
		const described = await connector.describe(client, "space", [ACME, ACME.toUpperCase(), JIRA, ENG, OPS, `${ACME}/999`, `${JIRA}/100`, `${ACME}/ENG`]);
		expect(described).toEqual({ [ACME]: "Acme (acme.atlassian.net)", [ENG]: "Engineering (ENG) · Acme", [OPS]: "Operations (OPS) · Beta" });
	});

	test("an archived space is named so", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		confluence.acme().spaces.push(space("103", "OLD", "Old", { status: "archived" }));
		const page = await confluenceConnector().discover(confluence.client(), "space", { query: "old", cursor: null });
		expect(page.items).toEqual([{ id: `${ACME}/103`, name: "Old (OLD) · archived" }]);
	});

	test("cursors are checked", () => {
		expect(pageParams(`c:${TOKEN}`)).toEqual({ cursor: TOKEN });
		for (const cursor of ["x:abc", "c:", "c:a b", `c:${"a".repeat(991)}`, "c:é"]) {
			expect(() => pageParams(cursor), cursor).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		}
		const listing = (next: string | null) => ListingModel.parse({ results: [], _links: next ? { next } : {} });
		expect(nextCursor(listing(null))).toBeNull();
		expect(nextCursor(listing("/wiki/api/v2/pages?cursor=abc%2B&limit=5"))).toBe("c:abc+");
		// Only the cursor is kept: where the link points is never used.
		expect(nextCursor(listing("https://evil.example/x?cursor=abc"))).toBe("c:abc");
		for (const link of ["/x?limit=5", "/x?cursor=a%20b", "/x?cursor=a&cursor=b", "/x?cursor=&cursor=b", "/x?cursor=", "/x?cursor=a+b", "/x?cursor=%C3%A9", "/x#cursor=a", "https://[v1.x]/?cursor=a", `/x?cursor=${"a".repeat(991)}`]) {
			expect(() => nextCursor(listing(link)), link).toThrow(expect.objectContaining({ code: "PROVIDER_LIMIT" }));
		}
	});

	test("discovery cursors are a site index and Confluence's cursor", () => {
		const sites = [null, null];
		expect([null, "0:", "1:abc", "01:x", "0:~"].map((cursor) => discoveryCursor(cursor, sites))).toEqual([[0, null], [0, null], [1, "abc"], [1, "x"], [0, "~"]]);
		for (const cursor of ["2:", "x", "0:a b", `0:${"a".repeat(991)}`, ":x", "١:x"]) {
			expect(() => discoveryCursor(cursor, sites), cursor).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		}
	});

	test("search words keep CQL out of the query", () => {
		expect(searchWords('run "OR space = FIN')).toBe("run OR space FIN");
		expect(() => searchWords("?!")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENTS", message: "text must contain letters or digits." }));
	});

	test("a body is ADF sent as a JSON string; one that does not parse is none", () => {
		const read = (value: Json) => document(BodyModel.parse({ atlas_doc_format: { value } }));
		expect(read('{"type": "doc"}')).toEqual({ type: "doc" });
		expect(read('"text"')).toBe("text");
		for (const value of ["{broken", "", "null", "nan", '{"a": 1', null]) expect(read(value), JSON.stringify(value)).toBeNull();
		expect(BodyModel.safeParse({ atlas_doc_format: { value: 5 } }).success).toBe(false);
	});

	test("the catalog asks for read scopes, and for a write scope per kind of write", async () => {
		const entry = await catalogEntry(confluenceConnector());
		const base = ["offline_access", "read:me", ...READ_SCOPES];
		expect(entry.auth).toMatchObject({ scopes: base });
		expect(askedScopes(entry)).toEqual({ add_comment: ["write:comment:confluence"], create_page: ["write:page:confluence"] });
		expect(uncovered(entry, base)).toEqual(["add_comment", "create_page"]);
		expect(uncovered(entry, [...base, "write:page:confluence"])).toEqual(["add_comment"]);
	});
});

describe("reading", () => {
	test("a site grant covers its spaces, and denies hold inside it", async () => {
		const confluence = new FakeConfluence();
		const run = await start(confluence, { [ACME]: ["read"] }, { ceiling: [ceilingDeny(FIN)] });
		const outcome = await run.ok("confluence_list_spaces", {});
		const listed = outcome.result.items as JsonObject[];
		expect(listed.map((item) => item.key)).toEqual(["ENG", "~ada"]);
		expect(listed[0]).toEqual({ id: "100", site_id: ACME, site: "Acme (acme.atlassian.net)", key: "ENG", name: "Engineering", type: "global", status: "current" });
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		// Several sites: calls name one.
		expect(await run.error("confluence_get_page", { page: "500" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "This connection reaches 2 Confluence sites; name one with site_id.",
		});
		expect((await items(run, "confluence_get_page", { site_id: ACME.toUpperCase(), page: "500" }))[0]?.title).toBe("Runbook");
		for (const [siteId, name] of [
			[ACME, "501"],
			[BETA, "500"],
			[JIRA, "500"],
			[ACME, "404"],
			[ACME, "505"],
		] as const) {
			expect(await run.code("confluence_get_page", { site_id: siteId, page: name }), `${siteId} ${name}`).toBe("POLICY_DENIED");
		}
		for (const args of [
			{ site_id: "acme", page: "500" },
			{ site_id: ACME, page: "x500" },
			{ site_id: ACME, page: "0500" },
		]) {
			expect(await run.code("confluence_get_page", args), JSON.stringify(args)).toBe("INVALID_ARGUMENTS");
		}
		// Nothing of a refused page was read beyond where it is.
		const refused = confluence.reads("/pages/501");
		expect(refused.length).toBeGreaterThan(0);
		expect(refused.every((request) => !("body-format" in request.params))).toBe(true);
		expect(confluence.reads("/pages/501/footer-comments")).toEqual([]);
	});

	test("the arguments' messages", async () => {
		const confluence = new FakeConfluence();
		const run = await start(confluence, { [ACME]: ["read"] });
		expect(await run.error("confluence_get_page", { site_id: "x".repeat(36), page: "500" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. site_id: must be a site id from list_spaces",
		});
		expect(await run.error("confluence_get_page", { site_id: ACME, page: "0500" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. page: must be a page id",
		});
		expect(await run.error("confluence_search_pages", { site_id: ACME, space: "0101" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: 'Invalid arguments. space: must be a space key such as "ENG", or a space id',
		});
		expect(await run.error("confluence_search_pages", { site_id: ACME, space: "ENG", text: "a\tb" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. text: must be a single line without control characters",
		});
	});

	test("spaces are named by exact key or id, and ids repeat across sites", async () => {
		const confluence = new FakeConfluence();
		let run = await start(confluence, { [OPS]: ["read"] });
		expect(await run.code("confluence_search_pages", { site_id: ACME, space: "100" })).toBe("POLICY_DENIED");
		expect((await items(run, "confluence_search_pages", { site_id: BETA, space: "100" })).map((item) => item.title)).toEqual(["Keys"]);
		confluence.oneSite();
		run = await start(confluence, { [ENG]: ["read"] });
		expect((await items(run, "confluence_search_pages", { space: "ENG" })).map((item) => item.id)).toEqual(["504", "502", "500"]);
		// Keys are case-sensitive: "eng" is not ENG.
		for (const name of ["eng", "FIN", "~ada", "NOPE"]) expect(await run.code("confluence_search_pages", { space: name }), name).toBe("POLICY_DENIED");
		// Another spelling of an id is refused before Confluence is asked: it cannot tell spaces apart.
		for (const name of ['ENG" OR space = "FIN', "a b", "0101", "0999"]) {
			expect(await run.code("confluence_search_pages", { space: name }), name).toBe("INVALID_ARGUMENTS");
		}
	});

	test("pages show their space only and hide Atlassian links", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read"] });
		const outcome = await run.ok("confluence_get_page", { page: "500" });
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		const found = outcome.result.items[0] as JsonObject;
		expect(found.body).toBe("See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link][unsupported content]");
		expect((found.comments as JsonObject[]).map((comment) => comment.text)).toEqual(["comment 0", "comment 1", "comment 2"]);
		expect([found.more_comments, found.parent, found.version]).toEqual([false, null, 3]);
		expect(found.link).toBe("https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500");
		expect(confluence.reads("/footer-comments")[0]?.params.limit).toBe("30");
		// The whole record.
		expect(found).toEqual({
			id: "500",
			site_id: ACME,
			space_id: "100",
			title: "Runbook",
			parent: null,
			created: "2026-10-01T09:00:00.000Z",
			updated: "2026-10-02T09:00:00.000Z",
			version: 3,
			body: "See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link][unsupported content]",
			body_truncated: false,
			comments: [0, 1, 2].map((n) => ({ id: String(700 + n), updated: `2026-10-01T0${n}:00:00.000Z`, text: `comment ${n}`, text_truncated: false })),
			more_comments: false,
			link: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500",
		});
		const child = (await items(run, "confluence_get_page", { page: "502" }))[0] as JsonObject;
		expect(child.parent).toEqual({ id: "500", title: "Runbook" });
		// A parent in another space is left out.
		const adopted = (await items(run, "confluence_get_page", { page: "504" }))[0] as JsonObject;
		expect(adopted.parent).toBeNull();
		confluence.pageSize = 2;
		expect((await items(run, "confluence_get_page", { page: "500" }))[0]?.more_comments).toBe(true);
	});

	test("a body that cannot be read is not shown as empty", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read"] });
		const acme = confluence.acme();
		(acme.comments["500"]?.[0] as JsonObject).body = { atlas_doc_format: { value: "{broken" } };
		const found = (await items(run, "confluence_get_page", { page: "500" }))[0] as JsonObject;
		const comments = found.comments as JsonObject[];
		expect(comments.map((comment) => comment.text)).toEqual([null, "comment 1", "comment 2"]);
		expect(comments[0]?.text_truncated).toBe(false);
		expect(comments[2]?.updated).toBe("2026-10-01T02:00:00.000Z");
		(acme.pages["500"] as JsonObject).body = { atlas_doc_format: { value: "{broken" } };
		expect(await run.error("confluence_get_page", { page: "500" })).toEqual({ code: "PROVIDER_FAILED", message: "Confluence returned an unexpected response." });
		delete (acme.pages["500"] as JsonObject).body;
		expect(await run.code("confluence_get_page", { page: "500" })).toBe("PROVIDER_FAILED");
	});

	test("a page that moves after authorizing is refused", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read", "comment", "create"] });
		const target = () => confluence.acme().pages["500"] as JsonObject;
		// Confluence answers the lookup that authorizes, then the page moves to FIN.
		confluence.hook = (method, path) => {
			if (method === "GET" && path.endsWith("/pages/500") && target().spaceId === "100") {
				const response = jsonResponse(200, structuredClone(target()));
				target().spaceId = "101";
				return response;
			}
			return null;
		};
		expect(await run.error("confluence_get_page", { page: "500" })).toEqual({
			code: "PAGE_MOVED",
			message: "This page moved in Confluence while Minerva was using it, or access was lost. Try again.",
		});
		target().spaceId = "100";
		expect(await run.code("confluence_add_comment", { page: "500", text: "hi" })).toBe("PAGE_MOVED");
		target().spaceId = "100";
		expect(await run.code("confluence_create_page", { space: "ENG", title: "New", parent_page: "500" })).toBe("PAGE_MOVED");
		expect(confluence.writes).toEqual([]);
	});

	test("search reads results again and shows them where they are", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		confluence.stale = ["501"];
		const run = await start(confluence, { [ENG]: ["read"] });
		const outcome = await run.ok("confluence_search_pages", { space: "ENG", text: 'run "OR space = FIN' });
		const found = outcome.result.items as JsonObject[];
		expect(found.map((item) => item.id)).toEqual(["504", "502", "500"]);
		expect(found[2]).toEqual({
			id: "500",
			site_id: ACME,
			space_id: "100",
			title: "Runbook",
			updated: "2026-10-02T09:00:00.000Z",
			link: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500",
		});
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(confluence.reads("/rest/api/search").at(-1)?.params.cql).toBe('type = page AND space = "ENG" AND title ~ "run OR space FIN" ORDER BY lastmodified DESC');
		expect(await run.error("confluence_search_pages", { space: "ENG", text: "?!" })).toEqual({ code: "INVALID_ARGUMENTS", message: "text must contain letters or digits." });
		// A search Confluence refuses is the agent's to change; Confluence's reason is not passed on.
		confluence.hook = (_method, path) => (path.endsWith("/search") ? jsonResponse(400, { message: SECRET }) : null);
		expect(await run.error("confluence_search_pages", { space: "ENG" })).toEqual({ code: "INVALID_ARGUMENTS", message: "Confluence could not run this search." });
	});

	test("search pages are run-bound, and batch reads follow their pages", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { "*": ["read"] });
		const first = await run.ok("confluence_search_pages", { space: "ENG", limit: 2 });
		expect(first.result.items.map((item) => item.id)).toEqual(["504", "502"]);
		const token = first.result.next_cursor as string;
		expect(token.startsWith("c:")).toBe(false);
		const second = await run.ok("confluence_search_pages", { space: "ENG", limit: 2, cursor: token });
		expect(second.result.items.map((item) => item.id)).toEqual(["500"]);
		expect(second.result.next_cursor).toBeUndefined();
		expect(confluence.reads("/rest/api/search").at(-1)?.params.cursor).toBe(`${TOKEN}2`);
		expect(await run.code("confluence_search_pages", { space: "FIN", limit: 2, cursor: token })).toBe("INVALID_CURSOR");
		// Confluence pages a filtered listing too; every page of it is read, in the search's order.
		confluence.pageSize = 1;
		const pages = await confluence.client().pages(ACME, ["504", "500", "502", "999"]);
		expect(pages.map((item) => item.id)).toEqual(["504", "500", "502"]);
	});

	test("space listings stop at a cap", async () => {
		const confluence = new FakeConfluence();
		// Acme has more spaces than MAX_SPACE_PAGES pages of one.
		const acme = confluence.acme();
		for (let n = 0; n < MAX_SPACE_PAGES; n++) acme.spaces.push(space(String(110 + n), `P${n}`, `Space ${n}`));
		confluence.pageSize = 1;
		const run = await start(confluence, { "*": ["read"] });
		const outcome = await run.ok("confluence_list_spaces", { site_id: ACME });
		expect(outcome.result.items.map((item) => item.key)).toEqual(["ENG", "FIN", "~ada", ...Array.from({ length: MAX_SPACE_PAGES - 3 }, (_, n) => `P${n}`)]);
		expect(outcome.result.incomplete).toBe(true);
		expect(confluence.reads("/api/v2/spaces")).toHaveLength(MAX_SPACE_PAGES);
	});

	test("a repeated cursor is refused", async () => {
		const confluence = new FakeConfluence();
		confluence.hook = (_method, path) => (path.endsWith("/api/v2/spaces") ? jsonResponse(200, { results: [], _links: { next: "/x?cursor=same" } }) : null);
		await expect(confluence.client().spacesBy(ACME, "keys", ["ENG"])).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		expect(confluence.reads("/api/v2/spaces")).toHaveLength(2);
	});
});

describe("writing", () => {
	test("comments are plain text without links to Atlassian", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read", "comment"] });
		const outcome = await run.ok("confluence_add_comment", { page: "500", text: "Done.\n\n**not bold**" });
		expect(outcome.result.items).toEqual([
			{ written: true, id: "709", page_id: "500", created: "2026-10-03T09:00:00.000Z", link: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500" },
		]);
		expect(confluence.writes).toHaveLength(1);
		const [path, sent] = confluence.writes[0] as [string, JsonObject];
		const written = sent.body as JsonObject;
		expect([path, sent.pageId, written.representation]).toEqual(["footer-comments", "500", "atlas_doc_format"]);
		expect(parseJson(written.value as string)).toEqual(doc(paragraph(text("Done.")), paragraph(text("**not bold**"))));
		expect(written.value).toBe(
			'{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Done."}]},{"type":"paragraph","content":[{"type":"text","text":"**not bold**"}]}]}',
		);
		for (const value of ["see https://acme.atlassian.net/wiki/x/501", "ACME%2EATLASSIAN%2ENET/x", "bell \x07"]) {
			expect(await run.code("confluence_add_comment", { page: "500", text: value }), value).toBe("INVALID_ARGUMENTS");
		}
		expect(await run.code("confluence_add_comment", { page: "501", text: "x" })).toBe("POLICY_DENIED");
		expect(confluence.writes).toHaveLength(1);
	});

	test("writes need read and their consent", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		let run = await start(confluence, { [ACME]: ["read", "comment", "create"] }, { ceiling: [ceilingDeny(ENG, ["read"])] });
		expect(await run.code("confluence_add_comment", { page: "500", text: "x" })).toBe("POLICY_DENIED");
		expect(await run.code("confluence_create_page", { space: "ENG", title: "x" })).toBe("POLICY_DENIED");
		// With only the comment scope, creating pages is not offered.
		run = await start(confluence, { [ACME]: ["read", "comment", "create"] }, { scopes: [...READ_SCOPES, "write:comment:confluence"] });
		expect(run.tools.filter((tool) => tool.startsWith("confluence_")).sort()).toEqual([
			"confluence_add_comment",
			"confluence_get_page",
			"confluence_list_spaces",
			"confluence_search_pages",
		]);
		expect(confluence.writes).toEqual([]);
	});

	test("pages are created in the space or under a page in it", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read", "create"] });
		const args = { space: "ENG", title: "Release notes", body: "Shipped.", parent_page: "500" };
		expect((await run.ok("confluence_create_page", args)).result.items).toEqual([
			{ written: true, id: "509", site_id: ACME, space_id: "100", link: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=509" },
		]);
		expect(confluence.writes).toHaveLength(1);
		const [path, sent] = confluence.writes[0] as [string, JsonObject];
		expect([path, without(sent, "body")]).toEqual(["pages", { spaceId: "100", status: "current", title: "Release notes", parentId: "500" }]);
		expect(parseJson((sent.body as JsonObject).value as string)).toEqual(doc(paragraph(text("Shipped."))));
		// A parent in another space, or one that does not exist, is refused alike.
		for (const parent of ["501", "404", "505"]) {
			expect(await run.error("confluence_create_page", { ...args, title: "Other", parent_page: parent }), parent).toEqual({
				code: "POLICY_DENIED",
				message: "This resource or action is not available under the current permissions.",
			});
		}
		for (const title of ["a\nb", "see acme.atlassian.net/wiki/x/501"]) {
			expect(await run.code("confluence_create_page", { ...args, title }), title).toBe("INVALID_ARGUMENTS");
		}
		// A title the space already has: Confluence's reason is not passed on.
		expect(await run.error("confluence_create_page", { space: "ENG", title: "Runbook" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Confluence refused the page. A page with this title may already exist in the space.",
		});
		expect(confluence.writes).toHaveLength(2);
		// Automation moves the new page at once: the result is in FIN, which the agent may not read.
		confluence.hook = (method, path) => (method === "GET" && path.endsWith("/pages/509") ? jsonResponse(200, page("509", "101", SECRET)) : null);
		delete confluence.acme().pages["509"];
		const outcome = await run.ok("confluence_create_page", { space: "ENG", title: "Again" });
		expect(outcome.result.items).toEqual([]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(confluence.writes.at(-1)?.[1]).not.toHaveProperty("parentId");
	});

	test("a created page that cannot be read back counts without a result", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		const run = await start(confluence, { [ENG]: ["read", "create"] });
		confluence.hook = (method, path) => (method === "GET" && path.endsWith("/pages/509") ? jsonResponse(404, {}) : null);
		const outcome = await run.ok("confluence_create_page", { space: "ENG", title: "New" });
		expect(outcome.result).toEqual({ items: [], count: 0, outcome: "applied_without_result" });
		expect(confluence.writes).toHaveLength(1);
	});

	test("written text may not name a site on its own domain", async () => {
		const confluence = new FakeConfluence();
		confluence.oneSite();
		(confluence.resources[0] as JsonObject).url = "https://wiki.acme.example";
		const run = await start(confluence, { [ENG]: ["read", "comment", "create"] });
		const refusal = { code: "INVALID_ARGUMENTS", message: "Text must not contain addresses of Atlassian sites: Atlassian may show them as previews." };
		for (const value of ["see https://WIKI.acme.example/wiki/x", "wiki%2Eacme%2Eexample/x"]) {
			expect(await run.error("confluence_add_comment", { page: "500", text: value }), value).toEqual(refusal);
			expect(await run.error("confluence_create_page", { space: "ENG", title: "New", body: value }), value).toEqual(refusal);
		}
		expect(confluence.writes).toEqual([]);
	});
});
