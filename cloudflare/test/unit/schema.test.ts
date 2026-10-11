import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validationItems } from "../../src/http/errors.ts";
import { WHITE_SPACE, str, stripWhitespace, strippedStr } from "../../src/lib/schema.ts";
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
