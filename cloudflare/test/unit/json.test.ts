import { describe, expect, test } from "vitest";
import { MAX_JSON_DEPTH, canonicalAscii, canonicalUtf8, dumps, parseJson, pythonDumps, pythonFloat } from "../../src/lib/json.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { utf8Strict } from "../../src/lib/bytes.ts";
import vectors from "./vectors.ts";

describe("canonical JSON matches today's Python", () => {
	test("the variants are the ones the backend uses", () => {
		expect(vectors.variants.fingerprint).toEqual({ sort_keys: true, separators: [",", ":"], default: "str" });
		expect(vectors.variants.write_key).toEqual(vectors.variants.fingerprint);
		expect(vectors.variants.manifest_digest).toEqual({ sort_keys: true, separators: [",", ":"], ensure_ascii: false });
		expect(vectors.variants.credentials).toEqual({});
	});

	test.each(vectors.canonical)("$json", async (vector) => {
		const value = parseJson(vector.json);
		expect(canonicalAscii(value)).toBe(vector.ascii);
		expect(canonicalUtf8(value)).toBe(vector.utf8);
		expect(pythonDumps(value)).toBe(vector.default);
		expect(await sha256Hex(canonicalAscii(value))).toBe(vector.ascii_sha256);
		expect(await sha256Hex(utf8Strict(canonicalUtf8(value)))).toBe(vector.utf8_sha256);
	});

	test.each(vectors.floats)("repr($value)", ({ value, repr }) => {
		expect(pythonFloat(value)).toBe(repr);
	});
});

describe("dumps", () => {
	test("sorts keys by code point, not UTF-16 unit", () => {
		expect(canonicalUtf8({ "\uffff": 1, "\u{1f600}": 2 })).toBe('{"\uffff":1,"\u{1f600}":2}');
		expect(JSON.stringify(Object.fromEntries(Object.entries({ "\uffff": 1, "\u{1f600}": 2 }).sort()))).toBe('{"\u{1f600}":2,"\uffff":1}');
	});

	test("escapes as Python does", () => {
		expect(canonicalAscii("\u00e9\u{1f600}\u007f\u2028")).toBe('"\\u00e9\\ud83d\\ude00\\u007f\\u2028"');
		expect(canonicalUtf8("\u00e9\u{1f600}\u007f\u2028")).toBe('"\u00e9\u{1f600}\u007f\u2028"');
		expect(canonicalAscii("\ud800")).toBe('"\\ud800"');
	});

	test("leaves out undefined members and refuses what is not JSON", () => {
		expect(canonicalAscii({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(() => canonicalAscii([undefined])).toThrow(TypeError);
		expect(() => canonicalAscii([, 1])).toThrow(TypeError);
		expect(() => canonicalAscii(new Array(1))).toThrow(TypeError);
		expect(() => canonicalAscii(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalAscii(1n)).toThrow(TypeError);
		expect(() => canonicalAscii(new Date(0))).toThrow(TypeError);
		expect(() => canonicalAscii(new Map())).toThrow(TypeError);
	});

	test("writes integers as ints and other numbers as floats", () => {
		expect(canonicalAscii([1, -0, 2 ** 53 - 1, 2 ** 53, 0.5])).toBe("[1,0,9007199254740991,9007199254740992.0,0.5]");
	});

	test("uses Python's default separators unless compact", () => {
		expect(dumps({ b: [1, 2], a: null })).toBe('{"b": [1, 2], "a": null}');
		expect(dumps({ b: [1, 2], a: null }, { sortKeys: true, compact: true })).toBe('{"a":null,"b":[1,2]}');
	});

	test("a UTF-8 digest refuses lone surrogates, as str.encode() does", () => {
		expect(() => utf8Strict(canonicalUtf8({ path: "a\udc00" }))).toThrow(TypeError);
	});
});

describe("parseJson", () => {
	// A first key of its own gives the object shape one known transition, so the runtime's bug (lib/json.ts)
	// shows up whatever other tests have parsed.
	const shape = () => `k${Math.random().toString(36).slice(2)}`;
	const codes = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

	test("keys written with escapes come back right after a lone backslash key was parsed", () => {
		const first = shape();
		JSON.parse(`{"${first}":0,"\\\\":1}`);
		expect(Object.keys(parseJson(`{"${first}":0,"\\n":1}`) as object).map(codes)).toEqual([codes(first), [10]]);
		const second = shape();
		JSON.parse(`{"${second}":0,"ab\\\\":1}`);
		expect(Object.keys(parseJson(`{"${second}":0,"ab\\n":1,"\\u00e9":2}`) as object)).toEqual([second, "ab\n", "\u00e9"]);
	});

	test("hashes over parsed vectors match Python after poisoning", async () => {
		const vector = vectors.canonical.at(-1) as (typeof vectors.canonical)[number];
		JSON.parse('{"\\\\":1}');
		JSON.parse('{"ab\\\\":1}');
		expect(canonicalAscii(parseJson(vector.json))).toBe(vector.ascii);
		expect(await sha256Hex(utf8Strict(canonicalUtf8(parseJson(vector.json))))).toBe(vector.utf8_sha256);
	});

	test("agrees with JSON.parse on what it accepts and refuses", () => {
		const texts = [
			'{"a":[1,-0.5,2e3,true,false,null,"x\\ty"],"b":{}}',
			' [ ] ',
			'"\\ud800\\u2028"',
			'{"a":1,"a":2}',
			'{"x":"\\"","y":"\\\\"}',
			"-0",
			"1e400",
		];
		for (const text of texts) expect(parseJson(text), text).toEqual(JSON.parse(text));
		const invalid = ["", "{", '{"a"', '{"a":}', "[1,]", '{"a":1,}', "01", "1.", "-", '"\\x"', '"\u0001"', '"\\u12"', "tru", "[] x", '{"a" 1}', '"\\', '{"\\n":1', "\ufeff{}", "NaN", "[1 2]", '"a\\"'];
		for (const text of invalid) {
			expect(() => JSON.parse(text), text).toThrow(SyntaxError);
			expect(() => parseJson(text), text).toThrow(SyntaxError);
		}
	});

	test("keeps __proto__ an own property, as JSON.parse does", () => {
		const value = parseJson('{"__proto__":{"polluted":true},"\\n":1}') as Record<string, unknown>;
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.hasOwn(value, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("refuses nesting deeper than its limit", () => {
		const nested = (depth: number) => `["\\n",${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}]`;
		expect(() => parseJson(nested(MAX_JSON_DEPTH))).not.toThrow();
		expect(() => parseJson(nested(MAX_JSON_DEPTH + 1))).toThrow(SyntaxError);
		// Without a backslash the text takes the native path, which must keep the same bound.
		const plain = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
		expect(() => parseJson(plain(MAX_JSON_DEPTH))).not.toThrow();
		expect(() => parseJson(plain(MAX_JSON_DEPTH + 1))).toThrow(SyntaxError);
		expect(() => parseJson(`{"a":"${"[".repeat(MAX_JSON_DEPTH + 5)}"}`)).not.toThrow();
	});
});
