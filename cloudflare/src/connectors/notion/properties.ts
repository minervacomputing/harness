// Database properties as agents read and set them.
//
// Only properties that hold the row's own values are shown. Rollups and formulas are left out because they
// can carry values from related pages the agent may not read; files because their links grant access by
// themselves. Agents set only plain values, and only options a select already has: a new option would change
// the database's schema. Relations are not set (a two-way relation also changes the related page), nor are
// people (which notifies them).
//
// Properties are kept by name in Maps, and results built with own properties, so a property named
// "constructor" or "__proto__" is an ordinary name. Names that are array indexes ("1", "42") come first in
// a JSON object, as JavaScript orders them.

import { OperationError } from "../../gateway/connector.ts";
import { parseDate, parseDateTime } from "../../lib/dates.ts";
import { type Json, type JsonObject, isDict } from "../../lib/json.ts";
import { hasTitledMention, own, textOf } from "./client.ts";

export const READABLE: ReadonlySet<string> = new Set([
	"title",
	"rich_text",
	"number",
	"select",
	"multi_select",
	"status",
	"date",
	"checkbox",
	"url",
	"email",
	"phone_number",
	"created_time",
	"last_edited_time",
	"created_by",
	"last_edited_by",
	"unique_id",
	"relation",
	"people",
]);
/** Filters and sorts may use what reading shows, and nothing else: filtering on a hidden value reveals it. */
export const FILTERABLE = READABLE;
export const MAX_TEXT = 2000;
export const MAX_OPTIONS = 100;

/** Properties as Notion lists them: a JSON object of property objects. */
export type Properties = { [name: string]: JsonObject } | JsonObject;

/** An object whose keys may be anyone's, built with own properties. */
function entries(pairs: [string, Json][]): JsonObject {
	return Object.fromEntries(pairs) as JsonObject;
}

function nameOrId(user: Json): Json {
	if (!isDict(user)) return null;
	const name = own(user, "name");
	return typeof name === "string" && name ? name : own(user, "id");
}

/** Properties with a usable type, by name; Notion's responses are not trusted to be well formed. */
function typed(properties: Json): Map<string, [type: string, prop: JsonObject]> {
	const out = new Map<string, [string, JsonObject]>();
	if (!isDict(properties)) return out;
	for (const name of Object.keys(properties)) {
		const prop = properties[name] as Json;
		if (!isDict(prop)) continue;
		const type = own(prop, "type");
		if (typeof type === "string") out.set(name, [type, prop]);
	}
	return out;
}

function propsOf(properties: Json): Map<string, JsonObject> {
	return new Map(Array.from(typed(properties), ([name, [, prop]]) => [name, prop]));
}

function byId(properties: Map<string, JsonObject>): Map<string, JsonObject> {
	const out = new Map<string, JsonObject>();
	for (const prop of properties.values()) {
		const id = own(prop, "id");
		if (typeof id === "string") out.set(id, prop);
	}
	return out;
}

function valueOf(kind: string, value: Json): Json {
	switch (kind) {
		case "title":
		case "rich_text":
			return textOf(value);
		case "select":
		case "status":
			return isDict(value) ? own(value, "name") : null;
		case "multi_select":
			return Array.isArray(value) ? value.filter(isDict).map((option) => own(option, "name")) : [];
		case "date":
			if (!isDict(value)) return null;
			return entries(["start", "end", "time_zone"].map((key): [string, Json] => [key, own(value, key)]));
		case "unique_id": {
			if (!isDict(value)) return null;
			const [prefix, number] = [own(value, "prefix"), own(value, "number")];
			if (typeof number !== "number") return null;
			return typeof prefix === "string" && prefix ? `${prefix}-${number}` : number;
		}
		case "relation":
			return Array.isArray(value) ? value.filter(isDict).map((related) => own(related, "id")) : [];
		case "people":
			return Array.isArray(value) ? value.map(nameOrId) : [];
		case "created_by":
		case "last_edited_by":
			return nameOrId(value);
		case "number":
		case "checkbox":
		case "url":
		case "email":
		case "phone_number":
		case "created_time":
		case "last_edited_time":
			return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
	}
	return null;
}

/**
 * The values of a page's properties that agents are shown. Notion lists at most 25 related pages or
 * people in a page; where it has more, the value says so.
 */
export function readable(properties: Json): JsonObject {
	const values: [string, Json][] = [];
	for (const [name, [kind, prop]] of typed(properties)) {
		if (!READABLE.has(kind)) continue;
		const value = valueOf(kind, own(prop, kind));
		values.push([name, own(prop, "has_more") === true ? { items: value, more: true } : value]);
	}
	return entries(values);
}

function optionsOf(prop: JsonObject): string[] {
	const type = own(prop, "type");
	const config = typeof type === "string" ? own(prop, type) : null;
	const options = isDict(config) ? own(config, "options") : null;
	if (!Array.isArray(options)) return [];
	return options.filter((option): option is JsonObject => isDict(option) && typeof own(option, "name") === "string").map((option) => own(option, "name") as string);
}

/** A data source's properties: their types, and the options of selects. */
export function schema(properties: Json): JsonObject {
	const described: [string, Json][] = [];
	for (const [name, [kind, prop]] of typed(properties)) {
		const entry: JsonObject = { type: kind };
		if (!READABLE.has(kind)) entry.hidden = true;
		if (kind === "select" || kind === "multi_select" || kind === "status") entry.options = optionsOf(prop);
		described.push([name, entry]);
	}
	return entries(described);
}

function invalid(message: string): OperationError {
	return new OperationError("INVALID_ARGUMENTS", message);
}

function richText(name: string, value: Json, required = false): Json[] {
	if (value === null && !required) return [];
	if (typeof value !== "string" || value.length > MAX_TEXT) throw invalid(`${JSON.stringify(name)} takes text of at most ${MAX_TEXT} characters.`);
	return value ? [{ type: "text", text: { content: value } }] : [];
}

function plain(name: string, value: Json): string | null {
	if (value !== null && (typeof value !== "string" || value.length > MAX_TEXT)) {
		throw invalid(`${JSON.stringify(name)} takes text of at most ${MAX_TEXT} characters, or null.`);
	}
	return value || null;
}

function option(name: string, prop: JsonObject, value: Json): JsonObject {
	// The options are not listed here: an agent may edit a row without being allowed to read its database.
	if (typeof value !== "string" || !optionsOf(prop).includes(value)) throw invalid(`${JSON.stringify(name)} takes one of its existing options, as get_database shows them.`);
	return { name: value };
}

function date(name: string, value: Json): Json {
	if (value === null) return null;
	const given: Json = typeof value === "string" ? { start: value } : value;
	if (
		!isDict(given) ||
		!Object.keys(given).every((key) => key === "start" || key === "end") ||
		!Object.values(given).every((item) => typeof item === "string" && (parseDate(item) ?? parseDateTime(item)) !== null) ||
		!Object.hasOwn(given, "start")
	) {
		throw invalid(`${JSON.stringify(name)} takes a date like "2026-10-01", or {"start": ..., "end": ...}, or null.`);
	}
	return given;
}

function convert(name: string, prop: JsonObject, value: Json): JsonObject {
	const kind = own(prop, "type") as string;
	switch (kind) {
		case "title":
			return { title: richText(name, value, true) };
		case "rich_text":
			return { rich_text: richText(name, value) };
		case "number":
			// A number too large for a double ("1e400") parses as an infinity.
			if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw invalid(`${JSON.stringify(name)} takes a number, or null.`);
			return { number: value };
		case "select":
			return { select: value === null ? null : option(name, prop, value) };
		case "status":
			return { status: option(name, prop, value) };
		case "multi_select":
			if (!Array.isArray(value) || value.length > MAX_OPTIONS || new Set(value).size !== value.length) {
				throw invalid(`${JSON.stringify(name)} takes a list of distinct existing options.`);
			}
			return { multi_select: value.map((item) => option(name, prop, item)) };
		case "date":
			return { date: date(name, value) };
		case "checkbox":
			if (typeof value !== "boolean") throw invalid(`${JSON.stringify(name)} takes true or false.`);
			return { checkbox: value };
		case "url":
		case "email":
		case "phone_number":
			return entries([[kind, plain(name, value)]]);
	}
	throw invalid(`Minerva does not set ${kind} properties such as ${JSON.stringify(name)}.`);
}

/** Notion property values for what the agent asked to set, checked against the schema. */
export function writable(properties: Json, values: JsonObject): JsonObject {
	const converted: [string, Json][] = [];
	const props = propsOf(properties);
	const ids = byId(props);
	for (const name of Object.keys(values)) {
		const prop = props.get(name);
		if (prop === undefined) throw invalid(`There is no property named ${JSON.stringify(name)}.`);
		// Notion reads these keys as names or ids.
		if ((ids.get(name) ?? prop) !== prop) throw invalid(`The property name ${JSON.stringify(name)} is also another property's id; rename it in Notion.`);
		converted.push([name, convert(name, prop, values[name] as Json)]);
	}
	return entries(converted);
}

const MAX_FILTER_DEPTH = 8;

/**
 * Refuses filters and sorts that use properties agents are not shown. Returns the names of the properties
 * they use.
 */
export function checkFilter(properties: Json, value: Json): Set<string> {
	const props = propsOf(properties);
	const names = new Map<JsonObject, string>(Array.from(props, ([name, prop]) => [prop, name]));
	const used = new Set<string>();
	walkFilter(props, byId(props), value, 0, (prop) => used.add(names.get(prop) as string));
	return used;
}

function walkFilter(props: Map<string, JsonObject>, ids: Map<string, JsonObject>, value: Json, depth: number, use: (prop: JsonObject) => void): void {
	if (depth > MAX_FILTER_DEPTH) throw invalid("The filter is nested too deeply.");
	if (Array.isArray(value)) {
		for (const item of value) walkFilter(props, ids, item, depth + 1, use);
		return;
	}
	if (!isDict(value)) return;
	if (Object.hasOwn(value, "property")) {
		const name = value.property as Json;
		// Notion takes a name or an id here; a name may equal another property's id, so both must pass.
		const matches = typeof name === "string" ? [props.get(name), ids.get(name)].filter((prop): prop is JsonObject => prop !== undefined) : [];
		if (matches.length === 0) throw invalid(`There is no property named ${JSON.stringify(name)}.`);
		for (const prop of matches) {
			const type = own(prop, "type") as string;
			if (!FILTERABLE.has(type)) throw invalid(`Minerva does not filter or sort by ${type} properties.`);
			use(prop);
		}
	}
	for (const key of Object.keys(value)) walkFilter(props, ids, value[key] as Json, depth + 1, use);
}

/** Whether a text property's value mentions another page, whose title a filter or sort could probe. */
export function mentionsHidden(prop: Json): boolean {
	if (!isDict(prop)) return false;
	const type = own(prop, "type");
	if (type !== "title" && type !== "rich_text") return false;
	return hasTitledMention(own(prop, type));
}
