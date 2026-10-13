// The Scripts Durable Object in local workerd (src/scripts/scripts.ts): real Dynamic Workers from the
// LOADER binding running the guest's prelude, called with the conversation's RpcTargets; the guest's world
// on this runtime, the fences on runs and resets, the reset that breaks its call, the reset on a stop, and
// executeScript's reset after every script. What local workerd does not enforce (CPU and memory limits, the
// ten Dynamic Worker slots) is measured on the account (test/account/scripts.test.ts).

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { ToolQueue } from "../../src/conversation/queue.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../../src/gateway/executor.ts";
import type { Json } from "../../src/lib/json.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { RESET_REASON } from "../../src/scripts/limits.ts";
import type { GuestOutcome } from "../../src/scripts/outcome.ts";
import { executeScript, isReset, ScriptLane, type ScriptsClient, toolList } from "../../src/scripts/run.ts";
import type { ScriptFence, ScriptRequest } from "../../src/scripts/scripts.ts";
import { ScriptCalls, ScriptSession } from "../../src/scripts/session.ts";
import { targetsOf } from "../../src/scripts/target.ts";

const RESULT = { type: "object", properties: { items: { type: "array" }, count: { type: "integer" } } };
const TOOLS = new Map<string, ToolDeclaration>(
	["list_things", "never"].map((name) => [
		name,
		{ name, title: name, description: name, inputSchema: { type: "object", properties: {} }, outputSchema: RESULT, annotations: { readOnlyHint: true } },
	]),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scripts(name: string): ScriptsClient {
	return env.SCRIPTS.getByName(name) as unknown as ScriptsClient;
}

const calls: string[] = [];
const queue = new ToolQueue();

function session(): ScriptSession {
	return new ScriptSession(new ScriptCalls(), TOOLS, {
		invoke: (declaration, args, drop) =>
			queue.send(
				false,
				async (): Promise<ToolCallOutcome> => {
					calls.push(declaration.name);
					if (declaration.name === "never") await new Promise(() => {});
					return { ok: true, result: { items: [{ args: (args ?? null) as Json }], count: 1 }, title: "t", repeat: false, writeKey: null, event: null };
				},
				() => drop.throwIfAborted(),
			),
	});
}

function request(code: string, store: [string, string][] = []): ScriptRequest {
	return { code, tools: toolList(TOOLS), store, cpuMs: 30_000 };
}

function fence(runId = uuid7(), attempt = 1): ScriptFence {
	return { runId, attempt, scriptId: uuid7() };
}

/** One script run on the object directly, with its session. */
async function direct(name: string, code: string, f = fence()): Promise<{ answer: GuestOutcome | { refused: "stale" }; state: ScriptSession }> {
	const state = session();
	const { tools, control } = targetsOf(state);
	const answer = await scripts(name).run(f, request(code), tools, control);
	state.end();
	return { answer, state };
}

describe("the guest on this runtime", () => {
	test("calls reach the conversation's target and come back; output crosses; the store is read", async () => {
		const state = session();
		const { tools, control } = targetsOf(state);
		const answer = await scripts(uuid7()).run(
			fence(),
			request("const r = await tools.list_things({ a: 1 }); console.log('got', r.count); store('n', load('n') + 1); return r.items[0]", [["n", "41"]]),
			tools,
			control,
		);
		expect(answer).toEqual({ ok: true, value: { text: '{"args":{"a":1}}' }, writes: { set: [["n", "42"]], delete: [] }, unsettled: 0 });
		expect(state.output.pieces()).toEqual([{ text: "got 1" }]);
	});

	test("the platform's globals: no eval, no network, timers, the wrapper's names shadowed, frames in codemode.js", async () => {
		const { answer } = await direct(
			uuid7(),
			[
				"const out = {}",
				"try { eval('1') } catch (error) { out.eval = error.constructor.name + ': ' + error.message }",
				"try { await fetch('https://example.com') } catch (error) { out.fetch = error.message }",
				"const t0 = Date.now(); await new Promise((resolve) => setTimeout(resolve, 30)); out.timer = Date.now() - t0 >= 25",
				"out.names = [typeof require, typeof module, typeof exports, this === globalThis]",
				"try { null.x } catch (error) { out.frame = error.stack.split('\\n')[1] }",
				"undeclared = 1; out.sloppy = undeclared",
				"return out",
			].join("\n"),
		);
		expect(answer).toMatchObject({ ok: true });
		const out = JSON.parse((answer as { value: { text: string } }).value.text) as { [key: string]: unknown };
		expect(out.eval).toBe("EvalError: Code generation from strings disallowed for this context");
		expect(out.fetch).toMatch(/not permitted to access the internet/);
		expect(out.timer).toBe(true);
		expect(out.names).toEqual(["undefined", "undefined", "undefined", true]);
		expect(out.frame).toMatch(/codemode\.js:6:/);
		expect(out.sloppy).toBe(1);
	});

	test("the lockdown holds on this runtime and calls still work after it", async () => {
		const { answer } = await direct(
			uuid7(),
			"Array.prototype.sum = 1; Promise.prototype.then = null; const r = await tools.list_things({}); return [typeof [].sum, Object.isFrozen(Promise.prototype), r.count]",
		);
		expect(answer).toEqual({ ok: true, value: { text: '["undefined",true,1]' }, writes: { set: [], delete: [] }, unsettled: 0 });
	});

	test("a syntax error the loader finds is the platform's words (the conversation checks first)", async () => {
		const { answer } = await direct(uuid7(), "return 1 }\nexport const x = 1; function y() {");
		expect(answer).toMatchObject({ ok: false, error: { kind: "sandbox" } });
	});
});

describe("fences", () => {
	test("a run or reset older than the newest is refused; the newest survives the reset", async () => {
		const name = uuid7();
		const older = uuid7();
		const newer = uuid7();
		const earlier = fence(newer, 2);
		const current = fence(newer, 2);
		expect((await direct(name, "return 1", earlier)).answer).toMatchObject({ ok: true });
		expect((await direct(name, "return 1", current)).answer).toMatchObject({ ok: true });
		expect((await direct(name, "return 1", fence(newer, 1))).answer).toEqual({ refused: "stale" });
		expect((await direct(name, "return 1", fence(older, 9))).answer).toEqual({ refused: "stale" });
		// The script the attempt began with does not run again.
		expect((await direct(name, "return 1", earlier)).answer).toEqual({ refused: "stale" });
		expect(await scripts(name).reset({ ...current, runId: older, attempt: 9 })).toEqual({ refused: "stale" });
		expect(await scripts(name).reset({ ...current, attempt: 1 })).toEqual({ refused: "stale" });
		// The reset of a script before the last one loaded here is refused too.
		expect(await scripts(name).reset(earlier)).toEqual({ refused: "stale" });
		expect(await scripts(name).reset(earlier, true)).toEqual({ refused: "stale" });
		// The last one's reset breaks its own call: that is the reset done.
		const reset = await scripts(name)
			.reset(current, true)
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(isReset(reset)).toBe(true);
		expect((reset as Error).message).toContain(RESET_REASON);
		// A new instance has loaded nothing: its reset answers without one.
		expect(await scripts(name).reset(current)).toEqual({ reset: true });
		expect((await direct(name, "return 1", fence(newer, 1))).answer).toEqual({ refused: "stale" });
		expect((await direct(name, "return 2", fence(newer, 3))).answer).toMatchObject({ ok: true, value: { text: "2" } });
	});

	test("a run that arrives after its script's reset never loads, in this instance or the next", async () => {
		const name = uuid7();
		const late = fence();
		// The reset came first, to an instance that had loaded nothing.
		expect(await scripts(name).reset(late)).toEqual({ reset: true });
		expect((await direct(name, "return 'late'", late)).answer).toEqual({ refused: "stale" });
		// After a reset that ends the instance, too.
		const other = fence(late.runId, late.attempt);
		expect((await direct(name, "return 1", other)).answer).toMatchObject({ ok: true });
		const broken = await scripts(name)
			.reset(other)
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(isReset(broken)).toBe(true);
		expect((await direct(name, "return 'again'", other)).answer).toEqual({ refused: "stale" });
		expect((await direct(name, "return 'next'", fence(late.runId, late.attempt))).answer).toMatchObject({ ok: true, value: { text: "next" } });
		// Later scripts ran since; the ended ones still never load.
		expect((await direct(name, "return 'late'", late)).answer).toEqual({ refused: "stale" });
		expect((await direct(name, "return 'again'", other)).answer).toEqual({ refused: "stale" });
	});

	test("the conversation's deletion empties the object: its fence is gone with it", async () => {
		const name = uuid7();
		const runId = uuid7();
		expect((await direct(name, "return 1", fence(runId, 2))).answer).toMatchObject({ ok: true });
		const destroyed = await (env.SCRIPTS.getByName(name) as unknown as { destroy(): Promise<void> }).destroy().then(
			() => null,
			(error: unknown) => error,
		);
		expect(isReset(destroyed)).toBe(true);
		expect((await direct(name, "return 'older'", fence(runId, 1))).answer).toMatchObject({ ok: true, value: { text: "older" } });
	});

	test("a late reset from a replaced attempt does not stop the next attempt's script", async () => {
		const name = uuid7();
		const runId = uuid7();
		const state = session();
		const { tools, control } = targetsOf(state);
		const running = scripts(name).run(fence(runId, 2), request("await new Promise((resolve) => setTimeout(resolve, 300)); return 'kept'"), tools, control);
		await sleep(100);
		expect(await scripts(name).reset({ runId, attempt: 1, scriptId: uuid7() })).toEqual({ refused: "stale" });
		expect(await running).toMatchObject({ ok: true, value: { text: "kept" } });
	});
});

describe("ending guests", () => {
	test("a stop resets the object, which breaks the run; the next call meets a new instance", async () => {
		const name = uuid7();
		const state = session();
		const { tools, control } = targetsOf(state);
		const running = scripts(name)
			.run(fence(), request("for (;;) { await new Promise((resolve) => setTimeout(resolve, 20)) }"), tools, control)
			.then(
				(answer) => ({ answer }),
				(error: unknown) => ({ error }),
			);
		await sleep(100);
		state.stop({ kind: "timeout", message: "Execution timed out after 100 ms" });
		const settled = await running;
		expect("error" in settled && isReset(settled.error)).toBe(true);
		expect((await direct(name, "return 'after'")).answer).toMatchObject({ ok: true, value: { text: "after" } });
	});

	test("executeScript resets the object after every script, and a stopped guest's later calls never reach the queue", async () => {
		const name = uuid7();
		const lane = new ScriptLane();
		const resets: string[] = [];
		const client = (): ScriptsClient => {
			const stub = scripts(name);
			return {
				run: (f, s, t, c) => stub.run(f, s, t, c),
				reset: (f) => {
					resets.push(`${f.attempt}`);
					return stub.reset(f);
				},
			};
		};
		const runId = uuid7();
		const options = (code: string, timeoutMs = 2000) => ({
			fence: fence(runId),
			code,
			tools: TOOLS,
			store: [] as [string, string][],
			timeoutMs,
			cpuMs: 30_000,
			calls: new ScriptCalls(),
			scripts: client,
			lane,
			targets: targetsOf,
			waitUntil: () => {},
		});
		calls.length = 0;
		const port = {
			invoke: (declaration: ToolDeclaration) => {
				calls.push(declaration.name);
				return Promise.resolve<ToolCallOutcome>({ ok: true, result: { items: [], count: 0 }, title: "t", repeat: false, writeKey: null, event: null });
			},
		};
		const first = await executeScript({ ...options("for (;;) { await tools.list_things({}); await new Promise((resolve) => setTimeout(resolve, 10)) }", 150), port });
		expect(first.error).toEqual({ kind: "timeout", message: "Execution timed out after 150 ms" });
		const before = calls.length;
		await sleep(200);
		expect(calls.length).toBe(before);
		const second = await executeScript({ ...options("return 'second'"), port });
		expect(second).toMatchObject({ ok: true, value: { text: "second" } });
		expect(resets.length).toBe(2);
	});
});
