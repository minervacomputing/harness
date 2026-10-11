import { describe, expect, test } from "vitest";
import {
	PLAIN_TEXT,
	PYTHON_WHITESPACE,
	SINGLE_LINE,
	TextError,
	codePointLength,
	decoded,
	htmlUnescape,
	plainText,
	pythonRepr,
	pythonStrip,
	singleLine,
	sliceCodePoints,
	truncate,
	unquote,
} from "../../src/lib/text.ts";
import vectors from "./vectors.ts";

// Ported from backend/tests/test_contract.py, test_free_text_validators_draw_one_line_for_control_characters.
test("free-text validators draw one line for control characters", () => {
	for (let code = 0; code < 0x80; code++) {
		const char = String.fromCharCode(code);
		const control = code < 0x20 || code === 0x7f;
		for (const [check, allowed] of [
			[singleLine, !control],
			[plainText, !control || "\t\n\r".includes(char)],
		] as const) {
			if (allowed) {
				expect(check(`a${char}b`)).toBe(`a${char}b`);
			} else {
				expect(() => check(`a${char}b`)).toThrow(TextError);
			}
		}
	}
});

test("validators keep today's messages", () => {
	expect(() => singleLine("a\nb")).toThrow(SINGLE_LINE);
	expect(() => plainText("a\u0000b")).toThrow(PLAIN_TEXT);
	expect(SINGLE_LINE).toBe("must be a single line without control characters");
	expect(PLAIN_TEXT).toBe("must not contain control characters other than tabs and newlines");
});

describe("decoded matches connectors/text.py", () => {
	test.each(vectors.decoded)("$input", ({ input, output }) => {
		expect(decoded(input)).toBe(output);
	});
});

describe("unquote matches urllib.parse.unquote", () => {
	test.each(vectors.unquote)("$input", ({ input, output }) => {
		expect(unquote(input)).toBe(output);
	});
});

describe("htmlUnescape matches html.unescape", () => {
	test.each(vectors.unescape)("$input", ({ input, output }) => {
		expect(htmlUnescape(input)).toBe(output);
	});
});

describe("truncate cuts by code point, as Python slices", () => {
	test.each(vectors.truncate)("$input to $limit", ({ input, limit, output }) => {
		expect(truncate(input, limit)).toEqual(output);
	});

	test("never splits a surrogate pair", () => {
		const [cut, wasCut] = truncate("a\u{1f600}b", 2);
		expect(cut).toBe("a\u{1f600}");
		expect(wasCut).toBe(true);
		expect(cut.isWellFormed()).toBe(true);
	});
});

test("code point length and slices", () => {
	expect(codePointLength("a\u{1f600}é")).toBe(3);
	expect(sliceCodePoints("a\u{1f600}é", 1, 2)).toBe("\u{1f600}");
	expect(sliceCodePoints("a\u{1f600}é", -1)).toBe("é");
});

describe("pythonRepr matches repr(str)", () => {
	test.each(vectors.repr)("$output", ({ input, output }) => {
		expect(pythonRepr(input)).toBe(output);
	});

	test("a lone surrogate, which the vectors cannot hold", () => {
		expect(pythonRepr("\ud800")).toBe("'\\ud800'");
	});
});

describe("pythonStrip matches str.strip()", () => {
	test("the same whitespace", () => {
		expect([...PYTHON_WHITESPACE].sort((a, b) => a - b)).toEqual(vectors.isspace);
	});

	test.each(vectors.strip)("$input", ({ input, output }) => {
		expect(pythonStrip(input)).toBe(output);
	});
});
