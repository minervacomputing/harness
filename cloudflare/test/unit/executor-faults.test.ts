// The plan's fault cases for writes (docs/plans/cloudflare.md, Testing: "applied then response lost;
// claimed then never sent; crash while dispatched; the same write under a new pi call id; deadline
// passed"), through the executor and the real ledger. A crash is a Conversation Durable Object that loses
// everything in memory: its executor and promises are gone and the ledger is reopened over the same
// database file, where the restart gate marks the dead instance's dispatched writes uncertain in the
// transaction of its decision (plan: Attempts and recovery, Writes).

import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type Connector, OperationError, type Prepared, defineOperation } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { ProviderHTTP } from "../../src/gateway/http.ts";
import { WRITE_MESSAGES, writeKey } from "../../src/gateway/ledger.ts";
import { appliedWithoutResult } from "../../src/gateway/results.ts";
import { record } from "../../src/lib/schema.ts";
import { FOLDER, FakeServer, Gate, MIXED, Scenario, mixedConnection, mixedConnector, userGrants } from "./executor-fakes.ts";
import { ledgerSql, openDatabase, scratchDirectory } from "./sqlite.ts";

const COPY = "mixed_copy_file";
const WRITER = { inbox: ["read"], archive: ["read", "create"] };
const scratch = scratchDirectory();
afterAll(() => scratch.done());
afterEach(() => {
	vi.useRealTimers();
});

function copy(name = "a") {
	return { source: "inbox", dest: "archive", name };
}

function start(server: FakeServer, extra: Partial<Parameters<typeof Scenario.start>[0]> = {}) {
	return Scenario.start({
		connectors: [mixedConnector(server)],
		connections: [mixedConnection()],
		user: userGrants(MIXED, FOLDER, WRITER),
		fetch: server.fetch,
		...extra,
	});
}

let files = 0;

/** An instance that dies while `during` runs, and the one that starts after it over the same database. */
async function crash(during: (before: Scenario, server: FakeServer) => Promise<void>, server = new FakeServer()) {
	const path = `${scratch.path}/conversation-${++files}.sqlite`;
	const db = openDatabase(path);
	const before = await start(server, { sql: ledgerSql(db) });
	await during(before, server);
	// The instance is gone: what it held in memory too, so nothing it started can settle any more.
	db.close();
	const after = await start(server, { sql: ledgerSql(openDatabase(path)), registry: before.registry });
	return { before, after, server };
}

/** The restart gate's decision: the attempt goes up and the dead instance's dispatched writes become uncertain, together. */
function restart(run: Scenario) {
	return run.sql.transaction(() => {
		const lost = run.ledger.markDispatchedUncertain(run.runId);
		run.replace();
		return lost;
	});
}

describe("writes under faults", () => {
	test("a call cancelled after its write was sent: the caller hears at once, and `settled` gets the write's real outcome", async () => {
		const server = new FakeServer();
		server.gate = new Gate();
		const run = await start(server);
		const abort = new AbortController();
		const settled: ToolCallOutcome[] = [];
		const call = run.call(COPY, copy(), { signal: abort.signal, settled: (outcome) => settled.push(outcome) });
		await server.received.promise;
		abort.abort(new Error("pi aborted the call"));
		await expect(call).rejects.toThrow("pi aborted the call");
		expect(settled).toEqual([]);
		server.gate.resolve();
		await run.executor.settled();
		// The write id is an HMAC (WebCrypto), so the outcome comes a few turns after the settle.
		for (let turn = 0; turn < 50 && settled.length === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(settled).toEqual([expect.objectContaining({ ok: true, event: expect.objectContaining({ decision: "allowed", write: expect.any(String) }) })]);
		expect(run.writes()).toEqual([expect.objectContaining({ status: "succeeded" })]);
	});

	test("applied, then the response lost: uncertain, the run paused, never sent twice", async () => {
		const server = new FakeServer();
		server.writeResponses = ["lost"];
		const run = await start(server);
		expect(await run.error(COPY, copy())).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.unknown });
		expect(server.copies).toHaveLength(1);
		expect(await run.error(COPY, copy())).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain });
		expect(await run.error(COPY, copy("b"))).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
		expect(server.posts()).toBe(1);
		expect(run.events.map((event) => event.decision)).toEqual(["denied", "denied", "denied"]);
	});

	test("claimed, then the instance died before sending: uncertain after the restart, since nothing can tell", async () => {
		const { after, server } = await crash(async (before) => {
			const key = await writeKey(COPY, copy());
			expect(before.state.dispatchWrite(before.fence(), key).kind).toBe("dispatched");
		});
		expect(restart(after)).toHaveLength(1);
		expect(await after.error(COPY, copy())).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain });
		expect(await after.error(COPY, copy("b"))).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
		expect(server.posts()).toBe(0);
	});

	test("claimed, then the attempt replaced before sending: forgotten, nothing sent", async () => {
		const server = new FakeServer();
		const run = await start(server);
		const dispatch = run.state.dispatchWrite.bind(run.state);
		run.state.dispatchWrite = (fence, key) => {
			const result = dispatch(fence, key);
			run.replace();
			return result;
		};
		expect(await run.code(COPY, copy())).toBe("RUN_ENDED");
		expect([server.posts(), run.writes()]).toEqual([0, []]);
	});

	test("a crash while a write is dispatched: the new attempt's same write is refused, and others pause", async () => {
		const { after, server } = await crash(async (before, provider) => {
			provider.writeResponses = ["hang"];
			provider.timeout = 0.05;
			void before.call(COPY, copy());
			await provider.received.promise;
		});
		expect(after.writes()).toMatchObject([{ status: "dispatched", attempt: 1 }]);
		// Until the gate has decided, the write still holds the run's one slot for writes.
		expect(await after.error(COPY, copy("b"))).toEqual({ code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress });
		expect(restart(after).map((lost) => lost.runId)).toEqual([after.runId]);
		expect(await after.error(COPY, copy())).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain });
		expect(await after.error(COPY, copy("b"))).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
		// The model reads what to do; the user's chat shows the refusals as not allowed.
		expect(after.events.map((event) => event.decision)).toEqual(["denied", "denied", "denied"]);
		expect(server.posts()).toBe(1);
	});

	test("a lost settle with no restart: the alarm's sweep marks the write 30 s past its deadline", async () => {
		const { after } = await crash(async (before) => {
			before.state.dispatchWrite(before.fence(), await writeKey(COPY, copy()));
		});
		after.clock.advance(60_000 + 30_000);
		expect(after.ledger.sweep()).toEqual([]);
		after.clock.advance(1);
		expect(after.ledger.sweep()).toHaveLength(1);
		expect(after.paused()).toBe(true);
		expect(await after.code(COPY, copy("b"))).toBe("WRITE_UNCERTAIN");
	});

	test("applied, then its result cannot be stored: still recorded as applied, never left dispatched", async () => {
		const server = new FakeServer();
		const sql = ledgerSql();
		let refuse = true;
		const failing = {
			...sql,
			exec: <T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]): T[] => {
				if (refuse && query.includes("SET status = 'succeeded'") && !String(bindings[0]).includes("applied_without_result")) throw new Error("string or blob too big");
				return sql.exec<T>(query, ...bindings);
			},
		};
		const run = await start(server, { sql: failing });
		const outcome = await run.ok(COPY, copy());
		expect(outcome.result.count).toBe(1);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
		refuse = false;
		expect((await run.ok(COPY, copy())).result).toEqual(appliedWithoutResult());
		expect([run.paused(), server.posts()]).toEqual([false, 1]);
		expect(run.log.warnings).toEqual([`The result of a write in run ${run.runId} could not be stored`]);
	});

	test("the same write under a new pi call id is answered from the record, whatever spelling the model uses", async () => {
		// After an interrupted write, the model retried it under a new call id (plan: Spike results); the
		// key is over the normalized fields, so stripped strings are the same write. (A strict object is
		// rebuilt in its schema's order, so the order of its fields never reaches the key; see below.)
		const server = new FakeServer();
		const run = await start(server);
		const first = await run.ok(COPY, copy());
		const retried = await run.ok(COPY, { name: " a ", dest: "archive ", source: "\tinbox" });
		expect([retried.repeat, retried.writeKey]).toEqual([true, first.writeKey]);
		expect(retried.result).toEqual(first.result);
		expect(server.posts()).toBe(1);
	});

	test("free-form fields sent in another order make the same write: the key is sorted at every depth", async () => {
		// A record keeps the order its keys were sent in through validation, so only the canonical key makes
		// these one write.
		const server = new FakeServer();
		const run = await Scenario.start({
			connectors: [taggedConnector(server)],
			connections: [{ ...mixedConnection(), provider: "tagged" }],
			user: userGrants(MIXED, FOLDER, { archive: ["read", "create"] }),
			fetch: server.fetch,
		});
		const first = await run.ok("tagged_tag", { dest: "archive", tags: { a: "1", b: "2" } });
		const retried = await run.ok("tagged_tag", { tags: { b: "2", a: " 1" }, dest: "archive" });
		expect([retried.repeat, retried.writeKey]).toEqual([true, first.writeKey]);
		expect(server.posts()).toBe(1);
	});

	test("the same write while the first is in flight is refused, then answered once it settled", async () => {
		const server = new FakeServer();
		server.gate = new Gate();
		const run = await start(server);
		const inFlight = run.call(COPY, copy());
		await server.received.promise;
		expect(await run.error(COPY, copy())).toEqual({ code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.identicalInProgress });
		server.gate.resolve();
		expect((await inFlight).ok).toBe(true);
		expect((await run.ok(COPY, copy())).repeat).toBe(true);
		expect(server.posts()).toBe(1);
	});
});

describe("deadlines", () => {
	test("a run past its deadline starts nothing", async () => {
		const server = new FakeServer();
		const run = await start(server);
		run.clock.advance(300_000);
		expect(await run.code(COPY, copy())).toBe("RUN_ENDED");
		expect([server.calls, run.runs.toolCalls(run.runId), run.writes()]).toEqual([[], 0, []]);
	});

	test("a write whose run passes its deadline while the provider applies it is recorded; the call gets RUN_ENDED", async () => {
		const server = new FakeServer();
		const fetch = server.fetch;
		let run: Scenario | null = null;
		const late: typeof globalThis.fetch = async (input, init) => {
			if (init?.method === "POST") run?.clock.advance(300_000);
			return fetch(input, init);
		};
		run = await start(server, { fetch: late });
		expect(await run.code(COPY, copy())).toBe("RUN_ENDED");
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
		expect(run.events).toEqual([]);
	});

	test("a write with under 2 s left is not sent and is forgotten", async () => {
		const server = new FakeServer();
		const run = await start(server, { deadline: null });
		run.runs.set(run.runId, { deadline: run.clock.now() + 1999 });
		expect(await run.code(COPY, copy())).toBe("TIMED_OUT");
		expect([server.posts(), run.writes()]).toEqual([0, []]);
		run.runs.set(run.runId, { deadline: run.clock.now() + 2000 });
		expect((await run.ok(COPY, copy())).result.count).toBe(1);
	});
});

/** A connector whose write takes free-form tags, a record whose keys keep the order they were sent in. */
function taggedConnector(server: FakeServer): Connector {
	const base = mixedConnector(server);
	const Input = z.strictObject({ dest: z.string().trim().min(1).max(40), tags: record(z.string().trim().max(40), { max: 10 }) });
	return {
		...base,
		slug: "tagged",
		name: "Tagged",
		operations: [
			defineOperation<z.output<typeof Input>>({
				name: "tag",
				title: "Tag",
				description: "Saves a copy with tags.",
				input: Input,
				needs: [[FOLDER, "create"]],
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.resource(FOLDER, data.dest), action: "create" }],
						async execute() {
							await http.json({ method: "POST", path: "/copies", json: { source: "inbox", dest: data.dest, name: JSON.stringify(data.tags) } });
							return { records: [] };
						},
					};
				},
			}),
		],
	};
}

/** A connector whose write ignores the client's timeout: after its request it waits forever. */
function stubbornConnector(server: FakeServer, swallow: boolean): Connector {
	const base = mixedConnector(server);
	const Input = z.strictObject({ name: z.string().trim().min(1) });
	return {
		...base,
		slug: "stubborn",
		name: "Stubborn",
		operations: [
			defineOperation<z.output<typeof Input>>({
				name: "save",
				title: "Save",
				description: "Saves, then hangs.",
				input: Input,
				needs: [[FOLDER, "create"]],
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.resource(FOLDER, "archive"), action: "create" }],
						async execute() {
							try {
								await http.json({ method: "POST", path: "/copies", json: { source: "inbox", dest: "archive", name: data.name } });
							} catch (error) {
								if (!swallow || !(error instanceof OperationError)) throw error;
							}
							return new Promise(() => {});
						},
					};
				},
			}),
		],
	};
}

describe("the backstop", () => {
	async function stubborn(swallow: boolean, responses: FakeServer["writeResponses"]) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const server = new FakeServer();
		server.writeResponses = responses;
		const connector = stubbornConnector(server, swallow);
		const run = await Scenario.start({
			connectors: [connector],
			connections: [{ ...mixedConnection(), provider: "stubborn" }],
			user: userGrants(MIXED, FOLDER, { archive: ["read", "create"] }),
			fetch: server.fetch,
		});
		const outcome = run.call("stubborn_save", { name: "a" });
		await server.received.promise;
		// The write's window is 60 s; the backstop cuts the connector off 5 s after it.
		await vi.advanceTimersByTimeAsync(64_000);
		expect(run.writes().map((write) => write.status)).toEqual(["dispatched"]);
		await vi.advanceTimersByTimeAsync(1_000);
		return { run, server, outcome: await outcome };
	}

	test("a connector that hangs after its write was applied: applied without a result", async () => {
		const { run, outcome } = await stubborn(false, [200]);
		expect(outcome.ok && outcome.result).toEqual(appliedWithoutResult());
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded"]);
	});

	test("a connector that swallows its request's timeout and hangs: uncertain", async () => {
		const { run, server, outcome } = await stubborn(true, ["hang"]);
		expect(outcome.ok ? null : outcome.error.code).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
		expect(server.posts()).toBe(1);
	});
});
