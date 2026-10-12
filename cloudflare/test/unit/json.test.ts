import { describe, expect, test } from "vitest";
import { MAX_JSON_DEPTH, parseJson, parseModelJson, pythonFloat, visibleJson } from "../../src/lib/json.ts";
import vectors from "./vectors.ts";

describe("visibleJson writes what the model and providers see as today's Python does", () => {
	test.each(vectors.canonical)("$json", (vector) => {
		expect(visibleJson(parseJson(vector.json))).toBe(vector.default);
	});

	test.each(vectors.floats)("repr($value)", ({ value, repr }) => {
		expect(pythonFloat(value)).toBe(repr);
	});

	test("sorts keys by code point, not UTF-16 unit, when asked", () => {
		expect(visibleJson({ "\uffff": 1, "\u{1f600}": 2 }, { sortKeys: true })).toBe('{"\\uffff": 1, "\\ud83d\\ude00": 2}');
		expect(visibleJson({ b: 1, a: 2 })).toBe('{"b": 1, "a": 2}');
	});

	test("escapes as Python does", () => {
		expect(visibleJson("\u00e9\u{1f600}\u007f\u2028")).toBe('"\\u00e9\\ud83d\\ude00\\u007f\\u2028"');
		expect(visibleJson("\ud800")).toBe('"\\ud800"');
	});

	test("leaves out undefined members and refuses what is not JSON", () => {
		expect(visibleJson({ a: undefined, b: 1 })).toBe('{"b": 1}');
		expect(() => visibleJson([undefined])).toThrow(TypeError);
		expect(() => visibleJson([, 1])).toThrow(TypeError);
		expect(() => visibleJson(new Array(1))).toThrow(TypeError);
		expect(() => visibleJson(Number.NaN)).toThrow(TypeError);
		expect(() => visibleJson(1n)).toThrow(TypeError);
		expect(() => visibleJson(new Date(0))).toThrow(TypeError);
		expect(() => visibleJson(new Map())).toThrow(TypeError);
	});

	test("writes integers as ints and other numbers as floats, with Python's default separators", () => {
		expect(visibleJson([1, -0, 2 ** 53 - 1, 2 ** 53, 0.5])).toBe("[1, 0, 9007199254740991, 9007199254740992.0, 0.5]");
		expect(visibleJson({ b: [1, 2], a: null })).toBe('{"b": [1, 2], "a": null}');
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

	test("parsed vectors are written as Python wrote them after poisoning", () => {
		const vector = vectors.canonical.at(-1) as (typeof vectors.canonical)[number];
		JSON.parse('{"\\\\":1}');
		JSON.parse('{"ab\\\\":1}');
		expect(visibleJson(parseJson(vector.json))).toBe(vector.default);
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

describe("parseModelJson reads what Pydantic's model_validate_json reads", () => {
	test("Python's answers for lone surrogates and nesting", () => {
		const nested = (open: string, inner: string, close: string, count: number) => open.repeat(count) + inner + close.repeat(count);
		// [text, whether TypeAdapter(Any).validate_json takes it]
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
