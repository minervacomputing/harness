// Pydantic's lax mode, as the connectors' answer models use it (`extra="ignore"`, not strict). These read a
// provider's answers, never a tool's input: tool inputs are strict (lib/schema.ts). A JSON number cannot tell
// 3 from 3.0 here, so a whole number written as a float is an int as in Python, and one past 2**63 is too,
// where Python's float would be refused (unless a connector passes a `below` bound).

import { z } from "zod";

const INVALID: unique symbol = Symbol("invalid");

function lax<T>(name: string, read: (value: unknown) => T | typeof INVALID) {
	return z.unknown().transform((value, ctx): T => {
		const out = read(value);
		if (out !== INVALID) return out;
		ctx.addIssue({ code: "custom", message: `Input should be a valid ${name}` });
		return z.NEVER;
	});
}

const FALSE = new Set(["0", "off", "f", "false", "n", "no"]);
const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);

/** `bool` read as Pydantic's lax mode reads it, or null: true and false, 0 and 1, and the words, in any ASCII case. */
export function laxBoolValue(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === 0) return false;
	if (value === 1) return true;
	if (typeof value !== "string") return null;
	const word = value.replace(/[A-Z]/g, (char) => char.toLowerCase());
	if (FALSE.has(word)) return false;
	if (TRUE.has(word)) return true;
	return null;
}

/** `bool`: true and false, 0 and 1, and the words Pydantic reads, in any ASCII case. */
export function laxBool() {
	return lax("boolean", (value) => laxBoolValue(value) ?? INVALID);
}

// pydantic-core's `str_as_int`, as pydantic 2.13 parses text into an int. Its rules are its own (fitted to
// it exhaustively on short strings and checked on long ones; test/fixtures/connectors/slack/generate.py pins
// the cases): Rust's integer grammar first (a sign and ASCII digits, leading zeros allowed), else leading
// zeros are dropped together with any underscores among them, after which a "-" may still come ("0-1" is
// -1), and the rest needs underscores only between digits and no leading zero ("0-01" is refused, "-01"
// is not); a fraction of zeros is cut and the rest read the same way.

/** Rust's `str::parse` of an integer. */
const NATIVE = /^[+-]?[0-9]+$/;
/** JSON's integer grammar, which jiter reads. */
const JSON_INT = /^-?(?:0|[1-9][0-9]*)$/;

/** Underscores removed, or null when one leads, ends or follows another. */
function withoutUnderscores(text: string): string | null {
	if (text.startsWith("_") || text.endsWith("_") || text.includes("__")) return null;
	return text.replaceAll("_", "");
}

/** One candidate's integer, as decimal text Number() reads, or null. */
function intText(text: string): string | null {
	if (NATIVE.test(text)) return text;
	let sign = "";
	let body = text;
	if (body.startsWith("+")) body = body.slice(1);
	else if (body.startsWith("-")) {
		body = body.slice(1);
		sign = "-";
	}
	if (!/^[0-9]/.test(body)) return null;
	let rest = body;
	if (body.startsWith("0")) {
		let at = 0;
		while (at < body.length && (body[at] === "0" || body[at] === "_")) at++;
		const next = body[at];
		if (next === undefined) rest = body.slice(-1);
		else if (next >= "1" && next <= "9") rest = body.slice(at);
		else if (next === "-" && sign === "") rest = body.slice(at);
		else return null;
	}
	const plain = withoutUnderscores(sign + rest);
	return plain !== null && JSON_INT.test(plain) ? plain : null;
}

/** The text before a "." followed by zeros only (at least one), or null. */
function withoutZeroFraction(text: string): string | null {
	const at = text.indexOf(".");
	if (at < 0) return null;
	return /^0+$/.test(text.slice(at + 1)) ? text.slice(0, at) : null;
}

/**
 * `int` read as Pydantic's lax mode reads it, or null: whole numbers, booleans as 0 and 1, and text as
 * pydantic-core reads it, White_Space around it stripped. A number is a double here, so an integer past 2**53
 * loses precision (as one in a JSON number does when parsed), and one too large for a double is refused,
 * where Python keeps it. `below` refuses numbers and texts whose size reaches it (a connector that would
 * rather refuse what a double cannot hold exactly passes 2**53, one that follows Pydantic's 64-bit floats
 * 2**63).
 */
export function laxIntValue(value: unknown, below = Number.POSITIVE_INFINITY): number | null {
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < below ? value + 0 : null;
	if (typeof value !== "string") return null;
	const text = value.trim();
	// Python refuses an int of more than 4300 digits, leading zeros not counted; a double holds fewer.
	const fraction = withoutZeroFraction(text);
	const found = intText(text) ?? (fraction === null ? null : intText(fraction));
	if (found === null) return null;
	const number = Number(found);
	// `+ 0` makes -0 the 0 Python's int has.
	return Number.isFinite(number) && Math.abs(number) < below ? number + 0 : null;
}

/** `int`: see `laxIntValue`. */
export function laxInt(below = Number.POSITIVE_INFINITY) {
	return lax("integer", (value) => laxIntValue(value, below) ?? INVALID);
}

/** Pydantic's `to_camel` for the snake_case names the models use: `next_page_token` is `nextPageToken`. */
export function toCamel(name: string): string {
	return name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ModelOptions {
	/** Look fields up by their camelCase alias first (`alias_generator=to_camel`). Default false. */
	camel?: boolean;
	/** Explicit aliases, which replace the generated one. */
	aliases?: { [field: string]: string };
}

/**
 * A Pydantic model (`extra="ignore"`, `populate_by_name=True`) with these fields: a plain object of them,
 * each found under its alias, else under its own name; unknown keys are dropped, and a value that is not an
 * object fails as the model does.
 */
export function model<Shape extends z.ZodRawShape>(shape: Shape, options: ModelOptions = {}) {
	const fields = Object.keys(shape);
	return z.preprocess((input) => {
		if (!isObject(input)) return input;
		const picked: { [key: string]: unknown } = {};
		for (const field of fields) {
			const alias = options.aliases?.[field] ?? (options.camel ? toCamel(field) : field);
			const key = Object.hasOwn(input, alias) ? alias : Object.hasOwn(input, field) ? field : null;
			if (key !== null) Object.defineProperty(picked, field, { value: input[key], enumerable: true, writable: true, configurable: true });
		}
		return picked;
	}, z.object(shape));
}

/** `dict[str, Any]`: any JSON object, as it is. */
export function dict() {
	return z.custom<{ [key: string]: unknown }>((value) => typeof value === "object" && value !== null && !Array.isArray(value));
}
