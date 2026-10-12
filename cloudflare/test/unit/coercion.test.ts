// Strict tool inputs and lax provider answers (docs/plans/cloudflare.md, "Text and number rules"). zod's
// coercion and Pydantic's lax mode read text as numbers and booleans by different rules, so no schema uses
// zod's: tool inputs are strict (a number is a JSON number, a string a string), and a provider's answer is
// read by lib/lax.ts, whose rules are pydantic-core's. The Pydantic columns below are pydantic 2.13.5's
// (backend/.venv, Python 3.14.8); the zod columns pin what the choice avoided.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { laxBoolValue, laxIntValue } from "../../src/lib/lax.ts";
import { str, strippedStr } from "../../src/lib/schema.ts";
import { chainedCalls, sourceCode } from "../fixtures/source.ts";

function coercedNumber(value: unknown): number | null {
	const result = z.coerce.number().safeParse(value);
	return result.success ? result.data : null;
}

describe("zod's coercion is not Pydantic's", () => {
	// [text, z.coerce.number(), Pydantic's int in lax mode]: null is a refusal.
	test.each<[string, number | null, number | null]>([
		["0x10", 16, null],
		["0b11", 3, null],
		["1e3", 1000, null],
		["1.5", 1.5, null],
		["", 0, null],
		[" ", 0, null],
		["1_000", null, 1000],
		["0-1", null, -1],
		[" 7 ", 7, 7],
		["007", 7, 7],
		["+5", 5, 5],
		["1.0", 1, 1],
		["1__0", null, null],
		["Infinity", null, null],
		["١٢", null, null],
	])("the int %j: zod reads %j, Pydantic %j", (text, zod, pydantic) => {
		expect(coercedNumber(text)).toBe(zod);
		expect(laxIntValue(text)).toBe(pydantic);
	});

	// [text, z.coerce.boolean(), Pydantic's bool in lax mode]: any non-empty string is true to zod.
	test.each<[string, boolean, boolean | null]>([
		["false", true, false],
		["False", true, false],
		["0", true, false],
		["off", true, false],
		["no", true, false],
		["n", true, false],
		["f", true, false],
		["ON", true, true],
		["Yes", true, true],
		["", false, null],
		["2", true, null],
		["null", true, null],
	])("the bool %j: zod reads %j, Pydantic %j", (text, zod, pydantic) => {
		expect(z.coerce.boolean().parse(text)).toBe(zod);
		expect(laxBoolValue(text)).toBe(pydantic);
	});

	test("what zod's coercion makes of a value that is no string at all", () => {
		expect(z.coerce.string().parse(null)).toBe("null");
		expect(z.coerce.string().parse({})).toBe("[object Object]");
		expect(z.coerce.string().parse([1, 2])).toBe("1,2");
		expect(z.coerce.boolean().parse({})).toBe(true);
		expect(z.coerce.number().parse(null)).toBe(0);
		expect(z.coerce.number().parse([])).toBe(0);
		expect(z.coerce.number().parse(true)).toBe(1);
	});
});

describe("strict inputs stay strict", () => {
	test("a tool input is the type it names and nothing else", () => {
		expect(z.number().safeParse("5").success).toBe(false);
		expect(z.int().safeParse("5").success).toBe(false);
		expect(z.int().safeParse(true).success).toBe(false);
		expect(z.int().safeParse(1.5).success).toBe(false);
		expect(z.int().safeParse(2 ** 53).success).toBe(false);
		expect(z.boolean().safeParse(1).success).toBe(false);
		expect(z.boolean().safeParse("true").success).toBe(false);
		expect(z.string().safeParse(5).success).toBe(false);
		expect(z.string().safeParse(null).success).toBe(false);
	});

	test("lengths count code points and stripping is Unicode White_Space, which zod's does not do", () => {
		// zod counts UTF-16 units: an emoji is two.
		expect(z.string().max(1).safeParse("\u{1f600}").success).toBe(false);
		expect(str({ max: 1 }).safeParse("\u{1f600}").success).toBe(true);
		expect(str({ max: 1 }).safeParse("\u{1f600}\u{1f600}").success).toBe(false);
		expect(str({ min: 2 }).safeParse("\u{1f600}").success).toBe(false);
		expect(z.string().min(2).safeParse("\u{1f600}").success).toBe(true);
		// zod's trim() is JavaScript's: it strips U+FEFF and keeps U+0085; Pydantic's is the reverse.
		expect(z.string().trim().parse("\u0085x﻿")).toBe("\u0085x");
		expect(strippedStr().parse("\u0085x﻿")).toBe("x﻿");
	});
});

/** What zod's strings do with UTF-16 units and JavaScript's white space and case (lib/schema.ts does it with code points). */
const STRING_RULES = new Set(["min", "max", "length", "trim", "toLowerCase", "toUpperCase", "normalize", "check"]);

describe("no schema uses zod's coercion or its string lengths", () => {
	test("z.coerce is nowhere in src", () => {
		const users = sourceCode().filter(({ code }) => /\bz\s*\.\s*coerce\b|\bcoerce\s*\.\s*(number|string|boolean|bigint|date)\b/.test(code));
		expect(users.map(({ path }) => path)).toEqual([]);
	});

	test("a string's length, minimum and trim come from lib/schema.ts, never from z.string() itself", () => {
		const users: string[] = [];
		for (const { path, code } of sourceCode()) {
			for (const match of code.matchAll(/\bz\s*\.\s*string\s*\(\s*\)/g)) {
				const rules = chainedCalls(code, match.index + match[0].length).filter((name) => STRING_RULES.has(name));
				if (rules.length > 0) users.push(`${path}: z.string().${rules.join(".")}`);
			}
			if (/\bz\s*\.\s*(minLength|maxLength|length|trim|toLowerCase|toUpperCase|normalize)\s*\(/.test(code)) users.push(`${path}: a zod string check`);
		}
		expect(users).toEqual([]);
	});

	// The scans see what they claim to: a chain over several lines, and a rule behind a regex with parentheses.
	test("the scan reads a chain across lines and parentheses", () => {
		const code = "const a = z\n\t.string()\n\t.regex(/(a)/)\n\t.max(1);";
		const [match] = [...code.matchAll(/\bz\s*\.\s*string\s*\(\s*\)/g)];
		expect(chainedCalls(code, (match?.index ?? 0) + (match?.[0].length ?? 0))).toEqual(["regex", "max"]);
	});
});
