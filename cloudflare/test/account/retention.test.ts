// Retention on the account (docs/plans/chunk-15a-design.md, Live checks), in conversations whose plan sets periods of a
// minute (src/faults/ports.ts, `retention`), so the platform's own alarms run the `retain` job:
//
// - two finished turns, the fake Laravel holding back the second's facts, and the object reset (`abort`) after the first step
//   of a pass: the next alarm finishes, the runs keep nothing of their own and pi nothing of their sessions, every fact Laravel
//   lacks is still held, and a replay from below the floor is refused with the floor;
// - a deleted conversation with a file: kept through its window, then its objects in R2 and its storage are gone, its alarm
//   with them, and Laravel's late commands are answered from the recovery index.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`; never against production.

import { ORPCError } from "@orpc/client";
import { afterAll, describe, expect, test } from "vitest";
import {
	type Fault,
	LIST_INBOX,
	type Retention,
	type World,
	commands,
	delivered,
	failDeliveries,
	fired,
	finish,
	heldFacts,
	laravel,
	objects,
	outcome,
	post,
	purged,
	run,
	script,
	settled,
	sleep,
	storage,
	upload,
	world,
} from "./driver.ts";

const MINUTE: Retention = { runMs: 60_000, factsMs: 60_000, deletedMs: 60_000, busyMs: 10_000, blockedMs: 30_000 };

afterAll(finish, 300_000);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 300_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value !== undefined && done(value)) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`${what}; last: ${JSON.stringify(value)}`);
		await sleep(2_000);
	}
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; status: number; data: unknown }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) return { code: error.code, status: error.status, data: error.data };
		throw error;
	}
	throw new Error("The call did not fail.");
}

const named = (w: World) => ({ scope: w.scope, conversation: w.conversationId });

/** The id just below `id`, so a listing after it starts at `id`. */
function below(id: string): string {
	const hex = (BigInt(`0x${id.replaceAll("-", "")}`) - 1n).toString(16).padStart(32, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const prune = async (w: World, runId: string) => (await run(w, runId)).internals.run?.prune ?? null;

describe.concurrent("retention with periods of a minute", () => {
	test("a reset after a pass's first step: the next alarm finishes, and every fact Laravel lacks is kept", async () => {
		const faults: Fault[] = [
			{ point: "retain:step", mode: "abort" },
			{ point: "retain:step", mode: "note", times: 1_000 },
		];
		const w = await world({ faults, retention: MINUTE });
		const first = await post(w, script([LIST_INBOX, { text: "First." }]));
		expect((await settled(w, first)).head?.status).toBe("completed");
		await delivered(w, first);
		// From here the fake Laravel answers every delivery 503: it acknowledges nothing of the second turn.
		await failDeliveries(w, 1_000_000);
		const second = await post(w, script([LIST_INBOX, { text: "Second." }]));
		const view = await settled(w, second);
		expect(view.head?.status, outcome(view)).toBe("completed");

		await until(async () => [await prune(w, first), await prune(w, second)], (states) => states.every((state) => state === "done"), "the runs were not pruned");
		const held = await until(
			() => heldFacts(w),
			(facts) => facts.delivery !== null && facts.lowest === facts.delivery.acknowledged + 1,
			"the facts Laravel acknowledged were not pruned",
		);
		const points = (await fired(w)).filter((entry) => entry.point === "retain:step");
		expect(points[0]?.mode, "the first step's reset").toBe("abort");
		expect(points.slice(1).map((entry) => entry.mode)).toContain("note");

		const tables = (await storage(w)).tables;
		const rows = (table: string) => tables[table]?.rows ?? 0;
		expect(["run_events", "run_snapshots", "attempts", "tool_executions", "call_records", "run_writes"].map(rows)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(["pi_entries", "pi_tasks", "pi_submissions"].map(rows)).toEqual([0, 0, 0]);
		expect(rows("pi_conversations"), "only pi's root conversation").toBe(1);
		expect(rows("runs")).toBe(2);

		// Laravel lacks every fact above its watermark, and the engine holds each of them.
		const { facts: applied } = await laravel(w);
		const delivery = held.delivery as { written: number; acknowledged: number; floor: number };
		expect(delivery.acknowledged).toBe(Math.max(...applied.map((fact) => fact.seq)));
		expect(delivery.written).toBeGreaterThan(delivery.acknowledged);
		expect([held.count, held.lowest, held.highest, delivery.floor]).toEqual([delivery.written - delivery.acknowledged, delivery.acknowledged + 1, delivery.written, delivery.acknowledged + 1]);
		const page = await commands.replayFacts({ ...named(w), after: delivery.acknowledged, limit: 500 });
		expect(page.facts.map((fact) => fact.seq)).toEqual(Array.from({ length: held.count }, (_value, index) => delivery.acknowledged + 1 + index));
		expect(page.facts.filter((fact) => fact.type === "run.settled").map((fact) => fact.run)).toEqual([second]);
		expect(await refusalOf(commands.replayFacts({ ...named(w), after: 0, limit: 500 }))).toEqual({ code: "FACTS_PRUNED", status: 410, data: { floor: delivery.floor } });

		await failDeliveries(w, 0);
	});

	test("a deleted conversation is kept through its window, then its files and its object are gone, and a late start is refused", async () => {
		const w = await world({ retention: MINUTE });
		const attachment = await upload(w, { name: "kept.txt", text: "A file of the conversation." });
		const runId = await post(w, "Hello", [attachment]);
		expect((await settled(w, runId)).head?.status).toBe("completed");
		await delivered(w, runId);
		const files = await objects(w);
		expect(files).toBeGreaterThan(0);

		const deleting = Date.now();
		expect(await commands.deleteConversation(named(w))).toEqual({ outcome: "deleted" });
		const deletedAt = Date.now();
		expect([await objects(w), (await storage(w)).tables.runs?.rows], "kept through its window").toEqual([files, 1]);
		await until(() => objects(w), (count) => count === 0, "the conversation's files are still in R2");
		purged(w);
		expect(Date.now() - deletedAt).toBeGreaterThanOrEqual(60_000);

		// Read now, the object is made again, and the read opens pi: its schema's rows and pi's root conversation, empty, are all
		// it holds, with no alarm.
		const emptied = await until(
			() => storage(w),
			(reading) => (reading.tables.conversation?.rows ?? 1) === 0,
			"the conversation's storage is not deleted",
		);
		const kept = Object.fromEntries(Object.entries(emptied.tables).flatMap(([table, { rows }]) => (rows > 0 ? [[table, rows]] : [])));
		expect(kept).toEqual({ _migrations: 15, pi_conversations: 1, pi_document_revisions: 5, pi_documents: 5, pi_durable_metadata: 1, pi_durable_schema: 1, pi_record_ids: 6 });
		expect(emptied.alarm).toBeNull();

		await expect(post(w, "Hello again")).rejects.toThrow(/^Refused: CONVERSATION_DELETED /);
		expect(await commands.cancelRun({ ...named(w), run: runId, reason: "cancelled" })).toEqual({ state: "ended" });
		expect(await commands.deleteConversation(named(w))).toEqual({ outcome: "deleted" });

		// Laravel's recovery listing (chunk 15c) answers it purged, with every fact it was sent.
		const listed = await commands.listConversations({ environment: w.scope.environment, after: below(w.conversationId), limit: 1 });
		const { organization, workspace } = w.scope;
		const factSeq = (await laravel(w)).facts.at(-1)?.seq;
		expect(listed.conversations).toEqual([{ conversation: w.conversationId, organization, workspace, factSeq, deletedAt: expect.any(String), purgedAt: expect.any(String) }]);
		const [entry] = listed.conversations;
		const [deletedTime, purgedTime] = [Date.parse(entry?.deletedAt as string), Date.parse(entry?.purgedAt as string)];
		// The Worker's clock against this machine's, a few seconds apart at most; the purge waits the window by the Worker's alone.
		expect(deletedTime >= deleting - 5_000 && deletedTime <= deletedAt + 5_000 && purgedTime >= deletedTime + 60_000, JSON.stringify(entry)).toBe(true);
	});
});
