// Stopping pi's work by its run (src/conversation/pi-stops.ts; docs/plans/chunk-19a-design.md, U5): the production class
// over pi-durable's own Harness on PiHarness's session store, opened and resumed as PiHarness does with the Conversation's
// settings, and tools of the test's own. Runs share one session, as chunk 19b makes every turn of a conversation do, and
// the acting run's operation is read as the Conversation reads it (pi-work.ts `operationOf`).

import { createModels, type FauxProviderHandle, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, createRegistry, defineTool, Harness, type Submission, type SubmissionRecord, type TaskId } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openPiSessionStore } from "agents/harness/pi";
import { afterEach, describe, expect, test } from "vitest";
import { PiStops } from "../../src/conversation/pi-stops.ts";
import { operationOf, PI_SETTINGS } from "../../src/conversation/pi-work.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context pi-stops test]" }) as never;

/** A tool call the test holds: its task, and what lets it answer. */
interface Held {
	task: TaskId;
	release(): void;
}

/** Resolvers of the next held call's start, and the release of every call still held. */
const starting: ((held: Held) => void)[] = [];
const releases: (() => void)[] = [];

/** Starts a call that answers once it is released, and also on pi's abort unless it is `stubborn`. */
function holding(task: TaskId, signal: AbortSignal | undefined, stubborn: boolean): Promise<void> {
	const released = Promise.withResolvers<void>();
	releases.push(released.resolve);
	for (const resolve of starting.splice(0)) resolve({ task, release: released.resolve });
	if (!stubborn) signal?.addEventListener("abort", () => released.resolve(), { once: true });
	return released.promise;
}

/** A call that runs until it is released or pi aborts it, as a connector call returns on pi's abort (tools.ts). */
const hold = defineTool({
	name: "hold",
	description: "Runs until it is stopped.",
	parameters: Type.Object({}),
	async execute(_args, api, context) {
		await holding(api.taskId, context.abortSignal, false);
		return { output: [{ type: "text", text: "Stopped." }] };
	},
});

/** A call that runs until it is released, whatever pi's abort says, as a local call past its checkpoint does (local.ts `runGated`). */
const stubborn = defineTool({
	name: "stubborn",
	description: "Runs until it is released.",
	parameters: Type.Object({}),
	async execute(_args, api, context) {
		await holding(api.taskId, context.abortSignal, true);
		return { output: [{ type: "text", text: "Released." }] };
	},
});

const opened: Harness[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const harness of opened.splice(0)) await harness.close(BG).catch(() => {});
});

interface Pi {
	harness: Harness;
	storage: SqliteStorage;
	faux: FauxProviderHandle;
	session: ConversationId;
	conversation: Conversation;
	stops: PiStops;
	/** Makes `run` the acting run, which claimed the session, or none. */
	act(run: string | null): void;
	logged: string[];
}

/** pi on a Conversation's storage, opened, rooted and resumed as PiHarness does, with one session for the runs and its stops. */
async function openPi(): Promise<Pi> {
	const storage = await openPiSessionStore(durableStorage(openDatabase()));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "minerva", tools: [hold, stubborn] });
	const harness = await Harness.open(storage, { models, registry, settings: PI_SETTINGS }, BG);
	opened.push(harness);
	await harness.root(BG);
	harness.resume();
	const model = faux.getModel();
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, instructions: "You are a test agent." } },
		BG,
	);
	let acting: string | null = null;
	const logged: string[] = [];
	const stops = new PiStops({
		operation: async () => (acting === null ? null : operationOf(storage, { id: acting, session: String(conversation.id) })),
		log: (message) => logged.push(message),
	});
	return { harness, storage, faux, session: conversation.id, conversation, stops, act: (run) => (acting = run), logged };
}

/** Resolves once the next held call has started. */
function started(): Promise<Held> {
	return new Promise((resolve) => starting.push(resolve));
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

const status = async (pi: Pi, run: string) => (await pi.storage.submissionByRequest(pi.session, `run:${run}`, BG))?.status;

/** Each task of the session, oldest first: the run whose submission it follows, its kind, its status and its abort mark. */
async function tasksOf(pi: Pi, runs: { run: string; submission: number }[]) {
	const { items } = await pi.storage.scanTasks({ conversationId: pi.session, order: "ascending" }, 100, undefined, BG);
	return items.map((task) => [runs.findLast(({ submission }) => task.id > submission)?.run, task.kind, task.state.status, task.abortRequested]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const A = "0199a000-0000-7000-8000-00000000000a";
const B = "0199a000-0000-7000-8000-00000000000b";
const call = (tool: string) => fauxAssistantMessage(fauxToolCall(tool, {}), { stopReason: "toolUse" });

describe("stopping pi's work by its run, on one session two runs share", () => {
	test("a stop started for A and held until B is placed marks nothing of B's, and B answers", async () => {
		const pi = await openPi();
		pi.faux.setResponses([call("hold"), call("hold"), fauxAssistantMessage(fauxText("B's answer"))]);
		pi.act(A);
		const aStarted = started();
		const a = await submit(pi, A, "Hold");
		await aStarted;

		pi.act(null);
		const stop = Promise.withResolvers<void>();
		const late = stop.promise.then(() => pi.stops.mark(pi.harness));
		pi.act(B);
		await pi.stops.settle(pi.harness);
		expect(await status(pi, A)).toBe("unanswered");
		const bStarted = started();
		const b = await submit(pi, B, "Hold, then answer");
		expect(b.committed).toBe("placed");
		const own = await bStarted;

		stop.resolve();
		const { orphans, marked } = await late;
		await marked;
		expect(orphans).toEqual([]);
		own.release();
		expect((await b.submission.wait(BG)).status).toBe("done");
		await pi.conversation.waitForIdle(BG);
		expect(
			await tasksOf(pi, [
				{ run: A, submission: a.submission.id },
				{ run: B, submission: b.submission.id },
			]),
		).toEqual([
			[A, "pi.generation", "terminal", true],
			[A, "pi.tool", "terminal", true],
			[B, "pi.generation", "terminal", false],
			[B, "pi.tool", "terminal", false],
			[B, "pi.generation", "terminal", false],
		]);
		expect(pi.logged).toEqual([]);
	});

	test("deletion's settle waits for a held tool task an earlier stop already marked, and answers only once it is terminal", async () => {
		const pi = await openPi();
		pi.faux.setResponses([call("stubborn")]);
		pi.act(A);
		const aStarted = started();
		const a = await submit(pi, A, "Run until released");
		const held = await aStarted;

		pi.act(null);
		const { orphans } = await pi.stops.mark(pi.harness);
		expect(orphans.map((task) => [task.kind, task.background])).toEqual([
			["pi.generation", false],
			["pi.tool", false],
		]);
		await expect.poll(async () => (await pi.storage.task(held.task, BG))?.abortRequested).toBe(true);
		let answered = false;
		const deleting = pi.stops.settle(pi.harness).then(() => {
			answered = true;
		});
		await sleep(200);
		expect(answered).toBe(false);
		expect((await pi.storage.task(held.task, BG))?.state.status).toBe("running");

		held.release();
		await deleting;
		expect((await pi.storage.task(held.task, BG))?.state.status).toBe("terminal");
		expect(await status(pi, A)).toBe("unanswered");
		expect((await pi.harness.inspect(BG)).tasks).toEqual([]);
		expect(await tasksOf(pi, [{ run: A, submission: a.submission.id }])).toEqual([
			[A, "pi.generation", "terminal", true],
			[A, "pi.tool", "terminal", true],
		]);
	});
});
