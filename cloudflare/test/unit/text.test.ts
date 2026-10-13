import { describe, expect, test } from "vitest";
import { unescapeAttributeValue } from "../../src/lib/htmlparser.ts";
import { PLAIN_TEXT, SINGLE_LINE, TextError, decoded, htmlUnescape, plainText, segment, singleLine, sliceText, truncate, unquote } from "../../src/lib/text.ts";
import vectors from "./vectors.ts";

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

test("validators' messages", () => {
	expect(() => singleLine("a\nb")).toThrow(SINGLE_LINE);
	expect(() => plainText("a\u0000b")).toThrow(PLAIN_TEXT);
	expect(SINGLE_LINE).toBe("must be a single line without control characters");
	expect(PLAIN_TEXT).toBe("must not contain control characters other than tabs and newlines");
});

describe("decoded", () => {
	test.each(vectors.decoded)("$input", ({ input, output }) => {
		expect(decoded(input)).toBe(output);
	});
});

describe("unquote", () => {
	test.each(vectors.unquote)("$input", ({ input, output }) => {
		expect(unquote(input)).toBe(output);
	});
});

describe("segment", () => {
	test("encodes everything but unreserved characters, so an id stays one path segment", () => {
		expect(segment("a/b?#")).toBe("a%2Fb%3F%23");
		expect(segment("%41")).toBe("%2541");
		expect(segment("a b")).toBe("a%20b");
		expect(segment("ü")).toBe("%C3%BC");
		expect(segment("!'()*")).toBe("%21%27%28%29%2A");
		expect(segment("A-z_0.9~")).toBe("A-z_0.9~");
	});
});

describe("htmlUnescape", () => {
	test.each(vectors.unescape)("$input", ({ input, output }) => {
		expect(htmlUnescape(input)).toBe(output);
	});

	test("every code point as a numeric reference, in every spelling", () => {
		// The windows-1252 range, the noncharacters and the ends of Unicode, written out.
		const letters = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f];
		const more = [0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
		const expected = new Map<number, string>();
		for (let point = 0; point <= 0x10ffff; point++) {
			let text = String.fromCodePoint(point);
			if (point >= 0xd800 && point <= 0xdfff) text = "\ufffd";
			else if (point === 0) text = "\ufffd";
			else if (point >= 0x80 && point <= 0x8f) text = String.fromCodePoint(letters[point - 0x80] as number);
			else if (point >= 0x90 && point <= 0x9f) text = String.fromCodePoint(more[point - 0x90] as number);
			else if ((point >= 1 && point <= 8) || point === 0xb || (point >= 0xe && point <= 0x1f) || point === 0x7f) text = "";
			else if ((point >= 0xfdd0 && point <= 0xfdef) || (point & 0xfffe) === 0xfffe) text = "";
			expected.set(point, text);
		}
		const wrong: unknown[] = [];
		for (const [point, text] of expected) {
			for (const input of [`&#${point};`, `&#x${point.toString(16)};`, `&#X${point.toString(16).toUpperCase()}`, `&#${point}z`]) {
				const output = htmlUnescape(input);
				if (output !== (input.endsWith("z") ? `${text}z` : text)) wrong.push([input, output]);
			}
		}
		expect(wrong.slice(0, 5)).toEqual([]);
		expect(htmlUnescape("&#1114112;&#99999999999999999999;")).toBe("\ufffd\ufffd");
	});

	test("hostile references are decoded in about linear time", () => {
		const cases: [string, string][] = [
			["&amp;".repeat(1_000_000), "&".repeat(1_000_000)],
			["&a".repeat(1_000_000), "&a".repeat(1_000_000)],
			["&notit;".repeat(500_000), "\u00acit;".repeat(500_000)],
			["&#65;".repeat(500_000), "A".repeat(500_000)],
			[`&${"a".repeat(2_000_000)}`, `&${"a".repeat(2_000_000)}`],
			[`&#x${"f".repeat(1_000_000)};`, "\ufffd"],
		];
		const started = performance.now();
		for (const [input, output] of cases) expect(htmlUnescape(input) === output).toBe(true);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("an attribute value's references", () => {
	test.each(vectors.unescape_attribute)("$input", ({ input, output }) => {
		expect(unescapeAttributeValue(input)).toBe(output);
	});
});

describe("cutting text", () => {
	test("truncate counts UTF-16 units and never splits a surrogate pair", () => {
		expect(truncate("abc", 3)).toEqual(["abc", false]);
		expect(truncate("abcd", 3)).toEqual(["abc", true]);
		expect(truncate("a\u{1f600}b", 2)).toEqual(["a", true]);
		expect(truncate("a\u{1f600}b", 3)).toEqual(["a\u{1f600}", true]);
		expect(truncate(null, 3)).toEqual([null, false]);
	});

	test("sliceText moves both ends off the middle of a pair", () => {
		const text = "a\u{1f600}b\u{1f601}";
		expect(sliceText(text, 0, 2)).toBe("a");
		expect(sliceText(text, 2, 4)).toBe("\u{1f600}b");
		expect(sliceText(text, 2)).toBe("\u{1f600}b\u{1f601}");
		// Pages cut at the same offsets join back to the text.
		expect(sliceText(text, 0, 2) + sliceText(text, 2, 5) + sliceText(text, 5)).toBe(text);
	});
});
