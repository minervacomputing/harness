// The integration matrix of the contract's routes (api/orpc.ts): oRPC's OpenAPIHandler behind our router,
// our mount and our body reader. It must pass after every update of @orpc/*: each row is a place where
// oRPC's own behaviour (its body reader, its matching, its errors) would answer differently from ours.
// request-rules.test.ts has the content-type table, strict UTF-8 and CSRF; api.test.ts the agents' refusals;
// instance.test.ts the setup and the instance admin's rules.
//
// The rows that need a procedure of their own (an escaped key, a header) run a test-only contract through
// the same `contractHandler`, in process; the others go through the Worker.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ERRORS, REFUSALS, RUN_EVENT_TYPES, contract } from "@minerva/contract";
import { createORPCClient } from "@orpc/client";
import { type ContractRouterClient, oc, type } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ORPCError, implement } from "@orpc/server";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { conversationObject } from "../../src/addressing.ts";
import type { ApiContext } from "../../src/api/procedures.ts";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { MAX_JSON_BODY } from "../../src/http/body.ts";
import { contractHandler } from "../../src/internal/handler.ts";
import { PROVIDER_NETWORK } from "../../src/internal/providers.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";
import { type Answer, Browser, ORIGIN, SESSION_COOKIE, contractError, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

interface Account {
	browser: Browser;
	userId: string;
	ws: string;
}

async function account(name = "ada"): Promise<Account> {
	const { browser, userId } = await signedIn(`${name}-${uuid7().slice(-12)}@example.com`);
	return { browser, userId, ws: (await browser.call("GET", "/api/me")).body.workspaces[0].id };
}

/** The typed client over the Worker, as the frontend builds it, with a browser's cookies. */
function client(browser: Browser): JsonifiedClient<ContractRouterClient<typeof contract>> {
	return createORPCClient(new OpenAPILink(contract, { url: `${ORIGIN}/api`, fetch: (request, init) => browser.fetch(request, init) }));
}

const JSON_TYPE = { "Content-Type": "application/json", Origin: ORIGIN };
const UNAUTHORIZED = { status: 401, body: contractError("UNAUTHORIZED", "Unauthorized") };
const NO_ROUTE = { status: 404, body: contractError("NOT_FOUND", "Not found.") };

function answer({ status, body }: Answer): { status: number; body: unknown } {
	return { status, body };
}

/** Makes Better Auth extend the user's sessions on their next read (as if last extended over a day ago). */
async function dueForRefresh(userId: string): Promise<void> {
	await env.DB.prepare(`UPDATE session SET "expiresAt" = ? WHERE "userId" = ?`).bind(new Date(Date.now() + 86_400_000).toISOString(), userId).run();
}

/** 3 MB of JSON whitespace, streamed without a declared length. */
function overCap(): ReadableStream<Uint8Array> {
	const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent++ < 3) controller.enqueue(chunk);
			else controller.close();
		},
	});
}

function setsSession({ response }: Answer): boolean {
	return response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(cookie));
}

// A test-only contract, served by the Worker's handler factory with our reader and errors.
const testContract = {
	keys: oc
		.errors(ERRORS)
		.route({ method: "POST", path: "/test/keys" })
		.input(z.record(z.string(), z.number()))
		.output(type<string[]>()),
	stamped: oc
		.errors(ERRORS)
		.route({ method: "POST", path: "/test/stamped", inputStructure: "detailed" })
		.input(z.object({ headers: z.object({ "idempotency-key": z.string().min(1) }), body: z.object({ note: z.string() }) }))
		.output(type<{ key: string; note: string }>()),
	failing: oc
		.errors(ERRORS)
		.route({ method: "POST", path: "/test/failing" })
		.input(z.object({ how: z.enum(["crash", "undeclared", "foreign"]) }))
		.output(type<never>()),
};
const testApi = implement(testContract).$context<ApiContext>();
const testHandler = contractHandler<ApiContext>(
	testApi.router({
		keys: testApi.keys.handler(({ input }) => Object.keys(input)),
		stamped: testApi.stamped.handler(({ input }) => ({ key: input.headers["idempotency-key"], note: input.body.note })),
		failing: testApi.failing.handler(({ input }) => {
			if (input.how === "crash") throw new Error("a secret in a crash");
			// Codes and statuses of the error map, but not made by `refusal`: oRPC alone would mark them declared.
			if (input.how === "undeclared") throw new ORPCError("INTERNAL_SERVER_ERROR", { status: 500, message: "a secret", data: { secret: 1 } });
			throw new ORPCError("toString", { status: 500, message: "a secret" });
		}),
	}),
	{ codes: REFUSALS, maxBody: MAX_JSON_BODY },
);
const testClient: JsonifiedClient<ContractRouterClient<typeof testContract>> = createORPCClient(
	new OpenAPILink(testContract, {
		url: `${ORIGIN}/api`,
		fetch: async (request) => {
			const { matched, response } = await testHandler.handle(request, { prefix: "/api", context: { request, env, user: null, member: null, admin: false } });
			return matched ? response : new Response(null, { status: 404 });
		},
	}),
);

describe("the body reader", () => {
	test("an escaped key reads right after the runtime has seen a lone backslash as a key", async () => {
		// The runtime's JSON.parse, once it has read "\\" as a key, reads a later "\n" in the same place as "\\" (lib/json.ts).
		const shape = `probe${crypto.randomUUID().replaceAll("-", "")}`;
		JSON.parse(`{"${shape}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(`{"${shape}":0,"\\n":1}`))[1]).toBe("\\");
		const request = new Request(`${ORIGIN}/api/test/keys`, { method: "POST", headers: JSON_TYPE, body: `{"${shape}":0,"\\n":1}` });
		const raw = await testHandler.handle(request, { prefix: "/api", context: { request, env, user: null, member: null, admin: false } });
		expect(await raw.response?.json()).toEqual([shape, "\n"]);
		// Through the typed client, which writes the key with JSON.stringify.
		expect(await testClient.keys({ [shape]: 0, "\n": 1 })).toEqual([shape, "\n"]);
	});

	test("a body that breaks off is refused as unreadable, in the contract's shape", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"a":'));
				controller.error(new TypeError("connection lost"));
			},
		});
		const request = new Request(`${ORIGIN}/api/test/keys`, { method: "POST", headers: JSON_TYPE, body, duplex: "half" } as RequestInit);
		const { response } = await testHandler.handle(request, { prefix: "/api", context: { request, env, user: null, member: null, admin: false } });
		expect([response?.status, await response?.json()]).toEqual([400, contractError("INVALID_JSON", "The body is not valid JSON.")]);
	});

	test("a form body is 415, not read as input", async () => {
		const a = await account();
		const form = await a.browser.call("POST", `/api/workspaces/${a.ws}/agents`, "name=Form", { "Content-Type": "application/x-www-form-urlencoded" });
		expect(answer(form)).toEqual({ status: 415, body: contractError("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.") });
		// Only the workspace's first agent.
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/agents`)).body.map((agent: { name: string }) => agent.name)).toEqual(["Assistant"]);
	});

	test("a streamed body over 2.5 MB is 413 without a declared length", async () => {
		const a = await account();
		const response = await a.browser.fetch(`${ORIGIN}/api/workspaces/${a.ws}/agents`, { method: "POST", headers: JSON_TYPE, body: overCap(), duplex: "half" } as RequestInit);
		expect([response.status, await response.json()]).toEqual([413, contractError("PAYLOAD_TOO_LARGE", "The request is too large.")]);
	});
});

describe("the order of refusals", () => {
	test("a non-member's body that never ends is refused at once", async () => {
		const [ada, grace] = [await account(), await account("grace")];
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				pulled++;
				controller.enqueue(new TextEncoder().encode(" "));
				await new Promise((resolve) => setTimeout(resolve, 50));
			},
		});
		const response = await grace.browser.fetch(`${ORIGIN}/api/workspaces/${ada.ws}/agents`, { method: "POST", headers: JSON_TYPE, body, duplex: "half" } as RequestInit);
		expect([response.status, await response.json()]).toEqual([401, UNAUTHORIZED.body]);
		// The stream may be primed with a chunk or two; it is not read through.
		expect(pulled).toBeLessThan(3);
	});

	test("401 comes before 400, 413, 415 and 422, for a non-member and for no session", async () => {
		// A declared length over the cap is the router's 413, before anything (step 1 in api/orpc.ts); it reads nothing.
		const ada = await account();
		const grace = await account("grace");
		const agents = `/api/workspaces/${ada.ws}/agents`;
		const bodies: [string, string, Record<string, string>][] = [
			["unparseable", '{"name":', {}],
			["form", "name=Form", { "Content-Type": "application/x-www-form-urlencoded" }],
			["invalid", JSON.stringify({ name: "" }), {}],
			["valid", JSON.stringify({ name: "A" }), {}],
		];
		for (const browser of [grace.browser, new Browser()]) {
			for (const [name, body, headers] of bodies) {
				expect([name, answer(await browser.call("POST", agents, body, headers))]).toEqual([name, UNAUTHORIZED]);
			}
			expect(answer(await browser.call("PUT", `${agents}/not-an-id`, "{"))).toEqual(UNAUTHORIZED);
			const streamed = await browser.fetch(`${ORIGIN}${agents}`, { method: "POST", headers: JSON_TYPE, body: overCap(), duplex: "half" } as RequestInit);
			expect([streamed.status, await streamed.json()]).toEqual([401, UNAUTHORIZED.body]);
			expect(answer(await browser.call("POST", agents, " ".repeat(2_621_441)))).toEqual({ status: 413, body: contractError("PAYLOAD_TOO_LARGE", "The request is too large.") });
		}
	});
});

describe("session cookies", () => {
	test("a session Better Auth extends sends its cookie with a success, a refusal and a 401", async () => {
		const ada = await account();
		const grace = await account("grace");
		const agents = `/api/workspaces/${ada.ws}/agents`;
		await dueForRefresh(ada.userId);
		const listed = await ada.browser.call("GET", agents);
		expect([listed.status, setsSession(listed), listed.response.headers.get("Cache-Control")]).toEqual([200, true, "no-store"]);
		await dueForRefresh(ada.userId);
		const invalid = await ada.browser.call("POST", agents, { name: "" });
		expect([invalid.status, setsSession(invalid)]).toEqual([422, true]);
		await dueForRefresh(ada.userId);
		const missing = await ada.browser.call("GET", `${agents}/${uuid7()}`);
		expect([answer(missing), setsSession(missing)]).toEqual([{ status: 404, body: contractError("NOT_FOUND", "Not found.") }, true]);
		await dueForRefresh(ada.userId);
		const noRoute = await ada.browser.call("GET", `/api/workspaces/${ada.ws}/nothing-here`);
		expect([answer(noRoute), setsSession(noRoute)]).toEqual([NO_ROUTE, true]);
		await dueForRefresh(grace.userId);
		const outsider = await grace.browser.call("GET", agents);
		expect([answer(outsider), setsSession(outsider)]).toEqual([UNAUTHORIZED, true]);
	});

	test("a session that is gone is a 401 that clears its cookies", async () => {
		const ada = await account();
		await env.DB.prepare(`DELETE FROM session WHERE "userId" = ?`).bind(ada.userId).run();
		const gone = await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`);
		expect(answer(gone)).toEqual(UNAUTHORIZED);
		expect(gone.response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0/.test(cookie))).toBe(true);
	});
});

describe("outside a workspace", () => {
	/** A body that never ends, and how much of it was pulled. */
	function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				pulled++;
				controller.enqueue(new TextEncoder().encode(" "));
				await new Promise((resolve) => setTimeout(resolve, 50));
			},
		});
		return { body, pulled: () => pulled };
	}

	const BAD_BODIES: [string, string, Record<string, string>][] = [
		["unparseable", '{"signupOpen":', {}],
		["form", "signupOpen=false", { "Content-Type": "application/x-www-form-urlencoded" }],
		["invalid", JSON.stringify({ signupOpen: "no" }), {}],
	];
	const ADMINS_ONLY = { status: 403, body: contractError("INSTANCE_ADMINS_ONLY", "Only instance admins can do this.") };

	test("a visitor gets 401 before any body is read, on every route but the setup's status; no route is 404 for anyone", async () => {
		const visitor = new Browser();
		expect(answer(await visitor.call("GET", "/api/me"))).toEqual(UNAUTHORIZED);
		expect(answer(await visitor.call("GET", "/api/instance/admins"))).toEqual(UNAUTHORIZED);
		for (const [name, body, headers] of BAD_BODIES) {
			expect([name, answer(await visitor.call("PATCH", "/api/instance/settings", body, headers))]).toEqual([name, UNAUTHORIZED]);
			expect([name, answer(await visitor.call("POST", "/api/setup", body, { "X-Minerva-Setup-Key": "k", ...headers }))]).toEqual([name, UNAUTHORIZED]);
			expect([name, answer(await visitor.call("POST", "/api/me/password", body, headers))]).toEqual([name, UNAUTHORIZED]);
			expect([name, answer(await visitor.call("POST", "/api/instance/users/remove-two-factor", body, headers))]).toEqual([name, UNAUTHORIZED]);
		}
		const slow = endless();
		const response = await visitor.fetch(`${ORIGIN}/api/instance/admins`, { method: "POST", headers: JSON_TYPE, body: slow.body, duplex: "half" } as RequestInit);
		expect([response.status, await response.json(), slow.pulled() < 3]).toEqual([401, UNAUTHORIZED.body, true]);
		// The setup's status is the one public route, and says only that.
		const status = await visitor.call("GET", "/api/setup");
		expect([status.status, Object.keys(status.body)]).toEqual([200, ["needed"]]);
		expect((await visitor.fetch(`${ORIGIN}/api/setup`, { method: "HEAD" })).status).toBe(200);
		expect(answer(await visitor.call("GET", "/api/nothing-here"))).toEqual(NO_ROUTE);
		expect(answer(await visitor.call("POST", "/api/me", {}))).toEqual(NO_ROUTE);
	});

	test("a user who is not an instance admin is refused before the body under /api/instance; an admin's body is read", async () => {
		const grace = await account("grace");
		for (const [name, body, headers] of BAD_BODIES) {
			expect([name, answer(await grace.browser.call("PATCH", "/api/instance/settings", body, headers))]).toEqual([name, ADMINS_ONLY]);
			expect([name, answer(await grace.browser.call("POST", "/api/instance/users/remove-two-factor", body, headers))]).toEqual([name, ADMINS_ONLY]);
		}
		const slowRemoval = endless();
		const removal = await grace.browser.fetch(`${ORIGIN}/api/instance/users/remove-two-factor`, { method: "POST", headers: JSON_TYPE, body: slowRemoval.body, duplex: "half" } as RequestInit);
		expect([removal.status, await removal.json(), slowRemoval.pulled() < 3]).toEqual([403, ADMINS_ONLY.body, true]);
		const slow = endless();
		const response = await grace.browser.fetch(`${ORIGIN}/api/instance/admins`, { method: "POST", headers: JSON_TYPE, body: slow.body, duplex: "half" } as RequestInit);
		expect([response.status, await response.json(), slow.pulled() < 3]).toEqual([403, ADMINS_ONLY.body, true]);
		expect(answer(await grace.browser.call("GET", "/api/instance/nothing-here"))).toEqual(NO_ROUTE);

		await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).bind(grace.userId).run();
		try {
			const read = BAD_BODIES.map(async ([name, body, headers]) => [name, (await grace.browser.call("PATCH", "/api/instance/settings", body, headers)).body.code]);
			expect(await Promise.all(read)).toEqual([
				["unparseable", "INVALID_JSON"],
				["form", "UNSUPPORTED_MEDIA_TYPE"],
				["invalid", "VALIDATION_FAILED"],
			]);
		} finally {
			await env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE id = ?`).bind(grace.userId).run();
		}
	});

	test("a session Better Auth extends sends its cookie with every answer: success, public and refusals; a gone one is cleared", async () => {
		const ada = await account();
		const calls: [string, string, number][] = [
			["GET", "/api/me", 200],
			["GET", "/api/setup", 200],
			["GET", "/api/instance/settings", 403],
		];
		for (const [method, path, status] of calls) {
			await dueForRefresh(ada.userId);
			const answered = await ada.browser.call(method, path);
			expect([path, answered.status, setsSession(answered), answered.response.headers.get("Cache-Control")]).toEqual([path, status, true, "no-store"]);
		}
		await dueForRefresh(ada.userId);
		const claimed = await ada.browser.call("POST", "/api/setup", undefined, { "X-Minerva-Setup-Key": "not the key" });
		expect([claimed.body.code, setsSession(claimed)]).toEqual(["INVALID_SETUP_KEY", true]);
		await env.DB.prepare(`DELETE FROM session WHERE "userId" = ?`).bind(ada.userId).run();
		const gone = await ada.browser.call("GET", "/api/me");
		expect(answer(gone)).toEqual(UNAUTHORIZED);
		expect(gone.response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0/.test(cookie))).toBe(true);
	});

	test("the typed client reads who is signed in, is told a password is set, and carries the setup key in its header", async () => {
		const ada = await account();
		const api = client(ada.browser);
		expect(await api.me()).toMatchObject({ user: { id: ada.userId, role: "user" }, workspaces: [{ id: ada.ws, kind: "personal", role: "owner" }] });
		expect(await api.password.set({ password: "a long enough passphrase" }).catch((error: unknown) => error)).toMatchObject({ defined: true, code: "PASSWORD_ALREADY_SET", status: 409 });
		const wrong = await api.setup.claim({ headers: { "x-minerva-setup-key": "not the key" } }).catch((error: unknown) => error);
		expect(wrong).toMatchObject({ defined: true, code: "INVALID_SETUP_KEY", status: 403 });
		const empty = await api.setup.claim({ headers: { "x-minerva-setup-key": "" } }).catch((error: unknown) => error);
		expect(empty).toMatchObject({ defined: true, code: "VALIDATION_FAILED", data: { issues: [{ path: ["headers", "x-minerva-setup-key"] }] } });
		expect(await client(new Browser()).me().catch((error: unknown) => error)).toMatchObject({ defined: true, code: "UNAUTHORIZED", status: 401 });
	});
});

describe("paths", () => {
	test("the path's workspace is the one used, whatever the body or query says", async () => {
		const ada = await account();
		const grace = await account("grace");
		const created = await ada.browser.call("POST", `/api/workspaces/${ada.ws}/agents?workspaceId=${grace.ws}`, { name: "Mine", workspaceId: grace.ws });
		expect(created.status).toBe(201);
		expect((await ada.browser.call("GET", `/api/workspaces/${ada.ws}/agents`)).body.map((agent: { name: string }) => agent.name)).toEqual(["Assistant", "Mine"]);
		expect((await grace.browser.call("GET", `/api/workspaces/${grace.ws}/agents`)).body.map((agent: { name: string }) => agent.name)).toEqual(["Assistant"]);
	});

	test("an encoded, odd or unknown path is no route; another method on a known path is no route", async () => {
		const ada = await account();
		const grace = await account("grace");
		const id = (await ada.browser.call("POST", `/api/workspaces/${ada.ws}/agents`, { name: "A" })).body.id as string;
		const agents = `/api/workspaces/${ada.ws}/agents`;
		const routes: [string, string][] = [
			["GET", `/api/workspaces/${encodeURIComponent(ada.ws).replace("-", "%2D")}/agents`],
			["GET", `/api/workspaces/${ada.ws.toUpperCase()}/agents`],
			["GET", `/api/workspaces/${ada.ws}/%61gents`],
			["GET", `${agents}/`],
			["GET", `${agents}/${id}/more`],
			["GET", `/api/workspaces/${ada.ws}/nothing-here`],
			["PATCH", agents],
			["POST", `${agents}/${id}`],
			["DELETE", agents],
			["GET", "/api/nothing-here"],
		];
		for (const [method, path] of routes) {
			const body = method === "GET" ? undefined : { name: "B" };
			expect([method, path, answer(await ada.browser.call(method, path, body))]).toEqual([method, path, NO_ROUTE]);
		}
		// A non-member learns nothing of the workspace's routes.
		expect(answer(await grace.browser.call("GET", `/api/workspaces/${ada.ws}/nothing-here`))).toEqual(UNAUTHORIZED);
		expect(answer(await grace.browser.call("PATCH", agents, { name: "B" }))).toEqual(UNAUTHORIZED);
		// An agent id that is not one is invalid input; an encoded or uppercase one reads as itself.
		const odd = await ada.browser.call("GET", `${agents}/not-an-id`);
		expect([odd.status, odd.body.code, odd.body.data.issues[0].path]).toEqual([422, "VALIDATION_FAILED", ["agentId"]]);
		expect((await ada.browser.call("GET", `${agents}/${id.replace("-", "%2D")}`)).body.id).toBe(id);
		expect((await ada.browser.call("GET", `${agents}/${id.toUpperCase()}`)).body.id).toBe(id);
	});
});

describe("errors", () => {
	test("only our refusals pass as declared: a crash or an error we did not make is a 500 that says nothing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const how of ["crash", "undeclared", "foreign"] as const) {
			const failed = await testClient.failing({ how }).catch((error: unknown) => error);
			expect([how, failed]).toMatchObject([how, { defined: true, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Something went wrong on the server." }]);
			expect((failed as ORPCError<string, unknown>).data).toBeUndefined();
		}
		vi.restoreAllMocks();
	});

	test("HEAD answers as GET without a body", async () => {
		const ada = await account();
		const response = await ada.browser.fetch(`${ORIGIN}/api/workspaces/${ada.ws}/agents`, { method: "HEAD" });
		expect([response.status, await response.text()]).toEqual([200, ""]);
		expect((await new Browser().fetch(`${ORIGIN}/api/workspaces/${ada.ws}/agents`, { method: "HEAD" })).status).toBe(401);
	});
});

describe("the typed client", () => {
	test("calls the Worker's agents and reads its refusals as declared errors", async () => {
		const ada = await account();
		const api = client(ada.browser);
		const workspaceId = ada.ws;
		const created = await api.agents.create({ workspaceId, name: "Typed", instructions: "", connectionIds: [] });
		expect(created).toMatchObject({ name: "Typed", connectionIds: [], canEdit: true });
		const [first] = await api.agents.list({ workspaceId });
		expect((await api.agents.list({ workspaceId })).at(-1)).toEqual(created);
		await api.agents.delete({ workspaceId, agentId: created.id });
		const refused = await api.agents.delete({ workspaceId, agentId: first!.id }).catch((error: unknown) => error);
		expect(refused).toMatchObject({ defined: true, code: "KEEP_ONE_AGENT", status: 422 });
		const invalid = await api.agents.create({ workspaceId, name: "", instructions: "", connectionIds: [] }).catch((error: unknown) => error);
		expect(invalid).toMatchObject({ defined: true, code: "VALIDATION_FAILED", data: { issues: [{ path: ["name"] }] } });
		const outsider = await client(new Browser()).agents.list({ workspaceId }).catch((error: unknown) => error);
		expect(outsider).toMatchObject({ defined: true, code: "UNAUTHORIZED", status: 401 });
	});

	test("an API key in a body reaches the provider as the reader decoded it, and no answer carries it", async () => {
		const ada = await account();
		const authorizations: string[] = [];
		const network = PROVIDER_NETWORK.fetch;
		PROVIDER_NETWORK.fetch = () => async (input, init) => {
			authorizations.push(new Request(input as RequestInfo, init as RequestInit).headers.get("Authorization") ?? "");
			return Response.json({ id: "acct_1", email: null, default_currency: "usd", business_profile: { name: "Acme" }, settings: null });
		};
		try {
			const path = `/api/workspaces/${ada.ws}/connectors/stripe/key`;
			// Every letter after the prefix escaped, as a JSON writer may send it.
			const created = await ada.browser.call("POST", path, `{"key":"rk_test_${"\\u0061".repeat(24)}"}`);
			expect(created.status, JSON.stringify(created.body)).toBe(200);
			expect(authorizations).toContain(`Bearer rk_test_${"a".repeat(24)}`);
			const secretKey = await ada.browser.call("POST", path, { key: `sk_test_${"a".repeat(24)}` });
			const tooLong = await ada.browser.call("POST", path, { key: `rk_test_${"a".repeat(600)}` });
			const typed = await client(ada.browser).connections.connectKey({ workspaceId: ada.ws, provider: "stripe", key: `rk_test_${"a".repeat(24)}` });
			expect([secretKey.body.code, tooLong.body.code, typed.id]).toEqual(["KEY_REFUSED", "VALIDATION_FAILED", created.body.id]);
			for (const answer of [created.body, secretKey.body, tooLong.body, typed]) expect(JSON.stringify(answer)).not.toMatch(/[rs]k_test_a/);
		} finally {
			PROVIDER_NETWORK.fetch = network;
		}
	});

	test("carries a header to a procedure that reads one", async () => {
		expect(await testClient.stamped({ headers: { "idempotency-key": "k-1" }, body: { note: "n" } })).toEqual({ key: "k-1", note: "n" });
		const missing = await testClient.stamped({ headers: { "idempotency-key": "" }, body: { note: "n" } }).catch((error: unknown) => error);
		expect(missing).toMatchObject({ defined: true, code: "VALIDATION_FAILED", data: { issues: [{ path: ["headers", "idempotency-key"] }] } });
	});
});

describe("the streamed read", () => {
	// The conversation as the Worker writes it, read with a schema of the test's own: the contract types the body with `type<>()`, and
	// nothing else checks it. Strict, so a field the API does not declare (a head's `eventSeq`) fails it.
	const Iso = z.iso.datetime();
	const event = <T extends string, D extends z.ZodType>(type: T, data: D) => z.strictObject({ seq: z.number().int().positive(), type: z.literal(type), data });
	const Delta = z.strictObject({ text: z.string(), call: z.string().regex(/^[0-9a-f]{8}$/) });
	const Shown = { tool: z.string(), label: z.string(), arguments: z.record(z.string(), z.unknown()) };
	const Event = z.discriminatedUnion("type", [
		event(
			"status",
			z.union([
				z.strictObject({ status: z.enum(["queued", "provisioning", "running", "completed"]) }),
				z.strictObject({ status: z.enum(["provisioning", "running"]), attempt: z.number().int().min(2) }),
				z.strictObject({ status: z.enum(["failed", "cancelled", "timed_out"]), message: z.string().optional() }),
			]),
		),
		event("phase", z.strictObject({ text: z.string() })),
		event("text_delta", Delta),
		event("reasoning_delta", Delta),
		event(
			"tool_call",
			z.union([
				z.strictObject({ ...Shown, decision: z.literal("allowed"), title: z.string(), count: z.number().nullable(), write: z.string().optional(), repeat: z.literal(true).optional() }),
				z.strictObject({ ...Shown, decision: z.enum(["denied", "error"]), code: z.string(), message: z.string() }),
			]),
		),
		event("local_tool", z.strictObject({ tool: z.enum(["read", "write", "edit", "bash"]), summary: z.string(), ok: z.boolean(), excerpt: z.string() })),
		event("message", z.strictObject({ id: z.uuid(), content: z.string(), call: z.string().optional() })),
	]);
	const Changed = z.array(z.strictObject({ path: z.string(), size: z.number() }));
	const Run = z.strictObject({
		id: z.uuid(),
		status: z.enum(["queued", "provisioning", "running", "completed", "failed", "cancelled", "timed_out"]),
		errorMessage: z.string(),
		createdAt: Iso,
		finishedAt: Iso.nullable(),
		baseVersionId: z.uuid().nullable(),
		resultVersionId: z.uuid().nullable(),
		folderChanges: z
			.strictObject({
				added: Changed,
				modified: Changed,
				deleted: Changed,
				counts: z.strictObject({ added: z.number(), modified: z.number(), deleted: z.number(), dirsAdded: z.number(), dirsDeleted: z.number() }),
				dirsAdded: z.array(z.string()),
				dirsDeleted: z.array(z.string()),
			})
			.nullable(),
		folderWarnings: z.strictObject({ items: z.array(z.strictObject({ path: z.string(), reason: z.string() })), total: z.number() }).nullable(),
		events: z.array(Event),
	});
	const Message = z.strictObject({
		id: z.uuid(),
		role: z.enum(["user", "assistant"]),
		content: z.string(),
		attachments: z.array(z.strictObject({ path: z.string(), size: z.number(), mediaType: z.string() })),
		runId: z.uuid().nullable(),
		createdAt: Iso,
	});
	const Conversation = z.strictObject({ id: z.uuid(), agentId: z.uuid(), title: z.string(), updatedAt: Iso, messages: z.array(Message), runs: z.array(Run) });

	beforeAll(() => {
		// The test build's wiring, as chat.test.ts sets it.
		CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
		PORTS.factory = () => faultConversationPorts(defaultPorts);
		WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
	});

	/** A conversation with one finished run ("Hi", answered), its run, and the events it has. */
	async function finished(a: Account): Promise<{ conversationId: string; runId: string; events: number }> {
		const api = client(a.browser);
		const agentId = (await api.agents.list({ workspaceId: a.ws }))[0]!.id;
		const { id: conversationId } = await api.conversations.create({ workspaceId: a.ws, agentId });
		const posted = await api.conversations.send({ params: { workspaceId: a.ws, conversationId }, headers: {}, body: { content: "Hi" } });
		const runId = posted.run.id;
		for (const started = Date.now(); ; ) {
			const run = await api.runs.get({ workspaceId: a.ws, runId });
			if (!["queued", "provisioning", "running"].includes(run.status)) return { conversationId, runId, events: run.events.length };
			if (Date.now() - started > 15_000) throw new Error(`The run did not finish: ${run.status}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Appends events to a finished run as a long answer would leave them: `count` text deltas of `size` characters, or `data` as stored. */
	async function addEvents(a: Account, conversationId: string, runId: string, count: number, size: number, data?: string): Promise<void> {
		const stored = data ?? JSON.stringify({ text: "x".repeat(size), call: "0badc0de" });
		await runInDurableObject(conversationObject(env, { id: a.ws, jurisdiction: null }, conversationId), (_instance, state) => {
			for (let i = 0; i < count; i++) {
				const seq = state.storage.sql.exec<{ event_seq: number }>("UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq", runId).one().event_seq;
				state.storage.sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, 'text_delta', ?, ?)", runId, seq, stored, Date.now());
			}
		});
	}

	const read = (a: Account, conversationId: string) => a.browser.fetch(`${ORIGIN}/api/workspaces/${a.ws}/conversations/${conversationId}`);

	test("the schema reads every event type", () => {
		expect(Event.options.map((option) => option.shape.type.value)).toEqual([...RUN_EVENT_TYPES]);
	});

	test("a large conversation, over many pages of events and of bytes, arrives whole as JSON through the typed client", async () => {
		const ada = await account();
		const { conversationId, runId, events } = await finished(ada);
		// Past the 1,000 events of a page, then past its 4 MiB.
		await addEvents(ada, conversationId, runId, 2_500, 10);
		await addEvents(ada, conversationId, runId, 6, 1024 * 1024);
		const raw = await read(ada, conversationId);
		expect([raw.status, raw.headers.get("Content-Type"), raw.headers.get("Content-Length"), raw.headers.get("Cache-Control")]).toEqual([
			200,
			"application/json; charset=utf-8",
			null,
			"no-store",
		]);
		const parsed = Conversation.parse(JSON.parse(await raw.text()));
		const seqs = Array.from({ length: events + 2_506 }, (_v, i) => i + 1);
		expect(parsed.runs[0]!.events.map((event) => event.seq)).toEqual(seqs);
		const typed = await client(ada.browser).conversations.get({ workspaceId: ada.ws, conversationId });
		expect(Conversation.parse(typed)).toEqual(parsed);
		expect(Run.parse(await client(ada.browser).runs.get({ workspaceId: ada.ws, runId }))).toEqual(parsed.runs[0]);
	}, 60_000);

	test("a slow reader gets the whole body; one that cancels leaves the Worker answering", async () => {
		const ada = await account();
		const { conversationId, runId } = await finished(ada);
		await addEvents(ada, conversationId, runId, 3, 1024 * 1024);
		const reader = (await read(ada, conversationId)).body!.getReader();
		const chunks: Uint8Array[] = [];
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			chunks.push(chunk.value);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const whole = Conversation.parse(JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer())));
		expect(chunks.length).toBeGreaterThan(1);
		// Cancelled after its first piece: the producer stops at its next write.
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const cancelled = (await read(ada, conversationId)).body!.getReader();
		await cancelled.read();
		await cancelled.cancel();
		await new Promise((resolve) => setTimeout(resolve, 100));
		error.mockRestore();
		expect(await client(ada.browser).conversations.get({ workspaceId: ada.ws, conversationId })).toEqual(whole);
	}, 30_000);

	test("a body that fails after its first page is cut short: never a value, and the conversation reads again once it is fixed", async () => {
		const ada = await account();
		const { conversationId, runId } = await finished(ada);
		await addEvents(ada, conversationId, runId, 1_200, 10);
		// An event the object cannot read, on the second page: the first is written before it fails.
		await addEvents(ada, conversationId, runId, 1, 0, "{");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const raw = await read(ada, conversationId);
		expect(raw.status).toBe(200);
		const text = await raw.text().catch(() => null);
		expect(text === null || !isJson(text)).toBe(true);
		await expect(client(ada.browser).conversations.get({ workspaceId: ada.ws, conversationId })).rejects.toThrow();
		expect(error).toHaveBeenCalledWith("A streamed body failed", expect.anything());
		error.mockRestore();
	}, 30_000);

	test("refused before the stream starts, in the contract's shape: another user's conversation or run, and a non-member", async () => {
		const [ada, grace] = [await account(), await account("grace")];
		const theirs = await finished(grace);
		const api = client(ada.browser);
		for (const call of [
			() => api.conversations.get({ workspaceId: ada.ws, conversationId: theirs.conversationId }),
			() => api.runs.get({ workspaceId: ada.ws, runId: theirs.runId }),
			() => api.runs.cancel({ workspaceId: ada.ws, runId: theirs.runId }),
		]) {
			expect(await call().catch((error: unknown) => error)).toMatchObject({ defined: true, code: "NOT_FOUND", status: 404 });
		}
		const outsider = await api.conversations.get({ workspaceId: grace.ws, conversationId: theirs.conversationId }).catch((error: unknown) => error);
		expect(outsider).toMatchObject({ defined: true, code: "UNAUTHORIZED", status: 401 });
	}, 30_000);
});

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
