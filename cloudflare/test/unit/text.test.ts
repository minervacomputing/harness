import { describe, expect, test } from "vitest";
import { OperationError } from "../../src/gateway/connector.ts";
import { segment } from "../../src/gateway/http.ts";
import { publicError } from "../../src/gateway/results.ts";
import { PLAIN_TEXT, SINGLE_LINE, TextError, browserAddress, decodeCharacterReferences, decoded, percentDecode, percentEncode, plainText, singleLine, sliceText, truncate } from "../../src/lib/text.ts";

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
	test.each([
		// Every encoding that could hide a dot in an address, undone.
		["[x](https://linear%2eapp/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["[x](https://linear&#46;app/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["[x](https://linear\\.app/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["[x](https://linear\u3002app/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["[x](https://\uff4c\uff49\uff4e\uff45\uff41\uff52.app/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["[x](https://linear\u200b.app/acme/issue/OPS-1)", "[x](https://linear.app/acme/issue/OPS-1)"],
		["https://linear.app/acme/issue/ENG-1/%2e%2e", "https://linear.app/acme/issue/ENG-1/.."],
		["acme.slack&#46;com/archives", "acme.slack.com/archives"],
		["acme.slack\u200b.com", "acme.slack.com"],
		// Three rounds, so twice-encoded text is undone, and no more.
		["linear%252eapp", "linear.app"],
		["linear%25252eapp", "linear.app"],
		["linear%2525252eapp", "linear%2eapp"],
		["linear&amp;#46;app", "linear.app"],
		["linear&amp;amp;#46;app", "linear.app"],
		["%26%2346%3B", "."],
		["\ufeffstart and \u00e9nd", "start and \u00e9nd"],
		["\u2460 \ufb01 \u00bd", "1 fi 1\u20442"],
		["plain text, nothing encoded", "plain text, nothing encoded"],
		["100% sure & then some", "100% sure & then some"],
		["&lt;img src=x&gt;", "<img src=x>"],
		// NFKC reads lookalikes as ASCII, so a scheme is never tested on this (browserAddress).
		["http\u017f://example.com", "https://example.com"],
		["\uff48\uff54\uff54\uff50\uff53://example.com", "https://example.com"],
	])("%j", (input, output) => {
		expect(decoded(input)).toBe(output);
	});
});

describe("browserAddress", () => {
	test.each([
		[" \u0000https://example.com/\u001f ", "https://example.com/"],
		["ht\ttps://exa\nmple.com/\r", "https://example.com/"],
		// Nothing else is undone: these schemes stay what a browser sees, which is no scheme at all.
		["http\u017f://example.com", "http\u017f://example.com"],
		["%68ttps://example.com", "%68ttps://example.com"],
		["&#104;ttps://example.com", "&#104;ttps://example.com"],
		["\u3000https://example.com", "\u3000https://example.com"],
		["\u200bhttps://example.com", "\u200bhttps://example.com"],
	])("%j", (input, output) => {
		expect(browserAddress(input)).toBe(output);
		// What the URL parser makes of it agrees: an absolute https address only when the form starts with one.
		const parsed = new URL(input, "https://base.example/page");
		expect(parsed.host === "example.com", input).toBe(output.startsWith("https://"));
	});
});

describe("percentDecode", () => {
	test.each([
		["a%20b", "a b"],
		["%E2%82%AC", "\u20ac"],
		["%e2%82", "\ufffd"],
		["%zz", "%zz"],
		["100%", "100%"],
		["%", "%"],
		["%%41", "%A"],
		["caf%C3%A9 \u00e9 %C3", "caf\u00e9 \u00e9 \ufffd"],
		["\u00e9%41", "\u00e9A"],
		["%F0%9F%98%80", "\u{1f600}"],
		["%ff%fe", "\ufffd\ufffd"],
		["a+b", "a+b"],
		["%2", "%2"],
		["%41%", "A%"],
	])("%j", (input, output) => {
		expect(percentDecode(input)).toBe(output);
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
		expect(segment("...")).toBe("...");
		expect(segment("%2e%2e")).toBe("%252e%252e");
	});

	test("refuses an empty id, \".\" and \"..\", which the URL parser would drop or step up with, as invalid arguments", () => {
		for (const value of ["", ".", ".."]) {
			expect(() => segment(value), JSON.stringify(value)).toThrow(OperationError);
			expect(publicError(catchError(() => segment(value)))).toEqual({ code: "INVALID_ARGUMENTS", message: `${JSON.stringify(value)} is not a valid id or name.` });
		}
		expect(new URL(`https://api.example.com/repos/acme/${percentEncode("..")}`).pathname).toBe("/repos/");
	});

	test("percentEncode leaves dots alone, for text inside a segment", () => {
		expect(percentEncode("..")).toBe("..");
		expect(percentEncode("it's")).toBe("it%27s");
	});
});

function catchError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("did not throw");
}

describe("decodeCharacterReferences", () => {
	test.each([
		["&amp;", "&"],
		["&amp", "&"],
		["&ampx", "&x"],
		["&AMP", "&"],
		["&Amp;", "&Amp;"],
		["&lt;b&gt;", "<b>"],
		["&lt=", "<="],
		["a&amp;b&lt;c&gt;\n&quot;&apos;", "a&b<c>\n\"'"],
		["&#46;&#x2e;&#X2E", "..."],
		["&#00000065", "A"],
		["&#X41g&#65a&#6g", "AgAa\u0006g"],
		// A control is kept; `decoded` removes invisible characters itself.
		["&#1;&#x7f;&#xFDD0;", "\u0001\u007f\ufdd0"],
		["&#;&#x;&#xg;", "&#;&#x;&#xg;"],
		["&#x41;;", "A;"],
		// Without ";", the longest name that starts the reference, if it may end that way.
		["&notit;", "\u00acit;"],
		["&notin;", "\u2209"],
		["&notinx", "\u00acinx"],
		["&nbsp&nbsp;", "\u00a0\u00a0"],
		["&copy2", "\u00a92"],
		["&AElig&aeligx", "\u00c6\u00e6x"],
		["&isin;&isinv;&isinvx", "\u2208\u2208&isinvx"],
		["&Gt;&GT;&gt;&Gt", "\u226b>>&Gt"],
		["&lsquo;&LSQUO&rsquo", "\u2018&LSQUO&rsquo"],
		["&NotEqualTilde;", "\u2242\u0338"],
		// Names that are not entities stay, the properties of Object.prototype included.
		["&nosuchentity;", "&nosuchentity;"],
		["&constructor;&__proto__;&toString", "&constructor;&__proto__;&toString"],
		["&\u{1f600};&\u00e9;", "&\u{1f600};&\u00e9;"],
		[`&${"a".repeat(40)};`, `&${"a".repeat(40)};`],
		["a & b", "a & b"],
		["&&amp;&amp&", "&&&&"],
		// One round only.
		["&amp;amp;&#38;#38;&amp;#38;", "&amp;&#38;&#38;"],
		["&\t&amp;", "&\t&"],
	])("%j", (input, output) => {
		expect(decodeCharacterReferences(input)).toBe(output);
	});

	test("every code point as a numeric reference, in every spelling", () => {
		// The windows-1252 range, NUL, the surrogates and the ends of Unicode, written out; every other code point is itself.
		const letters = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f];
		const more = [0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
		const expected = new Map<number, string>();
		for (let point = 0; point <= 0x10ffff; point++) {
			let text = String.fromCodePoint(point);
			if (point >= 0xd800 && point <= 0xdfff) text = "\ufffd";
			else if (point === 0) text = "\ufffd";
			else if (point >= 0x80 && point <= 0x8f) text = String.fromCodePoint(letters[point - 0x80] as number);
			else if (point >= 0x90 && point <= 0x9f) text = String.fromCodePoint(more[point - 0x90] as number);
			expected.set(point, text);
		}
		const wrong: unknown[] = [];
		for (const [point, text] of expected) {
			for (const input of [`&#${point};`, `&#x${point.toString(16)};`, `&#X${point.toString(16).toUpperCase()}`, `&#${point}z`]) {
				const output = decodeCharacterReferences(input);
				if (output !== (input.endsWith("z") ? `${text}z` : text)) wrong.push([input, output]);
			}
		}
		expect(wrong.slice(0, 5)).toEqual([]);
		expect(decodeCharacterReferences("&#1114112;&#99999999999999999999;")).toBe("\ufffd\ufffd");
	}, 30_000); // Every code point, in each spelling: over 5 s on CI's two cores.

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
		for (const [input, output] of cases) expect(decodeCharacterReferences(input) === output).toBe(true);
		expect(performance.now() - started).toBeLessThan(5000);
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
