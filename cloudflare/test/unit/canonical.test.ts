// Canonical JSON (lib/canonical.ts): RFC 8785's own test data and number vectors, the domain it refuses,
// and the labels hashes cover.

import { describe, expect, test } from "vitest";
import { type HashPurpose, canonicalJson, hashInput, hashLabel } from "../../src/lib/canonical.ts";
import { parseJson } from "../../src/lib/json.ts";
import jcs from "../fixtures/jcs-vectors.json" with { type: "json" };

describe("RFC 8785", () => {
	test.each(jcs.cases)("$name", ({ input, output }) => {
		expect(canonicalJson(parseJson(input))).toBe(output);
		// What is written reads back as the same value.
		expect(canonicalJson(parseJson(output))).toBe(output);
	});

	// Appendix B: IEEE 754 doubles (as hex) and how JCS writes them.
	const numbers: [string, string][] = [
		["0000000000000000", "0"],
		["8000000000000000", "0"],
		["0000000000000001", "5e-324"],
		["8000000000000001", "-5e-324"],
		["7fefffffffffffff", "1.7976931348623157e+308"],
		["ffefffffffffffff", "-1.7976931348623157e+308"],
		["4340000000000000", "9007199254740992"],
		["c340000000000000", "-9007199254740992"],
		["4430000000000000", "295147905179352830000"],
		["44b52d02c7e14af5", "9.999999999999997e+22"],
		["44b52d02c7e14af6", "1e+23"],
		["44b52d02c7e14af7", "1.0000000000000001e+23"],
		["444b1ae4d6e2ef4e", "999999999999999700000"],
		["444b1ae4d6e2ef4f", "999999999999999900000"],
		["444b1ae4d6e2ef50", "1e+21"],
		["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
		["3eb0c6f7a0b5ed8d", "0.000001"],
		["41b3de4355555553", "333333333.3333332"],
		["41b3de4355555554", "333333333.33333325"],
		["41b3de4355555555", "333333333.3333333"],
		["41b3de4355555556", "333333333.3333334"],
		["41b3de4355555557", "333333333.33333343"],
		["becbf647612f3696", "-0.0000033333333333333333"],
		["43143ff3c1cb0959", "1424953923781206.2"],
	];
	test.each(numbers)("the double %s is %s", (bits, text) => {
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, BigInt(`0x${bits}`));
		expect(canonicalJson(view.getFloat64(0))).toBe(text);
	});

	test("NaN and the infinities are not JSON", () => {
		for (const bits of ["7fffffffffffffff", "7ff0000000000000", "fff0000000000000"]) {
			const view = new DataView(new ArrayBuffer(8));
			view.setBigUint64(0, BigInt(`0x${bits}`));
			expect(() => canonicalJson(view.getFloat64(0)), bits).toThrow(TypeError);
		}
	});

	test("keys sort by UTF-16 code unit, and Unicode is not normalized", () => {
		expect(canonicalJson({ "￿": 1, "\u{1f600}": 2, "é": 3, e: 4 })).toBe('{"e":4,"é":3,"\u{1f600}":2,"￿":1}');
		expect(canonicalJson("é")).not.toBe(canonicalJson("é"));
		expect(canonicalJson("\u0000\u001f\u007f </script>")).toBe('"\\u0000\\u001f\u007f </script>"');
	});
});

describe("the domain: parsed JSON and plain objects, nothing coerced", () => {
	test("accepts what parseJson returns and plain objects, __proto__ an ordinary key", () => {
		const parsed = parseJson('{"__proto__":{"a":1},"b":[true,null,-0,0.5,"x"]}');
		expect(canonicalJson(parsed)).toBe('{"__proto__":{"a":1},"b":[true,null,0,0.5,"x"]}');
		const bare = Object.assign(Object.create(null) as object, { b: 1, a: 2 });
		expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
		// A value reached twice is not a cycle.
		const shared = { x: 1 };
		expect(canonicalJson([shared, { y: shared }])).toBe('[{"x":1},{"y":{"x":1}}]');
		expect(canonicalJson(parseJson('{"toJSON":"not a function"}'))).toBe('{"toJSON":"not a function"}');
	});

	test("refuses undefined anywhere, where JSON.stringify would drop it or write null", () => {
		expect(JSON.stringify({ a: undefined })).toBe("{}");
		expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
		expect(() => canonicalJson([undefined])).toThrow(TypeError);
		expect(() => canonicalJson([, 1])).toThrow(TypeError);
		expect(() => canonicalJson(new Array(2))).toThrow(TypeError);
		expect(() => canonicalJson(undefined)).toThrow(TypeError);
	});

	test("refuses what is not plain JSON", () => {
		class Point {
			x = 1;
		}
		class List extends Array<number> {}
		const refused: unknown[] = [
			() => 1,
			Symbol("s"),
			1n,
			new Number(1),
			new String("a"),
			new Boolean(true),
			new Date(0),
			new Map([["a", 1]]),
			new Set([1]),
			new Point(),
			List.from([1]),
			new Uint8Array(1),
			{ toJSON: () => "x" },
			{ [Symbol("k")]: 1 },
			{ a: () => 1 },
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		for (const value of refused) expect(() => canonicalJson({ v: value }), String(typeof value)).toThrow(TypeError);
	});

	test("reads each property once and calls no toJSON: getters, setters and hidden properties are refused", () => {
		let reads = 0;
		const getter = {
			get authorized() {
				reads++;
				return reads === 1 ? "A" : "B";
			},
		};
		expect(() => canonicalJson(getter)).toThrow(TypeError);
		expect(reads).toBe(0);
		expect(() => canonicalJson({ a: Object.defineProperty({}, "x", { set: () => {}, enumerable: true }) })).toThrow(TypeError);
		const indexed = [1];
		Object.defineProperty(indexed, 0, { get: () => 2, enumerable: true });
		expect(() => canonicalJson(indexed)).toThrow(TypeError);
		const hidden = Object.defineProperty({ authorized: "A" }, "toJSON", { value: () => ({ authorized: "B" }) });
		expect(() => canonicalJson(hidden)).toThrow(TypeError);
		expect(() => canonicalJson(Object.defineProperty({}, "a", { value: 1 }))).toThrow(TypeError);
		// A non-plain object is refused without reading it.
		let touched = false;
		const odd = Object.create({
			get constructor() {
				touched = true;
				return Object;
			},
		}) as object;
		expect(() => canonicalJson(odd)).toThrow(TypeError);
		expect(touched).toBe(false);
	});

	test("an array holds its indices only, so it cannot hash like a plain one", () => {
		const arrays: unknown[][] = [
			Object.assign([1], { foo: 2 }),
			Object.assign([1], { [Symbol("k")]: 2 }),
			Object.defineProperty([1], "toJSON", { value: () => [2] }),
			Object.defineProperty([1, 2], 1, { value: 2, enumerable: false }),
		];
		for (const array of arrays) expect(() => canonicalJson(array)).toThrow(TypeError);
		expect(canonicalJson([1, [2]])).toBe("[1,[2]]");
	});

	test("a toJSON added to Object.prototype or Array.prototype changes nothing", () => {
		const value = parseJson('{"a":[1,{"b":2}],"toJSON":"text"}');
		const expected = '{"a":[1,{"b":2}],"toJSON":"text"}';
		const prototypes = [Object.prototype, Array.prototype] as unknown as Record<string, unknown>[];
		for (const prototype of prototypes) {
			Object.defineProperty(prototype, "toJSON", { value: () => "polluted", configurable: true, writable: true });
			try {
				expect(canonicalJson(value)).toBe(expected);
				expect(hashInput("query", value)).toBe(`minerva:query:${expected}`);
			} finally {
				delete prototype.toJSON;
			}
		}
		expect(canonicalJson(value)).toBe(expected);
	});

	test("refuses lone surrogates in strings and keys", () => {
		for (const text of ["\ud800", "a\udc00", "\udc00\ud800"]) {
			expect(() => canonicalJson(text)).toThrow(TypeError);
			expect(() => canonicalJson({ [text]: 1 })).toThrow(TypeError);
		}
		expect(canonicalJson("😀")).toBe('"\u{1f600}"');
	});

	test("refuses cycles and nesting deeper than parseJson reads", () => {
		const cycle: { [key: string]: unknown } = {};
		cycle.self = cycle;
		expect(() => canonicalJson(cycle)).toThrow(TypeError);
		const array: unknown[] = [];
		array.push(array);
		expect(() => canonicalJson(array)).toThrow(TypeError);
		const nested = (depth: number) => JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`) as unknown;
		expect(() => canonicalJson(nested(1000))).not.toThrow();
		expect(() => canonicalJson(nested(5000))).toThrow(TypeError);
	});

	test("an identity refuses integers beyond ±(2^53 − 1), which parsing has already rounded", () => {
		expect(canonicalJson(2 ** 53)).toBe("9007199254740992");
		expect(canonicalJson(Number.MAX_SAFE_INTEGER, { identity: true })).toBe("9007199254740991");
		expect(canonicalJson(Number.MIN_SAFE_INTEGER, { identity: true })).toBe("-9007199254740991");
		expect(canonicalJson(0.1, { identity: true })).toBe("0.1");
		for (const value of [2 ** 53, -(2 ** 53), 1e21, -1e300, parseJson("12345678901234567890")]) {
			expect(() => canonicalJson({ id: value }, { identity: true }), String(value)).toThrow(TypeError);
		}
	});
});

describe("hash inputs", () => {
	test("start with their purpose's label, then the canonical JSON", () => {
		expect(hashInput("write-key", { b: 1, a: [2] })).toBe('minerva:write-key:{"a":[2],"b":1}');
		const purposes: HashPurpose[] = ["write-key", "query", "operation", "folder-version", "catalog"];
		const labels = purposes.map(hashLabel);
		expect(new Set(labels).size).toBe(purposes.length);
		// No label is a prefix of another, so equal JSON under two purposes never gives the same input.
		for (const a of labels) for (const b of labels) if (a !== b) expect(b.startsWith(a)).toBe(false);
		expect(() => hashInput("query", { id: 2 ** 60 })).toThrow(TypeError);
	});
});
