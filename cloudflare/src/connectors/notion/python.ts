// The JSON values the Notion connector reads from Notion and from tool input: own properties, and a value
// as text in a message.
//
// Keys that come from Notion or from the agent (property names, option names, a property's type) are read
// only as own properties, so "constructor" or "__proto__" is an ordinary key.

import { type Json, type JsonObject } from "../../lib/json.ts";

/** `value.get(key)`: the own property, or null when there is none. */
export function own(value: JsonObject, key: string): Json {
	return Object.hasOwn(value, key) ? (value[key] as Json) : null;
}

/** Whether `key in value`. */
export function has(value: JsonObject, key: string): boolean {
	return Object.hasOwn(value, key);
}

/** A JSON value as text: a string as it is, anything else as JSON. */
export function asText(value: Json): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}
