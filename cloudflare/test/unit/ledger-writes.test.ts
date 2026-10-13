// gateway/ledger.ts and gateway/run-state.ts on real SQLite: the write ledger's protocol, the lost-write
// sweep, the restart gate's marking (plan: Writes), claims fenced by attempt, and a ledger reopened over the
// same database file, as after a crash.

import { afterAll, describe, expect, test } from "vitest";
import { LOST_WRITE_GRACE_MS, WRITE_MESSAGES, WRITE_WINDOW_MS, WriteLedger, writeKey } from "../../src/gateway/ledger.ts";
import { PageTokens, queryHash } from "../../src/gateway/page-tokens.ts";
import { LedgerRunState } from "../../src/gateway/run-state.ts";
import { canonicalJson } from "../../src/lib/canonical.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { parseJson } from "../../src/lib/json.ts";
import { FakeClock, FakeRuns } from "./executor-fakes.ts";
import { ledgerSql, openDatabase, scratchDirectory } from "./sqlite.ts";

const RUN = "0199a000-0000-7000-8000-0000000000c1";
const OTHER = "0199a000-0000-7000-8000-0000000000c2";
const K1 = "a".repeat(64);
const K2 = "b".repeat(64);
const RESULT = { items: [{ id: "copy-1" }], count: 1 };

function setup(deadline: number | null = null) {
	const clock = new FakeClock();
	const sql = ledgerSql();
	const ledger = new WriteLedger(sql, clock);
	const runs = new FakeRuns();
	runs.add(RUN, { deadline });
	runs.add(OTHER, { deadline });
	const state = new LedgerRunState(runs, ledger, new PageTokens(sql, () => clock.now()), clock);
	return { clock, sql, ledger, runs, state };
}

const scratch = scratchDirectory();
afterAll(() => scratch.done());

describe("write keys and query hashes", () => {
	test("hash the tool and the normalized fields, keys sorted at every depth", async () => {
		const a = await writeKey("todoist_create_task", { title: "x", project_id: "work", nested: { b: 1, a: [2, { d: 1, c: 2 }] } });
		const b = await writeKey("todoist_create_task", { nested: { a: [2, { c: 2, d: 1 }], b: 1 }, project_id: "work", title: "x" });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(await writeKey("todoist2_create_task", { title: "x", project_id: "work", nested: { b: 1, a: [2, { d: 1, c: 2 }] } })).not.toBe(a);
	});

	test("cover a purpose label and the canonical JSON (RFC 8785) of the value", async () => {
		expect(await writeKey("t", { v: 1, a: "\u00e9" })).toBe(await sha256Hex('minerva:write-key:{"arguments":{"a":"\u00e9","v":1},"tool":"t"}'));
		expect(await queryHash({ v: 1, cursor: "page-2" })).toBe(await sha256Hex('minerva:query:{"v":1}'));
		// The same value hashed for another purpose is another hash.
		expect(await queryHash({ arguments: { v: 1 }, tool: "t" })).not.toBe(await writeKey("t", { v: 1 }));
	});

	test("values the API treats as different never collide", async () => {
		const distinct: [string, { [key: string]: unknown }][] = [
			["t", {}],
			["t", { a: null }],
			["t", { a: 0 }],
			["t", { a: "0" }],
			["t", { a: false }],
			["t", { a: "" }],
			["t", { a: [] }],
			["t", { a: {} }],
			["t", { a: [null] }],
			["t", { a: 1.5 }],
			["t", { a: "1.5" }],
			["t", { a: "x", b: "y" }],
			["t", { a: "x,b:y" }],
			["t", { 'a":"x","b': "y" }],
			["t", { a: { b: "y" } }],
			["t", { "a.b": "y" }],
			["t", { a: ["x", "y"] }],
			["t", { a: "x\u0000y" }],
			["t", { a: "\u00e9" }],
			["t", { a: "e\u0301" }],
			["t", { a: "\\u00e9" }],
			["t", { A: "x" }],
			["t", { a: "X" }],
			["t", { a: " x" }],
			["t", { a: 9007199254740991 }],
			["t", { a: 9007199254740990 }],
			["t", JSON.parse('{"__proto__":{"a":"x"}}')],
			["t:", {}],
			["t", { tool: "t" }],
			["u", {}],
			["t_x", {}],
		];
		const keys = await Promise.all(distinct.map(([tool, fields]) => writeKey(tool, fields)));
		expect(new Set(keys).size).toBe(distinct.length);
		const hashes = await Promise.all(distinct.map(([, fields]) => queryHash(fields)));
		// Query hashes leave the tool out (the token's row binds it), so only distinct fields count.
		expect(new Set(hashes).size).toBe(new Set(distinct.map(([, fields]) => canonicalJson(fields))).size);
		expect(new Set(hashes).size).toBe(distinct.length - 3);
	});

	test("refuse values whose identity is ambiguous rather than coerce them", async () => {
		await expect(writeKey("t", { a: undefined })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: [undefined] })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: Number.NaN })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: Number.POSITIVE_INFINITY })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: "\ud800" })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { "\udc00": 1 })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: new Date(0) })).rejects.toThrow(TypeError);
		await expect(writeKey("t", { a: 1n })).rejects.toThrow(TypeError);
		// parseJson rounds both to 2^53, so they would hash alike: an identity refuses them.
		expect(parseJson("9007199254740993")).toBe(parseJson("9007199254740992"));
		await expect(writeKey("t", { a: parseJson("9007199254740993") })).rejects.toThrow(TypeError);
		await expect(queryHash({ a: -(2 ** 53) })).rejects.toThrow(TypeError);
		await expect(queryHash({ a: 1e300 })).rejects.toThrow(TypeError);
	});
});

describe("dispatch and settle", () => {
	test("a write is claimed with its deadline fixed at dispatch, cut by the run's deadline", () => {
		const { clock, ledger } = setup();
		const dispatched = ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		expect(dispatched).toEqual({ kind: "dispatched", deadline: clock.mono + WRITE_WINDOW_MS });
		expect(ledger.known(RUN, K1)).toEqual({ runId: RUN, key: K1, status: "dispatched", result: null, attempt: 1, dispatchedAt: clock.epoch, deadlineAt: clock.epoch + WRITE_WINDOW_MS });
		const cut = setup();
		expect(cut.ledger.dispatch({ runId: RUN, attempt: 2 }, K1, cut.clock.now() + 10_000)).toEqual({ kind: "dispatched", deadline: cut.clock.mono + 10_000 });
		expect(cut.ledger.known(RUN, K1)?.attempt).toBe(2);
	});

	test("one write at a time per run, with the three refusals", () => {
		const { ledger } = setup();
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null)).toEqual({ kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.identicalInProgress });
		expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K2, null)).toEqual({ kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress });
		// Another run is not held up.
		expect(ledger.dispatch({ runId: OTHER, attempt: 1 }, K2, null).kind).toBe("dispatched");
		expect(ledger.settle(RUN, K1, { effect: "unknown" })).toBe(true);
		expect(ledger.paused(RUN)).toBe(true);
		expect(ledger.paused(OTHER)).toBe(false);
		expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null)).toEqual({ kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain });
		expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K2, null)).toEqual({ kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
		expect(WRITE_MESSAGES).toEqual({
			identicalUncertain: "This write has an unknown outcome. Check the provider before retrying.",
			identicalInProgress: "An identical write is already in progress.",
			paused: "A previous write has an unknown outcome. Further writes in this run are paused.",
			otherInProgress: "Another write in this run is still in progress.",
			unknown: "The write outcome is unknown. Check the provider; further writes in this run are paused.",
		});
	});

	test("a refused write is forgotten; an applied one answers repeats; the pause is sticky", () => {
		const { ledger } = setup();
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		ledger.settle(RUN, K1, { effect: "not_applied" });
		expect(ledger.writes(RUN)).toEqual([]);
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		ledger.settle(RUN, K1, { effect: "applied", result: RESULT });
		expect(ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null)).toEqual({ kind: "cached", result: RESULT });
		expect(ledger.known(RUN, K1)?.status).toBe("succeeded");
		// Only a dispatched row is settled: a second settle changes nothing.
		expect(ledger.settle(RUN, K1, { effect: "unknown" })).toBe(false);
		expect(ledger.paused(RUN)).toBe(false);
		ledger.dispatch({ runId: RUN, attempt: 1 }, K2, null);
		ledger.settle(RUN, K2, { effect: "unknown" });
		expect(ledger.settle(RUN, K2, { effect: "applied", result: RESULT })).toBe(false);
		expect(ledger.known(RUN, K2)?.status).toBe("uncertain");
		expect(ledger.paused(RUN)).toBe(true);
	});

	test("a result too large for a row is remembered as applied without a result", () => {
		const { ledger } = setup();
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		ledger.settle(RUN, K1, { effect: "applied", result: { items: [{ text: "é".repeat(600_000) }], count: 1 } });
		expect(ledger.known(RUN, K1)).toMatchObject({ status: "succeeded", result: { items: [], count: 0, outcome: "applied_without_result" } });
		expect(ledger.paused(RUN)).toBe(false);
	});

	test("results keep every key, \"__proto__\" included", () => {
		const { ledger } = setup();
		const result = { items: [Object.defineProperty({ a: 1 }, "__proto__", { value: { b: 2 }, enumerable: true, writable: true, configurable: true })], count: 1 };
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		ledger.settle(RUN, K1, { effect: "applied", result });
		const stored = ledger.known(RUN, K1)?.result?.items[0] as object;
		expect(Object.keys(stored)).toEqual(["a", "__proto__"]);
		expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
	});
});

describe("the run-state port", () => {
	test("a claim needs the current attempt of an acting, unexpired, unrevoked run", () => {
		const { clock, runs, state } = setup(Date.UTC(2026, 9, 12, 12, 5));
		expect(state.isCurrent({ runId: RUN, attempt: 1 })).toBe(true);
		expect(state.isCurrent({ runId: RUN, attempt: 2 })).toBe(false);
		expect(state.isCurrent({ runId: "0199a000-0000-7000-8000-0000000000ff", attempt: 1 })).toBe(false);
		// A replaced attempt cannot reserve a write.
		runs.set(RUN, { attempt: 2 });
		expect(state.dispatchWrite({ runId: RUN, attempt: 1 }, K1)).toEqual({ kind: "refused", code: "RUN_ENDED", message: "This run is no longer active." });
		expect(state.knownWrite(RUN, K1)).toBeNull();
		// A replaced attempt's answer is still recorded: active ignores the attempt.
		expect(state.isActive(RUN)).toBe(true);
		for (const patch of [{ status: "queued" as const }, { status: "cancelled" as const }, { revoked: true }]) {
			runs.set(RUN, { status: "running", revoked: false, ...patch });
			expect([state.isActive(RUN), state.dispatchWrite({ runId: RUN, attempt: 2 }, K1).kind]).toEqual([false, "refused"]);
		}
		runs.set(RUN, { status: "provisioning", revoked: false });
		expect(state.isActive(RUN)).toBe(true);
		// Expired: inactive for every check before it is marked timed_out.
		clock.advance(5 * 60_000);
		expect([state.isActive(RUN), state.isCurrent({ runId: RUN, attempt: 2 }), state.countToolCall({ runId: RUN, attempt: 2 })]).toEqual([false, false, false]);
		expect(runs.toolCalls(RUN)).toBe(0);
	});

	test("calls are counted only for the current attempt, and never limited", () => {
		const { runs, state } = setup();
		runs.set(RUN, { toolCalls: 1000 });
		for (let i = 0; i < 3; i++) expect(state.countToolCall({ runId: RUN, attempt: 1 })).toBe(true);
		expect(state.countToolCall({ runId: RUN, attempt: 2 })).toBe(false);
		expect(runs.toolCalls(RUN)).toBe(1003);
	});
});

describe("lost writes", () => {
	test("the sweep marks writes still dispatched 30 s past their deadline", () => {
		const { clock, ledger } = setup();
		const dispatchedWith = (deadline: number) => {
			ledger.forget(RUN);
			clock.epoch = deadline - WRITE_WINDOW_MS;
			ledger.dispatch({ runId: RUN, attempt: 1 }, "k", null);
		};
		const now = Date.UTC(2026, 9, 12, 13);
		dispatchedWith(now - 10_000);
		expect(ledger.sweep(now)).toEqual([]);
		expect(ledger.nextSweepAt()).toBe(now - 10_000 + LOST_WRITE_GRACE_MS);
		dispatchedWith(now - 40_000);
		expect(ledger.sweep(now)).toEqual([{ runId: RUN, key: "k" }]);
		expect(ledger.paused(RUN)).toBe(true);
		expect(ledger.writes(RUN).map((write) => write.status)).toEqual(["uncertain"]);
		expect(ledger.nextSweepAt()).toBeNull();
	});

	test("the restart gate makes the dead attempt's dispatched writes uncertain, in its own transaction", () => {
		const { sql, ledger } = setup();
		ledger.dispatch({ runId: RUN, attempt: 1 }, K1, null);
		ledger.dispatch({ runId: OTHER, attempt: 1 }, K1, null);
		const marked = sql.transaction(() => ledger.markDispatchedUncertain(RUN));
		expect(marked).toEqual([{ runId: RUN, key: K1 }]);
		expect([ledger.paused(RUN), ledger.paused(OTHER)]).toEqual([true, false]);
		expect(ledger.markDispatchedUncertain(RUN)).toEqual([]);
		// A gate that throws after marking rolls the marking back with its decision.
		expect(() =>
			sql.transaction(() => {
				ledger.markDispatchedUncertain(OTHER);
				throw new Error("the gate failed");
			}),
		).toThrow("the gate failed");
		expect(ledger.known(OTHER, K1)?.status).toBe("dispatched");
	});

	test("a ledger reopened over the same database after a crash sees what was dispatched", () => {
		const path = `${scratch.path}/conversation.sqlite`;
		const clock = new FakeClock();
		const before = openDatabase(path);
		new WriteLedger(ledgerSql(before), clock).dispatch({ runId: RUN, attempt: 1 }, K1, null);
		before.close();
		const after = new WriteLedger(ledgerSql(openDatabase(path)), clock);
		expect(after.known(RUN, K1)?.status).toBe("dispatched");
		expect(after.dispatch({ runId: RUN, attempt: 2 }, K2, null)).toEqual({ kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress });
		expect(after.markDispatchedUncertain(RUN)).toHaveLength(1);
		expect(after.dispatch({ runId: RUN, attempt: 2 }, K1, null)).toEqual({ kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain });
		expect(after.dispatch({ runId: RUN, attempt: 2 }, K2, null)).toEqual({ kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
	});

	test("at most one write per run is dispatched, also against a buggy caller", () => {
		const { sql } = setup();
		sql.exec("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES (?, ?, 'dispatched', 1, 0, 0)", RUN, K1);
		expect(() => sql.exec("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES (?, ?, 'dispatched', 1, 0, 0)", RUN, K2)).toThrow(/UNIQUE/);
		expect(() => sql.exec("INSERT INTO run_writes (run_id, key, status, attempt, dispatched_at, deadline_at) VALUES (?, ?, 'done', 1, 0, 0)", RUN, K2)).toThrow(/CHECK/);
	});
});
