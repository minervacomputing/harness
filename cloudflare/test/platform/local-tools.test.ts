// The local tools in the real Conversation Durable Object, in local workerd (ARCHITECTURE.md: Checkpoints, The local
// tools), as Laravel's commands reach it (startRun, cancelRun and folder through the internal mount) with the fake Laravel:
// PiHarness with the fake model calling pi's read, write, edit and bash, the folder's store on the object's SQLite and the
// EU bucket, and a conversation's container played by test/platform/sandbox-memory.ts (local workerd has no containers).
// Covered: results held until a checkpoint saved them and their cards after, phases, the final rehash, the folder version
// published with the run's changes and warnings, a turn that only reads, the run's container destroyed at its end, a cancelled
// run's end marking the work of a command pi's abort does not end, a deletion that waits for such a command, the next start
// waiting for it (and its bound, a start cancelled while it waits, and one cancelled in the lane, whose bound resets
// nothing), a folder over its limits (folder_limit and its message), a container that fails its hardening (worker_failed)
// or never starts (attempts until worker_exited), and crashes between a checkpoint's upload and its record, its record and
// the release, and the release and pi's commit (the Checkpoints row of ARCHITECTURE.md's Testing table), each resumed from
// the last checkpoint.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RunEvent } from "@minerva/contract";
import type { Fact, Scope } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { filesBucket } from "../../src/addressing.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { QUOTE_END } from "../../src/conversation/history.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import type { Conversation, RunInternals } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts } from "../../src/faults/ports.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeTurn } from "../../src/model/fake.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { commands, held, objectOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";
import { MemorySandbox } from "./sandbox-memory.ts";

signedAssertions();

const SANDBOXES = new Map<string, MemorySandbox>();
const DELIVERY = { ...FACT_DELIVERY };
let fake: FakeLaravel;
let uninstall: () => void;

type ConversationStub = DurableObjectStub<Conversation>;

beforeAll(() => {
	PORTS.factory = () => ({
		...faultConversationPorts(defaultPorts),
		sandbox: ({ conversationId }) => sandboxOf(conversationId),
	});
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	for (const sandbox of SANDBOXES.values()) sandbox.release();
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

function sandboxOf(conversationId: string): MemorySandbox {
	const sandbox = SANDBOXES.get(conversationId);
	if (!sandbox) throw new Error(`No sandbox for ${conversationId}`);
	return sandbox;
}

/** A Laravel conversation in the EU and its container. A stub breaks once its object was reset, so each use gets a new one. */
interface World {
	within: Scope;
	conversationId: string;
	readonly conversation: ConversationStub;
	sandbox: MemorySandbox;
}

async function world(options: { faults?: Fault[]; piSettleMs?: number } = {}): Promise<World> {
	const within = scope();
	const conversationId = uuid7();
	const sandbox = new MemorySandbox(() => filesBucket(env, { id: within.workspace, jurisdiction: "eu" }));
	SANDBOXES.set(conversationId, sandbox);
	const conversation = () => objectOf({ scope: within, conversation: conversationId });
	if (options.faults) await conversation().faultPlan(options.faults, { piSettleMs: options.piSettleMs });
	return {
		within,
		conversationId,
		get conversation() {
			return conversation();
		},
		sandbox,
	};
}

/** Sends a start, which Laravel holds, whose model answers with `turns`; its run's id once it is accepted. */
async function post(w: World, turns: FakeTurn[]): Promise<RunId> {
	const start = held(fake, startOf(w.within, { conversation: w.conversationId, message: { id: uuid7(), content: JSON.stringify({ fake: { turns } }), attachments: [] } }));
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return start.run;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
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

async function settled(w: World, runId: RunId, timeout?: number): Promise<RunHead> {
	return (await until(
		async () => (await w.conversation.faultView(runId, 0, 0)).head,
		(run) => run !== null && !["queued", "provisioning", "running"].includes(run.status),
		timeout,
	)) as RunHead;
}

async function eventsOf(w: World, runId: RunId): Promise<RunEvent[]> {
	return (await viewOf(w.conversation, runId)).events;
}

/** The run's facts, once the fake Laravel holds its `run.finished`. */
async function factsOf(w: World, runId: RunId): Promise<Fact[]> {
	const facts = await until(
		async () => fake.facts(w.conversationId),
		(all) => all.some((fact) => fact.type === "run.finished" && fact.run === runId),
	);
	return facts.filter((fact) => fact.run === runId);
}

const localToolFacts = (facts: Fact[]) => facts.flatMap((fact) => (fact.type === "run.local_tool" ? [fact.data] : []));
const finishedFact = (facts: Fact[]) => facts.find((fact) => fact.type === "run.finished")?.data;

/** The folder's current version, as Laravel reads it. */
function folderOf(w: World) {
	return commands.folder({ scope: w.within, conversation: w.conversationId, version: null });
}

function cards(events: RunEvent[]) {
	return events.filter((event) => event.type === "local_tool").map((event) => event.data as { tool: string; summary: string; ok: boolean; excerpt: string });
}

function phases(events: RunEvent[]): string[] {
	return events.filter((event) => event.type === "phase").map((event) => (event.data as { text: string }).text);
}

function restarts(events: RunEvent[]): number[] {
	return events.flatMap((event) => (event.type === "status" && "attempt" in event.data ? [event.data.attempt as number] : []));
}

/** Waits until the object logged that it reached a fault point. */
async function reached(w: World, point: string): Promise<void> {
	await until(
		async () => (await w.conversation.faultFired()).map((entry) => entry.point),
		(points) => points.includes(point),
	);
}

function cancel(w: World, runId: RunId) {
	return commands.cancelRun({ scope: w.within, conversation: w.conversationId, run: runId, reason: "cancelled" });
}

/**
 * From the run's start, which its section shows inside the lane before its wait, for 1 s while an earlier run's command is
 * held: no model call or tool execution, and no pi session, so no `run:<id>` submission.
 */
async function waits(w: World, runId: RunId): Promise<void> {
	await until(async () => phases(await eventsOf(w, runId)), (all) => all.includes("Starting the agent"));
	await sleep(1000);
	const run = await w.conversation.faultRun(runId);
	expect([run.entered, run.run?.session]).toEqual([{ model: 0, tool: 0 }, null]);
}

/**
 * The run completes in its first attempt, its first model call begun once the held run's `bash` task ended, on one clock. It
 * ran in the held run's pi session, the conversation's, and none of the held run's tasks is its.
 */
async function completesAfter(w: World, runId: RunId, held: RunId): Promise<void> {
	expect((await settled(w, runId)).status).toBe("completed");
	const run = await w.conversation.faultRun(runId);
	expect(run.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
	const earlier = await w.conversation.faultRun(held);
	const bash = earlier.piTasks.find((task) => task.kind === "pi.tool");
	expect(run.marks[0]?.begin).toBeGreaterThanOrEqual(bash?.endedAt ?? Number.POSITIVE_INFINITY);
	sharesSession(run, earlier);
}

/** The run's own input as pi placed it in the conversation's pi conversation. */
function inputOf(w: World, runId: RunId): Promise<string> {
	return runInDurableObject(w.conversation, (_instance, state) =>
		state.storage.sql
			.exec<{ text: string }>(
				"SELECT json_extract(entry.record, '$.model[0].content') AS text FROM pi_submissions AS submission JOIN pi_entries AS entry ON entry.id = json_extract(submission.record, '$.entry') WHERE submission.request_id = json_quote(?)",
				`run:${runId}`,
			)
			.one().text,
	);
}

/** Two runs of one conversation in one pi session, each with only its own tasks. */
function sharesSession(run: RunInternals, earlier: RunInternals): void {
	expect(run.run?.session).toEqual(expect.any(String));
	expect(run.run?.session).toBe(earlier.run?.session);
	expect(run.piTasks.length).toBeGreaterThan(0);
	expect(run.piTasks.filter((task) => earlier.piTasks.some((other) => other.id === task.id))).toEqual([]);
}

/** The console's warnings while `body` runs. */
async function warnings(body: (lines: () => string[]) => Promise<void>): Promise<void> {
	const warned = vi.spyOn(console, "warn");
	try {
		await body(() => warned.mock.calls.map((args) => args.map(String).join(" ")));
	} finally {
		warned.mockRestore();
	}
}

const call = (name: string, args: { [key: string]: unknown }): FakeTurn => ({ tools: [{ name, arguments: args as never }] });
const bash = (command: string) => call("bash", { command });
const DONE: FakeTurn = { text: "Done." };

describe("the local tools in the conversation", () => {
	test("write, edit, bash and read: held until saved, carded after, and the turn publishes the folder", async () => {
		const w = await world();
		const runId = await post(w, [
			call("write", { path: "notes.txt", content: "apples 3\n" }),
			call("edit", { path: "notes.txt", edits: [{ oldText: "3", newText: "4" }] }),
			bash("cat notes.txt"),
			call("read", { path: "notes.txt" }),
			DONE,
		]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(cards(events)).toEqual([
			{ tool: "write", summary: "notes.txt", ok: true, excerpt: "Successfully wrote to notes.txt" },
			{ tool: "edit", summary: "notes.txt", ok: true, excerpt: "Successfully replaced 1 block(s) in notes.txt." },
			{ tool: "bash", summary: "cat notes.txt", ok: true, excerpt: "apples 4\n" },
			{ tool: "read", summary: "notes.txt", ok: true, excerpt: "apples 4\n" },
		]);
		expect(phases(events)).toEqual(expect.arrayContaining(["Starting the agent", "Saving files", "Running commands", "Using tools", "Thinking"]));
		expect(phases(events)[0]).toBe("Starting the agent");
		// Three changing calls, three checkpoints (each after its strays were killed), none for the read, then the final rehash.
		const steps = w.sandbox.log.filter((line) => line === "kill" || line.startsWith("scan") || line.startsWith("checkpoint"));
		expect(steps).toEqual(["kill", "scan", "checkpoint 1", "kill", "scan", "checkpoint 1", "kill", "scan", "kill", "scan rehash"]);
		expect(w.sandbox.log[0]).toBe("start 1");
		expect(w.sandbox.log[1]).toBe("hydrate 0");
		expect(run.resultVersionId).not.toBeNull();
		expect(run.folderChanges).toMatchObject({ added: [{ path: "notes.txt", size: 9 }], counts: { added: 1 } });
		expect(run.folderWarnings).toEqual({ total: 0, items: [] });
		const folder = await folderOf(w);
		expect(folder).toMatchObject({ versionId: run.resultVersionId, files: [{ path: "notes.txt", size: 9 }] });
		// Laravel hears the same cards, and the folder the turn left.
		const facts = await factsOf(w, runId);
		expect(localToolFacts(facts)).toEqual(cards(events));
		expect(finishedFact(facts)).toMatchObject({ status: "completed", folder: { base: null, result: run.resultVersionId, changes: run.folderChanges, warnings: { total: 0, items: [] } } });
		// The run's container is destroyed when it ends.
		await until(async () => w.sandbox.log, (log) => log.some((line) => line.startsWith("destroy")));

		// The next turn starts from the folder; a turn that only reads saves nothing.
		const before = w.sandbox.log.length;
		const next = await post(w, [call("read", { path: "notes.txt" }), DONE]);
		const second = await settled(w, next);
		expect(second.status).toBe("completed");
		expect(cards(await eventsOf(w, next))).toEqual([{ tool: "read", summary: "notes.txt", ok: true, excerpt: "apples 4\n" }]);
		const log = w.sandbox.log.slice(before);
		expect(log.filter((line) => line.startsWith("scan") || line.startsWith("checkpoint"))).toEqual([]);
		expect(log).toContain("hydrate 1");
		expect([second.baseVersionId, second.resultVersionId, second.folderChanges]).toEqual([run.resultVersionId, run.resultVersionId, null]);
		expect(finishedFact(await factsOf(w, next))?.folder).toMatchObject({ base: run.resultVersionId, result: run.resultVersionId, changes: null });
	});

	test("the scan's warnings are published with the run", async () => {
		const w = await world();
		w.sandbox.faults.warnings = { total: 2, items: [{ path: "etc", reason: "symlink" }, { path: "pipe", reason: "special" }] };
		const runId = await post(w, [bash("put a.txt a"), DONE]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		expect(run.folderWarnings).toEqual({ total: 2, items: [{ path: "etc", reason: "symlink" }, { path: "pipe", reason: "special" }] });
		expect(finishedFact(await factsOf(w, runId))?.folder?.warnings).toEqual(run.folderWarnings);
	});

	test("a folder over its limits fails the turn with folder_limit and that limit's own message", async () => {
		const w = await world();
		w.sandbox.faults.limit = "folder_entries";
		const runId = await post(w, [bash("put a.txt a"), DONE]);
		const run = await settled(w, runId);
		expect([run.status, run.errorMessage]).toEqual(["failed", "The agent made more than the 10000 files and folders a conversation can keep."]);
		expect((await w.conversation.faultRun(runId)).run?.error_code).toBe("folder_limit");
		// No card: the call's result was never released; the folder stays as it was.
		expect(cards(await eventsOf(w, runId))).toEqual([]);
		expect(run.resultVersionId).toBeNull();
		// The reset that keeps the result from pi cuts the end's deferred clean-up: its retry was stored with
		// the end, and the next start destroys the container.
		expect((await w.conversation.faultJobs()).filter((job) => job.id === job.fn).map((job) => job.fn)).toContain("sandbox");
		await until(async () => w.sandbox.log, (log) => log.some((line) => line.startsWith("destroy")));

		const bytes = await world();
		bytes.sandbox.faults.limit = "folder_bytes";
		const over = await settled(bytes, await post(bytes, [bash("put a.txt a"), DONE]));
		expect(over.errorMessage).toBe("The agent's files grew past the 256 MiB a conversation can keep.");
	});

	test("a container that fails its hardening fails the turn", async () => {
		const w = await world();
		w.sandbox.faults.harden = "cgroup";
		const run = await settled(w, await post(w, [bash("put a.txt a"), DONE]));
		expect([run.status, run.errorMessage]).toEqual(["failed", "The agent could not finish this run. Try again."]);
	});

	test("a container that never starts ends each attempt that needs it, until worker_exited", async () => {
		const w = await world();
		w.sandbox.faults.start = true;
		const runId = await post(w, [bash("put a.txt a"), bash("put b.txt b"), bash("put c.txt c"), DONE]);
		const run = await settled(w, runId, 30_000);
		expect([run.status, run.errorMessage]).toEqual(["failed", "The worker stopped unexpectedly."]);
		expect(restarts(await eventsOf(w, runId))).toEqual([2, 3]);
	});

	test("a cancel stops the command and destroys the run's container", async () => {
		const w = await world();
		const runId = await post(w, [bash("hold"), DONE]);
		await until(async () => w.sandbox.holding, (holding) => holding === 1);
		await commands.cancelRun({ scope: w.within, conversation: w.conversationId, run: runId, reason: "cancelled" });
		const run = await settled(w, runId);
		expect(run.status).toBe("cancelled");
		await until(async () => w.sandbox.log, (log) => log.some((line) => line.startsWith("destroy")));
		expect(w.sandbox.holding).toBe(0);
		expect(cards(await eventsOf(w, runId))).toEqual([]);
	});

	test("a cancelled run's end marks its work that a command past its checkpoint holds, and the command's end ends it", async () => {
		const w = await world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }] });
		const runId = await post(w, [bash("echo hi"), DONE]);
		await until(
			async () => (await w.conversation.faultFired()).map((entry) => entry.point),
			(points) => points.includes("local:released"),
		);
		await commands.cancelRun({ scope: w.within, conversation: w.conversationId, run: runId, reason: "cancelled" });
		expect((await settled(w, runId)).status).toBe("cancelled");
		await until(
			async () => (await w.conversation.faultRun(runId)).piTasks,
			(tasks) => tasks.length === 2 && tasks.every((task) => task.abortRequested),
		);
		expect((await w.conversation.faultRun(runId)).piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "waiting", true],
			["pi.tool", "running", true],
		]);
		await w.conversation.faultRelease("local:released");
		const ended = await until(
			async () => (await w.conversation.faultRun(runId)).piTasks,
			(tasks) => tasks.every((task) => task.status === "terminal"),
		);
		expect(ended.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "terminal", true],
			["pi.tool", "terminal", true],
		]);
	});

	test("deleting the conversation answers only once a command past its checkpoint, which pi's abort does not end, has ended", async () => {
		const w = await world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }] });
		const runId = await post(w, [bash("echo hi"), DONE]);
		await until(
			async () => (await w.conversation.faultFired()).map((entry) => entry.point),
			(points) => points.includes("local:released"),
		);
		let answered = false;
		const deletion = commands.deleteConversation({ scope: w.within, conversation: w.conversationId }).finally(() => {
			answered = true;
		});
		await until(
			async () => (await w.conversation.faultRun(runId)).piTasks,
			(tasks) => tasks.length === 2 && tasks.every((task) => task.abortRequested),
		);
		await sleep(1000);
		expect(answered).toBe(false);
		expect((await w.conversation.faultRun(runId)).piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "waiting", true],
			["pi.tool", "running", true],
		]);
		await w.conversation.faultRelease("local:released");
		expect(await deletion).toEqual({ outcome: "deleted" });
		expect((await w.conversation.faultRun(runId)).piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "terminal", true],
			["pi.tool", "terminal", true],
		]);
	});

	test("a start waits until a cancelled run's command, which pi's abort does not end, has ended, then runs in its first attempt", async () => {
		const w = await world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }] });
		await warnings(async (lines) => {
			const a = await post(w, [bash("echo hi"), DONE]);
			await reached(w, "local:released");
			expect(await cancel(w, a)).toEqual({ state: "cancelled" });
			const b = await post(w, [DONE]);
			await waits(w, b);
			await w.conversation.faultRelease("local:released");
			await completesAfter(w, b, a);
			expect(lines()).toContainEqual(expect.stringContaining(`run ${a}'s call bash answered after the run ended; its result is refused (run ${b} acts now)`));
		});
	});

	test("a start whose wait passes the bound resets the object once, and runs in its first attempt in the next instance", async () => {
		const w = await world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }], piSettleMs: 2000 });
		await warnings(async (lines) => {
			const a = await post(w, [bash("echo hi"), DONE]);
			await reached(w, "local:released");
			expect(await cancel(w, a)).toEqual({ state: "cancelled" });
			const entered = (await w.conversation.faultRun(a)).entered;
			const b = await post(w, [DONE]);
			expect((await settled(w, b)).status).toBe("completed");
			const bound = `run ${b} could not start: pi's earlier work did not end within 2 s`;
			expect(lines().filter((line) => line.includes(bound))).toHaveLength(1);
			expect((await w.conversation.faultRun(b)).attempts).toEqual([{ attempt: 1, ended: "completed" }]);
			expect(restarts(await eventsOf(w, b))).toEqual([]);
			const left = await w.conversation.faultRun(a);
			expect(left.piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
				["pi.generation", "terminal", true],
				["pi.tool", "terminal", true],
			]);
			expect([entered, left.entered]).toEqual([
				{ model: 1, tool: 1 },
				{ model: 1, tool: 1 },
			]);
			sharesSession(await w.conversation.faultRun(b), left);
		});
	});

	test("a start cancelled while its section is queued resets nothing at its bound, and the section ahead of it goes on", async () => {
		const w = await world({ faults: [{ point: "loop:created", mode: "hold" }], piSettleMs: 2000 });
		await warnings(async (lines) => {
			const a = await post(w, [DONE]);
			await reached(w, "loop:created");
			expect(await cancel(w, a)).toEqual({ state: "cancelled" });
			const b = await post(w, [DONE]);
			expect(await cancel(w, b)).toEqual({ state: "cancelled" });
			await sleep(3000);
			expect(lines().filter((line) => line.includes("could not start"))).toEqual([]);
			const created = (await w.conversation.faultFired()).find((entry) => entry.point === "loop:created")?.detail;
			await w.conversation.faultRelease("loop:created");
			await until(async () => (await w.conversation.faultRun(a)).run?.session, (session) => session === created, 5000);
			const queued = await w.conversation.faultRun(b);
			expect([queued.run?.status, queued.run?.session, queued.entered]).toEqual(["cancelled", null, { model: 0, tool: 0 }]);
		});
	});

	test("a start cancelled while it waits configures nothing, the next start waits for the same command, and its input says the first was stopped and quotes the second", async () => {
		const w = await world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }] });
		const a = await post(w, [bash("echo hi"), DONE]);
		await reached(w, "local:released");
		expect(await cancel(w, a)).toEqual({ state: "cancelled" });
		const b = await post(w, [DONE]);
		await waits(w, b);
		expect(await cancel(w, b)).toEqual({ state: "cancelled" });
		const c = await post(w, [DONE]);
		await waits(w, c);
		await w.conversation.faultRelease("local:released");
		await completesAfter(w, c, a);
		const cancelled = await w.conversation.faultRun(b);
		expect([cancelled.run?.status, cancelled.run?.session, cancelled.entered, cancelled.piTasks]).toEqual(["cancelled", null, { model: 0, tool: 0 }, []]);
		// pi had a's message but never b's: c's input says a was stopped, then quotes b, then is c's own.
		const message = JSON.stringify({ fake: { turns: [DONE] } });
		const sent = expect.stringMatching(/^\[The user sent this message on .+ UTC\.\]$/);
		expect((await inputOf(w, c)).split("\n\n")).toEqual([
			"[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]",
			"[The user sent a message that was stopped before you saw it. It said:]",
			message,
			sent,
			QUOTE_END,
			message,
			sent,
		]);
	});
});

describe("fault rows: Checkpoints", () => {
	test("a crash between the upload and the record: the next attempt starts from the last checkpoint, without the file", async () => {
		const w = await world({ faults: [{ point: "checkpoint:uploaded", mode: "abort" }] });
		const runId = await post(w, [bash("put a.txt a"), bash("cat a.txt"), DONE]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		// The first command's result was never released, so pi reports it as interrupted and it has no card.
		expect(cards(events)).toEqual([{ tool: "bash", summary: "cat a.txt", ok: false, excerpt: "cat: a.txt: No such file or directory\n\n\nCommand exited with code 1" }]);
		expect(w.sandbox.log.filter((line) => line.startsWith("start") || line.startsWith("hydrate"))).toEqual(["start 1", "hydrate 0", "start 2", "hydrate 0"]);
		expect(run.resultVersionId).toBeNull();
	});

	test("a crash between the record and the release, and between the release and pi's commit, keep the checkpoint", async () => {
		for (const point of ["checkpoint:recorded", "local:released"]) {
			const w = await world({ faults: [{ point, mode: "abort" }] });
			const runId = await post(w, [bash("put a.txt a"), bash("cat a.txt"), DONE]);
			const run = await settled(w, runId);
			expect(run.status, point).toBe("completed");
			const events = await eventsOf(w, runId);
			expect(restarts(events), point).toEqual([2]);
			// Attempt 2 hydrates the checkpoint attempt 1 recorded: the file is there. A card is appended when its
			// call is released, so one released before the crash has its card although pi reports it interrupted.
			const cat = { tool: "bash", summary: "cat a.txt", ok: true, excerpt: "a" };
			expect(cards(events), point).toEqual(point === "local:released" ? [{ tool: "bash", summary: "put a.txt a", ok: true, excerpt: "" }, cat] : [cat]);
			expect(w.sandbox.log.filter((line) => line.startsWith("start") || line.startsWith("hydrate")), point).toEqual(["start 1", "hydrate 0", "start 2", "hydrate 1"]);
			expect(run.folderChanges, point).toMatchObject({ added: [{ path: "a.txt", size: 1 }] });
		}
	});

	test("a failed upload ends the attempt before the result reaches pi", async () => {
		const w = await world();
		w.sandbox.faults.upload = true;
		const runId = await post(w, [bash("put a.txt a"), DONE]);
		// The attempt ends; the next one is told the command was interrupted, and the model answers.
		const run = await settled(w, runId, 30_000);
		expect([run.status, run.errorMessage]).toEqual(["completed", ""]);
		expect(restarts(await eventsOf(w, runId))).toEqual([2]);
		expect(cards(await eventsOf(w, runId))).toEqual([]);
	});
});
