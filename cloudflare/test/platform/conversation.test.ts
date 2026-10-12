// The Conversation Durable Object in local workerd: the start protocol against a fake Workspace, runs and
// their events, cancels and revocations, the deadline, paging, the stream's WebSocket, tools through a fake
// executor, history replay, and restarts through the attempt gate with the fake model. Ported from
// backend/tests/test_api.py (runs and messages), test_gateway.py and test_attempts.py (events, fencing,
// tools, model calls), test_supervisor.py (restarts) and worker/test/resume.test.ts (recovery).

import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { conversationObject } from "../../src/addressing.ts";
import type { Caller, Json, RunId } from "../../src/contracts/common.ts";
import type { RunEvent } from "../../src/contracts/events.ts";
import type { DispatchResult, ExecutorContext, ToolCallOutcome, ToolCallRequest, ToolDeclaration, ToolResult } from "../../src/contracts/executor.ts";
import type { CancelReason, RunHead, StartSnapshot } from "../../src/contracts/runs.ts";
import type { CancelAck } from "../../src/contracts/conversation.ts";
import type { BeginRunInput, BeginRunResult, Registration } from "../../src/contracts/workspace.ts";
import type { Conversation } from "../../src/conversation/conversation.ts";
import { CANCELLED, WORKER_FAILED } from "../../src/conversation/events.ts";
import { FOLDER_INSTRUCTIONS } from "../../src/conversation/history.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { RunStream } from "../../src/conversation/stream.ts";
import { type ConversationPorts, defaultPorts, emptyFolder, gatewayLedger, PORTS, runStatePort, type WorkspaceClient, type WriteLedger } from "../../src/conversation/ports.ts";
import { PROVIDER_ERROR } from "../../src/model/tap.ts";
import { type FakeOptions, type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { type ModelRoute, type Upstream, upstreamOf } from "../../src/model/route.ts";
import { uuid7 } from "../../src/lib/random.ts";

const WS = "0199a000-0000-7000-8000-00000000c0aa";
const USER = "0199a000-0000-7000-8000-00000000c0bb";
const OTHER = "0199a000-0000-7000-8000-00000000c0cc";
const AGENT = "0199a000-0000-7000-8000-00000000c0dd";
const CALLER: Caller = { userId: USER, role: "owner" };
const WORKSPACE = { id: WS, jurisdiction: null };

/** The Workspace Durable Object as a conversation sees it, recording what it was asked. */
class FakeWorkspace implements WorkspaceClient {
	begun: BeginRunInput[] = [];
	activated: RunId[] = [];
	released: [RunId, string][] = [];
	touched = 0;
	deadline: number | null = null;
	/** Holds `beginRun` until released, to let a cancel arrive in between. */
	hold: Promise<void> | null = null;
	answer: (input: BeginRunInput) => BeginRunResult = (input) => ({
		ok: true,
		value: {
			snapshot: this.snapshot(input),
			uploads: input.uploadIds.map((id) => ({ id, name: "notes.txt", size: 5, mediaType: "text/plain", sha256: "0".repeat(64), key: `uploads/${WS}/${USER}/${id}` })),
		},
	});
	registration: (runId: RunId) => Registration | Promise<Registration> = () => ({ state: "active" });

	snapshot(input: BeginRunInput): StartSnapshot {
		const now = Date.now();
		return {
			workspaceId: WS,
			conversationId: input.conversationId,
			userId: input.userId,
			agentId: input.agentId,
			permissions: [{ name: "ceiling", restricted: false, allows: [], denies: [] }],
			tools: [],
			instructions: "You are a test agent.",
			modelAlias: "default",
			deadline: this.deadline,
			createdAt: now,
			connectionIds: [],
		};
	}

	async beginRun(input: BeginRunInput): Promise<BeginRunResult> {
		this.begun.push(input);
		await this.hold;
		return this.answer(input);
	}

	async activate(runId: RunId): Promise<Registration> {
		this.activated.push(runId);
		return this.registration(runId);
	}

	async release(runId: RunId, status: string): Promise<void> {
		this.released.push([runId, status]);
	}

	async conversationTouched(): Promise<void> {
		this.touched++;
	}

	async lease(): Promise<{ refused: "CONNECTION_UNAUTHORIZED"; message: string }> {
		return { refused: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." };
	}

	async markUnauthorized(): Promise<void> {}
}

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
	workspace: FakeWorkspace;
	ledger: FakeLedger;
	declarations: ToolDeclaration[];
	invoke: (request: ToolCallRequest, run: ExecutorContext) => Promise<ToolCallOutcome>;
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

beforeAll(() => {
	PORTS.factory = (): ConversationPorts => ({
		...defaultPorts,
		workspace: ({ conversationId }) => fakesOf(conversationId).workspace,
		executor: (run, { conversationId }) => ({
			declarations: () => fakesOf(conversationId).declarations,
			invoke: (request) => {
				const fakes = fakesOf(conversationId);
				fakes.invocations.push(request);
				return fakes.invoke(request, run);
			},
		}),
		ledger: (_storage, _runs, { conversationId }) => fakesOf(conversationId).ledger,
		folder: emptyFolder,
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
	});
});

afterEach(() => {
	FAKES.clear();
});

async function conversation(fakes: Partial<Fakes> = {}) {
	const id = uuid7();
	FAKES.set(id, {
		workspace: new FakeWorkspace(),
		ledger: new FakeLedger(),
		declarations: [],
		invoke: async (request) => allowed(request, { items: [{ id: "1" }], count: 1 }),
		model: {},
		contexts: [],
		invocations: [],
		...fakes,
	});
	const stub = conversationObject(env, WORKSPACE, id);
	await stub.init({ conversationId: id, workspace: WORKSPACE, userId: USER, agentId: AGENT, createdAt: Date.now() });
	return { id, stub, fakes: fakesOf(id) };
}

type Stub = DurableObjectStub<Conversation>;

/** A message the fake model answers with this script. */
function scripted(script: FakeScript): string {
	return JSON.stringify({ fake: script });
}

async function post(stub: Stub, content: string, attachments: string[] = []) {
	return stub.postMessage(CALLER, { content, attachments });
}

async function posted(stub: Stub, content: string): Promise<RunId> {
	const outcome = await post(stub, content);
	if (!outcome.ok) throw new Error(`Refused: ${outcome.refusal.status} ${outcome.refusal.detail}`);
	return outcome.value.run.id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 8000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(20);
	}
}

async function runOf(stub: Stub, runId: RunId): Promise<RunHead> {
	return (await stub.getRun(CALLER, runId)) as RunHead;
}

async function settled(stub: Stub, runId: RunId, timeout?: number): Promise<RunHead> {
	return until(() => runOf(stub, runId), (run) => !["queued", "provisioning", "running"].includes(run.status), timeout);
}

async function eventsOf(stub: Stub, runId: RunId): Promise<RunEvent[]> {
	return (await stub.getRunEvents(CALLER, runId, { after: 0, upTo: 1_000_000, limit: 1000 })) ?? [];
}

function statuses(events: RunEvent[]) {
	return events.filter((event) => event.type === "status").map((event) => event.data);
}

/** Makes a Lifecycle job due now and runs the object's alarm. */
async function due(stub: Stub, job: string): Promise<void> {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0 WHERE id = ?", job);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(stub);
}

/** Usage and flags straight from the row, for what the API does not show. */
async function row(stub: Stub, runId: RunId) {
	return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT * FROM runs WHERE id = ?", runId).one());
}

describe("starting a run", () => {
	test("a message starts one run, which answers and ends completed", async () => {
		const { stub, fakes } = await conversation();
		const outcome = await post(stub, "Hello there");
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const { message, run } = outcome.value;
		expect(message).toMatchObject({ role: "user", content: "Hello there", attachments: [], run_id: run.id });
		expect(run.status).toBe("queued");
		expect(run.events).toEqual([{ seq: 1, type: "status", data: { status: "queued" } }]);
		expect(fakes.workspace.begun).toEqual([
			{ runId: run.id, conversationId: expect.any(String), userId: USER, agentId: AGENT, uploadIds: [], folder: { bytes: 0, entries: 0 } },
		]);
		const ended = await settled(stub, run.id);
		expect(ended).toMatchObject({ status: "completed", error_message: "", finished_at: expect.any(String) });
		const events = await eventsOf(stub, run.id);
		expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
		expect(statuses(events)).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
		expect(events.filter((event) => event.type === "phase").map((event) => event.data)).toEqual([{ text: "Starting the agent" }, { text: "Thinking" }]);
		// The answer and `completed` are the last two events.
		const [answer, last] = events.slice(-2);
		expect(answer).toMatchObject({ type: "message", data: { content: "Done." } });
		expect(last).toMatchObject({ type: "status", data: { status: "completed" } });
		expect(events.filter((event) => event.type === "text_delta").map((event) => (event.data as { text: string }).text).join("")).toBe("Done.");
		const head = await stub.getConversation(CALLER);
		expect(head?.title).toBe("Hello there");
		expect(head?.messages.map((item) => [item.role, item.content, item.run_id])).toEqual([
			["user", "Hello there", run.id],
			["assistant", "Done.", run.id],
		]);
		expect(head?.messages[1]?.id).toBe((answer?.data as { id: string }).id);
		expect(head?.runs.map((item) => [item.id, item.status, item.eventSeq])).toEqual([[run.id, "completed", events.length]]);
		await until(async () => fakes.workspace.released, (released) => released.length > 0);
		expect(fakes.workspace.activated).toEqual([run.id]);
		expect(fakes.workspace.released).toEqual([[run.id, "completed"]]);
		const stored = await row(stub, run.id);
		expect([stored.model_calls, stored.unmetered_model_calls]).toEqual([1, 0]);
		expect(stored.input_tokens).toBeGreaterThan(0);
	});

	test("refusals leave nothing behind", async () => {
		const { stub, fakes } = await conversation();
		expect(await post(stub, "  \n\t ")).toEqual({ ok: false, refusal: { status: 400, detail: "Write a message or attach a file." } });
		fakes.workspace.answer = () => ({ ok: false, refusal: { status: 404, detail: "Not Found" } });
		expect(await post(stub, "Hi")).toEqual({ ok: false, refusal: { status: 404, detail: "Not Found" } });
		const head = await stub.getConversation(CALLER);
		expect(head).toMatchObject({ title: "", messages: [], runs: [] });
		// The marker is gone, so the next message may start.
		fakes.workspace.answer = (input) => ({ ok: true, value: { snapshot: fakes.workspace.snapshot(input), uploads: [] } });
		const runId = await posted(stub, "Hi");
		await settled(stub, runId);
	});

	test("an upload the folder cannot take refuses the start, and the Workspace releases it", async () => {
		const { stub, fakes } = await conversation();
		const upload = "0199a000-0000-7000-8000-0000000000ff";
		// The default folder takes no attachments until step 3.
		expect(await post(stub, "", [upload])).toEqual({
			ok: false,
			refusal: { status: 400, detail: "An attached file is no longer available. Remove it and attach it again." },
		});
		await until(async () => fakes.workspace.released, (released) => released.length === 1);
		expect(fakes.workspace.released[0]?.[1]).toBe("refused");
		expect(await stub.getConversation(CALLER)).toMatchObject({ messages: [], runs: [] });
	});

	test("one run at a time: a second message is 409, also while the first start is in flight", async () => {
		const hold = Promise.withResolvers<void>();
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		let release = () => {};
		fakes.workspace.hold = new Promise<void>((resolve) => (release = resolve));
		const first = post(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.workspace.begun.length, (n) => n === 1);
		const busy = { ok: false, refusal: { status: 409, detail: "Wait for the current answer to finish, or stop it." } };
		expect(await post(stub, "Second")).toEqual(busy);
		release();
		const outcome = await first;
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		await until(async () => fakes.invocations.length, (n) => n === 1);
		expect(await post(stub, "Third")).toEqual(busy);
		expect(fakes.workspace.begun.length).toBe(1);
		hold.resolve();
		await settled(stub, outcome.value.run.id);
		const head = await stub.getConversation(CALLER);
		expect(head?.messages.filter((item) => item.role === "user").length).toBe(1);
	});

	test("a message sent again with its key answers for the same run: joined in flight, stored, never a second run", async () => {
		const { stub, fakes } = await conversation();
		let release = () => {};
		fakes.workspace.hold = new Promise<void>((resolve) => (release = resolve));
		const content = scripted({ turns: [{ text: "Once." }] });
		const first = stub.postMessage(CALLER, { content, attachments: [] }, "retry-1");
		await until(async () => fakes.workspace.begun.length, (n) => n === 1);
		// While the first start is in flight: the same start's answer, not a 409.
		const second = stub.postMessage(CALLER, { content, attachments: [] }, "retry-1");
		expect(await stub.postMessage(CALLER, { content: "Something else", attachments: [] }, "retry-1")).toEqual({
			ok: false,
			refusal: { status: 422, detail: "This Idempotency-Key was used for a different message." },
		});
		release();
		const [a, b] = await Promise.all([first, second]);
		if (!a.ok || !b.ok) throw new Error("Refused");
		expect([b.value.run.id, b.value.message.id]).toEqual([a.value.run.id, a.value.message.id]);
		await settled(stub, a.value.run.id);
		// Stored: the stored message and run, as they are now.
		const third = await stub.postMessage(CALLER, { content, attachments: [] }, "retry-1");
		expect(third.ok && [third.value.run.id, third.value.message.id, third.value.run.status]).toEqual([a.value.run.id, a.value.message.id, "completed"]);
		expect(fakes.workspace.begun.length).toBe(1);
		const head = await stub.getConversation(CALLER);
		expect([head?.messages.filter((item) => item.role === "user").length, head?.runs.length]).toEqual([1, 1]);
		// Another key is another message.
		const next = await stub.postMessage(CALLER, { content, attachments: [] }, "retry-2");
		expect(next.ok && next.value.run.id).not.toBe(a.value.run.id);
		if (next.ok) await settled(stub, next.value.run.id);
	});

	test("a refused start forgets its key, so the message may be sent again with it", async () => {
		const { stub, fakes } = await conversation();
		fakes.workspace.answer = () => ({ ok: false, refusal: { status: 404, detail: "Not Found" } });
		expect(await stub.postMessage(CALLER, { content: "Hi", attachments: [] }, "k")).toEqual({ ok: false, refusal: { status: 404, detail: "Not Found" } });
		fakes.workspace.answer = (input) => ({ ok: true, value: { snapshot: fakes.workspace.snapshot(input), uploads: [] } });
		const again = await stub.postMessage(CALLER, { content: "Hi", attachments: [] }, "k");
		expect(again.ok).toBe(true);
		if (again.ok) await settled(stub, again.value.run.id);
	});

	test("another user's conversation and runs are not found", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, "Mine");
		const other: Caller = { userId: OTHER, role: "member" };
		expect(await stub.getConversation(other)).toBeNull();
		expect(await stub.getRun(other, runId)).toBeNull();
		expect(await stub.cancelRun(other, runId)).toBeNull();
		expect(await stub.getRunEvents(other, runId, { after: 0, upTo: 10, limit: 10 })).toBeNull();
		expect(await stub.postMessage(other, { content: "x", attachments: [] })).toEqual({ ok: false, refusal: { status: 404, detail: "Not Found" } });
		await settled(stub, runId);
	});

	test("the title is the first message cut to 80 characters, an emoji being one", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, `${"x".repeat(79)}😀😀`);
		expect((await stub.getConversation(CALLER))?.title).toBe(`${"x".repeat(79)}😀`);
		await settled(stub, runId);
		const second = await posted(stub, "Another");
		expect((await stub.getConversation(CALLER))?.title).toBe(`${"x".repeat(79)}😀`);
		await settled(stub, second);
	});

	test("a cancel during beginRun leaves a tombstone, and the run is stored cancelled", async () => {
		const { stub, fakes } = await conversation();
		let release = () => {};
		fakes.workspace.hold = new Promise<void>((resolve) => (release = resolve));
		const outcome = post(stub, "Revoke me");
		await until(async () => fakes.workspace.begun.length, (n) => n === 1);
		const runId = fakes.workspace.begun[0]?.runId as RunId;
		expect(await stub.cancel(runId, "permissions_changed", 7)).toEqual({ runId, state: "tombstoned" });
		release();
		const result = await outcome;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.run).toMatchObject({ status: "cancelled", error_message: "Stopped because permissions changed." });
		expect(statuses(result.value.run.events)).toEqual([{ status: "queued" }, { status: "cancelled", message: "Stopped because permissions changed." }]);
		await until(async () => fakes.workspace.released, (released) => released.length > 0);
		expect(fakes.workspace.released).toEqual([[runId, "cancelled"]]);
		expect(fakes.workspace.activated).toEqual([]);
		expect(await stub.cancel(runId, "permissions_changed", 7)).toEqual({ runId, state: "ended" });
	});

	test.each([
		[{ state: "revoked", reason: "agent_connections_changed" } as Registration, "cancelled", "Stopped because permissions changed."],
		[{ state: "expired" } as Registration, "failed", "The agent could not finish this run. Try again."],
		[{ state: "ended" } as Registration, "cancelled", "Stopped."],
	])("activation answering %o ends the run", async (registration, status, message) => {
		const { stub, fakes } = await conversation();
		fakes.workspace.registration = () => registration;
		const runId = await posted(stub, "Hi");
		const run = await settled(stub, runId);
		expect([run.status, run.error_message]).toEqual([status, message]);
		expect(fakes.contexts).toEqual([]);
	});

	test("an activation that failed is sent again by the watch alarm", async () => {
		const { stub, fakes } = await conversation();
		let failing = true;
		fakes.workspace.registration = () => {
			if (failing) throw new Error("lost answer");
			return { state: "active" };
		};
		const runId = await posted(stub, "Hi");
		await until(async () => fakes.workspace.activated.length, (n) => n === 1);
		expect((await runOf(stub, runId)).status).toBe("queued");
		failing = false;
		await due(stub, `watch:${runId}`);
		expect((await settled(stub, runId)).status).toBe("completed");
		expect(fakes.workspace.activated.length).toBe(2);
	});
});

describe("stopping a run", () => {
	test("the user's cancel is idempotent and says Stopped.", async () => {
		const hold = Promise.withResolvers<void>();
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		const cancelled = await stub.cancelRun(CALLER, runId);
		expect(cancelled).toMatchObject({ status: "cancelled", error_message: "Stopped." });
		expect(await stub.cancelRun(CALLER, runId)).toEqual(cancelled);
		hold.resolve();
		const events = await eventsOf(stub, runId);
		expect(statuses(events).at(-1)).toEqual({ status: "cancelled", message: "Stopped." });
		// The call finished after the run ended: it is not recorded.
		await sleep(50);
		expect((await eventsOf(stub, runId)).filter((event) => event.type === "tool_call")).toEqual([]);
		const stored = await row(stub, runId);
		expect(stored.error_code).toBe("cancelled");
	});

	test.each([
		["permissions_changed", "permissions_changed", "Stopped because permissions changed."],
		["emergency_stop", "emergency_stop", "Stopped."],
		["cancelled", "cancelled", "Stopped."],
	] as [CancelReason, string, string][])("a cancel from the outbox for %s stops the run with its code", async (reason, code, message) => {
		const hold = Promise.withResolvers<void>();
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		expect(await stub.cancel(runId, reason, 3)).toEqual({ runId, state: "stopping" });
		const stored = await row(stub, runId);
		expect([stored.status, stored.error_code, stored.error_message, stored.revoked]).toEqual(["cancelled", code, message, 1]);
		hold.resolve();
		expect(await stub.cancel(runId, reason, 3)).toEqual({ runId, state: "ended" });
	});

	test("a run past its deadline times out on its alarm", async () => {
		const hold = Promise.withResolvers<void>();
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		fakes.workspace.deadline = Date.now() + 1500;
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		await sleep(1600);
		// Expired counts as inactive before it is marked: fenced events are refused.
		await runDurableObjectAlarm(stub);
		const run = await settled(stub, runId);
		expect([run.status, run.error_message]).toEqual(["timed_out", "The run took too long."]);
		hold.resolve();
	});
});

describe("events", () => {
	test("pages of events by seq, up to a seq, at most a limit", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, scripted({ chunkChars: 1, turns: [{ text: "abcdefghij" }] }));
		await settled(stub, runId);
		const all = await eventsOf(stub, runId);
		expect(all.length).toBeGreaterThan(5);
		const page = await stub.getRunEvents(CALLER, runId, { after: 2, upTo: 5, limit: 2 });
		expect(page?.map((event) => event.seq)).toEqual([3, 4]);
		expect(await stub.getRunEvents(CALLER, runId, { after: 4, upTo: 5, limit: 1000 })).toEqual([all[4]]);
		await expect(stub.getRunEvents(CALLER, runId, { after: -1, upTo: 5, limit: 2 })).rejects.toThrow();
	});

	test("the stream sends the backlog, then live events, then end", async () => {
		const hold = Promise.withResolvers<void>();
		const { id, stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: { key: "a" } }] }, { text: "Finished." }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		const frames: string[] = [];
		const response = await stub.fetch(`http://conversation/stream?run=${runId}&after=1&user=${USER}`, { headers: { Upgrade: "websocket" } });
		expect(response.status).toBe(101);
		const socket = response.webSocket as WebSocket;
		const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
		socket.addEventListener("message", (event) => {
			frames.push(String(event.data));
		});
		socket.accept();
		await until(async () => frames.length, (n) => n >= 3);
		hold.resolve();
		expect(await closed).toBe(1000);
		const parsed = frames.map((frame) => JSON.parse(frame) as RunEvent | { type: "end" });
		expect(parsed.at(-1)).toEqual({ type: "end" });
		const seqs = parsed.flatMap((frame) => ("seq" in frame ? [frame.seq] : []));
		// Every event after `after`, once, in order.
		const all = await eventsOf(stub, runId);
		expect(seqs).toEqual(all.filter((event) => event.seq > 1).map((event) => event.seq));
		expect(id).toBeTruthy();
	});

	test("a socket another instance accepted is never written to, nor ended short of what it missed: it is told to reconnect", async () => {
		// Local workerd closes every socket when it resets objects (1006), so the next instance is played by a
		// second RunStream over the same object: what the platform gives an instance that inherits sockets
		// (they outlive the instance that accepted them), with nothing in memory about them.
		for (const variant of ["its start", "the run's next event and end"] as const) {
			const { stub, fakes } = await conversation({ declarations: [declaration("fake_wait", true)], invoke: () => new Promise<ToolCallOutcome>(() => {}) });
			const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
			await until(async () => fakes.invocations.length, (n) => n === 1);
			const seqs: number[] = [];
			const closes: number[] = [];
			let ended = false;
			// A client following the run as the Worker's relay does: from its last event again after a 1013.
			for (let reconnects = 0; reconnects < 3; reconnects++) {
				const response = await stub.fetch(`http://conversation/stream?run=${runId}&after=${seqs.at(-1) ?? 0}&user=${USER}`, { headers: { Upgrade: "websocket" } });
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
					await until(async () => seqs.length, (n) => n === before);
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
						const next = new RunStream(state, () => new RunStore(state.storage));
						if (variant === "its start") {
							append("status", { status: "completed" }, "completed");
							next.resetInherited();
						} else {
							next.broadcast(runId, append("status", { status: "completed" }, "completed"));
							next.end(runId);
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

	test("a stream for an ended run replays and ends at once; another user's is not found", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, "Hi");
		await settled(stub, runId);
		const all = await eventsOf(stub, runId);
		const refused = await stub.fetch(`http://conversation/stream?run=${runId}&after=0&user=${OTHER}`, { headers: { Upgrade: "websocket" } });
		expect(refused.status).toBe(404);
		const response = await stub.fetch(`http://conversation/stream?run=${runId}&after=${all.length - 2}&user=${USER}`, { headers: { Upgrade: "websocket" } });
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
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_read", true), declaration("fake_write", false)],
			invoke: async (request) =>
				request.name === "fake_read"
					? allowed(request, { items: [{ title: "Ünïcode" }], count: 1 })
					: { ok: false, error: { code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." }, event: { tool: request.name, label: "Fake: write", arguments: {}, decision: "denied", code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." } },
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: { key: "a" } }] }, { tools: [{ name: "fake_write", arguments: { key: "b" } }] }, { text: "Done reading." }] }));
		const run = await settled(stub, runId);
		expect(run.status).toBe("completed");
		expect(fakes.invocations.map((request) => [request.name, request.arguments, request.fence])).toEqual([
			["fake_read", { key: "a" }, { runId, attempt: 1 }],
			["fake_write", { key: "b" }, { runId, attempt: 1 }],
		]);
		const calls = (await eventsOf(stub, runId)).filter((event) => event.type === "tool_call").map((event) => event.data);
		expect(calls.map((call) => (call as { decision: string }).decision)).toEqual(["allowed", "denied"]);
		// The tool results as the model saw them: Python's json.dumps of the result, and the error's message.
		const results = (fakes.contexts.at(-1)?.messages ?? []).filter((message) => message.role === "toolResult");
		expect(results.map((message) => [message.content, message.isError])).toEqual([
			[[{ type: "text", text: '{"items": [{"title": "\\u00dcn\\u00efcode"}], "count": 1}' }], false],
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
		const { stub, fakes } = await conversation({ declarations: [{ ...declaration("fake_read", true), inputSchema: { type: "object" } }] });
		// "\\" parsed after a first key makes V8 return "\\" for a later "\n" in that place (lib/json.ts), so the
		// fake's provider-side parse (pi-ai's parseStreamingJson) and pi's own reads misread the arguments.
		const text = `{"${first}":1,"\\n":2}`;
		JSON.parse(`{"${first}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(text))).toEqual([first, "\\"]);
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }], rawArguments: { "0": text } }] }));
		await settled(stub, runId);
		expect(fakes.invocations.map((request) => request.arguments)).toEqual([{ [first]: 1, "\n": 2 }]);
	});

	test("a call that ends RUN_ENDED is not recorded", async () => {
		const { stub } = await conversation({
			declarations: [declaration("fake_read", true)],
			invoke: async () => ({ ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null }),
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }));
		await settled(stub, runId);
		expect((await eventsOf(stub, runId)).filter((event) => event.type === "tool_call")).toEqual([]);
	});
});

describe("the model", () => {
	test("a later run replays the earlier messages, not this run's own, as text", async () => {
		const { stub, fakes } = await conversation();
		const first = await posted(stub, "First question");
		await settled(stub, first);
		const second = await posted(stub, "Second question");
		await settled(stub, second);
		const context = fakes.contexts.at(-1) as TranscriptContext;
		const turns = context.messages.filter((message) => message.role !== "system").map((message) => [message.role, message.role === "assistant" ? message.content : (message as { content: unknown }).content]);
		expect(turns).toEqual([
			["user", "First question"],
			["assistant", [{ type: "text", text: "Done." }]],
			["user", "Second question"],
		]);
		// pi adds the instructions as a positional system section; providers that take no mid-conversation
		// system messages fold it into the leading one.
		const system = context.messages.filter((message) => message.role === "system");
		// With the local tools, the folder's paragraph follows the agent's instructions after a blank line (harness 3.3).
		expect(JSON.stringify(system)).toContain(JSON.stringify(`<instructions>\nYou are a test agent.\n\n${FOLDER_INSTRUCTIONS}\n</instructions>`).slice(1, -1));
	});

	test("a provider's error text never reaches the run, and the run fails", async () => {
		const { stub, fakes } = await conversation({ model: { script: () => ({ turns: [{ error: { message: "secret org-1234 quota" } }] }) } });
		const runId = await posted(stub, "Hi");
		const run = await settled(stub, runId);
		expect([run.status, run.error_message]).toEqual(["failed", "The agent could not finish this run. Try again."]);
		const stored = await runInDurableObject(stub, (_instance, state) => {
			const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
			return tables.map(({ name }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())).join("\n");
		});
		expect(stored).not.toContain("org-1234");
		expect(stored).toContain("The model provider reported an error.");
		expect(fakes.contexts.length).toBe(1);
		expect(PROVIDER_ERROR).toBe("The model provider reported an error.");
	});

	test("a failure's text, which createAI also copies into its diagnostics, is nowhere in storage, the run's events or the logs", async () => {
		const secret = "SYNTHETIC_SECRET";
		const route = (provider: ModelRoute["provider"]): ModelRoute => ({ provider, name: provider === "workers-ai" ? "@cf/zai-org/glm-5.3-flash" : "gpt-test", gateway: "minerva-cf-local", api: "responses", cap: 1000, reasoningEffort: "", reasoningSummary: "" });
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
				const { stub } = await conversation({ upstream: upstreamOf(route(provider), binding) });
				const runId = await posted(stub, "Hi");
				const run = await settled(stub, runId);
				expect([run.status, run.error_message]).toEqual(["failed", "The agent could not finish this run. Try again."]);
				const stored = await runInDurableObject(stub, (_instance, state) => {
					const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
					return tables.map(({ name }) => `${name}: ${JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())}`).join("\n");
				});
				// pi's own tables are there, with the failed call in its records.
				expect(stored).toMatch(/^pi_entries: \[\{/m);
				expect(stored).toContain("The model provider reported an error.");
				expect(stored).not.toContain(secret);
				expect(JSON.stringify(await eventsOf(stub, runId))).not.toContain(secret);
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(logged.join("\n")).toContain("The model provider reported an error");
		expect(logged.join("\n")).not.toContain(secret);
	});
});

describe("restarts through the attempt gate", () => {
	/** A stub after `abortAllDurableObjects`, which breaks the stubs made before it. */
	const fresh = (id: string): Stub => conversationObject(env, WORKSPACE, id);

	test("a read interrupted by the object's death runs again as attempt 2, and the run completes", async () => {
		let executions = 0;
		const never = new Promise<ToolCallOutcome>(() => {});
		const { id, stub, fakes } = await conversation({
			declarations: [declaration("fake_read", true)],
			invoke: async (request) => (++executions === 1 ? never : allowed(request, { items: [], count: 0 })),
		});
		const runId = await posted(stub, scripted({ turns: [{ text: "Looking.", tools: [{ name: "fake_read", arguments: { key: "a" } }] }, { text: "Found it." }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		await abortAllDurableObjects();
		// Any event opens pi again, and the gate counts the restart before pi does anything.
		const run = await settled(fresh(id), runId, 15_000);
		expect(run.status).toBe("completed");
		const events = await eventsOf(fresh(id), runId);
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
		expect((await row(fresh(id), runId)).attempt).toBe(2);
		expect((await fresh(id).getConversation(CALLER))?.messages.at(-1)?.content).toBe("Found it.");
	});

	test("the third death fails the run with worker_exited, and pi runs nothing afterwards", async () => {
		const never = new Promise<ToolCallOutcome>(() => {});
		const { id, stub, fakes } = await conversation({ declarations: [declaration("fake_read", true)], invoke: async () => never });
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }));
		for (const attempt of [1, 2, 3]) {
			await until(async () => fakes.invocations.length, (n) => n === attempt, 15_000);
			await abortAllDurableObjects();
			await fresh(id).getRun(CALLER, runId);
		}
		const run = await settled(fresh(id), runId, 15_000);
		expect([run.status, run.error_message]).toEqual(["failed", "The worker stopped unexpectedly."]);
		const stored = await row(fresh(id), runId);
		expect([stored.attempt, stored.error_code]).toEqual([3, "worker_exited"]);
		await sleep(300);
		expect(fakes.invocations.length).toBe(3);
		const live = await runInDurableObject(fresh(id), (_instance, state) =>
			state.storage.sql.exec("SELECT count(*) AS n FROM pi_tasks WHERE status <> 'terminal'").one().n,
		);
		expect(live).toBe(0);
		const attempts = await runInDurableObject(fresh(id), (_instance, state) =>
			state.storage.sql.exec("SELECT attempt, ended FROM attempts WHERE run_id = ? ORDER BY attempt", runId).toArray(),
		);
		expect(attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "restarted" },
			{ attempt: 3, ended: "failed" },
		]);
	});

	test("an idle object that wakes between turns is no restart", async () => {
		const { id, stub } = await conversation();
		const first = await posted(stub, "One");
		await settled(stub, first);
		await abortAllDurableObjects();
		const second = await posted(fresh(id), "Two");
		await settled(fresh(id), second);
		for (const runId of [first, second]) {
			expect(statuses(await eventsOf(fresh(id), runId)).some((data) => "attempt" in data)).toBe(false);
			expect((await row(fresh(id), runId)).attempt).toBe(1);
		}
	});

	test("a queued run is no restart: the start protocol activates it when the object comes back", async () => {
		const { id, stub, fakes } = await conversation();
		const answered = Promise.withResolvers<Registration>();
		fakes.workspace.registration = () => answered.promise;
		const runId = await posted(stub, "Hi");
		await until(async () => fakes.workspace.activated.length, (n) => n === 1);
		await abortAllDurableObjects();
		fakes.workspace.registration = () => ({ state: "active" });
		const run = await settled(fresh(id), runId, 15_000);
		expect(run.status).toBe("completed");
		expect(statuses(await eventsOf(fresh(id), runId)).some((data) => "attempt" in data)).toBe(false);
		expect(fakes.workspace.activated.length).toBe(2);
		answered.resolve({ state: "active" });
	});
});

describe("the run's records", () => {
	test("an attempt's events are appended only while it is current; refused ones take no seq", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, "Hi");
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
			expect(phases.map((row) => JSON.parse(row.data).text).filter((text: string) => text.length === 1)).toEqual(["a", "c", "f"]);
			const seqs = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq", runId).toArray().map((row) => row.seq);
			expect(seqs).toEqual(seqs.map((_, index) => index + 1));
			expect(state.storage.sql.exec("SELECT event_seq FROM runs WHERE id = ?", runId).one().event_seq).toBe(seqs.length);
		});
	});

	test("changes made inside pi's open transaction are announced only once it commits, and never if it rolls back", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, "Hi");
		await settled(stub, runId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = new RunStore(state.storage);
			store.watchTransactions();
			const heard: string[] = [];
			store.listen({ appended: (_runId, event) => heard.push(event.type), ended: () => heard.push("ended") }, () => ({ resultVersionId: null, changes: null }));
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
		const { stub } = await conversation();
		const runId = await posted(stub, "Hi");
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

	test("a revocation's cancel that arrives while pi's transaction is open is acknowledged only once it is kept", async () => {
		const hold = Promise.withResolvers<void>();
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		const stored = await runInDurableObject(stub, async (instance, state) => {
			let ack: Promise<CancelAck> | null = null;
			await state.storage
				.transaction(async () => {
					await Promise.resolve();
					ack = instance.cancel(runId, "permissions_changed", 7);
					await Promise.resolve();
					throw new Error("rolled back");
				})
				.catch(() => {});
			expect(await (ack as unknown as Promise<CancelAck>)).toEqual({ runId, state: "stopping" });
			return state.storage.sql.exec("SELECT status, revoked, error_code FROM runs WHERE id = ?", runId).one();
		});
		expect(stored).toEqual({ status: "cancelled", revoked: 1, error_code: "permissions_changed" });
		hold.resolve();
		expect((await settled(stub, runId)).status).toBe("cancelled");
	});

	test("a replaced attempt can neither fail nor complete the run", async () => {
		const { stub } = await conversation();
		const runId = await posted(stub, "Hi");
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
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_read", true)],
			invoke: async (request, run) => {
				await gate.promise;
				if (!run.run.countToolCall(request.fence)) return { ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null };
				return allowed(request, { items: [], count: 0 });
			},
		});
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: { key: "a" } }, { name: "fake_read", arguments: { key: "b" } }] }, { tools: [{ name: "fake_read", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 2);
		await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE runs SET tool_calls = 1000 WHERE id = ?", runId));
		gate.resolve();
		await settled(stub, runId);
		expect((await row(stub, runId)).tool_calls).toBe(1003);
	});

	test("a lease is for the call's attempt: refused before the Workspace is asked when it is not current", async () => {
		const leases: string[] = [];
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_read", true)],
			invoke: async (request, run) => {
				const current = await run.credentials.lease(request.fence, "conn-1");
				const stale = await run.credentials.lease({ ...request.fence, attempt: request.fence.attempt + 1 }, "conn-1");
				leases.push(JSON.stringify(current), JSON.stringify(stale));
				return allowed(request, { items: [], count: 0 });
			},
		});
		const asked: string[] = [];
		fakes.workspace.lease = async () => {
			asked.push("lease");
			return { refused: "CONNECTION_UNAUTHORIZED" as const, message: "The connection expired. Reconnect it in Minerva." };
		};
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_read", arguments: {} }] }] }));
		await settled(stub, runId);
		expect(leases).toEqual([
			JSON.stringify({ refused: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." }),
			JSON.stringify({ refused: "RUN_ENDED", message: "This run is no longer active." }),
		]);
		expect(asked).toEqual(["lease"]);
	});

	test("a dispatched write schedules the lost-write sweep", async () => {
		let swept = 0;
		const { stub, fakes } = await conversation({
			declarations: [declaration("fake_write", false)],
			invoke: async (request, run) => {
				const dispatched = await run.run.dispatchWrite(request.fence, "key-1");
				expect(dispatched).toEqual({ kind: "dispatched", deadline: 1 });
				return allowed(request, { items: [], count: 0 });
			},
		});
		fakes.ledger.dispatchWrite = (() => ({ kind: "dispatched", deadline: 1 })) as never;
		fakes.ledger.sweepLostWrites = () => {
			swept++;
			return { uncertain: [], nextAt: null };
		};
		const runId = await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_write", arguments: {} }] }] }));
		await settled(stub, runId);
		const jobs = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT id, fn FROM cf_agents_jobs").toArray());
		expect(jobs).toContainEqual({ id: "sweep", fn: "sweep" });
		// The run's own clean-up rearms the alarm; let it finish first.
		await until(async () => fakes.workspace.released.length, (n) => n === 1);
		await due(stub, "sweep");
		// The alarm may already be running on its own when the test asks for it.
		await until(async () => swept, (n) => n === 1);
	});

	test("deleting the conversation stops its run and leaves nothing", async () => {
		const hold = Promise.withResolvers<void>();
		const { id, stub, fakes } = await conversation({
			declarations: [declaration("fake_wait", true)],
			invoke: async (request) => {
				await hold.promise;
				return allowed(request, { items: [], count: 0 });
			},
		});
		await posted(stub, scripted({ turns: [{ tools: [{ name: "fake_wait", arguments: {} }] }] }));
		await until(async () => fakes.invocations.length, (n) => n === 1);
		await stub.destroy().catch(() => {});
		hold.resolve();
		// The Agent's teardown resets the object after deleting its storage; a later call reaches a new one.
		await sleep(50);
		const after = await until(
			async () => conversationObject(env, WORKSPACE, id).getConversation(CALLER).then((head) => ({ head }), () => null),
			(answer) => answer !== null,
		);
		expect(after).toEqual({ head: null });
		expect(await conversationObject(env, WORKSPACE, id).about()).toMatchObject({ kind: "conversation" });
	});
});

