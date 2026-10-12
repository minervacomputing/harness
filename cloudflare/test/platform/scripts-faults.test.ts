// Code mode's faults end to end in local workerd, as test/platform/protocols.test.ts runs the protocols:
// the real Workspace and Conversation objects, the executor with its ledger, the fake Notes connector and
// its provider, the fake model, the real Scripts object, and the test build's fault points. A script's
// store survives a crash of the conversation (worker/test/resume.test.ts), a write a script was waiting for
// when its wall clock ran out settles in the ledger and is recorded, and a crash during a script ends it
// unreplayed.

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { conversationObject, workspaceObject } from "../../src/addressing.ts";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import type { Caller, RunId, WorkspaceRef } from "../../src/contracts/common.ts";
import type { RunEvent } from "../../src/contracts/events.ts";
import type { RunHead } from "../../src/contracts/runs.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import type { Conversation, Workspace } from "../../src/faults/index.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts, faultWorkspacePorts, providerOf } from "../../src/faults/ports.ts";
import { setUpWorkspace } from "../../src/faults/routes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeTurn } from "../../src/model/fake.ts";
import { SCRIPT_TIMEOUT_MS } from "../../src/scripts/limits.ts";
import { SCRIPT_CLOCK } from "../../src/scripts/run.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";

const USER = "0199a000-0000-7000-8000-0000000e5c01";
const CALLER: Caller = { userId: USER, role: "owner" };
const LIST = "notes_list_notes";
const SAVE = "notes_save_note";

beforeAll(() => {
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

afterEach(() => {
	SCRIPT_CLOCK.timeoutMs = SCRIPT_TIMEOUT_MS;
});

interface World {
	ref: WorkspaceRef;
	readonly conversation: DurableObjectStub<Conversation>;
}

async function world(faults: Fault[] = []): Promise<World> {
	const ref: WorkspaceRef = { id: uuid7(), jurisdiction: null };
	const { agentId } = await setUpWorkspace(env, ref, USER, {});
	const ws = workspaceObject(env, ref) as unknown as DurableObjectStub<Workspace>;
	const created = await ws.createConversation(CALLER, agentId);
	if (!created.ok) throw new Error(created.refusal.detail);
	const conversationId = created.value.id;
	const conversation = () => conversationObject(env, ref, conversationId) as unknown as DurableObjectStub<Conversation>;
	if (faults.length) await conversation().faultPlan(faults);
	return {
		ref,
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

async function post(w: World, turns: FakeTurn[], pace: { delayMs?: number; chunkChars?: number } = {}): Promise<RunId> {
	const outcome = await w.conversation.postMessage(CALLER, { content: JSON.stringify({ fake: { turns, ...pace } }), attachments: [] });
	if (!outcome.ok) throw new Error(`Refused: ${outcome.refusal.status} ${outcome.refusal.detail}`);
	return outcome.value.run.id;
}

async function settled(w: World, runId: RunId): Promise<RunHead> {
	return until(async () => (await w.conversation.getRun(CALLER, runId)) as RunHead, (run) => !["queued", "provisioning", "running"].includes(run.status));
}

async function eventsOf(w: World, runId: RunId): Promise<RunEvent[]> {
	return (await w.conversation.getRunEvents(CALLER, runId, { after: 0, upTo: 1_000_000, limit: 1000 })) ?? [];
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
		const answer = (await w.conversation.getConversation(CALLER))?.messages.at(-1);
		expect(answer?.content).toBe("Done.");
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
		expect((await providerOf(env, w.ref.id).state()).notes.map((note) => note.title)).toContain("Slow");
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
