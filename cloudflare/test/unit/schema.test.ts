import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseJson } from "../../src/lib/json.ts";
import { isRecord, record } from "../../src/lib/schema.ts";

describe("record", () => {
	test("refuses the keys zod's record would drop or that name an object's machinery", () => {
		// zod's own record skips "__proto__" without a word.
		expect(z.record(z.string(), z.boolean()).parse(parseJson('{"__proto__":true}'))).toEqual({});
		const flags = record(z.boolean());
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const parsed = flags.safeParse(parseJson(`{"a":true,"${key}":true}`));
			expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: "custom", path: [key], message: `The key "${key}" is not allowed` })]);
		}
		expect(flags.parse(parseJson('{"a":true,"proto":false}'))).toEqual({ a: true, proto: false });
	});

	test("keeps refusing them after zod copies the schema (refine, describe, nullable)", () => {
		const copied = record(z.unknown()).refine(() => true).describe("A filter.").nullable();
		expect(copied.safeParse(parseJson('{"__proto__":{"polluted":true}}')).success).toBe(false);
		expect(isRecord(record(z.unknown()).describe("x"))).toBe(true);
		expect(isRecord(z.record(z.string(), z.unknown()))).toBe(false);
	});

	test("limits its keys before validating any value", () => {
		const seen: unknown[] = [];
		const limited = record(
			z.string().refine((value) => seen.push(value) > 0),
			{ min: 1, max: 2 },
		);
		expect(limited.safeParse({ a: "1", b: "2", c: "3" }).error?.issues).toEqual([expect.objectContaining({ code: "too_big", maximum: 2 })]);
		expect(limited.safeParse({}).error?.issues).toEqual([expect.objectContaining({ code: "too_small", minimum: 1 })]);
		expect(seen).toEqual([]);
		expect(limited.parse({ a: "1", b: "2" })).toEqual({ a: "1", b: "2" });
	});

	test("takes plain objects only, and leaves nested values as they are", () => {
		const any = record(z.unknown());
		for (const value of [[], null, "x", 1, new Map()]) expect(any.safeParse(value).success).toBe(false);
		const parsed = any.parse(parseJson('{"a":{"__proto__":{"b":1}}}'));
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(Object.keys(parsed.a as object)).toEqual(["__proto__"]);
		expect(({} as { b?: unknown }).b).toBeUndefined();
	});

	test("JSON Schema is an object of the value's schema, with its size", () => {
		const schema = z.toJSONSchema(z.strictObject({ properties: record(z.boolean(), { min: 1, max: 100 }).describe("Properties by name.") }), { io: "input" });
		expect(schema.properties).toEqual({
			properties: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "boolean" }, minProperties: 1, maxProperties: 100, description: "Properties by name." },
		});
	});
});
