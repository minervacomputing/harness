// The guest's prelude (harness 7.3, 17.7): what a script sees inside its Dynamic Worker, ported from
// pi-codemode 1.0.4's prelude (MIT, Earendil Works), which today's `run_script` runs in QuickJS. The
// script is the body of an async arrow function in a CommonJS module (`codemode.js`), so it runs sloppy, as
// today's `(async (tools, console) => {…})` did at QuickJS's top level, and its first line shares the
// wrapper's, so line numbers match the code's. The CommonJS wrapper's `require`, `module`, `exports`,
// `__filename` and `__dirname` are shadowed.
//
// As today, before the script runs the prelude defines `tools` (each tool as `tools.<identifier>` and
// `tools["<name>"]`; reading a missing one throws with the close matches), `ALL_TOOLS`, `text`, `image`,
// `exit`, `console.log/info/warn/error/debug` and synchronous `store`/`load` over a snapshot as read-only
// globals, then freezes every built-in it can reach and makes the built-in globals read-only (pi-codemode's
// lockdown, with the "override mistake" fixed for the usual properties). Unlike today, the platform's own
// globals remain: timers work, `fetch` and `connect` throw (`globalOutbound: null`), and `eval` throws (the
// platform refuses code generation).
//
// Nothing here is trusted: the host (scripts/session.ts) applies every bound again and the Scripts object
// checks every answer (scripts/outcome.ts); the prelude only gives an honest script today's semantics. Its
// one capability is `host`, the RpcTarget the conversation made for this script: `host.call(name, json)`
// answers `{ok, value}` or `{ok: false, message}`, and `host.print(items)` takes printed output in batches
// (one batch in flight, the rest sent when it settles, before every tool call and at the end), so what a
// script printed reaches the host even when it is stopped for time; what it prints while it computes
// without yielding is lost when the platform stops it for CPU or memory. A long output or value crosses as
// its head and the size of the rest (scripts/output.ts).
//
// `run()` answers `{ok: true, value, writes, unsettled}` or `{ok: false, error, unsettled}`: `value` is the
// returned value's text (a string as is, else its JSON; a value JSON cannot write fails the script, as
// today), `writes` the keys the script stored (`[key, json]`) or deleted (`[key]`), and `unsettled` the calls
// it started that had not settled, which counts calls started just before it returned that never reached
// the host.
//
// `load()` reads stored JSON with a port of lib/json.ts's reader for text with a backslash, since the
// runtime's JSON.parse can return a wrong key after it read the key "\\" (lib/json.ts). It takes the
// native parser from JSON once, outside the literal call src/ refuses outside lib/json.ts (a unit test).

import {
	ERROR_CHARS,
	HEAD_CHARS,
	IMAGE_OMITTED,
	MAX_OUTPUT_CHARS,
	MAX_OUTPUT_ITEMS,
	MAX_STORE_TOTAL_CHARS,
	MAX_STORE_VALUE_CHARS,
	OUTPUT_LIMIT,
	PRELUDE_MODULE,
	SCRIPT_MODULE,
} from "./limits.ts";

const IMAGE_HELPER_EXPECTS = "image expects a non-empty image URL string, an object with image_url, or a raw MCP image block";

/** Print items per batch, so a batch stays far under Workers RPC's 32 MiB. */
export const PRINT_BATCH = 10_000;

/**
 * The prelude's logic, an expression: `(host, script, tools, storeEntries) => Promise<answer>`, where
 * `script()` returns the script's function and `tools` lists `{name, identifier}`. A plain function, so the
 * unit tests can run it in Node with a fake host.
 */
export const GUEST_CORE = String.raw`(function (host, script, toolList, storeEntries) {
	"use strict";
	const stringify = JSON.stringify;
	const { parse: parseNative } = JSON;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const RangeErrorCtor = RangeError;
	const SyntaxErrorCtor = SyntaxError;
	const PromiseCtor = Promise;
	const promiseThen = Promise.prototype.then;
	const freeze = Object.freeze;
	const defineProperty = Object.defineProperty;
	// Thrown by exit() to unwind the script after it already reported success.
	const EXIT = freeze({});

	// Freeze every object reachable from the built-in globals, plus the intrinsics that are only reachable
	// from instances (pi-codemode's lockdown). Freezing alone breaks ordinary code through the "override
	// mistake": a data property that is read-only on a prototype cannot be assigned on an instance either,
	// so commonly overridden properties become accessors whose setter defines an own property on the
	// instance instead. What the platform does not let be frozen or redefined is left as it is.
	function lockdown() {
		const OVERRIDABLE = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
		const seen = new Set([globalThis]);
		const queue = [];
		const add = (value) => {
			if (((typeof value === "object" && value !== null) || typeof value === "function") && !seen.has(value)) {
				seen.add(value);
				queue.push(value);
			}
		};
		function allowOverride(object, key, value, enumerable) {
			const { get, set } = Object.getOwnPropertyDescriptor(
				{
					get accessor() {
						return value;
					},
					set accessor(next) {
						if (this === object) throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
						if ((typeof this !== "object" || this === null) && typeof this !== "function") return;
						Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
					},
				},
				"accessor",
			);
			try {
				Object.defineProperty(object, key, { get, set, enumerable, configurable: false });
			} catch {
				return;
			}
			add(get);
			add(set);
		}
		for (const key of Reflect.ownKeys(globalThis)) {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			if (!descriptor) continue;
			add(descriptor.value);
			add(descriptor.get);
			add(descriptor.set);
			if ("value" in descriptor && descriptor.configurable) {
				try {
					Object.defineProperty(globalThis, key, { writable: false, configurable: false });
				} catch {}
			}
		}
		add(Object.getPrototypeOf(function* () {}));
		add(Object.getPrototypeOf(async function () {}));
		add(Object.getPrototypeOf(async function* () {}));
		add(Object.getPrototypeOf(Int8Array));
		add(Object.getPrototypeOf([][Symbol.iterator]()));
		add(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
		add(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
		add(Object.getPrototypeOf(""[Symbol.iterator]()));
		add(Object.getPrototypeOf(/a/[Symbol.matchAll]("")));
		if (typeof Iterator === "function") {
			if (typeof Iterator.prototype.map === "function") add(Object.getPrototypeOf([].values().map((x) => x)));
			if (typeof Iterator.from === "function") add(Object.getPrototypeOf(Iterator.from({ next() {} })));
		}
		while (queue.length > 0) {
			const object = queue.pop();
			add(Object.getPrototypeOf(object));
			const descriptors = Object.getOwnPropertyDescriptors(object);
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key];
				if ("value" in descriptor) {
					add(descriptor.value);
					if (descriptor.writable && descriptor.configurable && (object === Object.prototype || OVERRIDABLE.has(key))) {
						allowOverride(object, key, descriptor.value, descriptor.enumerable);
					}
				} else {
					add(descriptor.get);
					add(descriptor.set);
				}
			}
			try {
				Object.freeze(object);
			} catch {}
		}
	}

	let finished = false;
	let resolveRun;
	const answered = new PromiseCtor((resolve) => {
		resolveRun = resolve;
	});
	let unsettled = 0;

	// UTF-8 sizes, as TextEncoder writes them (a lone surrogate is U+FFFD's three bytes).
	function sizeOfText(text) {
		let bytes = 0;
		let newlines = 0;
		for (let at = 0; at < text.length; at++) {
			const unit = text.charCodeAt(at);
			if (unit < 0x80) {
				bytes += 1;
				if (unit === 0x0a) newlines++;
			} else if (unit < 0x800) bytes += 2;
			else if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length && text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff) {
				bytes += 4;
				at++;
			} else bytes += 3;
		}
		return { bytes, newlines, last: text.length > 0 && text.charCodeAt(text.length - 1) === 0x0a };
	}
	function headOf(text, units) {
		if (text.length <= units) return text;
		let end = units;
		const before = text.charCodeAt(end - 1);
		if (end > 0 && before >= 0xd800 && before <= 0xdbff) end--;
		return text.slice(0, end);
	}
	// A long text crosses as its head and the size of the rest.
	function crossing(text, units) {
		const head = headOf(text, units);
		return head.length === text.length ? { text } : { text: head, rest: sizeOfText(text.slice(head.length)) };
	}

	// Output, in batches: one print in flight, the rest sent when it settles, before a tool call and at the end.
	let pending = [];
	let inFlight = 0;
	let scheduled = false;
	let headLeft = ${HEAD_CHARS};
	const sent = [];
	function send() {
		if (pending.length === 0) return;
		const items = pending.length > ${PRINT_BATCH} ? pending.splice(0, ${PRINT_BATCH}) : pending;
		if (items === pending) pending = [];
		let promise;
		try {
			promise = PromiseCtor.resolve(host.print(items));
		} catch {
			return;
		}
		inFlight++;
		const settled = promiseThen.call(
			promise,
			() => {},
			() => {},
		);
		sent.push(settled);
		promiseThen.call(settled, () => {
			inFlight--;
			if (inFlight === 0 && !finished) send();
		});
	}
	function sendAll() {
		while (pending.length > 0) send();
	}
	function schedule() {
		if (scheduled || inFlight > 0) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (inFlight === 0) send();
		});
	}
	function push(item) {
		if (item.type === "text") {
			if (headLeft > 0) {
				const crossed = crossing(item.text, headLeft);
				headLeft -= crossed.text.length;
				pending.push(crossed.rest ? { type: "text", text: crossed.text, rest: crossed.rest } : { type: "text", text: crossed.text });
			} else {
				// Past the head only sizes cross, merged into one item.
				const size = sizeOfText(item.text);
				const last = pending[pending.length - 1];
				if (last && last.type === "text" && last.text === "" && last.rest) {
					last.rest = { bytes: last.rest.bytes + size.bytes, newlines: last.rest.newlines + size.newlines, last: size.bytes > 0 ? size.last : last.rest.last };
				} else pending.push({ type: "text", text: "", rest: size });
			}
		} else pending.push(item);
		schedule();
	}

	function done(answer) {
		if (finished) return;
		finished = true;
		answer.unsettled = unsettled;
		sendAll();
		resolveRun(promiseThen.call(PromiseCtor.all(sent), () => answer));
	}

	// V8 stacks start with "Name: message" and list frames; the prelude's frames are dropped.
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\n").filter((line) => /^\s+at /.test(line) && !line.includes(${JSON.stringify(PRELUDE_MODULE)}))
				: [];
		return [head, ...frames].join("\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	// A script can set an error's name or message to anything, so they are coerced, and a value whose
	// coercion throws gets a placeholder. What crosses is cut; the rendering clips it further.
	function describeError(error) {
		const cut = (text) => headOf(text, ${ERROR_CHARS});
		try {
			if (error instanceof ErrorCtor) return { name: cut(String(error.name)), message: cut(String(error.message)), stack: cut(errorText(error)) };
			return { message: cut(String(format(error))) };
		} catch {
			return { message: "The script threw a value that cannot be described" };
		}
	}

	function fail(error) {
		done({ ok: false, error: describeError(error) });
	}

	function messageOf(error) {
		try {
			return String(error && error.message);
		} catch {
			return "undefined";
		}
	}

	function caller(name) {
		return (...args) =>
			new PromiseCtor((resolve, reject) => {
				// After the script ended, a call never settles, as in a VM that is gone.
				if (finished) return;
				let json;
				try {
					json = args[0] === undefined ? undefined : stringify(args[0]);
				} catch (error) {
					reject(error);
					return;
				}
				// Writing the arguments runs the script's own code (a toJSON), which may have ended it.
				if (finished) return;
				sendAll();
				unsettled++;
				let answer;
				try {
					answer = PromiseCtor.resolve(host.call(name, json));
				} catch (error) {
					unsettled--;
					reject(new ErrorCtor(messageOf(error)));
					return;
				}
				promiseThen.call(
					answer,
					(reply) => {
						unsettled--;
						if (reply && reply.ok === true) resolve(reply.value);
						else reject(new ErrorCtor(String(reply && reply.message)));
					},
					(error) => {
						unsettled--;
						reject(new ErrorCtor(messageOf(error)));
					},
				);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, identifier } of toolList) {
		const fn = caller(name);
		// The first tool wins when two names normalize to the same identifier.
		if (!(identifier in tools)) {
			tools[identifier] = fn;
			allTools.push(freeze({ name: identifier, description: "" }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	freeze(tools);
	freeze(allTools);

	// Reading a member that does not exist throws an error that names the close matches, instead of a later
	// "not a function". Checks with "in" still work.
	const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	function guard(target, label, names, hint) {
		return new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
					return Reflect.get(object, property, receiver);
				}
				const wanted = comparable(property);
				const exact = names.filter((name) => comparable(name) === wanted);
				const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
				let message = label + "." + property + " does not exist.";
				if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => label + "." + name).join(", ") + "?";
				else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
				if (hint) message += " " + hint;
				message += ' Check for a member with "' + property + '" in ' + label + ".";
				throw new TypeErrorCtor(message);
			},
		});
	}
	const toolsProxy = guard(
		tools,
		"tools",
		allTools.map((tool) => tool.name),
		"ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.",
	);

	// lib/json.ts's reader, for stored JSON with a backslash (see the module's comment).
	const PLAIN = /^[^\u0000-\u001f\\]*$/;
	const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
	function parseJson(text) {
		if (!text.includes("\\")) return parseNative(text);
		let at = 0;
		const fail = (message) => {
			throw new SyntaxErrorCtor(message + " at position " + at);
		};
		const space = () => {
			for (;;) {
				const char = text.charCodeAt(at);
				if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) return;
				at++;
			}
		};
		const string = () => {
			const start = at;
			let end = start;
			for (;;) {
				end = text.indexOf('"', end + 1);
				if (end < 0) fail("Unterminated string");
				let slashes = 0;
				while (text.charCodeAt(end - 1 - slashes) === 0x5c) slashes++;
				if (slashes % 2 === 0) break;
			}
			at = end + 1;
			const inner = text.slice(start + 1, end);
			return PLAIN.test(inner) ? inner : parseNative(text.slice(start, end + 1));
		};
		const value = () => {
			const char = text[at];
			if (char === '"') return string();
			if (char === "{") {
				const members = {};
				at++;
				space();
				if (text[at] === "}") {
					at++;
					return members;
				}
				for (;;) {
					space();
					if (text[at] !== '"') fail("Expected a property name");
					const key = string();
					space();
					if (text[at++] !== ":") fail("Expected ':'");
					space();
					// An own property even for "__proto__", as JSON.parse makes it.
					defineProperty(members, key, { value: value(), writable: true, enumerable: true, configurable: true });
					space();
					const next = text[at++];
					if (next === "}") return members;
					if (next !== ",") fail("Expected ',' or '}'");
				}
			}
			if (char === "[") {
				const items = [];
				at++;
				space();
				if (text[at] === "]") {
					at++;
					return items;
				}
				for (;;) {
					space();
					items.push(value());
					space();
					const next = text[at++];
					if (next === "]") return items;
					if (next !== ",") fail("Expected ',' or ']'");
				}
			}
			for (const [word, literal] of [["true", true], ["false", false], ["null", null]]) {
				if (text.startsWith(word, at)) {
					at += word.length;
					return literal;
				}
			}
			NUMBER.lastIndex = at;
			const match = NUMBER.exec(text);
			if (!match) fail("Unexpected token");
			at += match[0].length;
			return Number(match[0]);
		};
		space();
		const result = value();
		space();
		if (at < text.length) fail("Unexpected data after the JSON value");
		return result;
	}

	// key -> JSON text. Sizes count key and JSON characters.
	const stored = new Map(storeEntries);
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	const STORE_HINT =
		"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeErrorCtor(name + "() key must be a string");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeErrorCtor("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		if (json === undefined) {
			throw new TypeErrorCtor("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			throw new RangeErrorCtor(
				"store(" + stringify(key) + ") value has " + json.length + " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " + STORE_HINT,
			);
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			throw new RangeErrorCtor(
				"store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " + STORE_HINT,
			);
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parseJson(json);
	}

	function writeList() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return entries;
	}

	let outputChars = 0;
	let outputItems = 0;

	// Past the output limits the script fails: done() reports the error, so catching it does not resume
	// output, and the host stops waiting for the script.
	function output(item, chars) {
		if (finished) return;
		outputChars += chars;
		outputItems++;
		if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
			const error = new RangeErrorCtor(${JSON.stringify(OUTPUT_LIMIT)});
			fail(error);
			throw error;
		}
		push(item);
	}

	// Primitives become their string form, everything else JSON.
	function outputText(value) {
		if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		output({ type: "text", text: rendered }, rendered.length);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		if (value.type !== "image") throw new TypeErrorCtor('image only accepts MCP image blocks, got "' + value.type + '"');
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		return "data:;base64," + value.data;
	}

	// Base64 of the signatures of the formats providers accept inline (PNG, JPEG except JPEG-LS, GIF,
	// "RIFF....WEBP"). The model is shown ${IMAGE_OMITTED} in its place, as today, so the data never crosses.
	const IMAGE_SIGNATURES = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		const data = url.slice(comma + 1).replace(/\s+/g, "");
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new TypeErrorCtor("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
		}
		const head = data.slice(0, 16);
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		if (!signature) throw new TypeErrorCtor("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
		output({ type: "image" }, data.length);
	}

	function exit() {
		done({ ok: true, writes: writeList() });
		throw EXIT;
	}

	const consoleObject = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		consoleObject[level] = (...args) => {
			const rendered = args.map(format).join(" ");
			output({ type: "text", text: rendered }, rendered.length);
		};
	}
	freeze(consoleObject);

	// The globals first (the platform's console is replaced while it can still be), then the lockdown.
	const globals = { tools: toolsProxy, ALL_TOOLS: allTools, console: consoleObject, text, image, exit, store, load };
	for (const name of Object.keys(globals)) {
		try {
			defineProperty(globalThis, name, { value: globals[name], enumerable: true, writable: false, configurable: false });
		} catch {
			globalThis[name] = globals[name];
		}
	}
	lockdown();

	// The returned value's text: a string as is, else its JSON; nothing for a value JSON leaves out. A value
	// JSON cannot write throws, which fails the script, as today.
	function valueOf(value) {
		if (value === undefined) return undefined;
		const rendered = typeof value === "string" ? value : stringify(value);
		return rendered === undefined ? undefined : crossing(rendered, ${HEAD_CHARS});
	}

	let promise;
	try {
		promise = script()(toolsProxy, consoleObject);
	} catch (error) {
		fail(error);
		return answered;
	}
	promiseThen.call(
		PromiseCtor.resolve(promise),
		(value) => {
			if (finished) return;
			let rendered;
			try {
				rendered = valueOf(value);
			} catch (error) {
				fail(error);
				return;
			}
			const answer = { ok: true, writes: writeList() };
			if (rendered !== undefined) answer.value = rendered;
			done(answer);
		},
		(error) => {
			if (error === EXIT) return;
			fail(error);
		},
	);
	return answered;
})`;

/** The guest's main module: the entrypoint the Scripts object calls with the conversation's RpcTarget. */
export const GUEST_MAIN = `import { WorkerEntrypoint } from "cloudflare:workers";
import script from "./${SCRIPT_MODULE}";

const run = ${GUEST_CORE};

export default class Guest extends WorkerEntrypoint {
	run(host, tools, store) {
		return run(host, script, tools, store);
	}
}
`;

/**
 * The script's CommonJS module: a function that shadows the wrapper's names and gives the script, an async
 * arrow whose body is the code, on the first line. `scripts/syntax.ts` checks that the code cannot end it
 * early.
 */
export const SCRIPT_PREFIX = "module.exports = function (require, module, exports, __filename, __dirname) { return async (tools, console) => {";
export const SCRIPT_SUFFIX = "\n}; };\n";

export function scriptModule(code: string): string {
	return `${SCRIPT_PREFIX}${code}${SCRIPT_SUFFIX}`;
}

/** The modules of one script's Dynamic Worker. */
export function guestModules(code: string): { [name: string]: string | { cjs: string } } {
	return { [PRELUDE_MODULE]: GUEST_MAIN, [SCRIPT_MODULE]: { cjs: scriptModule(code) } };
}
