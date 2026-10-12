// JSON read and written for this port. Reading: `parseJson` replaces `JSON.parse` everywhere (see below).
// Writing: exactly as Python's `json.dumps` writes it, for hashes that must be stable and, where noted,
// equal to the ones today's Python computes. Each Python variant has a name here:
//
// | Function         | Python                                                                        | Used for |
// |------------------|-------------------------------------------------------------------------------|----------|
// | `canonicalAscii` | `json.dumps(x, sort_keys=True, separators=(",", ":"), default=str)`             | operation fingerprints (connectors/registry.py), write keys and query hashes (connectors/executor.py) |
// | `canonicalUtf8`  | `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`      | folder version digests (files/manifest.py), hashed as UTF-8 |
// | `pythonDumps`    | `json.dumps(x)`                                                               | credential plaintext before encryption (connections/crypto.py) |
//
// Values are plain JSON: null, booleans, finite numbers, strings, arrays and plain objects. An object
// member whose value is `undefined` is left out, as JSON.stringify does; anything else (undefined in an
// array, functions, bigints, dates, maps, NaN, infinities) throws, where Python would have called `str()`.
//
// Numbers. Python tells `1` (int) from `1.0` (float); a parsed JavaScript number cannot. Integers up to
// 2^53 are written as Python writes ints; every other number as Python writes floats (`repr`): `0.5`,
// `1e-07`, `1e+16`, `1.5e+300`. So a float that is integral and below 2^53, such as `2.0`, comes out as
// `2`, and an int of 2^53 or more as a float; neither occurs in the values these hashes cover. Worse,
// parsing has already rounded an integer beyond 2^53 before anything here sees it, so two different such
// integers would hash alike: inputs whose numbers can be that large (provider ids) declare them as
// strings. Byte equality with Python matters only for folder digests; fingerprints, write keys and query
// hashes need only be deterministic within the port (connectors spec 2.2, 7.3).
//
// Key order. Sorted output follows code points, as Python's does. Unsorted output (`pythonDumps`) follows
// JavaScript's property order, which puts integer-like keys first; Python keeps insertion order. The
// payloads written unsorted (credentials) have no such keys.

import { compareCodePoints } from "./order.ts";

export type Json = null | boolean | number | string | JsonArray | JsonObject;
export interface JsonArray extends Array<Json> {}
export interface JsonObject {
	[key: string]: Json;
}

/** Python's `isinstance(value, dict)` for a parsed JSON value. */
export function isDict(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness of a JSON value: null, false, 0, "", [] and {} are false. */
export function truthy(value: unknown): boolean {
	if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

export interface DumpOptions {
	/** Sort object keys by code point, as `sort_keys=True` does. */
	sortKeys?: boolean;
	/** `separators=(",", ":")` instead of Python's default `(", ", ": ")`. */
	compact?: boolean;
	/** Escape everything outside printable ASCII as `\uXXXX`, as `ensure_ascii=True` (the default) does. */
	ensureAscii?: boolean;
}

/** `json.dumps(value, **options)`. */
export function dumps(value: unknown, options: DumpOptions = {}): string {
	const out: string[] = [];
	write(value, out, {
		sortKeys: options.sortKeys ?? false,
		item: options.compact ? "," : ", ",
		key: options.compact ? ":" : ": ",
		ensureAscii: options.ensureAscii ?? true,
	});
	return out.join("");
}

/** Fingerprints, write keys and query hashes. */
export function canonicalAscii(value: unknown): string {
	return dumps(value, { sortKeys: true, compact: true, ensureAscii: true });
}

/**
 * Folder version digests. Hash the result's UTF-8 bytes (`utf8Strict` in bytes.ts refuses lone
 * surrogates, where Python's `str.encode()` raises).
 */
export function canonicalUtf8(value: unknown): string {
	return dumps(value, { sortKeys: true, compact: true, ensureAscii: false });
}

/** Python's default `json.dumps(value)`. */
export function pythonDumps(value: unknown): string {
	return dumps(value);
}

interface Format {
	sortKeys: boolean;
	item: string;
	key: string;
	ensureAscii: boolean;
}

function write(value: unknown, out: string[], format: Format): void {
	if (value === null) {
		out.push("null");
	} else if (value === true) {
		out.push("true");
	} else if (value === false) {
		out.push("false");
	} else if (typeof value === "number") {
		out.push(formatNumber(value));
	} else if (typeof value === "string") {
		out.push(quote(value, format.ensureAscii));
	} else if (Array.isArray(value)) {
		out.push("[");
		// Every index, so a hole in a sparse array throws like an explicit undefined.
		for (let index = 0; index < value.length; index++) {
			if (index > 0) out.push(format.item);
			const item: unknown = value[index];
			if (item === undefined) throw new TypeError("An array holds undefined, which is not JSON.");
			write(item, out, format);
		}
		out.push("]");
	} else if (isPlainObject(value)) {
		const keys = Object.keys(value).filter((key) => value[key] !== undefined);
		if (format.sortKeys) keys.sort(compareCodePoints);
		out.push("{");
		keys.forEach((key, index) => {
			if (index > 0) out.push(format.item);
			out.push(quote(key, format.ensureAscii), format.key);
			write(value[key], out, format);
		});
		out.push("}");
	} else {
		throw new TypeError(`A ${describe(value)} is not JSON.`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function describe(value: unknown): string {
	if (value === undefined) return "undefined value";
	if (typeof value === "object") return (value as object).constructor?.name ?? "object";
	return typeof value;
}

const ESCAPES: Record<string, string> = {
	'"': '\\"',
	"\\": "\\\\",
	"\b": "\\b",
	"\f": "\\f",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};

// Python's ESCAPE_ASCII is [\\"]|[^\ -~]: everything outside space to tilde, DEL included. ESCAPE (for
// ensure_ascii=False) is only quotes, backslashes and C0 controls.
const ASCII_UNSAFE = /["\\]|[^ -~]/g;
const UNSAFE = /["\\\u0000-\u001f]/g;

function quote(text: string, ensureAscii: boolean): string {
	const escaped = text.replace(ensureAscii ? ASCII_UNSAFE : UNSAFE, (char) => {
		return ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
	return `"${escaped}"`;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) throw new TypeError(`${value} is not JSON.`);
	if (Number.isSafeInteger(value)) return String(value === 0 ? 0 : value);
	return pythonFloat(value);
}

/**
 * `repr(float)`: the shortest digits that read back as the same double (JavaScript finds the same
 * ones), in fixed notation when the decimal exponent is in [-4, 16), else as `d.ddde±XX`.
 */
export function pythonFloat(value: number): string {
	if (!Number.isFinite(value)) throw new TypeError(`${value} is not a finite number.`);
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const sign = value < 0 ? "-" : "";
	const [mantissa = "", exponent = "0"] = Math.abs(value).toExponential().split("e");
	const digits = mantissa.replace(".", "");
	const point = Number(exponent) + 1; // digits are 0.d1d2... × 10^point
	if (point <= -4 || point > 16) {
		const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
		const power = point - 1;
		return `${sign}${digits[0]}${fraction}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
	}
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// Reading. V8's JSON parser (Node 24's V8 13.6 and workerd 1.20261006.1 alike) can return the wrong name
// for an object key written with an escape: it checks the key against the property name an earlier parse
// left on the same object shape by comparing the *raw* characters, so once any JSON text in the isolate
// had the key "\\" (a lone backslash), a later "\n", "\t" or "\u00e9" in the same place comes back as
// "\\", and "ab\\" captures "ab\n". The state is per isolate, so one tenant's input (tool arguments,
// say) can change how another's keys parse, and hashes over the result (write keys, query hashes) are not
// trustworthy. `JSON.parse`, `Response.json()` and `c.req.json()` are all affected; values are not, and
// neither are keys without escapes. test/platform/worker.test.ts keeps the bug visible.
//
// So every JSON text this port reads goes through `parseJson`: text with no backslash cannot hold an
// escaped key and goes to `JSON.parse`; other text is parsed here, with the structure walked in
// JavaScript, each string token decoded natively on its own (a lone string is not affected) and each key
// set by its decoded name. The grammar is JSON.parse's (no NaN or Infinity, which Python's `json.loads`
// accepts), duplicate keys keep the last value, as both do, and nesting deeper than 1,000 is refused, about
// where Python's recursion limit stops `json.loads`.

/** How deep arrays and objects may nest in `parseJson`. */
export const MAX_JSON_DEPTH = 1000;

/** `JSON.parse(text)`, without the runtime's escaped-key bug (above). Throws SyntaxError. */
export function parseJson(text: string): Json {
	if (!text.includes("\\")) {
		nestingWithin(text, MAX_JSON_DEPTH);
		return JSON.parse(text) as Json;
	}
	const parser = new Parser(text);
	parser.space();
	const value = parser.value(0);
	parser.space();
	if (parser.at < text.length) parser.fail("Unexpected data after the JSON value");
	return value;
}

/** How many non-empty arrays and objects may nest in the JSON Pydantic reads (jiter's recursion limit). */
export const MAX_MODEL_JSON_DEPTH = 200;

/**
 * The JSON text `model_validate_json` reads (already decoded from strict UTF-8, a byte order mark kept so
 * that it is refused): `parseJson`, then refused as jiter refuses it when any string token holds a lone
 * surrogate, keys and the values of keys repeated later included (which the parsed value no longer shows),
 * or when more than 200 non-empty arrays and objects nest (an empty one does not count). NaN and Infinity,
 * which jiter takes, stay refused as `parseJson` refuses them. Throws SyntaxError.
 */
export function parseModelJson(text: string): Json {
	const value = parseJson(text);
	const holds: boolean[] = [];
	let depth = 0;
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if (unit === 0x22) at = wellFormedString(text, at);
		else if (unit === 0x5b || unit === 0x7b) {
			let next = at + 1;
			while (isJsonSpace(text.charCodeAt(next))) next++;
			const empty = text.charCodeAt(next) === 0x5d || text.charCodeAt(next) === 0x7d;
			holds.push(!empty);
			if (!empty && ++depth > MAX_MODEL_JSON_DEPTH) throw new SyntaxError("Arrays and objects nest too deeply for the model.");
		} else if ((unit === 0x5d || unit === 0x7d) && holds.pop()) depth--;
	}
	return value;
}

function isJsonSpace(unit: number): boolean {
	return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
}

/** The index of the quote closing the string token opening at `start`; SyntaxError for a lone surrogate in it. */
function wellFormedString(text: string, start: number): number {
	let high = false;
	for (let at = start + 1; at < text.length; at++) {
		let unit = text.charCodeAt(at);
		if (unit === 0x22) {
			if (high) lone();
			return at;
		}
		if (unit === 0x5c) {
			unit = text.charCodeAt(++at);
			if (unit === 0x75) {
				unit = Number.parseInt(text.slice(at + 1, at + 5), 16);
				at += 4;
			}
		}
		const low = unit >= 0xdc00 && unit <= 0xdfff;
		if (high !== low) lone();
		high = !high && unit >= 0xd800 && unit <= 0xdbff;
	}
	throw new SyntaxError("Unterminated string.");
}

function lone(): never {
	throw new SyntaxError("A lone surrogate in a string.");
}

/**
 * Refuses text whose arrays and objects nest deeper than `limit`, as the parser below does, so the native
 * path cannot hand a deeper value to the recursive writers. Only for text without a backslash: its
 * strings hold no escapes, so every quote opens or closes one.
 */
function nestingWithin(text: string, limit: number): void {
	let depth = 0;
	let inString = false;
	for (let at = 0; at < text.length; at++) {
		const char = text.charCodeAt(at);
		if (char === 0x22) inString = !inString;
		else if (inString) continue;
		else if (char === 0x5b || char === 0x7b) {
			if (++depth > limit) throw new SyntaxError(`Too deeply nested at position ${at}`);
		} else if (char === 0x5d || char === 0x7d) depth--;
	}
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const PLAIN = /^[^\u0000-\u001f\\]*$/;

class Parser {
	readonly text: string;
	at = 0;

	constructor(text: string) {
		this.text = text;
	}

	fail(message: string): never {
		throw new SyntaxError(`${message} at position ${this.at}`);
	}

	space(): void {
		const text = this.text;
		for (;;) {
			const char = text.charCodeAt(this.at);
			if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) return;
			this.at++;
		}
	}

	value(depth: number): Json {
		const char = this.text[this.at];
		if (char === '"') return this.string();
		if (char === "{") return this.object(depth + 1);
		if (char === "[") return this.array(depth + 1);
		if (char === "t") return this.literal("true", true);
		if (char === "f") return this.literal("false", false);
		if (char === "n") return this.literal("null", null);
		return this.number();
	}

	literal<T extends Json>(word: string, value: T): T {
		if (!this.text.startsWith(word, this.at)) this.fail("Unexpected token");
		this.at += word.length;
		return value;
	}

	number(): number {
		NUMBER.lastIndex = this.at;
		const match = NUMBER.exec(this.text);
		if (!match) this.fail("Unexpected token");
		this.at += match[0].length;
		return Number(match[0]);
	}

	string(): string {
		const text = this.text;
		const start = this.at;
		let end = start;
		for (;;) {
			end = text.indexOf('"', end + 1);
			if (end < 0) this.fail("Unterminated string");
			let slashes = 0;
			while (text.charCodeAt(end - 1 - slashes) === 0x5c) slashes++;
			if (slashes % 2 === 0) break;
		}
		this.at = end + 1;
		const inner = text.slice(start + 1, end);
		if (PLAIN.test(inner)) return inner;
		// A lone string token: decoded natively, and checked for bad escapes and raw control characters.
		return JSON.parse(text.slice(start, end + 1)) as string;
	}

	array(depth: number): JsonArray {
		if (depth > MAX_JSON_DEPTH) this.fail("Too deeply nested");
		const items: JsonArray = [];
		this.at++;
		this.space();
		if (this.text[this.at] === "]") {
			this.at++;
			return items;
		}
		for (;;) {
			this.space();
			items.push(this.value(depth));
			this.space();
			const char = this.text[this.at++];
			if (char === "]") return items;
			if (char !== ",") this.fail("Expected ',' or ']'");
		}
	}

	object(depth: number): JsonObject {
		if (depth > MAX_JSON_DEPTH) this.fail("Too deeply nested");
		const members: JsonObject = {};
		this.at++;
		this.space();
		if (this.text[this.at] === "}") {
			this.at++;
			return members;
		}
		for (;;) {
			this.space();
			if (this.text[this.at] !== '"') this.fail("Expected a property name");
			const key = this.string();
			this.space();
			if (this.text[this.at++] !== ":") this.fail("Expected ':'");
			this.space();
			const value = this.value(depth);
			// As JSON.parse: an own property even for "__proto__", which assignment would turn into the prototype.
			if (key === "__proto__") Object.defineProperty(members, key, { value, writable: true, enumerable: true, configurable: true });
			else members[key] = value;
			this.space();
			const char = this.text[this.at++];
			if (char === "}") return members;
			if (char !== ",") this.fail("Expected ',' or '}'");
		}
	}
}

/**
 * The key the runtime's JSON.parse and `parseJson` give `"\n"` after `"\\"` was parsed in the same place,
 * as char codes: `native` is [92] while the bug lasts, `parseJson` is always [10]. For the platform test and
 * the deployed probe.
 */
export function escapedKeyCheck(): { native: number[]; parseJson: number[] } {
	// A first key of its own gives the shape exactly one transition, whatever the isolate parsed before.
	const shape = `probe${crypto.randomUUID().replaceAll("-", "")}`;
	const second = (value: Json) => Array.from(Object.keys(value as JsonObject)[1] ?? "", (char) => char.charCodeAt(0));
	JSON.parse(`{"${shape}":0,"\\\\":1}`);
	return { native: second(JSON.parse(`{"${shape}":0,"\\n":1}`) as Json), parseJson: second(parseJson(`{"${shape}":0,"\\n":1}`)) };
}
