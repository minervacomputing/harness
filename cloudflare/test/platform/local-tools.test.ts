// The local tools in the real Conversation Durable Object, in local workerd (ARCHITECTURE.md: Checkpoints, The local
// tools), as Laravel's commands reach it (startRun, cancelRun and folder through the internal mount) with the fake Laravel:
// PiHarness with the fake model calling pi's read, write, edit and bash, the folder's store on the object's SQLite and the
// EU bucket, and a conversation's container played by test/platform/sandbox-memory.ts (local workerd has no containers).
// Covered: results held until a checkpoint saved them and their cards after, phases, the final rehash, the folder version
// published with the run's changes and warnings, a turn that only reads, the run's container destroyed at its end, a cancelled
// run's end marking the work of a command pi's abort does not end, a deletion that waits for such a command, a folder over its
// limits (folder_limit and its message), a container that fails its hardening (worker_failed) or never starts (attempts until
// worker_exited), and crashes between a checkpoint's upload and its record, its record and the release, and the release and
// pi's commit (the Checkpoints row of ARCHITECTURE.md's Testing table), each resumed from the last checkpoint.

import { env } from "cloudflare:workers";
import type { RunEvent } from "@minerva/contract";
import type { Fact, Scope } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { filesBucket } from "../../src/addressing.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import type { Conversation } from "../../src/faults/index.ts";
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

async function world(options: { faults?: Fault[] } = {}): Promise<World> {
	const within = scope();
	const conversationId = uuid7();
	const sandbox = new MemorySandbox(() => filesBucket(env, { id: within.workspace, jurisdiction: "eu" }));
	SANDBOXES.set(conversationId, sandbox);
	const conversation = () => objectOf({ scope: within, conversation: conversationId });
	if (options.faults) await conversation().faultPlan(options.faults);
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
