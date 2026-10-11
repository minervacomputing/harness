// Fault tests on the account, for what only the platform shows (plan: Testing): the test Worker
// minerva-cf-test, built from the same code with the fake Notes connector, its provider object, fault
// points and a token-gated driver (src/faults/). Each test makes its own workspace and conversation:
//
// - ctx.abort() in a safe tool, in an unsafe tool, during the model stream;
// - a memory-limit reset in a tool, and repeated ones until the cap;
// - the cap at 3 attempts;
// - a crash right after the attempt gate, every time and with nothing synced (ctx.abort() and a memory
//   reset): the gate's own sync still advances the attempts to the cap;
// - a long tool across PiHarness's heartbeats, which is no restart;
// - a revocation during a run;
// - a write applied then its response lost, and a crash while it is dispatched;
// - a crash during a rotating refresh;
// - one smoke run with Workers AI and the fake connector's tool.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`; never against minerva-cf.

import { describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);
const USER = "0199a000-0000-7000-8000-0000000fa017";
const LIST = "notes_list_notes";
const SAVE = "notes_save_note";
const SEEDED = ["Buy milk", "Call Ada", "Old note"];

interface Fault {
	point: string;
	mode: "abort" | "oom" | "throw" | "lose" | "hold" | "note";
	times?: number;
	tool?: string;
	step?: number;
	delta?: number;
	unsynced?: boolean;
}

interface RunEvent {
	seq: number;
	type: string;
	data: { [key: string]: unknown };
}

interface RunView {
	head: { id: string; status: string; error_message: string; eventSeq: number } | null;
	events: RunEvent[];
	internals: {
		run: { [column: string]: unknown } | null;
		attempts: { attempt: number; ended: string | null }[];
		writes: { key: string; status: string; attempt: number }[];
		executions: { call_id: string; executions: number }[];
	};
	fired: { point: string; mode: string; at: number }[];
}

interface ProviderState {
	notes: { id: number; folder: string; title: string }[];
	requests: { seq: number; at: number; method: string; path: string; token: string; status: number }[];
	rotations: number;
}

/** A UUIDv7 for a workspace of its own. */
function uuid7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const now = BigInt(Date.now());
	for (let i = 0; i < 6; i++) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function driver<T>(op: string, body: { [key: string]: unknown }): Promise<T> {
	const reply = await fetchDeployed(`${worker.origin}/api/faults/${op}`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60_000,
	});
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as T;
}

interface World {
	workspace: { id: string; jurisdiction: null };
	conversationId: string;
	connectionId: string;
}

async function world(options: { faults?: Fault[]; workspaceFaults?: Fault[]; expired?: boolean; delays?: { [prefix: string]: number }; model?: string } = {}): Promise<World> {
	const workspace = { id: uuid7(), jurisdiction: null };
	const base = { workspace, userId: USER };
	const { connectionId, agentId } = await driver<{ connectionId: string; agentId: string }>("setup", { ...base, expired: options.expired === true, delays: options.delays ?? {} });
	if (options.workspaceFaults) await driver("workspace-faults", { ...base, faults: options.workspaceFaults });
	const { conversationId } = await driver<{ conversationId: string }>("conversation", { ...base, agentId, faults: options.faults ?? [], model: options.model ?? null });
	return { workspace, conversationId, connectionId };
}

function base(w: World) {
	return { workspace: w.workspace, userId: USER, conversationId: w.conversationId };
}

type Turn = { text?: string; tools?: { name: string; arguments: { [key: string]: unknown } }[] };

async function post(w: World, content: string): Promise<string> {
	const outcome = await driver<{ ok: boolean; value?: { run: { id: string } }; refusal?: { detail: string } }>("post", { ...base(w), content });
	if (!outcome.ok || !outcome.value) throw new Error(`Refused: ${outcome.refusal?.detail}`);
	return outcome.value.run.id;
}

function script(turns: Turn[], extra: { chunkChars?: number; delayMs?: number } = {}): string {
	return JSON.stringify({ fake: { turns, ...extra } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(w: World, runId: string): Promise<RunView> {
	return driver<RunView>("run", { ...base(w), runId });
}

/** Polls until the run has ended; the poll itself is an event that may wake a reset object. */
async function settled(w: World, runId: string, timeoutMs = 300_000): Promise<RunView & { seconds: number }> {
	const started = Date.now();
	for (;;) {
		const view = await run(w, runId).catch(() => null);
		if (view?.head && !["queued", "provisioning", "running"].includes(view.head.status)) return { ...view, seconds: (Date.now() - started) / 1000 };
		if (Date.now() - started > timeoutMs) throw new Error(`The run did not end; last: ${JSON.stringify(view?.head)}`);
		await sleep(2000);
	}
}

async function provider(w: World): Promise<ProviderState> {
	return driver<ProviderState>("provider", { workspace: w.workspace, userId: USER });
}

function restarts(events: RunEvent[]): number[] {
	return events.filter((event) => event.type === "status" && typeof event.data.attempt === "number").map((event) => event.data.attempt as number);
}

function toolCalls(events: RunEvent[]) {
	return events.filter((event) => event.type === "tool_call").map((event) => event.data);
}

function reads(state: ProviderState): number {
	return state.requests.filter((request) => request.method === "GET" && request.path === "/folders/inbox/notes").length;
}

const LIST_INBOX: Turn = { tools: [{ name: LIST, arguments: { folder: "inbox" } }] };
const save = (title: string): Turn => ({ tools: [{ name: SAVE, arguments: { folder: "inbox", title } }] });

describe.concurrent("attempts on the platform", () => {
	test("ctx.abort() in a safe tool: the read runs again in attempt 2", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Two notes." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(reads(await provider(w))).toBe(2);
		expect(view.internals.executions.map((row) => row.executions)).toEqual([2]);
		console.info(`safe tool: ${view.seconds} s`);
	});

	test("ctx.abort() in an unsafe tool: never replayed; the model's retry is answered from the ledger", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: SAVE }] });
		const runId = await post(w, script([save("Once only"), save("Once only"), { text: "Saved once." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Once only"]);
		expect(toolCalls(view.events)).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" }), expect.objectContaining({ tool: SAVE, decision: "allowed", repeat: true })]);
		console.info(`unsafe tool: ${view.seconds} s`);
	});

	test("ctx.abort() during the model stream: the next attempt asks again", async () => {
		const w = await world({ faults: [{ point: "model:delta", mode: "abort", step: 0, delta: 2 }] });
		const runId = await post(w, script([{ text: "A sentence long enough for several deltas." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		console.info(`model stream: ${view.seconds} s`);
	});

	test("the cap: a third death ends the run as worker_exited, and nothing runs after", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST, times: 5 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		await sleep(45_000);
		expect(reads(await provider(w))).toBe(3);
		console.info(`cap: ${view.seconds} s`);
	});

	test("a revocation during a read in flight: stopped before the answer, nothing after it", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 4000 } });
		const runId = await post(w, script([LIST_INBOX, LIST_INBOX, { text: "Done." }]));
		const started = Date.now();
		while ((await provider(w)).requests.length === 0) {
			if (Date.now() - started > 60_000) throw new Error("The read never reached the provider.");
			await sleep(250);
		}
		const changed = await driver<{ ok: boolean; revocation: string; answered: number; started: number }>("grants", {
			workspace: w.workspace,
			userId: USER,
			connectionId: w.connectionId,
			changes: [{ kind: "folder", id: "*", actions: ["read"] }],
		});
		expect(changed).toMatchObject({ ok: true, revocation: "acknowledged" });
		const view = await run(w, runId);
		expect(view.head).toMatchObject({ status: "cancelled", error_message: "Stopped because permissions changed." });
		await sleep(8000);
		const requests = (await provider(w)).requests;
		expect(requests).toHaveLength(1);
		expect(requests.every((request) => request.at < changed.answered)).toBe(true);
		expect(toolCalls((await run(w, runId)).events)).toEqual([]);
		console.info(`revocation answered in ${changed.answered - changed.started} ms`);
	});

	test("a write applied, then its response lost: uncertain, and later writes pause", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "lose" }] });
		const runId = await post(w, script([save("First"), save("Second"), save("First"), { text: "Stopped writing." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(toolCalls(view.events).map((call) => call.message)).toEqual([
			"The write outcome is unknown. Check the provider; further writes in this run are paused.",
			"A previous write has an unknown outcome. Further writes in this run are paused.",
			"This write has an unknown outcome. Check the provider before retrying.",
		]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
		expect(view.internals.run).toMatchObject({ writes_uncertain: 1 });
	});

	test("a crash while a write is dispatched, after the provider applied it: uncertain at the gate", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
		const runId = await post(w, script([save("Applied once"), save("Applied once"), { text: "Done." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(toolCalls(view.events)).toEqual([expect.objectContaining({ code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Applied once"]);
	});

	test("ctx.abort() right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "abort", unsynced: true, times: 6 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(1);
		console.info(`gate abort: ${view.seconds} s`);
	});

	test("a long tool across PiHarness's heartbeats is no restart", async () => {
		// 75 s: past two 30 s heartbeats and their alarms, within the fake connector's 300 s timeout.
		const w = await world({ delays: { "GET /folders/inbox/notes": 75_000 } });
		const runId = await post(w, script([LIST_INBOX, { text: "Two notes." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([]);
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		expect(reads(await provider(w))).toBe(1);
		console.info(`long tool: ${view.seconds} s`);
	});

	test("a crash during a rotating refresh: one refresh with the stored token after, refused, so Needs reconnecting", async () => {
		const w = await world({ expired: true, workspaceFaults: [{ point: "refresh:answered", mode: "abort" }] });
		const runId = await post(w, script([LIST_INBOX, LIST_INBOX, { text: "Done." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(toolCalls(view.events)).toEqual([
			expect.objectContaining({ decision: "error", code: "FAILED" }),
			expect.objectContaining({ decision: "error", code: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." }),
		]);
		const state = await provider(w);
		expect(state.requests.filter((request) => request.path === "/token").map((request) => request.status)).toEqual([200, 400]);
		expect(reads(state)).toBe(0);
		const connection = await driver<{ stored: { status: string; refresh_state: string } }>("connection", { workspace: w.workspace, userId: USER, connectionId: w.connectionId });
		expect(connection.stored).toMatchObject({ status: "error", refresh_state: "fresh" });
	});
});

describe("memory-limit resets", () => {
	// One at a time: a reset takes every object of its isolate with it.
	test("in a tool: the isolate is reset, and the run recovers in a new attempt", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "oom", tool: LIST }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Recovered." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(reads(await provider(w))).toBe(2);
		console.info(`memory reset: ${view.seconds} s`);
	});

	test("repeated in a tool: the third attempt's reset ends the run as worker_exited", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "oom", tool: LIST, times: 5 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		await sleep(45_000);
		expect(reads(await provider(w))).toBe(3);
		console.info(`repeated memory resets: ${view.seconds} s`);
	});

	test("right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited", async () => {
		// The isolate's memory goes with each reset, so this fault fires after every decision; only the gate's
		// sync makes the attempts advance (gate review, major).
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "oom", unsynced: true, times: 6 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(1);
		console.info(`gate memory reset: ${view.seconds} s`);
	});
});

describe("Workers AI", () => {
	test("a smoke run with @cf/zai-org/glm-5.3-flash and the fake connector's read", async () => {
		const w = await world({ model: "workers-ai" });
		const runId = await post(w, "Use the notes_list_notes tool to list the notes in the folder inbox, then tell me how many there are.");
		const view = await settled(w, runId, 180_000);
		expect(view.head?.status).toBe("completed");
		expect(toolCalls(view.events)).toContainEqual(expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }));
		const answer = view.events.find((event) => event.type === "message");
		expect(String(answer?.data.content ?? "")).not.toBe("");
		console.info(`Workers AI: ${view.seconds} s, ${view.internals.run?.model_calls} model calls; answer: ${String(answer?.data.content).slice(0, 200)}`);
	});
});
