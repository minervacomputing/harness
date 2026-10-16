// `run_script` in the real Conversation Durable Object, in local workerd, as Laravel's commands reach it (startRun and
// cancelRun through the internal mount) with the fake Laravel: PiHarness with the fake model writing scripts, the real
// Scripts object and Dynamic Workers, scripted calls through the run's queue and a fake executor (as
// test/platform/conversation.test.ts fakes it), the store kept in the run's pi conversation, and the plan's Scripts faults
// that local workerd can show: a timeout during a write (the write settles and is recorded), calls after the script
// returned, more than ten scripts in a row, a stop of the run while a script runs. The CPU-bound guest and the busy object
// are on the account.

import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { RunEvent } from "@minerva/contract";
import type { Scope } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { type ConversationPorts, defaultPorts, emptyFolder, PORTS, type WriteLedger } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import type { Conversation } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { ExecutorContext, ToolCallOutcome, ToolCallRequest, ToolDeclaration } from "../../src/gateway/executor.ts";
import type { ToolResult } from "../../src/gateway/results.ts";
import type { Json } from "../../src/lib/json.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type FakeTurn, fakeUpstream } from "../../src/model/fake.ts";
import { SCRIPT_TIMEOUT_MS } from "../../src/scripts/limits.ts";
import { SCRIPT_CLOCK } from "../../src/scripts/run.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { commands, held, objectOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";

signedAssertions();

const DELIVERY = { ...FACT_DELIVERY };
let fake: FakeLaravel;
let uninstall: () => void;

class FakeLedger implements WriteLedger {
	knownWrite = () => null;
	dispatchWrite = () => ({ kind: "refused" as const, code: "RUN_ENDED" as const, message: "This run is no longer active." });
	settleWrite = () => {};
	resolvePageToken = () => null;
	issuePageToken = () => null;
	markDispatchedUncertain(): number {
		return 0;
	}
	sweepLostWrites() {
		return { uncertain: [], nextAt: null };
	}
}

interface Fakes {
	declarations: ToolDeclaration[];
	invoke: (request: ToolCallRequest, run: ExecutorContext) => Promise<ToolCallOutcome>;
	contexts: TranscriptContext[];
	invocations: ToolCallRequest[];
	log: string[];
}

const FAKES = new Map<string, Fakes>();

function fakesOf(conversationId: string): Fakes {
	const fakes = FAKES.get(conversationId);
	if (!fakes) throw new Error(`No fakes for ${conversationId}`);
	return fakes;
}

function declaration(name: string, readOnly: boolean): ToolDeclaration {
	return {
		name,
		title: name,
		description: `${name} for tests.`,
		inputSchema: { type: "object", properties: { key: { type: "string" }, ms: { type: "integer" } }, additionalProperties: false },
		outputSchema: { type: "object" },
		annotations: { readOnlyHint: readOnly },
	};
}

function allowed(request: ToolCallRequest, result: ToolResult): ToolCallOutcome {
	return {
		ok: true,
		result,
		title: request.name,
		repeat: false,
		writeKey: null,
		event: { tool: request.name, label: `Fake: ${request.name}`, arguments: (request.arguments ?? {}) as { [key: string]: Json }, decision: "allowed", title: request.name, count: result.count },
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads answer at once; a write takes `ms`; both log what they did. */
async function tools(request: ToolCallRequest, fakes: Fakes): Promise<ToolCallOutcome> {
	const args = (request.arguments ?? {}) as { key?: string; ms?: number };
	fakes.log.push(`${request.name}:start:${args.key ?? ""}`);
	if (args.ms) await sleep(args.ms);
	fakes.log.push(`${request.name}:end:${args.key ?? ""}${request.signal?.aborted ? ":cut" : ""}`);
	return allowed(request, { items: [{ key: args.key ?? null }], count: 1 });
}

beforeAll(() => {
	PORTS.factory = (): ConversationPorts => ({
		...defaultPorts,
		executor: (run, { conversationId }) => ({
			declarations: () => fakesOf(conversationId).declarations,
			invoke: (request) => {
				const fakes = fakesOf(conversationId);
				fakes.invocations.push(request);
				return fakes.invoke(request, run);
			},
		}),
		ledger: () => new FakeLedger(),
		folder: emptyFolder,
		upstream: (_route, { conversationId }) => fakeUpstream({ onCall: (_call, context) => fakesOf(conversationId).contexts.push(context) }),
	});
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	FAKES.clear();
	SCRIPT_CLOCK.timeoutMs = SCRIPT_TIMEOUT_MS;
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

type Stub = DurableObjectStub<Conversation>;

/** A Laravel conversation in the EU with its fakes. */
function conversation(declarations = [declaration("fake_read", true), declaration("fake_write", false)]) {
	const within = scope();
	const id = uuid7();
	const fakes: Fakes = { declarations, invoke: (request) => tools(request, fakes), contexts: [], invocations: [], log: [] };
	FAKES.set(id, fakes);
	return { within, id, stub: objectOf({ scope: within, conversation: id }), fakes };
}

const script = (code: string): FakeTurn => ({ tools: [{ name: "run_script", arguments: { code } }] });

/** Sends a start, which Laravel holds, whose model answers with `turns`; its run's id once it is accepted. */
async function posted(w: { within: Scope; id: string }, turns: FakeTurn[], pace: { delayMs?: number; chunkChars?: number } = {}): Promise<RunId> {
	const start = held(fake, startOf(w.within, { conversation: w.id, message: { id: uuid7(), content: JSON.stringify({ fake: { turns, ...pace } }), attachments: [] } }));
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return start.run;
}

async function settled(stub: Stub, runId: RunId, timeout = 15_000): Promise<RunHead> {
	const started = Date.now();
	for (;;) {
		const run = (await stub.faultView(runId, 0, 0)).head;
		if (run !== null && !["queued", "provisioning", "running"].includes(run.status)) return run;
		if (Date.now() - started > timeout) throw new Error(`Run still ${run?.status}`);
		await sleep(25);
	}
}

async function eventsOf(stub: Stub, runId: RunId): Promise<RunEvent[]> {
	return (await viewOf(stub, runId)).events;
}

/** The tools a model request offered, from its system messages. */
function offered(context: TranscriptContext | undefined): { name: string; description: string }[] {
	return (context?.messages ?? []).flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
}

/** What the model saw of each `run_script` call, in order: its text items and whether it failed. */
function scriptResults(fakes: Fakes): { texts: string[]; isError: boolean }[] {
	const messages = fakes.contexts.at(-1)?.messages ?? [];
	return messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "run_script"
			? [{ texts: (message.content as { type: string; text?: string }[]).map((item) => item.text ?? ""), isError: message.isError }]
			: [],
	);
}

describe("run_script in the conversation", () => {
	test("offered after the connector tools, with its description; absent without them", async () => {
		const { stub, fakes, ...w } = conversation();
		await settled(stub, await posted(w, [{ text: "Hi." }]));
		expect(offered(fakes.contexts[0]).map((tool) => tool.name)).toEqual(["fake_read", "fake_write", "run_script", "read", "write", "edit", "bash"]);
		const runScript = offered(fakes.contexts[0]).find((tool) => tool.name === "run_script");
		expect(runScript?.description).toMatch(/^Run JavaScript that calls the tools declared below and returns a compact result\.\n/);
		const none = conversation([]);
		await settled(none.stub, await posted(none, [{ text: "Hi." }]));
		expect(offered(none.fakes.contexts[0]).map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
	});

	test("a script's calls go through the executor and are recorded; the model sees notes, output and value", async () => {
		const { stub, fakes, ...w } = conversation();
		const runId = await posted(w, [
			script("const r = await tools.fake_read({ key: 'a' }); await tools.fake_write({ key: 'b' }); console.log('read', r.items[0].key); return { done: true }"),
			{ text: "Done." },
		]);
		const run = await settled(stub, runId);
		expect(run.status).toBe("completed");
		expect(fakes.invocations.map((request) => [request.name, request.arguments, request.fence])).toEqual([
			["fake_read", { key: "a" }, { runId, attempt: 1 }],
			["fake_write", { key: "b" }, { runId, attempt: 1 }],
		]);
		const events = await eventsOf(stub, runId);
		expect(events.filter((event) => event.type === "tool_call").map((event) => (event.data as { tool: string }).tool)).toEqual(["fake_read", "fake_write"]);
		expect(events.filter((event) => event.type === "phase").map((event) => (event.data as { text: string }).text)).toContain("Running a script");
		expect(scriptResults(fakes)).toEqual([{ texts: ["read a", '{"done":true}'], isError: false }]);
	});

	test("store() keeps values between the scripts of a turn, saved only when a script succeeds", async () => {
		const { stub, fakes, ...w } = conversation();
		const runId = await posted(w, [
			script("store('kept', 1); store('gone', 2); return 'one'"),
			script("store('gone', undefined); store('lost', 3); throw new Error('failed')"),
			script("return [load('kept'), load('gone'), load('lost')]"),
			{ text: "Done." },
		]);
		await settled(stub, runId);
		const results = scriptResults(fakes);
		expect(results[1]?.isError).toBe(true);
		expect(results[2]).toEqual({ texts: ["[1,2,null]"], isError: false });
		// The next turn's scripts start with an empty store.
		const next = await posted(w, [script("return load('kept') === undefined"), { text: "Done." }]);
		await settled(stub, next);
		expect(scriptResults(fakes).at(-1)).toEqual({ texts: ["true"], isError: false });
	});

	test("a timeout during a write: the model hears at once, the write settles and is recorded, and the run goes on", async () => {
		SCRIPT_CLOCK.timeoutMs = 300;
		const { stub, fakes, ...w } = conversation();
		// The model answers slowly, so the write ends while the run still runs.
		const runId = await posted(w, [script("text('started'); await tools.fake_write({ key: 'slow', ms: 1200 }); text('never')"), { text: "Done." }], {
			delayMs: 1500,
			chunkChars: 500,
		});
		const run = await settled(stub, runId);
		expect(run.status).toBe("completed");
		// Not cut by the script's stop: it ended on its own, and its outcome was recorded while the run was active.
		expect(fakes.log).toEqual(["fake_write:start:slow", "fake_write:end:slow"]);
		const recorded = (await eventsOf(stub, runId)).filter((event) => event.type === "tool_call").map((event) => (event.data as { tool: string }).tool);
		expect(recorded).toEqual(["fake_write"]);
		expect(scriptResults(fakes)).toEqual([
			{
				texts: [
					"Script failed: Execution timed out after 300 ms",
					"1 tool call had not finished when the script ended and was cancelled. A cancelled write may still have taken effect.",
					"started",
				],
				isError: true,
			},
		]);
	});

	test("calls the script left behind never run once it returned", async () => {
		const { stub, fakes, ...w } = conversation();
		const runId = await posted(w, [script("setTimeout(() => tools.fake_read({ key: 'late' }), 100); return 'returned'"), { text: "Done." }]);
		await settled(stub, runId);
		await sleep(400);
		expect(scriptResults(fakes)).toEqual([{ texts: ["returned"], isError: false }]);
		expect(fakes.invocations).toEqual([]);
	});

	test("more than ten scripts in a row, each stopped by its wall clock, then one that answers", async () => {
		SCRIPT_CLOCK.timeoutMs = 150;
		const { stub, fakes, ...w } = conversation();
		const loop = "for (;;) await new Promise((resolve) => setTimeout(resolve, 10))";
		const runId = await posted(w, [...Array.from({ length: 12 }, () => script(loop)), script("return 'thirteenth'"), { text: "Done." }]);
		const run = await settled(stub, runId, 30_000);
		expect(run.status).toBe("completed");
		const results = scriptResults(fakes);
		expect(results.length).toBe(13);
		for (const result of results.slice(0, 12)) expect(result).toEqual({ texts: ["Script failed: Execution timed out after 150 ms"], isError: true });
		expect(results[12]).toEqual({ texts: ["thirteenth"], isError: false });
	});

	test("stopping the run stops its script", async () => {
		const { stub, ...w } = conversation();
		const runId = await posted(w, [script("for (;;) await new Promise((resolve) => setTimeout(resolve, 10))"), { text: "Done." }]);
		await sleep(500);
		await commands.cancelRun({ scope: w.within, conversation: w.id, run: runId, reason: "cancelled" });
		const run = await settled(stub, runId);
		expect(run.status).toBe("cancelled");
	});
});
