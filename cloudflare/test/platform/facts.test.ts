// A Laravel conversation's credentials, facts and stream in workerd (docs/plans/credentials-and-facts.md): leases from the
// fake Laravel, the facts its runs write, delivered in order and acknowledged, replayed, bounded, and Laravel's run stream
// with a stream token.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Fact, StartRun } from "@minerva/contract/internal";
import { SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { BACKLOG_MESSAGE, FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { EXPIRED, MIN_LEASE_MS, UNAVAILABLE, laravelCredentials } from "../../src/conversation/laravel-runs.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { RunStore, type RunSnapshot } from "../../src/conversation/store.ts";
import { RUN_ENDED_MESSAGE } from "../../src/gateway/ledger.ts";
import { createApp } from "../../src/http/router.ts";
import { LARAVEL_NETWORK } from "../../src/laravel/client.ts";
import { base64url } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { routeOf } from "../../src/model/route.ts";
import { type Prices, priceTable, pricesOf } from "../../src/budget/prices.ts";
import { settings } from "../../src/config.ts";
import { STREAM_TIMING, openSocket } from "../../src/stream/relay.ts";
import { STREAM_AUDIENCE, STREAM_PURPOSE } from "../../src/stream/token.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { ORIGIN, commands, held, objectOf, refusalOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";

signedAssertions();

const TOKEN = "test-laravel-token";
/** A table with no route's prices: the calls a test records itself are not charged. */
const UNPRICED: Prices = { version: "0000000000000000", table: priceTable(null) };
const DELIVERY = { ...FACT_DELIVERY };
let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	PORTS.factory = () => ({ ...defaultPorts, upstream: () => fakeUpstream() });
});

beforeEach(() => {
	fake = new FakeLaravel(TOKEN);
	uninstall = fake.install({ withToken: true });
	// A failed delivery is tried again within a test's time.
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 8000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(20);
	}
}

/** An answer that streams for about ten seconds, so the run stays running until it is cancelled. */
const SLOW = JSON.stringify({ fake: { turns: [{ text: "a".repeat(160) }], chunkChars: 8, delayMs: 500 } satisfies FakeScript });

async function runStatus(start: StartRun): Promise<string | null> {
	return runInDurableObject(objectOf(start), (_instance, state) => {
		const rows = state.storage.sql.exec<{ status: string }>("SELECT status FROM runs WHERE id = ?", start.run).toArray();
		return rows[0]?.status ?? null;
	});
}

function settled(start: StartRun): Promise<string | null> {
	return until(
		() => runStatus(start),
		(status) => status !== null && !["queued", "provisioning", "running"].includes(status),
	);
}

interface DeliveryRow {
	written: number;
	acknowledged: number;
	indexed: number;
	failures: number;
	next_at: number;
	stopped: string | null;
	[key: string]: SqlStorageValue;
}

function deliveryOf(start: StartRun): Promise<DeliveryRow> {
	return runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<DeliveryRow>("SELECT * FROM fact_delivery").one());
}

/** The fake's facts of the conversation once it holds the run's `last` fact: its `run.finished`, or its `run.settled`. */
function delivered(start: StartRun, last: "run.finished" | "run.settled" = "run.finished"): Promise<Fact[]> {
	return until(
		() => fake.facts(start.conversation),
		(facts) => facts.some((fact) => fact.type === last && fact.run === start.run),
	);
}

const deliveries = () => fake.calls.filter((call) => call.operation === "deliverFacts").length;

describe("facts", () => {
	test("a run's facts reach Laravel in order, each once, ending with run.finished and its totals, run.settled", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		expect(await settled(start)).toBe("completed");
		const facts = await delivered(start, "run.settled");
		expect(facts.map((fact) => fact.seq)).toEqual(facts.map((_fact, index) => index + 1));
		expect(facts.every((fact) => fact.run === start.run)).toBe(true);
		const types = facts.map((fact) => fact.type);
		expect(types[0]).toBe("run.status");
		expect(types.slice(-2)).toEqual(["run.finished", "run.settled"]);
		expect(facts.filter((fact) => fact.type === "run.status").map((fact) => fact.data)).toEqual([
			{ status: "provisioning", attempt: 1 },
			{ status: "running", attempt: 1 },
		]);
		const usage = facts.find((fact) => fact.type === "run.usage");
		expect(usage?.data).toMatchObject({ call: expect.stringMatching(/^[0-9a-f]{8}$/), inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
		expect(facts.at(-2)?.data).toMatchObject({ status: "completed", error: "", message: { id: expect.any(String), content: expect.any(String) } });

		const delivery = await deliveryOf(start);
		expect(delivery).toMatchObject({ written: facts.length, acknowledged: facts.length, failures: 0, next_at: 0, stopped: null });
		expect(delivery.indexed).toBeGreaterThanOrEqual(facts.length);
		const index = await env.DB.prepare("SELECT fact_seq FROM recovery_conversations WHERE id = ?").bind(start.conversation).first("fact_seq");
		expect(index).toBe(delivery.indexed);
	});

	test("a delivery Laravel fails is tried again after a backoff, and loses nothing", async () => {
		fake.failDeliveries = 2;
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const facts = await delivered(start);
		expect(facts.map((fact) => fact.seq)).toEqual(facts.map((_fact, index) => index + 1));
		expect(deliveries()).toBeGreaterThanOrEqual(3);
		expect(await deliveryOf(start)).toMatchObject({ acknowledged: facts.length, failures: 0, next_at: 0 });
	});

	test("a gap sends again from Laravel's watermark, as after Laravel was restored from a backup", async () => {
		const first = held(fake, startOf(scope()));
		await commands.startRun(first);
		await settled(first);
		const before = await delivered(first);
		fake.restore(first.conversation, 1);
		const second = held(fake, startOf(first.scope, { conversation: first.conversation }));
		await commands.startRun(second);
		await settled(second);
		const facts = await delivered(second);
		expect(facts.map((fact) => fact.seq)).toEqual(facts.map((_fact, index) => index + 1));
		expect(facts.slice(0, before.length)).toEqual(before);
	});

	test("a conflict stops the delivery for the operator, retried hourly", async () => {
		const first = held(fake, startOf(scope()));
		await commands.startRun(first);
		await settled(first);
		await delivered(first);
		// The engine's first fact no longer matches Laravel's, and the engine sends from the start again.
		await runInDurableObject(objectOf(first), (_instance, state) => {
			state.storage.sql.exec("UPDATE facts SET fact = json_set(fact, '$.data.attempt', 2) WHERE seq = 1");
			state.storage.sql.exec("UPDATE fact_delivery SET acknowledged = 0");
		});
		const second = held(fake, startOf(first.scope, { conversation: first.conversation }));
		await commands.startRun(second);
		await settled(second);
		const delivery = await until(
			() => deliveryOf(first),
			(row) => row.stopped !== null,
		);
		expect(delivery.stopped).toContain("FACT_CONFLICT");
		expect(delivery.next_at - Date.now()).toBeGreaterThan(FACT_DELIVERY.conflictRetryMs - 60_000);
	});

	test("a backlog past its bound refuses a start until Laravel catches up", async () => {
		FACT_DELIVERY.backlog = 1;
		fake.failDeliveries = 1_000_000;
		const first = held(fake, startOf(scope()));
		await commands.startRun(first);
		await settled(first);
		const second = held(fake, startOf(first.scope, { conversation: first.conversation }));
		expect(await commands.startRun(second)).toEqual({ outcome: "refused", code: "FACTS_BACKLOG", message: BACKLOG_MESSAGE });
		fake.failDeliveries = 0;
		await delivered(first);
		await until(
			() => deliveryOf(first),
			(row) => row.acknowledged === row.written,
		);
		const third = held(fake, startOf(first.scope, { conversation: first.conversation }));
		expect(await commands.startRun(third)).toMatchObject({ outcome: "accepted" });
		await settled(third);
	});
});

describe("model call settlements", () => {
	interface Settled {
		facts: Fact[];
		records: { call: string; outcome: string; cause: string | null; input_tokens: number; output_tokens: number }[];
		run: { model_calls: number; input_tokens: number; output_tokens: number; unmetered_model_calls: number };
	}

	/** A run whose one model call answers `turn`, once it ended: its settlement facts, its call records and its sums. */
	async function oneCall(turn: FakeScript["turns"][number]): Promise<Settled> {
		const start = held(fake, startOf(scope(), { message: { id: uuid7(), content: JSON.stringify({ fake: { turns: [turn] } }), attachments: [] } }));
		await commands.startRun(start);
		await settled(start);
		const facts = (await delivered(start)).filter((fact) => fact.type === "run.usage" || fact.type === "run.unmetered");
		return runInDurableObject(objectOf(start), (_instance, state) => ({
			facts,
			records: state.storage.sql.exec<Settled["records"][number]>("SELECT call, outcome, cause, input_tokens, output_tokens FROM call_records WHERE run_id = ?", start.run).toArray(),
			run: state.storage.sql.exec<Settled["run"]>("SELECT model_calls, input_tokens, output_tokens, unmetered_model_calls FROM runs WHERE id = ?", start.run).one(),
		}));
	}

	const { provider, cap } = routeOf(settings(env));
	/** The test build charges the fake model 1 µ$ a token (src/faults/prices.ts). */
	const charged = async (costMicros: number) => ({ costMicros, prices: (await pricesOf(env)).version });

	test("a reported call gives one run.usage, with its route and tokens, and adds them to the run's sums", async () => {
		const { facts, records, run } = await oneCall({ text: "Hi", usage: { input: 7, output: 3 } });
		const call = records[0]?.call;
		expect(call).toMatch(/^[0-9a-f]{8}$/);
		expect(facts.map((fact) => [fact.type, fact.data])).toEqual([
			["run.usage", { call, provider, model: "fake-1", inputTokens: 7, outputTokens: 3, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...(await charged(10)) }],
		]);
		expect(records).toEqual([{ call, outcome: "reported", cause: null, input_tokens: 7, output_tokens: 3 }]);
		expect(run).toEqual({ model_calls: 1, input_tokens: 7, output_tokens: 3, unmetered_model_calls: 0 });
	});

	test("an answer without usage gives one run.unmetered at the call's reservation, estimated", async () => {
		const { facts, records, run } = await oneCall({ text: "Hi", usage: null });
		const call = records[0]?.call;
		expect(facts.map((fact) => [fact.type, fact.data])).toEqual([
			["run.unmetered", { call, provider, model: "fake-1", cause: "no_usage", inputTokens: 128_000, outputTokens: cap, estimated: true, ...(await charged(128_000 + cap)) }],
		]);
		expect(records).toEqual([{ call, outcome: "unmetered", cause: "no_usage", input_tokens: 128_000, output_tokens: cap }]);
		expect(run).toEqual({ model_calls: 1, input_tokens: 0, output_tokens: 0, unmetered_model_calls: 1 });
	});

	test("a refused call (a 4xx) gives one run.unmetered at no tokens, not estimated; a 502 one at its reservation", async () => {
		const refusal = await oneCall({ refused: { status: 429 } });
		const call = refusal.records[0]?.call;
		expect(refusal.facts.map((fact) => [fact.type, fact.data])).toEqual([
			["run.unmetered", { call, provider, model: "fake-1", cause: "refused", inputTokens: 0, outputTokens: 0, estimated: false, ...(await charged(0)) }],
		]);
		expect(refusal.records).toEqual([{ call, outcome: "refused", cause: null, input_tokens: 0, output_tokens: 0 }]);
		expect(refusal.run).toEqual({ model_calls: 1, input_tokens: 0, output_tokens: 0, unmetered_model_calls: 0 });

		const failure = await oneCall({ refused: { status: 502 } });
		expect(failure.facts.map((fact) => [fact.type, fact.data])).toEqual([
			["run.unmetered", { call: failure.records[0]?.call, provider, model: "fake-1", cause: "failed", inputTokens: 128_000, outputTokens: cap, estimated: true, ...(await charged(128_000 + cap)) }],
		]);
		expect(failure.run).toEqual({ model_calls: 1, input_tokens: 0, output_tokens: 0, unmetered_model_calls: 1 });
	});

	test("a call settles once, also after its run ended; a record for an attempt that cannot act is refused and counts nothing", async () => {
		const start = held(fake, startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } }));
		await commands.startRun(start);
		await until(() => runStatus(start), (status) => status === "running");
		const fence = { runId: start.run, attempt: 1 };
		const request = { provider, model: "fake-1", reserved: { input: 10, output: 5 } };
		// Recorded by a store other than the live instance's, which its run's settlement would settle as lost: the run owes none.
		const call = await runInDurableObject(objectOf(start), (_instance, state) => {
			state.storage.sql.exec("UPDATE runs SET metered = 0 WHERE id = ?", start.run);
			return new RunStore(state.storage).recordModelCall(fence, request, UNPRICED);
		});
		expect(call).toMatch(/^[0-9a-f]{8}$/);
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		await delivered(start);
		// pi's own call, cut by the cancel, settles on its own; only the one recorded here stays open.
		const open = () => runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<{ call: string }>("SELECT call FROM call_records WHERE outcome IS NULL").toArray().map((row) => row.call));
		await until(open, (calls) => calls.length === 1 && calls[0] === call);
		const after = await runInDurableObject(objectOf(start), (_instance, state) => {
			const store = new RunStore(state.storage);
			const sql = state.storage.sql;
			const before = sql.exec<{ count: number }>("SELECT count(*) AS count FROM facts").one().count;
			store.settleModelCall(start.run, call as string, { outcome: "unmetered", cause: "stopped", requestBytes: 321 });
			store.settleModelCall(start.run, call as string, { outcome: "reported", tokens: { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: null });
			const refused = store.recordModelCall(fence, request, UNPRICED);
			return {
				refused,
				written: sql.exec<{ fact: string }>("SELECT fact FROM facts WHERE seq > ? ORDER BY seq", before).toArray().map((row) => JSON.parse(row.fact) as Fact),
				record: sql.exec("SELECT outcome, cause, input_tokens, output_tokens, request_bytes FROM call_records WHERE run_id = ? AND call = ?", start.run, call).one(),
				counts: sql.exec("SELECT (SELECT count(*) FROM call_records WHERE run_id = ?1) AS records, model_calls, unmetered_model_calls FROM runs WHERE id = ?1", start.run).one(),
			};
		});
		expect(after.refused).toBeNull();
		expect(after.written.map((fact) => [fact.type, fact.data])).toEqual([
			["run.unmetered", { call, provider, model: "fake-1", cause: "stopped", inputTokens: 10, outputTokens: 5, estimated: true, requestBytes: 321 }],
		]);
		expect(after.record).toEqual({ outcome: "unmetered", cause: "stopped", input_tokens: 10, output_tokens: 5, request_bytes: 321 });
		// pi's call (its answer had started, and the fake reports usage on a cut stream) and the one recorded here; the
		// refused record counted nothing.
		expect(after.counts).toEqual({ records: 2, model_calls: 2, unmetered_model_calls: 1 });
	});

	test("the restart rule settles every call and script another instance left open, once, and none of its own", async () => {
		const start = held(fake, startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } }));
		await commands.startRun(start);
		await until(() => runStatus(start), (status) => status === "running");
		const fence = { runId: start.run, attempt: 1 };
		const request = { provider, model: "fake-1", reserved: { input: 10, output: 5 } };
		const script = (scriptId: string) => ({ ...fence, scriptId });
		// Two instances' records, as far as the rule can tell: `mine` stands for the instance that recovers. Of the gone
		// instance's scripts, one started long enough ago that its clock ran out.
		let mine: RunStore | undefined;
		const recorded = Date.now();
		let clock = recorded;
		const [gone, own] = await runInDurableObject(objectOf(start), (_instance, state) => {
			// The live instance's own run.settled job would settle both instances' records as lost: the run owes none.
			state.storage.sql.exec("UPDATE runs SET metered = 0 WHERE id = ?", start.run);
			mine = new RunStore(state.storage, () => clock);
			const other = new RunStore(state.storage);
			new RunStore(state.storage, () => recorded - 5_000).recordScript(script("expired"), 1_000);
			other.recordScript(script("cut"), 60_000);
			mine.recordScript(script("own"), 60_000);
			return [other.recordModelCall(fence, request, UNPRICED), mine.recordModelCall(fence, request, UNPRICED)];
		});
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		const open = () => runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<{ call: string }>("SELECT call FROM call_records WHERE outcome IS NULL ORDER BY call").toArray().map((row) => row.call));
		await until(open, (calls) => calls.length === 2);
		const prices = await pricesOf(env);
		const after = await runInDurableObject(objectOf(start), (_instance, state) => {
			const sql = state.storage.sql;
			const before = sql.exec<{ count: number }>("SELECT count(*) AS count FROM facts").one().count;
			const settledAt = (clock = Date.now());
			const settled = [mine?.settleLost(prices), mine?.settleLost(prices)];
			// An end that comes after the rule ended a record changes nothing.
			mine?.endScript("expired", settledAt, prices);
			// The run ended: a script it would start now is refused, and nothing is recorded.
			const refused = mine?.recordScript(script("late"), 60_000);
			return {
				settled,
				refused,
				written: sql.exec<{ fact: string }>("SELECT fact FROM facts WHERE seq > ? ORDER BY seq", before).toArray().map((row) => JSON.parse(row.fact) as Fact),
				records: sql.exec("SELECT call, outcome, cause, input_tokens, output_tokens, request_bytes FROM call_records WHERE run_id = ? AND call IN (?, ?) ORDER BY call = ?", start.run, gone, own, own).toArray(),
				scripts: sql
					.exec<{ script_id: string; started_at: number; ended_at: number | null; estimated: number }>(
						"SELECT script_id, started_at, ended_at, estimated FROM script_records WHERE run_id = ? ORDER BY script_id",
						start.run,
					)
					.toArray()
					.map(({ script_id, started_at, ended_at, estimated }) => ({ script_id, lasted: ended_at === null ? null : ended_at - started_at, endedAt: ended_at, estimated })),
				settledAt,
			};
		});
		expect(after.settled).toEqual([3, 0]);
		expect(after.refused).toBe(false);
		// Ended at their clock's bound, or when the rule ran if that came first; this instance's own stays open.
		expect(after.scripts).toEqual([
			{ script_id: "cut", lasted: expect.any(Number), endedAt: after.settledAt, estimated: 1 },
			{ script_id: "expired", lasted: 1_000, endedAt: recorded - 4_000, estimated: 1 },
			{ script_id: "own", lasted: null, endedAt: null, estimated: 0 },
		]);
		expect(after.written.map((fact) => [fact.type, fact.data])).toEqual([["run.unmetered", { call: gone, provider, model: "fake-1", cause: "lost", inputTokens: 10, outputTokens: 5, estimated: true }]]);
		expect(after.records).toEqual([
			{ call: gone, outcome: "unmetered", cause: "lost", input_tokens: 10, output_tokens: 5, request_bytes: null },
			{ call: own, outcome: null, cause: null, input_tokens: null, output_tokens: null, request_bytes: null },
		]);
	});
});

describe("replayFacts", () => {
	test("pages through the conversation's facts, as delivered", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const facts = await delivered(start, "run.settled");
		const named = { scope: start.scope, conversation: start.conversation };
		expect(await commands.replayFacts({ ...named, after: 0, limit: 500 })).toEqual({ conversation: start.conversation, facts, more: false });
		expect(await commands.replayFacts({ ...named, after: 1, limit: 1 })).toEqual({ conversation: start.conversation, facts: [facts[1]], more: true });
		expect(await commands.replayFacts({ ...named, after: facts.length, limit: 10 })).toEqual({ conversation: start.conversation, facts: [], more: false });
	});

	test("refuses a conversation it does not know, or under another scope", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		expect(await refusalOf(commands.replayFacts({ scope: start.scope, conversation: uuid7(), after: 0, limit: 10 }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		for (const other of [{ ...start.scope, organization: uuid7() }, { ...start.scope, workspace: uuid7() }]) {
			expect(await refusalOf(commands.replayFacts({ scope: other, conversation: start.conversation, after: 0, limit: 10 }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		}
	});
});

describe("leases", () => {
	const engineEnv = { ...env, MINERVA_LARAVEL_TOKEN: TOKEN } as Env;

	function port(run: string, current: () => boolean = () => true) {
		const within = scope();
		const conversation = uuid7();
		fake.conversations.set(conversation, within);
		const connection = uuid7();
		fake.runs.set(run, { scope: within, conversation, active: true, authorized: [connection] });
		const snapshot = { tools: [{ connection_id: connection, provider: "todoist" }] } as unknown as RunSnapshot;
		const logged: string[] = [];
		const credentials = laravelCredentials({
			env: engineEnv,
			scope: { organization: within.organization, workspace: within.workspace },
			conversation,
			snapshot,
			isCurrent: current,
			log: (message, error) => logged.push(error instanceof Error ? `${message}: ${error.message}` : message),
		});
		return { credentials, connection, logged };
	}

	test("a lease holds the credential Laravel lent, and a report names the lease's attempt", async () => {
		const run = uuid7();
		const { credentials, connection } = port(run);
		fake.connections.set(connection, { kind: "oauth2", secret: "an access token", scopes: ["data:read"], generation: 4, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: "active" });
		const fence = { runId: run, attempt: 2 };
		const lease = await credentials.lease(fence, connection);
		expect(lease).toEqual({
			connectionId: connection,
			provider: "todoist",
			generation: 4,
			scopes: ["data:read"],
			payload: { kind: "oauth2", access_token: "an access token", refresh_token: null, scopes: ["data:read"] },
		});
		await credentials.markUnauthorized(connection, 4, fence);
		expect(fake.connections.get(connection)?.status).toBe("error");
		expect(fake.calls.at(-1)).toEqual({ operation: "reportUnauthorized", run, connection });
		expect(await credentials.lease(fence, connection)).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
	});

	test("Laravel's refusals reach the model as the engine's own messages", async () => {
		const run = uuid7();
		const { credentials, connection, logged } = port(run);
		fake.connections.set(connection, { kind: "api_key", secret: "a key", scopes: null, generation: 1, expiresAt: null, status: "active" });
		const fence = { runId: run, attempt: 1 };
		expect(await credentials.lease(fence, uuid7())).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: UNAVAILABLE });
		expect(logged.join("\n")).toContain("not authorized");
		fake.runs.get(run)!.active = false;
		expect(await credentials.lease(fence, connection)).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED_MESSAGE });
		// An error's text is Laravel's: only its code and status are logged.
		LARAVEL_NETWORK.fetch = () => async () => Response.json({ defined: true, code: "FORBIDDEN", status: 403, message: "Echoed SECRET_MARKER" }, { status: 403 });
		expect(await credentials.lease(fence, connection)).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: UNAVAILABLE });
		expect(logged.at(-1)).toContain("FORBIDDEN (HTTP 403)");
		expect(logged.join("\n")).not.toContain("SECRET_MARKER");
	});

	test("a held lease reads the run once it is let go, not when it arrived", async () => {
		const run = uuid7();
		const { credentials, connection } = port(run);
		fake.connections.set(connection, { kind: "api_key", secret: "a key", scopes: null, generation: 1, expiresAt: null, status: "active" });
		const release = fake.holdLeases(run);
		const lease = credentials.lease({ runId: run, attempt: 1 }, connection);
		// Only the run's own calls: the earlier tests' objects may still be delivering facts.
		await until(
			() => fake.calls.filter((call) => call.run === run),
			(calls) => calls.length === 1,
		);
		fake.runs.get(run)!.active = false;
		release();
		expect(await lease).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED_MESSAGE });
	});

	test("a fence that is no longer current is refused without asking", async () => {
		const run = uuid7();
		const { credentials, connection } = port(run, () => false);
		expect(await credentials.lease({ runId: run, attempt: 1 }, connection)).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED_MESSAGE });
		expect(fake.calls).toEqual([]);
	});

	test("a token about to expire is asked for once more, then refused", async () => {
		const run = uuid7();
		const { credentials, connection } = port(run);
		fake.connections.set(connection, { kind: "oauth2", secret: "a token", scopes: null, generation: 1, expiresAt: new Date(Date.now() + MIN_LEASE_MS / 2).toISOString(), status: "active" });
		expect(await credentials.lease({ runId: run, attempt: 1 }, connection)).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: UNAVAILABLE });
		expect(fake.calls.filter((call) => call.operation === "leaseToken")).toHaveLength(2);
	});

	test("a Laravel that fails is asked twice more, then the call is refused", async () => {
		const run = uuid7();
		const { credentials, connection } = port(run);
		fake.connections.set(connection, { kind: "api_key", secret: "a key", scopes: null, generation: 1, expiresAt: null, status: "active" });
		let failures = 2;
		// Only the leases fail: the earlier tests' objects may still be delivering facts.
		LARAVEL_NETWORK.fetch = () => async (input, init) => {
			const lease = new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/leases");
			return lease && failures-- > 0 ? new Response("<html>Bad gateway</html>", { status: 502 }) : fake.fetch(input, init);
		};
		expect(await credentials.lease({ runId: run, attempt: 1 }, connection)).toMatchObject({ payload: { kind: "api_key", key: "a key" } });
		failures = 3;
		const { credentials: other, connection: second } = port(run);
		expect(await other.lease({ runId: run, attempt: 1 }, second)).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: UNAVAILABLE });
	});
});

describe("Laravel's run stream", () => {
	const KEY = new Uint8Array(32).fill(7);
	const streamEnv = { ...env, MINERVA_STREAM_KEYS: `s1:${base64url(KEY, { pad: false })}` } as Env;
	const LARAVEL = env.MINERVA_LARAVEL_URL;

	function token(start: StartRun, change: { org?: string; exp?: number } = {}): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({
			aud: STREAM_AUDIENCE,
			purpose: STREAM_PURPOSE,
			env: "test",
			org: change.org ?? start.scope.organization,
			conversation: start.conversation,
			run: start.run,
		})
			.setProtectedHeader({ alg: "HS256", kid: "s1" })
			.setIssuedAt(now)
			.setExpirationTime(change.exp ?? now + 300)
			.sign(KEY);
	}

	async function get(headers: Record<string, string>, init: RequestInit = {}, on: Env = streamEnv): Promise<Response> {
		return await createApp().fetch(new Request(`${ORIGIN}/stream/v1`, { headers: { Origin: LARAVEL, ...headers }, ...init }), on);
	}

	async function read(response: Response, timeout = 8000): Promise<string> {
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		let text = "";
		const started = Date.now();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text;
			text += value;
			if (Date.now() - started > timeout) throw new Error(`The stream did not end: ${text}`);
		}
	}

	const TIMING = { ...STREAM_TIMING };

	afterEach(() => {
		Object.assign(STREAM_TIMING, TIMING);
	});

	interface Frame {
		id?: string;
		event?: string;
		data?: string;
		comment?: string;
	}

	/** An SSE response read frame by frame, as EventSource parses it. */
	class Sse {
		readonly response: Response;
		#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
		readonly #decoder = new TextDecoder();
		#buffer = "";
		#done = false;
		/** Why the response broke off, if it did (an aborted response), rather than ending. */
		failure: unknown = null;

		constructor(response: Response) {
			this.response = response;
		}

		get #body(): ReadableStreamDefaultReader<Uint8Array> {
			this.#reader ??= (this.response.body as ReadableStream<Uint8Array>).getReader();
			return this.#reader;
		}

		/** The next frame or comment, or null once the response ended. */
		async next(timeout = 15_000): Promise<Frame | null> {
			const deadline = Date.now() + timeout;
			for (;;) {
				const split = this.#buffer.indexOf("\n\n");
				if (split >= 0) {
					const block = this.#buffer.slice(0, split);
					this.#buffer = this.#buffer.slice(split + 2);
					const frame: Frame = {};
					for (const line of block.split("\n")) {
						if (line.startsWith(":")) frame.comment = line.slice(1).trim();
						else {
							const colon = line.indexOf(":");
							const name = line.slice(0, colon) as "id" | "event" | "data";
							frame[name] = line.slice(colon + 1).replace(/^ /, "");
						}
					}
					return frame;
				}
				if (this.#done) return null;
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`No frame within ${timeout} ms; buffered: ${this.#buffer.slice(0, 200)}`);
				let chunk: ReadableStreamReadResult<Uint8Array> | null;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					chunk = await Promise.race([this.#body.read(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), left)))]);
				} catch (error) {
					this.failure = error;
					this.#done = true;
					continue;
				} finally {
					clearTimeout(timer);
				}
				if (chunk === null) continue;
				if (chunk.done) this.#done = true;
				else this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
			}
		}

		/** Every frame up to the end of the response or its break (comments left out). */
		async rest(): Promise<Frame[]> {
			const frames: Frame[] = [];
			for (let frame = await this.next(); frame !== null; frame = await this.next()) if (frame.comment === undefined) frames.push(frame);
			return frames;
		}

		cancel(): Promise<void> {
			return this.#body.cancel();
		}
	}

	/** The run's stream with a token Laravel signed, from `lastEventId` when the browser sends one. */
	async function sse(start: StartRun, lastEventId?: string, change: { exp?: number } = {}): Promise<Sse> {
		const headers: Record<string, string> = { Authorization: `Bearer ${await token(start, change)}` };
		if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
		return new Sse(await get(headers));
	}

	function eventsOf(frames: Frame[]) {
		return frames.filter((frame) => frame.event !== "end").map((frame) => ({ seq: Number(frame.id), type: frame.event, data: JSON.parse(frame.data as string) }));
	}

	/** Adds `count` text deltas of `size` characters (1 MiB unless given) to a finished run, as a long answer would leave them. */
	async function addEvents(start: StartRun, count: number, size = 1024 * 1024): Promise<void> {
		const big = "x".repeat(size);
		await runInDurableObject(objectOf(start), (_instance, state) => {
			for (let i = 0; i < count; i++) {
				const seq = state.storage.sql.exec<{ event_seq: number }>("UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq", start.run).one().event_seq;
				state.storage.sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)", start.run, seq, "text_delta", JSON.stringify({ text: big, call: "0badc0de" }), Date.now());
			}
		});
	}

	/** A start whose fake model answers with `script`, which Laravel holds; not sent. */
	function answering(script: FakeScript): StartRun {
		return held(fake, startOf(scope(), { message: { id: uuid7(), content: JSON.stringify({ fake: script }), attachments: [] } }));
	}

	const eventCount = async (start: StartRun) => (await viewOf(objectOf(start), start.run)).events.length;

	test("streams a run's events with a token, and ends with the run", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const response = await get({ Authorization: `Bearer ${await token(start)}` });
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(LARAVEL);
		expect(response.headers.get("Vary")).toContain("Origin");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		const text = await read(response);
		expect(text).toMatch(/^id: 1\nevent: /);
		expect(text.endsWith("event: end\ndata: {}\n\n")).toBe(true);
		// From the last event the browser took.
		const last = Number([...text.matchAll(/^id: (\d+)$/gm)].at(-1)?.[1]);
		const resumed = await read(await get({ Authorization: `Bearer ${await token(start)}`, "Last-Event-ID": String(last) }));
		expect(resumed).toBe("event: end\ndata: {}\n\n");
	});

	test("closes at the token's expiry, without the end, so the browser resumes with a new token", async () => {
		const start = held(fake, startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } }));
		await commands.startRun(start);
		const exp = Math.floor(Date.now() / 1000) + 2;
		const response = await get({ Authorization: `Bearer ${await token(start, { exp })}` });
		expect(response.status).toBe(200);
		const text = await read(response);
		expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000);
		expect(text).not.toContain("event: end");
		expect(await runStatus(start)).toBe("running");
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		await settled(start);
	});

	test("a token that does not verify is 401, readable from Laravel's pages; another organization's is 404", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		for (const authorization of [undefined, "Bearer nonsense", `Basic ${await token(start)}`]) {
			const response = await get(authorization === undefined ? {} : { Authorization: authorization });
			expect(response.status, authorization).toBe(401);
			expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(LARAVEL);
		}
		const other = await get({ Authorization: `Bearer ${await token(start, { org: uuid7() })}` });
		expect(other.status).toBe(404);
		expect(other.headers.get("Access-Control-Allow-Origin")).toBe(LARAVEL);
		// Another origin is answered, without CORS: the browser keeps the answer from its page.
		const elsewhere = await get({ Authorization: `Bearer ${await token(start)}`, Origin: "https://elsewhere.example" });
		expect(elsewhere.status).toBe(200);
		expect(elsewhere.headers.get("Access-Control-Allow-Origin")).toBeNull();
		await elsewhere.body?.cancel();
	});

	test("a preflight needs no token; another method is refused; without its keys the route is not there", async () => {
		const preflight = await get({ "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, last-event-id" }, { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(Object.fromEntries([...preflight.headers].filter(([name]) => name.startsWith("access-control-")))).toEqual({
			"access-control-allow-origin": LARAVEL,
			"access-control-allow-methods": "GET",
			"access-control-allow-headers": "Authorization, Last-Event-ID",
			"access-control-max-age": "600",
		});
		const elsewhere = await get({ Origin: "https://elsewhere.example", "Access-Control-Request-Method": "GET" }, { method: "OPTIONS" });
		expect([...elsewhere.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
		expect((await get({}, { method: "POST" })).status).toBe(405);
		expect((await createApp().fetch(new Request(`${ORIGIN}/stream/v2`), streamEnv)).status).toBe(404);
		for (const keys of ["", "malformed"]) {
			const off = await get({}, {}, { ...env, MINERVA_STREAM_KEYS: keys } as Env);
			expect(off.status, keys).toBe(404);
			expect(off.headers.get("Access-Control-Allow-Origin")).toBeNull();
		}
	});

	test("the object lets an organization read its own conversation's runs, never another's", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const stub = objectOf(start);
		const socket = await openSocket(stub, start.run, { organization: start.scope.organization }, 0);
		expect(socket).not.toBeNull();
		socket?.accept();
		socket?.close(1000);
		expect(await openSocket(stub, start.run, { organization: uuid7() }, 0)).toBeNull();
	});

	test("a reconnect resumes after Last-Event-ID: no gaps, no duplicates; one not all digits counts as 0", async () => {
		const start = answering({ chunkChars: 2, delayMs: 25, turns: [{ text: "z".repeat(160) }] });
		await commands.startRun(start);
		const first = await sse(start, "1");
		const seen: Frame[] = [];
		while (seen.length < 4) {
			const frame = await first.next();
			expect(frame).not.toBeNull();
			if (frame?.event) seen.push(frame);
		}
		await first.cancel();
		const rest = await (await sse(start, seen.at(-1)?.id)).rest();
		expect(rest.at(-1)?.event).toBe("end");
		const stored = (await viewOf(objectOf(start), start.run)).events;
		expect(eventsOf([...seen, ...rest])).toEqual(stored.slice(1));
		const replay = eventsOf(await (await sse(start, "x7")).rest());
		expect(replay.map((event) => event.seq)).toEqual(stored.map((event) => event.seq));
		const empty = eventsOf(await (await sse(start, "")).rest());
		expect(empty.map((event) => event.seq)).toEqual(stored.map((event) => event.seq));
	});

	test("a stop during a run: the stream says the run was cancelled, Stopped., then ends; the conversation takes the next start", async () => {
		const start = held(fake, startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } }));
		await commands.startRun(start);
		const stream = await sse(start);
		for (let frame = await stream.next(); frame?.event !== "text_delta"; frame = await stream.next()) expect(frame).not.toBeNull();
		expect(await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" })).toEqual({ state: "cancelled" });
		const rest = await stream.rest();
		expect(rest.at(-1)).toEqual({ event: "end", data: "{}" });
		expect(eventsOf(rest).at(-1)).toMatchObject({ type: "status", data: { status: "cancelled", message: "Stopped." } });
		const next = held(fake, startOf(start.scope, { conversation: start.conversation }));
		expect(await commands.startRun(next)).toMatchObject({ outcome: "accepted" });
		expect(await settled(next)).toBe("completed");
	});

	test("a keepalive comment after silence; the token's expiry then closes the stream cleanly, without the end", async () => {
		STREAM_TIMING.keepaliveMs = 150;
		const start = answering({ chunkChars: 400, delayMs: 3000, turns: [{ text: "w".repeat(400) }] });
		await commands.startRun(start);
		const stream = await sse(start, "1", { exp: Math.floor(Date.now() / 1000) + 2 });
		let frame = await stream.next();
		while (frame !== null && frame.comment === undefined) frame = await stream.next();
		expect(frame).toEqual({ comment: "keepalive" });
		const rest = await stream.rest();
		expect([rest.some((item) => item.event === "end"), stream.failure]).toEqual([false, null]);
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		await settled(start);
	});

	test("a client that does not read is cut off rather than buffered for, and resumes from what it read", async () => {
		STREAM_TIMING.bufferLimit = 64 * 1024;
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const before = await eventCount(start);
		// Each frame is well under the limit; only the ones queued while the client does not read pass it.
		const added = 40;
		await addEvents(start, added, 16 * 1024);
		const stream = await sse(start, "0");
		// Two frames taken, then none for a while: what the relay queued past its limit is dropped, never what was taken.
		const taken = [await stream.next(), await stream.next()] as Frame[];
		await sleep(500);
		const frames = [...taken, ...(await stream.rest())];
		expect(frames.some((frame) => frame.event === "end")).toBe(false);
		const read = eventsOf(frames);
		expect(read.length).toBeGreaterThanOrEqual(2);
		expect(read.length).toBeLessThan(before + added);
		Object.assign(STREAM_TIMING, TIMING);
		const resumed = await (await sse(start, String(read.at(-1)?.seq ?? 0))).rest();
		expect(resumed.at(-1)?.event).toBe("end");
		expect([...read, ...eventsOf(resumed)].map((event) => event.seq)).toEqual(Array.from({ length: before + added }, (_v, i) => i + 1));
	});

	test("a backlog past the object's 4 MiB per socket, and a run past 32 MiB of events, arrive whole", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		const before = await eventCount(start);
		const added = 34;
		await addEvents(start, added);
		const frames = await (await sse(start)).rest();
		expect(frames.at(-1)?.event).toBe("end");
		const events = eventsOf(frames);
		expect(events.map((event) => event.seq)).toEqual(Array.from({ length: before + added }, (_v, i) => i + 1));
		expect(events.slice(before).map((event) => [event.type, event.data.text.length])).toEqual(Array.from({ length: added }, () => ["text_delta", 1024 * 1024]));
	}, 60_000);
});
