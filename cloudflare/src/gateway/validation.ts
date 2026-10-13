// Validation of a tool call's arguments against its operation's input. The model reads what failed as
// "Invalid arguments. <path>: <zod's message>; …". The registry already requires inputs that are strict at
// every depth (registry.ts `checkStrict`).

import type { z } from "zod";
import type { Json } from "../lib/json.ts";
import { RESERVED_KEYS } from "../lib/schema.ts";

/** At most this many problems are named in the message. */
export const MAX_PROBLEMS = 5;

export type Validated = { ok: true; data: { [key: string]: Json } } | { ok: false; message: string };

/**
 * Where the arguments hold a key that could reach an object's prototype ("__proto__", "constructor",
 * "prototype", at any depth), or what their hashes (write keys, page tokens) cannot hold exactly: a string
 * or key with a lone surrogate, an integer beyond ±(2^53 − 1), which parsing has already rounded, or a
 * number too large for a double ("1e400" parses as an infinity).
 */
function unsafe(value: unknown, path: string[]): string | null {
	if (typeof value === "string") return value.isWellFormed() ? null : problem(path, "Invalid string: lone surrogate");
	if (typeof value === "number") return Number.isFinite(value) && (Number.isSafeInteger(value) || !Number.isInteger(value)) ? null : problem(path, "Number out of range");
	if (typeof value !== "object" || value === null) return null;
	for (const [key, item] of Object.entries(value)) {
		if (!key.isWellFormed()) return problem(path, "Invalid key: lone surrogate");
		if (RESERVED_KEYS.has(key)) return problem([...path, key], `The key "${key}" is not allowed`);
		const found = unsafe(item, [...path, key]);
		if (found !== null) return found;
	}
	return null;
}

function problem(path: readonly PropertyKey[], message: string): string {
	return `${path.map(String).join(".") || "input"}: ${message}`;
}

/** Validates `raw` (null or missing validate as `{}`) and returns the normalized arguments, defaults included. */
export async function validateInput(schema: z.ZodType, raw: Json | undefined): Promise<Validated> {
	const input: Json = raw ?? {};
	const refused = unsafe(input, []);
	if (refused !== null) return { ok: false, message: `Invalid arguments. ${refused}` };
	const parsed = await schema.safeParseAsync(input);
	if (parsed.success) return { ok: true, data: parsed.data as { [key: string]: Json } };
	const problems = parsed.error.issues.slice(0, MAX_PROBLEMS).map((issue) => problem(issue.path, issue.message));
	return { ok: false, message: `Invalid arguments. ${problems.join("; ")}` };
}
