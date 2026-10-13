import { describe, expect, test } from "vitest";
import { MAX_JSON_DEPTH, parseJson, parseModelJson } from "../../src/lib/json.ts";

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

describe("parseModelJson", () => {
	test("refuses lone surrogates and nesting deeper than 200", () => {
		const nested = (open: string, inner: string, close: string, count: number) => open.repeat(count) + inner + close.repeat(count);
		// [text, whether it is taken]
		const cases: [string, boolean][] = [
			['{"sub":"ok","x":"\\ud800","x":"ok"}', false],
			['{"sub":"ok","\\ud800":1,"\\ud800":2}', false],
			['{"x":"\\ud800\\udc00"}', true],
			['["\\udc00\\ud800"]', false],
			['["\\ud800x"]', false],
			['["\\\\ud800"]', true],
			['["\\"\\ud800"]', false],
			['["\\ud800\\n"]', false],
			['["a\\ud83d\\ude00b"]', true],
			[nested("[", "1", "]", 200), true],
			[nested("[", "1", "]", 201), false],
			[nested("[", "", "]", 201), true],
			[nested("[", "[]", "]", 201), false],
			[nested('{"a":', "{}", "}", 200), true],
			[nested('{"a":', "{}", "}", 201), false],
			[`[${nested("[", "", "]", 199)},1]`, true],
			[`[1,${nested("[", "1", "]", 200)}]`, false],
			[nested("[ ", "", " ]", 201), true],
			[nested("[\n", "\t1", "]", 200), true],
			[nested("[", nested('{"a":', "1", "}", 50), "]", 150), true],
			[nested("[", nested('{"a":', "1", "}", 51), "]", 150), false],
			[`[${'"[",'.repeat(300)}1]`, true],
		];
		const actual = cases.map(([text]) => {
			try {
				parseModelJson(text);
				return true;
			} catch (error) {
				expect(error).toBeInstanceOf(SyntaxError);
				return false;
			}
		});
		expect(actual).toEqual(cases.map(([, taken]) => taken));
	});
});
