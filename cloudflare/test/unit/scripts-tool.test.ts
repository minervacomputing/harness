// `run_script` as the model sees it (src/scripts/tool.ts, description.ts): its registration, the
// description with the platform's stated differences, the rendering of results and the
// store's persistence.

import { describe, expect, test } from "vitest";
import type { ToolDeclaration } from "../../src/gateway/executor.ts";
import { scriptDeclarations, scriptDescription } from "../../src/scripts/description.ts";
import { HEAD_CHARS } from "../../src/scripts/limits.ts";
import { piece } from "../../src/scripts/output.ts";
import type { ScriptResult } from "../../src/scripts/run.ts";
import { loadStore, render, saveStore, SCRIPT_STORE, scriptTool, type ScriptToolHost } from "../../src/scripts/tool.ts";
import { declaration } from "./scripts-support.ts";

/** The description pi-codemode's host gives, lines before the declarations. */
const PI_CODEMODE = [
	"Run JavaScript that calls the tools declared below and returns a compact result.",
	"Prefer it for reads that page through long lists, repeat across many resources (each repository, calendar or database), or count, filter or total results. Start such reads inside the script, so their raw results never enter the conversation, and print only what the answer needs. Where you can, do the whole read in one script: list what you need, read each item and compute the answer. Call tools directly for one or two small reads whose results you want to see.",
	"The code is the body of an async function in a sandbox, so top-level await and return work. There is no network, file system, timers or modules.",
	"Call tools as `await tools.<name>(args)`. A call resolves to the object the tool returns and rejects with an Error when it fails or is refused.",
	"Await every call, for example with `await Promise.all(...)`: calls still running when the script ends are cancelled. A script that fails or stops does not undo the writes it made.",
	"Only what the script prints with `text(value)` or `console.log()`, and the value it returns, reach you. Tool results the script does not print do not.",
	"`count` is the number of items in that result, after leaving out what this run may not see, not a total. While a result has `next_cursor`, more items may follow, even after an empty page: call again with the same arguments plus `cursor: next_cursor`. `incomplete: true` means a provider or connector limit left something out; say so with any total. Item fields depend on the tool and are not declared. Rather than spending a script on looking at them, read the fields you expect, treat a missing one as unknown rather than empty, and also return the keys of one item, so a wrong guess shows in the same result.",
	"Each call is checked like a direct call. Up to 4 calls run at once, writes run one at a time, and at most 100 can wait, so start larger batches in parts.",
	"A script stops after 120 seconds, or sooner when the turn runs out of time. `store(key, value)` and `load(key)` keep JSON values between scripts in this turn, up to 1 MiB in all.",
	"",
	"```js",
	"// Totals every page of a list; list_things stands for any tool with a cursor argument.",
	"const args = { /* the arguments of the list you want */ }",
	"let total = 0, incomplete = false, cursor",
	"do {",
	"  const page = await tools.list_things({ ...args, cursor })",
	"  total += page.count",
	"  if (page.incomplete) incomplete = true",
	"  cursor = page.next_cursor",
	"} while (cursor)",
	"return { total, incomplete }",
	"```",
	"",
	"```ts",
];

/** The two lines that state this platform's differences (plan: Code mode). */
const CHANGED = new Map([
	[
		2,
		"The code is the body of an async function in a sandbox, so top-level await and return work. There is no network, file system or modules, and eval is not available. Timers exist, but `Date.now()` does not advance while the script computes.",
	],
	[
		8,
		"A script stops after 120 seconds, after 30 seconds of computation, or sooner when the turn runs out of time, and it may use about 256 MB of memory; one stopped for computation or memory loses what it printed since it last waited on a tool call or a timer. `store(key, value)` and `load(key)` keep JSON values between scripts in this turn, up to 1 MiB in all.",
	],
]);

const TOOLS: ToolDeclaration[] = [declaration("github_list_issues"), declaration("todoist_add-task", true)];

describe("the description", () => {
	test("pi-codemode's, line for line, but for the two that state the platform's differences", () => {
		const lines = scriptDescription(TOOLS).split("\n");
		const expected = PI_CODEMODE.map((line, index) => CHANGED.get(index) ?? line);
		expect(lines.slice(0, expected.length)).toEqual(expected);
		expect(lines.slice(expected.length).join("\n")).toBe(`${scriptDeclarations(TOOLS)}\n\`\`\``);
	});

	test("declarations share the result type and name tools by their identifiers", () => {
		const other: ToolDeclaration = { ...declaration("other"), outputSchema: { type: "object", properties: { x: { type: "string" } } } };
		expect(scriptDeclarations([...TOOLS, other])).toBe(
			[
				"type Result = { count: number; items: Array<{ [key: string]: unknown; }>; };",
				"",
				"declare const tools: {",
				"  github_list_issues(args: { cursor?: string; n?: number; }): Promise<Result>;",
				"  todoist_add_task(args: { cursor?: string; n?: number; }): Promise<Result>;",
				"  other(args: { cursor?: string; n?: number; }): Promise<{ x?: string; }>;",
				"};",
			].join("\n"),
		);
	});
});

describe("the registration", () => {
	test("sequential, never replayed, results up to 1 MiB with no line limit, one `code` parameter", () => {
		const tool = scriptTool([...TOOLS, TOOLS[0] as ToolDeclaration], {} as ScriptToolHost);
		expect(tool).toMatchObject({
			name: "run_script",
			executionMode: "sequential",
			replay: "unsafe",
			outputLimits: { maxBytes: 1024 * 1024, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" },
			parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript source." } }, required: ["code"] },
		});
		expect(tool.description).toBe(scriptDescription(TOOLS));
	});
});

const EMPTY = { set: [], delete: [] };

function result(fields: Partial<ScriptResult>): ScriptResult {
	return { ok: true, output: [], cancelled: 0, storeWrites: EMPTY, ...fields };
}

const texts = async (r: ScriptResult, unkept?: string) => {
	const rendered = await render(r, async () => unkept);
	return { texts: (rendered.content ?? []).map((item) => (item.type === "text" ? item.text : "")), isError: rendered.isError, diagnostics: rendered.diagnostics };
};

describe("what the model sees", () => {
	test("notes first, then the output, then the value", async () => {
		expect(await texts(result({ output: [{ text: "printed" }, { text: "[image omitted]" }], value: { text: "42" }, cancelled: 1 }), "What the script passed to `store()` was not kept: x")).toEqual({
			texts: [
				"1 tool call had not finished when the script ended and was cancelled. A cancelled write may still have taken effect.",
				"What the script passed to `store()` was not kept: x",
				"printed",
				"[image omitted]",
				"42",
			],
			isError: false,
			diagnostics: undefined,
		});
	});

	test("a failure: its stack or message clipped to 30,000 characters, cancelled calls, the output, no value and no store note", async () => {
		const failed = await texts(result({ ok: false, error: { kind: "script", message: "m", stack: `TypeError: ${"x".repeat(40_000)}` }, output: [{ text: "o" }], value: { text: "v" }, cancelled: 2 }), "unkept");
		expect(failed.isError).toBe(true);
		expect(failed.texts[0]).toBe(`Script failed: TypeError: ${"x".repeat(30_000 - "Script failed: TypeError: ".length)}\n\n[The rest of this message was left out.]`);
		expect(failed.texts.slice(1)).toEqual(["2 tool calls had not finished when the script ended and were cancelled. A cancelled write may still have taken effect.", "o"]);
		expect((await texts(result({ ok: false, error: { kind: "timeout", message: "Execution timed out after 120000 ms" } }))).texts).toEqual(["Script failed: Execution timed out after 120000 ms"]);
	});

	test("nothing printed or returned", async () => {
		expect((await texts(result({}))).texts).toEqual(["The script printed and returned nothing."]);
		expect((await texts(result({ value: { text: "" } }))).texts).toEqual([""]);
	});

	test("a result past 1 MiB is cut as pi cuts it, with pi's note", async () => {
		const value = `${"v\n".repeat(600_000)}`;
		const rendered = await texts(result({ output: [{ text: "start\n" }], value: piece(value, HEAD_CHARS) }));
		expect(rendered.texts).toEqual([`start\n${"v\n".repeat((1024 * 1024 - 6) / 2)}`]);
		expect(rendered.diagnostics).toEqual([{ severity: "warn", code: "truncated", message: `Output truncated to its beginning: ${600_000 - (1024 * 1024 - 6) / 2} lines, ${1_200_006 - 1024 * 1024} bytes dropped` }]);
	});

	test("the store is saved only for a script that succeeded", async () => {
		let saved = 0;
		await render(result({ ok: false, error: { kind: "script", message: "m" }, storeWrites: { set: [["k", "1"]], delete: [] } }), async () => {
			saved++;
			return undefined;
		});
		expect(saved).toBe(0);
	});
});

/** A pi conversation's documents as the tool's api sees them. */
function api() {
	let stored: { entries: [string, string][] } | null = null;
	const context = {} as never;
	return {
		get stored() {
			return stored;
		},
		conversationId: 1 as never,
		snapshot: async (token: unknown) => {
			expect(token).toBe(SCRIPT_STORE);
			return stored ? structuredClone(stored) : undefined;
		},
		commit: async <T>(change: (tx: { doc: (token: unknown) => Promise<{ entries: [string, string][] }> }) => T | Promise<T>) => {
			const draft = stored ? structuredClone(stored) : { entries: [] as [string, string][] };
			const answer = await change({ doc: async () => draft });
			stored = draft;
			return answer;
		},
		context,
	};
}

describe("the store", () => {
	test("saved as pairs of JSON texts, deletes before sets, and read back as the guest gets it", async () => {
		const a = api();
		expect(await saveStore(a as never, { set: [["a", '{"n": 1.0}'], ["__proto__", "[1]"]], delete: [] }, a.context)).toBeUndefined();
		expect(a.stored).toEqual({ entries: [["a", '{"n":1}'], ["__proto__", "[1]"]] });
		expect(await saveStore(a as never, { set: [["b", "2"], ["a", "3"]], delete: ["a", "__proto__"] }, a.context)).toBeUndefined();
		expect(await loadStore(a as never, a.context)).toEqual([
			["b", "2"],
			["a", "3"],
		]);
		expect(await saveStore(a as never, EMPTY, a.context)).toBeUndefined();
	});

	test("refusals: a value that is not JSON, and more than 1 MiB of JSON in all", async () => {
		const a = api();
		expect(await saveStore(a as never, { set: [["a", "{"]], delete: [] }, a.context)).toBe("What the script passed to `store()` was not kept: a value could not be converted to JSON.");
		const big = JSON.stringify("é".repeat(200_000));
		const set: [string, string][] = [0, 1, 2].map((i) => [`k${i}`, big]);
		expect(await saveStore(a as never, { set, delete: [] }, a.context)).toBe("What the script passed to `store()` was not kept: the stored values would take more than 1 MiB.");
		expect(a.stored).toBeNull();
		// Exactly 1 MiB of `{"k":"…"}` is kept.
		const exact = JSON.stringify("x".repeat(1024 * 1024 - 8));
		expect(await saveStore(a as never, { set: [["k", exact]], delete: [] }, a.context)).toBeUndefined();
		expect(new TextEncoder().encode(JSON.stringify({ k: JSON.parse(exact) })).length).toBe(1024 * 1024);
	});
});
