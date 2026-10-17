// Chunk 15a's perf probe (docs/plans/chunk-15a-design.md, Perf probe and rule) on the test instance, in conversations of
// their own: TURNS turns of the fake model, one after another, each a tool call and an answer of 2,000 characters, each start
// with the conversation's history as Laravel sends it (its latest MAX_HISTORY messages), so the history grows to its cap; one
// large turn of 200 tool calls and a streamed answer, whose events the driver then makes 10,000 (`events`: the stream writes
// one event a call per 250 ms flush, so 10,000 streamed events would take about 40 minutes, and a message's script holds
// 20,000 characters); and the floor, one short turn, which shows what an object keeps once everything is pruned. Each is built
// with the engine's periods, so nothing is pruned, and once the fake Laravel has acknowledged every fact the driver reads
// `databaseSize`, sets the conversation's periods to zero and makes its `retain` job due now (`retain`), with a `note` at each
// pass's start and end (`retain:pass`) and after each step (`retain:step`). Once no `retain` job is left it reads
// `databaseSize` again.
//
// The rule: every pass under 1 s of wall time, and `databaseSize` after under 10% of before, for the turns and the large turn.
// A pass's wall time is its end note's time less its start's, on the object's clock. That clock stands still through SQL and
// a timer moves it only by its delay; the pass syncs the storage after each step, which moves it to the real time, so the end
// counts every step and only the pass's last reads, after its last sync, are left out.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts), after `pnpm run deploy:test`:
// `MINERVA_PERF=1 pnpm test:faults test/account/retention-perf.test.ts`. MINERVA_RETENTION_OUT names a file for the passes
// and the readings. MINERVA_PERF_TURNS sets TURNS, 1,000 by default. Debug the probe with a few turns, and run 1,000 only for
// the numbers a box records.

import { writeFileSync } from "node:fs";
import { MAX_HISTORY } from "@minerva/contract/internal";
import { afterAll, describe, expect, test } from "vitest";
import { type Fault, type HistoryMessage, LIST_INBOX, type World, driver, finish, fired, heldFacts, jobs, outcome, post, retainNow, script, settled, sleep, storage, uuid7, world } from "./driver.ts";

const FULL_TURNS = 1_000;
const TURNS_SETTING = process.env.MINERVA_PERF_TURNS ?? String(FULL_TURNS);
if (!/^[1-9][0-9]*$/.test(TURNS_SETTING)) throw new Error(`MINERVA_PERF_TURNS must be a positive integer, not "${TURNS_SETTING}".`);
const TURNS = Number(TURNS_SETTING);
const EVENTS = 10_000;
const ANSWER_CHARS = 2_000;
const RULE_PASS_MS = 1_000;
const RULE_AFTER = 0.1;
const NOTES: Fault[] = [
	{ point: "retain:pass", mode: "note", times: 1_000_000 },
	{ point: "retain:step", mode: "note", times: 1_000_000 },
];

/** A pass, from its notes: its wall time, and each step's name and time, the last step's up to the pass's end. */
interface Pass {
	start: number;
	ms: number;
	steps: [name: string, ms: number][];
}

/**
 * The step bounds to compare, `MINERVA_RETENTION_ROWS=500,100`: a conversation of TURNS turns each, built at once and pruned one
 * after another. By default one, at the engine's own bound.
 */
const ROWS: (number | undefined)[] = process.env.MINERVA_RETENTION_ROWS ? process.env.MINERVA_RETENTION_ROWS.split(",").map(Number) : [undefined];

const results: { [name: string]: unknown } = {};

afterAll(async () => {
	if (process.env.MINERVA_RETENTION_OUT) writeFileSync(process.env.MINERVA_RETENTION_OUT, `${JSON.stringify(results, null, 2)}\n`);
	await finish();
}, 1_800_000);

/** Polls the run's head until it has ended, more often than `settled`: a turn of the fake model takes about a second. */
async function ended(w: World, runId: string): Promise<string> {
	const started = Date.now();
	for (;;) {
		const view = await driver<{ head: { status: string } | null }>("run", { scope: w.scope, conversationId: w.conversationId, runId });
		const status = view.head?.status;
		if (status !== undefined && !["queued", "provisioning", "running"].includes(status)) return status;
		if (Date.now() - started > 120_000) throw new Error(`The run did not end: ${status}`);
		await sleep(150);
	}
}

/** Waits until the fake Laravel has acknowledged every fact the conversation wrote, the runs' run.settled included. */
async function acknowledged(w: World, runs: number): Promise<void> {
	const started = Date.now();
	for (;;) {
		const { delivery } = await heldFacts(w);
		const { facts } = await driver<{ facts: { type: string }[] }>("laravel", { scope: w.scope, conversationId: w.conversationId });
		const settledRuns = facts.filter((fact) => fact.type === "run.settled").length;
		if (delivery !== null && delivery.acknowledged === delivery.written && settledRuns === runs) return;
		if (Date.now() - started > 600_000) throw new Error(`Laravel did not acknowledge every fact: ${JSON.stringify(delivery)}, ${settledRuns} of ${runs} runs settled`);
		await sleep(2_000);
	}
}

/**
 * Prunes the conversation with its periods at zero (and `rowsPerStep` when given) and reads each pass from the notes. A step's
 * note is taken before the step's sync, at the clock the previous sync moved, so a step's time is from its note to the next
 * note, or to the pass's end. Answers the readings before and after, the passes and the whole chain's time.
 */
async function prune(w: World, rowsPerStep?: number): Promise<{ before: Reading; after: Reading; passes: Pass[]; unfinished: number; chainMs: number }> {
	const before = await storage(w);
	await retainNow(w, NOTES, { runMs: 0, factsMs: 0, ...(rowsPerStep === undefined ? {} : { rowsPerStep }) });
	const started = Date.now();
	while ((await jobs(w)).some((job) => job.id === "retain")) {
		if (Date.now() - started > 3_600_000) throw new Error("The retain job is still there after an hour.");
		await sleep(2_000);
	}
	const after = await storage(w);
	const passes: Pass[] = [];
	let unfinished = 0;
	let open: { start: number; last: number; names: string[]; times: number[] } | null = null;
	for (const note of await fired(w)) {
		if (note.point === "retain:pass" && note.detail === "start") {
			// A pass with no end failed (or was reset): its retry is logged as a failure, not timed.
			if (open) unfinished++;
			open = { start: note.at, last: note.at, names: [], times: [] };
		}
		else if (open && note.point === "retain:step") {
			if (open.names.length) open.times.push(note.at - open.last);
			open.names.push(note.detail);
			open.last = note.at;
		} else if (open && note.point === "retain:pass" && note.detail === "end") {
			if (open.names.length) open.times.push(note.at - open.last);
			passes.push({ start: open.start, ms: note.at - open.start, steps: open.names.map((name, index) => [name, open?.times[index] ?? 0]) });
			open = null;
		}
	}
	const last = passes.at(-1);
	const chainMs = last ? last.start + last.ms - (passes[0] as Pass).start : 0;
	return { before, after, passes, unfinished, chainMs };
}

type Reading = Awaited<ReturnType<typeof storage>>;

function report(name: string, pruned: Awaited<ReturnType<typeof prune>>, extra: { [key: string]: unknown }): void {
	const { before, after, passes, unfinished, chainMs } = pruned;
	const times = passes.map((pass) => pass.ms).sort((a, b) => a - b);
	const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
	const steps = passes.flatMap((pass) => pass.steps);
	const slowest = [...steps].sort((a, b) => b[1] - a[1]).slice(0, 5);
	const summary = {
		...extra,
		before: before.databaseSize,
		after: after.databaseSize,
		ratio: after.databaseSize / before.databaseSize,
		passes: passes.length,
		unfinished,
		steps: steps.length,
		passMs: { min: times[0], median: at(0.5), p90: at(0.9), p99: at(0.99), max: times.at(-1) },
		over: passes.filter((pass) => pass.ms >= RULE_PASS_MS).length,
		slowestSteps: slowest,
		passesWithClockStill: passes.filter((pass) => pass.steps.length > 1 && pass.ms === 0).length,
		chainMs,
	};
	console.info(`${name}: ${JSON.stringify(summary)}`);
	results[name] = { summary, passes, before, after };
}

/** TURNS turns, one after another, each with the conversation's history as Laravel sends it. */
async function turns(w: World): Promise<void> {
	const history: HistoryMessage[] = [];
	for (let turn = 1; turn <= TURNS; turn++) {
		const answer = `Answer ${turn}. ${"The notes in the inbox are listed above. ".repeat(60)}`.slice(0, ANSWER_CHARS);
		const prompt = script([LIST_INBOX, { text: answer }]);
		const message = uuid7();
		const runId = await post(w, prompt, [], { history: history.slice(-MAX_HISTORY), message });
		const status = await ended(w, runId);
		if (status !== "completed") expect(status, outcome(await settled(w, runId))).toBe("completed");
		const at = new Date().toISOString();
		history.push(
			{ id: message, role: "user", content: prompt, attachments: [], run: runId, createdAt: at, changes: null },
			{ id: uuid7(), role: "assistant", content: answer, attachments: [], run: runId, createdAt: at, changes: null },
		);
	}
}

describe("retention's perf probe", () => {
	test(
		`${TURNS} turns with a growing history`,
		async () => {
			const worlds = await Promise.all(ROWS.map(() => world()));
			const started = Date.now();
			await Promise.all(worlds.map(turns));
			const buildMs = Date.now() - started;
			for (const [index, w] of worlds.entries()) {
				await acknowledged(w, TURNS);
				const rowsPerStep = ROWS[index];
				const pruned = await prune(w, rowsPerStep);
				report(`turns${rowsPerStep === undefined ? "" : `, ${rowsPerStep} rows a step`}`, pruned, { turns: TURNS, buildMs });

				expect(pruned.unfinished, "no pass failed").toBe(0);
				expect(pruned.after.tables.run_events?.rows).toBe(0);
				expect(pruned.after.tables.facts?.rows).toBe(0);
				expect(pruned.after.tables.pi_conversations?.rows, "only pi's root conversation is left").toBe(1);
				expect.soft(pruned.passes.filter((pass) => pass.ms >= RULE_PASS_MS).map((pass) => pass.ms)).toEqual([]);
				// Below the full size, the floor every pruned conversation keeps (about 550 kB) is more than 10% of before.
				if (TURNS === FULL_TURNS) expect.soft(pruned.after.databaseSize).toBeLessThan(pruned.before.databaseSize * RULE_AFTER);
			}
		},
		4 * 60 * 60_000,
	);

	test(
		"one turn of about 10,000 events",
		async () => {
			const w = await world();
			const runId = await post(w, script([...Array.from({ length: 200 }, () => LIST_INBOX), { text: "The notes in the inbox are listed above. ".repeat(120) }]));
			const started = Date.now();
			expect(await ended(w, runId)).toBe("completed");
			const runMs = Date.now() - started;
			await acknowledged(w, 1);
			const streamed = (await storage(w)).tables.run_events?.rows ?? 0;
			const { eventSeq } = await driver<{ eventSeq: number }>("events", { scope: w.scope, conversationId: w.conversationId, runId, count: EVENTS - streamed });
			const pruned = await prune(w, ROWS[0]);
			report("large", pruned, { streamed, events: pruned.before.tables.run_events?.rows, eventSeq, runMs });

			expect(pruned.unfinished, "no pass failed").toBe(0);
			expect(pruned.before.tables.run_events?.rows).toBe(EVENTS);
			expect(pruned.after.tables.run_events?.rows).toBe(0);
			expect.soft(pruned.passes.filter((pass) => pass.ms >= RULE_PASS_MS).map((pass) => pass.ms)).toEqual([]);
			expect.soft(pruned.after.databaseSize).toBeLessThan(pruned.before.databaseSize * RULE_AFTER);
		},
		60 * 60_000,
	);

	test("the floor: a conversation of one short turn, pruned", async () => {
		const w = await world();
		const runId = await post(w, "Hello");
		expect(await ended(w, runId)).toBe("completed");
		await acknowledged(w, 1);
		report("floor", await prune(w, ROWS[0]), {});
	});
});
