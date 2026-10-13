// The integration matrix of the contract's routes (api/orpc.ts): oRPC's OpenAPIHandler behind our router,
// our mount and our body reader. It must pass before the hey-api client goes, and after every update of
// @orpc/*: each row is a place where oRPC's own behaviour (its body reader, its matching, its errors)
// would answer differently from ours. request-rules.test.ts has the content-type table, strict UTF-8 and
// CSRF; api.test.ts the agents' refusals.
//
// The rows that need a procedure of their own (an escaped key, a header) run a test-only contract through
// the same `contractHandler`, in process; the others go through the Worker.

import { env } from "cloudflare:workers";
import { ERRORS, contract } from "@minerva/contract";
import { createORPCClient } from "@orpc/client";
import { type ContractRouterClient, oc, type } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ORPCError, implement } from "@orpc/server";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { contractHandler } from "../../src/api/orpc.ts";
import type { ApiContext } from "../../src/api/procedures.ts";
import { uuid7 } from "../../src/lib/random.ts";
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
const testHandler = contractHandler(
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
);
const testClient: JsonifiedClient<ContractRouterClient<typeof testContract>> = createORPCClient(
	new OpenAPILink(testContract, {
		url: `${ORIGIN}/api`,
		fetch: async (request) => {
			const { matched, response } = await testHandler.handle(request, { prefix: "/api", context: { request, member: null } });
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
		const raw = await testHandler.handle(request, { prefix: "/api", context: { request, member: null } });
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
		const { response } = await testHandler.handle(request, { prefix: "/api", context: { request, member: null } });
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

	test("carries a header to a procedure that reads one", async () => {
		expect(await testClient.stamped({ headers: { "idempotency-key": "k-1" }, body: { note: "n" } })).toEqual({ key: "k-1", note: "n" });
		const missing = await testClient.stamped({ headers: { "idempotency-key": "" }, body: { note: "n" } }).catch((error: unknown) => error);
		expect(missing).toMatchObject({ defined: true, code: "VALIDATION_FAILED", data: { issues: [{ path: ["headers", "idempotency-key"] }] } });
	});
});

// Pending for A3b, when conversations move to the contract: a streamed conversation read through the
// typed client (an event iterator that keeps its session cookies and ends on a refusal mid-stream).
test.todo("a conversation's streamed read through the typed client");
