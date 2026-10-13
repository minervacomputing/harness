// The JSON API over the Worker, D1 and the Workspace Durable Object: membership, agents, connectors,
// connections and access. Provider calls go to fakes through `PROVIDER_NETWORK`
// (src/api/providers.ts).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test } from "vitest";
import { type WorkspaceRow, ensureInitialized, workspaceOwner } from "../../src/accounts/provision.ts";
import { workspaceObject } from "../../src/addressing.ts";
import { PROVIDER_NETWORK } from "../../src/api/providers.ts";
import { STILL_STOPPING, afterRevocation } from "../../src/api/members.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type Caller, REFUSALS, type RefusalCode, type Role } from "../../src/shared/rpc.ts";
import { type Answer, Browser, contractError, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

const defaultNetwork = PROVIDER_NETWORK.fetch;
afterEach(() => {
	PROVIDER_NETWORK.fetch = defaultNetwork;
});

interface Account {
	browser: Browser;
	userId: string;
	/** The personal workspace. */
	ws: string;
}

async function account(name = "ada"): Promise<Account> {
	const { browser, userId } = await signedIn(`${name}-${uuid7().slice(-12)}@example.com`);
	const me = await browser.call("GET", "/api/me");
	expect(me.status).toBe(200);
	return { browser, userId, ws: me.body.workspaces[0].id };
}

function object(ws: string) {
	return workspaceObject(env, { id: ws, jurisdiction: null });
}

function caller(a: Account, role: Role = "owner"): Caller {
	return { userId: a.userId, role };
}

/**
 * A Todoist connection of the account in a workspace, saved as the OAuth callback would save it: after the
 * member check has initialized the workspace's object (credentials are encrypted for the workspace it holds).
 */
async function todoistConnection(a: Account, ws = a.ws, account = { id: "u1", label: "Ada" }, role: Role = "owner"): Promise<string> {
	const row = await env.DB.prepare("SELECT id, kind, name, jurisdiction, created_at, initialized_at FROM workspaces WHERE id = ?").bind(ws).first<WorkspaceRow>();
	const owner = await workspaceOwner(env.DB, ws);
	if (row === null || owner === null) throw new Error(`No workspace ${ws} with an owner`);
	await ensureInitialized(env, row, owner);
	const saved = await object(ws).saveConnection(caller(a, role), {
		provider: "todoist",
		account,
		credentials: { kind: "oauth2", access_token: "test-token", refresh_token: null, scopes: null },
		connectionId: null,
	});
	if (!saved.ok) throw new Error(saved.refusal.detail);
	return saved.value.id;
}

/** A team workspace with these members; its object is initialized on first use. */
async function teamWorkspace(members: [Account, Role][]): Promise<string> {
	const now = Date.now();
	const organization = uuid7();
	const ws = uuid7();
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Team', ?, ?)`).bind(organization, organization, new Date(now).toISOString()),
		env.DB.prepare("INSERT INTO workspaces (id, organization_id, kind, name, created_at) VALUES (?, ?, 'team', 'Team', ?)").bind(ws, organization, now),
		...members.map(([member, role], index) =>
			env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(ws, member.userId, role, now + index),
		),
	]);
	return ws;
}

/** Fake Todoist API v1. */
class FakeTodoist {
	readonly projects = [
		{ id: "work", name: "Work" },
		{ id: "private", name: "Private" },
	];
	readonly calls: string[] = [];
	revoked = false;

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		if (url.hostname !== "api.todoist.com") throw new TypeError(`Unexpected host ${url.hostname}`);
		const path = url.pathname.replace(/^\/api\/v1/, "");
		this.calls.push(`${request.method} ${path}`);
		if (this.revoked) return Response.json({}, { status: 401 });
		if (request.method === "GET" && path === "/user") return Response.json({ id: "u1", full_name: "Ada" });
		if (request.method === "GET" && path === "/projects") return Response.json({ results: this.projects, next_cursor: null });
		return Response.json({}, { status: 404 });
	};

	install(): this {
		PROVIDER_NETWORK.fetch = () => this.fetch;
		return this;
	}
}

/** Fake Stripe: the account behind each restricted key. */
class FakeStripe {
	readonly accounts = new Map<string, { id: string; name: string }>();

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		if (url.hostname !== "api.stripe.com") throw new TypeError(`Unexpected host ${url.hostname}`);
		const key = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
		const found = this.accounts.get(key);
		if (!found) return Response.json({ error: { type: "invalid_request_error", message: "Invalid API Key provided" } }, { status: 401 });
		if (request.method === "GET" && url.pathname === "/v1/account") {
			return Response.json({ id: found.id, email: null, default_currency: "usd", business_profile: { name: found.name }, settings: null });
		}
		return Response.json({ error: { type: "invalid_request_error", message: "Unknown" } }, { status: 404 });
	};

	install(): this {
		PROVIDER_NETWORK.fetch = () => this.fetch;
		return this;
	}
}

function expectRefusal(answer: Answer, status: number, code: RefusalCode, detail: string): void {
	expect([answer.status, answer.body], JSON.stringify(answer.body)).toEqual([status, { code, detail }]);
}

/** A refusal of the contract's routes (the agents), or of the router. */
function expectDeclared(answer: Answer, code: RefusalCode, message: string): void {
	expect([answer.status, answer.body], JSON.stringify(answer.body)).toEqual([REFUSALS[code], contractError(code, message)]);
}

describe("membership", () => {
	test("another user's workspace is 401 on every route, before validation and the handler", async () => {
		const ada = await account();
		const grace = await account("grace");
		for (const path of ["connections", "connectors"]) {
			expectRefusal(await ada.browser.call("GET", `/api/workspaces/${grace.ws}/${path}`), 401, "UNAUTHORIZED", "Unauthorized");
		}
		expectDeclared(await ada.browser.call("GET", `/api/workspaces/${grace.ws}/agents`), "UNAUTHORIZED", "Unauthorized");
		// The body would be refused, but the workspace is checked first.
		expectDeclared(await ada.browser.call("POST", `/api/workspaces/${grace.ws}/agents`, { name: "" }), "UNAUTHORIZED", "Unauthorized");
		expectRefusal(await ada.browser.call("POST", `/api/workspaces/${grace.ws}/connections/web/enable`), 401, "UNAUTHORIZED", "Unauthorized");
		// A workspace that does not exist answers the same; a non-UUID one matches no route.
		expectDeclared(await ada.browser.call("GET", `/api/workspaces/${uuid7()}/agents`), "UNAUTHORIZED", "Unauthorized");
		expect((await ada.browser.call("GET", "/api/workspaces/not-a-uuid/agents")).status).toBe(404);
		expect((await ada.browser.call("GET", `/api/workspaces/${grace.ws.toUpperCase()}/agents`)).status).toBe(404);
	});

	test("without a session it is 401, and an unsafe request from another site is 403 first", async () => {
		const ada = await account();
		const anonymous = new Browser();
		expectDeclared(await anonymous.call("GET", `/api/workspaces/${ada.ws}/agents`), "UNAUTHORIZED", "Unauthorized");
		expectDeclared(await anonymous.call("POST", `/api/workspaces/${ada.ws}/agents`, { name: "A" }), "UNAUTHORIZED", "Unauthorized");
		expectDeclared(await anonymous.call("POST", `/api/workspaces/${ada.ws}/agents`, { name: "A" }, { Origin: "https://evil.example" }), "CROSS_SITE", "Cross-site request refused.");
		expectDeclared(await ada.browser.call("POST", `/api/workspaces/${ada.ws}/agents`, { name: "A" }, { Origin: "null" }), "CROSS_SITE", "Cross-site request refused.");
		expectDeclared(await ada.browser.call("DELETE", `/api/workspaces/${ada.ws}/agents/${uuid7()}`, undefined, { Origin: "https://evil.example" }), "CROSS_SITE", "Cross-site request refused.");
	});

	test("sign-up provisions one agent and the layers; each user sees only their own workspace's agents", async () => {
		const ada = await account();
		const grace = await account("grace");
		const mine = await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`);
		const theirs = await grace.browser.call("GET", `/api/workspaces/${grace.ws}/agents`);
		expect(mine.body).toEqual([
			{ id: expect.any(String), name: "Assistant", instructions: "You are a helpful, concise assistant.", connectionIds: [], canEdit: true, createdAt: expect.stringMatching(/Z$/) },
		]);
		expect(theirs.body).toHaveLength(1);
		expect(theirs.body[0].id).not.toBe(mine.body[0].id);
		await runInDurableObject(object(ada.ws), (_, state) => {
			const layers = state.storage.sql.exec<{ id: string; level: string; restricted: number }>("SELECT id, level, restricted FROM layers ORDER BY level").toArray();
			expect(layers).toEqual([
				{ id: "ceiling", level: "ceiling", restricted: 0 },
				{ id: `user:${ada.userId}`, level: "user", restricted: 1 },
			]);
			expect(state.storage.sql.exec<{ owner_id: string }>("SELECT owner_id FROM agents").toArray()).toEqual([{ owner_id: ada.userId }]);
		});
		// Another workspace's agent, addressed through one's own, does not exist there.
		const foreign = theirs.body[0].id;
		expect((await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents/${foreign}`)).status).toBe(404);
		expect((await ada.browser.call("PUT", `/api/workspaces/${ada.ws}/agents/${foreign}`, { name: "Hijacked" })).status).toBe(404);
		expect((await ada.browser.call("DELETE", `/api/workspaces/${ada.ws}/agents/${foreign}`)).status).toBe(404);
		expect((await grace.browser.call("GET", `/api/workspaces/${grace.ws}/agents/${foreign}`)).body.name).toBe("Assistant");
	});

	test("a workspace whose object was not initialized is initialized on first use", async () => {
		const ada = await account();
		await env.DB.prepare("UPDATE workspaces SET initialized_at = NULL WHERE id = ?").bind(ada.ws).run();
		expect((await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`)).body).toHaveLength(1);
		const row = await env.DB.prepare("SELECT initialized_at FROM workspaces WHERE id = ?").bind(ada.ws).first<{ initialized_at: number | null }>();
		expect(row?.initialized_at).not.toBeNull();
	});
});

describe("agents", () => {
	test("create, read, replace and delete; unknown fields are ignored and never echoed", async () => {
		const ada = await account();
		const url = `/api/workspaces/${ada.ws}/agents`;
		for (const codeMode of [true, false]) {
			const created = await ada.browser.call("POST", url, { name: "Scripted", instructions: "Be brief.", code_mode: codeMode });
			expect(created.status).toBe(201);
			expect(created.body).toEqual({ id: expect.any(String), name: "Scripted", instructions: "Be brief.", connectionIds: [], canEdit: true, createdAt: expect.any(String) });
		}
		const listed = (await ada.browser.call("GET", url)).body;
		expect(listed.map((agent: { name: string }) => agent.name)).toEqual(["Assistant", "Scripted", "Scripted"]);
		const id = listed[1].id;
		expect((await ada.browser.call("GET", `${url}/${id}`)).body.instructions).toBe("Be brief.");
		// A full replace: the omitted instructions go back to "".
		const replaced = await ada.browser.call("PUT", `${url}/${id}`, { name: "Renamed", code_mode: false });
		expect(replaced.status).toBe(200);
		expect(replaced.body).toMatchObject({ id, name: "Renamed", instructions: "" });
		expect(replaced.body).not.toHaveProperty("code_mode");
		expect((await ada.browser.call("DELETE", `${url}/${id}`)).status).toBe(204);
		expectDeclared(await ada.browser.call("GET", `${url}/${id}`), "NOT_FOUND", "Not found.");
		expectDeclared(await ada.browser.call("PUT", `${url}/${id}`, { name: "Gone" }), "NOT_FOUND", "Not found.");
		expectDeclared(await ada.browser.call("DELETE", `${url}/${id}`), "NOT_FOUND", "Not found.");
	});

	test("the last agent stays", async () => {
		const ada = await account();
		const url = `/api/workspaces/${ada.ws}/agents`;
		const [only] = (await ada.browser.call("GET", url)).body;
		expectDeclared(await ada.browser.call("DELETE", `${url}/${only.id}`), "KEEP_ONE_AGENT", "Keep at least one agent.");
	});

	test("bodies are validated after the membership check", async () => {
		const ada = await account();
		const url = `/api/workspaces/${ada.ws}/agents`;
		const invalid = (message: string, issues: { path: (string | number)[]; message: string; code: string }[]) => ({ ...contractError("VALIDATION_FAILED", message), data: { issues } });
		const long = await ada.browser.call("POST", url, { name: "x".repeat(121) });
		const tooBig = "Too big: expected string to have <=120 characters";
		expect([long.status, long.body]).toEqual([422, invalid(`name: ${tooBig}`, [{ path: ["name"], message: tooBig, code: "too_big" }])]);
		expect((await ada.browser.call("POST", url, {})).body.data.issues).toEqual([{ path: ["name"], message: "Invalid input: expected string, received undefined", code: "invalid_type" }]);
		expect((await ada.browser.call("POST", url, { name: "" })).body.data.issues[0].code).toBe("too_small");
		expect((await ada.browser.call("POST", url, { name: "A", connectionIds: ["nope"] })).body.data.issues).toEqual([{ path: ["connectionIds", 0], message: "Invalid UUID", code: "invalid_format" }]);
		const many = Array.from({ length: 21 }, () => uuid7());
		expect((await ada.browser.call("POST", url, { name: "A", connectionIds: many })).body.data.issues[0].code).toBe("too_big");
		// An empty body is no fields at all; one that is not JSON is 400.
		expect((await ada.browser.call("POST", url, "")).body.data.issues[0].path).toEqual(["name"]);
		expectDeclared(await ada.browser.call("POST", url, "{nope"), "INVALID_JSON", "The body is not valid JSON.");
	});

	test("added connections must be the caller's and usable; ones the agent has may stay", async () => {
		const ada = await account();
		const grace = await account("grace");
		const url = `/api/workspaces/${ada.ws}/agents`;
		// An agent can only use connections of its user: not another workspace's.
		const foreign = await todoistConnection(grace);
		expectDeclared(await ada.browser.call("POST", url, { name: "Sneaky", connectionIds: [foreign] }), "CHOOSE_CONNECTIONS", "Choose connections you can use.");
		// An id in another spelling of the UUID is the same connection.
		const mine = await todoistConnection(ada);
		const created = await ada.browser.call("POST", url, { name: "Helper", connectionIds: [mine.toUpperCase(), mine.replaceAll("-", "")] });
		expect(created.status).toBe(201);
		expect(created.body.connectionIds).toEqual([mine]);
		// An agent keeps a connection that needs reconnecting.
		await object(ada.ws).markUnauthorized(mine, 1);
		const agent = `${url}/${created.body.id}`;
		expect((await ada.browser.call("PUT", agent, { name: "Renamed", connectionIds: [mine] })).status).toBe(200);
		expect((await ada.browser.call("PUT", agent, { name: "Renamed", connectionIds: [] })).status).toBe(200);
		expectDeclared(await ada.browser.call("PUT", agent, { name: "Renamed", connectionIds: [mine] }), "CHOOSE_CONNECTIONS", "Choose connections you can use.");
	});

	test("changing an agent's connections stops its active runs; a rename does not", async () => {
		const ada = await account();
		const connection = await todoistConnection(ada);
		const ws = object(ada.ws);
		const [assistant] = (await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`)).body;
		const url = `/api/workspaces/${ada.ws}/agents/${assistant.id}`;
		expect((await ada.browser.call("PUT", url, { name: "Assistant", connectionIds: [connection] })).status).toBe(200);
		const conversation = await ws.createConversation(caller(ada), assistant.id);
		if (!conversation.ok) throw new Error(conversation.refusal.detail);
		const runId = uuid7();
		const begun = await ws.beginRun({ runId, conversationId: conversation.value.id, userId: ada.userId, agentId: assistant.id, uploadIds: [], folder: { bytes: 0, entries: 0 } });
		expect(begun.ok).toBe(true);
		expect(await ws.activate(runId)).toEqual({ state: "active" });
		expect((await ada.browser.call("PUT", url, { name: "Renamed", connectionIds: [connection] })).status).toBe(200);
		expect(await ws.activate(runId)).toEqual({ state: "active" });
		expect((await ada.browser.call("PUT", url, { name: "Renamed", connectionIds: [] })).status).toBe(200);
		expect(await ws.activate(runId)).toEqual({ state: "revoked", reason: "agent_connections_changed" });
	});

	test("only the agent's owner, or a workspace owner or admin, may change it", async () => {
		const ada = await account();
		const grace = await account("grace");
		const alan = await account("alan");
		const team = await teamWorkspace([
			[ada, "owner"],
			[grace, "member"],
			[alan, "admin"],
		]);
		const url = `/api/workspaces/${team}/agents`;
		const [assistant] = (await ada.browser.call("GET", url)).body;
		// Every member sees the workspace's agents; canEdit says who may change them.
		expect((await grace.browser.call("GET", url)).body).toEqual([{ ...assistant, canEdit: false }]);
		expect((await alan.browser.call("GET", url)).body).toEqual([{ ...assistant, canEdit: true }]);
		expectDeclared(await grace.browser.call("PUT", `${url}/${assistant.id}`, { name: "Mine" }), "CANNOT_CHANGE_AGENT", "You cannot change this agent.");
		expectDeclared(await grace.browser.call("DELETE", `${url}/${assistant.id}`), "CANNOT_CHANGE_AGENT", "You cannot change this agent.");
		expect((await alan.browser.call("PUT", `${url}/${assistant.id}`, { name: "Admin's" })).status).toBe(200);
		const own = await grace.browser.call("POST", url, { name: "Grace's" });
		expect(own.body.canEdit).toBe(true);
		expect((await grace.browser.call("PUT", `${url}/${own.body.id}`, { name: "Still Grace's" })).status).toBe(200);
		expect((await ada.browser.call("GET", `${url}/${own.body.id}`)).body.canEdit).toBe(true);
		expect((await grace.browser.call("DELETE", `${url}/${own.body.id}`)).status).toBe(204);
	});
});

describe("connectors and connections", () => {
	test("connectors this instance can connect, in order", async () => {
		const ada = await account();
		const listed = (await ada.browser.call("GET", `/api/workspaces/${ada.ws}/connectors`)).body;
		// OAuth connectors need a configured client or dynamic registration (Todoist); the test build configures
		// only its fake provider's (Notes).
		expect(listed.map((connector: { slug: string }) => connector.slug)).toEqual(["todoist", "stripe", "web", "notes"]);
		const [todoist, stripe, web] = listed;
		expect(todoist).toMatchObject({ auth: "oauth2", key_label: null, key_hint: null });
		expect(todoist.kinds).toEqual([{ id: "project", label: "Project", actions: ["read", "create"], wildcard: true, hierarchical: false, note: null, listed: true, browsable: false }]);
		expect(stripe).toMatchObject({ auth: "api_key", key_label: "Restricted API key", key_hint: expect.stringContaining("rk_test_") });
		expect(web.auth).toBe("builtin");
	});

	test("the Web is added once per user and has no account to reconnect", async () => {
		const ada = await account();
		const grace = await account("grace");
		const base = `/api/workspaces/${ada.ws}/connections`;
		const first = await ada.browser.call("POST", `${base}/web/enable`);
		const again = await ada.browser.call("POST", `${base}/web/enable`);
		expect([first.status, again.status]).toEqual([200, 200]);
		expect(again.body.id).toBe(first.body.id);
		expect(first.body).toMatchObject({ provider: "web", provider_name: "Web", auth: "builtin", status: "active", personal: true, allowed: [], consent_needed: [] });
		expectRefusal(await ada.browser.call("POST", `${base}/todoist/enable`), 422, "WRONG_CONNECTION_METHOD", "Todoist is connected through its own sign-in.");
		expectRefusal(await ada.browser.call("POST", `${base}/nope/enable`), 404, "UNKNOWN_PROVIDER", "Unknown provider.");
		expectRefusal(await ada.browser.call("POST", `${base}/${first.body.id}/reconnect`, { actions: [] }), 422, "WRONG_CONNECTION_METHOD", "Web has no account to reconnect.");
		const theirs = await grace.browser.call("POST", `/api/workspaces/${grace.ws}/connections/web/enable`);
		expect(theirs.body.id).not.toBe(first.body.id);
		expect((await ada.browser.call("GET", base)).body.map((c: { id: string }) => c.id)).toEqual([first.body.id]);
	});

	test("sites are found by address and allowed per domain", async () => {
		const ada = await account();
		const connection = (await ada.browser.call("POST", `/api/workspaces/${ada.ws}/connections/web/enable`)).body;
		const url = `/api/workspaces/${ada.ws}/connections/${connection.id}/access`;
		const kinds = Object.fromEntries((await ada.browser.call("GET", url)).body.kinds.map((kind: { id: string }) => [kind.id, kind]));
		expect(kinds.site.listed).toBe(false);
		expect(kinds.site.note).toBeTruthy();
		expect((await ada.browser.call("GET", `${url}/resources?kind=site`)).body.items).toEqual([]);
		const found = (await ada.browser.call("GET", `${url}/resources?kind=site&q=https://Docs.Python.org/3/`)).body.items;
		expect(found.map((item: { id: string; name: string }) => [item.id, item.name])).toEqual([
			["docs.python.org", "docs.python.org"],
			["*.docs.python.org", "docs.python.org, including subdomains"],
			["*.python.org", "python.org, including subdomains"],
		]);
		const change = (id: string, kind = "site", actions = ["read"]) => ada.browser.call("PATCH", url, { changes: [{ kind, id, actions }] });
		expect((await change("*.python.org")).status).toBe(200);
		for (const refused of ["*.org", "*.github.io", "localhost", "10.0.0.1", "Python.org", "*.*.python.org"]) expect((await change(refused)).status, refused).toBe(422);
		expect((await change("*.python.org", "site", ["search"])).status).toBe(422);
		expect((await change(connection.id, "account", ["search"])).status).toBe(200);
		const grants = (await ada.browser.call("GET", url)).body.grants.map((grant: { kind: string; id: string; actions: string[] }) => [grant.kind, grant.id, grant.actions]);
		expect(grants).toEqual(
			expect.arrayContaining([
				["site", "*.python.org", ["read"]],
				["account", connection.id, ["search"]],
			]),
		);
		expect(grants).toHaveLength(2);
		// The account kind lists the connection itself, without the provider.
		expect((await ada.browser.call("GET", `${url}/resources?kind=account`)).body).toEqual({
			items: [{ id: connection.id, name: "Web", actions: ["search"], inherited: [], expandable: false }],
			next_cursor: null,
		});
	});

	test("access settings are validated", async () => {
		const ada = await account();
		const todoist = new FakeTodoist().install();
		const connection = await todoistConnection(ada);
		const url = `/api/workspaces/${ada.ws}/connections/${connection}/access`;
		const access = (await ada.browser.call("GET", url)).body;
		expect(access.grants).toEqual([]);
		expect(access.kinds).toEqual([{ id: "project", label: "Project", actions: ["read", "create"], wildcard: true, hierarchical: false, note: null, listed: true, browsable: false }]);
		expect(access.connection).toMatchObject({ id: connection, provider: "todoist", provider_name: "Todoist", label: "Ada", personal: true });
		expect(todoist.calls).toEqual([]);
		const resources = (await ada.browser.call("GET", `${url}/resources?kind=project`)).body;
		expect(resources.items[0]).toEqual({ id: "work", name: "Work", actions: [], inherited: [], expandable: false });
		expect(resources.next_cursor).toBeNull();
		// Projects do not nest, so there is nothing to browse into.
		expectRefusal(await ada.browser.call("GET", `${url}/resources?kind=project&parent=work`), 422, "CANNOT_BROWSE", "Only resources that nest can be browsed, and not while searching.");
		expectRefusal(await ada.browser.call("GET", `${url}/resources?kind=task`), 422, "UNKNOWN_RESOURCE_KIND", 'Todoist has no resources of type "task".');
		expect((await ada.browser.call("GET", `${url}/resources`)).body.detail).toEqual([{ type: "invalid_type", loc: ["query", "kind"], msg: "Invalid input: expected string, received undefined" }]);
		expect((await ada.browser.call("GET", `${url}/resources?kind=project&q=${"q".repeat(101)}`)).body.detail[0].type).toBe("too_big");
		const bad = [
			[{ kind: "project", id: "work", actions: ["create"] }],
			[{ kind: "project", id: "elsewhere", actions: ["read"] }],
			[{ kind: "project", id: "work", actions: ["delete"] }],
			[{ kind: "task", id: "work", actions: ["read"] }],
			[
				{ kind: "project", id: "work", actions: ["read"] },
				{ kind: "project", id: "work", actions: [] },
			],
		];
		const answers = [];
		for (const changes of bad) answers.push(await ada.browser.call("PATCH", url, { changes }));
		expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422, 422, 422]);
		expect(answers.map((answer) => answer.body.detail)).toEqual([
			"Create tasks on Work also requires Read tasks.",
			"Choose a project that the connected account can see.",
			'Todoist does not support "delete" on project.',
			'Todoist has no resources of type "task".',
			"Each resource can only be listed once.",
		]);
		expect((await ada.browser.call("PATCH", url, { changes: [] })).body.detail[0].type).toBe("too_small");
		const saved = await ada.browser.call("PATCH", url, { changes: [{ kind: "project", id: "work", actions: ["read", "create"] }] });
		expect(saved.status).toBe(200);
		expect(saved.body.grants).toEqual([{ kind: "project", id: "work", name: "Work", actions: ["create", "read"] }]);
		expect((await ada.browser.call("GET", `${url}/resources?kind=project`)).body.items[0].actions).toEqual(["create", "read"]);
	});

	test("connections summarize what the user allows", async () => {
		const ada = await account();
		new FakeTodoist().install();
		const connection = await todoistConnection(ada);
		const url = `/api/workspaces/${ada.ws}/connections`;
		expect((await ada.browser.call("GET", url)).body[0].allowed).toEqual([]);
		const changes = [
			{ kind: "project", id: "*", actions: ["read"] },
			{ kind: "project", id: "work", actions: ["read", "create"] },
		];
		expect((await ada.browser.call("PATCH", `${url}/${connection}/access`, { changes })).status).toBe(200);
		expect((await ada.browser.call("GET", url)).body[0].allowed).toEqual([
			{ kind: "project", kind_label: "Project", action: "read", action_label: "Read tasks", all: true, count: 1, names: ["Work"] },
			{ kind: "project", kind_label: "Project", action: "create", action_label: "Create tasks", all: false, count: 1, names: ["Work"] },
		]);
		const resources = (await ada.browser.call("GET", `${url}/${connection}/access/resources?kind=project`)).body.items;
		expect(resources.map((item: { id: string; actions: string[]; inherited: string[] }) => [item.id, item.actions, item.inherited])).toEqual([
			["work", ["create", "read"], ["read"]],
			["private", [], ["read"]],
		]);
	});

	test("a grant change stops the caller's runs; a provider that refuses the token marks the connection", async () => {
		const ada = await account();
		const todoist = new FakeTodoist().install();
		const connection = await todoistConnection(ada);
		const ws = object(ada.ws);
		const [assistant] = (await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`)).body;
		const conversation = await ws.createConversation(caller(ada), assistant.id);
		if (!conversation.ok) throw new Error(conversation.refusal.detail);
		const runId = uuid7();
		await ws.beginRun({ runId, conversationId: conversation.value.id, userId: ada.userId, agentId: assistant.id, uploadIds: [], folder: { bytes: 0, entries: 0 } });
		const url = `/api/workspaces/${ada.ws}/connections/${connection}/access`;
		expect((await ada.browser.call("PATCH", url, { changes: [{ kind: "project", id: "*", actions: ["read"] }] })).status).toBe(200);
		expect(await ws.activate(runId)).toEqual({ state: "revoked", reason: "permissions_changed" });
		todoist.revoked = true;
		const refusedToken = await ada.browser.call("GET", `${url}/resources?kind=project`);
		expect([refusedToken.status, refusedToken.body.code]).toEqual([502, "RECONNECT_NEEDED"]);
		expect((await ada.browser.call("GET", `/api/workspaces/${ada.ws}/connections`)).body[0].status).toBe("error");
		// No credential is lent for a connection that needs reconnecting: 502 with the reason, no provider call.
		const calls = todoist.calls.length;
		expectRefusal(await ada.browser.call("GET", `${url}/resources?kind=project`), 502, "RECONNECT_NEEDED", "The connection expired. Reconnect it in Minerva.");
		expect(todoist.calls).toHaveLength(calls);
		// Removing a grant never needs the provider.
		expect((await ada.browser.call("PATCH", url, { changes: [{ kind: "project", id: "*", actions: [] }] })).status).toBe(200);
	});

	test("API keys are checked with the provider, never returned, and renewed only for the same account", async () => {
		const ada = await account();
		const grace = await account("grace");
		const stripe = new FakeStripe().install();
		const key = `rk_test_${"a".repeat(24)}`;
		const other = `rk_test_${"b".repeat(24)}`;
		stripe.accounts.set(key, { id: "acct_1", name: "Acme" });
		stripe.accounts.set(other, { id: "acct_2", name: "Other" });
		const base = `/api/workspaces/${ada.ws}/connections`;
		const created = await ada.browser.call("POST", `${base}/stripe/key`, { key });
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		expect(created.body).toMatchObject({ provider: "stripe", auth: "api_key", label: "Acme (test mode)", status: "active", personal: true });
		expect(JSON.stringify(created.body)).not.toContain(key);
		// The same account again updates the connection in place.
		expect((await ada.browser.call("POST", `${base}/stripe/key`, { key })).body.id).toBe(created.body.id);
		expectRefusal(await ada.browser.call("PUT", `${base}/${created.body.id}/key`, { key: other }), 422, "DIFFERENT_ACCOUNT", "This key is for a different Stripe account. Use a key for Acme (test mode).");
		expect((await ada.browser.call("PUT", `${base}/${created.body.id}/key`, { key })).status).toBe(200);
		expectRefusal(await ada.browser.call("POST", `${base}/stripe/key`, { key: "sk_live_secret" }), 422, "KEY_REFUSED", "Use a restricted key from Stripe, which starts with rk_live_ or rk_test_. Secret keys are not accepted.");
		expectRefusal(await ada.browser.call("POST", `${base}/stripe/key`, { key: `rk_test_${"c".repeat(24)}` }), 422, "KEY_REFUSED", "Stripe did not accept this key.");
		expectRefusal(await ada.browser.call("POST", `${base}/todoist/key`, { key }), 422, "WRONG_CONNECTION_METHOD", "This provider does not connect with a key.");
		expectRefusal(await ada.browser.call("POST", `${base}/nope/key`, { key }), 404, "UNKNOWN_PROVIDER", "Unknown provider.");
		expect((await ada.browser.call("POST", `${base}/stripe/key`, { key: "" })).body.detail[0]).toMatchObject({ type: "too_small", loc: ["body", "key"] });
		const todoist = await todoistConnection(ada);
		expectRefusal(await ada.browser.call("PUT", `${base}/${todoist}/key`, { key }), 422, "WRONG_CONNECTION_METHOD", "This provider does not connect with a key.");
		// Another user's connection is not found, the same as one that does not exist.
		const theirs = await todoistConnection(grace, ada.ws, { id: "u2", label: "Grace" }, "member");
		expectRefusal(await ada.browser.call("PUT", `${base}/${theirs}/key`, { key }), 404, "NOT_FOUND", "Not found.");
		expectRefusal(await ada.browser.call("PUT", `${base}/${uuid7()}/key`, { key }), 404, "NOT_FOUND", "Not found.");
	});

	test("another user's personal connection is not found; shared ones are changed only by admins", async () => {
		const ada = await account();
		const grace = await account("grace");
		const alan = await account("alan");
		const team = await teamWorkspace([
			[ada, "owner"],
			[grace, "member"],
			[alan, "admin"],
		]);
		new FakeTodoist().install();
		const personal = await todoistConnection(ada, team, { id: "u1", label: "Ada" });
		const shared = await todoistConnection(ada, team, { id: "s1", label: "Team" });
		await runInDurableObject(object(team), (_, state) => {
			state.storage.sql.exec("UPDATE connections SET owner_id = NULL WHERE id = ?", shared);
		});
		const base = `/api/workspaces/${team}/connections`;
		expect((await grace.browser.call("GET", base)).body.map((c: { id: string; personal: boolean }) => [c.id, c.personal])).toEqual([[shared, false]]);
		expect((await ada.browser.call("GET", base)).body.map((c: { id: string }) => c.id)).toEqual([personal, shared]);
		for (const [method, path] of [
			["GET", `${personal}/access`],
			["GET", `${personal}/access/resources?kind=project`],
			["PATCH", `${personal}/access`],
			["DELETE", personal],
			["POST", `${personal}/reconnect`],
		] as const) {
			const body = method === "PATCH" ? { changes: [{ kind: "project", id: "*", actions: ["read"] }] } : method === "POST" ? {} : undefined;
			expectRefusal(await grace.browser.call(method, `${base}/${path}`, body), 404, "NOT_FOUND", "Not found.");
		}
		expectRefusal(await grace.browser.call("DELETE", `${base}/${shared}`), 403, "WORKSPACE_ADMINS_ONLY", "Only workspace admins can remove shared connections.");
		expectRefusal(await grace.browser.call("POST", `${base}/${shared}/reconnect`, {}), 403, "WORKSPACE_ADMINS_ONLY", "Only workspace admins can reconnect shared connections.");
		expectRefusal(await grace.browser.call("PUT", `${base}/${shared}/key`, { key: "k" }), 403, "WORKSPACE_ADMINS_ONLY", "Only workspace admins can replace the key of shared connections.");
		// Members choose their own access on a shared connection.
		expect((await grace.browser.call("PATCH", `${base}/${shared}/access`, { changes: [{ kind: "project", id: "*", actions: ["read"] }] })).status).toBe(200);
		expect((await ada.browser.call("GET", `${base}/${shared}/access`)).body.grants).toEqual([]);
		// An admin may remove it; it leaves every agent.
		const [assistant] = (await ada.browser.call("GET", `/api/workspaces/${team}/agents`)).body;
		expect((await ada.browser.call("PUT", `/api/workspaces/${team}/agents/${assistant.id}`, { name: "A", connectionIds: [shared] })).status).toBe(200);
		expect((await alan.browser.call("DELETE", `${base}/${shared}`)).status).toBe(204);
		expect((await ada.browser.call("GET", `/api/workspaces/${team}/agents/${assistant.id}`)).body.connectionIds).toEqual([]);
		expectRefusal(await ada.browser.call("GET", `${base}/${shared}/access`), 404, "NOT_FOUND", "Not found.");
		expect((await ada.browser.call("DELETE", `${base}/${personal}`)).status).toBe(204);
	});

	test("starting an OAuth flow: unknown providers and actions first, then 503 when the provider cannot be reached", async () => {
		const ada = await account();
		const base = `/api/workspaces/${ada.ws}/connections`;
		expectRefusal(await ada.browser.call("POST", `${base}/nope/authorize`), 404, "UNKNOWN_PROVIDER", "Unknown provider.");
		expectRefusal(await ada.browser.call("POST", `${base}/stripe/authorize`), 422, "WRONG_CONNECTION_METHOD", "Stripe does not connect through OAuth.");
		await env.DB.prepare("DELETE FROM oauth_clients WHERE provider = 'todoist'").run();
		// The test build reaches only its fake provider, so Todoist's registration fails (test/platform/oauth.test.ts).
		expectRefusal(await ada.browser.call("POST", `${base}/todoist/authorize`), 503, "CONNECT_UNAVAILABLE", "Could not register Minerva with Todoist. Try again later.");
		const connection = await todoistConnection(ada);
		expectRefusal(await ada.browser.call("POST", `${base}/${connection}/reconnect`, { actions: ["delete"] }), 422, "UNKNOWN_ACTION", 'Todoist has no action "delete".');
		expect((await ada.browser.call("POST", `${base}/${connection}/reconnect`, { actions: Array(11).fill("read") })).body.detail[0].type).toBe("too_big");
		expectRefusal(await ada.browser.call("POST", `${base}/${connection}/reconnect`, { actions: ["create"] }), 503, "CONNECT_UNAVAILABLE", "Could not register Minerva with Todoist. Try again later.");
		expectRefusal(await ada.browser.call("POST", `${base}/${uuid7()}/reconnect`, {}), 404, "NOT_FOUND", "Not found.");
	});
});

test("a revocation not acknowledged in time answers 503; an acknowledged one answers the change", async () => {
	const pending = afterRevocation("pending", Response.json({ id: "a" }));
	expect([pending.status, await pending.json()]).toEqual([503, { code: "RUNS_STILL_STOPPING", detail: STILL_STOPPING }]);
	const acknowledged = afterRevocation("acknowledged", Response.json({ id: "a" }));
	expect([acknowledged.status, await acknowledged.json()]).toEqual([200, { id: "a" }]);
});
