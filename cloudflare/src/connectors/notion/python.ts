// Python's view of the JSON values the Notion connector reads from Notion and from tool input: a dict's
// `get`, truthiness, and `str()` and `repr()` as an f-string writes a value into a message.
//
// Keys that come from Notion or from the agent (property names, option names, a property's type) are read
// only as own properties, so "constructor" or "__proto__" is an ordinary key, as it is in a dict.

import { type Json, type JsonObject, pythonFloat } from "../../lib/json.ts";
import { pythonRepr } from "../../lib/text.ts";

/** `value.get(key)`: the own property, or null when there is none. */
export function own(value: JsonObject, key: string): Json {
	return Object.hasOwn(value, key) ? (value[key] as Json) : null;
}

/** Whether `key in value`. */
export function has(value: JsonObject, key: string): boolean {
	return Object.hasOwn(value, key);
}

function number(value: number): string {
	// A parsed number cannot tell 1 from 1.0: integers are written as Python writes ints.
	return Number.isInteger(value) && Math.abs(value) < 2 ** 53 ? String(value) : pythonFloat(value);
}

/** `repr(value)` of a JSON value as Python reads it: str, int or float, bool, None, list or dict. */
export function pythonValueRepr(value: Json): string {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "number") return number(value);
	if (typeof value === "string") return pythonRepr(value);
	if (Array.isArray(value)) return `[${value.map(pythonValueRepr).join(", ")}]`;
	return `{${Object.keys(value)
		.map((key) => `${pythonRepr(key)}: ${pythonValueRepr(value[key] as Json)}`)
		.join(", ")}}`;
}

/** `str(value)`, as `f"{value}"` writes it: a string as it is, anything else as its repr. */
export function pythonStr(value: Json): string {
	return typeof value === "string" ? value : pythonValueRepr(value);
}
