// What the Conversation's store charges: each call at
// the rates its record kept, each script as it ends, the run's `spent` equal to its records' charges after every change,
// and `run.settled`'s charge. The store runs over node:sqlite with every schema step applied.

import type { Fact, RoutePrices } from "@minerva/contract/internal";
import { beforeEach, expect, test } from "vitest";
import { type Prices, priceTable, pricesVersion } from "../../src/budget/prices.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { reservation } from "../../src/model/policy.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

const GLM: RoutePrices = { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", input: 150_000, cachedInput: 30_000, cacheWrite: 150_000, output: 500_000 };
const RUN = "0190a000-0000-7000-8000-000000000001";
const FENCE = { runId: RUN, attempt: 1 };
const REQUEST = { provider: GLM.provider, model: GLM.model, reserved: reservation(8192) };

async function pricesFor(route: RoutePrices): Promise<Prices> {
	const table = priceTable(route);
	return { version: await pricesVersion(table), table };
}

let db: ReturnType<typeof openDatabase>;
let now: number;
/** This instance's store, and one of an instance that is gone. */
let store: RunStore;
let gone: RunStore;
let prices: Prices;

beforeEach(async () => {
	db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	// A Laravel conversation, which writes facts, and its running run.
	db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
	db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, metered) VALUES (?, 'running', 0, '{}', 0, 1)").all(RUN);
	now = 1_000_000;
	const storage = durableStorage(db);
	store = new RunStore(storage, () => now);
	gone = new RunStore(storage, () => now);
	prices = await pricesFor(GLM);
});

const facts = (type: Fact["type"]) =>
	(db.prepare("SELECT fact FROM facts ORDER BY seq").all() as { fact: string }[]).map((row) => JSON.parse(row.fact) as Fact).filter((fact) => fact.type === type);

/** The run's `spent`, and the sum of its records' charges, which it must always equal. */
function spent(): number {
	const { spent, calls, scripts } = db
		.prepare(
			`SELECT spent, (SELECT coalesce(sum(cost_micros), 0) FROM call_records WHERE run_id = ?1) AS calls,
				(SELECT coalesce(sum(cost_micros), 0) FROM script_records WHERE run_id = ?1) AS scripts FROM runs WHERE id = ?1`,
		)
		.all(RUN)[0] as { spent: number; calls: number; scripts: number };
	expect(spent).toBe(calls + scripts);
	return spent;
}

function record(at = prices, by = store): string {
	const call = by.recordModelCall(FENCE, REQUEST, at);
	if (call === null) throw new Error("The call was not recorded.");
	return call;
}

/** The run ends, with nothing open: its settlement is due. */
function settle(containerMs: number, at = prices): Fact {
	db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").all(RUN);
	expect(store.settleRun(RUN, { containers: containerMs ? 1 : 0, containerMs, containerEstimated: false }, at)).toBe(true);
	return facts("run.settled")[0] as Fact;
}

test("a reported, a refused and an unmetered call are each charged by rule, at the rates their records kept", () => {
	const reported = record();
	expect(spent()).toBe(0);
	store.settleModelCall(RUN, reported, { outcome: "reported", tokens: { input: 1000, output: 500, cached: 200, cacheWrite: 0, reasoning: 100 }, requestBytes: 10 });
	expect(spent()).toBe(376);
	const refused = record();
	store.settleModelCall(RUN, refused, { outcome: "refused", requestBytes: 10 });
	expect(spent()).toBe(376);
	const unmetered = record();
	store.settleModelCall(RUN, unmetered, { outcome: "unmetered", cause: "no_usage", requestBytes: null });
	expect(spent()).toBe(376 + 23_296);
	// Settled once: a second settlement changes nothing.
	store.settleModelCall(RUN, reported, { outcome: "unmetered", cause: "failed", requestBytes: null });
	expect(spent()).toBe(376 + 23_296);

	const charged = { prices: prices.version };
	expect(facts("run.usage").map((fact) => fact.data)).toEqual([
		{ call: reported, provider: GLM.provider, model: GLM.model, inputTokens: 1000, outputTokens: 500, cachedTokens: 200, cacheWriteTokens: 0, reasoningTokens: 100, requestBytes: 10, costMicros: 376, ...charged },
	]);
	expect(facts("run.unmetered").map((fact) => fact.data)).toEqual([
		{ call: refused, provider: GLM.provider, model: GLM.model, cause: "refused", inputTokens: 0, outputTokens: 0, estimated: false, requestBytes: 10, costMicros: 0, ...charged },
		{ call: unmetered, provider: GLM.provider, model: GLM.model, cause: "no_usage", inputTokens: 128_000, outputTokens: 8192, estimated: true, costMicros: 23_296, ...charged },
	]);
});

test("scripts are charged as they end, each rounded once: two 1 ms scripts are 2 × 2,001 µ$", () => {
	for (const scriptId of ["a", "b"]) {
		expect(store.recordScript({ ...FENCE, scriptId }, 120_000)).toBe(true);
		store.endScript(scriptId, now + 1, prices);
	}
	expect(spent()).toBe(4_002);
	// Ended once: a later end changes nothing.
	store.endScript("a", now + 60_000, prices);
	expect(spent()).toBe(4_002);
	expect(db.prepare("SELECT script_id, prices, cost_micros FROM script_records ORDER BY script_id").all()).toEqual([
		{ script_id: "a", prices: prices.version, cost_micros: 2_001 },
		{ script_id: "b", prices: prices.version, cost_micros: 2_001 },
	]);
	expect(settle(0).data).toMatchObject({ scripts: 2, scriptMs: 2, modelMicros: 0, containerMicros: 0, scriptMicros: 4_002, chargedMicros: 4_002 });
});

test("spent equals the records' charges after every change, the restart rule's included", () => {
	const own = record();
	const lost = record(undefined, gone);
	gone.recordScript({ ...FENCE, scriptId: "lost" }, 120_000);
	store.recordScript({ ...FENCE, scriptId: "own" }, 120_000);
	expect(spent()).toBe(0);
	now += 30_000;
	store.settleModelCall(RUN, own, { outcome: "reported", tokens: { input: 100, output: 10, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: 1 });
	expect(spent()).toBe(20);
	// The gone instance's call is charged at its reservation, its script for its time until now.
	expect(store.settleLost(prices)).toBe(2);
	expect(spent()).toBe(20 + 23_296 + 2_000 + 600);
	expect(store.settleLost(prices)).toBe(0);
	now += 1_000;
	store.endScript("own", now, prices);
	expect(spent()).toBe(20 + 23_296 + 2 * 2_000 + 600 + 620);
	expect(facts("run.unmetered").map((fact) => fact.data)).toMatchObject([{ call: lost, cause: "lost", costMicros: 23_296 }]);

	const settled = settle(60_000);
	// A minute of container time at 74,016 µ$ an hour.
	expect(settled.data).toMatchObject({ modelMicros: 20 + 23_296, containerMicros: 1_234, scriptMicros: 2 * 2_000 + 600 + 620, chargedMicros: spent() + 1_234, scriptEstimated: true });
});

test("a run's calls under two price versions are each charged at their own; its container at the version it settles with", async () => {
	const first = record();
	const raised = await pricesFor({ ...GLM, input: 300_000, output: 1_000_000 });
	const second = record(raised);
	// The first settles after the new prices came in, at the rates it was admitted under.
	const usage = { outcome: "reported" as const, tokens: { input: 1000, output: 100, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: null };
	store.settleModelCall(RUN, second, usage);
	store.settleModelCall(RUN, first, usage);
	expect(facts("run.usage").map((fact) => [(fact.data as { call: string }).call, (fact.data as { costMicros: number }).costMicros, (fact.data as { prices: string }).prices])).toEqual([
		[second, 400, raised.version],
		[first, 200, prices.version],
	]);
	expect(spent()).toBe(600);
	const settled = settle(3_600_000, raised);
	expect(settled.data).toMatchObject({ prices: raised.version, modelMicros: 600, containerMicros: 74_016, scriptMicros: 0, chargedMicros: 74_616 });
});

test("a call whose route has no price is not charged, and its run's settlement carries no charge", () => {
	const call = record({ version: "0000000000000000", table: priceTable(null) });
	store.settleModelCall(RUN, call, { outcome: "reported", tokens: { input: 100, output: 10, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: null });
	expect(spent()).toBe(0);
	expect(facts("run.usage")[0]?.data).not.toHaveProperty("costMicros");
	expect(facts("run.usage")[0]?.data).not.toHaveProperty("prices");
	const settled = settle(1_000).data;
	for (const field of ["prices", "modelMicros", "containerMicros", "scriptMicros", "chargedMicros"]) expect(settled).not.toHaveProperty(field);
	expect(settled).toMatchObject({ modelCalls: 1, inputTokens: 100, containerMs: 1_000 });
});
