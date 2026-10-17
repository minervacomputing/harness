// The facts' retention (docs/plans/chunk-15a-design.md, Facts and the floor): a `retain` pass over the store on node:sqlite
// with every schema step applied, on a clock the test moves, against a host that records what the pass schedules.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RETENTION, Retention, nextPass, retryMs } from "../../src/conversation/retention.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

const DAY = 24 * 60 * 60_000;
const PERIODS = { ...RETENTION };

let db: ReturnType<typeof openDatabase>;
let now: number;
let store: RunStore;
let host: { scheduled: (number | null)[]; steps: string[]; fail: number; logged: string[]; pages: number; purged: string[] };
let retention: Retention;

beforeEach(() => {
	db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
	now = 0;
	store = new RunStore(durableStorage(db), () => now);
	host = { scheduled: [], steps: [], fail: 0, logged: [], pages: 0, purged: [] };
	retention = new Retention(store, {
		schedule: (time) => host.scheduled.push(time),
		log: (message) => host.logged.push(message),
		abort: () => {},
		stepped: async (step) => {
			host.steps.push(step);
			if (host.fail > 0) {
				host.fail--;
				throw new Error("the step's fault");
			}
		},
		purge: {
			clean: async () => void host.purged.push("clean"),
			mark: async () => void host.purged.push("mark"),
			blobs: async () => {
				host.purged.push("blobs");
				return host.pages-- > 0 ? 1000 : 0;
			},
			storage: async () => void host.purged.push("storage"),
		},
	});
});

afterEach(() => {
	Object.assign(RETENTION, PERIODS);
	db.close();
});

/** The writer's part: facts 1 to `count`, written long ago. */
function write(count: number): void {
	store.delivery();
	for (let seq = 1; seq <= count; seq++) db.prepare("INSERT INTO facts (seq, run_id, fact, created_at) VALUES (?, 'r', '{}', 0)").all(seq);
	db.prepare("UPDATE fact_delivery SET written = ?").all(count);
}

const held = () => (db.prepare("SELECT seq FROM facts ORDER BY seq").all() as { seq: number }[]).map((row) => row.seq);
const marks = () => db.prepare("SELECT seq, at FROM fact_acknowledgements ORDER BY seq").all();
const floor = () => store.delivery().floor;

describe("the facts' cut", () => {
	test("is the highest mark acknowledged 7 days ago, so a fact goes 7 days after its acknowledgement, not its writing", async () => {
		write(10);
		store.acknowledge(3);
		now = DAY;
		store.acknowledge(8);

		now = 7 * DAY + 1;
		expect(await retention.pass()).toEqual({ rescheduleAt: 8 * DAY });
		expect([held(), floor(), marks()]).toEqual([[4, 5, 6, 7, 8, 9, 10], 4, [{ seq: 8, at: DAY }]]);
		expect(host.scheduled).toEqual([8 * DAY]);

		now = 8 * DAY;
		await retention.pass();
		expect([held(), floor(), marks()]).toEqual([[9, 10], 9, []]);
		expect(host.scheduled).toEqual([8 * DAY, null]);
	});

	test("never passes what Laravel holds: a gap below a mark removes it, and the facts above the gap stay", async () => {
		write(10);
		store.acknowledge(4);
		store.acknowledge(8);
		store.acknowledgeGap(6);
		expect([store.delivery().acknowledged, marks()]).toEqual([6, [{ seq: 4, at: 0 }]]);
		now = 30 * DAY;
		await retention.pass();
		expect([held(), floor()]).toEqual([[5, 6, 7, 8, 9, 10], 5]);
		// A mark Laravel has not acknowledged since, as one above `acknowledged` would be, is never cut past it.
		db.prepare("INSERT INTO fact_acknowledgements (seq, at) VALUES (9, 0)").all();
		await retention.pass();
		expect([held(), floor()]).toEqual([[7, 8, 9, 10], 7]);
	});

	test("an acknowledgement repeated keeps its first time; nothing acknowledged is never cut, however old", async () => {
		write(5);
		now = 30 * DAY;
		await retention.pass();
		expect([held(), host.scheduled]).toEqual([[1, 2, 3, 4, 5], [null]]);
		store.acknowledge(5);
		now = 31 * DAY;
		store.acknowledge(5);
		expect(marks()).toEqual([{ seq: 5, at: 30 * DAY }]);
	});
});

describe("a pass", () => {
	test("deletes in steps of at most rowsPerStep, each committed before the next", async () => {
		RETENTION.rowsPerStep = 3;
		write(10);
		store.acknowledge(10);
		now = 7 * DAY;
		await retention.pass();
		expect([host.steps, held(), floor(), host.scheduled]).toEqual([["facts", "facts", "facts", "facts"], [], 11, [null]]);
	});

	test("stops on its budget after a step and comes back at once", async () => {
		RETENTION.rowsPerStep = 3;
		RETENTION.passMs = 0;
		write(10);
		store.acknowledge(10);
		now = 7 * DAY;
		await retention.pass();
		expect([host.steps, held(), host.scheduled]).toEqual([["facts"], [4, 5, 6, 7, 8, 9, 10], [7 * DAY]]);
	});

	test("does nothing while a run is active or a start is prepared, and comes back in an hour", async () => {
		write(4);
		store.acknowledge(4);
		now = 7 * DAY;
		db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at) VALUES ('r', 'running', 0, '{}', 0)").all();
		await retention.pass();
		db.prepare("UPDATE runs SET status = 'completed'").all();
		db.prepare("INSERT INTO internal_starts (run_id, part, text) VALUES ('s', 0, '{}')").all();
		await retention.pass();
		expect([held(), host.scheduled]).toEqual([[1, 2, 3, 4], [7 * DAY + RETENTION.busyMs, 7 * DAY + RETENTION.busyMs]]);
		store.deletePreparation("s");
		await retention.pass();
		expect(held()).toEqual([]);
	});

	test("never throws: a failure is logged and tried again after 30 s, doubling, and the step it committed stays", async () => {
		RETENTION.rowsPerStep = 2;
		write(4);
		store.acknowledge(4);
		now = 7 * DAY;
		host.fail = 2;
		expect(await retention.pass()).toEqual({ rescheduleAt: 7 * DAY + 30_000 });
		expect(await retention.pass()).toEqual({ rescheduleAt: 7 * DAY + 60_000 });
		expect([held(), host.scheduled, host.logged]).toEqual([[], [7 * DAY + 30_000, 7 * DAY + 60_000], ["retention failed (1 in a row)", "retention failed (2 in a row)"]]);
		expect(await retention.pass()).toBeUndefined();
	});
});

describe("the next time", () => {
	test("is the earliest due item, an item a whole pass left due counts as a day from now, and none when nothing is left", () => {
		expect(nextPass(100, [500, null, 300])).toBe(300);
		expect(nextPass(100, [50, 2 * DAY])).toBe(100 + DAY);
		expect(nextPass(100, [50, 400])).toBe(400);
		expect(nextPass(100, [null])).toBeNull();
		expect(nextPass(100, [])).toBeNull();
	});

	test("after failures backs off from 30 s, doubling to an hour", () => {
		expect([1, 2, 3, 7, 8, 30].map(retryMs)).toEqual([30_000, 60_000, 120_000, 1_920_000, 3_600_000, 3_600_000]);
	});
});

describe("a run's prune", () => {
	/** A run that ended at `finishedAt`, owing no settlement, with `events` events. */
	function ended(id: string, session: string | null, finishedAt: number, events: number): void {
		db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, session, created_at, finished_at) VALUES (?, 'completed', 0, '{}', ?, 0, ?)").all(id, session, finishedAt);
		for (let seq = 1; seq <= events; seq++) db.prepare("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, 'phase', '{}', 0)").all(id, seq);
	}

	const state = () => db.prepare("SELECT id, prune, pruned_at, snapshot FROM runs ORDER BY id").all();
	const events = () => db.prepare("SELECT run_id, seq FROM run_events ORDER BY run_id, seq").all();

	test("goes in steps of at most rowsPerStep from 30 days after the run's end; its snapshot is unreadable from its first", async () => {
		RETENTION.rowsPerStep = 3;
		ended("a", null, 0, 5);
		ended("b", null, DAY, 1);
		expect(retention.due()).toBe(30 * DAY);
		now = 30 * DAY - 1;
		await retention.pass();
		expect([host.steps, host.scheduled, events().length]).toEqual([[], [30 * DAY], 6]);

		now = 30 * DAY;
		await retention.pass();
		expect([host.steps, state(), events()]).toEqual([
			["runs", "runs"],
			[
				{ id: "a", prune: "done", pruned_at: 30 * DAY, snapshot: "" },
				{ id: "b", prune: null, pruned_at: null, snapshot: "{}" },
			],
			[{ run_id: "b", seq: 1 }],
		]);
		expect(() => store.snapshot({ id: "a" })).toThrow("The run's inputs were deleted after it ended.");
		expect(host.scheduled).toEqual([30 * DAY, 31 * DAY]);
		expect(retention.due()).toBe(31 * DAY);
	});

	test("waits in its pi stage while pi's schema is unknown, and the other runs' records are still deleted", async () => {
		ended("a", "7", 0, 2);
		ended("b", null, 0, 2);
		now = 30 * DAY;
		await retention.pass();
		expect([host.steps, state(), events(), host.logged]).toEqual([
			["runs", "pi", "runs"],
			[
				{ id: "a", prune: "pi", pruned_at: 30 * DAY, snapshot: "" },
				{ id: "b", prune: "done", pruned_at: 30 * DAY, snapshot: "" },
			],
			[],
			["pi's schema is version null, not 1: pi sessions are not deleted"],
		]);
		// Due and blocked: looked at again a day later.
		expect(host.scheduled).toEqual([30 * DAY + RETENTION.blockedMs]);
	});
});

describe("a deleted conversation's purge", () => {
	const deleted = (at: number) => db.prepare("UPDATE conversation SET deleted_at = ?").all(at);

	test("waits 7 days from the deletion, then every fact acknowledged and pruned, every run settled and no write dispatched", async () => {
		deleted(DAY);
		write(2);
		db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, finished_at, metered) VALUES ('r', 'completed', 0, '{}', 0, 0, 1)").all();
		db.prepare("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES ('r', 'k', 'dispatched', 1, 0, 0)").all();
		expect(retention.due()).toBe(8 * DAY);
		now = 8 * DAY - 1;
		await retention.pass();
		expect([host.purged, host.logged]).toEqual([[], []]);

		now = 8 * DAY;
		await retention.pass();
		expect([host.purged, host.logged]).toEqual([[], ["a deleted conversation is kept: 2 facts are not acknowledged"]]);
		expect(host.scheduled.at(-1)).toBe(9 * DAY);
		store.acknowledge(2);
		await retention.pass();
		expect(host.purged).toEqual([]);
		now = 15 * DAY;
		await retention.pass();
		expect([held(), host.purged]).toEqual([[], []]);
		db.prepare("UPDATE run_writes SET status = 'uncertain'").all();
		await retention.pass();
		expect(host.purged).toEqual([]);
		db.prepare("UPDATE runs SET settled_at = 0").all();
		await retention.pass();
		expect(host.purged).toEqual(["clean", "mark", "blobs", "storage"]);
		expect(host.logged).toEqual(["a deleted conversation is kept: 2 facts are not acknowledged"]);
	});

	test("deletes the blobs a page at a time within the pass's budget, at least one a pass, and comes back at once", async () => {
		deleted(0);
		now = 7 * DAY;
		host.pages = 3;
		RETENTION.passMs = 0;
		expect(await retention.pass()).toEqual({ rescheduleAt: 7 * DAY });
		expect([host.purged, host.steps]).toEqual([["clean", "mark", "blobs"], ["clean", "mark", "blobs"]]);
		RETENTION.passMs = PERIODS.passMs;
		host.purged = [];
		expect(await retention.pass()).toBeUndefined();
		expect(host.purged).toEqual(["clean", "mark", "blobs", "blobs", "blobs", "storage"]);
	});

	test("a conversation not deleted, or the Workspace's, is never purged", async () => {
		now = 30 * DAY;
		await retention.pass();
		db.prepare("UPDATE conversation SET organization_id = NULL, deleted_at = 0").all();
		await retention.pass();
		expect([host.purged, retention.due()]).toEqual([[], null]);
	});
});
