// A run's `run.settled` in local workerd (docs/plans/chunk-14a-design.md, Decisions): written once by the run's settlement
// job, after its `run.finished` and every settlement of its calls, with totals equal to the sums of its call and script
// records and of the spans its Sandbox kept. The Conversation runs with the test build's ports (src/faults/), for its fault
// points; its Sandbox is the real object, which has no containers here, so its spans are written into its SQLite.

import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Fact, StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { sandboxObject } from "../../src/addressing.ts";
import { callPrice, pricesOf } from "../../src/budget/prices.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts } from "../../src/faults/ports.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { HARD_GRACE_MS } from "../../src/sandbox/constants.ts";
import { commands, held, objectOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	PORTS.factory = () => faultConversationPorts(defaultPorts);
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
});

afterEach(() => {
	uninstall();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		let value: T | undefined;
		try {
			value = await read();
		} catch {
			// A reset object refuses the call that was in flight; the next one reaches its new instance.
		}
		if (value !== undefined && done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(25);
	}
}

/** An answer that streams for about ten seconds, so the run stays running until it is cancelled. */
const SLOW = JSON.stringify({ fake: { turns: [{ text: "a".repeat(160) }], chunkChars: 8, delayMs: 500 } satisfies FakeScript });

/** A start Laravel holds, in a new conversation whose plan has `faults`; not sent. */
async function startWith(content: string, faults: Fault[] = []): Promise<StartRun> {
	const start = held(fake, startOf(scope(), { message: { id: uuid7(), content, attachments: [] } }));
	if (faults.length) await objectOf(start).faultPlan(faults);
	return start;
}

/** The conversation's Sandbox object, where its spans are kept. */
function sandboxOf(start: StartRun) {
	return sandboxObject(env, exports, { id: start.scope.workspace, jurisdiction: "eu" }, start.conversation);
}

/** A span of the run's in its Sandbox: from `startedAt`, with its lease, and ended (destroyed) at `endedAt` unless null. */
async function addSpan(start: StartRun, span: { startedAt: number; leaseUntil: number; endedAt: number | null }): Promise<void> {
	const sandbox = sandboxOf(start);
	// Its first call runs its migrations.
	await sandbox.status();
	await runInDurableObject(sandbox, (_instance, state) => {
		state.storage.sql.exec(
			"INSERT INTO container_spans (incarnation, run_id, attempt, started_at, lease_until, ended_at, ended) VALUES (?, ?, 1, ?, ?, ?, ?)",
			uuid7(),
			start.run,
			span.startedAt,
			span.leaseUntil,
			span.endedAt,
			span.endedAt === null ? null : "destroyed",
		);
	});
}

function runStatus(start: StartRun): Promise<string | null> {
	return runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<{ status: string }>("SELECT status FROM runs WHERE id = ?", start.run).toArray()[0]?.status ?? null);
}

/** One of Laravel's commands that reads nothing, so an object a fault reset starts again and runs its recovery. */
function wake(start: StartRun): Promise<unknown> {
	return commands.replayFacts({ scope: start.scope, conversation: start.conversation, after: 1_000_000_000, limit: 1 });
}

/** The fake's facts of the conversation once it holds the run's fact of `type`. */
function factsUntil(start: StartRun, type: Fact["type"]): Promise<Fact[]> {
	return until(
		async () => {
			await wake(start);
			return fake.facts(start.conversation);
		},
		(facts) => facts.some((fact) => fact.type === type && fact.run === start.run),
	);
}

const ofRun = (start: StartRun, facts: Fact[], type: Fact["type"]) => facts.filter((fact) => fact.type === type && fact.run === start.run);

interface CallRow {
	outcome: string;
	cost_micros: number | null;
	input_tokens: number;
	output_tokens: number;
	cached_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
	[key: string]: SqlStorageValue;
}

/** What the run's call records add up to, as `run.settled` names it. */
async function callSums(start: StartRun) {
	const rows = await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<CallRow>("SELECT * FROM call_records WHERE run_id = ?", start.run).toArray());
	const sum = (outcome: string, column: keyof CallRow) => rows.filter((row) => row.outcome === outcome).reduce((total, row) => total + Number(row[column]), 0);
	return {
		modelCalls: rows.length,
		refusedCalls: rows.filter((row) => row.outcome === "refused").length,
		unmeteredCalls: rows.filter((row) => row.outcome === "unmetered").length,
		inputTokens: sum("reported", "input_tokens"),
		outputTokens: sum("reported", "output_tokens"),
		cachedTokens: sum("reported", "cached_tokens"),
		cacheWriteTokens: sum("reported", "cache_write_tokens"),
		reasoningTokens: sum("reported", "reasoning_tokens"),
		estimatedInputTokens: sum("unmetered", "input_tokens"),
		estimatedOutputTokens: sum("unmetered", "output_tokens"),
		charges: rows.map((row) => row.cost_micros as number),
	};
}

describe("run.settled", () => {
	test("follows run.finished and every settlement fact of its run, once, with the sums of its records and spans, and its charge", async () => {
		const start = await startWith(SLOW);
		await commands.startRun(start);
		await until(() => runStatus(start), (status) => status === "running");
		// Besides pi's own call: a reported, an unmetered and a refused call, and a script that took 1234 ms, recorded and settled
		// by a store of their own; and a container that ran ten seconds. The test build charges the fake model 1 µ$ a token,
		// and time 1 µ$ a millisecond and 1,000 µ$ a script (src/faults/prices.ts).
		const fence = { runId: start.run, attempt: 1 };
		const request = { provider: "fake", model: "fake-1", reserved: { input: 10, output: 5 } };
		const prices = await pricesOf(env);
		const at = Date.now();
		await runInDurableObject(objectOf(start), (_instance, state) => {
			const store = new RunStore(state.storage, () => at);
			const settle = (settlement: Parameters<RunStore["settleModelCall"]>[2]) =>
				store.settleModelCall(start.run, store.recordModelCall(fence, request, callPrice(prices, request.provider, request.model)) as string, settlement);
			settle({ outcome: "reported", tokens: { input: 7, output: 3, cached: 2, cacheWrite: 1, reasoning: 4 }, requestBytes: null });
			settle({ outcome: "unmetered", cause: "stopped", requestBytes: null });
			settle({ outcome: "refused", requestBytes: null });
			store.recordScript({ ...fence, scriptId: "script" }, 60_000);
			store.endScript("script", at + 1234, prices);
		});
		await addSpan(start, { startedAt: at - 10_000, leaseUntil: at + 3_600_000, endedAt: at });
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });

		const facts = await factsUntil(start, "run.settled");
		const [settled, ...more] = ofRun(start, facts, "run.settled");
		expect(more).toEqual([]);
		expect(facts.at(-1)).toBe(settled);
		const calls = [...ofRun(start, facts, "run.usage"), ...ofRun(start, facts, "run.unmetered")];
		for (const earlier of [...calls, ...ofRun(start, facts, "run.finished")]) expect(earlier.seq).toBeLessThan(settled?.seq as number);
		const sums = await callSums(start);
		expect(sums).toMatchObject({ modelCalls: 4, refusedCalls: 1, unmeteredCalls: 1, estimatedInputTokens: 10, estimatedOutputTokens: 5, cachedTokens: 2, cacheWriteTokens: 1, reasoningTokens: 4 });
		expect(calls).toHaveLength(sums.modelCalls);
		// Each call at 1 µ$ a token of its counted input and output (none for the refusal), as its fact says.
		const charges = calls.map((fact) => (fact.data as { costMicros?: number }).costMicros);
		const ascending = (a: number | undefined, b: number | undefined) => (a ?? -1) - (b ?? -1);
		expect(charges.toSorted(ascending)).toEqual(sums.charges.toSorted(ascending));
		const modelMicros = sums.inputTokens + sums.outputTokens + sums.estimatedInputTokens + sums.estimatedOutputTokens;
		expect(sums.charges.reduce((total, charge) => total + charge, 0)).toBe(modelMicros);
		const { charges: _charges, ...totals } = sums;
		expect(settled?.data).toEqual({
			...totals,
			containers: 1,
			containerMs: 10_000,
			containerEstimated: false,
			scripts: 1,
			scriptMs: 1234,
			scriptEstimated: false,
			prices: prices.version,
			modelMicros,
			containerMicros: 10_000,
			scriptMicros: 2_234,
			chargedMicros: modelMicros + 10_000 + 2_234,
		});
		const row = await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec("SELECT metered, settled_at, spent FROM runs WHERE id = ?", start.run).one());
		// What was spent before the run settled: its calls and its script, not its container time.
		expect(row).toEqual({ metered: 1, settled_at: expect.any(Number), spent: modelMicros + 2_234 });
	});

	test("waits for a call the end cut, and follows its settlement", async () => {
		// The call's answer is held before its settlement; the run is cancelled meanwhile.
		const start = await startWith("Hello", [{ point: "model:settle", mode: "hold" }]);
		await commands.startRun(start);
		await until(() => objectOf(start).faultFired(), (fired) => fired.some((entry) => entry.point === "model:settle"));
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		await factsUntil(start, "run.finished");
		await sleep(1000);
		expect(ofRun(start, fake.facts(start.conversation), "run.settled")).toEqual([]);

		await objectOf(start).faultRelease("model:settle");
		const facts = await factsUntil(start, "run.settled");
		const [finished] = ofRun(start, facts, "run.finished");
		const [usage] = ofRun(start, facts, "run.usage");
		const [settled] = ofRun(start, facts, "run.settled");
		// The call settled after the run ended, and the totals came after it.
		expect(finished?.seq).toBeLessThan(usage?.seq as number);
		expect(usage?.seq).toBeLessThan(settled?.seq as number);
		expect(settled?.data).toMatchObject({ modelCalls: 1, inputTokens: (usage?.data as { inputTokens: number }).inputTokens });
	});

	test("waits for a span still open, and charges one past its cutoff to the cutoff, estimated", async () => {
		const start = await startWith("Hello");
		// A container of the run's that was never seen to stop: its lease's cutoff comes three seconds from now.
		const now = Date.now();
		const leaseUntil = now + 3000 - HARD_GRACE_MS;
		await addSpan(start, { startedAt: now - 60_000, leaseUntil, endedAt: null });
		await commands.startRun(start);
		await factsUntil(start, "run.finished");
		expect(ofRun(start, fake.facts(start.conversation), "run.settled")).toEqual([]);

		const facts = await factsUntil(start, "run.settled");
		expect(Date.now()).toBeGreaterThanOrEqual(leaseUntil + HARD_GRACE_MS);
		expect(ofRun(start, facts, "run.settled")[0]?.data).toMatchObject({ containers: 1, containerMs: 63_000, containerEstimated: true });
	});

	test("is not due while a script record of the run is open; a script the restart rule ended counts as estimated", async () => {
		const start = await startWith("Hello");
		await commands.startRun(start);
		await factsUntil(start, "run.settled");
		// The run's settlement taken back, with a script a gone instance left open, all in one step the job cannot enter.
		const at = Date.now();
		const prices = await pricesOf(env);
		const steps = await runInDurableObject(objectOf(start), (_instance, state) => {
			const store = new RunStore(state.storage, () => at + 5000);
			const sql = state.storage.sql;
			sql.exec("UPDATE runs SET settled_at = NULL WHERE id = ?", start.run);
			sql.exec("INSERT INTO script_records (script_id, run_id, instance, started_at, timeout_ms) VALUES ('script', ?, 'gone', ?, 2000)", start.run, at);
			const open = store.settlement(start.run).state;
			const refused = store.settleRun(start.run, { containers: 0, containerMs: 0, containerEstimated: false }, prices);
			store.settleLost(prices);
			const due = store.settlement(start.run).state;
			const written = store.settleRun(start.run, { containers: 0, containerMs: 0, containerEstimated: false }, prices);
			const fact = JSON.parse(sql.exec<{ fact: string }>("SELECT fact FROM facts ORDER BY seq DESC LIMIT 1").one().fact) as Fact;
			return { open, refused, due, written, fact, again: store.settleRun(start.run, { containers: 0, containerMs: 0, containerEstimated: false }, prices) };
		});
		expect(steps).toMatchObject({ open: "open", refused: false, due: "due", written: true, again: false });
		// Charged as it ended: 1,000 µ$ and 1 µ$ a millisecond.
		expect(steps.fact).toMatchObject({ type: "run.settled", data: { scripts: 1, scriptMs: 2000, scriptEstimated: true, scriptMicros: 3_000 } });
	});

	test("a run the conversation's deletion ended still settles", async () => {
		const start = await startWith(SLOW);
		await commands.startRun(start);
		await until(() => runStatus(start), (status) => status === "running");
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const facts = await factsUntil(start, "run.settled");
		expect(ofRun(start, facts, "run.finished")[0]?.data).toMatchObject({ status: "cancelled" });
		expect(ofRun(start, facts, "run.settled")[0]?.data).toMatchObject({ modelCalls: 1, containers: 0 });
	});

	test("a settlement job lost with a reset is made again by the next instance, which settles the call it left as lost", async () => {
		const start = await startWith("Hello", [{ point: "model:settle", mode: "hold" }]);
		await commands.startRun(start);
		await until(() => objectOf(start).faultFired(), (fired) => fired.some((entry) => entry.point === "model:settle"));
		await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" });
		await factsUntil(start, "run.finished");
		await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec("DELETE FROM cf_agents_jobs WHERE id = ?", `settle:${start.run}`));
		await abortAllDurableObjects();

		const facts = await factsUntil(start, "run.settled");
		expect(ofRun(start, facts, "run.unmetered").map((fact) => fact.data)).toMatchObject([{ cause: "lost" }]);
		expect(ofRun(start, facts, "run.settled")[0]?.data).toMatchObject({ modelCalls: 1, unmeteredCalls: 1, inputTokens: 0, estimatedInputTokens: 128_000 });
	});

	test("a reset inside the job, before or after its write, leaves one run.settled, and the job ends", async () => {
		const start = await startWith("Hello", [
			{ point: "settle:sealed", mode: "abort" },
			{ point: "settle:written", mode: "abort" },
		]);
		await commands.startRun(start);
		const facts = await factsUntil(start, "run.settled");
		expect((await until(() => objectOf(start).faultFired(), (fired) => fired.length === 2)).map((entry) => entry.point)).toEqual(["settle:sealed", "settle:written"]);
		// The job the second reset cut runs again and finds the run settled.
		await until(
			async () => {
				await wake(start);
				return objectOf(start).faultJobs();
			},
			(jobs) => !jobs.some((job) => job.id === `settle:${start.run}`),
			40_000,
		);
		expect(ofRun(start, facts, "run.settled")).toHaveLength(1);
		const written = await runInDurableObject(objectOf(start), (_instance, state) =>
			state.storage.sql.exec("SELECT count(*) AS count FROM facts WHERE run_id = ? AND json_extract(fact, '$.type') = 'run.settled'", start.run).one(),
		);
		expect(written).toEqual({ count: 1 });
	}, 60_000);

	test("a run started without metering, as by an older version, owes none", async () => {
		const first = await startWith(SLOW);
		await commands.startRun(first);
		await until(() => runStatus(first), (status) => status === "running");
		await runInDurableObject(objectOf(first), (_instance, state) => state.storage.sql.exec("UPDATE runs SET metered = 0 WHERE id = ?", first.run));
		await commands.cancelRun({ scope: first.scope, conversation: first.conversation, run: first.run, reason: "cancelled" });
		await factsUntil(first, "run.finished");
		// A new instance's recovery schedules no settlement for it either.
		await abortAllDurableObjects();
		const second = held(fake, startOf(first.scope, { conversation: first.conversation, message: { id: uuid7(), content: "Hello", attachments: [] } }));
		await commands.startRun(second);
		const facts = await factsUntil(second, "run.settled");
		expect(ofRun(first, facts, "run.settled")).toEqual([]);
		expect((await objectOf(first).faultJobs()).map((job) => job.id)).not.toContain(`settle:${first.run}`);
		const row = await runInDurableObject(objectOf(first), (_instance, state) => state.storage.sql.exec("SELECT metered, settled_at FROM runs WHERE id = ?", first.run).one());
		expect(row).toEqual({ metered: 0, settled_at: null });
	});
});
