// The guest's prelude (src/scripts/prelude.ts) against pi-codemode 1.0.4's contract, run in
// a realm of its own with a fake host (scripts-support.ts). What only the platform shows (eval, timers,
// fetch, the loader's CommonJS) is in test/platform/scripts.test.ts.

import { describe, expect, test } from "vitest";
import type { ScriptCallAnswer, ScriptOutputItem, ScriptTools } from "../../src/contracts/scripts.ts";
import { ERROR_CHARS, HEAD_CHARS, MAX_OUTPUT_ITEMS, OUTPUT_LIMIT } from "../../src/scripts/limits.ts";
import { sizeOf } from "../../src/scripts/output.ts";
import { runInRealm, toolList } from "./scripts-support.ts";

interface Host extends ScriptTools {
	calls: { name: string; argsJson: string | undefined }[];
	prints: ScriptOutputItem[][];
}

/** A host that answers every call with `answer(name, args)`. */
function host(answer: (name: string, args: unknown) => ScriptCallAnswer | Promise<ScriptCallAnswer> = () => ({ ok: true, value: { items: [], count: 0 } })): Host {
	const calls: Host["calls"] = [];
	const prints: Host["prints"] = [];
	return {
		calls,
		prints,
		async call(name, argsJson) {
			calls.push({ name, argsJson });
			return answer(name, argsJson === undefined ? undefined : JSON.parse(argsJson));
		},
		async print(items) {
			prints.push(items.map((item) => ({ ...item })));
		},
	};
}

const TOOLS = toolList(["list_things", "save-thing", "github_list_issues"]);

async function run(code: string, h: Host = host(), store: [string, string][] = []) {
	const guest = runInRealm(code, h, TOOLS, store);
	const answer = (await guest.answer) as { ok: boolean; value?: { text: string; rest?: unknown }; error?: { name?: string; message: string; stack?: string }; writes?: unknown[]; unsettled: number };
	return { answer, printed: h.prints.flat(), calls: h.calls, global: guest.global };
}

const text = (printed: ScriptOutputItem[]) => printed.map((item) => (item.type === "text" ? item.text : "[image]"));

describe("values", () => {
	test("a string as it is, anything else as JSON, nothing for undefined or a function", async () => {
		expect((await run("return 'plain'")).answer).toEqual({ ok: true, value: { text: "plain" }, writes: [], unsettled: 0 });
		expect((await run("return { a: [1, 'b'], n: null }")).answer.value).toEqual({ text: '{"a":[1,"b"],"n":null}' });
		expect((await run("return null")).answer.value).toEqual({ text: "null" });
		expect((await run("return 0")).answer.value).toEqual({ text: "0" });
		expect((await run("return ''")).answer.value).toEqual({ text: "" });
		expect((await run("return undefined")).answer).not.toHaveProperty("value");
		expect((await run("return () => 1")).answer).not.toHaveProperty("value");
		expect((await run("1 + 1")).answer).toEqual({ ok: true, writes: [], unsettled: 0 });
	});

	test("a value JSON cannot write fails the script, as pi-codemode's serialize did", async () => {
		const cyclic = await run("const a = {}; a.a = a; return a");
		expect(cyclic.answer.ok).toBe(false);
		expect(cyclic.answer.error?.name).toBe("TypeError");
		expect(cyclic.answer.error?.message).toMatch(/circular/i);
		const big = await run("return 10n");
		expect(big.answer.error?.stack).toMatch(/^TypeError: Do not know how to serialize a BigInt/);
	});

	test("a long value crosses as its head and the size of the rest", async () => {
		const { answer } = await run(`return "é".repeat(${HEAD_CHARS + 10}) + "\\nend"`);
		expect(answer.value?.text).toBe("é".repeat(HEAD_CHARS));
		expect(answer.value?.rest).toEqual(sizeOf(`${"é".repeat(10)}\nend`));
	});

	test("a surrogate pair is not split at the head's end", async () => {
		const { answer } = await run(`return "a" + "😀".repeat(${HEAD_CHARS})`);
		expect(answer.value?.text.length).toBe(HEAD_CHARS - 1);
		expect(answer.value?.rest).toEqual(sizeOf("😀".repeat(HEAD_CHARS / 2 + 1)));
	});
});

describe("output", () => {
	test("text() and console, in order, formatted", async () => {
		const { printed } = await run(
			"text('one'); text(5); text(undefined); text(null); text({ a: 1 }); text([1, 2]); console.log('a', { b: 1 }, [1], 2); console.error(new TypeError('bad')); console.info(); return 'done'",
		);
		const shown = text(printed);
		expect(shown.slice(0, 8)).toEqual(["one", "5", "undefined", "null", '{"a":1}', "[1,2]", 'a {"b":1} [1] 2', expect.stringMatching(/^TypeError: bad\n {4}at /)]);
		expect(shown[7]).not.toContain("codemode-prelude.js");
		expect(shown[8]).toBe("");
	});

	test("prints are sent in batches, before a call and at the end", async () => {
		const h = host();
		const { printed } = await run("for (let i = 0; i < 1000; i++) text(String(i)); await tools.list_things({}); text('after'); return 1", h);
		expect(text(printed)).toEqual([...Array.from({ length: 1000 }, (_, i) => String(i)), "after"]);
		expect(h.prints.length).toBeLessThanOrEqual(3);
	});

	test("past the item limit the script fails with a RangeError, and catching it does not resume output", async () => {
		const { answer, printed } = await run(`try { for (let i = 0; i <= ${MAX_OUTPUT_ITEMS}; i++) text("") } catch (error) { text("caught") } return "never"`);
		expect(answer.ok).toBe(false);
		expect(answer.error?.message).toBe(OUTPUT_LIMIT);
		expect(answer.error?.stack).toMatch(/^RangeError: script output exceeded the limit of 16777216 characters/);
		expect(printed.length).toBe(MAX_OUTPUT_ITEMS);
	});

	test("a long output crosses as its head, then sizes only, merged", async () => {
		const { printed } = await run(`text("x".repeat(${HEAD_CHARS - 2})); text("abcd\\n"); text("é\\n"); text("z"); return 1`);
		expect(printed).toEqual([
			{ type: "text", text: "x".repeat(HEAD_CHARS - 2) },
			{ type: "text", text: "ab", rest: sizeOf("cd\n") },
			{ type: "text", text: "", rest: sizeOf("é\nz") },
		]);
	});

	test("images: a data URL, an image_url or an MCP block of a known format; its data never crosses", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		const { answer, printed } = await run(
			`image("data:image/png;base64,${png}"); image({ image_url: "data:;base64,${png}" }); image({ type: "image", data: "${png}", mimeType: "image/png" }); return 1`,
		);
		expect(answer.ok).toBe(true);
		expect(printed).toEqual([{ type: "image" }, { type: "image" }, { type: "image" }]);
		const refusals = await run(
			`const out = []; for (const value of ["", "https://example.com/a.png", "data:image/png,abc", "data:;base64,abc", "data:;base64,AAAA", { type: "text" }, 5]) { try { image(value) } catch (error) { out.push(error.message) } } return out`,
		);
		expect(JSON.parse(refusals.answer.value?.text ?? "")).toEqual([
			"image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",
			"remote image URLs are not supported in tool outputs. Pass a base64 data URI instead",
			"invalid image output. Pass a base64 data URI instead",
			"invalid image output. The image data is not valid base64 (truncated or corrupted?)",
			"invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image",
			'image only accepts MCP image blocks, got "text"',
			"image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",
		]);
	});
});

describe("tools", () => {
	test("a call sends its arguments' JSON and resolves to the structured result", async () => {
		const h = host((name, args) => ({ ok: true, value: { items: [{ name, args: args as never }], count: 1 } }));
		const { answer, calls } = await run("const r = await tools.list_things({ n: 1 }); const s = await tools['save-thing'](); const t = await tools.save_thing({ b: [1] }); return [r, s.items[0].args === undefined, t.count]", h);
		expect(calls).toEqual([
			{ name: "list_things", argsJson: '{"n":1}' },
			{ name: "save-thing", argsJson: undefined },
			{ name: "save-thing", argsJson: '{"b":[1]}' },
		]);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([{ items: [{ name: "list_things", args: { n: 1 } }], count: 1 }, true, 1]);
	});

	test("a failure rejects with an Error of its message", async () => {
		const h = host(() => ({ ok: false, message: "This operation is not available." }));
		const { answer } = await run("try { await tools.list_things({}) } catch (error) { return [error instanceof Error, error.message] }", h);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([true, "This operation is not available."]);
	});

	test("arguments JSON cannot write reject in the script, before reaching the host", async () => {
		const h = host();
		const { answer } = await run("const a = {}; a.a = a; try { await tools.list_things(a) } catch (error) { return error.constructor.name }", h);
		expect(answer.value?.text).toBe("TypeError");
		expect(h.calls).toEqual([]);
	});

	test("ALL_TOOLS lists identifiers; the first tool wins an identifier; a missing member names the close ones", async () => {
		const tools = toolList(["a-b", "a_b", "list_things"]);
		const guest = runInRealm(
			"const out = [ALL_TOOLS.map((tool) => tool.name), 'a_b' in tools, 'nope' in tools, tools.then === undefined]; try { tools.listthings } catch (error) { out.push(error.message) } try { tools.zzz } catch (error) { out.push(error.message) } return out",
			host(),
			tools,
		);
		const answer = (await guest.answer) as { value: { text: string } };
		expect(JSON.parse(answer.value.text)).toEqual([
			["a_b", "list_things"],
			true,
			false,
			true,
			'tools.listthings does not exist. Did you mean tools.list_things? ALL_TOOLS lists every tool; searchTools(query) finds tools by topic. Check for a member with "listthings" in tools.',
			'tools.zzz does not exist. Available: a_b, list_things. ALL_TOOLS lists every tool; searchTools(query) finds tools by topic. Check for a member with "zzz" in tools.',
		]);
	});

	test("calls the script did not wait for are counted as unsettled", async () => {
		const h = host(() => new Promise(() => {}));
		const { answer } = await run("tools.list_things({}); tools.list_things({}); return 1", h);
		expect(answer.unsettled).toBe(2);
	});

	test("a call whose arguments end the script while they are written never reaches the host", async () => {
		const h = host();
		const { answer, calls } = await run("tools.list_things({ toJSON() { try { exit() } catch {} return { n: 1 } } }); return 1", h);
		expect(answer).toEqual({ ok: true, writes: [], unsettled: 0 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toEqual([]);
	});

	test("after the script answered, a call never reaches the host", async () => {
		const h = host();
		const guest = runInRealm("globalThis.later = () => tools.list_things({}); return 1", h, TOOLS);
		await guest.answer;
		void (guest.global.later as () => Promise<unknown>)();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.calls).toEqual([]);
	});
});

describe("store and load", () => {
	test("values persist as JSON; undefined deletes; load returns a copy; writes are reported", async () => {
		const { answer } = await run(
			"store('a', { n: 1 }); const copy = load('a'); copy.n = 2; store('b', [1]); store('b', undefined); store('c', 'x'); store('kept', 0); return [load('a'), load('b'), load('old'), load('kept')]",
			host(),
			[
				["old", '{"o":true}'],
				["kept", "1"],
			],
		);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([{ n: 1 }, null, { o: true }, 0]);
		expect(answer.writes).toEqual([["a", '{"n":1}'], ["b"], ["c", '"x"'], ["kept", "0"]]);
	});

	test("refusals: a key that is not a string, a value JSON cannot write, a value or a store too large", async () => {
		const { answer } = await run(
			`const out = []; for (const f of [() => store(1, 1), () => load(1), () => store("f", () => 1), () => store("big", "x".repeat(262144)), () => { for (let i = 0; i < 5; i++) store("k" + i, "x".repeat(262000)) }]) { try { f() } catch (error) { out.push(error.constructor.name + ": " + error.message) } } return out`,
		);
		const hint = "store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([
			"TypeError: store() key must be a string",
			"TypeError: load() key must be a string",
			'TypeError: store("f") value is not JSON-serializable',
			`RangeError: store("big") value has 262146 characters of JSON, more than the limit of 262144. ${hint}`,
			`RangeError: store is full: stored values would exceed 1048576 characters of JSON. Delete keys with store(key, undefined). ${hint}`,
		]);
	});

	test("load reads escaped keys right after the key \\\\ was read (the runtime's JSON.parse would not)", async () => {
		const { answer } = await run(
			String.raw`store("one", { "\\": 1 }); load("one"); store("two", { "\n": 2, "éé": 3 }); return Object.keys(load("two")).map((key) => [...key].map((c) => c.charCodeAt(0)))`,
		);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([[10], [233, 233]]);
	});

	test("a key __proto__ stays a key", async () => {
		const { answer } = await run(String.raw`store("__proto__", { ["__proto__"]: { "\n": 1 } }); const v = load("__proto__"); return [Object.keys(v), Object.getPrototypeOf(v) === Object.prototype]`);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([["__proto__"], true]);
		expect(answer.writes).toEqual([["__proto__", String.raw`{"__proto__":{"\n":1}}`]]);
	});
});

describe("exit and errors", () => {
	test("exit() ends the script successfully, with its output and writes, and nothing after it runs", async () => {
		const { answer, printed } = await run("text('before'); store('k', 1); exit(); text('after'); return 'never'");
		expect(answer).toEqual({ ok: true, writes: [["k", "1"]], unsettled: 0 });
		expect(text(printed)).toEqual(["before"]);
		const caught = await run("try { exit() } catch {} text('after'); return 'later'");
		expect(caught.answer).toEqual({ ok: true, writes: [], unsettled: 0 });
		expect(caught.printed).toEqual([]);
	});

	test("a thrown Error reports its name, message and the script's frames; other values their text", async () => {
		const thrown = await run("\nconst f = () => { throw new RangeError('bad thing') }\nf()");
		expect(thrown.answer.error).toMatchObject({ name: "RangeError", message: "bad thing" });
		expect(thrown.answer.error?.stack).toMatch(/^RangeError: bad thing\n {4}at f \(codemode\.js:2:/);
		expect(thrown.answer.error?.stack).not.toContain("codemode-prelude.js");
		expect((await run("throw { a: 1 }")).answer.error).toEqual({ message: '{"a":1}' });
		expect((await run("throw 'text'")).answer.error).toEqual({ message: "text" });
		const odd = await run("const e = new Error('m'); e.name = { toString() { throw 1 } }; throw e");
		expect(odd.answer.error).toEqual({ message: "The script threw a value that cannot be described" });
		const long = await run(`throw new Error("x".repeat(${ERROR_CHARS * 2}))`);
		expect(long.answer.error?.message.length).toBe(ERROR_CHARS);
		expect(long.answer.error?.stack?.length).toBe(ERROR_CHARS);
	});

	test("an error message without text shows its name alone", async () => {
		expect((await run("throw new Error()")).answer.error?.stack).toMatch(/^Error\n {4}at /);
	});
});

describe("the sandbox's semantics", () => {
	test("sloppy, as a function at the top level: undeclared globals, `this` the global object, the wrapper's names shadowed", async () => {
		const { answer } = await run("undeclared = 5; return [undeclared, this === globalThis, typeof require, typeof module, typeof exports, typeof __filename]");
		expect(JSON.parse(answer.value?.text ?? "")).toEqual([5, true, "undefined", "undefined", "undefined", "undefined"]);
	});

	test("built-ins are frozen (pi-codemode's lockdown); overriding an inherited name on an instance still works", async () => {
		const { answer } = await run(
			"Array.prototype.sum = function () { return 1 }; JSON.stringify = () => 'x'; class E extends Error { constructor() { super('m'); this.name = 'E' } }; const o = {}; o.toString = () => 'mine'; return [typeof [].sum, JSON.stringify(1), new E().name, String(o), Object.isFrozen(Object.prototype)]",
		);
		expect(JSON.parse(answer.value?.text ?? "")).toEqual(["undefined", "1", "E", "mine", true]);
		const strict = await run("'use strict'; try { Object.prototype.toString = null } catch (error) { return error.message }");
		expect(strict.answer.value?.text).toBe("Cannot assign to read only property 'toString' of a built-in");
	});

	test("the globals are read-only and the prelude's console replaces the platform's", async () => {
		const { answer, printed } = await run("globalThis.tools = 1; text = 2; console.log('mine'); return [typeof globalThis.tools, typeof text, globalThis.console === console]");
		expect(JSON.parse(answer.value?.text ?? "")).toEqual(["object", "function", true]);
		expect(text(printed)).toEqual(["mine"]);
	});
});
