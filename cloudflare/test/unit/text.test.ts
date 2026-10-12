import { createHash } from "node:crypto";
import { DecodingMode, EntityDecoder, decodeHTML, htmlDecodeTree } from "entities/decode";
import { describe, expect, test } from "vitest";
import { unescapeAttributeValue } from "../../src/lib/htmlparser.ts";
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

	test("every code point as a numeric reference, in every spelling", () => {
		// Python's answers for the windows-1252 range, the noncharacters and the ends of Unicode, written out.
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

	test("the package holds the names and values of Python's html.entities.html5, and no others", () => {
		// The names that end in ";" are found by walking the package's table: a prefix that needs more input is
		// a path, a complete one a name. A name without ";" is one that decodes before a character that ends it.
		const found = new Map<string, string>();
		const queue = [""];
		while (queue.length > 0) {
			const prefix = queue.shift() as string;
			for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;") {
				if (letter === ";" && prefix === "") continue;
				const name = prefix + letter;
				let value = "";
				const decoder = new EntityDecoder(htmlDecodeTree, (point) => (value += String.fromCodePoint(point)));
				decoder.startEntity(DecodingMode.Strict);
				const consumed = decoder.write(`&${name}`, 1);
				if (consumed > 0) found.set(name, value);
				else if (consumed < 0 && letter !== ";") queue.push(name);
			}
		}
		const table = new Map<string, string>(found);
		for (const [name, value] of found) if (decodeHTML(`&${name.slice(0, -1)}\u0000`) === `${value}\u0000`) table.set(name.slice(0, -1), value);
		const lines = [...table.keys()]
			.sort()
			.map((name) => `${name}\t${[...(table.get(name) as string)].map((c) => (c.codePointAt(0) as number).toString(16)).join(" ")}\n`)
			.join("");
		const without = [...table.keys()].filter((name) => !name.endsWith(";")).length;
		expect({ names: table.size, without_semicolon: without }).toEqual({
			names: vectors.entities.names,
			without_semicolon: vectors.entities.without_semicolon,
		});
		expect(createHash("sha256").update(lines).digest("hex")).toBe(vectors.entities.sha256);
	});
});

describe("an attribute value's references are read as html.parser reads them", () => {
	test.each(vectors.unescape_attribute)("$input", ({ input, output }) => {
		expect(unescapeAttributeValue(input)).toBe(output);
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
