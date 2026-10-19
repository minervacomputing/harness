// What pi holds for a run, by its operation (src/conversation/pi-work.ts):
// the gate's reader and the admission of tool and model calls over pi-durable's own Harness on PiHarness's session store,
// opened and resumed as PiHarness does with the Conversation's settings, so every submission and task they read is one pi
// made. Runs share one session, as chunk 19b makes every turn of a conversation do.

import { type AssistantMessage, createModels, type FauxProviderHandle, type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineTask,
	defineTool,
	Harness,
	type Submission,
	type SubmissionRecord,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openPiSessionStore } from "agents/harness/pi";
import { afterEach, describe, expect, test } from "vitest";
import { CANCELLED } from "../../src/conversation/events.ts";
import { admitModel, admitTool, belongs, PI_SETTINGS, type PiCall, piWork, type ToolAdmission } from "../../src/conversation/pi-work.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context pi-work test]" }) as never;

/** A `hold` call as pi named it to its tool, and what lets it answer. */
interface Held {
	call: PiCall;
	release(): void;
}

/** Resolvers of the next `hold` call's start. */
const holding: ((held: Held) => void)[] = [];

/** A tool call that runs until it is released or pi aborts it, as a connector call returns on pi's abort (tools.ts). */
const hold = defineTool({
	name: "hold",
	description: "Runs until it is stopped.",
	parameters: Type.Object({}),
	async execute(_args, api, context) {
		const stopped = Promise.withResolvers<void>();
		const held = { call: { session: api.conversationId, task: api.taskId }, release: () => stopped.resolve() };
		for (const resolve of holding.splice(0)) resolve(held);
		context.abortSignal?.addEventListener("abort", () => stopped.resolve(), { once: true });
		await stopped.promise;
		return { output: [{ type: "text", text: "Stopped." }] };
	},
});

/** A conversation-owned task that runs until it is aborted: work a run left live, or a background task. */
const held = defineTask<Record<string, never>, { phase: "run" }, null>({
	name: "test.held",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		async run(_task, runtime) {
			await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	},
	async abort(_task, runtime, context) {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

interface Pi {
	harness: Harness;
	storage: SqliteStorage;
	faux: FauxProviderHandle;
	session: ConversationId;
	conversation: Conversation;
}

const opened: Harness[] = [];
const gates: PromiseWithResolvers<void>[] = [];
afterEach(async () => {
	for (const gate of gates.splice(0)) gate.resolve();
	for (const harness of opened.splice(0)) await harness.close(BG).catch(() => {});
});

/** pi on a Conversation's storage, opened, rooted and resumed as PiHarness does, with one session for the runs. */
async function openPi(durable: DurableObjectStorage = durableStorage(openDatabase())): Promise<Pi> {
	const storage = await openPiSessionStore(durable);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "minerva", tools: [hold], tasks: [held] });
	const harness = await Harness.open(storage, { models, registry, settings: PI_SETTINGS }, BG);
	opened.push(harness);
	await harness.root(BG);
	harness.resume();
	const model = faux.getModel();
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, instructions: "You are a test agent." } },
		BG,
	);
	return { harness, storage, faux, session: conversation.id, conversation };
}

/** A model answer that comes once `open` is called. */
function later(message: AssistantMessage): { answer: FauxResponseFactory; open(): void } {
	const gate = Promise.withResolvers<void>();
	gates.push(gate);
	return {
		answer: async () => {
			await gate.promise;
			return message;
		},
		open: () => gate.resolve(),
	};
}

/** Resolves once the next `hold` call has started. */
function holdStarted(): Promise<Held> {
	return new Promise((resolve) => holding.push(resolve));
}

/** Submits the run's input `run:<id>` once, as `#startLoop` does, with the status its submission had in the commit that made it. */
async function submit(pi: Pi, run: string, prompt: string): Promise<{ submission: Submission; committed: SubmissionRecord["status"] | undefined }> {
	let committed: SubmissionRecord["status"] | undefined;
	const unsubscribe = pi.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) if (change.type === "submission" && change.value.requestId === `run:${run}`) committed ??= change.value.status;
	});
	try {
		const submission = await pi.conversation.submit({ type: "input", content: prompt, requestId: `run:${run}` }, BG);
		return { submission, committed };
	} finally {
		unsubscribe();
	}
}

async function heldTask(conversation: Conversation, background: boolean): Promise<TaskId> {
	return conversation.commit((tx) => tx.createTask(held, {}, { ownership: { kind: "conversation" }, background }), BG);
}

/** Waits until pi runs each task, so they share the status whose newest task piWork checks. */
async function running(pi: Pi, ids: readonly TaskId[]): Promise<void> {
	for (const id of ids) await expect.poll(async () => (await pi.storage.task(id, BG))?.state.status).toBe("running");
}

async function abort(pi: Pi, ids: readonly TaskId[]): Promise<void> {
	for (const id of ids) await pi.harness.abortTask(id, BG);
	for (const id of ids) await pi.harness.waitForTask(id, BG);
}

async function tasksOf(pi: Pi): Promise<readonly TaskRecord<unknown, unknown, unknown>[]> {
	return (await pi.storage.scanTasks({ conversationId: pi.session }, 100, undefined, BG)).items;
}

function run(pi: Pi, id: string): { id: string; session: string } {
	return { id, session: String(pi.session) };
}

describe("what pi holds for a run, read by its operation", () => {
	test("the run's own submission decides: queued and placed are in progress, done and unanswered settled while no task of its own is live", async () => {
		const pi = await openPi();
		const first = later(fauxAssistantMessage(fauxText("First answer")));
		pi.faux.setResponses([first.answer, fauxAssistantMessage(fauxText("Second answer")), fauxAssistantMessage("", { stopReason: "error", errorMessage: "The upstream failed." })]);

		const placed = await submit(pi, "placed", "First question");
		expect(placed.committed).toBe("placed");
		expect(await piWork(pi.storage, run(pi, "placed"))).toBe("in_progress");
		const queued = await submit(pi, "queued", "Second question");
		expect(queued.committed).toBe("queued");
		expect(await piWork(pi.storage, run(pi, "queued"))).toBe("in_progress");

		first.open();
		expect((await placed.submission.wait(BG)).status).toBe("done");
		expect((await queued.submission.wait(BG)).status).toBe("done");
		await pi.conversation.waitForIdle(BG);
		expect(await piWork(pi.storage, run(pi, "placed"))).toBe("settled");
		expect(await piWork(pi.storage, run(pi, "queued"))).toBe("settled");

		const failed = await submit(pi, "failed", "Third question");
		expect((await failed.submission.wait(BG)).status).toBe("unanswered");
		await pi.conversation.waitForIdle(BG);
		expect(await piWork(pi.storage, run(pi, "failed"))).toBe("settled");
		await heldTask(pi.conversation, false);
		expect(await piWork(pi.storage, run(pi, "failed"))).toBe("in_progress");
	});

	test("a settled run with a live task of its own is in progress; a leftover background task, older or newer than its own, or one in another session, never counts", async () => {
		const pi = await openPi();
		pi.faux.setResponses([fauxAssistantMessage(fauxText("Answer"))]);
		const answered = await submit(pi, "run-1", "Question");
		expect((await answered.submission.wait(BG)).status).toBe("done");
		await pi.conversation.waitForIdle(BG);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("settled");

		const background = await heldTask(pi.conversation, true);
		const elsewhere = await heldTask(await pi.harness.createConversation({ ownership: { kind: "ownerless" } }, BG), false);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("settled");
		const own = await heldTask(pi.conversation, false);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("in_progress");
		const newer = await heldTask(pi.conversation, true);
		await running(pi, [own, newer]);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("in_progress");
		await abort(pi, [own]);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("settled");

		const op = { session: pi.session, submission: { id: answered.submission.id, status: "done" as const } };
		for (const id of [background, newer, elsewhere]) {
			const task = await pi.storage.task(id, BG);
			expect(task?.state.status).toBe("running");
			expect(task !== undefined && belongs(op, task)).toBe(false);
		}
	});

	test("a run with no submission is not submitted, whatever its session holds, and a task older than its submission is not its own and never hides its own", async () => {
		const pi = await openPi();
		const earlier = await heldTask(pi.conversation, false);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("not_submitted");
		expect(await piWork(pi.storage, { id: "run-1", session: null })).toBe("not_submitted");
		const live = await pi.storage.task(earlier, BG);
		expect(live !== undefined && belongs({ session: pi.session, submission: null }, live)).toBe(false);

		pi.faux.setResponses([fauxAssistantMessage(fauxText("Answer"))]);
		const answered = await submit(pi, "run-1", "Question");
		expect((await answered.submission.wait(BG)).status).toBe("done");
		expect((await pi.storage.task(earlier, BG))?.state.status).toBe("running");
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("settled");
		const own = await heldTask(pi.conversation, false);
		await running(pi, [own]);
		expect(await piWork(pi.storage, run(pi, "run-1"))).toBe("in_progress");
	});

	test("two runs on one session: B is not submitted while A's work is live, then B's own work alone decides", async () => {
		const pi = await openPi();
		const started = holdStarted();
		pi.faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]);
		const a = await submit(pi, "A", "Hold");
		await started;
		expect(await piWork(pi.storage, run(pi, "A"))).toBe("in_progress");
		expect(await piWork(pi.storage, run(pi, "B"))).toBe("not_submitted");

		const live = (await pi.harness.inspect(BG)).tasks.filter((task) => task.record.conversationId === pi.session).map((task) => task.record.id);
		expect(live.length).toBe(2);
		await abort(pi, live);
		expect((await a.submission.wait(BG)).status).toBe("unanswered");
		expect((await pi.storage.submissionByRequest(pi.session, "run:A", BG))?.status).toBe("unanswered");
		const ofA = await tasksOf(pi);
		expect(ofA.map((task) => task.state.status)).toEqual(["terminal", "terminal"]);

		const answer = later(fauxAssistantMessage(fauxText("B's answer")));
		pi.faux.setResponses([answer.answer]);
		const b = await submit(pi, "B", "Answer");
		expect(b.committed).toBe("placed");
		expect(await piWork(pi.storage, run(pi, "B"))).toBe("in_progress");
		answer.open();
		expect((await b.submission.wait(BG)).status).toBe("done");
		await pi.conversation.waitForIdle(BG);
		expect(await piWork(pi.storage, run(pi, "B"))).toBe("settled");
		expect(await piWork(pi.storage, run(pi, "A"))).toBe("settled");

		const opB = { session: pi.session, submission: { id: b.submission.id, status: "done" as const } };
		expect(ofA.every((task) => task.id < b.submission.id && !belongs(opB, task))).toBe(true);
		const ofB = (await tasksOf(pi)).filter((task) => !ofA.some((earlier) => earlier.id === task.id));
		expect(ofB.length).toBe(1);
		expect(ofB.every((task) => belongs(opB, task))).toBe(true);
	});
});

describe("pi makes no background work", () => {
	test("background compaction is off, which the id rule and model admission rest on", () => {
		expect(PI_SETTINGS.compaction?.backgroundTokens).toBe(0);
	});
});

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199a000-0000-7000-8000-00000000000b";
const HOLD = fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });

/**
 * pi and the Conversation's store on one storage, as the object holds them, with admission's reads built as the
 * Conversation builds them and an entry counter. Its runs share pi's session, which chunk 19b's schema allows.
 */
async function admission() {
	const db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	db.exec("DROP INDEX runs_session");
	db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
	const storage = durableStorage(db);
	const store = new RunStore(storage);
	store.watchTransactions();
	const pi = await openPi(storage);
	const entered: string[] = [];
	const deps: ToolAdmission = { store, pi: () => pi.storage, entered: (session) => entered.push(session) };
	let created = 0;
	return {
		store,
		pi,
		deps,
		entered,
		/** A run that claimed pi's session and is running in attempt 1. */
		start(id: string): void {
			db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, metered, session) VALUES (?, 'running', 0, '{}', ?, 1, ?)").all(id, ++created, String(pi.session));
			db.prepare("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, 1, 0)").all(id);
		},
		cancel: (id: string) => store.outside(() => store.finish(id, CANCELLED)),
	};
}

describe("admission by the active run's operation", () => {
	test("a call is admitted only for the active run while its submission is placed, a tool call only from its session and a task made after the submission", async () => {
		const { pi, deps, entered, start, cancel } = await admission();
		pi.faux.setResponses([HOLD, HOLD, fauxAssistantMessage(fauxText("A's answer")), HOLD, fauxAssistantMessage(fauxText("B's answer"))]);
		const S = String(pi.session);
		start(A);
		const first = holdStarted();
		await submit(pi, A, "Hold twice");
		const a = await first;
		expect(await admitTool(deps, a.call), "A's own task").toEqual({ fence: { runId: A, attempt: 1 }, deadline: null });
		expect(await admitModel(deps, { runId: A, attempt: 1 }), "A's model call").toBe(true);

		await cancel(A);
		expect(await admitTool(deps, a.call), "no active run").toBeNull();
		expect(await admitModel(deps, { runId: A, attempt: 1 }), "A ended").toBe(false);

		start(B);
		expect(await admitTool(deps, a.call), "B has no submission").toBeNull();
		expect(await admitModel(deps, { runId: B, attempt: 1 }), "B has no submission").toBe(false);
		const b = await submit(pi, B, "Hold once");
		expect(b.committed).toBe("queued");
		const second = holdStarted();
		a.release();
		const after = await second;
		expect(after.call.task).toBeGreaterThan(b.submission.id);
		expect(await admitTool(deps, after.call), "a task above B's queued submission").toBeNull();
		expect(await admitModel(deps, { runId: B, attempt: 1 }), "B's submission queued").toBe(false);

		const third = holdStarted();
		after.release();
		const own = await third;
		expect((await pi.storage.submissionByRequest(pi.session, `run:${B}`, BG))?.status).toBe("placed");
		expect(await admitTool(deps, own.call), "B's own task").toEqual({ fence: { runId: B, attempt: 1 }, deadline: null });
		expect(await admitModel(deps, { runId: B, attempt: 1 }), "B's model call").toBe(true);
		expect(await admitTool(deps, a.call), "A's task against B's placed submission").toBeNull();
		expect(await admitModel(deps, { runId: A, attempt: 1 }), "A's model call while B acts").toBe(false);
		const elsewhere = await pi.harness.createConversation({ ownership: { kind: "ownerless" } }, BG);
		const other = { session: elsewhere.id, task: await heldTask(elsewhere, false) };
		expect(other.task).toBeGreaterThan(b.submission.id);
		expect(await admitTool(deps, other), "a call from another session").toBeNull();

		own.release();
		expect((await b.submission.wait(BG)).status).toBe("done");
		expect(await admitTool(deps, own.call), "B's submission settled").toBeNull();
		expect(await admitModel(deps, { runId: B, attempt: 1 }), "B's submission settled").toBe(false);
		expect(entered).toEqual([S, S, S, S, S, S, String(elsewhere.id), S]);
	});

	test("a run cancelled while the check awaits pi's read is refused by the fence after it", async () => {
		for (const check of ["tool", "model"] as const) {
			const { store, pi, deps, start, cancel } = await admission();
			pi.faux.setResponses([HOLD]);
			start(B);
			const started = holdStarted();
			await submit(pi, B, "Hold");
			const own = await started;
			const cancelling: ToolAdmission = {
				...deps,
				pi: () => ({
					async submissionByRequest(session, requestId, context) {
						const submission = await pi.storage.submissionByRequest(session, requestId, context);
						await cancel(B);
						return submission;
					},
				}),
			};
			if (check === "tool") {
				expect(await admitTool(deps, own.call)).toEqual({ fence: { runId: B, attempt: 1 }, deadline: null });
				expect(await admitTool(cancelling, own.call)).toBeNull();
			} else {
				expect(await admitModel(deps, { runId: B, attempt: 1 })).toBe(true);
				expect(await admitModel(cancelling, { runId: B, attempt: 1 })).toBe(false);
			}
			expect(store.activeRun(), check).toBeNull();
			expect((await pi.storage.submissionByRequest(pi.session, `run:${B}`, BG))?.status, check).toBe("placed");
		}
	});
});
