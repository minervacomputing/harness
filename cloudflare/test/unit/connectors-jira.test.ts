// backend/tests/test_jira.py, case by case: the Jira connector against an in-memory Atlassian API behind an
// injected `fetch`, and runs through the executor. The ADF cases are in connectors-atlassian.test.ts; the
// pure helpers are also checked against vectors from today's Python.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { MAX_SITES } from "../../src/connectors/atlassian/index.ts";
import { JiraClient, nextCursor, pageParams } from "../../src/connectors/jira/client.ts";
import { discoveryCursor, jiraConnector } from "../../src/connectors/jira/connector.ts";
import { MAX_PROJECT_PAGES, searchWords } from "../../src/connectors/jira/reads.ts";
import { names } from "../../src/connectors/jira/writes.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { Scenario, USER, jsonResponse } from "./executor-fakes.ts";

const SECRET = "SECRET merger";
const ACCOUNT_ID = "5b10ac8d82e05b22cc7d4ef5";
const ACME = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";
const WIKI = "33333333-3333-3333-3333-333333333333";
const ENG = `${ACME}/10000`;
const FIN = `${ACME}/10001`;
const OPS = `${BETA}/10000`;
const SCOPES = ["offline_access", "read:me", "read:jira-work", "write:jira-work"];
/** Jira's page tokens are opaque; some are not URL-safe. */
const TOKEN = "eyJ+a/b=";
const CONNECTION = "0199a000-0000-7000-8000-0000000000a1";

type Outcome = { value?: Json; error?: string; message?: string };
const VECTORS = parseJson(readFileSync(new URL("../fixtures/connectors/atlassian/vectors.json", import.meta.url).pathname, "utf8")) as unknown as {
	jira: {
		page_params: ({ cursor: string | null } & Outcome)[];
		next_cursor: ({ body: JsonObject } & Outcome)[];
		discover_cursor: ({ cursor: string | null } & Outcome)[];
		search_words: ({ text: string } & Outcome)[];
		names: { values: (string | null)[]; value: string }[];
	};
};

function outcome(run: () => Json): Outcome {
	try {
		return { value: run() };
	} catch (error) {
		if (error instanceof OperationError) return { error: error.code, message: error.message };
		throw error;
	}
}

function doc(...content: Json[]): JsonObject {
	return { type: "doc", version: 1, content };
}

function paragraph(...content: Json[]): Json {
	return { type: "paragraph", content };
}

function text(value: string, href?: string): JsonObject {
	return href === undefined ? { type: "text", text: value } : { type: "text", text: value, marks: [{ type: "link", attrs: { href } }] };
}

type Issue = { id: string; key: string; fields: { [name: string]: Json } & { project: { id: string; key: string } } };

function issue(id: string, key: string, project: string, summary: string, fields: { [name: string]: Json } = {}): Issue {
	return {
		id,
		key,
		fields: {
			project: { id: project, key: key.split("-")[0] as string },
			summary,
			status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
			issuetype: { id: "1", name: "Task", subtask: false },
			priority: { name: "Medium" },
			assignee: { displayName: "Ada" },
			reporter: { displayName: "Grace" },
			labels: [],
			created: "2026-10-01T09:00:00.000+0000",
			updated: "2026-10-02T09:00:00.000+0000",
			duedate: null,
			resolution: null,
			description: null,
			subtasks: [],
			issuelinks: [],
			attachment: [],
			...fields,
		},
	};
}

function project(id: string, key: string, name: string): JsonObject {
	return { id, key, name, projectTypeKey: "software", archived: false };
}

interface Recorded {
	method: string;
	path: string;
	params: { [name: string]: string };
}

type Hook = (method: string, path: string, params: { [name: string]: string }) => Response | null;

interface FakeSite {
	projects: JsonObject[];
	issues: { [id: string]: Issue };
	aliases: { [key: string]: string };
	comments: { [id: string]: JsonObject[] };
}

const fakes: FakeJira[] = [];

/**
 * Atlassian's API for Jira (test_jira.py `FakeJira`). Acme (acme.atlassian.net) has projects ENG and FIN;
 * Beta (beta.atlassian.net) has OPS, whose id repeats ENG's. ENG-1 has a sub-task ENG-2 and blocks FIN-1,
 * whose former key was ENG-9.
 */
class FakeJira {
	me: JsonObject = { account_id: ACCOUNT_ID, name: "Ada", email: "ada@example.com" };
	resources: JsonObject[] = [
		{ id: BETA.toUpperCase(), name: "Beta", url: "https://beta.atlassian.net", scopes: SCOPES },
		{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: SCOPES },
		// The same site again (Atlassian lists a site once per product), and a site without Jira.
		{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:confluence"] },
		{ id: WIKI, name: "Wiki", url: "https://wiki.atlassian.net", scopes: ["read:confluence"] },
	];
	sites: { [id: string]: FakeSite };
	types: JsonObject[] = [
		{ id: "1", name: "Task", subtask: false },
		{ id: "2", name: "Bug", subtask: false },
		{ id: "5", name: "Sub-task", subtask: true },
	];
	transitions: JsonObject[] = [
		{ id: "11", name: "Start", to: { name: "In Progress" } },
		{ id: "21", name: "Finish", to: { name: "Done" } },
		{ id: "31", name: "Close", to: { name: "Done" } },
	];
	pageSize: number | null = null;
	/** Ids search returns before the issues it names (an index that lags behind moves). */
	stale: string[] = [];
	requests: Recorded[] = [];
	writes: [string, Json][] = [];
	hook: Hook | null = null;
	problems: string[] = [];

	constructor() {
		fakes.push(this);
		const description = doc(
			paragraph(text("See "), text(SECRET, "https://acme.atlassian.net/browse/FIN-1"), text(" and "), text("docs", "https://example.com/docs")),
			{ type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/FIN-1" } },
		);
		this.sites = {
			[ACME]: {
				projects: [project("10000", "ENG", "Engineering"), project("10001", "FIN", SECRET)],
				issues: {
					"20001": issue("20001", "ENG-1", "10000", "Fix login", {
						description,
						subtasks: [{ id: "20003", key: "ENG-2" }],
						issuelinks: [{ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { id: "20002", key: "FIN-1" } }],
						attachment: [{ filename: SECRET }],
					}),
					"20002": issue("20002", "FIN-1", "10001", SECRET),
					"20003": issue("20003", "ENG-2", "10000", "Write tests", { parent: { id: "20001" } }),
				},
				aliases: { "ENG-9": "20002" },
				comments: {
					"20001": [0, 1, 2].map((n) => ({
						id: String(30000 + n),
						author: { displayName: "Grace" },
						body: doc(paragraph(text(`comment ${n}`))),
						created: `2026-10-01T${String(n).padStart(2, "0")}:00:00.000+0000`,
					})),
				},
			},
			[BETA]: { projects: [project("10000", "OPS", "Operations")], issues: { "20001": issue("20001", "OPS-1", "10000", "Rotate keys") }, aliases: {}, comments: {} },
		};
	}

	static missing(): Response {
		return jsonResponse(404, { errorMessages: [SECRET] });
	}

	#issue(site: FakeSite, name: string): Issue | null {
		const id = site.aliases[name] ?? name;
		return site.issues[id] ?? Object.values(site.issues).find((found) => found.key === id) ?? null;
	}

	#page<T>(items: T[], params: { [name: string]: string }): [T[], number | null] {
		const size = this.pageSize ?? Number(params.maxResults ?? 50);
		let start = Number(params.startAt ?? 0);
		if ("nextPageToken" in params) {
			const token = params.nextPageToken as string;
			if (!token.startsWith(TOKEN)) this.problems.push(`unexpected token ${token}`);
			start = Number(token.slice(TOKEN.length));
		}
		const end = start + size;
		return [items.slice(start, end), end < items.length ? end : null];
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
		if (parts[0] !== "ex" || parts[1] !== "jira" || parts.slice(3, 6).join("/") !== "rest/api/3") {
			this.problems.push(`unexpected path ${path}`);
			return jsonResponse(500, {});
		}
		const site = this.sites[parts[2] as string];
		if (site === undefined) return FakeJira.missing();
		const rest = parts.slice(6);
		const route = rest.join("/");
		if (request.method === "POST") {
			const body = parseJson(await request.text()) as JsonObject;
			if (route === "issue/bulkfetch") {
				const found = (body.issueIdsOrKeys as string[]).map((name) => this.#issue(site, name)).filter((item): item is Issue => item !== null);
				// In ascending id order, whatever order they were asked in.
				found.sort((a, b) => Number(a.id) - Number(b.id));
				return jsonResponse(200, { issues: found, issueErrors: [] });
			}
			this.writes.push([route, body]);
			if (route === "issue") {
				const fields = body.fields as { project: { id: string }; summary: string };
				const target = site.projects.find((item) => item.id === fields.project.id) as JsonObject;
				const created = issue("20009", `${target.key}-9`, target.id as string, fields.summary);
				site.issues["20009"] = created;
				return jsonResponse(201, { id: "20009", key: created.key, self: "x" });
			}
			if (rest[0] === "issue" && rest[2] === "comment" && rest.length === 3) {
				return jsonResponse(201, { id: "30009", body: body.body as Json, created: "2026-10-03T09:00:00.000+0000" });
			}
			if (rest[0] === "issue" && rest[2] === "transitions" && rest.length === 3) return new Response(null, { status: 204 });
			this.problems.push(`unexpected write ${path}`);
			return jsonResponse(500, {});
		}
		if (route === "project/search") {
			if (params.action !== "browse") this.problems.push("project search without action=browse");
			let projects = site.projects;
			if ("query" in params) {
				const query = (params.query as string).toLowerCase();
				projects = projects.filter((item) => String(item.key).toLowerCase().includes(query) || String(item.name).toLowerCase().includes(query));
			}
			const [page, after] = this.#page(projects, params);
			return jsonResponse(200, { values: page, isLast: after === null, total: projects.length });
		}
		if (rest[0] === "project" && rest.length === 2) {
			const found = site.projects.find((item) => item.id === rest[1] || item.key === rest[1]);
			return found ? jsonResponse(200, found) : FakeJira.missing();
		}
		if (rest[0] === "issue" && rest[1] === "createmeta" && rest[3] === "issuetypes" && rest.length === 4) {
			const [page] = this.#page(this.types, params);
			return jsonResponse(200, { issueTypes: page, total: this.types.length, startAt: Number(params.startAt) });
		}
		if (rest[0] === "issue" && rest.length === 2) {
			const found = this.#issue(site, rest[1] as string);
			return found ? jsonResponse(200, found) : FakeJira.missing();
		}
		if (rest[0] === "issue" && rest[2] === "comment" && rest.length === 3) {
			if (params.orderBy !== "-created") this.problems.push("comments not newest first");
			const comments = [...(site.comments[rest[1] as string] ?? [])].reverse();
			return jsonResponse(200, { comments: comments.slice(0, Number(params.maxResults)), total: comments.length });
		}
		if (rest[0] === "issue" && rest[2] === "transitions" && rest.length === 3) return jsonResponse(200, { transitions: this.transitions });
		if (route === "search/jql") {
			const wanted = /project = (\d+) /.exec(params.jql as string)?.[1];
			// Most recently updated first: here, the highest id.
			const matching = Object.entries(site.issues)
				.filter(([, found]) => found.fields.project.id === wanted)
				.map(([id]) => id)
				.sort((a, b) => Number(b) - Number(a));
			const [page, after] = this.#page([...this.stale, ...matching], params);
			const body: JsonObject = { issues: page.map((id) => ({ id })) };
			if (after !== null) body.nextPageToken = `${TOKEN}${after}`;
			return jsonResponse(200, body);
		}
		this.problems.push(`unexpected read ${path}`);
		return jsonResponse(500, {});
	};

	reads(suffix: string): Recorded[] {
		return this.requests.filter((request) => request.method === "GET" && request.path.endsWith(suffix));
	}

	client(): JiraClient {
		return new JiraClient("token", settingsIo(this.fetch));
	}

	oneSite(): void {
		this.resources = this.resources.filter((resource) => resource.id !== BETA.toUpperCase());
	}
}

afterEach(() => {
	for (const fake of fakes.splice(0)) expect(fake.problems).toEqual([]);
});

/** Starts and claims a run with the user's Jira connection, holding `grants` ({site or project: actions}). */
function start(jira: FakeJira, grants: { [id: string]: string[] }, options: { scopes?: string[]; ceiling?: GrantRow[] } = {}): Promise<Scenario> {
	return Scenario.start({
		connectors: [jiraConnector()],
		connections: [{ id: CONNECTION, provider: "jira", payload: { kind: "oauth2", access_token: "t", refresh_token: null, scopes: options.scopes ?? SCOPES } }],
		user: Object.entries(grants).map(([resourceId, actions]) => ({
			layer: "user",
			subject: USER,
			connectionId: CONNECTION,
			kind: "project",
			resourceId,
			resourceName: "",
			actions: [...actions].sort(),
			effect: "allow",
		})),
		ceiling: options.ceiling ?? [],
		fetch: jira.fetch,
	});
}

/** A deny in the workspace ceiling (connector_runs.py `ceiling`). */
function ceilingDeny(resourceId: string, actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: CONNECTION, kind: "project", resourceId, resourceName: "", actions, effect: "deny" };
}

async function items(run: Scenario, tool: string, args: Json): Promise<JsonObject[]> {
	return (await run.ok(tool, args)).result.items as JsonObject[];
}

describe("connecting and discovery", () => {
	test("the account and its Jira sites", async () => {
		const jira = new FakeJira();
		const connector = jiraConnector();
		const client = jira.client();
		expect(await connector.account(client)).toEqual({ id: ACCOUNT_ID, label: "Ada (ada@example.com)" });
		// Once each, ordered by id, in lower case, without sites that did not grant Jira.
		expect((await client.sites()).map((site) => [site.id, site.label])).toEqual([
			[ACME, "Acme (acme.atlassian.net)"],
			[BETA, "Beta (beta.atlassian.net)"],
		]);
		jira.resources = jira.resources.slice(3);
		await expect(connector.account(jira.client())).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT", message: "This Atlassian account gave Minerva no Jira site." });
		// Labels without both a name and an email.
		jira.resources = [{ id: ACME, name: "Acme", url: "https://acme.atlassian.net", scopes: SCOPES }];
		for (const [me, label] of [
			[{ account_id: ACCOUNT_ID, name: "Ada" }, "Ada"],
			[{ account_id: ACCOUNT_ID, email: "ada@example.com" }, "ada@example.com"],
			[{ account_id: ACCOUNT_ID, name: null, email: null }, "Jira"],
		] as const) {
			jira.me = me;
			expect((await connector.account(jira.client())).label).toBe(label);
		}
	});

	test("discovery lists sites, then each site's projects", async () => {
		const jira = new FakeJira();
		const connector = jiraConnector();
		const client = jira.client();
		const page = await connector.discover(client, "project", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[ACME, "Acme (acme.atlassian.net)"],
			[BETA, "Beta (beta.atlassian.net)"],
			[ENG, "Engineering (ENG) · Acme"],
			[FIN, `${SECRET} (FIN) · Acme`],
		]);
		const second = await connector.discover(client, "project", { query: null, cursor: page.nextCursor ?? null });
		expect([second.items.map((item) => [item.id, item.name]), second.nextCursor]).toEqual([[[OPS, "Operations (OPS) · Beta"]], null]);
		jira.pageSize = 1;
		const first = await connector.discover(client, "project", { query: "e", cursor: null });
		expect([first.items.map((item) => item.id), first.nextCursor]).toEqual([[ACME, BETA, ENG], "0:1"]);
		for (const cursor of ["x", "2:0", "0:-1", "0:1234567"]) {
			await expect(connector.discover(client, "project", { query: null, cursor }), cursor).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		}
		const described = await connector.describe(client, "project", [ACME, ACME.toUpperCase(), WIKI, ENG, OPS, `${ACME}/99999`, `${WIKI}/10000`, `${ACME}/ENG`]);
		expect(described).toEqual({ [ACME]: "Acme (acme.atlassian.net)", [ENG]: "Engineering (ENG) · Acme", [OPS]: "Operations (OPS) · Beta" });
	});

	test("too many sites are refused", async () => {
		const jira = new FakeJira();
		// Python lowers MAX_SITES to 1; here the account reaches one more site than the limit.
		const site = (n: number) => ({ id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, name: `S${n}`, url: `https://s${n}.atlassian.net`, scopes: SCOPES });
		jira.resources = Array.from({ length: MAX_SITES }, (_, n) => site(n));
		expect(await jira.client().sites()).toHaveLength(MAX_SITES);
		jira.resources.push(site(MAX_SITES));
		await expect(jira.client().sites()).rejects.toMatchObject({ code: "PROVIDER_LIMIT", message: "This account reaches more Jira sites than Minerva reads." });
	});

	test("cursors are checked", () => {
		expect(pageParams(`t:${TOKEN}`)).toEqual({ nextPageToken: TOKEN });
		for (const cursor of ["x:abc", "t:", "t:a b", `t:${"a".repeat(991)}`, "t:é"]) expect(() => pageParams(cursor), cursor).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		expect(nextCursor({ nextPageToken: "abc", isLast: true })).toBeNull();
		expect(nextCursor({})).toBeNull();
		for (const token of ["a b", 5, "a".repeat(991)]) expect(() => nextCursor({ nextPageToken: token }), String(token)).toThrow(expect.objectContaining({ code: "PROVIDER_LIMIT" }));
	});

	test("the pure helpers answer as Python's", () => {
		const vectors = VECTORS.jira;
		for (const { cursor, ...expected } of vectors.page_params) expect(outcome(() => pageParams(cursor)), String(cursor)).toEqual(expected);
		for (const { body, ...expected } of vectors.next_cursor) expect(outcome(() => nextCursor(body)), JSON.stringify(body)).toEqual(expected);
		for (const { cursor, ...expected } of vectors.discover_cursor) expect(outcome(() => discoveryCursor(cursor, [null, null])), String(cursor)).toEqual(expected);
		for (const { text: value, ...expected } of vectors.search_words) expect(outcome(() => searchWords(value)), value).toEqual(expected);
		for (const { values, value } of vectors.names) expect(names(values)).toBe(value);
	});

	test("scopes follow the allowed actions", () => {
		const connector = jiraConnector();
		const base = ["offline_access", "read:me", "read:jira-work"];
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(base);
		expect(requestedScopes(connector, new Set(["read", "comment"]))).toEqual([...base, "write:jira-work"]);
		expect(consentNeeded(connector, base, new Set(["read", "comment", "create"]))).toEqual(["comment", "create"]);
		expect(consentNeeded(connector, [...base, "write:jira-work"], new Set(["read", "comment", "transition"]))).toEqual([]);
	});
});

describe("reading", () => {
	test("a site grant covers its projects, and denies hold inside it", async () => {
		const jira = new FakeJira();
		const run = await start(jira, { [ACME]: ["read"] }, { ceiling: [ceilingDeny(FIN)] });
		const outcome = await run.ok("jira_list_projects", {});
		expect(outcome.result.items).toEqual([
			{ id: "10000", site_id: ACME, site: "Acme (acme.atlassian.net)", key: "ENG", name: "Engineering", type: "software", archived: false },
		]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		// Several sites: calls name one.
		expect(await run.error("jira_get_issue", { issue: "ENG-1" })).toEqual({ code: "INVALID_ARGUMENTS", message: "This connection reaches 2 Jira sites; name one with site_id." });
		expect((await items(run, "jira_get_issue", { site_id: ACME.toUpperCase(), issue: "eng-1" }))[0]?.key).toBe("ENG-1");
		for (const [siteId, name] of [
			[ACME, "FIN-1"],
			[ACME, "20002"],
			[BETA, "OPS-1"],
			[WIKI, "ENG-1"],
			[ACME, "ENG-404"],
		] as const) {
			expect(await run.code("jira_get_issue", { site_id: siteId, issue: name }), `${siteId} ${name}`).toBe("POLICY_DENIED");
		}
		for (const args of [
			{ site_id: "acme", issue: "ENG-1" },
			{ site_id: ACME, issue: "ENG 1" },
		]) {
			expect(await run.code("jira_get_issue", args), JSON.stringify(args)).toBe("INVALID_ARGUMENTS");
		}
		// Nothing of a refused issue was read beyond its project.
		const refused = [...jira.reads("/issue/20002"), ...jira.reads("/FIN-1")];
		expect(refused.length).toBeGreaterThan(0);
		expect(refused.every((request) => request.params.fields === "project")).toBe(true);
	});

	test("the arguments' messages", async () => {
		const jira = new FakeJira();
		const run = await start(jira, { [ACME]: ["read"] });
		expect(await run.error("jira_get_issue", { site_id: "x".repeat(36), issue: "ENG-1" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. site_id: must be a site id from list_projects",
		});
		expect(await run.error("jira_get_issue", { issue: "ENG 1" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: 'Invalid arguments. issue: must be an issue key such as "ENG-123", or an issue id',
		});
		expect(await run.error("jira_search_issues", { project: "e-g" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: 'Invalid arguments. project: must be a project key such as "ENG", or a project id',
		});
	});

	test("one site needs no site_id, and project ids repeat across sites", async () => {
		const jira = new FakeJira();
		let run = await start(jira, { [OPS]: ["read"] });
		expect(await run.code("jira_search_issues", { project: "ENG" })).toBe("INVALID_ARGUMENTS");
		// Project 10000 on Acme is not project 10000 on Beta.
		expect(await run.code("jira_search_issues", { site_id: ACME, project: "10000" })).toBe("POLICY_DENIED");
		expect((await items(run, "jira_search_issues", { site_id: BETA, project: "10000" })).map((item) => item.key)).toEqual(["OPS-1"]);
		jira.oneSite();
		run = await start(jira, { [ENG]: ["read"] });
		expect((await items(run, "jira_search_issues", { project: "ENG" })).map((item) => item.key)).toEqual(["ENG-2", "ENG-1"]);
	});

	test("a former key is authorized where the issue is now", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read"] });
		expect(await run.code("jira_get_issue", { issue: "ENG-9" })).toBe("POLICY_DENIED");
		expect(jira.reads("/comment")).toEqual([]);
	});

	test("issues show their project only and hide Atlassian links", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read"] });
		const outcome = await run.ok("jira_get_issue", { issue: "ENG-1" });
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		const found = outcome.result.items[0] as JsonObject;
		expect(found.description).toBe("See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link]");
		expect((found.comments as JsonObject[]).map((comment) => comment.text)).toEqual(["comment 0", "comment 1", "comment 2"]);
		expect(found.comments_not_shown).toBe(0);
		expect(found.related).toEqual([{ relation: "subtask", key: "ENG-2", summary: "Write tests", status: { name: "To Do", category: "To Do" } }]);
		expect([found.related_elsewhere, found.related_not_shown]).toEqual([1, 0]);
		expect([found.attachments, found.link]).toEqual([1, "https://acme.atlassian.net/browse/ENG-1"]);
		expect(jira.reads("/comment")[0]?.params.maxResults).toBe("30");
		// The whole record, as Python returns it.
		expect(found).toEqual({
			id: "20001",
			key: "ENG-1",
			site_id: ACME,
			project_id: "10000",
			summary: "Fix login",
			status: { name: "To Do", category: "To Do" },
			type: "Task",
			priority: "Medium",
			assignee: "Ada",
			reporter: "Grace",
			labels: [],
			created: "2026-10-01T09:00:00.000+0000",
			updated: "2026-10-02T09:00:00.000+0000",
			due_date: null,
			resolution: null,
			description: "See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link]",
			description_truncated: false,
			attachments: 1,
			comments: [0, 1, 2].map((n) => ({
				id: String(30000 + n),
				author: "Grace",
				created: `2026-10-01T0${n}:00:00.000+0000`,
				updated: null,
				text: `comment ${n}`,
				text_truncated: false,
			})),
			comments_not_shown: 0,
			link: "https://acme.atlassian.net/browse/ENG-1",
			related: [{ relation: "subtask", key: "ENG-2", summary: "Write tests", status: { name: "To Do", category: "To Do" } }],
			related_elsewhere: 1,
			related_not_shown: 0,
		});
		// A parent is read for its project too.
		const sub = (await items(run, "jira_get_issue", { issue: "ENG-2" }))[0] as JsonObject;
		expect((sub.related as JsonObject[]).map((item) => item.key)).toEqual(["ENG-1"]);
	});

	test("an issue that moves after authorizing is refused", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read", "comment", "transition"] });
		let moves = 0;
		const target = () => (jira.sites[ACME] as FakeSite).issues["20001"] as Issue;
		// Jira answers the lookup by key, then the issue moves to FIN.
		jira.hook = (method, path) => {
			if (method === "GET" && path.endsWith("/issue/ENG-1")) {
				const response = jsonResponse(200, structuredClone(target()));
				target().fields.project.id = "10001";
				moves += 1;
				return response;
			}
			return null;
		};
		expect(await run.code("jira_get_issue", { issue: "ENG-1" })).toBe("ISSUE_MOVED");
		target().fields.project.id = "10000";
		expect(await run.code("jira_add_comment", { issue: "ENG-1", text: "hi" })).toBe("ISSUE_MOVED");
		target().fields.project.id = "10000";
		// A status that matches no transition: the statuses are not named, since the issue moved.
		expect(await run.error("jira_transition_issue", { issue: "ENG-1", status: "nowhere" })).toEqual({
			code: "ISSUE_MOVED",
			message: "This issue moved in Jira while Minerva was using it, or access was lost. Try again.",
		});
		expect(moves).toBe(3);
		expect(jira.writes).toEqual([]);
	});

	test("search reads results again and shows them where they are", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		jira.stale = ["20002"];
		const run = await start(jira, { [ENG]: ["read"] });
		const outcome = await run.ok("jira_search_issues", { project: "eng", text: 'login "OR project = FIN', status_category: "to_do", assigned_to_me: true });
		expect(outcome.result.items.map((item) => item.key)).toEqual(["ENG-2", "ENG-1"]);
		expect(outcome.result.items[1]).toEqual({
			id: "20001",
			key: "ENG-1",
			site_id: ACME,
			project_id: "10000",
			summary: "Fix login",
			status: { name: "To Do", category: "To Do" },
			type: "Task",
			priority: "Medium",
			assignee: "Ada",
			updated: "2026-10-02T09:00:00.000+0000",
			link: "https://acme.atlassian.net/browse/ENG-1",
		});
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(jira.reads("/search/jql").at(-1)?.params.jql).toBe(
			'project = 10000 AND summary ~ "login OR project FIN" AND statusCategory = 2 AND assignee = currentUser() ORDER BY updated DESC',
		);
		expect(await run.error("jira_search_issues", { project: "ENG", text: "?!" })).toEqual({ code: "INVALID_ARGUMENTS", message: "text must contain letters or digits." });
		expect(await run.code("jira_search_issues", { project: "FIN" })).toBe("POLICY_DENIED");
		// A search Jira refuses is the agent's to change; Jira's reason is not passed on.
		jira.hook = (_method, path) => (path.endsWith("/search/jql") ? jsonResponse(400, { errorMessages: [SECRET] }) : null);
		expect(await run.error("jira_search_issues", { project: "ENG" })).toEqual({ code: "INVALID_ARGUMENTS", message: "Jira could not run this search." });
	});

	test("search pages are run-bound", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		jira.pageSize = 1;
		const run = await start(jira, { "*": ["read"] });
		const first = await run.ok("jira_search_issues", { project: "ENG", limit: 1 });
		expect(first.result.items.map((item) => item.key)).toEqual(["ENG-2"]);
		const token = first.result.next_cursor as string;
		expect(token.startsWith("t:")).toBe(false);
		const second = await run.ok("jira_search_issues", { project: "ENG", limit: 1, cursor: token });
		expect(second.result.items.map((item) => item.key)).toEqual(["ENG-1"]);
		expect(second.result.next_cursor).toBeUndefined();
		expect(jira.reads("/search/jql").at(-1)?.params.nextPageToken).toBe(`${TOKEN}1`);
		expect(await run.code("jira_search_issues", { project: "FIN", limit: 1, cursor: token })).toBe("INVALID_CURSOR");
	});

	test("project listings stop at a cap", async () => {
		const jira = new FakeJira();
		// Python lowers MAX_PROJECT_PAGES to 1; here Acme has more projects than that many pages of one.
		const acme = jira.sites[ACME] as FakeSite;
		for (let n = 0; n < MAX_PROJECT_PAGES; n++) acme.projects.push(project(String(11000 + n), `P${n}`, `Project ${n}`));
		jira.pageSize = 1;
		const run = await start(jira, { "*": ["read"] });
		const outcome = await run.ok("jira_list_projects", { site_id: ACME });
		expect(outcome.result.items.map((item) => item.key)).toEqual(["ENG", "FIN", ...Array.from({ length: MAX_PROJECT_PAGES - 2 }, (_, n) => `P${n}`)]);
		expect(outcome.result.incomplete).toBe(true);
		expect(jira.reads("/project/search")).toHaveLength(MAX_PROJECT_PAGES);
	});
});

describe("writing", () => {
	test("comments are plain text without links to Atlassian", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read", "comment"] });
		const outcome = await run.ok("jira_add_comment", { issue: "ENG-1", text: "Done.\n\n**not bold**\nnext" });
		expect(outcome.result.items).toEqual([
			{ written: true, id: "30009", issue_id: "20001", issue_key: "ENG-1", created: "2026-10-03T09:00:00.000+0000", link: "https://acme.atlassian.net/browse/ENG-1" },
		]);
		expect(jira.writes).toEqual([
			["issue/20001/comment", { body: doc(paragraph(text("Done.")), paragraph(text("**not bold**"), { type: "hardBreak" }, text("next"))) }],
		]);
		for (const value of ["see https://acme.atlassian.net/browse/FIN-1", "see https%3A%2F%2Facme%2Eatlassian%2Enet", "ACME.ATLASSIAN.NET/x", "bell \x07"]) {
			expect(await run.code("jira_add_comment", { issue: "ENG-1", text: value }), value).toBe("INVALID_ARGUMENTS");
		}
		expect(await run.error("jira_add_comment", { issue: "ENG-1", text: "atl.so/x" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message:
				"Invalid arguments. text: must not contain Atlassian addresses: Atlassian may show them as previews of issues or pages you may not read",
		});
		expect(jira.writes).toHaveLength(1);
	});

	test("writes need read and their consent", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		let run = await start(jira, { [ACME]: ["read", "comment", "create", "transition"] }, { ceiling: [ceilingDeny(ENG, ["read"])] });
		expect(await run.code("jira_add_comment", { issue: "ENG-1", text: "x" })).toBe("POLICY_DENIED");
		expect(await run.code("jira_create_issue", { project: "ENG", issue_type: "Task", summary: "x" })).toBe("POLICY_DENIED");
		// Without write:jira-work only the reads are offered.
		run = await start(jira, { [ACME]: ["read", "comment"] }, { scopes: ["read:jira-work", "read:me"] });
		expect(run.tools.filter((tool) => tool.startsWith("jira_")).sort()).toEqual(["jira_get_issue", "jira_list_projects", "jira_search_issues"]);
		expect(jira.writes).toEqual([]);
	});

	test("issues are created with a named type and shown where they land", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read", "create"] });
		const args = { project: "ENG", issue_type: "bug", summary: "Crash", description: "Steps" };
		expect((await run.ok("jira_create_issue", args)).result.items).toEqual([
			{ written: true, id: "20009", key: "ENG-9", site_id: ACME, project_id: "10000", link: "https://acme.atlassian.net/browse/ENG-9" },
		]);
		expect(jira.writes).toEqual([["issue", { fields: { project: { id: "10000" }, issuetype: { id: "2" }, summary: "Crash", description: doc(paragraph(text("Steps"))) } }]]);
		for (const issueType of ["Sub-task", "Epic"]) {
			expect(await run.error("jira_create_issue", { ...args, issue_type: issueType }), issueType).toEqual({
				code: "INVALID_ARGUMENTS",
				message: "No single issue type in this project has that name. Types: Bug, Task.",
			});
		}
		for (const summary of ["a\nb", "see acme.atlassian.net/browse/FIN-1"]) {
			expect(await run.code("jira_create_issue", { ...args, summary }), summary).toBe("INVALID_ARGUMENTS");
		}
		expect(jira.writes).toHaveLength(1);
		// Automation moves the new issue at once: the result is in FIN, which the agent may not read.
		jira.hook = (method, path) => (method === "GET" && path.endsWith("/issue/20009") ? jsonResponse(200, issue("20009", "FIN-9", "10001", SECRET)) : null);
		const outcome = await run.ok("jira_create_issue", { ...args, summary: "Again" });
		expect(outcome.result.items).toEqual([]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(jira.writes).toHaveLength(2);
	});

	test("a created issue that cannot be read back counts without a result", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read", "create"] });
		jira.hook = (method, path) => (method === "GET" && path.endsWith("/issue/20009") ? jsonResponse(404, {}) : null);
		const outcome = await run.ok("jira_create_issue", { project: "ENG", issue_type: "Task", summary: "Crash" });
		expect(outcome.result).toEqual({ items: [], count: 0, outcome: "applied_without_result" });
		expect(jira.writes).toHaveLength(1);
	});

	test("transitions are picked by status or name", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		const run = await start(jira, { [ENG]: ["read", "transition"] });
		expect((await items(run, "jira_transition_issue", { issue: "ENG-1", status: "in progress" }))[0]?.status).toBe("In Progress");
		// Two transitions lead to Done; one is named Finish.
		expect(await run.error("jira_transition_issue", { issue: "ENG-1", status: "Done" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "No single transition of this issue leads to that status. Statuses it can move to: Done, In Progress.",
		});
		expect((await items(run, "jira_transition_issue", { issue: "ENG-1", status: "finish" }))[0]).toEqual({
			written: true,
			issue_id: "20001",
			issue_key: "ENG-1",
			status: "Done",
			link: "https://acme.atlassian.net/browse/ENG-1",
		});
		expect(jira.writes).toEqual([
			["issue/20001/transitions", { transition: { id: "11" } }],
			["issue/20001/transitions", { transition: { id: "21" } }],
		]);
		expect(await run.code("jira_transition_issue", { issue: "FIN-1", status: "Done" })).toBe("POLICY_DENIED");
	});

	test("written text may not name a site on its own domain", async () => {
		const jira = new FakeJira();
		jira.oneSite();
		(jira.resources[0] as JsonObject).url = "https://jira.acme.example";
		const run = await start(jira, { [ENG]: ["read", "comment", "create"] });
		for (const value of ["see https://JIRA.acme.example/browse/FIN-1", "jira%2Eacme%2Eexample/x"]) {
			expect(await run.error("jira_add_comment", { issue: "ENG-1", text: value }), value).toEqual({
				code: "INVALID_ARGUMENTS",
				message: "Text must not contain addresses of Atlassian sites: Atlassian may show them as previews.",
			});
		}
		expect(await run.code("jira_create_issue", { project: "ENG", issue_type: "Task", summary: "x", description: "jira.acme.example" })).toBe("INVALID_ARGUMENTS");
		expect(jira.writes).toEqual([]);
	});

	test("issue types page by what Jira returned", async () => {
		const jira = new FakeJira();
		jira.types = Array.from({ length: 7 }, (_, n) => ({ id: String(n + 1), name: `Type ${n + 1}`, subtask: false }));
		jira.pageSize = 3;
		const types = await jira.client().issueTypes(ACME, "10000");
		expect(types.map((type) => type.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
		expect(jira.reads("/issuetypes").map((request) => request.params.startAt)).toEqual(["0", "3", "6"]);
	});
});
