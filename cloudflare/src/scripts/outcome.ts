// What the Scripts object makes of a guest's answer (contracts/scripts.ts `GuestOutcome`). The guest is
// hostile and its answer arrives as structured data, so every field is checked here as pi-codemode's host
// checked its bridge's JSON: an answer that does not decode fails the script as a sandbox error ("Sandbox
// bridge broken: …"). The platform's own failures of the guest (its CPU and memory limits, a guest that
// waits on nothing) become sandbox or script errors, in words of their own.

import type { GuestOutcome, ScriptError, ScriptStoreWrites, ScriptText, TextSize } from "../contracts/scripts.ts";
import { parseJson } from "../lib/json.ts";
import { BRIDGE_BROKEN, CPU_STOPPED, ERROR_CHARS, HEAD_CHARS, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS, MEMORY_STOPPED, SANDBOX_FAILED, STALLED, STORE_DELETES_CHARS } from "./limits.ts";
import { headUnits } from "./output.ts";

class BridgeError extends Error {}

function object(value: unknown, what: string): { [key: string]: unknown } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BridgeError(`${what} is not an object`);
	return value as { [key: string]: unknown };
}

function only(value: { [key: string]: unknown }, keys: readonly string[], what: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new BridgeError(`${what} has an unknown field`);
}

function string(value: unknown, what: string): string {
	if (typeof value !== "string") throw new BridgeError(`${what} is not a string`);
	return value;
}

function size(value: unknown, what: string): TextSize {
	const fields = object(value, what);
	only(fields, ["bytes", "newlines", "last"], what);
	const { bytes, newlines, last } = fields;
	if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(newlines) || typeof last !== "boolean") throw new BridgeError(`${what} is malformed`);
	if ((newlines as number) < 0 || (newlines as number) > (bytes as number)) throw new BridgeError(`${what} is malformed`);
	return { bytes: bytes as number, newlines: newlines as number, last };
}

/** A text that crossed: at most HEAD_CHARS of it, with the size of the rest. */
function text(value: unknown, what: string): ScriptText {
	const fields = object(value, what);
	only(fields, ["text", "rest"], what);
	const head = string(fields.text, what);
	if (head.length > HEAD_CHARS) throw new BridgeError(`${what} is longer than its head`);
	return fields.rest === undefined ? { text: head } : { text: head, rest: size(fields.rest, what) };
}

function unsettledOf(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new BridgeError("the count of unsettled calls is malformed");
	return value;
}

function writesOf(value: unknown): ScriptStoreWrites {
	if (!Array.isArray(value)) throw new BridgeError("store writes are not an array");
	const writes: ScriptStoreWrites = { set: [], delete: [] };
	// One entry per key, so the values set are what the store holds of them, within its limits; keys deleted
	// may be any, so they have a bound of their own.
	let setChars = 0;
	let deletedChars = 0;
	for (const entry of value as unknown[]) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string" || (entry.length === 2 ? typeof entry[1] !== "string" : entry.length !== 1)) {
			throw new BridgeError("store writes contain a malformed entry");
		}
		const key = entry[0] as string;
		if (entry.length === 1) {
			deletedChars += key.length;
			if (deletedChars > STORE_DELETES_CHARS) throw new BridgeError("store writes are over the store's limits");
			writes.delete.push(key);
			continue;
		}
		const json = entry[1] as string;
		setChars += key.length + json.length;
		if (json.length > MAX_STORE_VALUE_CHARS || setChars > MAX_STORE_TOTAL_CHARS) throw new BridgeError("store writes are over the store's limits");
		try {
			parseJson(json);
		} catch {
			throw new BridgeError(`store value for ${JSON.stringify(key)} is not valid JSON`);
		}
		writes.set.push([key, json]);
	}
	return writes;
}

function errorOf(value: unknown): ScriptError {
	const error = object(value, "script error");
	only(error, ["name", "message", "stack"], "script error");
	if (error.name !== undefined && typeof error.name !== "string") throw new BridgeError("script error is malformed");
	const message = headUnits(string(error.message, "script error"), ERROR_CHARS);
	const stack = error.stack === undefined ? undefined : headUnits(string(error.stack, "script error"), ERROR_CHARS);
	return { kind: "script", message, ...(stack !== undefined ? { stack } : {}) };
}

/** The guest's answer to `run()`, checked. */
export function guestOutcome(answer: unknown): GuestOutcome {
	try {
		const fields = object(answer, "the answer");
		if (fields.ok === true) {
			only(fields, ["ok", "value", "writes", "unsettled"], "the answer");
			const value = fields.value === undefined ? undefined : text(fields.value, "the returned value");
			return { ok: true, ...(value !== undefined ? { value } : {}), writes: writesOf(fields.writes), unsettled: unsettledOf(fields.unsettled) };
		}
		if (fields.ok === false) {
			only(fields, ["ok", "error", "unsettled"], "the answer");
			return { ok: false, error: errorOf(fields.error), unsettled: unsettledOf(fields.unsettled) };
		}
		throw new BridgeError("the answer is malformed");
	} catch (error) {
		if (!(error instanceof BridgeError)) throw error;
		return { ok: false, error: { kind: "sandbox", message: BRIDGE_BROKEN(error.message) }, unsettled: 0 };
	}
}

/** The platform's failure of a guest's `run()`, as a script's failure. */
export function thrownOutcome(error: unknown, cpuMs: number): GuestOutcome {
	const message = error instanceof Error ? error.message : String(error);
	if (/exceeded CPU time limit/i.test(message)) return { ok: false, error: { kind: "sandbox", message: CPU_STOPPED(cpuMs) }, unsettled: 0 };
	if (/exceeded memory limit/i.test(message)) return { ok: false, error: { kind: "sandbox", message: MEMORY_STOPPED }, unsettled: 0 };
	// A guest that waits on a promise nothing can settle is cancelled by the platform as hung: a script error.
	if (/had hung|would never generate a response/i.test(message)) return { ok: false, error: { kind: "script", message: STALLED }, unsettled: 0 };
	return { ok: false, error: { kind: "sandbox", message: SANDBOX_FAILED(headUnits(message, ERROR_CHARS)) }, unsettled: 0 };
}
