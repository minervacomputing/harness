// The OAuth connection flow (web-api 9) against the test build's fake provider, Notes (src/faults/provider.ts),
// whose consent page `authorize` stands for: the authorization URL, the callback's checks in today's order,
// a flow used once (also by concurrent callbacks), PKCE, reconnects, Google's login hint, and Todoist's
// dynamic client registration against a fake (backend/tests: test_google_calendar.py's reconnect tests,
// test_contract.py's flow-client tests, test_github.py `test_apps_without_an_oauth_client_are_not_offered`).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspaceObject } from "../../src/addressing.ts";
import { EXPIRED_FLOW } from "../../src/api/flows.ts";
import { FLOW_CLIENTS } from "../../src/api/oauth-clients.ts";
import { PROVIDER_NETWORK } from "../../src/api/providers.ts";
import type { Role } from "../../src/contracts/common.ts";
import { providerOf } from "../../src/faults/ports.ts";
import { NOTES_ACCOUNT } from "../../src/faults/provider.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type Answer, Browser, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

let network = PROVIDER_NETWORK.fetch;
let clients = FLOW_CLIENTS.of;
beforeEach(() => {
	network = PROVIDER_NETWORK.fetch;
	clients = FLOW_CLIENTS.of;
});
afterEach(() => {
	PROVIDER_NETWORK.fetch = network;
	FLOW_CLIENTS.of = clients;
});

const SITE = "http://localhost";
const CALLBACK = `${SITE}/api/oauth/notes/callback`;
const OTHER_ACCOUNT = { id: "notes-account-2", name: "Other notes" };

interface Account {
	browser: Browser;
	userId: string;
	/** The personal workspace. */
	ws: string;
}

async function account(name = "ada"): Promise<Account> {
	const { browser, userId } = await signedIn(`${name}-${uuid7().slice(-12)}@example.com`);
	await browser.start();
	const me = await browser.call("GET", "/api/me");
	expect(me.status).toBe(200);
	return { browser, userId, ws: me.body.workspaces[0].id };
}

function object(ws: string) {
	return workspaceObject(env, { id: ws, jurisdiction: null });
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

function expectDetail(answer: Answer, status: number, detail: string): void {
	expect([answer.status, answer.body], JSON.stringify(answer.body)).toEqual([status, { detail }]);
}

/** The authorization URL the API answers for a new connection (`path` "notes/authorize") or a reconnect. */
async function start(a: Account, ws = a.ws, path = "notes/authorize", body: unknown = path.endsWith("/reconnect") ? {} : undefined): Promise<URL> {
	const answer = await a.browser.call("POST", `/api/workspaces/${ws}/connections/${path}`, body);
	expect(answer.status, JSON.stringify(answer.body)).toBe(200);
	return new URL(answer.body.url);
}

/** The user consents on Notes' page as `as`: the code and state Notes redirects back with. */
function consent(ws: string, url: URL, as = NOTES_ACCOUNT) {
	return providerOf(env, ws).authorize(url.href, as);
}

interface Landing {
	path: string;
	params: { [name: string]: string };
	location: string;
}

/** The provider's redirect reaching the callback: where the API sends the browser next. */
async function callback(browser: Browser, query: [string, string][], provider = "notes"): Promise<Landing> {
	// Not followed: the redirect goes to the frontend.
	const response = await browser.fetch(`/api/oauth/${provider}/callback?${new URLSearchParams(query)}`, { redirect: "manual" });
	expect(response.status, await response.text()).toBe(302);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const location = response.headers.get("Location")!;
	const url = new URL(location);
	expect(url.origin).toBe(SITE);
	return { path: url.pathname, params: Object.fromEntries(url.searchParams), location };
}

/** Authorizes, consents and comes back: a whole flow. */
async function connect(a: Account, ws = a.ws, as = NOTES_ACCOUNT, path = "notes/authorize"): Promise<Landing> {
	const { code, state } = await consent(ws, await start(a, ws, path), as);
	return callback(a.browser, [
		["state", state!],
		["code", code],
	]);
}

async function connections(a: Account, ws = a.ws): Promise<{ id: string; provider: string; label: string; personal: boolean }[]> {
	return (await a.browser.call("GET", `/api/workspaces/${ws}/connections`)).body;
}

async function flowsOf(ws: string): Promise<number> {
	return (await env.DB.prepare("SELECT count(*) AS n FROM oauth_flows WHERE workspace_id = ?").bind(ws).first<{ n: number }>())!.n;
}

const expired = { path: "/", params: { error: EXPIRED_FLOW } };

describe("connecting an account (web-api 9)", () => {
	test("the authorization URL, the callback and the connection it saves", async () => {
		const ada = await account();
		const url = await start(ada);
		expect(`${url.origin}${url.pathname}`).toBe("https://notes.fake.invalid/authorize");
		expect([...url.searchParams.keys()]).toEqual(["client_id", "state", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method"]);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "notes-client", response_type: "code", redirect_uri: CALLBACK, scope: "notes", code_challenge_method: "S256" });
		expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
		expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
		expect(await flowsOf(ada.ws)).toBe(1);

		const landing = await connect(ada, ada.ws, NOTES_ACCOUNT, "notes/authorize");
		expect(landing.path).toBe(`/w/${ada.ws}/connections`);
		const listed = await connections(ada);
		expect(listed).toHaveLength(1);
		expect(landing.params).toEqual({ connected: listed[0]!.id });
		expect(listed[0]).toMatchObject({ provider: "notes", label: "Notes account", personal: true });
		expect(await flowsOf(ada.ws)).toBe(0);
		// The code was redeemed once, and the account read with the tokens it gave.
		const requests = (await providerOf(env, ada.ws).state()).requests.map((r) => `${r.method} ${r.path} ${r.status}`);
		expect(requests).toEqual(["POST /token 200", "GET /me 200"]);
	});

	test("a callback with no flow of this session, or another state or provider, is expired and leaves the flow; a used flow is gone", async () => {
		const ada = await account();
		const grace = await account("grace");
		// Ada's state and code in Grace's browser: Grace started nothing, and Ada's flow is untouched.
		const { code, state } = await consent(ada.ws, await start(ada));
		const query: [string, string][] = [
			["state", state!],
			["code", code],
		];
		expect(await callback(grace.browser, query)).toMatchObject(expired);
		expect(await flowsOf(ada.ws)).toBe(1);
		// The right session with the wrong provider, or no state, an empty one, another one: a forged or stale
		// callback does not cancel the attempt.
		expect(await callback(ada.browser, query, "todoist")).toMatchObject(expired);
		for (const states of [[], [["state", ""]], [["state", `${state}x`]], [["state", state!.slice(0, -1)]]] as [string, string][][]) {
			expect(await callback(ada.browser, [...states, ["code", code]])).toMatchObject(expired);
		}
		expect(await flowsOf(ada.ws)).toBe(1);
		expect((await providerOf(env, ada.ws).state()).requests).toEqual([]);
		// The real callback connects, once: replayed, its flow is gone.
		expect((await callback(ada.browser, query)).params.connected).toBeDefined();
		expect(await flowsOf(ada.ws)).toBe(0);
		expect(await callback(ada.browser, query)).toMatchObject(expired);
		expect(await connections(ada)).toHaveLength(1);
	});

	test("an authorization in another workspace replaces the session's flow; the earlier state is expired", async () => {
		const ada = await account();
		const team = await teamWorkspace([[ada, "owner"]]);
		const first = await consent(ada.ws, await start(ada));
		const second = await consent(team, await start(ada, team));
		expect(await callback(ada.browser, [["state", first.state!], ["code", first.code]])).toMatchObject(expired);
		const landing = await callback(ada.browser, [["state", second.state!], ["code", second.code]]);
		expect(landing.path).toBe(`/w/${team}/connections`);
		expect(await connections(ada)).toEqual([]);
		expect((await connections(ada, team)).map((c) => c.id)).toEqual([landing.params.connected]);
	});

	test("a flow older than ten minutes is expired", async () => {
		const ada = await account();
		const { code, state } = await consent(ada.ws, await start(ada));
		await env.DB.prepare("UPDATE oauth_flows SET issued_at = issued_at - 600001, expires_at = expires_at - 600001 WHERE workspace_id = ?").bind(ada.ws).run();
		expect(await callback(ada.browser, [["state", state!], ["code", code]])).toMatchObject(expired);
		expect(await flowsOf(ada.ws)).toBe(0);
		expect((await providerOf(env, ada.ws).state()).requests).toEqual([]);
	});

	test("a refused consent or a missing code is 'was not connected', in the connections page", async () => {
		const ada = await account();
		const { state } = await consent(ada.ws, await start(ada));
		const refused = await callback(ada.browser, [["error", "access_denied"], ["state", state!]]);
		expect(refused.location).toBe(`${SITE}/w/${ada.ws}/connections?error=Notes+was+not+connected.`);
		const again = await consent(ada.ws, await start(ada));
		expect((await callback(ada.browser, [["state", again.state!]])).params).toEqual({ error: "Notes was not connected." });
		expect(await connections(ada)).toEqual([]);
	});

	test("PKCE: a code issued for another challenge is refused at the token endpoint", async () => {
		const ada = await account();
		const url = await start(ada);
		// An attacker's code, issued for a request the attacker made (a challenge of their own verifier).
		url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
		const { code, state } = await consent(ada.ws, url);
		const landing = await callback(ada.browser, [["state", state!], ["code", code]]);
		expect(landing.params).toEqual({ error: "Notes did not accept the authorization. Please try again." });
		expect((await providerOf(env, ada.ws).state()).requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(["POST /token 400"]);
		expect(await connections(ada)).toEqual([]);
	});

	test("of concurrent callbacks for one flow exactly one connects", async () => {
		const ada = await account();
		const { code, state } = await consent(ada.ws, await start(ada));
		const query: [string, string][] = [
			["state", state!],
			["code", code],
		];
		const landings = await Promise.all(Array.from({ length: 6 }, () => callback(ada.browser, query)));
		const connected = landings.filter((landing) => landing.params.connected !== undefined);
		expect(connected).toHaveLength(1);
		expect(landings.filter((landing) => landing.params.error === EXPIRED_FLOW)).toHaveLength(5);
		expect((await connections(ada)).map((c) => c.id)).toEqual([connected[0]!.params.connected]);
		expect((await providerOf(env, ada.ws).state()).requests.filter((r) => r.path === "/token")).toHaveLength(1);
	});

	test("signed out goes to sign-in; an unknown provider or a workspace left during the flow goes home", async () => {
		const ada = await account();
		const grace = await account("grace");
		expect(await callback(new Browser(), [["state", "s"], ["code", "c"]])).toEqual({ path: "/login", params: {}, location: `${SITE}/login` });
		const own = await consent(ada.ws, await start(ada));
		expect(await callback(ada.browser, [["state", own.state!], ["code", own.code]], "nope")).toMatchObject({ path: "/", params: {} });
		// The unknown provider left the flow in place.
		expect(await flowsOf(ada.ws)).toBe(1);

		const team = await teamWorkspace([
			[ada, "owner"],
			[grace, "member"],
		]);
		const flow = await consent(team, await start(grace, team));
		await env.DB.prepare("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").bind(team, grace.userId).run();
		expect(await callback(grace.browser, [["state", flow.state!], ["code", flow.code]])).toMatchObject({ path: "/", params: {} });
		expect(await connections(ada, team)).toEqual([]);
	});

	test("the callback answers GET only, after the CSRF check", async () => {
		const ada = await account();
		const path = "/api/oauth/notes/callback?state=s&code=c";
		expect((await ada.browser.call("POST", path, undefined, { "X-CSRFToken": "" })).status).toBe(403);
		const answer = await ada.browser.call("POST", path);
		expect([answer.status, answer.response.headers.get("Allow")]).toEqual([405, "GET"]);
	});
});

describe("reconnecting (backend/tests/test_google_calendar.py)", () => {
	test("the same account renews the connection; another account or a removed connection changes nothing", async () => {
		const ada = await account();
		const id = (await connect(ada)).params.connected!;
		const renewed = await connect(ada, ada.ws, NOTES_ACCOUNT, `${id}/reconnect`);
		expect(renewed.params).toEqual({ connected: id });
		expect((await connections(ada)).map((c) => c.id)).toEqual([id]);

		const other = await connect(ada, ada.ws, OTHER_ACCOUNT, `${id}/reconnect`);
		expect(other.params).toEqual({ error: "You signed in to a different Notes account. Sign in as Notes account." });
		expect((await connections(ada)).map((c) => [c.id, c.label])).toEqual([[id, "Notes account"]]);

		const url = await start(ada, ada.ws, `${id}/reconnect`);
		expect((await ada.browser.call("DELETE", `/api/workspaces/${ada.ws}/connections/${id}`)).status).toBe(204);
		const { code, state } = await consent(ada.ws, url);
		expect((await callback(ada.browser, [["state", state!], ["code", code]])).params).toEqual({ error: "This Notes connection was removed. Connect it again." });
		expect(await connections(ada)).toEqual([]);
	});

	test("a shared connection is renewed by admins only, checked again when the provider sends the user back", async () => {
		const ada = await account();
		const grace = await account("grace");
		const team = await teamWorkspace([
			[ada, "owner"],
			[grace, "admin"],
		]);
		const id = (await connect(ada, team)).params.connected!;
		await runInDurableObject(object(team), (_, state) => {
			state.storage.sql.exec("UPDATE connections SET owner_id = NULL WHERE id = ?", id);
		});
		const url = await start(grace, team, `${id}/reconnect`);
		await env.DB.prepare("UPDATE memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?").bind(team, grace.userId).run();
		const { code, state } = await consent(team, url);
		expect((await callback(grace.browser, [["state", state!], ["code", code]])).params).toEqual({ error: "Only workspace admins can reconnect shared connections." });
		expect((await providerOf(env, team).state()).requests.filter((r) => r.path === "/token")).toHaveLength(1);

		await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").bind(team, grace.userId).run();
		expect((await connect(grace, team, NOTES_ACCOUNT, `${id}/reconnect`)).params).toEqual({ connected: id });
		expect((await connections(ada, team)).map((c) => [c.id, c.personal])).toEqual([[id, false]]);
	});

	test("Google preselects the connection's account (login_hint) and keeps earlier grants", async () => {
		const ada = await account();
		FLOW_CLIENTS.of = (e) => {
			const base = clients(e);
			return { configured: (app) => (app === "google" ? { clientId: "google-client", clientSecret: "google-secret" } : base.configured(app)), stored: base.stored };
		};
		const saved = await object(ada.ws).saveConnection(
			{ userId: ada.userId, role: "owner" },
			{
				provider: "google_calendar",
				account: { id: "108", label: "primary@example.com" },
				credentials: { kind: "oauth2", access_token: "old", refresh_token: "r", scopes: null },
				connectionId: null,
			},
		);
		if (!saved.ok) throw new Error(saved.refusal.detail);
		const url = await start(ada, ada.ws, `${saved.value.id}/reconnect`, {});
		expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect([...url.searchParams.keys()]).toEqual([
			"access_type",
			"prompt",
			"include_granted_scopes",
			"client_id",
			"state",
			"response_type",
			"redirect_uri",
			"scope",
			"code_challenge",
			"code_challenge_method",
			"login_hint",
		]);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			include_granted_scopes: "true",
			client_id: "google-client",
			redirect_uri: `${SITE}/api/oauth/google_calendar/callback`,
			login_hint: "108",
		});
		// A new connection has no account to preselect.
		expect((await start(ada, ada.ws, "google_calendar/authorize")).searchParams.has("login_hint")).toBe(false);
	});
});

/** Todoist's registration endpoint and token endpoint (RFC 7591; backend/connections/oauth.py `_register_client`). */
class FakeTodoistAuth {
	readonly registrations: unknown[] = [];
	readonly tokenRequests: URLSearchParams[] = [];
	answer: () => Promise<Response> | Response = () => Response.json({ client_id: `registered-${this.registrations.length}`, client_secret: "registered-secret" }, { status: 201 });

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		if (request.method === "POST" && url.href === "https://api.todoist.com/oauth/register") {
			expect(request.headers.get("Content-Type")).toBe("application/json");
			this.registrations.push(await request.json());
			return this.answer();
		}
		if (request.method === "POST" && url.href === "https://api.todoist.com/oauth/access_token") {
			this.tokenRequests.push(new URLSearchParams(await request.text()));
			return Response.json({ access_token: "todoist-token", token_type: "Bearer" });
		}
		if (request.method === "GET" && url.href === "https://api.todoist.com/api/v1/user") return Response.json({ id: "u1", full_name: "Ada" });
		throw new TypeError(`Unexpected request ${request.method} ${url.href}`);
	};

	install(): this {
		PROVIDER_NETWORK.fetch = () => this.fetch;
		return this;
	}
}

async function storedTodoistClients(): Promise<{ client_id: string; secret_ciphertext: string }[]> {
	return (await env.DB.prepare("SELECT client_id, secret_ciphertext FROM oauth_clients WHERE provider = 'todoist'").all<{ client_id: string; secret_ciphertext: string }>()).results;
}

describe("Todoist registers Minerva dynamically (web-api 9.1)", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM oauth_clients WHERE provider = 'todoist'").run();
	});

	test("once, then its client is used for the authorization and the code exchange", async () => {
		const ada = await account();
		const todoist = new FakeTodoistAuth().install();
		const url = await start(ada, ada.ws, "todoist/authorize");
		expect(todoist.registrations).toEqual([
			{
				client_name: "Minerva",
				redirect_uris: [`${SITE}/api/oauth/todoist/callback`],
				scope: "data:read_write",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_post",
			},
		]);
		expect(url.searchParams.get("client_id")).toBe("registered-1");
		const stored = await storedTodoistClients();
		expect(stored.map((row) => row.client_id)).toEqual(["registered-1"]);
		expect(stored[0]!.secret_ciphertext).not.toContain("registered-secret");

		const again = await start(ada, ada.ws, "todoist/authorize");
		expect(todoist.registrations).toHaveLength(1);
		expect(again.searchParams.get("client_id")).toBe("registered-1");
		const landing = await callback(
			ada.browser,
			[
				["state", again.searchParams.get("state")!],
				["code", "todoist-code"],
			],
			"todoist",
		);
		expect(landing.path).toBe(`/w/${ada.ws}/connections`);
		expect((await connections(ada)).map((c) => [c.id, c.provider, c.label])).toEqual([[landing.params.connected, "todoist", "Ada"]]);
		const sent = Object.fromEntries(todoist.tokenRequests[0]!);
		expect(sent).toMatchObject({ client_id: "registered-1", client_secret: "registered-secret", code: "todoist-code", grant_type: "authorization_code" });
		expect(sent.code_verifier).toMatch(/^[\w-]{43}$/);
	});

	test("concurrent first authorizations keep one registered client", async () => {
		const ada = await account();
		const todoist = new FakeTodoistAuth().install();
		const answer = todoist.answer;
		todoist.answer = async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return answer();
		};
		const urls = await Promise.all(Array.from({ length: 4 }, () => start(ada, ada.ws, "todoist/authorize")));
		const stored = await storedTodoistClients();
		expect(stored).toHaveLength(1);
		expect(new Set(urls.map((url) => url.searchParams.get("client_id")))).toEqual(new Set([stored[0]!.client_id]));
	});

	test("a failed registration is 503 and stores nothing; an app with neither a client nor registration is not offered", async () => {
		const ada = await account();
		const todoist = new FakeTodoistAuth().install();
		const base = `/api/workspaces/${ada.ws}/connections`;
		for (const failure of [() => Response.json({ error: "nope" }, { status: 500 }), () => Response.json({ client_id: "x" }), () => new Response("not json"), () => Promise.reject(new TypeError("Network connection lost."))]) {
			todoist.answer = failure;
			expectDetail(await ada.browser.call("POST", `${base}/todoist/authorize`), 503, "Could not register Minerva with Todoist. Try again later.");
		}
		expect(await storedTodoistClients()).toEqual([]);
		expectDetail(await ada.browser.call("POST", `${base}/github/authorize`), 503, "GitHub is not configured on this instance.");
		const listed = (await ada.browser.call("GET", `/api/workspaces/${ada.ws}/connectors`)).body.map((connector: { slug: string }) => connector.slug);
		expect(listed).not.toContain("github");
		FLOW_CLIENTS.of = (e) => {
			const base = clients(e);
			return { configured: (app) => (app === "github" ? { clientId: "Iv1.x", clientSecret: "github-secret" } : base.configured(app)), stored: base.stored };
		};
		expect((await ada.browser.call("GET", `/api/workspaces/${ada.ws}/connectors`)).body.map((connector: { slug: string }) => connector.slug)).toContain("github");
	});
});
