// Stopping pi's work by its run, and the starts' lane (src/conversation/pi-stops.ts): the
// production class over pi-durable's own Harness on PiHarness's session store, opened and resumed as PiHarness does with the
// Conversation's settings, and tools and a task kind of the test's own. Runs share one session, as chunk 19b makes every turn
// of a conversation do, and the acting run's operation is read as the Conversation reads it (pi-work.ts `operationOf`).

import { createModels, type FauxProviderHandle, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
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
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openPiSessionStore } from "agents/harness/pi";
import { afterEach, describe, expect, test } from "vitest";
import { PI_SETTLE_MS, PiStops } from "../../src/conversation/pi-stops.ts";
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

/** A background task whose invocation runs until it is released, whatever pi's abort says. */
const background = defineTask<Record<string, never>, { phase: "run" }, null>({
	name: "test.background",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		async run(task, runtime) {
			await holding(task.id, runtime.signal, true);
		},
	},
	async abort(_task, runtime, context) {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
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

/**
 * pi on a Conversation's storage, opened, rooted and resumed as PiHarness does, with one session for the runs and its stops,
 * whose starts may wait `bound` ms.
 */
async function openPi(bound = PI_SETTLE_MS): Promise<Pi> {
	const storage = await openPiSessionStore(durableStorage(openDatabase()));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "minerva", tools: [hold, stubborn], tasks: [background] });
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
		bound: () => bound,
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

/** What a section does once its bound passed while it waited: logged, so a test that expects none finds it. */
const expired = (pi: Pi, section = "the section") => async (bound: number) => void pi.logged.push(`${section}'s bound of ${bound} ms passed`);

/** The end signal of a run that never ends. */
const noEnd = () => new AbortController().signal;

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

	test("A's end, marking while B submits between its two reads, takes nothing of B's for an orphan, and B answers", async () => {
		const pi = await openPi();
		pi.faux.setResponses([call("hold"), call("hold"), fauxAssistantMessage(fauxText("B's answer"))]);
		pi.act(A);
		const aStarted = started();
		const a = await submit(pi, A, "Hold");
		await aStarted;

		pi.act(B);
		await pi.stops.settle(pi.harness);
		expect(await status(pi, A)).toBe("unanswered");
		const bStarted = started();
		const submitted = Promise.withResolvers<Awaited<ReturnType<typeof submit>>>();
		const end = new PiStops({
			operation: async () => {
				const op = await operationOf(pi.storage, { id: B, session: String(pi.session) });
				submitted.resolve(await submit(pi, B, "Hold, then answer"));
				return op;
			},
			bound: () => PI_SETTLE_MS,
			log: (message) => pi.logged.push(message),
		});
		const { orphans, marked } = await end.mark(pi.harness);
		expect(orphans).toEqual([]);
		await marked;
		const b = await submitted.promise;
		expect(b.committed).toBe("placed");

		(await bStarted).release();
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

	test("a settle whose first reading went stale, as A's generation handed its run to a successor, marks again until a mark finds nothing", async () => {
		const pi = await openPi();
		// A's successor calls the held tool again, so it stays live until it is marked.
		pi.faux.setResponses([call("hold"), call("hold")]);
		pi.act(A);
		const aStarted = started();
		await submit(pi, A, "Hold");
		const held = await aStarted;
		const generations = async () =>
			(await pi.storage.scanTasks({ conversationId: pi.session, order: "ascending" }, 100, undefined, BG)).items.filter((task) => task.kind === "pi.generation");
		const [first] = await generations();

		// The first reading is taken while A's first generation is live, and returned only once a successor holds A's run.
		pi.act(B);
		let reads = 0;
		const stale: Pick<Harness, "inspect" | "abortTask" | "waitForTask"> = {
			inspect: async (context) => {
				const reading = await pi.harness.inspect(context);
				if (reads++ > 0) return reading;
				expect(reading.tasks.map((task) => task.record.id)).toContain(first?.id);
				held.release();
				await expect.poll(async () => (await generations()).map((task) => task.state.status !== "terminal")).toEqual([false, true]);
				return reading;
			},
			abortTask: (task, context) => pi.harness.abortTask(task, context),
			waitForTask: (task, context) => pi.harness.waitForTask(task, context),
		};
		await pi.stops.settle(stale);

		expect((await pi.harness.inspect(BG)).tasks.filter((task) => !task.record.background)).toEqual([]);
		const [, successor] = await generations();
		expect([successor?.state.status, successor?.abortRequested]).toEqual(["terminal", true]);
		expect(await status(pi, A)).toBe("unanswered");
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

describe("the starts' lane, on one session two runs share", () => {
	test("A's section, held at its submit while A is cancelled, ends before B's starts; B's wait settles A's input, and B answers in its own run", async () => {
		const pi = await openPi();
		pi.faux.setResponses([call("hold"), fauxAssistantMessage(fauxText("B's answer"))]);
		const order: string[] = [];
		const aEnd = new AbortController();
		const aAtSubmit = Promise.withResolvers<void>();
		const aSubmits = Promise.withResolvers<void>();
		let a: Awaited<ReturnType<typeof submit>> | undefined;
		pi.act(A);
		const aSection = pi.stops.section(async (section) => {
			expect(await section.settle(pi.harness, aEnd.signal)).toBe(true);
			aAtSubmit.resolve();
			await aSubmits.promise;
			// Its tool started, so A's generation, not B's, takes the first answer.
			const aStarted = started();
			a = await submit(pi, A, "Hold");
			await aStarted;
			order.push("A submitted");
		}, expired(pi));
		await aAtSubmit.promise;

		aEnd.abort();
		pi.act(B);
		let aAtWait: SubmissionRecord["status"] | undefined;
		let b: Awaited<ReturnType<typeof submit>> | undefined;
		const bSection = pi.stops.section(async (section) => {
			order.push("B started");
			expect(await section.settle(pi.harness, noEnd())).toBe(true);
			aAtWait = await status(pi, A);
			b = await submit(pi, B, "Answer");
		}, expired(pi));
		await sleep(200);
		expect(order).toEqual([]);

		aSubmits.resolve();
		await aSection;
		await bSection;
		expect(order).toEqual(["A submitted", "B started"]);
		expect(a?.committed).toBe("placed");
		expect(aAtWait).toBe("unanswered");
		expect(b?.committed).toBe("placed");
		const answered = await b?.submission.wait(BG);
		expect(answered?.status).toBe("done");
		await pi.conversation.waitForIdle(BG);
		expect(
			await tasksOf(pi, [
				{ run: A, submission: a?.submission.id ?? 0 },
				{ run: B, submission: b?.submission.id ?? 0 },
			]),
		).toEqual([
			[A, "pi.generation", "terminal", true],
			[A, "pi.tool", "terminal", true],
			[B, "pi.generation", "terminal", false],
		]);
		expect(pi.logged).toEqual([]);
	});

	test("a background invocation that ignores its signal is marked, and B's wait goes on without it", async () => {
		const pi = await openPi();
		pi.faux.setResponses([fauxAssistantMessage(fauxText("B's answer"))]);
		const running = started();
		const task = await pi.conversation.commit((tx) => tx.createTask(background, {}, { ownership: { kind: "conversation" }, background: true }), BG);
		const held = await running;
		expect(held.task).toBe(task);

		pi.act(B);
		let b: Awaited<ReturnType<typeof submit>> | undefined;
		await pi.stops.section(async (section) => {
			expect(await section.settle(pi.harness, noEnd())).toBe(true);
			b = await submit(pi, B, "Answer");
		}, expired(pi));
		await expect.poll(async () => (await pi.storage.task(task, BG))?.abortRequested).toBe(true);
		expect((await pi.storage.task(task, BG))?.state.status).toBe("running");
		expect(b?.committed).toBe("placed");
		expect((await b?.submission.wait(BG))?.status).toBe("done");

		held.release();
		await expect.poll(async () => (await pi.storage.task(task, BG))?.state.status).toBe("terminal");
		expect(pi.logged).toEqual([]);
	});

	test("a section that throws does not stop the next, and a section's timer fires only while it waits", async () => {
		const pi = await openPi(300);
		const failed = pi.stops.section(async () => {
			throw new Error("The section failed.");
		}, expired(pi));
		let next: boolean | undefined;
		const after = pi.stops.section(async (section) => {
			next = await section.settle(pi.harness, noEnd());
		}, expired(pi));
		await expect(failed).rejects.toThrow("The section failed.");
		await after;
		expect(next).toBe(true);

		pi.faux.setResponses([call("stubborn")]);
		pi.act(A);
		const aStarted = started();
		await submit(pi, A, "Run until released");
		const held = await aStarted;
		pi.act(B);
		let waited: boolean | undefined;
		await pi.stops.section(async (section) => {
			waited = await section.settle(pi.harness, noEnd());
		}, expired(pi));
		expect(waited).toBe(false);
		await sleep(400);
		expect(pi.logged).toEqual(["the section's bound of 300 ms passed"]);
		held.release();
	});

	test("a section held past its bound once its wait answered resets nothing, and one queued behind it resets once from the lane and never runs", async () => {
		const pi = await openPi(300);
		const answered = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<void>();
		const held = pi.stops.section(async (section) => {
			answered.resolve(await section.settle(pi.harness, noEnd()));
			await release.promise;
		}, expired(pi, "the held section"));
		expect(await answered.promise).toBe(true);
		let ran = false;
		const queued = pi.stops.section(async () => {
			ran = true;
		}, expired(pi, "the queued section"));
		await expect.poll(() => pi.logged, { timeout: 2_000 }).toEqual(["the queued section's bound of 300 ms passed"]);

		release.resolve();
		await held;
		await queued;
		expect(ran).toBe(false);
		expect(pi.logged).toEqual(["the queued section's bound of 300 ms passed"]);
	});
});
