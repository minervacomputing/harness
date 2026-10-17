// The facts' retention in local workerd (docs/plans/chunk-15a-design.md, Facts and the floor): the `retain` job on the
// Conversation's alarm deletes a fact only 7 days after Laravel acknowledged it, raising the floor; a replay or a gap from
// below the floor is refused rather than skipping what is gone. The Conversation runs with the test build's ports
// (src/faults/), for the fault point `retain:step`, and its runs answer with the fake model.

import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { RETAIN_JOB, RETENTION } from "../../src/conversation/retention.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts } from "../../src/faults/ports.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { commands, held, objectOf, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

const DELIVERY = { ...FACT_DELIVERY };
const PERIODS = { ...RETENTION };
const DAY = 24 * 60 * 60_000;
let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	PORTS.factory = () => faultConversationPorts(defaultPorts);
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
	Object.assign(RETENTION, PERIODS);
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

/** The next start in the conversation of `after`, or in a new one whose plan has `faults`; Laravel holds it. */
async function next(after: StartRun | null, faults: Fault[] = [], content = "Hello"): Promise<StartRun> {
	const message = { id: uuid7(), content, attachments: [] };
	const start = held(fake, after === null ? startOf(scope(), { message }) : startOf(after.scope, { conversation: after.conversation, message }));
	if (faults.length) await objectOf(start).faultPlan(faults);
	return start;
}

function sql<T>(start: StartRun, query: string, ...bindings: SqlStorageValue[]): Promise<T[]> {
	return runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

interface Delivery {
	written: number;
	acknowledged: number;
	floor: number;
	next_at: number;
	stopped: string | null;
}

async function delivery(start: StartRun): Promise<Delivery> {
	const [row] = await sql<Delivery>(start, "SELECT written, acknowledged, floor, next_at, stopped FROM fact_delivery");
	if (row === undefined) throw new Error("The conversation has no delivery.");
	return row;
}

const heldSeqs = async (start: StartRun) => (await sql<{ seq: number }>(start, "SELECT seq FROM facts ORDER BY seq")).map((row) => row.seq);
const marks = (start: StartRun) => sql<{ seq: number; at: number }>(start, "SELECT seq, at FROM fact_acknowledgements ORDER BY seq");
const retainJob = async (start: StartRun) => (await sql<{ time: number }>(start, "SELECT time FROM cf_agents_jobs WHERE id = ?", RETAIN_JOB))[0]?.time ?? null;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_value, index) => from + index);

/** Waits until the run's `run.settled` is written: the last fact of the run. */
async function settled(start: StartRun): Promise<void> {
	await until(
		() => sql<{ n: number }>(start, "SELECT count(*) AS n FROM facts WHERE run_id = ? AND json_extract(fact, '$.type') = 'run.settled'", start.run),
		([row]) => row?.n === 1,
	);
}

/** Runs the start to its end, its last fact written. */
async function ran(start: StartRun): Promise<void> {
	await commands.startRun(start);
	await settled(start);
}

/** Waits until Laravel acknowledged every fact written. */
function acknowledged(start: StartRun): Promise<Delivery> {
	return until(
		() => delivery(start),
		(row) => row.written > 0 && row.acknowledged === row.written,
	);
}

/** Makes every acknowledgement `ms` older, as if that much time had passed since Laravel gave it. */
async function age(start: StartRun, ms: number): Promise<void> {
	await sql(start, "UPDATE fact_acknowledgements SET at = at - ?", ms);
}

/** Makes the `retain` job due, as if its time had come, and runs the object's alarm. */
async function due(start: StartRun): Promise<void> {
	await runInDurableObject(objectOf(start), async (_instance, state) => {
		state.storage.sql.exec(
			"INSERT INTO cf_agents_jobs (id, capability, fn, time, running) VALUES (?, 'host', ?, 0, 0) ON CONFLICT (id) DO UPDATE SET time = 0, running = 0",
			RETAIN_JOB,
			RETAIN_JOB,
		);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(objectOf(start));
}

/**
 * Runs a pass of the `retain` job and waits until it is over: the job then has a time of its own, or is gone. The alarm set
 * for now can fire on its own before `runDurableObjectAlarm`, which then returns before the pass ends.
 */
async function retain(start: StartRun): Promise<void> {
	await due(start);
	await until(
		() => sql<{ time: number }>(start, "SELECT time FROM cf_agents_jobs WHERE id = ?", RETAIN_JOB),
		(rows) => rows.length === 0 || rows[0]?.time !== 0,
	);
}

describe("facts' retention", () => {
	test("an unacknowledged fact is never pruned, however old; those acknowledged 7 days ago are", async () => {
		const first = await next(null);
		await ran(first);
		const { written } = await acknowledged(first);
		fake.failDeliveries = 1_000_000;
		const second = await next(first);
		await ran(second);
		await sql(first, "UPDATE facts SET created_at = 0");
		await age(first, 30 * DAY);
		await retain(first);

		const after = await delivery(first);
		expect(after).toMatchObject({ acknowledged: written, floor: written + 1 });
		expect(await heldSeqs(first)).toEqual(range(written + 1, after.written));
		expect(await marks(first)).toEqual([]);
		// Nothing is left that Laravel acknowledged: the job is gone until it acknowledges more.
		expect(await retainJob(first)).toBeNull();
	});

	test("an acknowledged fact is kept 7 days after its acknowledgement, not its writing; a late one moves the job earlier", async () => {
		fake.failDeliveries = 1_000_000;
		const start = await next(null);
		await ran(start);
		await sql(start, "UPDATE facts SET created_at = 0");
		await retain(start);
		const { written } = await delivery(start);
		expect([await heldSeqs(start), await retainJob(start)]).toEqual([range(1, written), null]);

		// Due later, as a run's prune would be.
		await runInDurableObject(objectOf(start), (_instance, state) => {
			state.storage.sql.exec("INSERT INTO cf_agents_jobs (id, capability, fn, time, running) VALUES (?, 'host', ?, ?, 0)", RETAIN_JOB, RETAIN_JOB, Date.now() + 30 * DAY);
		});
		const before = Date.now();
		fake.failDeliveries = 0;
		await acknowledged(start);
		const job = await retainJob(start);
		expect(job).toBeGreaterThanOrEqual(before + RETENTION.factsMs);
		expect(job).toBeLessThanOrEqual(Date.now() + RETENTION.factsMs);

		await retain(start);
		await age(start, RETENTION.factsMs - 60_000);
		await retain(start);
		expect(await heldSeqs(start)).toEqual(range(1, written));
		await age(start, 60_000);
		await retain(start);
		expect([await heldSeqs(start), (await delivery(start)).floor]).toEqual([[], written + 1]);
	});

	test("a replay from below the floor less one is refused FACTS_PRUNED with the floor, and one from the floor less one is answered", async () => {
		const first = await next(null);
		await ran(first);
		const { written } = await acknowledged(first);
		await age(first, RETENTION.factsMs);
		await retain(first);
		const second = await next(first);
		await ran(second);
		const all = await acknowledged(second);
		const named = { scope: first.scope, conversation: first.conversation, limit: 500 };

		for (const after of [0, written - 1]) {
			expect(await refusalOf(commands.replayFacts({ ...named, after }))).toEqual({ code: "FACTS_PRUNED", status: 410, data: { floor: written + 1 } });
		}
		const page = await commands.replayFacts({ ...named, after: written });
		expect(page.facts.map((fact) => fact.seq)).toEqual(range(written + 1, all.written));
		expect(page.facts).toEqual(fake.facts(first.conversation).filter((fact) => fact.seq > written));
	});

	test("a FACT_GAP below the floor less one stops the delivery and leaves what was acknowledged; one at it goes on", async () => {
		const pruned = async (): Promise<{ start: StartRun; floor: number }> => {
			const start = await next(null);
			await ran(start);
			const { written } = await acknowledged(start);
			await age(start, RETENTION.factsMs);
			await retain(start);
			return { start, floor: written + 1 };
		};

		// Laravel acknowledged more after the prune, then was restored to below the floor less one.
		const lost = await pruned();
		const kept = await next(lost.start);
		await ran(kept);
		const { written } = await acknowledged(kept);
		fake.restore(lost.start.conversation, lost.floor - 2);
		const late = await next(lost.start);
		await ran(late);
		const stopped = await until(
			() => delivery(lost.start),
			(row) => row.stopped !== null,
		);
		expect(stopped).toMatchObject({
			acknowledged: written,
			floor: lost.floor,
			stopped: `Laravel lost facts up to the floor ${lost.floor}, which the engine no longer holds (FACTS_PRUNED).`,
		});
		expect(stopped.next_at - Date.now()).toBeGreaterThan(FACT_DELIVERY.conflictRetryMs - 60_000);
		expect(fake.facts(lost.start.conversation).map((fact) => fact.seq)).toEqual(range(1, lost.floor - 2));
		// What Laravel lacks and the engine still holds is no longer counted as acknowledged: retention keeps it.
		expect(await marks(lost.start)).toEqual([]);
		await retain(lost.start);
		expect((await heldSeqs(lost.start)).slice(0, written - lost.floor + 1)).toEqual(range(lost.floor, written));

		// Laravel acknowledged more after the prune, then was restored to the floor less one: it is sent again from the floor.
		const resent = await pruned();
		const more = await next(resent.start);
		await ran(more);
		expect((await acknowledged(more)).acknowledged).toBeGreaterThan(resent.floor);
		fake.restore(resent.start.conversation, resent.floor - 1);
		const after = await next(resent.start);
		await ran(after);
		const done = await acknowledged(after);
		expect(done).toMatchObject({ floor: resent.floor, stopped: null });
		expect(fake.facts(resent.start.conversation).map((fact) => fact.seq)).toEqual(range(1, done.written));
	});

	test("an object migrated from step 13 marks what Laravel acknowledged as of the step, and gets its job when it wakes", async () => {
		const start = await next(null);
		await ran(start);
		const { written } = await acknowledged(start);
		await runInDurableObject(objectOf(start), (_instance, state) => {
			state.storage.sql.exec("DELETE FROM cf_agents_jobs WHERE id = ?", RETAIN_JOB);
			state.storage.sql.exec("DROP TABLE fact_acknowledgements");
			state.storage.sql.exec("ALTER TABLE fact_delivery DROP COLUMN floor");
			state.storage.sql.exec("DELETE FROM _migrations WHERE id = 14");
		});
		await abortAllDurableObjects();
		const before = Date.now();
		await commands.replayFacts({ scope: start.scope, conversation: start.conversation, after: written, limit: 1 });

		const [mark] = await marks(start);
		expect(mark?.seq).toBe(written);
		expect(mark?.at).toBeGreaterThanOrEqual(before);
		expect(mark?.at).toBeLessThanOrEqual(Date.now());
		expect((await delivery(start)).floor).toBe(1);
		expect(await until(() => retainJob(start), (time) => time !== null)).toBe((mark?.at ?? 0) + RETENTION.factsMs);
	});

	test("a reset after the first step leaves the floor it committed; the next alarm finishes, and every unacknowledged fact stays", async () => {
		RETENTION.rowsPerStep = 2;
		const first = await next(null, [{ point: "retain:step", mode: "abort" }]);
		await ran(first);
		const { written } = await acknowledged(first);
		fake.failDeliveries = 1_000_000;
		const second = await next(first);
		await ran(second);
		await age(first, RETENTION.factsMs);

		// The reset fails the alarm's invocation.
		await due(first).catch(() => {});
		const fired = await until(
			() => objectOf(first).faultFired(),
			(entries) => entries.length === 1,
		);
		expect(fired.map((entry) => [entry.point, entry.detail])).toEqual([["retain:step", "facts"]]);

		await retain(first);
		const after = await delivery(first);
		expect(after).toMatchObject({ acknowledged: written, floor: written + 1 });
		expect(await heldSeqs(first)).toEqual(range(written + 1, after.written));
	});

	test("a failing step reschedules the job after a backoff and keeps it; the next pass finishes", async () => {
		RETENTION.rowsPerStep = 2;
		const start = await next(null, [{ point: "retain:step", mode: "throw" }]);
		await ran(start);
		const { written } = await acknowledged(start);
		await age(start, RETENTION.factsMs);
		const before = Date.now();
		await retain(start);
		const job = await retainJob(start);
		expect(job).toBeGreaterThanOrEqual(before + 30_000);
		expect(job).toBeLessThanOrEqual(Date.now() + 30_000);
		expect(await heldSeqs(start)).toEqual(range(3, written));

		await retain(start);
		expect([await heldSeqs(start), await retainJob(start)]).toEqual([[], null]);
	});

	test("nothing is pruned while a run is active or a start is prepared; a pass a preparation blocked comes back within the hour", async () => {
		const first = await next(null);
		await ran(first);
		const { written } = await acknowledged(first);
		await age(first, RETENTION.factsMs);
		const slow = await next(first, [], SLOW);
		await commands.startRun(slow);
		const before = Date.now();
		await retain(first);
		expect(await heldSeqs(first)).toEqual(expect.arrayContaining(range(1, written)));
		expect(await retainJob(first)).toBeGreaterThanOrEqual(before + RETENTION.busyMs);
		await commands.cancelRun({ scope: slow.scope, conversation: slow.conversation, run: slow.run, reason: "cancelled" });
		await settled(slow);
		await acknowledged(slow);

		// A start prepared and not answered, as a start's try that was lost leaves it, then cancelled.
		const prepared = uuid7();
		await sql(first, "INSERT INTO internal_starts (run_id, part, text) VALUES (?, 0, '{}')", prepared);
		await age(first, RETENTION.factsMs);
		const blocked = Date.now();
		await retain(first);
		expect(await heldSeqs(first)).toEqual(expect.arrayContaining(range(1, written)));
		await commands.cancelRun({ scope: first.scope, conversation: first.conversation, run: prepared, reason: "cancelled" });
		expect(await sql(first, "SELECT run_id FROM internal_starts")).toEqual([]);
		expect(await retainJob(first)).toBeLessThanOrEqual(blocked + RETENTION.busyMs + 1000);

		await retain(first);
		expect(await heldSeqs(first)).toEqual([]);
	});
});
