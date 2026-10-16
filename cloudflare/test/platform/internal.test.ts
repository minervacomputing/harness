// The internal API (src/internal/mount.ts) in workerd: Laravel's commands with an Access assertion this test signs, and
// the engine's client of Laravel (src/laravel/client.ts) against the fake Laravel, which must pass the delivery scenarios
// (contract/scenarios/facts.json). vitest.platform.config.ts turns the internal API on with the test's issuer.

import { env, exports } from "cloudflare:workers";
import { Catalog, type Fact, INTERNAL_ERRORS, INTERNAL_PREFIX, INTERNAL_REFUSALS, MAX_INTERNAL_BODY } from "@minerva/contract/internal";
import { ORPCError, createORPCClient } from "@orpc/client";
import { type ContractRouterClient, oc, type } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { implement } from "@orpc/server";
import { errors } from "jose";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import scenarios from "../../../contract/scenarios/facts.json";
import { pricesOf } from "../../src/budget/prices.ts";
import { SECURITY_HEADERS } from "../../src/http/headers.ts";
import { createApp } from "../../src/http/router.ts";
import { ACCESS_KEYS, ASSERTION_HEADER } from "../../src/internal/access.ts";
import { contractHandler } from "../../src/internal/handler.ts";
import { LARAVEL_NETWORK, LaravelUnreachable, laravelClient, retryable } from "../../src/laravel/client.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { FAKE_ROUTE_PRICES } from "../../src/faults/prices.ts";
import { ORIGIN, assertion, call, commands, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

const SCOPE = scope();
const startRun = (within = SCOPE) => startOf(within);

describe("the commands", () => {
	test("the catalog is served, as the contract declares it", async () => {
		const catalog = await commands.catalog();
		expect(Catalog.parse(catalog)).toEqual(catalog);
		expect(catalog.connectors.some((connector) => connector.slug === "todoist" && connector.auth.type === "oauth2")).toBe(true);
		// With the build's prices, the test build's with the fake model's; the catalog's version stays its connectors'.
		expect(catalog.prices).toEqual(await pricesOf(env));
		expect(catalog.prices?.table.routes).toEqual([FAKE_ROUTE_PRICES]);
		const response = await call(`${INTERNAL_PREFIX}/catalog`);
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	test("a command declared before its chunk is 501 in the contract's shape", async () => {
		const admission = commands.admission({ environment: SCOPE.environment, open: false, revision: 1, reason: "Stop." });
		expect(await refusalOf(admission)).toMatchObject({ code: "NOT_IMPLEMENTED", status: 501 });
	});

	test("a command for another environment is refused", async () => {
		expect(await refusalOf(commands.startRun(startRun({ ...SCOPE, environment: "staging" })))).toMatchObject({ code: "WRONG_ENVIRONMENT", status: 409 });
		const admission = commands.admission({ environment: "production", open: false, revision: 1, reason: "Stop." });
		expect(await refusalOf(admission)).toMatchObject({ code: "WRONG_ENVIRONMENT", status: 409 });
	});

	test("an input that is not the contract's is 422 with its issues", async () => {
		const response = await call(`${INTERNAL_PREFIX}/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...startRun(), user: "not a user id" }),
		});
		expect(response.status).toBe(422);
		const body = (await response.json()) as { code: string; data: { issues: { path: unknown[] }[] } };
		expect(body.code).toBe("VALIDATION_FAILED");
		expect(body.data.issues.map((issue) => issue.path)).toEqual([["user"]]);
	});

	test("a body over the cap is refused before it is read", async () => {
		const response = await call(`${INTERNAL_PREFIX}/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": String(16 * 1024 * 1024 + 1) },
			body: "{}",
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
	});

	test("a path no command has is 404, another version's too", async () => {
		for (const path of [`${INTERNAL_PREFIX}/nothing`, "/internal/v2/catalog", "/internal/"]) {
			const response = await call(path);
			expect(response.status, path).toBe(404);
			expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
		}
	});
});

/** A refusal as the commands answer it. */
function refusal(code: keyof typeof INTERNAL_REFUSALS, message: string): { defined: true; code: string; status: number; message: string } {
	return { defined: true, code, status: INTERNAL_REFUSALS[code], message };
}

// A test-only contract, served by the commands' handler factory (internal/handler.ts) with their codes and body cap.
const testContract = {
	keys: oc
		.errors(INTERNAL_ERRORS)
		.route({ method: "POST", path: "/test/keys" })
		.input(z.record(z.string(), z.number()))
		.output(type<string[]>()),
	optional: oc
		.errors(INTERNAL_ERRORS)
		.route({ method: "POST", path: "/test/optional" })
		.input(z.object({}).optional())
		.output(type<string>()),
	failing: oc
		.errors(INTERNAL_ERRORS)
		.route({ method: "POST", path: "/test/failing" })
		.input(z.object({ how: z.enum(["crash", "undeclared", "foreign"]) }))
		.output(type<never>()),
};
const testApi = implement(testContract).$context<{ request: Request }>();
const testHandler = contractHandler<{ request: Request }>(
	testApi.router({
		keys: testApi.keys.handler(({ input }) => Object.keys(input)),
		optional: testApi.optional.handler(({ input }) => (input === undefined ? "none" : "a body")),
		failing: testApi.failing.handler(({ input }) => {
			if (input.how === "crash") throw new Error("a secret in a crash");
			// Codes and statuses of the error map, but not made by `refusal`: oRPC alone would mark them declared.
			if (input.how === "undeclared") throw new ORPCError("INTERNAL_SERVER_ERROR", { status: 500, message: "a secret", data: { secret: 1 } });
			throw new ORPCError("toString", { status: 500, message: "a secret" });
		}),
	}),
	{ codes: INTERNAL_REFUSALS, maxBody: MAX_INTERNAL_BODY },
);

async function testCall(request: Request): Promise<Response> {
	const { matched, response } = await testHandler.handle(request, { context: { request } });
	return matched ? response : new Response(null, { status: 404 });
}

const testClient: JsonifiedClient<ContractRouterClient<typeof testContract>> = createORPCClient(new OpenAPILink(testContract, { url: ORIGIN, fetch: testCall }));

/** JSON whitespace one MB over the commands' cap, streamed without a declared length. */
function overCap(): ReadableStream<Uint8Array> {
	const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent++ <= MAX_INTERNAL_BODY / chunk.length) controller.enqueue(chunk);
			else controller.close();
		},
	});
}

describe("the body reader", () => {
	test("an escaped key reads right after the runtime has seen a lone backslash as a key", async () => {
		// The runtime's JSON.parse, once it has read "\\" as a key, reads a later "\n" in the same place as "\\" (lib/json.ts).
		const shape = `probe${crypto.randomUUID().replaceAll("-", "")}`;
		JSON.parse(`{"${shape}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(`{"${shape}":0,"\\n":1}`))[1]).toBe("\\");
		const request = new Request(`${ORIGIN}/test/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: `{"${shape}":0,"\\n":1}` });
		expect(await (await testCall(request)).json()).toEqual([shape, "\n"]);
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
		const request = new Request(`${ORIGIN}/test/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit);
		const response = await testCall(request);
		expect([response.status, await response.json()]).toEqual([400, refusal("INVALID_JSON", "The body is not valid JSON.")]);
	});

	test("a POST without a body, as a browser sends one (Content-Length: 0, no type), is no body; an empty body with a type is read", async () => {
		const send = async (headers: Record<string, string>, body: string) => {
			// Bytes, so the Request adds no type of its own.
			const response = await testCall(new Request(`${ORIGIN}/test/optional`, { method: "POST", headers, body: new TextEncoder().encode(body) }));
			return [response.status, await response.json()];
		};
		expect(await send({ "Content-Length": "0" }, "")).toEqual([200, "none"]);
		expect(await send({ "Content-Type": "application/json" }, "")).toEqual([200, "none"]);
		expect(await send({ "Content-Type": "application/json" }, "{}")).toEqual([200, "a body"]);
		// Without a type, a body that is not empty is still refused.
		expect(await send({}, "{}")).toEqual([415, refusal("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.")]);
	});

	test("only our refusals pass as declared: a crash or an error we did not make is a 500 that says nothing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const how of ["crash", "undeclared", "foreign"] as const) {
				const failed = await testClient.failing({ how }).catch((error: unknown) => error);
				expect([how, failed]).toMatchObject([how, { defined: true, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Something went wrong on the server." }]);
				expect((failed as ORPCError<string, unknown>).data).toBeUndefined();
			}
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("a form body is 415, not read as input", async () => {
		const response = await call(`${INTERNAL_PREFIX}/runs/start`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "user=42" });
		expect([response.status, await response.json()]).toEqual([415, refusal("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.")]);
	});

	test("a streamed body over the cap is 413 without a declared length", async () => {
		const response = await call(`${INTERNAL_PREFIX}/runs/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: overCap(), duplex: "half" } as RequestInit);
		expect([response.status, await response.json()]).toEqual([413, refusal("PAYLOAD_TOO_LARGE", "The request is too large.")]);
	});
});

describe("who may call", () => {
	test("only a listed service token's assertion, while it is listed", async () => {
		expect((await call(`${INTERNAL_PREFIX}/catalog`, { client: "laravel-old.access" })).status).toBe(200);
		for (const client of [null, "someone.access"]) {
			const response = await call(`${INTERNAL_PREFIX}/catalog`, { client });
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ defined: true, code: "UNAUTHORIZED", status: 401, message: "Unauthorized" });
		}
		const otherApplication = await exports.default.fetch(
			new Request(`${ORIGIN}${INTERNAL_PREFIX}/catalog`, { headers: { [ASSERTION_HEADER]: await assertion("laravel.access", "another-audience") } }),
		);
		expect(otherApplication.status).toBe(401);
	});

	test("a refused caller's body is never read", async () => {
		// No chunk is asked for ahead of a read (highWaterMark 0), so `read` says whether anything read the body. The app
		// itself is called, not the Worker's entry point, which streams a body across as it is sent.
		const send = async (assertion: string | null) => {
			const state = { read: false };
			const body = new ReadableStream(
				{
					pull(controller) {
						state.read = true;
						controller.enqueue(new TextEncoder().encode("{}"));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			const headers = new Headers({ "Content-Type": "application/json" });
			if (assertion !== null) headers.set(ASSERTION_HEADER, assertion);
			const request = new Request(`${ORIGIN}${INTERNAL_PREFIX}/runs/start`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
			return { status: (await createApp().fetch(request, env)).status, read: state.read };
		};
		expect(await send(null)).toEqual({ status: 401, read: false });
		// The same body from Laravel is read, and refused for what it holds.
		expect(await send(await assertion())).toEqual({ status: 422, read: true });
	});

	test("a refused caller's path is not matched first: an unknown path is 401 too", async () => {
		expect((await call(`${INTERNAL_PREFIX}/nothing`, { client: null })).status).toBe(401);
	});

	test("Access's keys out of reach answer 503, to be retried", async () => {
		const local = ACCESS_KEYS.of;
		ACCESS_KEYS.of = () => async () => {
			throw new errors.JWKSTimeout();
		};
		try {
			const response = await call(`${INTERNAL_PREFIX}/catalog`);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ code: "UNAVAILABLE" });
		} finally {
			ACCESS_KEYS.of = local;
		}
	});

	test("without the internal settings there is no internal API", async () => {
		const off = { ...env, MINERVA_ENVIRONMENT: "", MINERVA_ACCESS_ISSUER: "", MINERVA_ACCESS_AUDIENCE: "", MINERVA_ACCESS_CLIENTS: "" };
		const request = new Request(`${ORIGIN}${INTERNAL_PREFIX}/catalog`, { headers: { [ASSERTION_HEADER]: await assertion() } });
		const response = await createApp().fetch(request, off);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("the engine's client of Laravel, against the fake Laravel", () => {
	// The token this engine was given; its binding is a secret, set only where it is configured (cloudflare.config.ts).
	const token = "test-laravel-token";
	const engineEnv = { ...env, MINERVA_LARAVEL_TOKEN: token } as Env;

	test("a lease for a run's authorized connection, and refusals outside it", async () => {
		const fake = new FakeLaravel(token);
		const uninstall = fake.install();
		try {
			const [run, conversation, connection, other] = [uuid7(), uuid7(), uuid7(), uuid7()];
			fake.runs.set(run, { scope: SCOPE, conversation, active: true, authorized: [connection] });
			fake.connections.set(connection, { kind: "api_key", secret: "a key", scopes: null, generation: 3, expiresAt: null, status: "active" });
			const laravel = laravelClient(engineEnv);
			const lease = { scope: SCOPE, conversation, run, attempt: 1, connection };
			expect(await laravel.leaseToken(lease)).toEqual({ outcome: "leased", kind: "api_key", secret: "a key", scopes: null, generation: 3, expiresAt: null });
			expect(await laravel.leaseToken({ ...lease, connection: other })).toMatchObject({ outcome: "refused", code: "NOT_AUTHORIZED" });
			// Another workspace's run, or another environment's, is not known.
			expect(await laravel.leaseToken({ ...lease, scope: { ...SCOPE, workspace: uuid7() } })).toMatchObject({ outcome: "refused", code: "RUN_NOT_ACTIVE" });
			expect(await laravel.leaseToken({ ...lease, scope: { ...SCOPE, environment: "staging" } })).toMatchObject({ outcome: "refused", code: "RUN_NOT_ACTIVE" });
			// A report is fenced by the generation.
			expect(await laravel.reportUnauthorized({ ...lease, generation: 2 })).toEqual({ marked: false });
			expect(await laravel.reportUnauthorized({ ...lease, generation: 3 })).toEqual({ marked: true });
			expect(await laravel.leaseToken(lease)).toMatchObject({ outcome: "refused", code: "RECONNECT_NEEDED" });
			// The fake records ids, never a secret.
			expect(JSON.stringify(fake.calls)).not.toContain("a key");
		} finally {
			uninstall();
		}
	});

	test("a wrong token is refused, and not worth retrying", async () => {
		const uninstall = new FakeLaravel("another token").install();
		try {
			const error = await laravelClient(engineEnv)
				.deliverFacts({ scope: SCOPE, conversation: uuid7(), facts: scenarios.scenarios[0]!.steps[0]!.deliver.facts as Fact[] })
				.then(() => null, (failure: unknown) => failure);
			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<string, unknown>).status).toBe(401);
			expect(retryable(error)).toBe(false);
		} finally {
			uninstall();
		}
	});

	test("an answer outside the contract is classed for retrying", async () => {
		const previous = LARAVEL_NETWORK.fetch;
		const answers: [() => Promise<Response>, boolean][] = [
			[async () => Promise.reject(new TypeError("Network connection lost.")), true],
			[async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }), false],
			[async () => new Response("<html>Bad gateway</html>", { status: 502 }), true],
			[async () => new Response("<html>Forbidden</html>", { status: 403 }), false],
			// JSON that is not the operation's answer, or not JSON at all: a bug, unless Laravel is failing.
			[async () => Response.json({ marked: "yes" }), false],
			[async () => new Response("{", { headers: { "Content-Type": "application/json" } }), false],
			[async () => new Response("{", { status: 502, headers: { "Content-Type": "application/json" } }), true],
			// An error whose body names another status than it came with: classed by the status it came with.
			[async () => Response.json({ defined: true, code: "BAD_REQUEST", status: 400, message: "No." }, { status: 503 }), true],
			[async () => Response.json({ defined: true, code: "INTERNAL_SERVER_ERROR", status: 500, message: "No." }, { status: 400 }), false],
			// Larger than any answer of Laravel's, declared or not.
			[async () => new Response(`{"marked":true,"pad":"${"x".repeat(1 << 20)}"}`, { headers: { "Content-Type": "application/json" } }), false],
			// An answer cut off while it arrives.
			[
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"mar'));
								controller.error(new Error("Connection reset."));
							},
						}),
						{ headers: { "Content-Type": "application/json" } },
					),
				true,
			],
		];
		try {
			for (const [answer, retry] of answers) {
				LARAVEL_NETWORK.fetch = () => answer;
				const report = { scope: SCOPE, conversation: uuid7(), run: uuid7(), attempt: 1, connection: uuid7(), generation: 1 };
				const error = await laravelClient(engineEnv)
					.reportUnauthorized(report)
					.then(() => null, (failure: unknown) => failure);
				expect(error).toBeInstanceOf(LaravelUnreachable);
				expect(retryable(error)).toBe(retry);
			}
		} finally {
			LARAVEL_NETWORK.fetch = previous;
		}
	});

	test("a call's own signal reaches the request", async () => {
		const previous = LARAVEL_NETWORK.fetch;
		LARAVEL_NETWORK.fetch = () => async (input) => {
			const request = input as Request;
			if (request.signal.aborted) throw request.signal.reason;
			return Response.json({ marked: true });
		};
		try {
			const report = { scope: SCOPE, conversation: uuid7(), run: uuid7(), attempt: 1, connection: uuid7(), generation: 1 };
			const laravel = laravelClient(engineEnv);
			expect(await laravel.reportUnauthorized(report)).toEqual({ marked: true });
			await expect(laravel.reportUnauthorized(report, { signal: AbortSignal.abort() })).rejects.toThrow();
		} finally {
			LARAVEL_NETWORK.fetch = previous;
		}
	});

	describe("the delivery scenarios", () => {
		for (const scenario of scenarios.scenarios) {
			test(scenario.name, async () => {
				const fake = new FakeLaravel(token);
				for (const conversation of scenarios.conversations) {
					fake.conversations.set(conversation.id, scenarios.scope);
					for (const run of conversation.runs) fake.runs.set(run, { scope: scenarios.scope, conversation: conversation.id, active: true, authorized: [] });
				}
				const uninstall = fake.install();
				try {
					const laravel = laravelClient(engineEnv);
					for (const [index, step] of scenario.steps.entries()) {
						const answer = await laravel.deliverFacts(step.deliver as Parameters<typeof laravel.deliverFacts>[0]).then(
							(value) => value as unknown,
							(error: unknown) => {
								if (!(error instanceof ORPCError)) throw error;
								return error.data === undefined ? { error: error.code } : { error: error.code, data: error.data };
							},
						);
						expect(answer, `step ${index + 1}`).toEqual(step.answer);
					}
				} finally {
					uninstall();
				}
			});
		}
	});
});
