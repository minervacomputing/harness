// gateway/validation.ts: what the model reads when a tool call's arguments do not validate.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validateInput } from "../../src/gateway/validation.ts";
import { parseJson } from "../../src/lib/json.ts";
import { record } from "../../src/lib/schema.ts";

const Input = z.strictObject({
	project_id: z.string().trim().min(1).max(10),
	limit: z.int().min(1).max(50).default(30),
	inner: z.strictObject({ name: z.string().trim().max(5) }).nullable().default(null),
	tags: z.array(z.string()).default([]),
	data: record(z.unknown(), { max: 2 }).nullable().default(null),
});

describe("tool input validation", () => {
	test("returns the normalized arguments, defaults included; missing arguments validate as {}", async () => {
		expect(await validateInput(Input, { project_id: "  work " })).toEqual({ ok: true, data: { project_id: "work", limit: 30, inner: null, tags: [], data: null } });
		expect(await validateInput(Input, undefined)).toMatchObject({ ok: false, message: expect.stringMatching(/^Invalid arguments\. project_id: /) });
		expect(await validateInput(z.strictObject({ limit: z.int().default(30) }), null)).toEqual({ ok: true, data: { limit: 30 } });
	});

	test("names each problem by its path with zod's message, at most five", async () => {
		const result = await validateInput(Input, { project_id: "", limit: 0, inner: { name: "toolong", x: 1 }, tags: [1], data: { a: 1, b: 2, c: 3 }, zz: 1 });
		expect(result.ok).toBe(false);
		const message = result.ok ? "" : result.message;
		expect(message.startsWith("Invalid arguments. ")).toBe(true);
		const problems = message.slice("Invalid arguments. ".length).split("; ");
		expect(problems).toHaveLength(5);
		expect(problems.map((problem) => problem.split(": ")[0])).toEqual(["project_id", "limit", "inner.name", "inner", "tags.0"]);
		expect(problems[3]).toBe('inner: Unrecognized key: "x"');
	});

	test("refuses unknown fields, and keys that could reach a prototype", async () => {
		expect(await validateInput(Input, { project_id: "w", zz: 1 })).toEqual({ ok: false, message: 'Invalid arguments. input: Unrecognized key: "zz"' });
		expect(await validateInput(Input, parseJson('{"project_id":"w","__proto__":{"limit":1}}'))).toEqual({ ok: false, message: 'Invalid arguments. __proto__: The key "__proto__" is not allowed' });
		// At any depth, inside values the schema does not look into as well.
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"a":[{"constructor":1}]}}'))).toEqual({ ok: false, message: 'Invalid arguments. data.a.0.constructor: The key "constructor" is not allowed' });
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"__proto__":1}}'))).toEqual({ ok: false, message: 'Invalid arguments. data.__proto__: The key "__proto__" is not allowed' });
		expect(await validateInput(Input, [])).toMatchObject({ ok: false, message: expect.stringMatching(/^Invalid arguments\. input: /) });
	});

	test("refuses what the hashes of the arguments cannot hold, anywhere in them", async () => {
		expect(await validateInput(Input, parseJson('{"project_id":"\\ud800"}'))).toEqual({ ok: false, message: "Invalid arguments. project_id: Invalid string: lone surrogate" });
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"\\udc00":1}}'))).toEqual({ ok: false, message: "Invalid arguments. data: Invalid key: lone surrogate" });
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"n":9007199254740993}}'))).toEqual({ ok: false, message: "Invalid arguments. data.n: Number out of range" });
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"n":[1e400]}}'))).toEqual({ ok: false, message: "Invalid arguments. data.n.0: Number out of range" });
		expect(await validateInput(Input, parseJson('{"project_id":"w","data":{"n":0.5,"m":9007199254740991}}'))).toMatchObject({ ok: true });
	});
});
