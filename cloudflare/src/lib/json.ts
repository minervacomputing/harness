// JSON values, and reading JSON text: `parseJson` replaces `JSON.parse` everywhere (see below). Writing is
// `JSON.stringify`; hashed and encrypted values use lib/canonical.ts's canonical JSON instead.

export type Json = null | boolean | number | string | JsonArray | JsonObject;
export interface JsonArray extends Array<Json> {}
export interface JsonObject {
	[key: string]: Json;
}

/** Whether a parsed JSON value is an object (not an array or null). */
export function isDict(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON value is non-empty: null, false, 0, "", [] and {} are not. */
export function truthy(value: unknown): boolean {
	if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
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
// So every JSON text Minerva reads goes through `parseJson`: text with no backslash cannot hold an
// escaped key and goes to `JSON.parse`; other text is parsed here, with the structure walked in
// JavaScript, each string token decoded natively on its own (a lone string is not affected) and each key
// set by its decoded name. The grammar is JSON.parse's, duplicate keys keep the last value, and nesting
// deeper than 1,000 is refused.

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
