// lib/sql.ts's Durable Object adapter in workerd, and the write ledger and page tokens on a Durable
// Object's SQLite: their schema applied as one migration step, statements with bindings and RETURNING,
// transactions that roll back and nest, and the ledger's protocol. The unit tests run the same code on
// node:sqlite (test/unit/ledger-*.test.ts).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { scriptsObject } from "../../src/addressing.ts";
import { LEDGER_NOTES_SCHEMA, LEDGER_SCHEMA, LOST_WRITE_GRACE_MS, WRITE_MESSAGES, WriteLedger } from "../../src/gateway/ledger.ts";
import { PAGE_TOKEN_SCHEMA, PageTokens } from "../../src/gateway/page-tokens.ts";
import { durableSql } from "../../src/lib/sql.ts";
import { migrate } from "../../src/lib/sqlite.ts";

const WS = { id: "0199a000-0000-7000-8000-0000000000aa", jurisdiction: null };
const RUN = "0199a000-0000-7000-8000-0000000000c1";
const K1 = "a".repeat(64);
const K2 = "b".repeat(64);

let objects = 0;

function object() {
	return scriptsObject(env, WS, `0199a000-0000-7000-8000-${String(++objects).padStart(12, "0")}`);
}

const clock = { now: () => Date.UTC(2026, 9, 12, 12), monotonic: () => 1_000_000 };

describe("durableSql", () => {
	test("binds values, returns rows, and rolls a transaction back when its body throws", async () => {
		await runInDurableObject(object(), (_, state) => {
			const sql = durableSql(state.storage);
			sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT");
			expect(sql.exec("INSERT INTO t (k, n) VALUES (?, ?)", "a", 1)).toEqual([]);
			expect(sql.exec("INSERT INTO t (k, n) VALUES (?, ?) RETURNING k", "b", 2)).toEqual([{ k: "b" }]);
			expect(sql.exec("SELECT ? AS v", null)).toEqual([{ v: null }]);
			expect(() =>
				sql.transaction(() => {
					sql.exec("INSERT INTO t (k, n) VALUES ('c', 3)");
					throw new Error("no");
				}),
			).toThrow("no");
			expect(sql.exec("SELECT k FROM t ORDER BY k")).toEqual([{ k: "a" }, { k: "b" }]);
			const kept = sql.transaction(() => {
				sql.exec("INSERT INTO t (k, n) VALUES ('c', 3)");
				try {
					sql.transaction(() => {
						sql.exec("INSERT INTO t (k, n) VALUES ('d', 4)");
						throw new Error("inner");
					});
				} catch {
					// Only the inner one is undone.
				}
				return sql.exec<{ k: string }>("SELECT k FROM t ORDER BY k").map((row) => row.k);
			});
			expect(kept).toEqual(["a", "b", "c"]);
		});
	});
});

describe("the ledger on a Durable Object's SQLite", () => {
	test("its schema is one migration step, and the protocol runs as on node:sqlite", async () => {
		await runInDurableObject(object(), (_, state) => {
			// A step id of its own: the Scripts object these tests borrow applies its own step 1 when it is built.
			expect(migrate(state.storage, [{ id: 100, sql: [...LEDGER_SCHEMA, ...LEDGER_NOTES_SCHEMA, ...PAGE_TOKEN_SCHEMA].join(";\n") }])).toEqual([100]);
			const sql = durableSql(state.storage);
			const ledger = new WriteLedger(sql, clock);
			expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null)).toEqual({ kind: "dispatched", deadline: 1_060_000 });
			expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K2, null)).toEqual({ kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress });
			expect(ledger.settle(RUN, K1, { effect: "applied", result: { items: [{ id: "x" }], count: 1 } })).not.toBeNull();
			expect(ledger.dispatch({ runId: RUN, attempt: 2 }, K1, null)).toEqual({ kind: "cached", result: { items: [{ id: "x" }], count: 1 } });
			ledger.dispatch({ runId: RUN, attempt: 1 }, K2, null);
			// The restart gate marks in the transaction of its decision.
			expect(state.storage.transactionSync(() => ledger.markDispatchedUncertain(RUN))).toEqual([{ runId: RUN, key: K2, tool: "", connection: "", write: "" }]);
			expect(ledger.paused(RUN)).toBe(true);
			expect(ledger.sweep(clock.now() + 120_000)).toEqual([]);
			expect(ledger.nextSweepAt()).toBeNull();
			// One write in flight per run, enforced by the index too.
			sql.exec("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES ('r2', 'k1', 'dispatched', 1, 0, 0)");
			expect(() => sql.exec("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES ('r2', 'k2', 'dispatched', 1, 0, 0)")).toThrow(/UNIQUE/);
			// Dispatched with a deadline at 0: lost once the grace after it has passed.
			expect(ledger.sweep(LOST_WRITE_GRACE_MS + 1)).toEqual([{ runId: "r2", key: "k1", tool: "", connection: "", write: "" }]);

			const tokens = new PageTokens(sql, clock.now);
			const token = tokens.issue(RUN, "todoist_list_tasks", "h", "2") as string;
			expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
			expect([tokens.resolve(RUN, token, "todoist_list_tasks", "h"), tokens.resolve(RUN, token, "todoist_list_tasks", "other")]).toEqual(["2", null]);
		});
	});
});
