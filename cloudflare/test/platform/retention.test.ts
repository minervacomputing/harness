// Retention in local workerd (docs/plans/chunk-15a-design.md): the `retain` job on the Conversation's alarm deletes a fact
// only 7 days after Laravel acknowledged it, raising the floor, and a replay or a gap from below the floor is refused rather
// than skipping what is gone (Facts and the floor); it deletes a run's own records and its pi session 30 days after the run
// ended, keeping its row, its answer and its tombstone, and the pi sessions no run names (A run's steps, pi's tables); and it
// purges a deleted conversation 7 days after its deletion once Laravel holds every fact, after which the Worker answers its
// commands from the recovery index (Physical deletion). The Conversation runs with the test build's ports (src/faults/), for
// the fault points `retain:step` and `loop:created`, and its runs answer with the fake model.

import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type ConversationId, defineTask } from "@earendil-works/pi-durable";
import type { StartRun } from "@minerva/contract/internal";
import { SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { FOLDER_PORTS } from "../../src/files/folder.ts";
import { createApp } from "../../src/http/router.ts";
import { base64url } from "../../src/lib/bytes.ts";
import { STREAM_AUDIENCE, STREAM_PURPOSE } from "../../src/stream/token.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RETAIN_JOB, RETENTION } from "../../src/conversation/retention.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { notesLease } from "../../src/faults/world.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript, FakeTurn } from "../../src/model/fake.ts";
import { ORIGIN, commands, held, notesStart, objectOf, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

const DELIVERY = { ...FACT_DELIVERY };
const PERIODS = { ...RETENTION };
const BUCKET = FOLDER_PORTS.bucket;
const DAY = 24 * 60 * 60_000;
let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
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
	FOLDER_PORTS.bucket = BUCKET;
	vi.restoreAllMocks();
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
/** When the oldest run's records are due: 30 days after it ended. */
const runsDue = async (start: StartRun) => ((await sql<{ at: number }>(start, "SELECT min(finished_at) AS at FROM runs"))[0]?.at ?? 0) + RETENTION.runMs;
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

/**
 * Makes the `retain` job due, as if its time had come, and sets the object's alarm for now, which the platform runs once any
 * invocation in progress has ended. Not `runDurableObjectAlarm`: it calls the handler at once whenever an alarm is set, the
 * deadman alarm of an invocation in progress included, and Lifecycle would run a second pass beside that invocation's.
 */
async function due(start: StartRun): Promise<void> {
	await runInDurableObject(objectOf(start), async (_instance, state) => {
		state.storage.sql.exec(
			"INSERT INTO cf_agents_jobs (id, capability, fn, time, running) VALUES (?, 'host', ?, 0, 0) ON CONFLICT (id) DO UPDATE SET time = 0, running = 0",
			RETAIN_JOB,
			RETAIN_JOB,
		);
		await state.storage.setAlarm(Date.now());
	});
}

/**
 * Runs passes of the `retain` job until none is due: the job then has a time still to come, or is gone. A pass that spent its
 * budget makes the job due at once, for the next.
 */
async function retain(start: StartRun): Promise<void> {
	await due(start);
	await until(
		() => sql<{ time: number }>(start, "SELECT time FROM cf_agents_jobs WHERE id = ?", RETAIN_JOB),
		(rows) => rows.length === 0 || (rows[0]?.time ?? 0) > Date.now(),
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
		// Nothing is left that Laravel acknowledged: the job waits for the first run's records.
		expect(await retainJob(first)).toBe(await runsDue(first));
	});

	test("an acknowledged fact is kept 7 days after its acknowledgement, not its writing; a late one moves the job earlier", async () => {
		fake.failDeliveries = 1_000_000;
		const start = await next(null);
		await ran(start);
		await sql(start, "UPDATE facts SET created_at = 0");
		await retain(start);
		const { written } = await delivery(start);
		expect([await heldSeqs(start), await retainJob(start)]).toEqual([range(1, written), await runsDue(start)]);

		// Due later, for the run's records.
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
		expect([await heldSeqs(start), await retainJob(start)]).toEqual([[], await runsDue(start)]);
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

/** The fake model's answer: `turns`, in order. */
const scripted = (...turns: FakeTurn[]) => JSON.stringify({ fake: { turns } satisfies FakeScript });

/** A start in a new conversation with a Notes connection Laravel lends, whose fake provider is seeded. */
async function notes(content: string): Promise<StartRun> {
	const within = scope();
	const connectionId = uuid7();
	await providerOf(env, within.workspace).reset({});
	fake.connections.set(connectionId, notesLease());
	return held(fake, notesStart(within, connectionId, { message: { id: uuid7(), content, attachments: [] } }));
}

/** The tables of a run's own records, which its prune deletes. */
const RECORDS = ["run_events", "run_snapshots", "attempts", "tool_executions", "tool_arguments", "call_records", "script_records", "run_writes", "page_tokens"] as const;

/** How many rows of the run each of its own tables holds. */
async function records(start: StartRun, runId = start.run): Promise<{ [table in (typeof RECORDS)[number]]: number }> {
	const counts = await Promise.all(RECORDS.map(async (table) => [table, (await sql<{ n: number }>(start, `SELECT count(*) AS n FROM ${table} WHERE run_id = ?`, runId))[0]?.n ?? 0] as const));
	return Object.fromEntries(counts) as { [table in (typeof RECORDS)[number]]: number };
}

const NO_RECORDS = Object.fromEntries(RECORDS.map((table) => [table, 0]));

interface Pruned {
	status: string;
	prune: string | null;
	snapshot: string;
	session: string | null;
	event_seq: number;
}

async function runRow(start: StartRun, runId = start.run): Promise<Pruned> {
	const [row] = await sql<Pruned>(start, "SELECT status, prune, snapshot, session, event_seq FROM runs WHERE id = ?", runId);
	if (row === undefined) throw new Error("The run has no row.");
	return row;
}

/** What pi holds of a session: its own row, entries, tasks, submissions and the documents scoped to it. */
async function piRows(start: StartRun, session: string | number | null): Promise<number[]> {
	const counts = await Promise.all(
		[
			"SELECT count(*) AS n FROM pi_conversations WHERE id = ?",
			"SELECT count(*) AS n FROM pi_entries WHERE conversation_id = ?",
			"SELECT count(*) AS n FROM pi_tasks WHERE conversation_id = ?",
			"SELECT count(*) AS n FROM pi_submissions WHERE conversation_id = ?",
			"SELECT count(*) AS n FROM pi_documents WHERE scope_kind = 'conversation' AND owner_id = ?",
		].map(async (query) => (await sql<{ n: number }>(start, query, Number(session)))[0]?.n ?? 0),
	);
	return counts;
}

/** Makes every run's end `ms` older, as if that much time had passed since it ended. */
async function ageRuns(start: StartRun, ms: number): Promise<void> {
	await sql(start, "UPDATE runs SET finished_at = finished_at - ? WHERE finished_at IS NOT NULL", ms);
}

/** The frames the run's stream sends from `after` until it closes, and its close code. */
async function streamed(start: StartRun, runId: string, after: number): Promise<{ frames: unknown[]; code: number }> {
	const response = await objectOf(start).fetch(`http://conversation/stream?run=${runId}&after=${after}&organization=${start.scope.organization}`, { headers: { Upgrade: "websocket" } });
	const socket = response.webSocket as WebSocket;
	const frames: unknown[] = [];
	const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
	socket.addEventListener("message", (event) => {
		frames.push(JSON.parse(String(event.data)));
	});
	socket.accept();
	return { frames, code: await closed };
}

/** Laravel's command that reads nothing, so an object a fault reset starts again and recovers. */
const wake = (start: StartRun) => commands.replayFacts({ scope: start.scope, conversation: start.conversation, after: 1_000_000_000, limit: 1 });

/** Waits until the run's `run.settled` is written, waking the object as Laravel's commands would after a reset. */
async function settledAfterReset(start: StartRun): Promise<void> {
	await until(
		async () => {
			await wake(start);
			return sql<{ n: number }>(start, "SELECT count(*) AS n FROM facts WHERE run_id = ? AND json_extract(fact, '$.type') = 'run.settled'", start.run);
		},
		([row]) => row?.n === 1,
	);
}

const steps = async (start: StartRun) => (await objectOf(start).faultFired()).filter((entry) => entry.point === "retain:step").map((entry) => entry.detail);

const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context retention test]" }) as never;

/** A task of a kind the Conversation registers no definition for: pi keeps it pending until an `abortTask` ends it as orphaned. */
const BLOCKED = defineTask<Record<string, never>, { phase: "run" }, null>({
	name: "test.blocked",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: { async run() {} },
	async abort() {},
});

/** A live task pi holds in the session, as pi's own work left after the run's end would be; its id. */
function liveTask(start: StartRun, session: number): Promise<number> {
	return runInDurableObject(objectOf(start), async (instance) => {
		const conversation = await (await instance.harness.pi()).conversation(session as ConversationId, BG);
		if (conversation === undefined) throw new Error(`pi has no session ${session}.`);
		return conversation.commit((tx) => tx.createTask(BLOCKED, {}, { ownership: { kind: "conversation" } }), BG);
	});
}

const taskStates = (start: StartRun, ids: readonly number[]) =>
	Promise.all(ids.map(async (id) => (await sql<{ status: string; outcome: string | null }>(start, "SELECT status, json_extract(record, '$.state.outcome.status') AS outcome FROM pi_tasks WHERE id = ?", id))[0]));

describe("runs' retention", () => {
	test("a run 30 days after its end keeps its row, answer and tombstone, and nothing else of its own", async () => {
		const start = await notes(scripted({ tools: [{ name: "notes_list_notes", arguments: { folder: "inbox" } }] }, { tools: [{ name: "notes_save_note", arguments: { folder: "inbox", title: "Kept" } }] }, { tools: [{ name: "run_script", arguments: { code: "return 1" } }] }, { text: "Done." }));
		// Laravel acknowledges nothing, so only the run's end schedules the job.
		fake.failDeliveries = 1_000_000;
		const accepted = await commands.startRun(start);
		expect(accepted.outcome).toBe("accepted");
		await settled(start);
		const tombstoned = uuid7();
		expect(await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: tombstoned, reason: "cancelled" })).toEqual({ state: "tombstoned" });
		// What the run did not make of its own, as a run with a page of results and an escaped argument would.
		await sql(start, "INSERT INTO tool_arguments (run_id, call_id, text) VALUES (?, 'call', '{}')", start.run);
		await sql(start, "INSERT INTO page_tokens (token, run_id, tool, query_hash, upstream_cursor, created_at) VALUES ('token', ?, 'notes_list_notes', 'hash', 'cursor', 0)", start.run);
		const before = await runRow(start);
		const kept = await records(start);
		expect(Object.entries(kept).filter(([, count]) => count === 0)).toEqual([["run_snapshots", 0]]);
		expect((await piRows(start, before.session)).every((count) => count > 0)).toBe(true);
		const [{ finished_at } = { finished_at: 0 }] = await sql<{ finished_at: number }>(start, "SELECT finished_at FROM runs WHERE id = ?", start.run);
		expect(await retainJob(start)).toBe(finished_at + RETENTION.runMs);

		await ageRuns(start, RETENTION.runMs - 60_000);
		await retain(start);
		expect([await runRow(start), await records(start)]).toEqual([before, kept]);

		await ageRuns(start, 60_000);
		await retain(start);
		expect(await runRow(start)).toEqual({ status: "completed", prune: "done", snapshot: "", session: before.session, event_seq: before.event_seq });
		expect(await records(start)).toEqual(NO_RECORDS);
		expect(await piRows(start, before.session)).toEqual([0, 0, 0, 0, 0]);
		expect((await sql<{ n: number }>(start, "SELECT count(*) AS n FROM internal_answers WHERE run_id = ?", start.run))[0]?.n).toBe(1);
		expect(await sql(start, "SELECT run_id, reason FROM tombstones")).toEqual([{ run_id: tombstoned, reason: "cancelled" }]);

		// Laravel's commands sent again get their first answers.
		expect(await commands.startRun(start)).toEqual(accepted);
		expect(await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" })).toEqual({ state: "ended" });
		const repeat = held(fake, { ...start, message: { ...start.message, id: uuid7() }, run: tombstoned });
		expect(await commands.startRun(repeat)).toMatchObject({ outcome: "refused", code: "CANCELLED" });
		// Its stream ends at once, from its start, from inside its old events and from its last.
		for (const after of [0, Math.floor(before.event_seq / 2), before.event_seq]) {
			expect(await streamed(start, start.run, after)).toEqual({ frames: [{ type: "end" }], code: 1000 });
		}
		// A conversation whose runs are pruned is still deleted.
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
	});

	test("the test build's plan gives one conversation periods of its own, and notes each pass's start and end", async () => {
		RETENTION.passMs = 60_000;
		const start = await next(null);
		await objectOf(start).faultPlan([{ point: "retain:pass", mode: "note", times: 10 }], { retention: { runMs: 60_000 } });
		const other = await next(null);
		// Laravel acknowledges nothing, so only the runs' ends schedule the job.
		fake.failDeliveries = 1_000_000;
		await ran(start);
		await ran(other);
		const ended = async (of: StartRun) => (await sql<{ finished_at: number }>(of, "SELECT finished_at FROM runs WHERE id = ?", of.run))[0]?.finished_at ?? 0;
		expect([await retainJob(start), await retainJob(other)]).toEqual([(await ended(start)) + 60_000, (await ended(other)) + RETENTION.runMs]);

		await ageRuns(start, 60_000);
		await retain(start);
		expect((await runRow(start)).prune).toBe("done");
		const edges = (await objectOf(start).faultFired()).filter((entry) => entry.point === "retain:pass");
		expect(edges.map((entry) => entry.detail)).toEqual(["start", "end"]);
		expect(edges[1]?.at).toBeGreaterThanOrEqual(edges[0]?.at ?? Number.POSITIVE_INFINITY);
	});

	test("a pass that spent its budget is followed at once by the next, which goes on from there", async () => {
		RETENTION.passMs = 0;
		const start = await next(null, [
			{ point: "retain:pass", mode: "note", times: 2 },
			{ point: "retain:pass", mode: "hold" },
			{ point: "retain:pass", mode: "note", times: 10 },
		]);
		await ran(start);
		await ageRuns(start, RETENTION.runMs);
		const retained = retain(start);
		await until(
			() => objectOf(start).faultFired(),
			(log) => log.some((entry) => entry.mode === "hold"),
		);
		expect((await runRow(start)).prune).toBe("pi");

		await objectOf(start).faultRelease("retain:pass");
		await retained;
		expect([(await runRow(start)).prune, await records(start)]).toEqual(["done", NO_RECORDS]);
		const fired = await until(
			() => objectOf(start).faultFired(),
			(log) => log.filter((entry) => entry.detail === "end").length === 4,
		);
		expect(fired.map((entry) => [entry.mode, entry.detail])).toEqual([
			["note", "start"],
			["note", "end"],
			["hold", "start"],
			["note", "end"],
			["note", "start"],
			["note", "end"],
			["note", "start"],
			["note", "end"],
		]);
	});

	test("the job made due again while a pass runs gets no second pass beside it", async () => {
		const start = await next(null, [
			{ point: "retain:pass", mode: "hold" },
			{ point: "retain:pass", mode: "note", times: 10 },
		]);
		await ran(start);
		await due(start);
		await until(
			() => objectOf(start).faultFired(),
			(log) => log.length > 0,
		);

		await due(start);
		await objectOf(start).faultRelease("retain:pass");
		const fired = await until(
			() => objectOf(start).faultFired(),
			(log) => log.some((entry) => entry.detail === "end"),
		);
		expect(fired.map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([
			["retain:pass", "hold", "start"],
			["retain:pass", "note", "end"],
		]);
	});

	test("a run not settled, or with a write still dispatched, is not pruned, and is looked at again a day later", async () => {
		const start = await next(null);
		await ran(start);
		await sql(start, "UPDATE runs SET settled_at = NULL WHERE id = ?", start.run);
		await ageRuns(start, RETENTION.runMs);
		const before = Date.now();
		await retain(start);
		expect((await runRow(start)).prune).toBeNull();
		expect((await records(start)).run_events).toBeGreaterThan(0);
		const job = await retainJob(start);
		expect(job).toBeGreaterThanOrEqual(before + RETENTION.blockedMs);
		expect(job).toBeLessThanOrEqual(Date.now() + RETENTION.blockedMs);

		await sql(start, "UPDATE runs SET settled_at = ? WHERE id = ?", Date.now(), start.run);
		await sql(start, "INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES (?, 'k', 'dispatched', 1, 0, 0)", start.run);
		await retain(start);
		expect((await runRow(start)).prune).toBeNull();

		await sql(start, "UPDATE run_writes SET status = 'uncertain' WHERE run_id = ?", start.run);
		await retain(start);
		expect([(await runRow(start)).prune, await records(start)]).toEqual(["done", NO_RECORDS]);
	});

	test("runs whose pi sessions have live work are aborted and skipped, and a later run is still pruned in the same pass", async () => {
		RETENTION.passMs = 60_000;
		const first = await next(null, [{ point: "retain:step", mode: "note", times: 100 }]);
		await ran(first);
		const blocked = [first, await next(first), await next(first)];
		for (const start of blocked.slice(1)) await ran(start);
		const free = await next(first);
		await ran(free);
		const sessions: string[] = [];
		const live: number[] = [];
		for (const start of blocked) {
			const { session } = await runRow(start);
			sessions.push(session as string);
			live.push(await liveTask(start, Number(session)));
		}
		expect(await taskStates(first, live)).toEqual(live.map(() => ({ status: "pending", outcome: null })));
		await ageRuns(first, RETENTION.runMs);
		await retain(first);

		expect(await steps(first)).toEqual(["runs", "pi", "runs", "pi", "runs", "pi", "runs", "pi", "pi"]);
		expect([(await runRow(free)).prune, await records(free), await piRows(free, (await runRow(free)).session)]).toEqual(["done", NO_RECORDS, [0, 0, 0, 0, 0]]);
		for (const [index, start] of blocked.entries()) {
			expect([(await runRow(start)).prune, await records(start)]).toEqual(["pi", NO_RECORDS]);
			expect((await piRows(start, sessions[index] as string))[0]).toBe(1);
		}
		const ended = await until(
			() => taskStates(first, live),
			(states) => states.every((state) => state?.status === "terminal"),
		);
		expect(ended).toEqual(live.map(() => ({ status: "terminal", outcome: "orphaned" })));
	});

	test("a run of 10,000 events takes as many steps as a bound of the step's rows needs", async () => {
		const start = await next(null, [{ point: "retain:step", mode: "note", times: 1000 }]);
		await ran(start);
		await runInDurableObject(objectOf(start), (_instance, state) => {
			const { event_seq } = state.storage.sql.exec<{ event_seq: number }>("SELECT event_seq FROM runs WHERE id = ?", start.run).one();
			state.storage.sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
				INSERT INTO run_events (run_id, seq, type, data, created_at) SELECT ?, ? + i, 'text_delta', json_object('text', printf('%.200c', 'a'), 'call', '0000abcd'), 0 FROM n`,
				start.run,
				event_seq,
			);
			state.storage.sql.exec("UPDATE runs SET event_seq = event_seq + 10000 WHERE id = ?", start.run);
		});
		const rows = Object.values(await records(start)).reduce((sum, count) => sum + count, 0);
		expect(rows).toBeGreaterThan(10_000);
		await ageRuns(start, RETENTION.runMs);
		for (let passes = 0; (await runRow(start)).prune !== "done"; passes++) {
			expect(passes).toBeLessThan(50);
			await retain(start);
		}

		const fired = (await objectOf(start).faultFired()).filter((entry) => entry.point === "retain:step");
		const runs = fired.filter((entry) => entry.detail === "runs").length;
		// Every step but the last deleted the step's 500 rows: the fewest steps a bound of 500 allows.
		expect(runs).toBe(Math.ceil((rows + 1) / RETENTION.rowsPerStep));
		expect(fired.filter((entry) => entry.detail === "pi").length).toBe(2);
		expect(await records(start)).toEqual(NO_RECORDS);
	});

	test("a run pruned right after its end; the next turn, reset mid-turn, starts again and completes", async () => {
		RETENTION.runMs = 0;
		const first = await next(null);
		await ran(first);
		const { session } = await runRow(first);
		await retain(first);
		expect([(await runRow(first)).prune, await piRows(first, session)]).toEqual(["done", [0, 0, 0, 0, 0]]);

		const text = "A sentence long enough for several deltas.";
		const second = await next(first, [{ point: "model:delta", mode: "abort", step: 0, delta: 2 }], scripted({ text }));
		await commands.startRun(second);
		await settledAfterReset(second);
		const events = await sql<{ type: string; data: string }>(second, "SELECT type, data FROM run_events WHERE run_id = ? ORDER BY seq", second.run);
		expect(events.filter((event) => event.type === "status").map((event) => JSON.parse(event.data))).toEqual([
			{ status: "queued" },
			{ status: "provisioning" },
			{ status: "running" },
			{ status: "provisioning", attempt: 2 },
			{ status: "running" },
			{ status: "completed" },
		]);
		expect(JSON.parse(events.find((event) => event.type === "message")?.data ?? "null")).toMatchObject({ content: text });
		expect((await objectOf(second).faultFired()).map((entry) => entry.point)).toEqual(["model:delta"]);

		await retain(second);
		expect([(await runRow(second)).prune, await records(second), await piRows(second, (await runRow(second)).session)]).toEqual(["done", NO_RECORDS, [0, 0, 0, 0, 0]]);
	});

	test("a reset between a session's creation and its claim leaves an orphan, drained once the run has ended", async () => {
		const start = await next(null, [{ point: "loop:created", mode: "abort" }]);
		await commands.startRun(start);
		await settledAfterReset(start);
		const fired = await objectOf(start).faultFired();
		expect(fired.map((entry) => entry.point)).toEqual(["loop:created"]);
		const orphan = (fired[0] as { detail: string }).detail;
		const { session } = await runRow(start);
		expect(session).not.toBe(orphan);
		const claimed = await piRows(start, session);
		expect((await piRows(start, orphan))[0]).toBe(1);

		await retain(start);
		expect(await piRows(start, orphan)).toEqual([0, 0, 0, 0, 0]);
		expect([(await runRow(start)).prune, await piRows(start, session)]).toEqual([null, claimed]);
		expect(await sql(start, "SELECT id FROM pi_conversations ORDER BY id")).toEqual([{ id: 1 }, { id: Number(session) }]);
	});

	test("a reset after a run's first step leaves what it committed; its stream ends at once, and the next alarm finishes", async () => {
		RETENTION.rowsPerStep = 2;
		// The pass after the reset is held at its start until the test has read what the first one left: the platform retries
		// the failed alarm on its own, and may do so before the reads.
		const start = await next(null, [
			{ point: "retain:step", mode: "abort" },
			{ point: "retain:pass", mode: "note" },
			{ point: "retain:pass", mode: "hold" },
		]);
		await ran(start);
		const before = await records(start);
		await ageRuns(start, RETENTION.runMs);

		await due(start).catch(() => {});
		const fired = await until(
			() => objectOf(start).faultFired(),
			(entries) => entries.some((entry) => entry.point === "retain:step"),
		);
		expect(fired.slice(0, 2).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([
			["retain:pass", "note", "start"],
			["retain:step", "abort", "runs"],
		]);
		expect([(await runRow(start)).prune, (await runRow(start)).snapshot, await records(start)]).toEqual(["records", "", { ...before, run_events: before.run_events - 2 }]);
		expect(await streamed(start, start.run, 0)).toEqual({ frames: [{ type: "end" }], code: 1000 });

		// The held pass, if the alarm started one, and the one `retain` starts finish it between them, in either order.
		await objectOf(start).faultRelease("retain:pass");
		await retain(start);
		const finished = await until(
			() => runRow(start),
			(row) => row.prune === "done",
		);
		expect([finished.prune, await records(start)]).toEqual(["done", NO_RECORDS]);
	});
});

/** A start in a new conversation whose message attaches `report.txt` ("hello"), so the conversation holds a blob in R2. */
async function filed(): Promise<StartRun> {
	const within = scope();
	const upload = `uploads/${within.workspace}/${uuid7()}`;
	await env.FILES_EU.put(upload, "hello");
	return held(fake, startOf(within, { message: { id: uuid7(), content: "Read this", attachments: [{ upload, name: "report.txt", size: 5, mediaType: "text/plain" }] } }));
}

const workspaceOf = (start: StartRun) => ({ id: start.scope.workspace, jurisdiction: "eu" as const });
const blobs = async (start: StartRun) => (await env.FILES_EU.list({ prefix: `blobs/${start.scope.workspace}/${start.conversation}/` })).objects.length;
const indexed = (start: StartRun) =>
	env.DB.prepare("SELECT deleted_at, purged_at, fact_seq FROM recovery_conversations WHERE id = ?").bind(start.conversation).first<{ deleted_at: number; purged_at: number | null; fact_seq: number }>();
const conversations = async (start: StartRun) => (await sql<{ n: number }>(start, "SELECT count(*) AS n FROM conversation"))[0]?.n;

/** Makes the conversation's deletion `ms` older in its object, as if that much time had passed since. */
async function ageDeletion(start: StartRun, ms: number): Promise<void> {
	await sql(start, "UPDATE conversation SET deleted_at = deleted_at - ?", ms);
}

/**
 * The tables of the object that hold rows, and how many, but the test build's own and the platform's (`_cf_`, which no query
 * may read): what is left of the conversation.
 */
async function contents(stub: DurableObjectStub): Promise<{ [table: string]: number }> {
	return runInDurableObject(stub, (_instance, state) => {
		const sql = state.storage.sql;
		const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fault_%' AND name NOT LIKE '_cf_%' ORDER BY name").toArray();
		const counts: { [table: string]: number } = {};
		for (const { name } of tables) {
			const n = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`).one().n;
			if (n > 0) counts[name] = n;
		}
		return counts;
	});
}

/** What a Conversation object holds before any command reached it: the steps of its schema, which its constructor applies. */
const EMPTY = { _migrations: MIGRATIONS.length };

/** A finished conversation with a blob, every fact Laravel acknowledged pruned, deleted 7 days ago: due for its purge. */
async function purgeable(): Promise<{ start: StartRun; written: number }> {
	const start = await filed();
	await ran(start);
	const { written } = await acknowledged(start);
	await age(start, RETENTION.factsMs);
	await retain(start);
	expect(await delivery(start)).toMatchObject({ written, acknowledged: written, floor: written + 1 });
	expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
	await ageDeletion(start, RETENTION.deletedMs);
	return { start, written };
}

/** Runs the `retain` job until the object is gone: the destroy resets it, so the alarm's invocation fails. */
async function purge(start: StartRun): Promise<void> {
	await due(start).catch(() => {});
	await until(
		() => conversations(start),
		(n) => n === 0,
	);
}

const STREAM_KEY = new Uint8Array(32).fill(7);

/** Laravel's run stream for the start's run, as a browser opens it with a token Laravel signed. */
async function stream(start: StartRun): Promise<Response> {
	const now = Math.floor(Date.now() / 1000);
	const token = await new SignJWT({ aud: STREAM_AUDIENCE, purpose: STREAM_PURPOSE, env: "test", org: start.scope.organization, conversation: start.conversation, run: start.run })
		.setProtectedHeader({ alg: "HS256", kid: "s1" })
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(STREAM_KEY);
	const streamEnv = { ...env, MINERVA_STREAM_KEYS: `s1:${base64url(STREAM_KEY, { pad: false })}` } as Env;
	return createApp().fetch(new Request(`${ORIGIN}/stream/v1`, { headers: { Authorization: `Bearer ${token}` } }), streamEnv);
}

describe("a deleted conversation's purge", () => {
	test("a deleted conversation whose facts Laravel never acknowledged is kept, and an error is logged", async () => {
		const errors = vi.spyOn(console, "error");
		fake.failDeliveries = 1_000_000;
		const start = await filed();
		await ran(start);
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const [{ deleted_at } = { deleted_at: 0 }] = await sql<{ deleted_at: number }>(start, "SELECT deleted_at FROM conversation");
		expect(await retainJob(start)).toBe(deleted_at + RETENTION.deletedMs);
		await ageDeletion(start, RETENTION.deletedMs);
		const { written } = await delivery(start);
		const before = Date.now();
		await retain(start);

		expect(errors.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("deleted conversation"))).toEqual([
			`conversation ${(await runInDurableObject(objectOf(start), (_instance, state) => state.id.name)) ?? ""}: a deleted conversation is kept: ${written} facts are not acknowledged`,
		]);
		expect([await conversations(start), await heldSeqs(start), await blobs(start), (await indexed(start))?.purged_at]).toEqual([1, range(1, written), 1, null]);
		const job = await retainJob(start);
		expect(job).toBeGreaterThanOrEqual(before + RETENTION.blockedMs);
		expect(job).toBeLessThanOrEqual(Date.now() + RETENTION.blockedMs);
	});

	test("is kept 7 days after its last acknowledgement; then its storage, blobs and object go and the index marks it purged", async () => {
		const start = await filed();
		await ran(start);
		const { written } = await acknowledged(start);
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		await ageDeletion(start, RETENTION.deletedMs);
		const before = Date.now();
		await retain(start);
		expect([await conversations(start), await heldSeqs(start), await blobs(start), (await indexed(start))?.purged_at]).toEqual([1, range(1, written), 1, null]);
		// Due and blocked: looked at again a day later.
		const job = await retainJob(start);
		expect(job).toBeGreaterThanOrEqual(before + RETENTION.blockedMs);
		expect(job).toBeLessThanOrEqual(Date.now() + RETENTION.blockedMs);

		await age(start, RETENTION.factsMs);
		const purging = Date.now();
		await purge(start);
		expect(await contents(objectOf(start))).toEqual(EMPTY);
		expect(await blobs(start)).toBe(0);
		const row = await indexed(start);
		expect(row).toEqual({ deleted_at: expect.any(Number), purged_at: expect.any(Number), fact_seq: written });
		expect(row?.purged_at).toBeGreaterThanOrEqual(purging);
		expect(await runInDurableObject(objectOf(start), (_instance, state) => state.storage.getAlarm())).toBeNull();
	});

	test("afterwards the Worker answers every command from the index, and none reaches the object", async () => {
		const { start, written } = await purgeable();
		await purge(start);
		const named = { scope: start.scope, conversation: start.conversation };

		const refused = { outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." };
		// Its start, accepted before the deletion, is refused too: the answer went with the object.
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await commands.startRun(held(fake, startOf(start.scope, { conversation: start.conversation })))).toEqual(refused);
		expect(await commands.cancelRun({ ...named, run: start.run, reason: "cancelled" })).toEqual({ state: "ended" });
		expect(await commands.cancelRun({ ...named, run: uuid7(), reason: "cancelled" })).toEqual({ state: "ended" });
		expect(await commands.deleteConversation(named)).toEqual({ outcome: "deleted" });
		expect(await commands.replayFacts({ ...named, after: written, limit: 500 })).toEqual({ conversation: start.conversation, facts: [], more: false });
		expect(await refusalOf(commands.replayFacts({ ...named, after: written - 1, limit: 500 }))).toEqual({ code: "FACTS_PRUNED", status: 410, data: { floor: written + 1 } });
		expect(await refusalOf(commands.folder({ ...named, version: null }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(await refusalOf(commands.resolveDownload({ ...named, version: null, path: "report.txt" }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		const streamed = await stream(start);
		expect(streamed.status).toBe(404);
		await streamed.body?.cancel();
		// Another scope is still refused as such.
		expect(await refusalOf(commands.cancelRun({ ...named, scope: { ...start.scope, organization: uuid7() }, run: uuid7(), reason: "cancelled" }))).toMatchObject({ code: "SCOPE_MISMATCH" });

		expect(await contents(objectOf(start))).toEqual(EMPTY);
	});

	// As the Worker sends a start or a cancel of a conversation the index read as deleted and not purged: the deletion first,
	// then the command, which says the conversation is deleted. The purge can come before either of them.
	test.each([
		{ sent: "the deletion and a cancel", deletes: true, command: "cancel", answer: { state: "tombstoned" } },
		{ sent: "a cancel, the purge having come after the deletion", deletes: false, command: "cancel", answer: { state: "tombstoned" } },
		{
			sent: "a start, the purge having come after the deletion",
			deletes: false,
			command: "start",
			answer: { outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." },
		},
	])("$sent, after the purge, make the object again only deleted, which purges itself after its window", async ({ deletes, command, answer }) => {
		const { start } = await purgeable();
		await purge(start);
		const first = await indexed(start);
		const named = { scope: start.scope, conversation: start.conversation };

		if (deletes) expect(await objectOf(start).deleteInternal(named, workspaceOf(start))).toEqual({ ok: true, value: { outcome: "deleted" } });
		const late = held(fake, startOf(start.scope, { conversation: start.conversation }));
		const answered =
			command === "start"
				? await objectOf(start).startInternal(late, workspaceOf(start), true)
				: await objectOf(start).cancelInternal({ ...named, run: late.run, reason: "cancelled" }, workspaceOf(start), true);
		expect(answered).toEqual({ ok: true, value: answer });
		const [{ deleted_at } = { deleted_at: 0 }] = await sql<{ deleted_at: number }>(start, "SELECT deleted_at FROM conversation");
		expect(await retainJob(start)).toBe(deleted_at + RETENTION.deletedMs);
		expect(await sql(start, "SELECT id FROM runs")).toEqual([]);

		await ageDeletion(start, RETENTION.deletedMs);
		await purge(start);
		expect(await contents(objectOf(start))).toEqual(EMPTY);
		expect([await blobs(start), await indexed(start)]).toEqual([0, first]);
	});

	test("an R2 failure past three tries keeps the job, backing off, and a later pass finishes", async () => {
		let failing = true;
		FOLDER_PORTS.bucket = (context) => {
			const inner = BUCKET(context);
			return {
				get: (key) => inner.get(key),
				put: (key, value, options) => inner.put(key, value, options),
				delete: (keys) => inner.delete(keys),
				list: (options) => (failing ? Promise.reject(new Error("R2 is unavailable.")) : inner.list(options)),
			};
		};
		const { start } = await purgeable();
		for (const backoff of [30_000, 60_000, 120_000, 240_000]) {
			const before = Date.now();
			await retain(start);
			const job = await retainJob(start);
			expect(job).toBeGreaterThanOrEqual(before + backoff);
			expect(job).toBeLessThanOrEqual(Date.now() + backoff);
		}
		expect([await conversations(start), await blobs(start), (await indexed(start))?.purged_at]).toEqual([1, 1, expect.any(Number)]);

		failing = false;
		await purge(start);
		expect(await contents(objectOf(start))).toEqual(EMPTY);
		expect(await blobs(start)).toBe(0);
	});

	test.each([
		{ step: "clean", notes: 0, left: { purged: false, blobs: 1, conversations: 1 } },
		{ step: "mark", notes: 1, left: { purged: true, blobs: 1, conversations: 1 } },
		{ step: "blobs", notes: 2, left: { purged: true, blobs: 0, conversations: 1 } },
	])("a reset after its $step step leaves what it did, and the next alarm finishes", async ({ step, notes, left }) => {
		const { start } = await purgeable();
		await objectOf(start).faultPlan([...(notes > 0 ? [{ point: "retain:step", mode: "note" as const, times: notes }] : []), { point: "retain:step", mode: "abort" }]);

		await due(start).catch(() => {});
		const fired = await until(
			() => objectOf(start).faultFired(),
			(log) => log.some((entry) => entry.mode === "abort"),
		);
		expect(fired.map((entry) => entry.detail)).toEqual(["clean", "mark", "blobs"].slice(0, notes + 1));
		expect(fired.at(-1)).toMatchObject({ detail: step, mode: "abort" });
		expect({ purged: (await indexed(start))?.purged_at != null, blobs: await blobs(start), conversations: await conversations(start) }).toEqual(left);

		await purge(start);
		expect(await contents(objectOf(start))).toEqual(EMPTY);
		expect([await blobs(start), (await indexed(start))?.purged_at]).toEqual([0, expect.any(Number)]);
	});

	test("a reset between the storage's deletion and the object's destroy() leaves nothing of the conversation", async () => {
		const { start } = await purgeable();
		await objectOf(start).faultPlan([
			{ point: "retain:step", mode: "note", times: 3 },
			{ point: "retain:step", mode: "abort" },
		]);

		await due(start).catch(() => {});
		// Taken before the deletion and logged again after it, which deleted the notes logged before it.
		const fired = await until(
			() => objectOf(start).faultFired(),
			(log) => log.length > 0,
		);
		expect(fired.map((entry) => [entry.point, entry.detail, entry.mode])).toEqual([["retain:step", "storage", "abort"]]);
		expect([await contents(objectOf(start)), await blobs(start), (await indexed(start))?.purged_at]).toEqual([EMPTY, 0, expect.any(Number)]);
		// An alarm left, if any, wakes an object with nothing to do.
		await runDurableObjectAlarm(objectOf(start));
		expect(await contents(objectOf(start))).toEqual(EMPTY);
		expect(await runInDurableObject(objectOf(start), (_instance, state) => state.storage.getAlarm())).toBeNull();
	});
});
