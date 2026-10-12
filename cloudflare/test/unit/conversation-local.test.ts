// The checkpoint barrier and the local tools (src/conversation/local.ts), ported case by case from
// worker/test/local-tools.test.ts (harness 18, "LocalCalls and the gated wrapper", "Local tools"): results
// held until a checkpoint saved them, read-only rounds without one, a failed checkpoint ending the attempt
// before any result is released, the watchdog, the chat's cards, the bash tool's environment and timeouts,
// and the fixed order. The file tools run against pi's own Node environment in a temporary directory; the
// container's (minerva-fs, FIFOs, the stray killer) is test/unit/conversation-local-docker.test.ts's.

import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localToolEvent } from "../../src/conversation/events.ts";
import {
	COMMAND_TIMEOUT_S,
	gated,
	LOCAL_TOOLS,
	LocalCalls,
	type LocalTool,
	type LocalToolEvent,
	LocalToolStuck,
	localToolSpecs,
	localTools,
	OUT_OF_TIME,
	STRAYS_KILL_MS,
} from "../../src/conversation/local.ts";
import { HOME } from "../../src/sandbox/constants.ts";

interface NodeModules {
	getBuiltinModule(id: "node:fs"): {
		mkdtempSync(prefix: string): string;
		rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
		readFileSync(path: string, encoding: "utf8"): string;
	};
	getBuiltinModule(id: "node:os"): { tmpdir(): string };
	env: { [name: string]: string | undefined };
}
const node = (globalThis as unknown as { process: NodeModules }).process;
const fs = node.getBuiltinModule("node:fs");

const realTimeout = globalThis.setTimeout;
/** Lets pending callbacks run; a real timer, so it works while timers are faked. */
const tick = () => new Promise<void>((resolve) => realTimeout(resolve, 0));

type Context = Parameters<ToolRegistration["execute"]>[2];
function contextOf(signal?: AbortSignal): Context {
	return { abortSignal: signal, value: () => undefined, toString: () => "[Context test]" } as unknown as Context;
}
const context = contextOf();

const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(`${node.getBuiltinModule("node:os").tmpdir()}/local-tools-test-`);
	dirs.push(dir);
	return dir;
}

async function state(promise: Promise<unknown>): Promise<"pending" | "fulfilled" | "rejected"> {
	let result: "pending" | "fulfilled" | "rejected" = "pending";
	promise.then(
		() => (result = "fulfilled"),
		() => (result = "rejected"),
	);
	await tick();
	return result;
}

interface Fixture {
	calls: LocalCalls;
	log: string[];
	checkpoints: { options: { rehashAll?: boolean }; done: PromiseWithResolvers<void> }[];
	events: LocalToolEvent[];
	failures: Error[];
}

/** Local calls whose checkpoints wait to be let through, unless `auto`. */
function fixture(options: { auto?: boolean; killStrays?: () => Promise<void> } = {}): Fixture {
	const f: Omit<Fixture, "calls"> = { log: [], checkpoints: [], events: [], failures: [] };
	const calls = new LocalCalls({
		checkpoint(checkpointOptions) {
			const done = Promise.withResolvers<void>();
			f.checkpoints.push({ options: checkpointOptions, done });
			f.log.push("checkpoint");
			if (options.auto) done.resolve();
			return done.promise;
		},
		killStrays:
			options.killStrays ??
			(async () => {
				f.log.push("kill");
			}),
		fail(error) {
			f.log.push("fail");
			f.failures.push(error);
		},
		report: (event) => f.events.push(event),
		saving: (active) => f.log.push(active ? "saving" : "saved"),
	});
	return { ...f, calls };
}

function api(env: ExecutionEnv | undefined, outputs: string[] = []): ToolExecutionApi {
	return {
		env,
		outputWindow: undefined,
		output(chunk: string | Uint8Array) {
			outputs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		},
		diagnostic() {},
	} as unknown as ToolExecutionApi;
}

function fakeTool(execute: (api: ToolExecutionApi) => Promise<ToolExecutionResult>): LocalTool {
	return {
		name: "bash",
		changes: true,
		tool: { name: "bash", description: "", parameters: {}, execute: (_args: unknown, given: ToolExecutionApi) => execute(given) } as unknown as ToolRegistration,
		summary: (args) => String(args.command),
		plan: (args) => ({ args, stuckMs: 1000 }),
	};
}

function byName(tools: ToolRegistration[]): { [name: string]: ToolRegistration } {
	return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

describe("LocalCalls", () => {
	test("holds results until a checkpoint has saved what the calls did", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		await f.calls.admit(undefined, false);
		const first = f.calls.release();
		await tick();
		// Another call still runs.
		expect(f.checkpoints.length).toBe(0);
		const second = f.calls.release();
		await tick();
		expect(f.log).toEqual(["saving", "kill", "checkpoint"]);
		expect(await state(first)).toBe("pending");

		// A call that arrives during the checkpoint starts after it.
		const third = f.calls.admit(undefined, true);
		expect(await state(third)).toBe("pending");
		f.checkpoints[0]?.done.resolve();
		await Promise.all([first, second, third]);
		expect(f.log).toEqual(["saving", "kill", "checkpoint", "saved"]);

		const last = f.calls.release();
		await tick();
		expect(f.checkpoints.length).toBe(2);
		expect(await state(last)).toBe("pending");
		f.checkpoints[1]?.done.resolve();
		await last;
	});

	test("calls that only read need no checkpoint", async () => {
		const f = fixture();
		await f.calls.admit(undefined, false);
		await f.calls.release();
		await f.calls.finish();
		expect(f.log).toEqual([]);
	});

	test("a failed checkpoint fails the attempt before any result is released", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		const held = f.calls.release();
		let failedFirst = false;
		held.catch(() => {
			failedFirst = f.failures.length === 1;
		});
		await tick();
		f.checkpoints[0]?.done.reject(new Error("lost"));
		await expect(held).rejects.toThrow(/lost/);
		expect(failedFirst).toBe(true);
		await expect(f.calls.admit(undefined, false)).rejects.toThrow(/lost/);
		await expect(f.calls.finish()).rejects.toThrow(/lost/);
		expect(f.failures.length).toBe(1);
	});

	test("a call waiting for a checkpoint can be aborted, and is not counted", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		const held = f.calls.release();
		await tick();
		const controller = new AbortController();
		const waiting = f.calls.admit(controller.signal, true);
		controller.abort(new Error("stop"));
		await expect(waiting).rejects.toThrow(/stop/);
		f.checkpoints[0]?.done.resolve();
		await held;

		await f.calls.admit(undefined, false);
		expect(await state(f.calls.release())).toBe("fulfilled");
	});

	test("finish saves once more, rehashing every file, when a call may have changed the folder", async () => {
		const f = fixture({ auto: true });
		await f.calls.admit(undefined, true);
		await f.calls.release();
		await f.calls.finish();
		expect(f.checkpoints.map((checkpoint) => checkpoint.options)).toEqual([{}, { rehashAll: true }]);
	});

	test("held results and later calls wait until the attempt's failure has been handled", async () => {
		const handled = Promise.withResolvers<void>();
		const order: string[] = [];
		const calls = new LocalCalls({
			checkpoint: async () => {
				throw new Error("over");
			},
			killStrays: async () => {},
			fail: async () => {
				order.push("fail");
				await handled.promise;
				order.push("handled");
			},
			report: () => {},
		});
		await calls.admit(undefined, true);
		const held = calls.release().catch((error: Error) => order.push(`held:${error.message}`));
		const later = calls.admit(undefined, false).catch((error: Error) => order.push(`admit:${error.message}`));
		await tick();
		expect(order).toEqual(["fail"]);
		handled.resolve();
		await Promise.all([held, later]);
		expect(order).toEqual(["fail", "handled", "held:over", "admit:over"]);
	});

	test("the final checkpoint runs once, however often the turn's end is reconciled", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		const held = f.calls.release();
		await tick();
		f.checkpoints[0]?.done.resolve();
		await held;
		const one = f.calls.finish();
		const two = f.calls.finish();
		await tick();
		expect(f.checkpoints.map((checkpoint) => checkpoint.options)).toEqual([{}, { rehashAll: true }]);
		f.checkpoints[1]?.done.resolve();
		await Promise.all([one, two]);
		expect(f.checkpoints.length).toBe(2);
	});

	test("the final checkpoint waits for a call still running and the checkpoint it asks for, never overlapping them", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		const finished = f.calls.finish();
		await tick();
		// The call (an aborted one whose command outlived pi's wait) still runs: no scan meets it.
		expect(f.checkpoints).toEqual([]);
		const held = f.calls.release();
		await tick();
		expect(f.checkpoints.map((checkpoint) => checkpoint.options)).toEqual([{}]);
		f.checkpoints[0]?.done.resolve();
		await held;
		await tick();
		expect(f.checkpoints.map((checkpoint) => checkpoint.options)).toEqual([{}, { rehashAll: true }]);
		f.checkpoints[1]?.done.resolve();
		await finished;
	});

	test("a call stuck while the final checkpoint waits for it ends the attempt", async () => {
		const f = fixture();
		await f.calls.admit(undefined, true);
		const finished = f.calls.finish();
		await tick();
		f.calls.stuck(new LocalToolStuck("stuck"));
		await expect(finished).rejects.toBeInstanceOf(LocalToolStuck);
		expect(f.checkpoints).toEqual([]);
	});

	test("a stuck call ends the attempt", async () => {
		const f = fixture();
		f.calls.stuck(new LocalToolStuck("stuck"));
		expect(f.failures[0]).toBeInstanceOf(LocalToolStuck);
		await expect(f.calls.admit(undefined, false)).rejects.toBeInstanceOf(LocalToolStuck);
	});
});

describe("gated", () => {
	test("reports a call once its result is released, cut to fit the chat", async () => {
		const f = fixture({ auto: true });
		const tool = gated(
			f.calls,
			fakeTool(async (given) => {
				given.output("a".repeat(5000));
				given.output("END");
				return {};
			}),
		);
		const nul = String.fromCharCode(0);
		const lone = String.fromCharCode(0xd800);
		await tool.execute({ command: `${nul}${lone}${"c".repeat(400)}` }, api(undefined), context);
		const [event] = f.events;
		expect(event?.ok).toBe(true);
		expect(Array.from(event?.summary ?? "").length).toBe(300);
		expect(event?.summary.startsWith("�")).toBe(true);
		expect(event?.summary.endsWith("c…")).toBe(true);
		expect(event?.excerpt.length).toBe(2000);
		expect(event?.excerpt.startsWith("…a")).toBe(true);
		expect(event?.excerpt.endsWith("aEND")).toBe(true);
		// Appending cuts nothing more: the card is already within its limits.
		expect(localToolEvent("bash", event?.summary ?? "", true, event?.excerpt ?? "")).toEqual({ type: "local_tool", data: event });
	});

	test("characters are code points: an astral excerpt keeps whole characters", async () => {
		const f = fixture({ auto: true });
		const smile = "\u{1f600}";
		await gated(
			f.calls,
			fakeTool(async (given) => {
				given.output(smile.repeat(3000));
				return {};
			}),
		).execute({ command: smile.repeat(400) }, api(undefined), context);
		const [event] = f.events;
		expect(Array.from(event?.summary ?? "")).toHaveLength(300);
		expect(event?.summary).toBe(`${smile.repeat(299)}…`);
		expect(event?.excerpt).toBe(`…${smile.repeat(1999)}`);
	});

	test("a failed call is reported with its error", async () => {
		const f = fixture({ auto: true });
		const tool = gated(
			f.calls,
			fakeTool(async () => {
				throw new Error("Command exited with code 3");
			}),
		);
		await expect(tool.execute({ command: "exit 3" }, api(undefined), context)).rejects.toThrow(/code 3/);
		expect(f.events).toEqual([{ tool: "bash", summary: "exit 3", ok: false, excerpt: "Command exited with code 3" }]);
	});

	test("a failed call's output comes before its error", async () => {
		const f = fixture({ auto: true });
		const tool = gated(
			f.calls,
			fakeTool(async (given) => {
				given.output("partial\n");
				throw new Error("Command timed out after 1 seconds");
			}),
		);
		await expect(tool.execute({ command: "sleep 9" }, api(undefined), context)).rejects.toThrow(/timed out/);
		expect(f.events[0]?.excerpt).toBe("partial\n\n\nCommand timed out after 1 seconds");
	});

	test("an aborted call stops waiting for its result, which is still saved", async () => {
		const f = fixture();
		const controller = new AbortController();
		const tool = gated(
			f.calls,
			fakeTool(async () => ({ content: [] })),
		);
		const call = tool.execute({ command: "x" }, api(undefined), contextOf(controller.signal));
		await tick();
		expect(f.checkpoints.length).toBe(1);
		controller.abort(new Error("stop"));
		await expect(call).rejects.toThrow(/stop/);
		expect(f.events).toEqual([]);
		f.checkpoints[0]?.done.resolve();
	});

	test("a call that does not settle in time has strays killed, then ends the attempt", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture();
		const never = Promise.withResolvers<ToolExecutionResult>();
		const tool = gated(
			f.calls,
			fakeTool(() => never.promise),
		);
		void tool.execute({ command: "x" }, api(undefined), context).catch(() => {});
		await tick();
		vi.advanceTimersByTime(999);
		await tick();
		expect(f.log).toEqual([]);
		vi.advanceTimersByTime(1);
		await tick();
		expect(f.log).toEqual(["kill"]);
		vi.advanceTimersByTime(10_000);
		expect(f.log).toEqual(["kill", "fail"]);
		expect(f.failures[0]).toBeInstanceOf(LocalToolStuck);
		expect(f.failures[0]?.message).toBe("A bash call did not stop.");
	});

	test("a kill that never answers ends the attempt", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture({ killStrays: () => new Promise(() => {}) });
		const never = Promise.withResolvers<ToolExecutionResult>();
		void gated(
			f.calls,
			fakeTool(() => never.promise),
		)
			.execute({ command: "x" }, api(undefined), context)
			.catch(() => {});
		await tick();
		vi.advanceTimersByTime(1000);
		await tick();
		vi.advanceTimersByTime(STRAYS_KILL_MS - 1);
		await tick();
		expect(f.failures).toEqual([]);
		vi.advanceTimersByTime(1);
		await tick();
		expect(f.failures.length).toBe(1);
		expect(f.failures[0]).toBeInstanceOf(LocalToolStuck);
		expect(f.failures[0]?.message).toBe("Processes left by commands could not be stopped.");
	});

	test("a call that settles while strays are killed is not stuck", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const killing = Promise.withResolvers<void>();
		const f = fixture({ auto: true, killStrays: () => killing.promise });
		const result = Promise.withResolvers<ToolExecutionResult>();
		const tool = gated(
			f.calls,
			fakeTool(() => result.promise),
		);
		const call = tool.execute({ command: "x" }, api(undefined), context);
		await tick();
		vi.advanceTimersByTime(1000);
		result.resolve({ content: [{ type: "text", text: "done" }] });
		await tick();
		killing.resolve();
		await call;
		vi.advanceTimersByTime(20_000);
		await tick();
		expect(f.failures).toEqual([]);
		expect(f.events.map((event) => [event.ok, event.excerpt])).toEqual([[true, "done"]]);
	});

	test("no call is admitted while strays are killed, since its command would die with them", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const killing = Promise.withResolvers<void>();
		const f = fixture({ auto: true, killStrays: () => killing.promise });
		const slow = Promise.withResolvers<ToolExecutionResult>();
		void gated(
			f.calls,
			fakeTool(() => slow.promise),
		).execute({ command: "slow" }, api(undefined), context);
		await tick();
		vi.advanceTimersByTime(1000);
		let started = false;
		const next = gated(
			f.calls,
			fakeTool(async () => {
				started = true;
				return {};
			}),
		).execute({ command: "next" }, api(undefined), context);
		await tick();
		expect(started).toBe(false);
		slow.resolve({ content: [] });
		killing.resolve();
		await next;
		expect(started).toBe(true);
		expect(f.failures).toEqual([]);
	});

	test("processes that cannot be stopped end the attempt, even if the call settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const killing = Promise.withResolvers<void>();
		const f = fixture({ auto: true, killStrays: () => killing.promise });
		const slow = Promise.withResolvers<ToolExecutionResult>();
		const call = gated(
			f.calls,
			fakeTool(() => slow.promise),
		).execute({ command: "slow" }, api(undefined), context);
		await tick();
		vi.advanceTimersByTime(1000);
		const next = f.calls.admit(undefined, false);
		slow.resolve({ content: [] });
		killing.reject(new LocalToolStuck("Processes left by commands could not be stopped."));
		await expect(next).rejects.toBeInstanceOf(LocalToolStuck);
		await expect(call).rejects.toBeInstanceOf(LocalToolStuck);
		expect(f.failures.length).toBe(1);
	});
});

describe("localTools", () => {
	test("reads, writes and edits files, checkpointing only after changes", async () => {
		const root = tempDir();
		const f = fixture({ auto: true });
		const tools = byName(localTools({ names: LOCAL_TOOLS, calls: f.calls, deadline: null }));
		const env = new NodeExecutionEnv({ cwd: root });
		await tools.write?.execute({ path: "notes.txt", content: "apples 3\n" }, api(env), context);
		await tools.edit?.execute({ path: "notes.txt", edits: [{ oldText: "3", newText: "4" }] }, api(env), context);
		expect(fs.readFileSync(`${root}/notes.txt`, "utf8")).toBe("apples 4\n");
		const read = await tools.read?.execute({ path: "notes.txt" }, api(env), context);
		expect(JSON.stringify(read?.content)).toMatch(/apples 4/);
		expect(f.events.map((event) => [event.tool, event.summary, event.ok])).toEqual([
			["write", "notes.txt", true],
			["edit", "notes.txt", true],
			["read", "notes.txt", true],
		]);
		expect(f.checkpoints.length).toBe(2);
	});

	test("commands get a fixed environment, never the Worker's", async () => {
		const root = tempDir();
		const f = fixture({ auto: true });
		const tools = byName(localTools({ names: ["bash"], calls: f.calls, deadline: null }));
		node.env.MINERVA_TEST_SECRET = "secret";
		const outputs: string[] = [];
		try {
			await tools.bash?.execute({ command: 'echo "home=$HOME secret=$MINERVA_TEST_SECRET"' }, api(new NodeExecutionEnv({ cwd: root }), outputs), context);
		} finally {
			delete node.env.MINERVA_TEST_SECRET;
		}
		expect(outputs.join("")).toBe(`home=${HOME} secret=\n`);
		expect(f.events[0]?.excerpt).toBe(`home=${HOME} secret=\n`);
	});

	test("a command stops after 10 minutes by default, and before the turn's deadline", async () => {
		const root = tempDir();
		const f = fixture({ auto: true });
		const env = new NodeExecutionEnv({ cwd: root });
		const tools = byName(localTools({ names: ["bash"], calls: f.calls, deadline: Date.now() + 1500 }));
		const timeout = (tools.bash?.parameters as unknown as { properties: { timeout: { description: string } } }).properties.timeout;
		expect(timeout.description).toBe(`Timeout in seconds (optional, ${COMMAND_TIMEOUT_S} by default)`);
		await expect(tools.bash?.execute({ command: "sleep 5", timeout: 100 }, api(env), context)).rejects.toThrow(/timed out after 1 seconds/);

		const late = byName(localTools({ names: ["bash"], calls: f.calls, deadline: Date.now() - 1 }));
		await expect(late.bash?.execute({ command: "true" }, api(env), context)).rejects.toThrow(/run out of time/);
		expect(f.events.map((event) => [event.ok, event.excerpt]).at(-1)).toEqual([false, OUT_OF_TIME]);
		// The refused call was let go.
		await f.calls.admit(undefined, false);
		await f.calls.release();
	});

	test("a command that waited for a checkpoint is given only the time left after it", async () => {
		const root = tempDir();
		const f = fixture();
		let clock = 0;
		const tools = byName(localTools({ names: ["bash"], calls: f.calls, deadline: 100_000, now: () => clock }));
		await f.calls.admit(undefined, true);
		const held = f.calls.release();
		await tick();
		const call = expect(tools.bash?.execute({ command: "sleep 5" }, api(new NodeExecutionEnv({ cwd: root })), context)).rejects.toThrow(/timed out after 1 seconds/);
		await tick();
		clock = 98_500;
		f.checkpoints[0]?.done.resolve();
		await held;
		while (f.checkpoints.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
		f.checkpoints[1]?.done.resolve();
		await call;
	});

	test("only the run's tools are offered, in a fixed order; read alone is replayed", () => {
		const f = fixture();
		const tools = localTools({ names: ["bash", "read", "unknown"], calls: f.calls, deadline: null });
		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
		expect(localToolSpecs({ deadline: null }).map((local) => [local.name, local.tool.replay ?? "unsafe", local.tool.executionMode ?? "parallel", local.changes])).toEqual([
			["read", "safe", "parallel", false],
			["write", "unsafe", "parallel", true],
			["edit", "unsafe", "parallel", true],
			["bash", "unsafe", "parallel", true],
		]);
	});

	test("the stuck limits: a command's timeout plus a minute, 120 s for the file tools and for an invalid timeout", () => {
		const [read, , , bash] = localToolSpecs({ deadline: null });
		expect(read?.plan({ path: "x" }).stuckMs).toBe(120_000);
		expect(bash?.plan({ command: "x" })).toEqual({ args: { command: "x", timeout: 600 }, stuckMs: 660_000 });
		expect(bash?.plan({ command: "x", timeout: 5 }).stuckMs).toBe(65_000);
		expect(bash?.plan({ command: "x", timeout: -1 })).toEqual({ args: { command: "x", timeout: -1 }, stuckMs: 120_000 });
	});
});
