import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validationItems } from "../../src/http/errors.ts";
import { canonicalJson } from "../../src/lib/canonical.ts";
import { parseJson, visibleJson } from "../../src/lib/json.ts";
import { WHITE_SPACE, anyRecord, isStrictRecord, str, strictRecord, stripWhitespace, strippedStr } from "../../src/lib/schema.ts";
import vectors from "./vectors.ts";

describe("strings as Pydantic validates them", () => {
	test("stripping removes exactly what Pydantic strips", () => {
		expect([...WHITE_SPACE].sort((a, b) => a - b)).toEqual(vectors.pydantic.stripped);
		// String.prototype.trim would strip U+FEFF and keep U+0085.
		expect(stripWhitespace("﻿ab")).toBe("﻿ab");
		expect(stripWhitespace("\u0085ab\u0085")).toBe("ab");
		expect(stripWhitespace(" \t\n")).toBe("");
		expect(stripWhitespace("a b")).toBe("a b");
	});

	test.each(vectors.pydantic.cases)("$input", ({ input, stripped, plain }) => {
		// The vectors' models: max_length 3, stripped (a connector input), and min 2, max 3, not stripped.
		const parsed = strippedStr({ max: 3 }).safeParse(input);
		expect(parsed.success ? parsed.data : null).toBe(stripped);
		expect(str({ min: 2, max: 3 }).safeParse(input).success).toBe(plain);
	});

	test("an emoji counts once, and the refusal is in Pydantic's words", () => {
		const content = z.object({ content: str({ min: 1, max: 3 }) }).strict();
		expect(content.safeParse({ content: "\u{1f600}\u{1f600}\u{1f600}" }).success).toBe(true);
		const longInput = { content: "\u{1f600}".repeat(4) };
		const long = content.safeParse(longInput);
		expect(long.success).toBe(false);
		expect(validationItems(long.error?.issues ?? [], "body", longInput)).toEqual([
			{ type: "string_too_long", loc: ["body", "payload", "content"], msg: "String should have at most 3 characters", ctx: { max_length: 3 } },
		]);
		const emptyInput = { content: "" };
		const empty = content.safeParse(emptyInput);
		expect(validationItems(empty.error?.issues ?? [], "body", emptyInput)).toEqual([
			{ type: "string_too_short", loc: ["body", "payload", "content"], msg: "String should have at least 1 character", ctx: { min_length: 1 } },
		]);
	});

	test("a connector input strips before its limits", () => {
		expect(strippedStr({ min: 1 }).safeParse("  ").success).toBe(false);
		expect(strippedStr({ max: 1 }).parse(" x ")).toBe("x");
	});

	test("JSON Schema still says minLength and maxLength", () => {
		const schema = z.toJSONSchema(z.object({ a: str({ min: 1, max: 3 }), b: strippedStr({ max: 200 }), c: str() }).strict());
		expect(schema.properties).toEqual({
			a: { type: "string", minLength: 1, maxLength: 3 },
			b: { type: "string", maxLength: 200 },
			c: { type: "string" },
		});
	});
});

describe("records as Pydantic validates dict[str, …]", () => {
	// generate.py's model: OperationInput's config, with the dicts of notion's QueryDatabase and CreateRow.
	const Input = z.strictObject({
		flags: strictRecord(z.boolean()).nullable().default(null),
		filter: anyRecord().nullable().default(null),
		sorts: z.array(anyRecord()).max(10).nullable().default(null),
		properties: anyRecord({ min: 1, max: 2 }).nullable().default(null),
	});

	test.each(vectors.pydantic_records)("$json", (vector) => {
		const input = parseJson(vector.json);
		const parsed = Input.safeParse(input);
		if (vector.canonical !== undefined) {
			expect(parsed.error?.issues).toBeUndefined();
			// The same value as Python validated (its JSON, compared as canonical JSON).
			expect(canonicalJson(parsed.data)).toBe(canonicalJson(parseJson(vector.canonical)));
		} else {
			const items = validationItems(parsed.error?.issues ?? [], "body", input);
			expect(items.map(({ loc, ...item }) => ({ ...item, loc: loc.slice(2) }))).toEqual(vector.errors);
		}
	});

	test("a \"__proto__\" key is validated, where zod's record skips it", () => {
		const text = '{"filter":{"__proto__":1}}';
		const zods = z.strictObject({ filter: z.record(strippedStr(), z.boolean()) }).safeParse(parseJson(text));
		expect(zods.data).toEqual({ filter: {} });
		const input = parseJson(text);
		const parsed = z.strictObject({ filter: strictRecord(z.boolean()) }).safeParse(input);
		expect(validationItems(parsed.error?.issues ?? [], "body", input)).toEqual([
			{ type: "bool_type", loc: ["body", "payload", "filter", "__proto__"], msg: "Input should be a valid boolean" },
		]);
	});

	test("a key that strips to \"__proto__\" stays a key, where zod's record makes it the prototype", () => {
		const text = '{"filter":{" __proto__ ":{"injected":true}}}';
		const zods = z.strictObject({ filter: z.record(strippedStr(), z.unknown()) }).parse(parseJson(text));
		expect(Object.keys(zods.filter)).toEqual([]);
		expect((zods.filter as { injected?: unknown }).injected).toBe(true);
		const { filter } = z.strictObject({ filter: anyRecord() }).parse(parseJson(text));
		expect(Object.keys(filter)).toEqual(["__proto__"]);
		expect(Object.getPrototypeOf(filter)).toBe(Object.prototype);
		expect("injected" in filter).toBe(false);
		expect(Object.getOwnPropertyDescriptor(filter, "__proto__")?.value).toEqual({ injected: true });
		expect(canonicalJson({ filter })).toBe('{"filter":{"__proto__":{"injected":true}}}');
		expect(visibleJson(filter)).toBe('{"__proto__": {"injected": true}}');
		// Nested values are left as they are, own "__proto__" keys included.
		const nested = anyRecord().parse(parseJson('{"a":{"__proto__":{"b":1}}}'));
		expect(Object.keys(nested.a as object)).toEqual(["__proto__"]);
		expect(Object.getPrototypeOf(nested.a)).toBe(Object.prototype);
	});

	test("of keys that strip alike, a parsed object lists an integer-like one first", () => {
		// Python keeps the later of " 1 " and "1" in the text; the parsed object has lost that order, and
		// the padded key, listed after "1", wins (the vectors have the order both agree on).
		expect(anyRecord().parse(parseJson('{" 1 ":"a","1":"b"}'))).toEqual({ 1: "a" });
		expect(anyRecord().parse(parseJson('{"1":"a"," 1 ":"b"}'))).toEqual({ 1: "b" });
	});

	test("only a plain object is a dict", () => {
		const dict = anyRecord();
		for (const value of [[], null, "x", 1, new Map(), new Date(0), new (class Box {})()]) {
			expect(dict.safeParse(value).error?.issues[0]).toMatchObject({ code: "invalid_type", expected: "record" });
		}
		expect(dict.parse(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
	});

	test("values are validated by their schema, asynchronously too, and refinements run after", async () => {
		const names = strictRecord(strippedStr({ max: 2 }));
		expect(names.parse({ " a ": " b " })).toEqual({ a: "b" });
		const later = strictRecord(z.boolean().refine(async (value) => value));
		expect(await later.parseAsync({ a: true })).toEqual({ a: true });
		expect((await later.safeParseAsync({ a: false })).success).toBe(false);
		// An AfterValidator such as notion's json_size.
		const sized = anyRecord().refine((value) => visibleJson(value).length <= 10, "must be at most 10 characters as JSON");
		expect(isStrictRecord(sized)).toBe(true);
		expect(sized.safeParse({ a: 1 }).success).toBe(true);
		expect(sized.safeParse({ abcdef: 1 }).success).toBe(false);
	});

	test("refinements and the length check skip a dict whose items failed, as Pydantic's do", () => {
		const seen: unknown[] = [];
		// A length check's issue lets zod go on; the dict's failure must not.
		const checked = strictRecord(strippedStr({ min: 2 }), { min: 2 }).refine((value) => {
			seen.push(value);
			return true;
		});
		const input = { a: "x" };
		const parsed = checked.safeParse(input);
		expect(validationItems(parsed.error?.issues ?? [], "body", input)).toEqual([
			{ type: "string_too_short", loc: ["body", "payload", "a"], msg: "String should have at least 2 characters", ctx: { min_length: 2 } },
		]);
		expect(seen).toEqual([]);
		expect(checked.safeParse({ a: "xy", b: "zw" }).success).toBe(true);
		expect(seen).toEqual([{ a: "xy", b: "zw" }]);
	});

	test("JSON Schema is Pydantic's: an object of the value's schema, with its size", () => {
		const schema = z.toJSONSchema(
			z.strictObject({
				flags: strictRecord(z.boolean()),
				filter: anyRecord().nullable().default(null),
				properties: anyRecord({ min: 1, max: 100 }).describe("Properties by name."),
			}),
			{ io: "input" },
		);
		expect(schema.properties).toEqual({
			flags: { type: "object", additionalProperties: { type: "boolean" } },
			filter: { anyOf: [{ type: "object", additionalProperties: {} }, { type: "null" }], default: null },
			properties: { type: "object", additionalProperties: {}, minProperties: 1, maxProperties: 100, description: "Properties by name." },
		});
	});
});
