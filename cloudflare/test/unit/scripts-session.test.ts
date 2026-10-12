// The host's side of a script (src/scripts/session.ts): today's admission of scripted calls (harness 7.5,
// worker/src/main.ts `scriptCalls`), the guest treated as hostile, and calls and prints after the end.

import { describe, expect, test } from "vitest";
import type { Json } from "../../src/contracts/common.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../../src/contracts/executor.ts";
import { ToolQueue } from "../../src/conversation/queue.ts";
import { HEAD_CHARS, IMAGE_OMITTED, LATE_PENDING, MAX_OUTPUT_ITEMS, OUTPUT_LIMIT, SCRIPT_ARGS_BYTES } from "../../src/scripts/limits.ts";
import { ScriptCalls, ScriptSession } from "../../src/scripts/session.ts";
import { declaration, ok } from "./scripts-support.ts";

const READ = declaration("list_things");
const WRITE = declaration("save_thing", true);
const TOOLS = new Map<string, ToolDeclaration>([
	[READ.name, READ],
	[WRITE.name, WRITE],
]);

interface Port {
	sent: { name: string; args: Json | undefined }[];
	settle: (index: number, outcome?: ToolCallOutcome) => void;
	invoke: (declaration: ToolDeclaration, args: Json | undefined, drop: AbortSignal) => Promise<ToolCallOutcome>;
}

/** A port through the run's real queue whose calls settle when the test says. */
function port(): Port {
	const queue = new ToolQueue();
	const sent: Port["sent"] = [];
	const waiting: ((outcome: ToolCallOutcome) => void)[] = [];
	return {
		sent,
		settle: (index, outcome = ok([{ n: index }])) => waiting[index]?.(outcome),
		invoke: (tool, args, drop) =>
			queue.send(
				tool.annotations.readOnlyHint !== true,
				() =>
					new Promise<ToolCallOutcome>((resolve) => {
						sent.push({ name: tool.name, args });
						waiting.push(resolve);
					}),
				() => drop.throwIfAborted(),
			),
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settledYet(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(
		() => (done = true),
		() => (done = true),
	);
	await flush();
	return done;
}

describe("admission (harness 7.5)", () => {
	test("today's order and words: 100 open across the turn's scripts, then the JSON, then 256 KB", async () => {
		const calls = new ScriptCalls();
		const p = port();
		const first = new ScriptSession(calls, TOOLS, p);
		for (let i = 0; i < 4; i++) void first.call(READ.name, "{}");
		await flush();
		first.end();
		await flush();
		// The first script's calls that were sent still run after it ended, and keep their places.
		expect(p.sent.length).toBe(4);
		expect(calls.open).toBe(4);
		const second = new ScriptSession(calls, TOOLS, p);
		const answers = [];
		for (let i = 0; i < 97; i++) answers.push(second.call(READ.name, "{}"));
		expect(calls.open).toBe(100);
		expect(await answers[96]).toEqual({ ok: false, message: "At most 100 tool calls can wait at once. Await some before starting more." });
		// The open count is checked first, as today.
		expect(await second.call(READ.name, "{")).toEqual({ ok: false, message: "At most 100 tool calls can wait at once. Await some before starting more." });
		p.settle(0);
		await flush();
		expect(calls.open).toBe(99);
		expect(await second.call(READ.name, "{")).toEqual({ ok: false, message: "Tool arguments could not be converted to JSON." });
		const big = JSON.stringify({ n: "x".repeat(SCRIPT_ARGS_BYTES) });
		expect(await second.call(READ.name, big)).toEqual({ ok: false, message: "Tool arguments are limited to 256 KB of JSON." });
		// Exactly 256 KB of UTF-8 passes; one more byte does not.
		const exact = `"${"é".repeat((SCRIPT_ARGS_BYTES - 4) / 2)}xy"`;
		expect(new TextEncoder().encode(exact).length).toBe(SCRIPT_ARGS_BYTES);
		void second.call(READ.name, exact);
		p.settle(1);
		await flush();
		expect(await second.call(READ.name, `${exact} `)).toEqual({ ok: false, message: "Tool arguments are limited to 256 KB of JSON." });
		expect(await second.call(READ.name, 5 as unknown as string)).toEqual({ ok: false, message: "Tool arguments could not be converted to JSON." });
	});

	test("a tool the run does not have is refused by name (only a guest that bypassed `tools` can ask)", async () => {
		const session = new ScriptSession(new ScriptCalls(), TOOLS, port());
		expect(await session.call("nope", undefined)).toEqual({ ok: false, message: 'Unknown tool "nope"' });
		expect(await session.call(7 as unknown as string, undefined)).toEqual({ ok: false, message: 'Unknown tool "7"' });
	});

	test("absent arguments reach the executor as absent; JSON is read with parseJson", async () => {
		const p = port();
		const session = new ScriptSession(new ScriptCalls(), TOOLS, p);
		void session.call(READ.name, undefined);
		void session.call(READ.name, String.raw`{"\\":1,"\n":2}`);
		await flush();
		expect(p.sent[0]).toEqual({ name: READ.name, args: undefined });
		expect(Object.keys(p.sent[1]?.args as object)).toEqual(["\\", "\n"]);
	});

	test("the 100th refusal stops the script from a microtask, so it is still answered as a refusal", async () => {
		const session = new ScriptSession(new ScriptCalls(), TOOLS, port());
		const answers = [];
		for (let i = 0; i < 99; i++) answers.push(session.call(READ.name, "{"));
		expect(session.over).toBe(false);
		const hundredth = session.call(READ.name, "{");
		const after = session.call(READ.name, "{");
		expect(await hundredth).toEqual({ ok: false, message: "Tool arguments could not be converted to JSON." });
		await flush();
		expect(session.stopReason).toEqual({ kind: "aborted", message: "The script kept making tool calls that could not run." });
		// The 101st came in the same stretch, before the stop: refused too, as today's setImmediate let through.
		expect(await after).toEqual({ ok: false, message: "Tool arguments could not be converted to JSON." });
		expect(await settledYet(session.call(READ.name, "{"))).toBe(false);
	});
});

describe("calls and the script's end", () => {
	test("a call still waiting for its slot is dropped; one already sent runs to its end and keeps its count", async () => {
		const calls = new ScriptCalls();
		const p = port();
		const session = new ScriptSession(calls, TOOLS, p);
		const answers = [0, 1, 2, 3, 4].map(() => session.call(READ.name, "{}"));
		await flush();
		expect(p.sent.length).toBe(4);
		session.stop({ kind: "timeout", message: "Execution timed out after 1000 ms" });
		expect(session.pending()).toBe(5);
		p.settle(0);
		await flush();
		// The fifth never went out; the four that did keep counting until they settle.
		expect(p.sent.length).toBe(4);
		expect(calls.open).toBe(3);
		for (const index of [1, 2, 3]) p.settle(index);
		await flush();
		expect(calls.open).toBe(0);
		for (const answer of answers) expect(await settledYet(answer)).toBe(false);
		// Settled after the end: still cancelled in the records, as today's finish() left them.
		expect(session.pending()).toBe(5);
	});

	test("writes wait for each other through the run's queue; a write sent before the stop still settles", async () => {
		const p = port();
		const session = new ScriptSession(new ScriptCalls(), TOOLS, p);
		void session.call(WRITE.name, '{"n":1}');
		void session.call(WRITE.name, '{"n":2}');
		await flush();
		expect(p.sent.map((call) => call.args)).toEqual([{ n: 1 }]);
		session.stop({ kind: "timeout", message: "t" });
		p.settle(0);
		await flush();
		// The second write waited behind the first and was dropped by the stop before it was sent.
		expect(p.sent.map((call) => call.args)).toEqual([{ n: 1 }]);
	});

	test("a failure answers its message, or `<name> failed.` without one; settled calls get their status", async () => {
		const p = port();
		const session = new ScriptSession(new ScriptCalls(), TOOLS, p);
		const a = session.call(READ.name, "{}");
		const b = session.call(READ.name, "{}");
		await flush();
		p.settle(0, { ok: false, error: { code: "FAILED", message: "The provider refused the request." }, event: null });
		p.settle(1, { ok: false, error: { code: "FAILED", message: "" }, event: null });
		expect(await a).toEqual({ ok: false, message: "The provider refused the request." });
		expect(await b).toEqual({ ok: false, message: "list_things failed." });
		expect(session.pending()).toBe(0);
	});

	test("after the end, calls and prints never settle; past LATE_PENDING they are answered at once", async () => {
		const p = port();
		const session = new ScriptSession(new ScriptCalls(), TOOLS, p);
		session.end();
		const late = [];
		for (let i = 0; i < LATE_PENDING; i++) late.push(i % 2 ? session.call(READ.name, "{}") : session.print([{ type: "text", text: "x" }]));
		for (const answer of late) expect(await settledYet(answer)).toBe(false);
		expect(await session.call(READ.name, "{}")).toEqual({ ok: false, message: "The script has ended." });
		expect(await session.print([])).toBeUndefined();
		expect(session.late).toBe(LATE_PENDING + 2);
		expect(p.sent).toEqual([]);
		expect(session.output.items).toEqual([]);
	});
});

describe("prints", () => {
	test("text items and images, kept in order", async () => {
		const session = new ScriptSession(new ScriptCalls(), TOOLS, port());
		await session.print([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "" }]);
		expect(session.output.pieces()).toEqual([{ text: "a" }, { text: IMAGE_OMITTED }, { text: "" }]);
	});

	test("a malformed batch, or text past the head, is a broken bridge", async () => {
		for (const items of [
			"x",
			[{ type: "text", text: 5 }],
			[{ type: "text", text: "a", rest: { bytes: 1, newlines: 2, last: false } }],
			[{ type: "video" }],
			[{ type: "text", text: "x".repeat(HEAD_CHARS + 1) }],
			// Sizes no output within today's limits could have.
			[{ type: "text", text: "head", rest: { bytes: 1_000_000_000, newlines: 0, last: false } }],
		]) {
			const session = new ScriptSession(new ScriptCalls(), TOOLS, port());
			expect(await settledYet(session.print(items as never))).toBe(false);
			expect(session.stopReason?.kind).toBe("sandbox");
			expect(session.stopReason?.message).toMatch(/^Sandbox bridge broken: /);
		}
	});

	test("more than today's items stops the script as the prelude would have failed it", async () => {
		const session = new ScriptSession(new ScriptCalls(), TOOLS, port());
		await session.print(Array.from({ length: MAX_OUTPUT_ITEMS }, () => ({ type: "text" as const, text: "" })));
		expect(session.over).toBe(false);
		void session.print([{ type: "image" }]);
		expect(session.stopReason).toEqual({ kind: "script", message: OUTPUT_LIMIT, stack: `RangeError: ${OUTPUT_LIMIT}` });
	});
});
