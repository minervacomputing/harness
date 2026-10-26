// The executor's contract with connectors, through the HTTP-based `mixed` and `keyed` fakes: requirement
// checks, record filtering, write accounting, consent and contract changes.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ACCOUNT_KIND, type Connector, OperationError, type Prepared, defineOperation } from "../../src/gateway/connector.ts";
import { visibleResult } from "../../src/gateway/executor.ts";
import { ProgrammingError } from "../../src/gateway/http.ts";
import { Layer, Policy, resource } from "../../src/gateway/policy.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { RESULT_SCHEMA, type ToolResult, appliedWithoutResult } from "../../src/gateway/results.ts";
import type { RunStatePort } from "../../src/gateway/run-state.ts";
import {
	FOLDER,
	FakeServer,
	Gate,
	KEYED,
	LABEL,
	MIXED,
	type MixedMode,
	Scenario,
	type WriteResponse,
	keyedConnection,
	keyedConnector,
	mixedConnection,
	mixedConnector,
	userGrants,
} from "./executor-fakes.ts";

const COPY = "mixed_copy_file";

function copy(source = "inbox", dest = "archive", name = "a") {
	return { source, dest, name };
}

/** Grants are {folder id: actions}, plus [kind, id, actions] rows for other kinds. */
function start(server: FakeServer, folders: { [id: string]: string[] }, others: [string, string, string[]][] = [], scopes?: string[] | null) {
	return Scenario.start({
		connectors: [mixedConnector(server), keyedConnector(server)],
		connections: [mixedConnection(scopes)],
		user: userGrants(MIXED, FOLDER, folders, others),
		fetch: server.fetch,
	});
}

const WRITER = { inbox: ["read"], archive: ["read", "create"] };

function withMode(mode: MixedMode, responses: WriteResponse[] = []): FakeServer {
	const server = new FakeServer();
	server.mode = mode;
	server.writeResponses = responses;
	return server;
}

/** RESULT_SCHEMA checked by hand: the keys it allows, with their types. */
function matchesResultSchema(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as { [key: string]: unknown };
	const allowed = Object.keys(RESULT_SCHEMA.properties as object);
	if (Object.keys(result).some((key) => !allowed.includes(key))) return false;
	if (!Array.isArray(result.items) || !result.items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return false;
	if (!Number.isInteger(result.count) || (result.count as number) < 0) return false;
	if ("incomplete" in result && result.incomplete !== true) return false;
	if ("next_cursor" in result && (typeof result.next_cursor !== "string" || result.next_cursor.length < 1)) return false;
	if ("outcome" in result && result.outcome !== "applied_without_result") return false;
	return true;
}

describe("records", () => {
	const unrestricted = new Policy([Layer.build("agent", false, [])]);
	const nothingGranted = new Policy([Layer.build("agent", true, [])]);
	const ref = { connection_id: "c1", provider: "variant" };

	test("records of a kind without the output action are dropped even when unrestricted", () => {
		const connector = mixedConnector(new FakeServer());
		const op = { ...(connector.operations[0] as (typeof connector.operations)[0]), needs: [[FOLDER, "read"], [LABEL, "read"]] as [string, string][], outputAction: "create" };
		const output = {
			records: [
				{ resource: resource("c1", FOLDER, "inbox"), data: { id: "inbox" } },
				{ resource: resource("c1", LABEL, "red"), data: { id: "red" } },
			],
		};
		const { result } = visibleResult(connector, op, ref, unrestricted, output, { error() {}, warn() {} });
		expect(result.items.map((item) => item.id)).toEqual(["inbox"]);
	});

	test("results match the schema the gateway declares", () => {
		const connector = mixedConnector(new FakeServer());
		const op = connector.operations[0] as (typeof connector.operations)[0];
		const records = [{ resource: resource("c1", FOLDER, "inbox"), data: { id: "inbox" } }];
		const cases: [Policy, Parameters<typeof visibleResult>[4], ToolResult][] = [
			[unrestricted, { records }, { items: [{ id: "inbox" }], count: 1 }],
			[unrestricted, { records, incomplete: true }, { items: [{ id: "inbox" }], count: 1, incomplete: true }],
			// count is what is left after the policy, so a page can be empty while the provider had records.
			[nothingGranted, { records }, { items: [], count: 0 }],
		];
		for (const [policy, output, expected] of cases) {
			const { result, images } = visibleResult(connector, op, ref, policy, output);
			expect([result, images]).toEqual([expected, []]);
			expect(matchesResultSchema(result)).toBe(true);
		}
		// Paginated operations add the run-bound cursor afterwards, even to an empty page.
		expect(matchesResultSchema({ items: [], count: 0, next_cursor: "token" })).toBe(true);
		expect(matchesResultSchema(appliedWithoutResult())).toBe(true);
		expect(matchesResultSchema({ items: [], count: 0, total: 3 })).toBe(false);
		expect(RESULT_SCHEMA).toEqual({
			type: "object",
			properties: {
				items: { type: "array", items: { type: "object" }, description: "Records this run may see. Their fields depend on the tool." },
				count: { type: "integer", minimum: 0, description: "The number of items in this result, not a total across pages." },
				incomplete: { const: true, description: "A provider or connector limit left something out." },
				next_cursor: { type: "string", minLength: 1, description: "More items may follow: repeat the call with the same arguments and this as cursor." },
				outcome: { const: "applied_without_result", description: "The write took effect, but its result could not be read back." },
			},
			required: ["items", "count"],
			additionalProperties: false,
		});
		expect(Object.isFrozen(RESULT_SCHEMA.properties)).toBe(true);
	});
});

describe("requirements", () => {
	test("copy needs read on the source and create on the destination", async () => {
		const server = new FakeServer();
		const run = await start(server, WRITER);
		expect((await run.ok(COPY, copy())).result.count).toBe(1);
		for (const args of [copy("secret"), copy("archive", "inbox")]) expect(await run.code(COPY, args)).toBe("POLICY_DENIED");
		expect(server.posts()).toBe(1);
	});

	test.each(["omit-source", "enumerate-write"] as const)("requirements that break the declaration are rejected (%s)", async (mode) => {
		const server = withMode(mode);
		const run = await start(server, WRITER);
		expect(await run.error(COPY, copy())).toEqual({ code: "CONNECTOR_ERROR", message: "This operation failed because of an internal error." });
		expect(server.posts()).toBe(0);
		expect(run.writes()).toEqual([]);
		expect(run.log.errors.some((line) => line.startsWith("Connector contract violation in mixed.copy_file"))).toBe(true);
	});

	test("a connector with a tenant per resource must name each resource's tenant", async () => {
		const server = new FakeServer();
		const tenancy = { kind: "resource" as const, label: "Fake organization", tenants: async () => ({}) };
		const run = await Scenario.start({
			connectors: [{ ...mixedConnector(server), tenancy }, keyedConnector(server)],
			connections: [mixedConnection()],
			user: userGrants(MIXED, FOLDER, { "*": ["read", "create"] }),
			fetch: server.fetch,
		});
		expect(await run.error(COPY, copy())).toEqual({ code: "CONNECTOR_ERROR", message: "This operation failed because of an internal error." });
		expect(server.posts()).toBe(0);
		// Records without a tenant are dropped.
		expect((await run.ok("mixed_list_folders", {})).result).toEqual({ items: [], count: 0 });
		expect(run.log.errors.some((line) => line.startsWith("Connector contract violation in mixed.copy_file"))).toBe(true);
	});

	test("prepare cannot write", async () => {
		// A write attempted in prepare throws; the call fails with the generic message and nothing is sent.
		const server = withMode("write-in-prepare");
		const run = await start(server, WRITER);
		expect(await run.error(COPY, copy())).toEqual({ code: "FAILED", message: "The operation could not be completed. Check the connection and try again." });
		expect(server.posts()).toBe(0);
		expect(run.writes()).toEqual([]);
		expect(run.log.errors).toEqual([`Tool ${COPY} failed for run ${run.runId}`]);
	});

	test("an operation sends at most one write", async () => {
		const server = withMode("two-writes");
		const run = await start(server, WRITER);
		expect((await run.ok(COPY, copy())).result).toEqual(appliedWithoutResult());
		expect(server.posts()).toBe(1);
	});

	test("records of undeclared kinds or other connections are dropped", async () => {
		const server = withMode("foreign-record");
		const run = await start(server, { "*": ["read"] });
		const outcome = await run.ok("mixed_list_folders", {});
		expect(outcome.result.items.map((item) => item.id)).toEqual(["inbox", "archive", "secret"]);
		expect(run.log.errors).toHaveLength(2);
	});

	test("wildcard grants cover resources the user never listed", async () => {
		const server = new FakeServer();
		const run = await start(server, { "*": ["read"], archive: ["create"] });
		server.folders.new = "New";
		expect((await run.ok(COPY, copy("new"))).result.count).toBe(1);
		expect(await run.code(COPY, copy("inbox", "inbox"))).toBe("POLICY_DENIED");
	});
});

describe("write accounting", () => {
	test.each([
		[409, "PROVIDER_REJECTED", "Mixed rejected this request."],
		[429, "PROVIDER_RATE_LIMITED", "Mixed is rate limiting requests. Try again later."],
		[403, "PROVIDER_FORBIDDEN", "Mixed refused this request for the connected account."],
		// The platform's own refusal of a fetch: the request never left.
		["platform", "PROVIDER_FORBIDDEN", "Mixed refused this request for the connected account."],
	] as [WriteResponse, string, string][])("a refused write is forgotten and can be retried (%s)", async (response, code, message) => {
		const server = withMode("ok", [response]);
		const run = await start(server, WRITER);
		expect(await run.error(COPY, copy())).toEqual({ code, message });
		expect(run.paused()).toBe(false);
		expect(run.writes()).toEqual([]);
		expect((await run.ok(COPY, copy())).result.count).toBe(1);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
	});

	test.each([500, 502, 418, 302, "transport", "lost", "hang"] as WriteResponse[])("a write with an unknown outcome pauses writes (%s)", async (response) => {
		// A transport error is unknown even when the connection never opened: fetch cannot tell. "hang" is
		// an answer that never comes.
		const server = withMode("ok", [response]);
		server.timeout = 0.05;
		const run = await start(server, WRITER);
		expect(await run.error(COPY, copy())).toEqual({
			code: "WRITE_UNCERTAIN",
			message: "The write outcome is unknown. Check the provider; further writes in this run are paused.",
		});
		expect(run.paused()).toBe(true);
		expect(run.writes().map((write) => write.status)).toEqual(["uncertain"]);
		expect(await run.error(COPY, copy())).toEqual({ code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." });
		expect(await run.error(COPY, copy("inbox", "archive", "b"))).toEqual({
			code: "WRITE_UNCERTAIN",
			message: "A previous write has an unknown outcome. Further writes in this run are paused.",
		});
		expect(server.posts()).toBe(1);
	});

	test.each([500, "hang"] as WriteResponse[])("a connector cannot hide an unknown write outcome (%s)", async (response) => {
		const server = withMode("swallow-errors", [response]);
		server.timeout = 0.05;
		const run = await start(server, WRITER);
		expect(await run.code(COPY, copy())).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
	});

	test.each(["swallow-errors", "no-write"] as const)("a write that sent nothing or was refused is forgotten (%s)", async (mode) => {
		const server = withMode(mode, [409]);
		const run = await start(server, WRITER);
		expect((await run.ok(COPY, copy())).result.count).toBe(0);
		expect(run.paused()).toBe(false);
		expect(run.writes()).toEqual([]);
	});

	test("a write applied without a readable result counts and is remembered", async () => {
		const server = withMode("ok", ["bad-json"]);
		const run = await start(server, WRITER);
		expect((await run.ok(COPY, copy())).result).toEqual(appliedWithoutResult());
		const again = await run.ok(COPY, copy());
		expect(again.result).toEqual(appliedWithoutResult());
		expect(again.repeat).toBe(true);
		expect(run.paused()).toBe(false);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
		expect(server.posts()).toBe(1);
		expect((await run.ok(COPY, copy("inbox", "archive", "b"))).result.count).toBe(1);
	});

	test("writes run one at a time", async () => {
		const server = new FakeServer();
		server.gate = new Gate();
		const run = await start(server, WRITER);
		const inFlight = run.call(COPY, copy());
		await server.received.promise;
		expect(await run.error(COPY, copy())).toEqual({ code: "WRITE_IN_PROGRESS", message: "An identical write is already in progress." });
		expect(await run.error(COPY, copy("inbox", "archive", "b"))).toEqual({ code: "WRITE_IN_PROGRESS", message: "Another write in this run is still in progress." });
		server.gate.resolve();
		expect((await inFlight).ok).toBe(true);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
	});

	test("a cancelled call answers at once, and its write still settles with its real outcome", async () => {
		// The call
		// stops (ARCHITECTURE.md: Writes, "even if the tool call that asked for it was cancelled") and the request goes on.
		const server = new FakeServer();
		server.gate = new Gate();
		const run = await start(server, WRITER);
		const abort = new AbortController();
		const inFlight = run.call(COPY, copy(), { signal: abort.signal });
		await server.received.promise;
		abort.abort(new Error("stopped"));
		await expect(inFlight).rejects.toThrow("stopped");
		expect(run.writes().map((write) => write.status)).toEqual(["dispatched"]);
		expect(run.waits).toHaveLength(1);
		server.gate.resolve();
		await run.executor.settled();
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
		expect(run.paused()).toBe(false);
		// Nothing of the cancelled call was recorded.
		expect(run.events).toEqual([]);
	});

	test("a cancelled call's write that never answers is uncertain once its request times out", async () => {
		const server = withMode("ok", ["hang"]);
		server.timeout = 0.05;
		const run = await start(server, WRITER);
		const abort = new AbortController();
		const inFlight = run.call(COPY, copy(), { signal: abort.signal });
		await server.received.promise;
		abort.abort(new Error("stopped"));
		await expect(inFlight).rejects.toThrow("stopped");
		await run.executor.settled();
		expect(run.writes().map((write) => write.status)).toEqual(["uncertain"]);
		expect(run.paused()).toBe(true);
	});

	test("a call cancelled before its write was sent sends nothing and forgets the write", async () => {
		const server = new FakeServer();
		const run = await start(server, WRITER);
		const abort = new AbortController();
		const dispatch = run.state.dispatchWrite.bind(run.state);
		run.state.dispatchWrite = (fence, key) => {
			const result = dispatch(fence, key);
			abort.abort(new Error("stopped"));
			return result;
		};
		await expect(run.call(COPY, copy(), { signal: abort.signal })).rejects.toThrow("stopped");
		await run.executor.settled();
		expect(server.posts()).toBe(0);
		expect(run.writes()).toEqual([]);
	});

	test("a claim that answers later (the Conversation waits out pi's transactions): nothing is sent before it, and it settles as usual", async () => {
		const server = new FakeServer();
		const run = await start(server, WRITER);
		const asked = new Gate();
		const answer = new Gate();
		const dispatch = run.state.dispatchWrite.bind(run.state);
		const settle = run.state.settleWrite.bind(run.state);
		const port = run.state as RunStatePort;
		port.dispatchWrite = async (fence, key) => {
			asked.resolve();
			await answer.promise;
			return dispatch(fence, key);
		};
		port.settleWrite = async (runId, key, settlement) => {
			await Promise.resolve();
			settle(runId, key, settlement);
		};
		const call = run.ok(COPY, copy());
		await asked.promise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect([server.posts(), run.writes()]).toEqual([0, []]);
		answer.resolve();
		await call;
		await run.executor.settled();
		expect(server.posts()).toBe(1);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
	});

	test("a write is not sent without time to finish", async () => {
		const server = new FakeServer();
		const run = await start(server, WRITER);
		run.runs.set(run.runId, { deadline: run.clock.now() + 1500 });
		expect(await run.error(COPY, copy())).toEqual({ code: "TIMED_OUT", message: "The write was not sent because its time ran out." });
		expect(server.posts()).toBe(0);
		expect(run.writes()).toEqual([]);
	});

	test("time spent after dispatch counts against the write", async () => {
		const server = new FakeServer();
		const run = await start(server, WRITER);
		run.runs.set(run.runId, { deadline: run.clock.now() + 3000 });
		const current = run.state.isCurrent.bind(run.state);
		// Slow only once the write is dispatched.
		run.state.isCurrent = (fence) => {
			if (run.ledger.writes(run.runId).length > 0) run.clock.advance(1500);
			return current(fence);
		};
		expect(await run.code(COPY, copy())).toBe("TIMED_OUT");
		expect(server.posts()).toBe(0);
	});

	test("a rejected token marks the connection, but a forbidden request does not", async () => {
		const server = withMode("ok", [403]);
		const run = await start(server, WRITER);
		await run.call(COPY, copy());
		expect(run.credentials.status(MIXED)).toBe("active");
		server.writeResponses = [401];
		expect(await run.error(COPY, copy())).toEqual({ code: "CONNECTION_UNAUTHORIZED", message: "The Mixed connection is no longer authorized." });
		expect(run.credentials.status(MIXED)).toBe("error");
		expect(run.writes()).toEqual([]);
	});

	test("a write cannot be sent after its attempt was judged", async () => {
		const server = withMode("late-write");
		const run = await start(server, WRITER);
		expect((await run.ok(COPY, copy())).result.count).toBe(0);
		expect(run.writes()).toEqual([]);
		server.lateGate.resolve();
		// The call is over, so its client is closed too; http-client.test.ts has the attempt judged alone.
		await expect(server.late).rejects.toThrow(ProgrammingError);
		expect(server.posts()).toBe(0);
	});
});

/** A connector whose one read runs `hook` in prepare, for what happens around open_client. */
function hookedConnector(hook: () => Promise<void>): Connector {
	const Input = z.strictObject({});
	return {
		...mixedConnector(new FakeServer()),
		slug: "hooked",
		name: "Hooked",
		operations: [
			defineOperation<z.output<typeof Input>>({
				name: "poke",
				title: "Poke",
				description: "Runs the hook.",
				input: Input,
				needs: [[FOLDER, "read"]],
				async prepare(): Promise<Prepared> {
					await hook();
					throw new Error("unreachable");
				},
			}),
		],
	};
}

describe("credentials", () => {
	test("a rejection of replaced credentials does not mark the connection; a wrapped one does", async () => {
		let run: Scenario | null = null;
		let hook = async () => {};
		const connector = hookedConnector(() => hook());
		const registry = await Registry.create([connector]);
		run = await Scenario.start({
			registry,
			connectors: [connector],
			connections: [{ id: MIXED, provider: "hooked", payload: { kind: "oauth2", access_token: "t", refresh_token: null, scopes: null } }],
			user: userGrants(MIXED, FOLDER, { "*": ["read"] }),
			fetch: new FakeServer().fetch,
		});
		const scenario = run;
		hook = async () => {
			scenario.credentials.replace(MIXED, { kind: "oauth2", access_token: "fresh", refresh_token: null, scopes: null });
			throw new OperationError("CONNECTION_UNAUTHORIZED", "stale");
		};
		expect(await scenario.code("hooked_poke", {})).toBe("CONNECTION_UNAUTHORIZED");
		expect(scenario.credentials.status(MIXED)).toBe("active");
		hook = async () => {
			throw new OperationError("PROVIDER_FAILED", "wrapped", { cause: new OperationError("CONNECTION_UNAUTHORIZED", "current") });
		};
		expect(await scenario.code("hooked_poke", {})).toBe("PROVIDER_FAILED");
		expect(scenario.credentials.status(MIXED)).toBe("error");
		// A connection in error leases nothing: the next call says to reconnect.
		expect(await scenario.error("hooked_poke", {})).toEqual({ code: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." });
	});
});

describe("consent, exposure and contract changes", () => {
	test("tools need provider consent", async () => {
		const server = new FakeServer();
		const labels = { inbox: ["read"] };
		const red: [string, string, string[]][] = [[LABEL, "red", ["read"]]];
		const run = await start(server, labels, red);
		expect(run.tools).toContain("mixed_list_labels");
		run.credentials.replace(MIXED, { kind: "oauth2", access_token: "t", refresh_token: null, scopes: ["files"] });
		expect(await run.error("mixed_list_labels", {})).toEqual({
			code: "CONSENT_REQUIRED",
			message: "Mixed has not given Minerva access for this yet. The user can allow it on Minerva's connections page.",
		});
		expect(server.calls).not.toContainEqual(["GET", "/labels"]);
		expect((await start(server, labels, red, ["files"])).tools).not.toContain("mixed_list_labels");
		expect((await start(server, labels, red, null)).tools).toContain("mixed_list_labels");
	});

	test("a tool whose contract changed stops working", async () => {
		const server = new FakeServer();
		const run = await Scenario.start({
			connectors: [mixedConnector(server)],
			connections: [mixedConnection()],
			user: userGrants(MIXED, FOLDER, { inbox: ["read"] }),
			fetch: server.fetch,
			editTools: (tools) => tools.map((tool) => (tool.name === "mixed_list_folders" ? { ...tool, contract: "stale" } : tool)),
		});
		const outcome = await run.call("mixed_list_folders", {});
		expect(outcome.ok ? null : outcome.error).toEqual({ code: "OPERATION_CHANGED", message: "This operation changed after the run started. Send a new message to use it." });
		expect(server.calls).toEqual([]);
		// The label still names the operation, and the refusal counts as denied.
		expect(outcome.event).toMatchObject({ label: "Mixed: List folders", decision: "denied", code: "OPERATION_CHANGED" });
		const blank = await Scenario.start({
			connectors: [mixedConnector(server)],
			connections: [mixedConnection()],
			user: userGrants(MIXED, FOLDER, { inbox: ["read"] }),
			fetch: server.fetch,
			editTools: (tools) => tools.map((tool) => ({ ...tool, contract: "" })),
		});
		expect(blank.executor.declarations()).toEqual([]);
	});
});

describe("API keys and the account kind", () => {
	test("account grants cover account operations", async () => {
		const server = new FakeServer();
		const run = await Scenario.start({
			connectors: [mixedConnector(server), keyedConnector(server)],
			connections: [keyedConnection()],
			user: userGrants(KEYED, ACCOUNT_KIND, { [KEYED]: ["read"] }),
			fetch: server.fetch,
		});
		const outcome = await run.ok("keyed_whoami", {});
		expect(outcome.result.items).toEqual([{ id: "acct-1", name: "Fake account" }]);
	});
});
