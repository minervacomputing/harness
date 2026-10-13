// One `run_script` from the conversation's side (src/scripts/run.ts) with the real session, the run's
// real queue and the guest's prelude in a realm of its own, behind a Scripts object in Node
// (scripts-support.ts): the wall clock, pi's abort, refusals, the reset after every script and the lane
// the next script waits in, cancelled calls, and writes that settle after their script stopped.

import { describe, expect, test } from "vitest";
import { ToolQueue } from "../../src/conversation/queue.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../../src/gateway/executor.ts";
import type { Json } from "../../src/lib/json.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { executeScript, type ExecuteOptions, remainingMs, resetScripts, ScriptLane, scriptCpuMs, scriptTimeoutMs } from "../../src/scripts/run.ts";
import type { ScriptFence } from "../../src/scripts/scripts.ts";
import { ScriptCalls, type ScriptSession } from "../../src/scripts/session.ts";
import { declaration, FakeScripts, ok } from "./scripts-support.ts";

const TOOLS = new Map<string, ToolDeclaration>([
	["list_things", declaration("list_things")],
	["slow", declaration("slow")],
	["save_thing", declaration("save_thing", true)],
	["never", declaration("never")],
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Lab {
	scripts: FakeScripts;
	lane: ScriptLane;
	calls: ScriptCalls;
	log: string[];
	waits: Promise<unknown>[];
	sessions: ScriptSession[];
	run(code: string, options?: Partial<ExecuteOptions>): ReturnType<typeof executeScript>;
}

/** A conversation's side: tools that answer after a while, through the run's queue, with a log of what they did. */
function lab(): Lab {
	const scripts = new FakeScripts();
	const lane = new ScriptLane();
	const calls = new ScriptCalls();
	const queue = new ToolQueue();
	const log: string[] = [];
	const waits: Promise<unknown>[] = [];
	const sessions: ScriptSession[] = [];
	const runId = uuid7();
	const tool = async (name: string, args: Json | undefined): Promise<ToolCallOutcome> => {
		const n = (args as { n?: number } | undefined)?.n ?? 0;
		log.push(`${name}:start:${n}`);
		if (name === "never") await new Promise(() => {});
		if (name === "slow" || name === "save_thing") await sleep(150);
		log.push(`${name}:end:${n}`);
		return ok([{ n }]);
	};
	return {
		scripts,
		lane,
		calls,
		log,
		waits,
		sessions,
		run: (code, options = {}) => {
			const fence: ScriptFence = { runId, attempt: 1, scriptId: uuid7() };
			return executeScript({
				fence,
				code,
				tools: TOOLS,
				store: [],
				timeoutMs: 2000,
				cpuMs: 2000,
				calls,
				port: {
					invoke: (declaration, args, drop) => {
						const call = queue.send(declaration.annotations.readOnlyHint !== true, () => tool(declaration.name, args), () => drop.throwIfAborted());
						// As `#invoke` records each call's outcome when it settles, whoever still waits.
						waits.push(call.then((outcome) => log.push(`${declaration.name}:recorded:${outcome.ok}`), () => log.push(`${declaration.name}:dropped`)));
						return call;
					},
				},
				scripts: () => scripts,
				lane,
				targets: (session) => ({ tools: session, control: { stopped: async () => void (await session.stopped()) } }),
				waitUntil: (promise) => waits.push(promise),
				onSession: (session) => sessions.push(session),
				...options,
			});
		},
	};
}

describe("a script and its result", () => {
	test("calls through the queue, output, the value and the store's writes", async () => {
		const l = lab();
		const result = await l.run("const pages = await Promise.all([1, 2, 3, 4, 5].map((n) => tools.slow({ n }))); text('done'); store('k', pages.length); return pages.map((p) => p.items[0].n)");
		expect(result).toEqual({ ok: true, value: { text: "[1,2,3,4,5]" }, output: [{ text: "done" }], cancelled: 0, storeWrites: { set: [["k", "5"]], delete: [] } });
		// Four at once: the fifth started when the first ended.
		expect(l.log.indexOf("slow:start:5")).toBeGreaterThan(l.log.indexOf("slow:end:1"));
		expect(l.scripts.runs[0]?.request.tools).toEqual([
			{ name: "list_things", identifier: "list_things" },
			{ name: "slow", identifier: "slow" },
			{ name: "save_thing", identifier: "save_thing" },
			{ name: "never", identifier: "never" },
		]);
		await Promise.all(l.waits);
		expect(l.scripts.resets.length).toBe(1);
	});

	test("a syntax error fails before anything is loaded", async () => {
		const l = lab();
		const result = await l.run("const a = ;");
		expect(result).toEqual({ ok: false, error: { kind: "script", message: "Unexpected token (1:10)", stack: "SyntaxError: Unexpected token (1:10)" }, output: [], cancelled: 0, storeWrites: { set: [], delete: [] } });
		expect(l.scripts.runs).toEqual([]);
	});

	test("calls the script did not wait for are reported as cancelled", async () => {
		const l = lab();
		const result = await l.run("tools.never({}); tools.never({}); return 'returned'");
		expect(result).toMatchObject({ ok: true, value: { text: "returned" }, cancelled: 2 });
	});
});

describe("the wall clock and the stops", () => {
	test("a script past its wall clock times out at once; the write it was waiting for settles and is recorded", async () => {
		const l = lab();
		const started = Date.now();
		const result = await l.run("text('start'); await tools.save_thing({ n: 1 }); text('never')", { timeoutMs: 50 });
		expect(Date.now() - started).toBeLessThan(140);
		expect(result).toEqual({ ok: false, error: { kind: "timeout", message: "Execution timed out after 50 ms" }, output: [{ text: "start" }], cancelled: 1, storeWrites: { set: [], delete: [] } });
		expect(l.log).toEqual(["save_thing:start:1"]);
		await Promise.all(l.waits);
		await sleep(10);
		expect(l.log).toEqual(["save_thing:start:1", "save_thing:end:1", "save_thing:recorded:true"]);
		expect(l.scripts.resets.length).toBe(1);
		// The stopped guest's later calls never reach the queue.
		expect(l.calls.open).toBe(0);
	});

	test("pi's abort stops the script with its reason", async () => {
		const l = lab();
		const controller = new AbortController();
		const running = l.run("await tools.never({})", { signal: controller.signal });
		await sleep(20);
		controller.abort(new Error("Stopped."));
		expect(await running).toMatchObject({ ok: false, error: { kind: "aborted", message: "Stopped." }, cancelled: 1 });
		const already = await l.run("return 1", { signal: AbortSignal.abort("no error") });
		expect(already.error).toEqual({ kind: "aborted", message: "Execution aborted" });
	});

	test("a script that keeps making calls that cannot run is stopped after 100 refusals", async () => {
		const l = lab();
		const result = await l.run("for (let i = 0; i < 1000; i++) { try { await tools.list_things({ n: 'x'.repeat(300 * 1024) }) } catch {} } return 'never'");
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "The script kept making tool calls that could not run." }, cancelled: 0 });
		expect(l.log).toEqual([]);
	});

	test("a Scripts object that fails is a sandbox failure; a stale one answers that the run ended", async () => {
		const l = lab();
		const failing = await l.run("return 1", {
			scripts: () => ({ run: async () => Promise.reject(new Error("Network connection lost.")), reset: async () => ({ reset: true as const }) }),
		});
		expect(failing.error).toEqual({ kind: "sandbox", message: "Sandbox host failed: Network connection lost." });
		const stale = await l.run("return 1", { scripts: () => ({ run: async () => ({ refused: "stale" as const }), reset: async () => ({ refused: "stale" as const }) }) });
		expect(stale.error).toEqual({ kind: "aborted", message: "This run is no longer active." });
	});
});

describe("the reset after every script and the lane", () => {
	test("the next script waits for the previous one's reset", async () => {
		const l = lab();
		l.scripts.resetDelayMs = 200;
		await l.run("return 1");
		const started = Date.now();
		const second = await l.run("return 2");
		expect(second.value).toEqual({ text: "2" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		expect(l.scripts.resets.length).toBe(2);
	});

	test("waiting for the reset counts against the next script's wall clock", async () => {
		const l = lab();
		l.scripts.resetDelayMs = 300;
		await l.run("return 1");
		const second = await l.run("return 2", { timeoutMs: 50 });
		expect(second.error).toEqual({ kind: "timeout", message: "Execution timed out after 50 ms" });
		// It never ran.
		expect(l.scripts.runs.length).toBe(1);
	});

	test("a stopped script is reset at once, not when its guest answers", async () => {
		const l = lab();
		await l.run("for (;;) await new Promise((resolve) => setTimeout(resolve, 5))", { timeoutMs: 30 });
		await sleep(5);
		expect(l.scripts.resets.length).toBe(1);
	});

	test("a reset that failed three times is tried again by the next script before it runs", async () => {
		const l = lab();
		l.scripts.failResets = 3;
		await l.run("return 1");
		await Promise.all(l.waits);
		expect(l.scripts.resets.length).toBe(3);
		expect((await l.run("return 2")).value).toEqual({ text: "2" });
		// The fourth reset is the first script's, tried again before the second ran; the fifth is the second's own.
		expect(l.scripts.resets.length).toBe(5);
		expect(l.scripts.order).toEqual(["run", "reset", "reset", "reset", "reset", "run", "reset"]);
		expect(l.scripts.runs.length).toBe(2);
	});

	test("while the reset keeps failing no script runs; once it succeeds they run again", async () => {
		const l = lab();
		l.scripts.failResets = 6;
		await l.run("return 1");
		await Promise.all(l.waits);
		const refused = await l.run("return 2");
		expect(refused).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Sandbox host failed: the sandbox of the previous script could not be reset, so this script did not run" },
		});
		expect(l.scripts.runs.length).toBe(1);
		expect((await l.run("return 3")).value).toEqual({ text: "3" });
		expect(l.scripts.order).toEqual(["run", "reset", "reset", "reset", "reset", "reset", "reset", "reset", "run", "reset"]);
	});

	test("a reset that never answers is given up after its wait, three times", async () => {
		const hung = { run: async () => ({ refused: "stale" as const }), reset: () => new Promise<never>(() => {}) };
		const started = Date.now();
		expect(await resetScripts(() => hung, { runId: uuid7(), attempt: 1, scriptId: uuid7() }, false, 30)).toBe("failed");
		expect(Date.now() - started).toBeGreaterThanOrEqual(85);
	});

	test("more than ten scripts in a row, each stopped, each followed by its reset", async () => {
		const l = lab();
		for (let i = 0; i < 12; i++) {
			const result = await l.run("for (;;) await new Promise((resolve) => setTimeout(resolve, 5))", { timeoutMs: 20 });
			expect(result.error?.kind).toBe("timeout");
		}
		expect((await l.run("return 'next'")).value).toEqual({ text: "next" });
		await Promise.all(l.waits);
		expect(l.scripts.resets.length).toBe(13);
	});
});

describe("time helpers", () => {
	test("remainingMs, the wall clock and the CPU limit", () => {
		expect(remainingMs(null)).toBe(600_000);
		expect(remainingMs(Number.NaN)).toBe(60_000);
		expect(remainingMs(1_000_500, 1_000_000)).toBe(1000);
		expect(remainingMs(1_050_000, 1_000_000)).toBe(50_000);
		expect(scriptTimeoutMs(null)).toBe(120_000);
		expect(scriptTimeoutMs(1_050_000, 1_000_000)).toBe(50_000);
		expect(scriptCpuMs(120_000)).toBe(30_000);
		expect(scriptCpuMs(5000)).toBe(5000);
		expect(scriptCpuMs(10)).toBe(1000);
	});
});
