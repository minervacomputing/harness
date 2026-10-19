// A model call's admission: before each call the store
// compares the run's spend so far (its settled calls and ended scripts, its open scripts and its container time until
// now) with its allowance, and a run that reached it ends with `budget_reached` in the same change, recording nothing. And a
// run's claim of the conversation's pi conversation. The store runs over node:sqlite with every schema step applied.

import type { Fact, RoutePrices } from "@minerva/contract/internal";
import { beforeEach, expect, test } from "vitest";
import { type Prices, pricesVersion } from "../../src/budget/prices.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { reservation } from "../../src/model/policy.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

/** 1 µ$ a token, 1 µ$ a millisecond of container or script time, and 1,000 µ$ a script. */
const ROUTE: RoutePrices = { provider: "fake", model: "fake-1", input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
const RUN = "0190a000-0000-7000-8000-000000000001";
const FENCE = { runId: RUN, attempt: 1 };
const REQUEST = { provider: ROUTE.provider, model: ROUTE.model, reserved: reservation(8192), summary: false };
const MESSAGE = "This conversation reached its budget.";

let db: ReturnType<typeof openDatabase>;
let now: number;
let store: RunStore;
let prices: Prices;

beforeEach(async () => {
	db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	// A Laravel conversation, which writes facts, and its running run.
	db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
	db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, metered) VALUES (?, 'running', 0, '{}', 0, 1)").all(RUN);
	db.prepare("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, 1, 0)").all(RUN);
	now = 1_000_000;
	store = new RunStore(durableStorage(db), () => now);
	const table = { routes: [ROUTE], container: { instance: "standard-1", perHour: 3_600_000 }, script: { perScript: 1_000, perHour: 3_600_000 } };
	prices = { version: await pricesVersion(table), table };
});

const allow = (allowance: number | null) => db.prepare("UPDATE runs SET allowance = ? WHERE id = ?").all(allowance, RUN);
const run = () => db.prepare("SELECT status, error_code, error_message, model_calls, spent FROM runs WHERE id = ?").all(RUN)[0];
const records = () => (db.prepare("SELECT count(*) AS count FROM call_records").all()[0] as { count: number }).count;
const finished = () =>
	(db.prepare("SELECT fact FROM facts ORDER BY seq").all() as { fact: string }[]).map((row) => JSON.parse(row.fact) as Fact).filter((fact) => fact.type === "run.finished");

/** A call admitted and settled as reported, charged `micros` (1 µ$ a token). */
function spend(micros: number): void {
	const call = store.recordModelCall(FENCE, REQUEST, prices);
	if (call === null) throw new Error("The call was not admitted.");
	store.settleModelCall(RUN, call, { outcome: "reported", tokens: { input: micros, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: null });
}

test.each([
	["under", 99, true],
	["at", 100, false],
	["over", 101, false],
])("a call is admitted while spent is under the allowance, and refused %s it", (_case, spent, admitted) => {
	allow(100);
	spend(spent);
	expect(run()).toMatchObject({ spent, model_calls: 1 });
	expect(store.recordModelCall(FENCE, REQUEST, prices) !== null).toBe(admitted);
	expect(run()).toMatchObject({ status: admitted ? "running" : "failed", model_calls: admitted ? 2 : 1 });
});

test("a refused admission ends the run once, failed with budget_reached and its message, and records nothing", () => {
	allow(0);
	expect(store.recordModelCall(FENCE, REQUEST, prices)).toBeNull();
	expect(run()).toEqual({ status: "failed", error_code: "budget_reached", error_message: MESSAGE, model_calls: 0, spent: 0 });
	expect(records()).toBe(0);
	expect(db.prepare("SELECT ended FROM attempts WHERE run_id = ?").all(RUN)).toEqual([{ ended: "failed" }]);
	expect(finished().map((fact) => fact.data)).toEqual([{ status: "failed", code: "budget_reached", error: MESSAGE, message: null, folder: null }]);
	// The run has ended: a later call is refused by the fence, and ends nothing again.
	expect(store.recordModelCall(FENCE, REQUEST, prices)).toBeNull();
	expect(records()).toBe(0);
	expect(finished()).toHaveLength(1);
});

test.each([
	[1_800, false],
	[1_801, true],
])("open scripts, each with its perScript, and container time since container_since are counted: allowance %d", (allowance, admitted) => {
	allow(allowance);
	store.containerStarting(RUN);
	now += 200;
	// Set once: a later preparation does not move it.
	store.containerStarting(RUN);
	expect(store.recordScript({ ...FENCE, scriptId: "open" }, 120_000)).toBe(true);
	now += 300;
	// 500 ms of container time, and the open script's 1,000 µ$ and 300 ms.
	expect(store.recordModelCall(FENCE, REQUEST, prices) !== null).toBe(admitted);
	expect(run()).toMatchObject({ status: admitted ? "running" : "failed", spent: 0 });
});

test("a script that ended is counted at its charge, not its time since", () => {
	allow(1_101);
	expect(store.recordScript({ ...FENCE, scriptId: "ended" }, 120_000)).toBe(true);
	now += 100;
	store.endScript("ended", now, prices);
	now += 60_000;
	expect(store.recordModelCall(FENCE, REQUEST, prices)).not.toBeNull();
	expect(run()).toMatchObject({ status: "running", spent: 1_100 });
});

test("a call a gone instance left open is charged as lost before the admission, which counts it", () => {
	// Its reservation at 1 µ$ a token: 128,000 and 8,192 tokens.
	allow(100_000);
	expect(new RunStore(durableStorage(db), () => now).recordModelCall(FENCE, REQUEST, prices)).not.toBeNull();
	expect(store.recordModelCall(FENCE, REQUEST, prices)).toBeNull();
	expect(run()).toMatchObject({ status: "failed", error_code: "budget_reached", model_calls: 1, spent: 136_192 });
	expect(records()).toBe(1);
});

test("a run without an allowance admits every call, whatever it spent", () => {
	spend(1_000_000_000);
	store.containerStarting(RUN);
	expect(store.recordScript({ ...FENCE, scriptId: "open" }, 120_000)).toBe(true);
	now += 3_600_000;
	expect(store.recordModelCall(FENCE, REQUEST, prices)).not.toBeNull();
	expect(run()).toMatchObject({ status: "running", model_calls: 2, spent: 1_000_000_000 });
	expect(finished()).toEqual([]);
});

test("a call record says whether the call made a compaction's summary", () => {
	const calls = [store.recordModelCall(FENCE, REQUEST, prices), store.recordModelCall(FENCE, { ...REQUEST, summary: true }, prices)];
	const summary = (call: string | null) => (db.prepare("SELECT summary FROM call_records WHERE call = ?").all(call)[0] as { summary: number }).summary;
	expect(calls.map(summary)).toEqual([0, 1]);
});

test("a run claims the conversation's pi conversation: a creator's ids become the conversation's, later runs copy them, and a claim is kept", () => {
	const [second, third] = ["0190a000-0000-7000-8000-000000000002", "0190a000-0000-7000-8000-000000000003"];
	for (const id of [second, third]) db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, metered) VALUES (?, 'running', 0, '{}', 0, 1)").all(id);
	const ids = (id: string) => db.prepare("SELECT session, provider_session FROM runs WHERE id = ?").all(id)[0];
	const conversation = () => db.prepare("SELECT pi_session, pi_provider_session FROM conversation").all()[0];
	expect(store.conversationSession()).toBeNull();

	// The conversation's first run created pi conversation 7: its ids are the conversation's and the run's, in one write.
	expect(store.claimSession(RUN, { session: "7", providerSession: "p7" })).toBe("7");
	expect([conversation(), ids(RUN), store.conversationSession()]).toEqual([{ pi_session: "7", pi_provider_session: "p7" }, { session: "7", provider_session: "p7" }, "7"]);
	// A later run creates nothing and copies the conversation's.
	expect(store.claimSession(second, null)).toBe("7");
	expect(ids(second)).toEqual({ session: "7", provider_session: "p7" });
	// A second creator, which the lane rules out, gets the conversation's ids, and its own pi conversation is an orphan.
	expect(store.claimSession(third, { session: "9", providerSession: "p9" })).toBe("7");
	expect([conversation(), ids(third)]).toEqual([{ pi_session: "7", pi_provider_session: "p7" }, { session: "7", provider_session: "p7" }]);
	// A run that already holds a session, as a run from before they were shared does, keeps it.
	db.prepare("UPDATE runs SET session = '3', provider_session = 'p3' WHERE id = ?").all(second);
	expect(store.claimSession(second, null)).toBe("3");
	expect(ids(second)).toEqual({ session: "3", provider_session: "p3" });
});
