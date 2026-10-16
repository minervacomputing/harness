// The Conversation Durable Object in local workerd, as Laravel's commands reach it (startRun, cancelRun, deleteConversation
// through the internal mount) with the fake Laravel: the start, runs and their events, cancels, the deadline, the stream's
// WebSocket, tools through a fake executor, the history replay, fencing, model calls, and restarts and recovery through the
// attempt gate with the fake model.

import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { RunEvent } from "@minerva/contract";
import type { CancelReason, Fact, StartRun, StartRunResult } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { BUSY_MESSAGE } from "../../src/conversation/conversation.ts";
import { CANCELLED, statusEvent, WORKER_FAILED } from "../../src/conversation/events.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { FOLDER_INSTRUCTIONS } from "../../src/conversation/history.ts";
import { type RunHead, RunStore } from "../../src/conversation/store.ts";
import { RunStream } from "../../src/conversation/stream.ts";
import { type ConversationPorts, defaultPorts, emptyFolder, type FolderPort, gatewayLedger, PORTS, type PortsContext, runStatePort, type WriteLedger } from "../../src/conversation/ports.ts";
import type { Conversation } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { faultConversationPorts } from "../../src/faults/ports.ts";
import { notesConnection, notesLayers, notesLease } from "../../src/faults/world.ts";
import type { ExecutorContext, ToolCallOutcome, ToolCallRequest, ToolDeclaration } from "../../src/gateway/executor.ts";
import type { DispatchResult } from "../../src/gateway/ledger.ts";
import type { ToolResult } from "../../src/gateway/results.ts";
import type { Json } from "../../src/lib/json.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type FakeOptions, type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { type ModelRoute, type Upstream, upstreamOf } from "../../src/model/route.ts";
import { PROVIDER_ERROR } from "../../src/model/tap.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { commands, held, objectOf, refusalOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";

signedAssertions();

/** A ledger that only records what the gate and the sweep asked of it. */
class FakeLedger implements WriteLedger {
	uncertain: RunId[] = [];
	knownWrite = () => null;
	dispatchWrite = () => ({ kind: "refused" as const, code: "RUN_ENDED" as const, message: "This run is no longer active." });
	settleWrite = () => {};
	resolvePageToken = () => null;
	issuePageToken = () => null;
	markDispatchedUncertain(runId: RunId): number {
		this.uncertain.push(runId);
		return 0;
	}
	sweepLostWrites() {
		return { uncertain: [], nextAt: null };
	}
}

interface Fakes {
	ledger: FakeLedger;
	declarations: ToolDeclaration[];
	invoke: (request: ToolCallRequest, run: ExecutorContext) => Promise<ToolCallOutcome>;
	/** What replaces the empty folder's methods (emptyFolder), for this conversation. */
	folder: (context: PortsContext) => Partial<FolderPort>;
	model: FakeOptions;
	/** Instead of the fake model: a real route's upstream (createAI) over a fake binding. */
	upstream?: Upstream;
	/** Every model request's transcript, in order. */
	contexts: TranscriptContext[];
	invocations: ToolCallRequest[];
}

const FAKES = new Map<string, Fakes>();

function fakesOf(conversationId: string): Fakes {
	const fakes = FAKES.get(conversationId);
	if (!fakes) throw new Error(`No fakes for ${conversationId}`);
	return fakes;
}

const RESULT_SCHEMA = { type: "object" } as const;

function declaration(name: string, readOnly: boolean): ToolDeclaration {
	return {
		name,
		title: name.replaceAll("_", " "),
		description: `${name} for tests.`,
		inputSchema: { type: "object", properties: { key: { type: "string" } }, additionalProperties: false },
		outputSchema: RESULT_SCHEMA,
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

const DELIVERY = { ...FACT_DELIVERY };
let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	const faults = faultConversationPorts(defaultPorts);
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
		ledger: (_storage, _runs, { conversationId }) => fakesOf(conversationId).ledger,
		folder: (context) => ({ ...emptyFolder(context), ...fakesOf(context.conversationId).folder(context) }),
		upstream: (_route, { conversationId }) => {
			const fakes = fakesOf(conversationId);
			if (fakes.upstream) return fakes.upstream;
			return fakeUpstream({
				...fakes.model,
				onCall: (call, context, options) => {
					fakes.contexts.push(context);
					fakes.model.onCall?.(call, context, options);
				},
			});
		},
		// The deadline a test sets in the object's fault plan (`faultPlan`), else the setting's.
		runTimeoutMs: faults.runTimeoutMs,
		// The model calls and tool executions pi starts, counted before any check (`faultView`'s internals).
		entered: faults.entered,
	});
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
	// A failed delivery is tried again within a test's time.
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	FAKES.clear();
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

type Stub = DurableObjectStub<Conversation>;

interface Started {
	start: StartRun;
	stub: Stub;
	fakes: Fakes;
}

/** A message with this content and no attachments. */
const message = (content: string): StartRun["message"] => ({ id: uuid7(), content, attachments: [] });

/** A message the fake model answers with this script. */
function scripted(script: FakeScript): string {
	return JSON.stringify({ fake: script });
}

/** A new conversation's first start, which Laravel holds, with the conversation's fakes; not sent. */
function conversation(fakes: Partial<Fakes> = {}, change: Partial<StartRun> = {}): Started {
	const start = held(fake, startOf(scope(), change));
	FAKES.set(start.conversation, {
		ledger: new FakeLedger(),
		declarations: [],
		invoke: async (request) => allowed(request, { items: [{ id: "1" }], count: 1 }),
		folder: () => ({}),
		model: {},
		contexts: [],
		invocations: [],
		...fakes,
	});
	return { start, stub: objectOf(start), fakes: fakesOf(start.conversation) };
}

/** Another run in the start's conversation, which Laravel holds; not sent. */
function next(start: StartRun, change: Partial<StartRun> = {}): StartRun {
	return held(fake, startOf(start.scope, { conversation: start.conversation, ...change }));
}

async function accepted(start: StartRun): Promise<StartRunResult> {
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return answer;
}

/** A new conversation whose first message, `content`, started a run. */
async function started(content: string, fakes: Partial<Fakes> = {}): Promise<Started> {
	const begun = conversation(fakes, { message: message(content) });
	await accepted(begun.start);
	return begun;
}

const cancelOf = (start: StartRun, reason: CancelReason) => commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason });

/** One of Laravel's commands, so the object, reset by a test, starts again and runs its gate and recovery. */
const wake = (start: StartRun) => commands.replayFacts({ scope: start.scope, conversation: start.conversation, after: 0, limit: 1 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 8000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(20);
	}
}

async function runOf(stub: Stub, runId: RunId): Promise<RunHead | null> {
	return (await stub.faultView(runId, 0, 0)).head;
}

async function settled(stub: Stub, runId: RunId, timeout?: number): Promise<RunHead> {
	return (await until(() => runOf(stub, runId), (run) => run !== null && !["queued", "provisioning", "running"].includes(run.status), timeout)) as RunHead;
}

async function eventsOf(stub: Stub, runId: RunId): Promise<RunEvent[]> {
	return (await viewOf(stub, runId)).events;
}

function statuses(events: RunEvent[]) {
	return events.filter((event) => event.type === "status").map((event) => event.data);
}

/** The fake Laravel's facts of the conversation once it holds the run's `run.finished`. */
function delivered(start: StartRun): Promise<Fact[]> {
	return until(
		() => fake.facts(start.conversation),
		(facts) => facts.some((fact) => fact.type === "run.finished" && fact.run === start.run),
	);
}

/** Makes a Lifecycle job due now and runs the object's alarm. */
async function due(stub: Stub, job: string): Promise<void> {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0 WHERE id = ?", job);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(stub);
}

/** Usage and flags straight from the row, for what the run's head does not show. */
async function row(stub: Stub, runId: RunId) {
	return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT * FROM runs WHERE id = ?", runId).one());
}

const runCount = (stub: Stub) => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM runs").one().n);

/** Every stored table's rows, by table, besides the platform's own. */
function storedText(stub: Stub): Promise<string> {
	return runInDurableObject(stub, (_instance, state) => {
		const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
		return tables.map(({ name }) => `${name}: ${JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())}`).join("\n");
	});
}

/** A tool that waits for `hold` before it answers, so its run stays running until the test lets it go. */
function waiting(hold: Promise<void>): Partial<Fakes> {
	return {
		declarations: [declaration("fake_wait", true)],
		invoke: async (request) => {
			await hold;
			return allowed(request, { items: [], count: 0 });
		},
	};
}

const WAIT = scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] });

const BUSY = { outcome: "refused", code: "CONVERSATION_BUSY", message: BUSY_MESSAGE };

/**
 * What the previous version could leave (chunk-13b-design.md, amendment 2): `left`'s run stored `queued` and never
 * activated, with no deadline and its start answered `accepted`, after `ended`'s run; with its watch job when `watched`.
 */
async function leftQueued(stub: Stub, ended: StartRun, left: StartRun, watched: boolean): Promise<void> {
	await runInDurableObject(stub, async (instance: Conversation, state) => {
		const store = new RunStore(state.storage);
		const snapshot = store.snapshot({ id: ended.run });
		const answer = store.answer(ended.run) as StartRunResult;
		store.write(() => {
			const turn = { history: [], prompt: left.message.content };
			store.insertRun({ id: left.run, snapshot: { ...snapshot, runId: left.run, deadline: null, turn }, deadline: null, baseVersionId: snapshot.baseVersionId, createdAt: Date.now() });
			store.append(left.run, statusEvent({ status: "queued" }));
			store.addAnswer(left.run, answer);
		});
		if (watched) await instance.lifecycle.jobs.push({ id: `watch:${left.run}`, fn: "watch", time: Date.now() + 60_000, payload: { runId: left.run } });
	});
}

/** The run `leftQueued` stored ran its turn once it was activated. */
async function ranFromQueued(stub: Stub, left: StartRun, fakes: Fakes): Promise<void> {
	expect((await settled(stub, left.run, 15_000)).status).toBe("completed");
	expect(statuses(await eventsOf(stub, left.run))).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
	expect((await row(stub, left.run)).activated).toBe(1);
	expect(JSON.stringify(fakes.contexts.at(-1))).toContain(left.message.content);
}

describe("starting a run", () => {
	test("a start runs one turn, which answers and ends completed, and its end reaches Laravel with the answer", async () => {
		const { start, stub } = conversation({}, { message: message("Hello there") });
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", authorized: [], attachments: [] });
		const ended = await settled(stub, start.run);
		expect(ended).toMatchObject({ status: "completed", errorMessage: "", finishedAt: expect.any(String) });
		const events = await eventsOf(stub, start.run);
		expect(events[0]).toEqual({ seq: 1, type: "status", data: { status: "queued" } });
		expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
		expect(statuses(events)).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
		expect(events.filter((event) => event.type === "phase").map((event) => event.data)).toEqual([{ text: "Starting the agent" }, { text: "Thinking" }]);
		// The answer and `completed` are the last two events.
		const [answer, last] = events.slice(-2);
		expect(answer).toMatchObject({ type: "message", data: { content: "Done." } });
		expect(last).toMatchObject({ type: "status", data: { status: "completed" } });
		expect(events.filter((event) => event.type === "text_delta").map((event) => (event.data as { text: string }).text).join("")).toBe("Done.");
		expect(ended.eventSeq).toBe(events.length);
		const facts = await delivered(start);
		expect(facts.find((fact) => fact.type === "run.finished")?.data).toMatchObject({ status: "completed", error: "", message: { id: (answer?.data as { id: string }).id, content: "Done." } });
		const stored = await row(stub, start.run);
		expect([stored.model_calls, stored.unmetered_model_calls]).toEqual([1, 0]);
		expect(stored.input_tokens).toBeGreaterThan(0);
	});

	test("refusals store no run, and the conversation takes the next start", async () => {
		// Staged uploads measure as declared; the folder then cannot take them (emptyFolder's `prepareAttachments`).
		const { start, stub } = conversation(
			{
				folder: () => ({
					measureStaged: async (staged) => staged.map((item) => ({ id: uuid7(), name: item.name, size: item.size, mediaType: "text/plain", sha256: "0".repeat(64), key: item.upload })),
				}),
			},
			{ message: message("  \n\t ") },
		);
		expect(await commands.startRun(start)).toEqual({ outcome: "refused", code: "EMPTY_MESSAGE", message: "Write a message or attach a file." });
		const upload = { upload: `uploads/${start.scope.workspace}/${uuid7()}`, name: "notes.txt", size: 5, mediaType: "text/plain" };
		const attached = next(start, { message: { id: uuid7(), content: "", attachments: [upload] } });
		const unavailable = { outcome: "refused", code: "ATTACHMENT_UNAVAILABLE", message: "An attached file is no longer available. Remove it and attach it again." };
		expect(await commands.startRun(attached)).toEqual(unavailable);
		expect(await commands.startRun(attached)).toEqual(unavailable);
		expect(await runCount(stub)).toBe(0);
		const after = next(start, { message: message("Hi") });
		await accepted(after);
		expect((await settled(stub, after.run)).status).toBe("completed");
	});

	test("one run at a time: another start is refused as busy, also while the first is still being prepared", async () => {
		const hold = Promise.withResolvers<void>();
		const prepared = Promise.withResolvers<void>();
		let measuring = false;
		const { start, stub, fakes } = conversation(
			{
				...waiting(hold.promise),
				// The first start waits after its preparation is stored, while its attachments would be measured.
				folder: () => ({
					measureStaged: async () => {
						measuring = true;
						await prepared.promise;
						return [];
					},
				}),
			},
			{ message: message(WAIT) },
		);
		const first = commands.startRun(start);
		// Polled, not awaited: a promise the object settles would carry the test on in the object's context.
		await until(() => measuring, (yes) => yes);
		const second = next(start, { message: message("Second") });
		expect(await commands.startRun(second)).toEqual(BUSY);
		prepared.resolve();
		expect(await first).toMatchObject({ outcome: "accepted" });
		await until(() => fakes.invocations.length, (n) => n === 1);
		const third = next(start, { message: message("Third") });
		expect(await commands.startRun(third)).toEqual(BUSY);
		hold.resolve();
		await settled(stub, start.run);
		expect(await runCount(stub)).toBe(1);
	});
});

describe("one start per run", () => {
	test("the same start sent again while it is prepared joins it: one preparation, one run, one turn", async () => {
		const prepared = Promise.withResolvers<void>();
		let measured = 0;
		const { start, stub, fakes } = conversation(
			{
				folder: () => ({
					measureStaged: async () => {
						measured++;
						await prepared.promise;
						return [];
					},
				}),
			},
			{ message: message("Once") },
		);
		const first = commands.startRun(start);
		await until(() => measured, (n) => n === 1);
		const second = commands.startRun(start);
		expect(await refusalOf(commands.startRun({ ...start, message: { ...start.message, content: "Something else" } }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
		await sleep(50);
		prepared.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toMatchObject({ outcome: "accepted" });
		expect(b).toEqual(a);
		expect(measured).toBe(1);
		await settled(stub, start.run);
		// Stored: the same answer, and nothing runs again.
		expect(await commands.startRun(start)).toEqual(a);
		expect(await runCount(stub)).toBe(1);
		expect(fakes.contexts).toHaveLength(1);
	});

	test("another organization's or workspace's cancel is refused, and the run goes on until its own scope's", async () => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(WAIT, waiting(hold.promise));
		await until(() => fakes.invocations.length, (n) => n === 1);
		for (const other of [
			{ ...start.scope, organization: uuid7() },
			{ ...start.scope, workspace: uuid7() },
		]) {
			expect(await refusalOf(commands.cancelRun({ scope: other, conversation: start.conversation, run: start.run, reason: "cancelled" }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		}
		expect(await row(stub, start.run)).toMatchObject({ status: "running", revoked: 0 });
		expect(await cancelOf(start, "cancelled")).toEqual({ state: "cancelled" });
		hold.resolve();
		expect((await settled(stub, start.run)).status).toBe("cancelled");
	});
});

describe("stopping a run", () => {
	test("a cancel is idempotent and says Stopped., and a call that finishes after it is not recorded", async () => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(WAIT, waiting(hold.promise));
		await until(() => fakes.invocations.length, (n) => n === 1);
		expect(await cancelOf(start, "cancelled")).toEqual({ state: "cancelled" });
		expect(await runOf(stub, start.run)).toMatchObject({ status: "cancelled", errorMessage: "Stopped." });
		expect(await cancelOf(start, "cancelled")).toEqual({ state: "cancelled" });
		hold.resolve();
		const events = await eventsOf(stub, start.run);
		expect(statuses(events).at(-1)).toEqual({ status: "cancelled", message: "Stopped." });
		// The call finished after the run ended: it is not recorded.
		await sleep(50);
		expect((await eventsOf(stub, start.run)).filter((event) => event.type === "tool_call")).toEqual([]);
		const stored = await row(stub, start.run);
		expect(stored.error_code).toBe("cancelled");
	});

	test.each([
		["permissions_changed", "permissions_changed", "Stopped because permissions changed."],
		["emergency_stop", "emergency_stop", "Stopped."],
		["cancelled", "cancelled", "Stopped."],
	] as [CancelReason, string, string][])("Laravel's cancel for %s stops the run with its code", async (reason, code, text) => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(WAIT, waiting(hold.promise));
		await until(() => fakes.invocations.length, (n) => n === 1);
		expect(await cancelOf(start, reason)).toEqual({ state: "cancelled" });
		const stored = await row(stub, start.run);
		expect([stored.status, stored.error_code, stored.error_message, stored.revoked]).toEqual(["cancelled", code, text, 1]);
		hold.resolve();
		expect(await cancelOf(start, reason)).toEqual({ state: "cancelled" });
	});

	test("a run past its deadline times out on its alarm", async () => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = conversation(waiting(hold.promise), { message: message(WAIT) });
		await stub.faultPlan([], { runTimeoutMs: 1500 });
		await accepted(start);
		await until(() => fakes.invocations.length, (n) => n === 1);
		await sleep(1600);
		// Expired counts as inactive before it is marked: fenced events are refused.
		await runDurableObjectAlarm(stub);
		const run = await settled(stub, start.run);
		expect([run.status, run.errorMessage]).toEqual(["timed_out", "The run took too long."]);
		hold.resolve();
	});
});

describe("events", () => {
	test("the stream sends the backlog, then live events, then end", async () => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: { key: "a" } }] }, { text: "Finished." }] }), waiting(hold.promise));
		await until(() => fakes.invocations.length, (n) => n === 1);
		const frames: string[] = [];
		const response = await stub.fetch(`http://conversation/stream?run=${start.run}&after=1&organization=${start.scope.organization}`, { headers: { Upgrade: "websocket" } });
		expect(response.status).toBe(101);
		const socket = response.webSocket as WebSocket;
		const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
		socket.addEventListener("message", (event) => {
			frames.push(String(event.data));
		});
		socket.accept();
		await until(() => frames.length, (n) => n >= 3);
		hold.resolve();
		expect(await closed).toBe(1000);
		const parsed = frames.map((frame) => JSON.parse(frame) as RunEvent | { type: "end" });
		expect(parsed.at(-1)).toEqual({ type: "end" });
		const seqs = parsed.flatMap((frame) => ("seq" in frame ? [frame.seq] : []));
		// Every event after `after`, once, in order.
		const all = await eventsOf(stub, start.run);
		expect(seqs).toEqual(all.filter((event) => event.seq > 1).map((event) => event.seq));
	});

	test("a socket another instance accepted is never written to, nor ended short of what it missed: it is told to reconnect", async () => {
		// Local workerd closes every socket when it resets objects (1006), so the next instance is played by a
		// second RunStream over the same object: what the platform gives an instance that inherits sockets
		// (they outlive the instance that accepted them), with nothing in memory about them.
		for (const variant of ["its start", "the run's next event and end"] as const) {
			const { start, stub, fakes } = await started(WAIT, { declarations: [declaration("fake_wait", true)], invoke: () => new Promise<ToolCallOutcome>(() => {}) });
			const runId = start.run;
			await until(() => fakes.invocations.length, (n) => n === 1);
			const seqs: number[] = [];
			const closes: number[] = [];
			let ended = false;
			// A client following the run as the stream's relay does: from its last event again after a 1013.
			for (let reconnects = 0; reconnects < 3; reconnects++) {
				const response = await stub.fetch(`http://conversation/stream?run=${runId}&after=${seqs.at(-1) ?? 0}&organization=${start.scope.organization}`, { headers: { Upgrade: "websocket" } });
				const socket = response.webSocket as WebSocket;
				const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
				socket.addEventListener("message", (event) => {
					const frame = JSON.parse(String(event.data)) as RunEvent | { type: "end" };
					if ("seq" in frame) seqs.push(frame.seq);
					else ended = true;
				});
				socket.accept();
				if (reconnects === 0) {
					const before = (await row(stub, runId)).event_seq as number;
					await until(() => seqs.length, (n) => n === before);
					await runInDurableObject(stub, (_instance, state) => {
						// Committed by an instance that died before sending them; the run is over by then.
						const append = (type: string, data: Json, status?: string) => {
							const seq = state.storage.sql.exec<{ event_seq: number }>("UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq", runId).one().event_seq;
							state.storage.sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)", runId, seq, type, JSON.stringify(data), Date.now());
							if (status) state.storage.sql.exec("UPDATE runs SET status = ? WHERE id = ?", status, runId);
							return { seq, type, data } as RunEvent;
						};
						append("phase", { text: "Missed one" });
						append("phase", { text: "Missed two" });
						const nextStore = new RunStore(state.storage);
						const nextStream = new RunStream(state, () => nextStore, nextStore.instance);
						if (variant === "its start") {
							append("status", { status: "completed" }, "completed");
							nextStream.resetInherited();
						} else {
							nextStream.broadcast(runId, append("status", { status: "completed" }, "completed"));
							nextStream.end(runId);
						}
					});
				}
				const code = await closed;
				closes.push(code);
				if (code !== 1013) break;
			}
			const all = (await eventsOf(stub, runId)).map((event) => event.seq);
			// Every event once, in order, then `end`, from the socket the client opened again.
			expect([variant, seqs, ended, closes]).toEqual([variant, all, true, [1013, 1000]]);
		}
	});

	test("a stream for an ended run replays and ends at once; another organization's is not found", async () => {
		const { start, stub } = await started("Hi");
		await settled(stub, start.run);
		const all = await eventsOf(stub, start.run);
		const refused = await stub.fetch(`http://conversation/stream?run=${start.run}&after=0&organization=${uuid7()}`, { headers: { Upgrade: "websocket" } });
		expect(refused.status).toBe(404);
		const response = await stub.fetch(`http://conversation/stream?run=${start.run}&after=${all.length - 2}&organization=${start.scope.organization}`, { headers: { Upgrade: "websocket" } });
		const socket = response.webSocket as WebSocket;
		const frames: string[] = [];
		const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
		socket.addEventListener("message", (event) => {
			frames.push(String(event.data));
		});
		socket.accept();
		await closed;
		expect(frames.map((frame) => JSON.parse(frame))).toEqual([...all.slice(-2), { type: "end" }]);
	});
});

describe("tools", () => {
	test("calls go through the executor, are recorded from its outcome, and the model sees the result's JSON", async () => {
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: { key: "a" } }] }, { tools: [{ name: "fake_write", arguments: { key: "b" } }] }, { text: "Done reading." }] }), {
			declarations: [declaration("fake_read", true), declaration("fake_write", false)],
			invoke: async (request) =>
				request.name === "fake_read"
					? allowed(request, { items: [{ title: "Ünïcode" }], count: 1 })
					: { ok: false, error: { code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." }, event: { tool: request.name, label: "Fake: write", arguments: {}, decision: "denied", code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." } },
		});
		const runId = start.run;
		const run = await settled(stub, runId);
		expect(run.status).toBe("completed");
		expect(fakes.invocations.map((request) => [request.name, request.arguments, request.fence])).toEqual([
			["fake_read", { key: "a" }, { runId, attempt: 1 }],
			["fake_write", { key: "b" }, { runId, attempt: 1 }],
		]);
		const calls = (await eventsOf(stub, runId)).filter((event) => event.type === "tool_call").map((event) => event.data);
		expect(calls.map((call) => (call as { decision: string }).decision)).toEqual(["allowed", "denied"]);
		// The tool results as the model saw them: the result's JSON, and the error's message.
		const results = (fakes.contexts.at(-1)?.messages ?? []).filter((item) => item.role === "toolResult");
		expect(results.map((item) => [item.content, item.isError])).toEqual([
			[[{ type: "text", text: '{"items":[{"title":"Ünïcode"}],"count":1}' }], false],
			[[{ type: "text", text: "This resource or action is not available under the current permissions." }], true],
		]);
		const phases = (await eventsOf(stub, runId)).filter((event) => event.type === "phase").map((event) => (event.data as { text: string }).text);
		expect(phases).toContain("Using tools");
	});

	test("a key the runtime's JSON.parse misreads reaches the executor as the model wrote it", async () => {
		// Known gap: pi decodes its own stored rows with JSON.parse and validates the call from that copy, so with
		// a schema that refuses the misread key (required, additionalProperties: false) pi refuses the call
		// before the tool can read the model's text again. This schema lets the call through to the tool.
		const first = "minerva_escaped_key_probe";
		// "\\" parsed after a first key makes V8 return "\\" for a later "\n" in that place (lib/json.ts), so the
		// fake's provider-side parse (pi-ai's parseStreamingJson) and pi's own reads misread the arguments.
		const text = `{"${first}":1,"\\n":2}`;
		JSON.parse(`{"${first}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(text))).toEqual([first, "\\"]);
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }], rawArguments: { "0": text } }] }), {
			declarations: [{ ...declaration("fake_read", true), inputSchema: { type: "object" } }],
		});
		await settled(stub, start.run);
		expect(fakes.invocations.map((request) => request.arguments)).toEqual([{ [first]: 1, "\n": 2 }]);
	});

	test("a call that ends RUN_ENDED is not recorded", async () => {
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }), {
			declarations: [declaration("fake_read", true)],
			invoke: async () => ({ ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null }),
		});
		expect((await settled(stub, start.run)).status).toBe("completed");
		expect(fakes.invocations.map((request) => request.name)).toEqual(["fake_read"]);
		expect((await eventsOf(stub, start.run)).filter((event) => event.type === "tool_call")).toEqual([]);
	});
});

describe("the model", () => {
	test("a run replays the history Laravel sent as text, not its own message, then its message, under the agent's instructions and the folder's", async () => {
		const [earlier, run] = [uuid7(), uuid7()];
		const { start, stub, fakes } = conversation(
			{},
			{
				run,
				message: message("Second question"),
				history: [
					{ id: uuid7(), role: "user", content: "First question", attachments: [], run: earlier, createdAt: "2026-10-14T10:00:00+00:00", changes: null },
					{ id: uuid7(), role: "assistant", content: "Done.", attachments: [], run: earlier, createdAt: "2026-10-14T10:00:05+00:00", changes: null },
					{ id: uuid7(), role: "user", content: "Second question", attachments: [], run, createdAt: "2026-10-14T10:01:00+00:00", changes: null },
				],
			},
		);
		await accepted(start);
		await settled(stub, start.run);
		const context = fakes.contexts.at(-1) as TranscriptContext;
		const turns = context.messages.filter((item) => item.role !== "system").map((item) => [item.role, item.role === "assistant" ? item.content : (item as { content: unknown }).content]);
		expect(turns).toEqual([
			["user", "First question"],
			["assistant", [{ type: "text", text: "Done." }]],
			["user", "Second question"],
		]);
		// pi adds the instructions as a positional system section; providers that take no mid-conversation
		// system messages fold it into the leading one.
		const system = context.messages.filter((item) => item.role === "system");
		// With the local tools, the folder's paragraph follows the agent's instructions after a blank line.
		expect(JSON.stringify(system)).toContain(JSON.stringify(`\n\n${start.agent.instructions}\n\n${FOLDER_INSTRUCTIONS}\n</instructions>`).slice(1, -1));
	});

	test("a provider's error text never reaches the run or Laravel, and the run fails", async () => {
		const { start, stub, fakes } = await started("Hi", { model: { script: () => ({ turns: [{ error: { message: "secret org-1234 quota" } }] }) } });
		const run = await settled(stub, start.run);
		expect([run.status, run.errorMessage]).toEqual(["failed", "The agent could not finish this run. Try again."]);
		const stored = await storedText(stub);
		expect(stored).not.toContain("org-1234");
		expect(stored).toContain("The model provider reported an error.");
		expect(JSON.stringify(await delivered(start))).not.toContain("org-1234");
		expect(fakes.contexts.length).toBe(1);
		expect(PROVIDER_ERROR).toBe("The model provider reported an error.");
	});

	test("a failure's text, which createAI also copies into its diagnostics, is nowhere in storage, the run's events, its facts or the logs", async () => {
		const secret = "SYNTHETIC_SECRET";
		const route = (provider: ModelRoute["provider"]): ModelRoute => ({ provider, name: provider === "workers-ai" ? "@cf/zai-org/glm-5.3-flash" : "gpt-test", gateway: "acme", api: "responses", cap: 1000, reasoningEffort: "", reasoningSummary: "" });
		// AI Gateway's universal endpoint answering a 401 that echoes the key, and Workers AI throwing such text.
		const binding = {
			aiGatewayLogId: null,
			run: async () => {
				throw new Error(`5007: upstream refused Authorization: Bearer ${secret}`);
			},
			gateway: () => ({
				run: async () =>
					new Response(JSON.stringify({ error: { message: `Incorrect API key provided: Bearer ${secret}.`, type: "invalid_request_error", code: "invalid_api_key" } }), {
						status: 401,
						headers: { "content-type": "application/json" },
					}),
			}),
		} as unknown as Ai;
		const logged: string[] = [];
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message} ${arg.stack ?? ""}` : String(arg))).join(" "));
			}),
		);
		try {
			for (const provider of ["openai", "workers-ai"] as const) {
				const { start, stub } = await started("Hi", { upstream: upstreamOf(route(provider), binding) });
				const run = await settled(stub, start.run);
				expect([run.status, run.errorMessage]).toEqual(["failed", "The agent could not finish this run. Try again."]);
				const stored = await storedText(stub);
				// pi's own tables are there, with the failed call in its records.
				expect(stored).toMatch(/^pi_entries: \[\{/m);
				expect(stored).toContain("The model provider reported an error.");
				expect(stored).not.toContain(secret);
				expect(JSON.stringify(await eventsOf(stub, start.run))).not.toContain(secret);
				expect(JSON.stringify(await delivered(start))).not.toContain(secret);
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(logged.join("\n")).toContain("The model provider reported an error");
		expect(logged.join("\n")).not.toContain(secret);
	});
});

describe("restarts through the attempt gate", () => {
	test("a read interrupted by the object's death runs again as attempt 2, and the run completes", async () => {
		let executions = 0;
		const never = new Promise<ToolCallOutcome>(() => {});
		const { start, fakes } = await started(scripted({ turns: [{ text: "Looking.", tools: [{ name: "fake_read", arguments: { key: "a" } }] }, { text: "Found it." }] }), {
			declarations: [declaration("fake_read", true)],
			invoke: async (request) => (++executions === 1 ? never : allowed(request, { items: [], count: 0 })),
		});
		const runId = start.run;
		await until(() => fakes.invocations.length, (n) => n === 1);
		await abortAllDurableObjects();
		// Any event opens pi again, and the gate counts the restart before pi does anything.
		await wake(start);
		const run = await settled(objectOf(start), runId, 15_000);
		expect(run.status).toBe("completed");
		const events = await eventsOf(objectOf(start), runId);
		expect(statuses(events)).toEqual([
			{ status: "queued" },
			{ status: "provisioning" },
			{ status: "running" },
			{ status: "provisioning", attempt: 2 },
			{ status: "running" },
			{ status: "completed" },
		]);
		const phases = events.filter((event) => event.type === "phase").map((event) => (event.data as { text: string }).text);
		expect(phases).toContain("Resuming the agent");
		expect(fakes.invocations.map((request) => request.fence.attempt)).toEqual([1, 2]);
		expect(fakes.ledger.uncertain).toEqual([runId]);
		expect((await row(objectOf(start), runId)).attempt).toBe(2);
		expect(events.filter((event) => event.type === "message").map((event) => (event.data as { content: string }).content)).toEqual(["Found it."]);
		expect((await delivered(start)).at(-1)?.data).toMatchObject({ status: "completed", message: { content: "Found it." } });
	});

	test("the third death fails the run with worker_exited, and pi runs nothing afterwards", async () => {
		const never = new Promise<ToolCallOutcome>(() => {});
		const { start, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }), { declarations: [declaration("fake_read", true)], invoke: async () => never });
		const runId = start.run;
		for (const attempt of [1, 2, 3]) {
			await until(() => fakes.invocations.length, (n) => n === attempt, 15_000);
			await abortAllDurableObjects();
			await wake(start);
		}
		const stub = objectOf(start);
		const run = await settled(stub, runId, 15_000);
		expect([run.status, run.errorMessage]).toEqual(["failed", "The worker stopped unexpectedly."]);
		const stored = await row(stub, runId);
		expect([stored.attempt, stored.error_code]).toEqual([3, "worker_exited"]);
		await sleep(300);
		expect(fakes.invocations.length).toBe(3);
		const live = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'").one().n);
		expect(live).toBe(0);
		const attempts = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT attempt, ended FROM attempts WHERE run_id = ? ORDER BY attempt", runId).toArray());
		expect(attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "restarted" },
			{ attempt: 3, ended: "failed" },
		]);
	});

	test("an idle object that wakes between turns is no restart", async () => {
		const { start: first, stub } = await started("One");
		await settled(stub, first.run);
		await abortAllDurableObjects();
		const second = next(first, { message: message("Two") });
		await accepted(second);
		await settled(objectOf(first), second.run);
		for (const runId of [first.run, second.run]) {
			expect(statuses(await eventsOf(objectOf(first), runId)).some((data) => "attempt" in data)).toBe(false);
			expect((await row(objectOf(first), runId)).attempt).toBe(1);
		}
	});

	test("a reset right after the start's transaction is no restart: the start sent again runs its turn once, as attempt 1", async () => {
		// The object is reset once the start's transaction has committed, before the activation it deferred.
		const { start, fakes } = conversation(
			{
				folder: (context) => ({
					commitAttachments: (runId, prepared) => {
						queueMicrotask(() => context.ctx.abort("fault: start:stored"));
						return emptyFolder(context).commitAttachments(runId, prepared);
					},
				}),
			},
			{ message: message("Hi") },
		);
		expect((await refusalOf(commands.startRun(start))).status).toBeGreaterThanOrEqual(500);
		// The run and its answer were not yet written out (the output gate): the reset took them together.
		const left = await runInDurableObject(objectOf(start), (_instance, state) => ({
			runs: state.storage.sql.exec("SELECT count(*) AS n FROM runs").one().n,
			answers: state.storage.sql.exec("SELECT count(*) AS n FROM internal_answers").one().n,
		}));
		expect(left).toEqual({ runs: 0, answers: 0 });
		expect(fakes.contexts).toHaveLength(0);
		FAKES.set(start.conversation, { ...fakes, folder: () => ({}) });
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		const stub = objectOf(start);
		expect((await settled(stub, start.run, 15_000)).status).toBe("completed");
		expect(statuses(await eventsOf(stub, start.run))).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
		expect((await row(stub, start.run)).attempt).toBe(1);
		expect(await runCount(stub)).toBe(1);
		expect(fakesOf(start.conversation).contexts).toHaveLength(1);
	});
});

describe("conversations the previous version left", () => {
	test("a run left queued is activated when the object starts again, and its turn runs", async () => {
		const { start: first, stub, fakes } = await started("One");
		await settled(stub, first.run);
		const left = next(first, { message: message("Two, left queued") });
		await leftQueued(stub, first, left, false);
		await abortAllDurableObjects();
		await wake(first);
		await ranFromQueued(objectOf(first), left, fakes);
	});

	test("a run left queued is activated by its watch, and its turn runs", async () => {
		const { start: first, stub, fakes } = await started("One");
		await settled(stub, first.run);
		const left = next(first, { message: message("Two, watched") });
		await leftQueued(stub, first, left, true);
		await due(stub, `watch:${left.run}`);
		await ranFromQueued(stub, left, fakes);
	});

	test("a run left queued, activated by recovery and its watch at once, runs its turn once", async () => {
		const { start: first, stub, fakes } = await started("One");
		await settled(stub, first.run);
		const left = next(first, { message: message("Two, from both") });
		await leftQueued(stub, first, left, true);
		await abortAllDurableObjects();
		await Promise.all([wake(first), due(objectOf(first), `watch:${left.run}`)]);
		await ranFromQueued(objectOf(first), left, fakes);
		expect(fakes.contexts.filter((context) => JSON.stringify(context).includes(left.message.content))).toHaveLength(1);
	});

	test("a run left queued and then cancelled stays cancelled when the object starts again", async () => {
		const { start: first, stub, fakes } = await started("One");
		await settled(stub, first.run);
		const left = next(first, { message: message("Two, cancelled") });
		await leftQueued(stub, first, left, true);
		expect(await cancelOf(left, "cancelled")).toEqual({ state: "cancelled" });
		await abortAllDurableObjects();
		await wake(first);
		await due(objectOf(first), `watch:${left.run}`);
		await sleep(300);
		expect(statuses(await eventsOf(objectOf(first), left.run))).toEqual([{ status: "queued" }, { status: "cancelled", message: "Stopped." }]);
		expect(JSON.stringify(fakes.contexts)).not.toContain(left.message.content);
	});

	test("one with no organization ends its run cancelled when the object starts again, and pi runs none of its work", async () => {
		const never = new Promise<ToolCallOutcome>(() => {});
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }), {
			declarations: [declaration("fake_read", true)],
			invoke: async () => never,
		});
		await until(() => fakes.invocations.length, (n) => n === 1);
		// As the Workspace made its conversations: no organization.
		await runInDurableObject(stub, (_instance, state) => void state.storage.sql.exec("UPDATE conversation SET organization_id = NULL"));
		const before = (await stub.faultView(start.run, 0, 0)).internals.entered;
		expect(before).toEqual({ model: 1, tool: 1 });
		await abortAllDurableObjects();
		// Laravel's commands no longer reach it, but any event opens pi, and the gate runs first.
		expect(await refusalOf(wake(start))).toMatchObject({ code: "SCOPE_MISMATCH" });
		const restarted = objectOf(start);
		const run = await settled(restarted, start.run);
		expect([run.status, run.errorMessage]).toEqual(["cancelled", CANCELLED.message]);
		const live = () => runInDurableObject(restarted, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'").one().n);
		await until(live, (n) => n === 0);
		await sleep(300);
		const view = await restarted.faultView(start.run, 0, 0);
		expect(view.internals.entered).toEqual(before);
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "cancelled" }]);
		expect(fakes.invocations).toHaveLength(1);
	});
});

describe("the run's records", () => {
	test("an attempt's events are appended only while it is current; refused ones take no seq", async () => {
		const { start, stub } = await started("Hi");
		const runId = start.run;
		await settled(stub, runId);
		await runInDurableObject(stub, (_instance, state) => {
			const store = new RunStore(state.storage);
			state.storage.sql.exec("UPDATE runs SET status = 'running', attempt = 1, deadline = NULL WHERE id = ?", runId);
			const phase = (text: string) => ({ type: "phase" as const, data: { text } });
			expect(store.append(runId, phase("a"), { runId, attempt: 1 })).not.toBeNull();
			state.storage.sql.exec("UPDATE runs SET attempt = 2 WHERE id = ?", runId);
			expect(store.append(runId, phase("b"), { runId, attempt: 1 })).toBeNull();
			expect(store.append(runId, phase("c"), { runId, attempt: 2 })).not.toBeNull();
			state.storage.sql.exec("UPDATE runs SET deadline = ? WHERE id = ?", Date.now() - 1, runId);
			expect(store.append(runId, phase("d"), { runId, attempt: 2 })).toBeNull();
			// Recording a finished call needs an active run, any attempt; the object's own events need nothing.
			expect(store.append(runId, phase("e"), "active")).toBeNull();
			expect(store.append(runId, phase("f"))).not.toBeNull();
			state.storage.sql.exec("UPDATE runs SET deadline = NULL, revoked = 1 WHERE id = ?", runId);
			expect(store.isCurrent({ runId, attempt: 2 })).toBe(false);
			expect(store.isActive(runId)).toBe(false);
			expect(store.countToolCall({ runId, attempt: 2 })).toBe(false);
			const phases = state.storage.sql.exec<{ data: string }>("SELECT data FROM run_events WHERE run_id = ? AND type = 'phase' ORDER BY seq", runId).toArray();
			expect(phases.map((item) => JSON.parse(item.data).text).filter((text: string) => text.length === 1)).toEqual(["a", "c", "f"]);
			const seqs = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq", runId).toArray().map((item) => item.seq);
			expect(seqs).toEqual(seqs.map((_, index) => index + 1));
			expect(state.storage.sql.exec("SELECT event_seq FROM runs WHERE id = ?", runId).one().event_seq).toBe(seqs.length);
		});
	});

	test("changes made inside pi's open transaction are announced only once it commits, and never if it rolls back", async () => {
		const { start, stub } = await started("Hi");
		const runId = start.run;
		await settled(stub, runId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = new RunStore(state.storage);
			store.watchTransactions();
			const heard: string[] = [];
			store.listen({ appended: (_runId, event) => heard.push(event.type), ended: () => heard.push("ended"), factWritten: () => {}, settling: () => {} }, () => ({ resultVersionId: null, changes: null }));
			state.storage.sql.exec("UPDATE runs SET status = 'running' WHERE id = ?", runId);
			const seq = () => state.storage.sql.exec("SELECT event_seq FROM runs WHERE id = ?", runId).one().event_seq;
			const before = seq();
			// As pi commits: an asynchronous transaction whose callback awaits between statements.
			await state.storage
				.transaction(async () => {
					await Promise.resolve();
					expect(store.finish(runId, CANCELLED)).toBe(true);
					expect(heard).toEqual([]);
					throw new Error("rolled back");
				})
				.catch(() => {});
			expect(heard).toEqual([]);
			expect(state.storage.sql.exec("SELECT status FROM runs WHERE id = ?", runId).one().status).toBe("running");
			expect(seq()).toBe(before);
			await state.storage.transaction(async () => {
				await Promise.resolve();
				store.append(runId, { type: "phase", data: { text: "x" } });
				expect(heard).toEqual([]);
			});
			expect(heard).toEqual(["phase"]);
			store.append(runId, { type: "phase", data: { text: "y" } });
			expect(heard).toEqual(["phase", "phase"]);
		});
	});

	test("a write claimed while pi's transaction is open is not taken back by its rollback, nor is its settlement", async () => {
		const { start, stub } = await started("Hi");
		const runId = start.run;
		await settled(stub, runId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = new RunStore(state.storage);
			store.watchTransactions();
			state.storage.sql.exec("UPDATE runs SET status = 'running', attempt = 1, deadline = NULL, revoked = 0 WHERE id = ?", runId);
			// The Conversation's own composition: the store's checks and gateway/'s ledger in this object's SQLite.
			const ledger = gatewayLedger(state.storage, {
				isCurrent: (fence) => store.isCurrent(fence),
				deadline: () => null,
				writesUncertain: () => false,
				markWritesUncertain: (id) => store.setWritesUncertain(id),
				writeSettled: (write, outcome) => store.writeSettled(write, outcome),
			});
			const port = runStatePort(store, () => ledger, () => {});
			const fence = { runId, attempt: 1 };
			const writes = () => state.storage.sql.exec<{ key: string; status: string }>("SELECT key, status FROM run_writes WHERE run_id = ?", runId).toArray();
			// As pi commits: an asynchronous transaction whose callback awaits between statements, here rolled back.
			let claim: Promise<DispatchResult> | null = null;
			await state.storage
				.transaction(async () => {
					await Promise.resolve();
					claim = Promise.resolve(port.dispatchWrite(fence, "key-1"));
					await Promise.resolve();
					throw new Error("rolled back");
				})
				.catch(() => {});
			expect(await (claim as unknown as Promise<DispatchResult>)).toMatchObject({ kind: "dispatched" });
			// The claim the executor was told about is kept, so the same write is never dispatched twice.
			expect(writes()).toEqual([{ key: "key-1", status: "dispatched" }]);
			expect(await port.dispatchWrite(fence, "key-1")).toMatchObject({ kind: "refused", code: "WRITE_IN_PROGRESS" });
			let settle: Promise<void> | null = null;
			await state.storage
				.transaction(async () => {
					await Promise.resolve();
					settle = Promise.resolve(port.settleWrite(runId, "key-1", { effect: "applied", result: { items: [], count: 1 } }));
					await Promise.resolve();
					throw new Error("rolled back");
				})
				.catch(() => {});
			await settle;
			expect(writes()).toEqual([{ key: "key-1", status: "succeeded" }]);
			expect(await port.dispatchWrite(fence, "key-1")).toEqual({ kind: "cached", result: { items: [], count: 1 } });
		});
	});

	test("a replaced attempt can neither fail nor complete the run", async () => {
		const { start, stub } = await started("Hi");
		const runId = start.run;
		await settled(stub, runId);
		await runInDurableObject(stub, (_instance, state) => {
			const store = new RunStore(state.storage);
			state.storage.sql.exec("UPDATE runs SET status = 'provisioning', attempt = 2 WHERE id = ?", runId);
			expect(store.finish(runId, WORKER_FAILED, { attempt: 1 })).toBe(false);
			expect(store.finish(runId, { status: "completed", code: "", message: "" }, { attempt: 2, fromStatus: "running" })).toBe(false);
			expect(store.startAttempt({ runId, attempt: 1 })).toBe(false);
			expect(store.startAttempt({ runId, attempt: 2 })).toBe(true);
			expect(store.startAttempt({ runId, attempt: 2 })).toBe(false);
			expect(store.finish(runId, { status: "completed", code: "", message: "" }, { attempt: 2 })).toBe(true);
			expect(store.finish(runId, { status: "cancelled", code: "cancelled", message: "Stopped." })).toBe(false);
		});
	});

	test("tool calls are counted, never limited, and only for the current attempt", async () => {
		const gate = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: { key: "a" } }, { name: "fake_read", arguments: { key: "b" } }] }, { tools: [{ name: "fake_read", arguments: {} }] }] }), {
			declarations: [declaration("fake_read", true)],
			invoke: async (request, run) => {
				await gate.promise;
				if (!run.run.countToolCall(request.fence)) return { ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null };
				return allowed(request, { items: [], count: 0 });
			},
		});
		await until(() => fakes.invocations.length, (n) => n === 2);
		await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE runs SET tool_calls = 1000 WHERE id = ?", start.run));
		gate.resolve();
		await settled(stub, start.run);
		expect((await row(stub, start.run)).tool_calls).toBe(1003);
	});

	test("a lease is for the call's attempt: Laravel lends the current one's, and is never asked for another's", async () => {
		const connection = uuid7();
		const leases: unknown[] = [];
		const { start, stub } = conversation(
			{
				declarations: [declaration("fake_read", true)],
				invoke: async (request, run) => {
					leases.push(await run.credentials.lease(request.fence, connection));
					leases.push(await run.credentials.lease({ ...request.fence, attempt: request.fence.attempt + 1 }, connection));
					return allowed(request, { items: [], count: 0 });
				},
			},
			{
				message: message(scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] })),
				authority: { connections: [notesConnection(connection)], layers: notesLayers(connection) },
			},
		);
		fake.connections.set(connection, notesLease());
		await accepted(start);
		await settled(stub, start.run);
		expect(leases).toEqual([
			expect.objectContaining({ connectionId: connection, generation: 1, payload: { kind: "oauth2", access_token: "notes-access-0", refresh_token: null, scopes: ["notes"] } }),
			{ refused: "RUN_ENDED", message: "This run is no longer active." },
		]);
		expect(fake.calls.filter((call) => call.operation === "leaseToken" && call.run === start.run)).toHaveLength(1);
	});

	test("a dispatched write schedules the lost-write sweep", async () => {
		let swept = 0;
		const ledger = new FakeLedger();
		ledger.dispatchWrite = (() => ({ kind: "dispatched", deadline: 1 })) as never;
		ledger.sweepLostWrites = () => {
			swept++;
			return { uncertain: [], nextAt: null };
		};
		const { start, stub } = await started(scripted({ turns: [{ tools: [{ name: "fake_write", arguments: {} }] }] }), {
			ledger,
			declarations: [declaration("fake_write", false)],
			invoke: async (request, run) => {
				const dispatched = await run.run.dispatchWrite(request.fence, "key-1");
				expect(dispatched).toEqual({ kind: "dispatched", deadline: 1 });
				return allowed(request, { items: [], count: 0 });
			},
		});
		await settled(stub, start.run);
		const jobs = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT id, fn FROM cf_agents_jobs").toArray());
		expect(jobs).toContainEqual({ id: "sweep", fn: "sweep" });
		// The run's own clean-up and its facts' delivery rearm the alarm; let them finish first.
		await delivered(start);
		await due(stub, "sweep");
		// The alarm may already be running on its own when the test asks for it.
		await until(() => swept, (n) => n === 1);
	});

	test("deleting the conversation stops its run inside a tool call, and pi runs nothing afterwards", async () => {
		const hold = Promise.withResolvers<void>();
		const { start, stub, fakes } = await started(WAIT, waiting(hold.promise));
		await until(() => fakes.invocations.length, (n) => n === 1);
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const stored = await row(stub, start.run);
		expect([stored.status, stored.error_code, stored.revoked]).toEqual(["cancelled", "conversation_deleted", 1]);
		const entered = (await stub.faultView(start.run, 0, 0)).internals.entered;
		hold.resolve();
		await sleep(50);
		expect((await eventsOf(stub, start.run)).filter((event) => event.type === "tool_call")).toEqual([]);
		expect((await stub.faultView(start.run, 0, 0)).internals.entered).toEqual(entered);
		expect(entered).toEqual({ model: 1, tool: 1 });
		const live = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'").one().n);
		expect(live).toBe(0);
		expect(fakes.invocations).toHaveLength(1);
		expect(await stub.about()).toMatchObject({ kind: "conversation" });
	});
});
