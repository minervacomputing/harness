// The protocols end to end in local workerd (ARCHITECTURE.md: Testing, fault injection), as Laravel's commands reach them
// (startRun and cancelRun through the internal mount): the real Conversation object in the EU, the executor with its ledger
// and page tokens in its SQLite, credentials leased from the fake Laravel (src/faults/laravel.ts), the fake Notes connector
// (src/faults/), and the deterministic fake model. Faults come from the test build's points (src/faults/ports.ts) and from
// the platform's own resets (`ctx.abort()`, abortAllDurableObjects).

import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RunEvent } from "@minerva/contract";
import type { Scope, StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { conversationObject } from "../../src/addressing.ts";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { BUSY_MESSAGE } from "../../src/conversation/conversation.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import type { Conversation } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { type Calibration, faultConversationPorts, modelScope, NOT_FAKE, providerFetch, providerOf } from "../../src/faults/ports.ts";
import { FOLDER, notesConnection, notesLayers, notesLease } from "../../src/faults/world.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript, FakeTurn } from "../../src/model/fake.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { commands, held, notesStart, objectOf, refusalOf, scope, signedAssertions, viewOf } from "./internal-support.ts";

signedAssertions();

const LIST = "notes_list_notes";
const SAVE = "notes_save_note";

type Stub = DurableObjectStub<Conversation>;

/** A workspace whose fake provider is seeded, a Notes connection Laravel lends, and a conversation. A stub breaks once its object was reset, so each use gets a new one. */
interface World {
	within: Scope;
	conversation: string;
	connectionId: string;
	readonly stub: Stub;
}

let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	// The test build's wiring, as src/faults/index.ts sets it (another test file may have replaced it).
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
});

afterEach(() => {
	uninstall();
});

async function world(
	options: { faults?: Fault[]; delays?: { [prefix: string]: number }; runTimeoutMs?: number; model?: string; calibrate?: Calibration } = {},
): Promise<World> {
	const within = scope();
	const conversation = uuid7();
	const connectionId = uuid7();
	await providerOf(env, within.workspace).reset({ delays: options.delays ?? {} });
	fake.connections.set(connectionId, notesLease());
	const stub = () => objectOf({ scope: within, conversation });
	const { faults, runTimeoutMs, model, calibrate } = options;
	if (faults || runTimeoutMs !== undefined || model !== undefined || calibrate !== undefined) await stub().faultPlan(faults ?? [], { runTimeoutMs, model, calibrate });
	return {
		within,
		conversation,
		connectionId,
		get stub() {
			return stub();
		},
	};
}

function script(turns: FakeTurn[], options: Omit<FakeScript, "turns"> = {}): string {
	return JSON.stringify({ fake: { turns, ...options } });
}

/** A start of a run in the world's conversation, which Laravel holds; not sent. */
function startIn(w: World, content: string, change: Partial<StartRun> = {}): StartRun {
	return held(fake, notesStart(w.within, w.connectionId, { conversation: w.conversation, message: { id: uuid7(), content, attachments: [] }, ...change }));
}

/** Sends a start whose model answers with `turns`; its run's id once it is accepted. */
async function post(w: World, turns: FakeTurn[], change: Partial<StartRun> = {}): Promise<RunId> {
	const start = startIn(w, script(turns), change);
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return start.run;
}

function cancelOf(w: World, runId: RunId) {
	return commands.cancelRun({ scope: w.within, conversation: w.conversation, run: runId, reason: "permissions_changed" });
}

/**
 * One of Laravel's commands, which reads nothing, so an object a fault reset starts again and runs its gate and recovery
 * (`faultView` alone does not wake it).
 */
function wake(w: World): Promise<unknown> {
	return commands.replayFacts({ scope: w.within, conversation: w.conversation, after: 1_000_000_000, limit: 1 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 10_000): Promise<T> {
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

const ACTIVE = ["queued", "provisioning", "running"];

async function runOf(w: World, runId: RunId): Promise<RunHead | null> {
	return (await w.stub.faultView(runId, 0, 0)).head;
}

async function settled(w: World, runId: RunId, timeout?: number): Promise<RunHead> {
	const run = await until(
		async () => {
			await wake(w);
			return runOf(w, runId);
		},
		(head) => head !== null && !ACTIVE.includes(head.status),
		timeout,
	);
	return run as RunHead;
}

async function eventsOf(w: World, runId: RunId): Promise<RunEvent[]> {
	return (await viewOf(w.stub, runId)).events;
}

function statuses(events: RunEvent[]) {
	return events.filter((event) => event.type === "status").map((event) => event.data);
}

function toolCalls(events: RunEvent[]) {
	return events.filter((event) => event.type === "tool_call").map((event) => event.data as { tool: string; decision: string; code?: string; message?: string; repeat?: boolean; count?: number; write?: string });
}

/** Waits until the object logged that it reached a fault point. */
async function reached(read: () => Promise<{ point: string }[]>, point: string): Promise<void> {
	await until(read, (fired) => fired.some((entry) => entry.point === point));
}

/** How often the object logged a point. */
async function times(read: () => Promise<{ point: string }[]>, point: string): Promise<number> {
	return (await read()).filter((entry) => entry.point === point).length;
}

function leases(runId: RunId): number {
	return fake.calls.filter((call) => call.operation === "leaseToken" && call.run === runId).length;
}

/**
 * The platform's refusal of a value or a row over 2 MB ("string or blob too big"), which local workerd does not enforce,
 * for the start's tables: rows of `internal_starts`, `runs` and `run_snapshots`.
 */
async function enforceValueLimit(stub: Stub): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		for (const [table, column] of [
			["internal_starts", "text"],
			["runs", "snapshot"],
			["run_snapshots", "text"],
		]) {
			state.storage.sql.exec(
				`CREATE TRIGGER limit_${table} BEFORE INSERT ON ${table} WHEN length(CAST(NEW.${column} AS BLOB)) > 2097152 BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END`,
			);
		}
	});
}

async function provider(w: World) {
	return providerOf(env, w.within.workspace).state();
}

/** Two runs of one conversation in one pi session, the conversation's, each with only its own tasks. */
async function sharesSession(w: World, runId: RunId, earlier: RunId): Promise<void> {
	const [run, before] = [await w.stub.faultRun(runId), await w.stub.faultRun(earlier)];
	expect(run.run?.session).toEqual(expect.any(String));
	expect(run.run?.session).toBe(before.run?.session);
	expect(run.piTasks.length).toBeGreaterThan(0);
	expect(run.piTasks.filter((task) => before.piTasks.some((other) => other.id === task.id))).toEqual([]);
}

const STOPPED_PERMISSIONS = "Stopped because permissions changed.";
const LIST_INBOX: FakeTurn = { tools: [{ name: LIST, arguments: { folder: "inbox" } }] };
const save = (title: string): FakeTurn => ({ tools: [{ name: SAVE, arguments: { folder: "inbox", title } }] });
const SEEDED = ["Buy milk", "Call Ada", "Old note"];

describe("the wiring", () => {
	test("a read and a write through the executor, the ledger and a lease from Laravel", async () => {
		const w = await world();
		const runId = await post(w, [LIST_INBOX, save("From the test"), { text: "Saved." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		const calls = toolCalls(events);
		expect(calls).toEqual([
			expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }),
			expect.objectContaining({ tool: SAVE, decision: "allowed", count: 1, write: expect.stringMatching(/^[0-9a-f]{32}$/) }),
		]);
		expect(calls[1]).not.toHaveProperty("repeat");
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "From the test"]);
		// Each call leased the connection from Laravel, which lent the fake provider's token.
		expect(leases(runId)).toBe(2);
		expect((await provider(w)).requests.map((request) => request.token)).toEqual(["notes-access-0", "notes-access-0"]);
		const internals = await w.stub.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
		expect(internals.run).toMatchObject({ tool_calls: 2, writes_uncertain: 0 });
	});

	test("a Laravel conversation's object is in the EU: its run acts there, and the unqualified object is another, empty one", async () => {
		const w = await world();
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		// Locally an EU object is named `eu:<id>` (no jurisdictions in workerd, addressing.ts).
		expect(await runInDurableObject(w.stub, (_instance, state) => state.id.name)).toBe(`eu:${w.conversation}`);
		const plain = conversationObject(env, { id: w.within.workspace, jurisdiction: null }, w.conversation) as unknown as Stub;
		expect((await plain.faultView(runId)).head).toBeNull();
	});
});

describe("authority and revocation", () => {
	test("the layers a start carries decide its tools: a read-only grant offers no write", async () => {
		const w = await world();
		const readOnly = notesLayers(w.connectionId, [{ kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" }]);
		const runId = await post(w, [save("Not allowed"), { text: "Done." }], { authority: { connections: [notesConnection(w.connectionId)], layers: readOnly } });
		expect((await settled(w, runId)).status).toBe("completed");
		// The write is not offered at all (gateway/tools.ts): pi answers the model's call itself.
		const internals = await w.stub.faultRun(runId);
		expect(internals.tools).toEqual([LIST]);
		expect(internals.run).toMatchObject({ revoked: 0 });
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
		expect((await provider(w)).requests).toEqual([]);
	});

	test("a revocation during a read in flight: the run stops before the answer, and nothing starts after it", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 1500 } });
		const runId = await post(w, [LIST_INBOX, LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		expect(await cancelOf(w, runId)).toEqual({ state: "cancelled" });
		const answered = Date.now();
		// Laravel is answered only once the run is stopped.
		expect(await runOf(w, runId)).toMatchObject({ status: "cancelled", errorMessage: STOPPED_PERMISSIONS });
		await sleep(2000);
		const requests = (await provider(w)).requests;
		expect(requests).toHaveLength(1);
		expect(requests.every((request) => request.at < answered)).toBe(true);
		// The read's answer came back to a run that had ended: no tool_call event.
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ revoked: 1, error_code: "permissions_changed" });
	});

	test("a revocation while a write is in flight: it completes, and its call's next request is never sent", async () => {
		const w = await world({ delays: { "POST /folders/inbox/notes": 1500 } });
		// file_note saves, then reads the note back: two requests of one call.
		const runId = await post(w, [{ tools: [{ name: "notes_file_note", arguments: { folder: "inbox", title: "Filed" } }] }, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		expect(await cancelOf(w, runId)).toEqual({ state: "cancelled" });
		const answered = Date.now();
		await sleep(2500);
		// The write was sent before the cancel and completes ("no further effects", not rollback); the read
		// that would follow it is refused before it is sent, though the call goes on to settle its write.
		const state = await provider(w);
		expect(state.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /folders/inbox/notes"]);
		expect(state.requests.every((request) => request.at < answered)).toBe(true);
		expect(state.notes.map((note) => note.title)).toEqual([...SEEDED, "Filed"]);
		const internals = await w.stub.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "succeeded" })]);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
	});

	test("a write answered after its run was cancelled is logged as refused for the run that acts now, without its arguments", async () => {
		const title = "Quarterly plan";
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "hold" }], delays: { "GET /folders/inbox/notes": 3000 } });
		const warned = vi.spyOn(console, "warn");
		const lines = async () => warned.mock.calls.map((args) => args.map(String).join(" "));
		try {
			const a = await post(w, [{ tools: [{ name: "notes_file_note", arguments: { folder: "inbox", title } }] }, { text: "Filed." }]);
			await reached(() => w.stub.faultFired(), "provider:write:applied");
			expect(await cancelOf(w, a)).toEqual({ state: "cancelled" });
			const b = await post(w, [LIST_INBOX, { text: "Done." }]);
			await until(() => provider(w), (state) => reads(state.requests) === 1);
			await w.stub.faultRelease("provider:write:applied");
			const line = `run ${a}'s call notes_file_note answered after the run ended; its result is refused (run ${b} acts now)`;
			await until(lines, (logged) => logged.some((entry) => entry.includes(line)));
			expect((await lines()).filter((entry) => entry.includes(title))).toEqual([]);
			expect(toolCalls(await eventsOf(w, a))).toEqual([]);
			expect((await w.stub.faultRun(a)).writes).toEqual([expect.objectContaining({ status: "succeeded" })]);
			expect((await settled(w, b)).status).toBe("completed");
			expect(toolCalls(await eventsOf(w, b))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
			await sharesSession(w, b, a);
		} finally {
			warned.mockRestore();
		}
	});

	test("a cancelled run's stop, held until the next run recorded its read and is inside its next model call, marks nothing of the next run's", async () => {
		const w = await world({
			faults: [
				{ point: "pi:stop", mode: "hold" },
				{ point: "model:delta", mode: "hold", step: 1, delta: 0 },
			],
			delays: { "GET /folders/inbox/notes": 1500 },
		});
		const a = await post(w, [LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => reads(state.requests) === 1);
		expect(await cancelOf(w, a)).toEqual({ state: "cancelled" });
		await reached(() => w.stub.faultFired(), "pi:stop");
		const b = await post(w, [LIST_INBOX, { text: "Done." }]);
		await reached(() => w.stub.faultFired(), "model:delta");
		expect(toolCalls(await eventsOf(w, b))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		expect((await w.stub.faultFired()).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([
			["pi:stop", "hold", a],
			["model:delta", "hold", ""],
		]);
		await w.stub.faultRelease("pi:stop");
		await sleep(500);
		expect((await w.stub.faultRun(b)).piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "terminal", false],
			["pi.tool", "terminal", false],
			["pi.generation", "running", false],
		]);
		await w.stub.faultRelease("model:delta");
		expect((await settled(w, b)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, b))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		const tasks = await until(
			async () => (await w.stub.faultRun(b)).piTasks,
			(all) => all.every((task) => task.status === "terminal"),
		);
		expect(tasks.map(({ kind, abortRequested }) => [kind, abortRequested])).toEqual([
			["pi.generation", false],
			["pi.tool", false],
			["pi.generation", false],
		]);
		await sharesSession(w, b, a);
	});

	test("a reset at a cancelled run's stop: the next instance marks the run's work before pi resumes, and pi runs none of it", async () => {
		const w = await world({
			faults: [
				{ point: "tool:before", mode: "hold", tool: LIST },
				{ point: "pi:stop", mode: "abort" },
			],
		});
		const a = await post(w, [LIST_INBOX, { text: "Done." }]);
		await reached(() => w.stub.faultFired(), "tool:before");
		expect((await w.stub.faultRun(a)).entered).toEqual({ model: 1, tool: 1 });
		await until(
			() => cancelOf(w, a),
			(answer) => answer.state === "cancelled",
		);
		await reached(() => w.stub.faultFired(), "pi:stop");
		const tasks = await until(
			async () => {
				await wake(w);
				return (await w.stub.faultRun(a)).piTasks;
			},
			(all) => all.every((task) => task.status === "terminal"),
		);
		expect(tasks.map(({ kind, abortRequested }) => [kind, abortRequested])).toEqual([
			["pi.generation", true],
			["pi.tool", true],
		]);
		await sleep(300);
		expect((await w.stub.faultRun(a)).entered).toEqual({ model: 1, tool: 1 });
		expect((await w.stub.faultFired()).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([
			["tool:before", "hold", LIST],
			["pi:stop", "abort", a],
		]);
		expect((await provider(w)).requests).toEqual([]);
		expect(await runOf(w, a)).toMatchObject({ status: "cancelled", errorMessage: STOPPED_PERMISSIONS });
	});
});

describe("starts the store refuses", () => {
	test("a snapshot past the 2 MB a value may have is kept in parts, and the run starts", async () => {
		const w = await world();
		await enforceValueLimit(w.stub);
		// Four more Notes connections, another user's (so they offer this run no tools), with 500 grants each on ids and names
		// of 190 code points (the limits are 500, 200 and 300): about 2.5 MB of snapshot, while no limit of the contract is broken.
		const extra = Array.from({ length: 4 }, () => ({ ...notesConnection(uuid7()), owner: "7" }));
		const layers = notesLayers(w.connectionId);
		for (const [c, connection] of extra.entries()) {
			for (let i = 0; i < 500; i++) {
				layers.user?.grants.push({ connection: connection.id, kind: FOLDER, resource: `${"界".repeat(190)}-${c}-${i}`, name: "界".repeat(190), actions: ["read", "create"], effect: "allow" });
			}
		}
		const runId = await post(w, [LIST_INBOX, { text: "Done." }], { authority: { connections: [notesConnection(w.connectionId), ...extra], layers } });
		expect((await settled(w, runId, 20_000)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 })]);
		const stored = await runInDurableObject(w.stub, (_instance, state) => ({
			column: state.storage.sql.exec<{ bytes: number }>("SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM runs WHERE id = ?", runId).one().bytes,
			parts: state.storage.sql.exec<{ bytes: number }>("SELECT length(CAST(text AS BLOB)) AS bytes FROM run_snapshots WHERE run_id = ? ORDER BY part", runId).toArray().map((row) => row.bytes),
		}));
		expect(stored.column).toBe(0);
		expect(stored.parts.length).toBeGreaterThan(1);
		expect(stored.parts.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(2 * 1024 * 1024);
		expect(Math.max(...stored.parts)).toBeLessThan(2 * 1024 * 1024);
	}, 120_000);

	test("a start whose transaction the store refuses is an error, not a refusal: only its preparation is kept, and sent again once the store takes it, it runs", async () => {
		const w = await world();
		// Every run row is refused, as the platform refuses one over 2 MB, every time the start is sent.
		await runInDurableObject(w.stub, (_instance, state) => {
			state.storage.sql.exec("CREATE TRIGGER refuse_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END");
		});
		const start = startIn(w, script([{ text: "Hi." }]));
		// A stored refusal would be final: Laravel sends it again.
		expect((await refusalOf(commands.startRun(start))).status).toBeGreaterThanOrEqual(500);
		expect((await refusalOf(commands.startRun(start))).status).toBeGreaterThanOrEqual(500);
		const inside = await runInDurableObject(w.stub, (_instance, state) => ({
			prepared: state.storage.sql.exec("SELECT DISTINCT run_id FROM internal_starts").toArray(),
			answers: state.storage.sql.exec("SELECT run_id FROM internal_answers").toArray().length,
			runs: state.storage.sql.exec("SELECT id FROM runs").toArray().length,
			events: state.storage.sql.exec("SELECT seq FROM run_events").toArray().length,
		}));
		expect(inside).toEqual({ prepared: [{ run_id: start.run }], answers: 0, runs: 0, events: 0 });
		// The start Laravel still holds keeps the conversation for its run.
		expect(await commands.startRun(startIn(w, script([{ text: "Other." }])))).toEqual({ outcome: "refused", code: "CONVERSATION_BUSY", message: BUSY_MESSAGE });
		await runInDurableObject(w.stub, (_instance, state) => {
			state.storage.sql.exec("DROP TRIGGER refuse_runs");
		});
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		expect((await settled(w, start.run)).status).toBe("completed");
		expect(statuses(await eventsOf(w, start.run))).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
	});
});

describe("the test build's network", () => {
	test("reaches only the fake provider: any other host is refused before anything is sent", async () => {
		const send = providerFetch(env, uuid7());
		await expect(send("https://api.todoist.com/api/v1/projects")).rejects.toThrow(NOT_FAKE);
		await expect(send("https://notes.fake.invalid.example/folders")).rejects.toThrow(NOT_FAKE);
	});

	// The perf probe's model (test/account/perf.test.ts): five calls of a tool that does not exist, which pi answers at once.
	const PROBE_TURNS: FakeTurn[] = [...Array.from({ length: 5 }, () => ({ tools: [{ name: "no_such_tool", arguments: {} }] })), { text: "Done." }];

	test("the fake-remote model sends one request before each answer, and each call is marked in order", async () => {
		const w = await world({ model: "fake-remote" });
		// Its own responder holds each answer 50 ms, so a call whose request was not sent and awaited would show less.
		await providerOf(env, modelScope(w.within.workspace)).reset({ delays: { "POST /v1/messages": 50 } });
		const runId = await post(w, PROBE_TURNS);
		expect((await settled(w, runId)).status).toBe("completed");
		const internals = await w.stub.faultRun(runId);
		expect(internals.entered.model).toBe(6);
		expect(internals.run).toMatchObject({ model_calls: 6 });
		expect(internals.marks).toHaveLength(6);
		for (const [i, marks] of internals.marks.entries()) {
			const { begin, answered, last } = marks;
			expect(answered, `call ${i + 1}`).not.toBeNull();
			expect(last, `call ${i + 1}`).not.toBeNull();
			expect((answered as number) - begin).toBeGreaterThanOrEqual(50);
			expect(answered).toBeLessThanOrEqual(last as number);
			if (i > 0) expect(internals.marks[i - 1]?.last).toBeLessThanOrEqual(begin);
		}
		// S (test/account/perf.test.ts) starts at the run's `created_at`, before its first call's held answer on the marks' clock.
		expect((internals.marks[0]?.answered as number) - (internals.run?.created_at as number)).toBeGreaterThanOrEqual(50);
		expect(internals.piTasks.map(({ kind, status, abortRequested }) => ({ kind, status, abortRequested }))).toEqual(Array(6).fill({ kind: "pi.generation", status: "terminal", abortRequested: false }));
		for (const [i, task] of internals.piTasks.entries()) {
			expect(task.startedAt, `generation ${i + 1} starts before its call, on the marks' clock`).toBeLessThanOrEqual(internals.marks[i]?.begin as number);
			expect(task.endedAt, `generation ${i + 1} ends after its answer`).toBeGreaterThanOrEqual(internals.marks[i]?.last as number);
		}
		// Neither provider records them.
		expect((await provider(w)).requests).toEqual([]);
		expect((await providerOf(env, modelScope(w.within.workspace)).state()).requests).toEqual([]);
		expect(await runInDurableObject(w.stub, (_instance, state) => state.storage.sql.exec("SELECT 1 FROM fault_ballast").toArray().length)).toBe(0);
	});

	const ballastOf = (w: World) =>
		runInDurableObject(w.stub, (_instance, state) => state.storage.sql.exec<{ bytes: number; writes: number }>("SELECT length(data) AS bytes, writes FROM fault_ballast").toArray());

	test("calibrated, each fake-remote call writes its bytes before its request; its control writes none", async () => {
		const written = await world({ model: "fake-remote", calibrate: { bytes: 1 << 20, write: true } });
		const control = await world({ model: "fake-remote", calibrate: { bytes: 1 << 20, write: false } });
		for (const w of [written, control]) {
			const runId = await post(w, PROBE_TURNS);
			expect((await settled(w, runId)).status).toBe("completed");
			expect((await w.stub.faultRun(runId)).marks.filter((marks) => marks.answered !== null)).toHaveLength(6);
		}
		expect(await ballastOf(written)).toEqual([{ bytes: 1 << 20, writes: 6 }]);
		expect(await ballastOf(control)).toEqual([]);
	});
});

/** The restart marker of each attempt the gate gave the run. */
function restarts(events: RunEvent[]): number[] {
	return statuses(events).flatMap((data) => ("attempt" in data && typeof data.attempt === "number" ? [data.attempt] : []));
}

function reads(requests: { method: string; path: string }[]): number {
	return requests.filter((request) => request.method === "GET" && request.path === "/folders/inbox/notes").length;
}

/**
 * The run's model call records in the order they were made, its settlement facts (type, call, cause or input tokens,
 * estimated), and its sums beside the records' own.
 */
function callsOf(w: World, runId: RunId) {
	return runInDurableObject(w.stub, (_instance, state) => {
		const sql = state.storage.sql;
		const records = sql
			.exec<{ call: string; attempt: number; outcome: string | null; cause: string | null }>("SELECT call, attempt, outcome, cause FROM call_records WHERE run_id = ? ORDER BY attempt, created_at", runId)
			.toArray();
		const settlements = sql
			.exec<{ fact: string }>("SELECT fact FROM facts WHERE run_id = ? ORDER BY seq", runId)
			.toArray()
			.map((row) => JSON.parse(row.fact) as { type: string; data: { call: string; cause?: string; inputTokens: number; estimated?: boolean } })
			.filter((fact) => fact.type === "run.usage" || fact.type === "run.unmetered")
			.map(({ type, data }) => [type, type === "run.usage" ? { call: data.call, inputTokens: data.inputTokens } : { call: data.call, cause: data.cause, estimated: data.estimated }]);
		const sums = sql
			.exec(
				`SELECT model_calls, (SELECT count(*) FROM call_records WHERE run_id = ?1) AS records,
					input_tokens, (SELECT coalesce(sum(input_tokens), 0) FROM call_records WHERE run_id = ?1 AND outcome = 'reported') AS reported_input,
					unmetered_model_calls, (SELECT count(*) FROM call_records WHERE run_id = ?1 AND outcome = 'unmetered') AS unmetered
				FROM runs WHERE id = ?1`,
				runId,
			)
			.one();
		return { records, settlements, sums };
	});
}

describe("attempts", () => {
	test("a crash in a safe tool: the read runs again in attempt 2, under the same call", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, [LIST_INBOX, { text: "Two notes." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(reads((await provider(w)).requests)).toBe(2);
		const internals = await w.stub.faultRun(runId);
		expect(internals.executions).toEqual([{ call_id: expect.any(String), executions: 2 }]);
		expect(internals.attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "completed" },
		]);
		// Each attempt's read reached the provider and is recorded, the first one before its instance died.
		expect(toolCalls(events)).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" }), expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		const [first, second] = internals.calls;
		expect(internals.calls).toMatchObject([
			{ attempt: 1, instance: expect.any(String) },
			{ attempt: 2, instance: expect.any(String) },
		]);
		expect(second?.instance).not.toBe(first?.instance);
		expect((await w.stub.faultView(runId, 0, 0)).aborts).toEqual([{ at: expect.any(Number), reason: "fault: tool:after" }]);
	});

	test("the platform's own reset mid-tool asks for none: attempt 2's calls come from a new instance, and no reset is recorded", async () => {
		const w = await world({ faults: [{ point: "tool:before", mode: "hold", tool: LIST }] });
		const runId = await post(w, [LIST_INBOX, { text: "Two notes." }]);
		await reached(() => w.stub.faultFired(), "tool:before");
		await abortAllDurableObjects();
		expect((await settled(w, runId)).status).toBe("completed");
		expect(restarts(await eventsOf(w, runId))).toEqual([2]);
		const { internals, aborts } = await w.stub.faultView(runId, 0, 0);
		const [first, second] = internals.calls;
		expect(internals.calls).toMatchObject([
			{ attempt: 1, instance: expect.any(String) },
			{ attempt: 2, instance: expect.any(String) },
		]);
		expect(second?.instance).not.toBe(first?.instance);
		expect(aborts).toEqual([]);
	});

	test("a crash in an unsafe tool after its write settled: never replayed; the model's retry is answered from the ledger", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: SAVE }] });
		// The retry spells the same write differently: stripped values, and `meta`'s keys (free-form, so their
		// order survives validation) in another order, make the same key, which is sorted at every depth.
		const first: FakeTurn = { tools: [{ name: SAVE, arguments: { folder: "inbox", title: "Once only", meta: { a: "1", b: "2" } } }] };
		const retry: FakeTurn = { tools: [{ name: SAVE, arguments: { meta: { b: "2", a: " 1" }, title: "  Once only ", folder: "inbox" } }] };
		const runId = await post(w, [first, retry, { text: "Saved once." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Once only"]);
		const calls = toolCalls(events);
		// The write is recorded when it settled, before the crash; the retry is a repeat with the same write id.
		expect(calls).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" }), expect.objectContaining({ tool: SAVE, decision: "allowed", repeat: true })]);
		expect(calls[0]).not.toHaveProperty("repeat");
		expect((calls[1] as { write?: string }).write).toBe((calls[0] as { write?: string }).write);
		expect((await w.stub.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
	});

	test("a crash during the model stream: the next attempt asks the model again", async () => {
		const w = await world({ faults: [{ point: "model:delta", mode: "abort", step: 0, delta: 2 }] });
		const runId = await post(w, [{ text: "A sentence long enough for several deltas." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(events.at(-2)).toMatchObject({ type: "message", data: { content: "A sentence long enough for several deltas." } });
		// The message names the call that wrote it: the new attempt's, which streamed last.
		const last = events.findLast((event) => event.type === "text_delta");
		expect(last?.data).toMatchObject({ text: expect.any(String), call: expect.stringMatching(/^[0-9a-f]{8}$/) });
		expect(events.at(-2)?.data).toMatchObject({ call: (last?.data as { call?: string } | undefined)?.call });
	});

	describe("a reset between a model call's record and pi hearing its answer", () => {
		const TURN: FakeTurn = { text: "Settled once.", usage: { input: 11, output: 4 } };

		test.each([
			["model:recorded", "abort"],
			["model:settle", "abort"],
			["model:settle", "throw"],
		] as const)("at %s (%s): the next instance settles the open call as lost, and attempt 2's call is a new one", async (point, mode) => {
			const w = await world({ faults: [{ point, mode }] });
			const runId = await post(w, [TURN]);
			expect((await settled(w, runId)).status).toBe("completed");
			const events = await eventsOf(w, runId);
			expect(restarts(events)).toEqual([2]);
			const { records, settlements, sums } = await until(() => callsOf(w, runId), (calls) => calls.records.every((record) => record.outcome !== null));
			const [lost, next] = records.map((record) => record.call);
			expect(records).toEqual([
				{ call: lost, attempt: 1, outcome: "unmetered", cause: "lost" },
				{ call: next, attempt: 2, outcome: "reported", cause: null },
			]);
			expect(next).not.toBe(lost);
			expect(settlements).toEqual([
				["run.unmetered", { call: lost, cause: "lost", estimated: true }],
				["run.usage", { call: next, inputTokens: 11 }],
			]);
			expect(sums).toEqual({ model_calls: 2, records: 2, input_tokens: 11, reported_input: 11, unmetered_model_calls: 1, unmetered: 1 });
			// pi heard only attempt 2's answer.
			expect(events.filter((event) => event.type === "message").map((event) => (event.data as { call?: string }).call)).toEqual([next]);
			expect((await w.stub.faultFired()).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([[point, mode, lost]]);
		});

		test("at model:settled with nothing synced: whatever survived the crash settles once, and the sums follow the records", async () => {
			// The crash may lose the settlement, or the record too: the fake sends nothing the output gate would hold for it, and
			// in local workerd the record is lost with the rest.
			const w = await world({ faults: [{ point: "model:settled", mode: "abort", unsynced: true }] });
			const runId = await post(w, [TURN]);
			expect((await settled(w, runId)).status).toBe("completed");
			expect(restarts(await eventsOf(w, runId))).toEqual([2]);
			const { records, settlements, sums } = await until(() => callsOf(w, runId), (calls) => calls.records.every((record) => record.outcome !== null));
			const next = records.at(-1);
			expect(next).toMatchObject({ attempt: 2, outcome: "reported" });
			expect(records.length === 1 || records[0]?.outcome === "reported" || records[0]?.cause === "lost").toBe(true);
			expect(new Set(records.map((record) => record.call)).size).toBe(records.length);
			expect(settlements.map(([, data]) => (data as { call: string }).call)).toEqual(records.map((record) => record.call));
			expect(sums.model_calls).toBe(sums.records);
			expect(sums.input_tokens).toBe(sums.reported_input);
			expect(sums.unmetered_model_calls).toBe(sums.unmetered);
		});

		test("a call held at model:settle when its run is cancelled settles as lost after the object resets", async () => {
			const w = await world({ faults: [{ point: "model:settle", mode: "hold" }] });
			const runId = await post(w, [TURN]);
			await reached(() => w.stub.faultFired(), "model:settle");
			await cancelOf(w, runId);
			expect((await settled(w, runId)).status).toBe("cancelled");
			expect((await callsOf(w, runId)).records).toEqual([expect.objectContaining({ attempt: 1, outcome: null })]);
			await abortAllDurableObjects();
			await wake(w);
			const { records, settlements, sums } = await until(() => callsOf(w, runId), (calls) => calls.records.every((record) => record.outcome !== null));
			const [lost] = records.map((record) => record.call);
			expect(records).toEqual([{ call: lost, attempt: 1, outcome: "unmetered", cause: "lost" }]);
			expect(settlements).toEqual([["run.unmetered", { call: lost, cause: "lost", estimated: true }]]);
			expect(sums).toEqual({ model_calls: 1, records: 1, input_tokens: 0, reported_input: 0, unmetered_model_calls: 1, unmetered: 1 });
		});

		test("at model:settled (abort): the call stays settled once as reported, and pi asks again under a new id", async () => {
			const w = await world({ faults: [{ point: "model:settled", mode: "abort" }] });
			const runId = await post(w, [TURN]);
			expect((await settled(w, runId)).status).toBe("completed");
			expect(restarts(await eventsOf(w, runId))).toEqual([2]);
			// The next instance's restart rule ran, and left the settled call as it was.
			await wake(w);
			const { records, settlements, sums } = await callsOf(w, runId);
			const [first, next] = records.map((record) => record.call);
			expect(records).toEqual([
				{ call: first, attempt: 1, outcome: "reported", cause: null },
				{ call: next, attempt: 2, outcome: "reported", cause: null },
			]);
			expect(next).not.toBe(first);
			expect(settlements).toEqual([
				["run.usage", { call: first, inputTokens: 11 }],
				["run.usage", { call: next, inputTokens: 11 }],
			]);
			expect(sums).toEqual({ model_calls: 2, records: 2, input_tokens: 22, reported_input: 22, unmetered_model_calls: 0, unmetered: 0 });
		});
	});

	test("resets until the cap: the third attempt's death ends the run as worker_exited, and pi runs nothing after", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST, times: 5 }] });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		const run = await settled(w, runId, 20_000);
		expect(run).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2, 3]);
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		await sleep(500);
		await wake(w);
		expect(reads((await provider(w)).requests)).toBe(3);
		// The gate stopped pi's live task before pi resumed: one model call (attempt 1's) and one execution of
		// the read per attempt, none after the decision, not even one the refusals would answer.
		expect((await w.stub.faultRun(runId)).entered).toEqual({ model: 1, tool: 3 });
	});

	test("a crash right after the gate, every time and with nothing synced, still advances the attempts to the cap", async () => {
		// The second fault crashes after each decision without syncing first and keeps no count in SQLite, so
		// only the gate's own sync keeps each attempt: a1, a2, a3, then worker_exited (gate review, major).
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "abort", unsynced: true, times: 6 }] });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		const run = await settled(w, runId, 20_000);
		expect(run).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(restarts(await eventsOf(w, runId))).toEqual([2, 3]);
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		// Only attempt 1 reached the tool: attempts 2 and 3 died before pi resumed.
		expect(reads((await provider(w)).requests)).toBe(1);
	});

	test("a gate that throws runs again on the next event of the same instance, and counts the restart", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:decided", mode: "throw" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Two notes." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		expect(await times(() => w.stub.faultFired(), "gate:decided")).toBe(1);
		expect(restarts(await eventsOf(w, runId))).toEqual([2]);
		expect((await w.stub.faultRun(runId)).attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "completed" },
		]);
		expect(reads((await provider(w)).requests)).toBe(2);
	});

	test("a run whose deadline passed while the object was away ends timed_out at the gate, with no new attempt", async () => {
		const w = await world({ faults: [{ point: "tool:before", mode: "hold", tool: LIST }, { point: "gate:decided", mode: "note" }], runTimeoutMs: 3000 });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		await reached(() => w.stub.faultFired(), "tool:before");
		// pi's wake job runs in an alarm, and the platform retries an alarm whose invocation a reset cut before it re-armed,
		// about 2 s later; a fact the run writes makes the alarm due at once, for its delivery. Either would wake the object
		// before its deadline, and its gate would end the run as worker_exited. The reset comes while the read is held, before
		// it records anything, once the alarm waits for the deadline, the first job due, so nothing wakes the object before it.
		const alarm = () =>
			runInDurableObject(w.stub, async (_instance, state) => ({
				deadline: state.storage.sql.exec<{ deadline: number }>("SELECT deadline FROM runs WHERE id = ?", runId).one().deadline,
				alarm: await state.storage.getAlarm(),
			}));
		const { deadline } = await until(alarm, (now) => now.alarm === now.deadline);
		await abortAllDurableObjects();
		// No call to the conversation until then: it would wake it before its deadline.
		await sleep(Math.max(0, deadline + 1000 - Date.now()));
		const run = await settled(w, runId);
		expect(run).toMatchObject({ status: "timed_out", errorMessage: "The run took too long." });
		expect(restarts(await eventsOf(w, runId))).toEqual([]);
		const internals = await w.stub.faultRun(runId);
		expect(internals.run).toMatchObject({ attempt: 1, error_code: "timed_out" });
		expect(internals.attempts).toEqual([{ attempt: 1, ended: "failed" }]);
		// The gate decided it, before pi resumed: attempt 1's model call and its held read, and nothing after.
		expect((await w.stub.faultFired()).filter((entry) => entry.point === "gate:decided").map((entry) => entry.detail)).toEqual(["timed_out"]);
		expect(internals.entered).toEqual({ model: 1, tool: 1 });
		expect(reads((await provider(w)).requests)).toBe(0);
	});

	test("an eviction between turns is no restart", async () => {
		const w = await world();
		const first = await post(w, [{ text: "One." }]);
		expect((await settled(w, first)).status).toBe("completed");
		await abortAllDurableObjects();
		const second = await post(w, [LIST_INBOX, { text: "Two." }]);
		expect((await settled(w, second)).status).toBe("completed");
		expect(restarts(await eventsOf(w, second))).toEqual([]);
		expect(toolCalls(await eventsOf(w, second))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		expect((await w.stub.faultRun(second)).attempts).toEqual([{ attempt: 1, ended: "completed" }]);
	});

	test("a late call from a replaced attempt is refused by the object's own ports: its write, its count, its lease and its appends", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const asked = leases(runId);
		const set = (status: string) =>
			runInDurableObject(w.stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE runs SET status = ? WHERE id = ?", status, runId);
			});
		// As the run was while attempt 2 acted, the attempt that died calls in late, through the RunStatePort and
		// CredentialPort this object built for the run's executor.
		await set("running");
		try {
			const late = await w.stub.faultLateCall(runId, 1, w.connectionId);
			expect(late).toEqual({
				dispatch: { kind: "refused", code: "RUN_ENDED", message: "This run is no longer active." },
				counted: false,
				lease: { refused: "RUN_ENDED", message: "This run is no longer active." },
			});
			// Refused here: Laravel, which knows runs but not which attempt is current, was not even asked.
			expect(leases(runId)).toBe(asked);
			await runInDurableObject(w.stub, async (_instance, state) => {
				const { RunStore } = await import("../../src/conversation/store.ts");
				const store = new RunStore(state.storage);
				expect(store.isCurrent({ runId, attempt: 2 })).toBe(true);
				expect(store.append(runId, { type: "phase", data: { text: "late" } }, { runId, attempt: 1 })).toBeNull();
			});
		} finally {
			await set("completed");
		}
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ tool_calls: 2 });
	});

	test("an attempt replaced while its lease was being given gets no lease: Laravel knows runs, not attempts", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 3000 } });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		// The run's own read has its lease once the provider has its request; Laravel holds the next one, the test's.
		await until(() => provider(w), (state) => state.requests.length > 0);
		const release = fake.holdLeases(runId);
		const leasing = w.stub.faultLease(runId, 1, w.connectionId);
		await until(async () => leases(runId), (n) => n === 2);
		const attempt = (value: number) =>
			runInDurableObject(w.stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE runs SET attempt = ? WHERE id = ?", value, runId);
			});
		// Attempt 2 takes over while Laravel is asked; Laravel still lends to the run.
		await attempt(2);
		release();
		const lease = await leasing;
		await attempt(1);
		expect(lease).toEqual({ refused: "RUN_ENDED", message: "This run is no longer active." });
		expect(await w.stub.faultLease(runId, 1, w.connectionId)).toMatchObject({ connectionId: w.connectionId });
		expect((await settled(w, runId)).status).toBe("completed");
	});
});

describe("writes", () => {
	test("applied, then the response lost: uncertain, and every later write of the run pauses", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "lose" }] });
		const runId = await post(w, [save("First"), save("Second"), save("First"), { text: "Stopped writing." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "The write outcome is unknown. Check the provider; further writes in this run are paused." }),
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "A previous write has an unknown outcome. Further writes in this run are paused." }),
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." }),
		]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
		const internals = await w.stub.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "uncertain" })]);
		expect(internals.run).toMatchObject({ writes_uncertain: 1 });
	});

	test("claimed, then never sent: the crash leaves it dispatched, the gate makes it uncertain, nothing reached the provider", async () => {
		const w = await world({ faults: [{ point: "provider:write:before", mode: "abort" }] });
		const runId = await post(w, [save("Never sent"), save("Never sent"), { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(toolCalls(events)).toEqual([expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." })]);
		expect((await provider(w)).requests.filter((request) => request.method === "POST")).toEqual([]);
		expect((await w.stub.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "uncertain", attempt: 1 })]);
	});

	test("a crash while dispatched, after the provider applied it: uncertain at the gate, and the retry under a new call id is refused", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
		const runId = await post(w, [save("Applied once"), save("Applied once"), { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(toolCalls(events)).toEqual([expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN" })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Applied once"]);
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ writes_uncertain: 1 });
	});

	test("a write with under 2 s to the run's deadline is not sent, and the run times out", async () => {
		const w = await world({ runTimeoutMs: 4000 });
		// The tool call's arguments stream slowly, so the write is asked for about 3 s into the run, and the
		// answer after it streams past the deadline.
		const turns = [save("Too late"), { text: "An answer that keeps streaming until well after the run's deadline has passed." }];
		const start = startIn(w, script(turns, { chunkChars: 4, delayMs: 300 }));
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		const run = await settled(w, start.run, 15_000);
		expect(run).toMatchObject({ status: "timed_out", errorMessage: "The run took too long." });
		expect(toolCalls(await eventsOf(w, start.run))).toEqual([
			expect.objectContaining({ decision: "error", code: "TIMED_OUT", message: "The write was not sent because its time ran out." }),
		]);
		expect((await provider(w)).requests.filter((request) => request.method === "POST")).toEqual([]);
		// Not sent, so not applied: forgotten.
		expect((await w.stub.faultRun(start.run)).writes).toEqual([]);
	});
});

describe("holds", () => {
	const REQUIRED =
		"Minerva asked the user to approve this. It has not run. Do not call it again or try another way. Finish your turn by saying what waits for approval. The user approves or declines it with the buttons Minerva shows in the chat, so do not ask them to reply yes or no. The outcome comes in the next turn.";
	const FOLDERS = { method: "GET", path: "/folders" };

	/** A start the user attends whose layer asks before saving a note: reads allowed, creates asked. */
	function asking(w: World): Partial<StartRun> {
		const layers = notesLayers(w.connectionId, [
			{ kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" },
			{ kind: FOLDER, resource: "*", name: "", actions: ["create"], effect: "ask" },
		]);
		return { attended: true, authority: { connections: [notesConnection(w.connectionId)], layers } };
	}

	const requirement = { kind: FOLDER, kindLabel: "Folder", resource: "inbox", name: "Inbox", action: "create", actionLabel: "Create notes", effect: "ask", asked: ["user"] };

	/** The run's `run.held_call` facts the fake Laravel applied, once it holds the run's last fact. */
	async function heldFacts(w: World, runId: RunId) {
		const facts = await until(
			async () => fake.facts(w.conversation),
			(all) => all.some((fact) => fact.type === "run.settled" && fact.run === runId),
		);
		return facts.flatMap((fact) => (fact.type === "run.held_call" && fact.run === runId ? [fact.data] : []));
	}

	function requests(state: { requests: { method: string; path: string }[] }) {
		return state.requests.map(({ method, path }) => ({ method, path }));
	}

	test("a run with holds completes: two asked saves are held in order, nothing reaches the provider, and Laravel holds both whole", async () => {
		const w = await world();
		const runId = await post(w, [save("First"), save("Second"), { text: "Both notes wait for your approval." }], asking(w));
		expect(await settled(w, runId)).toMatchObject({ status: "completed" });
		const internals = await w.stub.faultRun(runId);
		expect(internals.run).toMatchObject({ attended: 1, writes_closed: 0, writes_uncertain: 0 });
		expect(internals.writes).toEqual([]);
		const [first, second] = internals.holds.map((hold) => hold.write_id);
		expect(internals.holds).toEqual([
			{ position: 1, key: expect.stringMatching(/^[0-9a-f]{64}$/), write_id: first, tool: SAVE, label: "Notes: Save a note", state: "open", arguments: '{"folder":"inbox","title":"First"}', requirements: JSON.stringify([requirement]), decided_by: null, approve: null, outcome: null },
			{ position: 2, key: expect.stringMatching(/^[0-9a-f]{64}$/), write_id: second, tool: SAVE, label: "Notes: Save a note", state: "open", arguments: '{"folder":"inbox","title":"Second"}', requirements: JSON.stringify([requirement]), decided_by: null, approve: null, outcome: null },
		]);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).not.toBe(first);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_REQUIRED", message: REQUIRED, write: first }),
			expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_REQUIRED", message: REQUIRED, write: second }),
		]);
		// Each hold read the folder's name, and nothing was saved.
		const state = await provider(w);
		expect(requests(state)).toEqual([FOLDERS, FOLDERS]);
		expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
		const held = { tool: SAVE, label: "Notes: Save a note", connection: w.connectionId, provider: "notes", operation: "save_note", requirements: [requirement] };
		expect(await heldFacts(w, runId)).toEqual([
			{ position: 1, ...held, arguments: '{"folder":"inbox","title":"First"}', write: first },
			{ position: 2, ...held, arguments: '{"folder":"inbox","title":"Second"}', write: second },
		]);
	});

	test("the same start without attended holds nothing: the save is refused APPROVAL_UNAVAILABLE", async () => {
		const w = await world();
		const runId = await post(w, [save("First"), { text: "Saving needs approval." }], { ...asking(w), attended: undefined });
		expect(await settled(w, runId)).toMatchObject({ status: "completed" });
		const internals = await w.stub.faultRun(runId);
		expect(internals.run).toMatchObject({ attended: 0, writes_closed: 0 });
		expect(internals.holds).toEqual([]);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_UNAVAILABLE", message: "This needs the user's approval, which nobody can give in this run. Do not retry. Say what you would do." }),
		]);
		expect(requests(await provider(w))).toEqual([]);
		expect(await heldFacts(w, runId)).toEqual([]);
	});

	test.each([
		["a Stop", "cancelled", "Stopped."],
		["a revocation", "permissions_changed", STOPPED_PERMISSIONS],
	] as const)("holds outlive %s: the run ends with its hold open", async (_name, reason, message) => {
		const w = await world({ faults: [{ point: "model:delta", mode: "hold", step: 1, delta: 0 }] });
		const runId = await post(w, [save("First"), { text: "It waits for your approval." }], asking(w));
		await reached(() => w.stub.faultFired(), "model:delta");
		expect(await commands.cancelRun({ scope: w.within, conversation: w.conversation, run: runId, reason })).toEqual({ state: "cancelled" });
		await w.stub.faultRelease("model:delta");
		expect(await settled(w, runId)).toMatchObject({ status: "cancelled", errorMessage: message });
		const internals = await w.stub.faultRun(runId);
		expect(internals.holds).toEqual([expect.objectContaining({ position: 1, tool: SAVE, state: "open" })]);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ code: "APPROVAL_REQUIRED", write: internals.holds[0]?.write_id })]);
		expect(await heldFacts(w, runId)).toEqual([expect.objectContaining({ position: 1, write: internals.holds[0]?.write_id })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual(SEEDED);
	});

	test("holds outlive an empty answer that fails the run", async () => {
		const w = await world();
		const runId = await post(w, [save("First"), { text: "" }], asking(w));
		expect(await settled(w, runId)).toMatchObject({ status: "failed" });
		const internals = await w.stub.faultRun(runId);
		expect(internals.holds).toEqual([expect.objectContaining({ position: 1, tool: SAVE, state: "open" })]);
		expect(await heldFacts(w, runId)).toEqual([expect.objectContaining({ position: 1, write: internals.holds[0]?.write_id })]);
	});

	test("a script's write after a hold closes the run's writes, which stay closed across a restart: no later write holds or runs", async () => {
		const w = await world({ faults: [{ point: "model:delta", mode: "hold", step: 1, delta: 0 }] });
		// Notes asks before saving to the inbox only, so a save to the archive needs no approval.
		const layers = notesLayers(w.connectionId, [
			{ kind: FOLDER, resource: "*", name: "", actions: ["read", "create"], effect: "allow" },
			{ kind: FOLDER, resource: "inbox", name: "Inbox", actions: ["create"], effect: "ask" },
		]);
		const code = `const out = [];
for (const [folder, title] of [["inbox", "A"], ["archive", "B"], ["inbox", "C"]]) {
	try { await tools.notes_save_note({ folder, title }); out.push("saved"); } catch (error) { out.push(error.message); }
}
return out;`;
		const runId = await post(w, [{ tools: [{ name: "run_script", arguments: { code } }] }, save("D"), { text: "A waits for your approval." }], {
			attended: true,
			authority: { connections: [notesConnection(w.connectionId)], layers },
		});
		await reached(() => w.stub.faultFired(), "model:delta");
		expect((await w.stub.faultRun(runId)).run).toMatchObject({ writes_closed: 1 });
		await abortAllDurableObjects();
		expect(await settled(w, runId)).toMatchObject({ status: "completed" });
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		const pending = "An earlier action waits for the user's approval. Make no more changes in this turn.";
		const internals = await w.stub.faultRun(runId);
		// A is held; B would run out of order, so it is refused and closes writes; C, asking, and D after the restart, find them closed.
		expect(toolCalls(events)).toEqual([
			expect.objectContaining({ tool: SAVE, code: "APPROVAL_REQUIRED", message: REQUIRED, write: internals.holds[0]?.write_id }),
			expect.objectContaining({ tool: SAVE, code: "APPROVAL_PENDING", message: pending }),
			expect.objectContaining({ tool: SAVE, code: "APPROVAL_PENDING", message: pending }),
			expect.objectContaining({ tool: SAVE, code: "APPROVAL_PENDING", message: pending }),
		]);
		expect(internals.holds.map(({ position, arguments: text }) => [position, text])).toEqual([[1, '{"folder":"inbox","title":"A"}']]);
		expect(internals.writes).toEqual([]);
		expect(internals.run).toMatchObject({ writes_closed: 1 });
		const state = await provider(w);
		expect(requests(state)).toEqual([FOLDERS]);
		expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
		expect((await heldFacts(w, runId)).map((data) => data.position)).toEqual([1]);
	});

	test("a reset at approval:held leaves one hold and one fact: the model's call after the restart is answered from the hold", async () => {
		const w = await world({ faults: [{ point: "approval:held", mode: "abort" }] });
		const runId = await post(w, [save("First"), save("First"), { text: "It waits for your approval." }], asking(w));
		expect(await settled(w, runId)).toMatchObject({ status: "completed" });
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		const internals = await w.stub.faultRun(runId);
		expect(internals.holds).toEqual([expect.objectContaining({ position: 1, tool: SAVE, state: "open", arguments: '{"folder":"inbox","title":"First"}' })]);
		const write = internals.holds[0]?.write_id;
		// The held call never answered; the retry is the repeat of a held key: no lease, no second hold, no second read.
		expect(toolCalls(events)).toEqual([expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_REQUIRED", message: REQUIRED, write })]);
		expect(requests(await provider(w))).toEqual([FOLDERS]);
		expect(await heldFacts(w, runId)).toEqual([expect.objectContaining({ position: 1, write })]);
		expect((await w.stub.faultFired()).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([["approval:held", "abort", runId]]);
	});

	describe("the continuation", () => {
		const NOTE: FakeTurn = { note: true };
		const LABEL = "Notes: Save a note";
		const ran = (result: string) => `[You asked to ${LABEL}. The user approved it, and it ran: ${result}]`;

		/** A held run of a save of each title, ended: its id. */
		async function holding(w: World, titles: string[]): Promise<RunId> {
			const runId = await post(w, [...titles.map(save), { text: "They wait for your approval." }], asking(w));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			return runId;
		}

		/** A continuation's start, deciding the held run's holds in position order. */
		function answering(w: World, heldRun: RunId, approve: boolean[], change: Partial<StartRun> = {}): Partial<StartRun> {
			return { ...asking(w), approval: { run: heldRun, decisions: approve.map((yes, index) => ({ position: index + 1, approve: yes })) }, ...change };
		}

		async function answerOf(w: World, runId: RunId): Promise<string | undefined> {
			return ((await eventsOf(w, runId)).find((event) => event.type === "message")?.data as { content: string } | undefined)?.content;
		}

		/** The facts Laravel applied for a run, once it holds its last. */
		async function factsOf(w: World, runId: RunId) {
			const facts = await until(
				async () => fake.facts(w.conversation),
				(all) => all.some((fact) => fact.type === "run.settled" && fact.run === runId),
			);
			return facts.filter((fact) => fact.run === runId);
		}

		const POST_INBOX = { method: "POST", path: "/folders/inbox/notes" };
		const declined = `[The user declined ${LABEL}. It did not run. Do not try it again unless they ask.]`;
		/** A saved note's result as the model reads it. */
		const result = (id: number, title: string) => JSON.stringify({ items: [{ id: String(id), title }], count: 1 });
		const outcomeOf = (hold: { outcome: string | null } | undefined) => (hold?.outcome == null ? null : JSON.parse(hold.outcome));

		test("approving one of two carries out exactly that save before the prompt, once, and the model reads what came of both", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First", "Second"]);
			// The model then asks for the approved save again: the ledger answers it from the record, under the same key.
			const runId = await post(w, [save("First"), NOTE], answering(w, heldRun, [true, false]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			const state = await provider(w);
			expect(state.notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
			expect(requests(state)).toEqual([FOLDERS, FOLDERS, POST_INBOX]);
			expect(await answerOf(w, runId)).toBe(`${ran(result(4, "First"))}\n\n${declined}`);
			const holds = (await w.stub.faultRun(heldRun)).holds;
			expect(holds.map(({ position, state: held, decided_by, approve }) => ({ position, held, decided_by, approve }))).toEqual([
				{ position: 1, held: "used", decided_by: runId, approve: 1 },
				{ position: 2, held: "used", decided_by: runId, approve: 0 },
			]);
			expect(holds.map(outcomeOf)).toEqual([{ kind: "ran", result: result(4, "First") }, null]);
			const internals = await w.stub.faultRun(runId);
			expect(internals.writes).toEqual([{ key: holds[0]?.key, status: "succeeded", attempt: 1, approved_run: heldRun, approved_position: 1 }]);
			const [carried, repeated] = toolCalls(await eventsOf(w, runId));
			expect(carried).toMatchObject({ tool: SAVE, decision: "allowed", count: 1, write: expect.stringMatching(/^[0-9a-f]{32}$/) });
			expect(carried).not.toHaveProperty("repeat");
			expect(repeated).toMatchObject({ tool: SAVE, decision: "allowed", repeat: true, write: carried?.write });
			// Laravel reads which hold each record carried out.
			const facts = (await factsOf(w, runId)).filter((fact) => fact.type === "run.write" || fact.type === "run.tool_call");
			const approved = { run: heldRun, position: 1 };
			expect(facts.map((fact) => [fact.type, (fact.data as { approved?: unknown }).approved])).toEqual([
				["run.write", approved],
				["run.tool_call", approved],
				["run.tool_call", undefined],
			]);
			expect(facts[0]?.data).toMatchObject({ write: carried?.write, tool: SAVE, connection: w.connectionId, outcome: "done", afterCancel: false });
		});

		test("declining both runs nothing, and the continuation still answers", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [NOTE], answering(w, heldRun, [false, false]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect(await answerOf(w, runId)).toBe(`${declined}\n\n${declined}`);
			const state = await provider(w);
			expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
			expect(requests(state)).toEqual([FOLDERS, FOLDERS]);
			expect((await w.stub.faultRun(heldRun)).holds.map(({ state: held, approve, outcome }) => [held, approve, outcome])).toEqual([
				["used", 0, null],
				["used", 0, null],
			]);
			const internals = await w.stub.faultRun(runId);
			expect([internals.writes, toolCalls(await eventsOf(w, runId))]).toEqual([[], []]);
		});

		test("an approved call that fails stops the approved calls after it", async () => {
			const w = await world();
			// The provider has no folder "gone": the first save is refused there.
			const heldRun = await post(w, [{ tools: [{ name: SAVE, arguments: { folder: "gone", title: "Lost" } }] }, save("Second"), { text: "They wait." }], asking(w));
			expect(await settled(w, heldRun)).toMatchObject({ status: "completed" });
			const runId = await post(w, [NOTE], answering(w, heldRun, [true, true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			const [call] = toolCalls(await eventsOf(w, runId));
			expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: SAVE, decision: "error", message: expect.any(String) })]);
			const message = call?.message ?? "";
			const holds = (await w.stub.faultRun(heldRun)).holds;
			expect(holds.map(outcomeOf)).toEqual([
				{ kind: "failed", message },
				{ kind: "not_run", reason: "earlier" },
			]);
			expect(await answerOf(w, runId)).toBe(
				`[You asked to ${LABEL}. The user approved it, but it failed: ${message.replace(/\.$/, "")}. The approved actions after it did not run.]\n\n[You asked to ${LABEL}. The user approved it, but it did not run, because an approved action before it did not succeed.]`,
			);
			const state = await provider(w);
			expect(requests(state)).toEqual([FOLDERS, FOLDERS, { method: "POST", path: "/folders/gone/notes" }]);
			expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
			// Not applied, so forgotten.
			expect((await w.stub.faultRun(runId)).writes).toEqual([]);
		});

		test("a plain message closes the open holds, and its note says they were not approved: a continuation naming them is then refused", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [NOTE], asking(w));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			const closed = `[${LABEL}, which you asked for, was not approved and did not run.]`;
			expect(await answerOf(w, runId)).toBe(`${closed}\n\n${closed}`);
			expect((await w.stub.faultRun(heldRun)).holds.map(({ state, decided_by, approve, outcome }) => [state, decided_by, approve, outcome])).toEqual([
				["closed", runId, null, null],
				["closed", runId, null, null],
			]);
			const late = startIn(w, script([NOTE]), answering(w, heldRun, [true, true]));
			const refused = { outcome: "refused", code: "APPROVAL_DECIDED", message: "These actions were already answered." };
			expect(await commands.startRun(late)).toEqual(refused);
			expect(await commands.startRun(late)).toEqual(refused);
			expect(await runOf(w, late.run)).toBeNull();
			expect((await provider(w)).notes.map((note) => note.title)).toEqual(SEEDED);
			// The next message closes nothing more and says nothing of them.
			const after = await post(w, [{ text: "Done." }]);
			expect(await settled(w, after)).toMatchObject({ status: "completed" });
			expect(await answerOf(w, after)).toBe("Done.");
		});

		test("a plain message stopped before its copy commits leaves the holds open, and the approval then carries them out", async () => {
			const w = await world({ faults: [{ point: "copy:copied", mode: "hold" }] });
			const heldRun = await holding(w, ["First"]);
			const upload = `uploads/${w.within.workspace}/${uuid7()}`;
			await env.FILES_EU.put(upload, "hello");
			const attachments = [{ upload, name: "a.txt", size: 5, mediaType: "text/plain" }];
			const plain = startIn(w, script([{ text: "Read it." }]), { ...asking(w), message: { id: uuid7(), content: script([{ text: "Read it." }]), attachments } });
			expect(await commands.startRun(plain)).toMatchObject({ outcome: "accepted" });
			await reached(() => w.stub.faultFired(), "copy:copied");
			expect(await commands.cancelRun({ scope: w.within, conversation: w.conversation, run: plain.run, reason: "cancelled" })).toEqual({ state: "cancelled" });
			await w.stub.faultRelease("copy:copied");
			expect(await settled(w, plain.run)).toMatchObject({ status: "cancelled" });
			expect((await w.stub.faultRun(heldRun)).holds.map(({ state, decided_by }) => [state, decided_by])).toEqual([["open", null]]);
			const runId = await post(w, [NOTE], answering(w, heldRun, [true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect(await answerOf(w, runId)).toBe(ran(result(4, "First")));
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
		});

		test.each([
			[
				"a revocation that takes the save away: not available any more",
				(w: World) => notesLayers(w.connectionId, [{ kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" }]),
				"APPROVAL_STALE",
				"This is not available any more, so it did not run.",
				{ kind: "not_run", reason: "unavailable" },
				`[You asked to ${LABEL}. The user approved it, but it is not available any more, so it did not run.]`,
			],
			[
				"a deny on its folder: refused by the policy",
				(w: World) =>
					notesLayers(w.connectionId, [
						{ kind: FOLDER, resource: "*", name: "", actions: ["read", "create"], effect: "allow" },
						{ kind: FOLDER, resource: "inbox", name: "Inbox", actions: ["create"], effect: "deny" },
					]),
				"POLICY_DENIED",
				null,
				null,
				null,
			],
		] as const)("between hold and approval, %s, and nothing reaches the provider", async (_name, layersOf, code, message, outcome, line) => {
			const w = await world();
			const heldRun = await holding(w, ["First", "Second"]);
			const authority = { connections: [notesConnection(w.connectionId)], layers: layersOf(w) };
			const runId = await post(w, [NOTE], answering(w, heldRun, [true, true], { authority }));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			const [call] = toolCalls(await eventsOf(w, runId));
			expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: SAVE, decision: "denied", code, message: message ?? expect.any(String) })]);
			const said = message ?? call?.message ?? "";
			const holds = (await w.stub.faultRun(heldRun)).holds;
			expect(holds.map(outcomeOf)).toEqual([outcome ?? { kind: "failed", message: said }, { kind: "not_run", reason: "earlier" }]);
			const first = line ?? `[You asked to ${LABEL}. The user approved it, but it failed: ${said.replace(/\.$/, "")}. The approved actions after it did not run.]`;
			const after = `[You asked to ${LABEL}. The user approved it, but it did not run, because an approved action before it did not succeed.]`;
			expect(await answerOf(w, runId)).toBe(`${first}\n\n${after}`);
			const state = await provider(w);
			expect(requests(state)).toEqual([FOLDERS, FOLDERS]);
			expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
			// The refused row names its hold, for the card.
			const facts = (await factsOf(w, runId)).filter((fact) => fact.type === "run.tool_call");
			expect(facts.map((fact) => (fact.data as { approved?: unknown }).approved)).toEqual([{ run: heldRun, position: 1 }]);
		});

		test("a tool whose fingerprint changed since the hold is not called", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First"]);
			// What a deploy that changed save_note's contract leaves: the hold's fingerprint is not the new snapshot's.
			await runInDurableObject(w.stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE run_holds SET contract = 'an older contract' WHERE run_id = ?", heldRun);
			});
			const runId = await post(w, [NOTE], answering(w, heldRun, [true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect(toolCalls(await eventsOf(w, runId))).toEqual([
				expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_STALE", message: "This changed since the user approved it, so it did not run." }),
			]);
			expect(outcomeOf((await w.stub.faultRun(heldRun)).holds[0])).toEqual({ kind: "not_run", reason: "changed" });
			expect(await answerOf(w, runId)).toBe(`[You asked to ${LABEL}. The user approved it, but it changed since they approved it, so it did not run.]`);
			expect(requests(await provider(w))).toEqual([FOLDERS]);
		});

		test("a tool that changed after the continuation was accepted is not called: the run no longer offers it as it was", async () => {
			const w = await world({ faults: [{ point: "copy:copied", mode: "hold" }] });
			const heldRun = await holding(w, ["First"]);
			// An attachment, so the run waits at its copy, after its acceptance and before its section.
			const upload = `uploads/${w.within.workspace}/${uuid7()}`;
			await env.FILES_EU.put(upload, "hello");
			const content = script([NOTE]);
			const start = startIn(w, content, { ...answering(w, heldRun, [true]), message: { id: uuid7(), content, attachments: [{ upload, name: "a.txt", size: 5, mediaType: "text/plain" }] } });
			expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
			await reached(() => w.stub.faultFired(), "copy:copied");
			// What a deploy meanwhile leaves: the snapshot's tool and its copy of the hold name a fingerprint the registry no longer has.
			await runInDurableObject(w.stub, (_instance, state) => {
				const sql = state.storage.sql;
				const snapshot = JSON.parse(sql.exec<{ snapshot: string }>("SELECT snapshot FROM runs WHERE id = ?", start.run).one().snapshot);
				for (const tool of snapshot.tools) if (tool.name === SAVE) tool.contract = "an older contract";
				for (const hold of snapshot.approval.holds) hold.contract = "an older contract";
				sql.exec("UPDATE runs SET snapshot = ? WHERE id = ?", JSON.stringify(snapshot), start.run);
			});
			await w.stub.faultRelease("copy:copied");
			expect(await settled(w, start.run)).toMatchObject({ status: "completed" });
			expect(toolCalls(await eventsOf(w, start.run))).toEqual([
				expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_STALE", message: "This changed since the user approved it, so it did not run." }),
			]);
			expect(outcomeOf((await w.stub.faultRun(heldRun)).holds[0])).toEqual({ kind: "not_run", reason: "changed" });
			expect(await answerOf(w, start.run)).toBe(`[You asked to ${LABEL}. The user approved it, but it changed since they approved it, so it did not run.]`);
			expect(requests(await provider(w))).toEqual([FOLDERS]);
		});

		test("a held call on a connection the next start numbers differently runs under the continuation's name", async () => {
			const w = await world();
			const other = uuid7();
			fake.connections.set(other, notesLease());
			// The run's own connection is the second of two, so it is `notes2`; the continuation has it alone, as `notes`.
			const connections = [
				{ ...notesConnection(other), createdAt: "2026-01-01T00:00:00.000Z" },
				{ ...notesConnection(w.connectionId), createdAt: "2026-01-02T00:00:00.000Z" },
			];
			const grants = [w.connectionId, other].flatMap((connection) => [
				{ connection, kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" as const },
				{ connection, kind: FOLDER, resource: "*", name: "", actions: ["create"], effect: "ask" as const },
			]);
			const layers = { ceiling: null, user: { restricted: true, revision: 1, grants }, agent: null };
			const heldRun = await post(w, [{ tools: [{ name: "notes2_save_note", arguments: { folder: "inbox", title: "First" } }] }, { text: "It waits." }], {
				attended: true,
				authority: { connections, layers },
			});
			expect(await settled(w, heldRun)).toMatchObject({ status: "completed" });
			const [hold] = (await w.stub.faultRun(heldRun)).holds;
			expect(hold).toMatchObject({ position: 1, tool: "notes2_save_note", state: "open" });
			const runId = await post(w, [NOTE], answering(w, heldRun, [true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" })]);
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
			expect(await answerOf(w, runId)).toBe(`[You asked to ${hold?.label}. The user approved it, and it ran: ${result(4, "First")}]`);
		});

		test("a Stop during the approved save: the save completes, and the next turn's note says it ran", async () => {
			const w = await world({ delays: { "POST /folders/inbox/notes": 1500 } });
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [{ text: "Not reached." }], answering(w, heldRun, [true, true]));
			await until(() => provider(w), (state) => state.requests.some((request) => request.method === "POST"));
			expect(await commands.cancelRun({ scope: w.within, conversation: w.conversation, run: runId, reason: "cancelled" })).toEqual({ state: "cancelled" });
			expect(await settled(w, runId)).toMatchObject({ status: "cancelled" });
			// The save settles after the Stop, and its settlement stores the hold's outcome; the second never started.
			const holds = await until(
				async () => (await w.stub.faultRun(heldRun)).holds,
				(all) => all[0]?.outcome !== null,
			);
			expect(holds.map(outcomeOf)).toEqual([{ kind: "ran", result: result(4, "First") }, null]);
			expect((await w.stub.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "succeeded", approved_run: heldRun, approved_position: 1 })]);
			// After the run's run.settled, which the Stop wrote.
			const facts = await until(
				async () => fake.facts(w.conversation).filter((fact) => fact.type === "run.write" && fact.run === runId),
				(all) => all.length > 0,
			);
			expect(facts.map((fact) => fact.data)).toEqual([expect.objectContaining({ outcome: "done", afterCancel: true, approved: { run: heldRun, position: 1 } })]);
			const next = await post(w, [NOTE], asking(w));
			expect(await settled(w, next)).toMatchObject({ status: "completed" });
			expect(await answerOf(w, next)).toBe(
				`${ran(result(4, "First"))}\n\n[You asked to ${LABEL}. The user approved it, but the turn was stopped before it ran.]`,
			);
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
		});

		test("the same continuation sent twice is one run, and another run naming the used holds is refused", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First"]);
			const start = startIn(w, script([NOTE]), answering(w, heldRun, [true]));
			const accepted = await commands.startRun(start);
			expect(accepted).toMatchObject({ outcome: "accepted" });
			expect(await commands.startRun(start)).toEqual(accepted);
			expect(await settled(w, start.run)).toMatchObject({ status: "completed" });
			expect(await commands.startRun(start)).toEqual(accepted);
			const other = startIn(w, script([NOTE]), answering(w, heldRun, [true]));
			expect(await commands.startRun(other)).toEqual({ outcome: "refused", code: "APPROVAL_DECIDED", message: "These actions were already answered." });
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
			expect((await w.stub.faultRun(heldRun)).holds.map(({ decided_by }) => decided_by)).toEqual([start.run]);
		});

		test("decisions that leave an open hold out, or name another user's, are refused and use nothing", async () => {
			const w = await world();
			const heldRun = await holding(w, ["First", "Second"]);
			const unknown = { outcome: "refused", code: "APPROVAL_UNKNOWN", message: "These decisions do not match the actions waiting for approval." };
			expect(await commands.startRun(startIn(w, script([NOTE]), answering(w, heldRun, [true])))).toEqual(unknown);
			expect(await commands.startRun(startIn(w, script([NOTE]), answering(w, heldRun, [true, true], { user: "43" })))).toEqual(unknown);
			expect((await w.stub.faultRun(heldRun)).holds.map(({ state }) => state)).toEqual(["open", "open"]);
			expect((await provider(w)).notes.map((note) => note.title)).toEqual(SEEDED);
		});

		test("a reset at approval:carried: the section runs again and carries out only the holds with no outcome", async () => {
			const w = await world({ faults: [{ point: "approval:carried", mode: "abort" }] });
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [NOTE], answering(w, heldRun, [true, true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First", "Second"]);
			expect(await answerOf(w, runId)).toBe(`${ran(result(4, "First"))}\n\n${ran(result(5, "Second"))}`);
			expect((await w.stub.faultRun(runId)).writes.map(({ status, approved_position }) => [status, approved_position])).toEqual([
				["succeeded", 1],
				["succeeded", 2],
			]);
			expect((await w.stub.faultFired()).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([["approval:carried", "abort", runId]]);
		});

		test("a reset after the provider applied the first approved save: its outcome is unknown, and the rest do not run", async () => {
			const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [NOTE], answering(w, heldRun, [true, true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
			expect((await w.stub.faultRun(heldRun)).holds.map(outcomeOf)).toEqual([{ kind: "unknown" }, { kind: "not_run", reason: "earlier" }]);
			expect((await w.stub.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "uncertain", approved_position: 1 })]);
			expect(await answerOf(w, runId)).toBe(
				`[You asked to ${LABEL}. The user approved it, but whether it ran is unknown. Check before trying again.]\n\n[You asked to ${LABEL}. The user approved it, but it did not run, because an approved action before it did not succeed.]`,
			);
		});

		test("an approved save whose response is lost: unknown, and the rest do not run", async () => {
			const w = await world({ faults: [{ point: "provider:write:applied", mode: "lose" }] });
			const heldRun = await holding(w, ["First", "Second"]);
			const runId = await post(w, [NOTE], answering(w, heldRun, [true, true]));
			expect(await settled(w, runId)).toMatchObject({ status: "completed" });
			expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
			expect((await w.stub.faultRun(heldRun)).holds.map(outcomeOf)).toEqual([{ kind: "unknown" }, { kind: "not_run", reason: "earlier" }]);
			expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: SAVE, decision: "denied", code: "WRITE_UNCERTAIN" })]);
			expect(await answerOf(w, runId)).toBe(
				`[You asked to ${LABEL}. The user approved it, but whether it ran is unknown. Check before trying again.]\n\n[You asked to ${LABEL}. The user approved it, but it did not run, because an approved action before it did not succeed.]`,
			);
		});
	});
});
