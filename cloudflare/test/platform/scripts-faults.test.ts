// Code mode's faults end to end in local workerd, as test/platform/protocols.test.ts runs the protocols: Laravel's commands
// through the internal mount, the real Conversation object in the EU, the executor with its ledger, credentials leased from
// the fake Laravel, the fake Notes connector and its provider, the fake model, the real Scripts object, and the test build's
// fault points. A script's store survives a crash of the conversation, a write a script was waiting for when its wall clock
// ran out settles in the ledger and is recorded, and a crash during a script ends it unreplayed.

import { env } from "cloudflare:workers";
import type { RunEvent } from "@minerva/contract";
import type { Fact, Scope } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import type { Conversation } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { notesLease } from "../../src/faults/world.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeTurn } from "../../src/model/fake.ts";
import { SCRIPT_TIMEOUT_MS } from "../../src/scripts/limits.ts";
import { SCRIPT_CLOCK } from "../../src/scripts/run.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { commands, held, notesStart, objectOf, scope, signedAssertions, viewOf } from "./internal-support.ts";

signedAssertions();

const LIST = "notes_list_notes";
const SAVE = "notes_save_note";
const DELIVERY = { ...FACT_DELIVERY };
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
	SCRIPT_CLOCK.timeoutMs = SCRIPT_TIMEOUT_MS;
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

/** A workspace whose fake provider is seeded, a Notes connection Laravel lends, and a conversation. A stub breaks once its object was reset, so each use gets a new one. */
interface World {
	within: Scope;
	conversationId: string;
	connectionId: string;
	readonly conversation: DurableObjectStub<Conversation>;
}

async function world(faults: Fault[] = []): Promise<World> {
	const within = scope();
	const conversationId = uuid7();
	const connectionId = uuid7();
	await providerOf(env, within.workspace).reset({ delays: {} });
	fake.connections.set(connectionId, notesLease());
	const conversation = () => objectOf({ scope: within, conversation: conversationId });
	if (faults.length) await conversation().faultPlan(faults);
	return {
		within,
		conversationId,
		connectionId,
		get conversation() {
			return conversation();
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 20_000): Promise<T> {
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

const script = (code: string): FakeTurn => ({ tools: [{ name: "run_script", arguments: { code } }] });

/** Sends a start, which Laravel holds, whose model answers with `turns`; its run's id once it is accepted. */
async function post(w: World, turns: FakeTurn[], pace: { delayMs?: number; chunkChars?: number } = {}): Promise<RunId> {
	const content = JSON.stringify({ fake: { turns, ...pace } });
	const start = held(fake, notesStart(w.within, w.connectionId, { conversation: w.conversationId, message: { id: uuid7(), content, attachments: [] } }));
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return start.run;
}

/** One of Laravel's commands, so an object a fault reset starts again and runs its gate and recovery. */
function wake(w: World): Promise<unknown> {
	return commands.replayFacts({ scope: w.within, conversation: w.conversationId, after: 1_000_000_000, limit: 1 });
}

async function settled(w: World, runId: RunId): Promise<RunHead> {
	const run = await until(
		async () => {
			await wake(w);
			return (await w.conversation.faultView(runId, 0, 0)).head;
		},
		(head) => head !== null && !["queued", "provisioning", "running"].includes(head.status),
	);
	return run as RunHead;
}

async function eventsOf(w: World, runId: RunId): Promise<RunEvent[]> {
	return (await viewOf(w.conversation, runId)).events;
}

/** The run's end as Laravel received it. */
async function finished(w: World, runId: RunId): Promise<Fact> {
	const facts = await until(
		async () => fake.facts(w.conversationId),
		(all) => all.some((fact) => fact.type === "run.finished" && fact.run === runId),
	);
	return facts.find((fact) => fact.type === "run.finished" && fact.run === runId) as Fact;
}

function toolCalls(events: RunEvent[]) {
	return events.filter((event) => event.type === "tool_call").map((event) => event.data as { tool: string; decision: string });
}

function restarts(events: RunEvent[]): number[] {
	return events.filter((event) => event.type === "status" && (event.data as { attempt?: number }).attempt !== undefined).map((event) => (event.data as { attempt: number }).attempt);
}

describe("code mode's faults", () => {
	test("what a turn's scripts stored is there for the scripts of the attempt that resumes it", async () => {
		const w = await world([{ point: "tool:before", mode: "abort", tool: LIST }]);
		const big = Array.from({ length: 4 }, (_, i) => `store("big${i}", "é".repeat(200000));`).join(" ");
		const runId = await post(w, [
			script("store('kept', 1); store('gone', 2); return 'keep'"),
			script("store('gone', undefined); return 'drop'"),
			script(`${big} return 'too big'`),
			// Its read crashes the conversation; the script is not run again.
			script("await tools.notes_list_notes({ folder: 'inbox' }); return 'never'"),
			script("return [load('kept'), load('gone'), load('big0')]"),
			{ text: "Done." },
		]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "completed" },
		]);
		// The read never reached the provider: the crash came before the executor's answer.
		expect(toolCalls(events)).toEqual([]);
		expect((await finished(w, runId)).data).toMatchObject({ status: "completed", message: { content: "Done." } });
		// What the last script returned, as the model saw it, is in pi's transcript; the store's sizes are the guest's.
		const seen = await piToolResults(w);
		expect(seen.at(-2)).toEqual({ text: "Tool run_script was interrupted and may have partially run", isError: true });
		expect(seen.at(-1)).toEqual({ text: "[1,null,null]", isError: false });
		expect(seen[2]?.text).toBe("What the script passed to `store()` was not kept: the stored values would take more than 1 MiB.");
	});

	test("a write the script waited for when its wall clock ran out settles in the ledger and is recorded", async () => {
		SCRIPT_CLOCK.timeoutMs = 300;
		const w = await world([{ point: "provider:write:applied", mode: "hold" }]);
		const runId = await post(w, [script("await tools.notes_save_note({ folder: 'inbox', title: 'Slow' }); return 'never'"), { text: "Done." }], {
			delayMs: 1000,
			chunkChars: 500,
		});
		await until(
			() => w.conversation.faultFired(),
			(fired) => fired.some((entry) => entry.point === "provider:write:applied"),
		);
		// The script's wall clock runs out while the write is held after the provider applied it.
		await sleep(500);
		await w.conversation.faultRelease("provider:write:applied");
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const internals = await w.conversation.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
		expect(internals.run).toMatchObject({ writes_uncertain: 0 });
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" })]);
		expect((await providerOf(env, w.within.workspace).state()).notes.map((note) => note.title)).toContain("Slow");
		const seen = await piToolResults(w);
		expect(seen[0]).toEqual({ text: "Script failed: Execution timed out after 300 ms", isError: true });
		expect(seen[1]?.text).toBe("1 tool call had not finished when the script ended and was cancelled. A cancelled write may still have taken effect.");
	});
});

/** The tool results in pi's transcript, text item by text item, in order. */
async function piToolResults(w: World): Promise<{ text: string; isError: boolean }[]> {
	const { runInDurableObject } = await import("cloudflare:test");
	return runInDurableObject(w.conversation, (_instance, state) => {
		const rows = state.storage.sql.exec<{ data: string }>("SELECT * FROM pi_entries").toArray() as unknown as { [column: string]: unknown }[];
		const results: { text: string; isError: boolean }[] = [];
		for (const row of rows) {
			const text = JSON.stringify(row);
			if (!text.includes("toolResult")) continue;
			for (const value of Object.values(row)) {
				if (typeof value !== "string" || !value.includes('"toolResult"')) continue;
				const parsed = JSON.parse(value) as { model?: { role: string; content: { type: string; text?: string }[]; isError: boolean }[] };
				for (const message of parsed.model ?? []) {
					if (message.role !== "toolResult") continue;
					for (const item of message.content) {
						if (item.type === "text") results.push({ text: (item.text ?? "").replace(/^<harness>\n\[error\] (.*)\n<\/harness>$/s, "$1"), isError: message.isError });
					}
				}
			}
		}
		return results;
	});
}
