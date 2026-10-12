// HubSpot's responses as client.py's Pydantic models read them: `extra="ignore"`, fields found under their
// camelCase alias first and their own name otherwise (`alias_generator=to_camel, populate_by_name=True`),
// defaults for missing fields, and Pydantic's lax types (test/fixtures/connectors/hubspot/vectors.json pins
// each rule against today's Python):
//
// - `str` takes only a string; `str | None` also null.
// - `int` takes an integer (1.0 and 1e3 too, not 1.5), a boolean (as 0 or 1), or a string that is one once
//   Unicode White_Space is stripped from both ends: an optional sign, digits with single underscores between
//   them, and optionally "." and zeros ("+4_242", "007", "1.0"). Read as a bigint, so an id is written as
//   Python writes it. One difference: a JSON number beyond 2^53 is refused, since parsing has already
//   rounded it, where Python reads it exactly.
// - `bool` takes a boolean, 0 or 1, or (in any case) "0", "off", "f", "false", "n", "no", "1", "on", "t",
//   "true", "y" or "yes", not padded.
// - `dict[str, str | None]` takes an object whose every value is a string or null, kept in a Map, so a key
//   such as "__proto__" stays a key.
//
// Model fields are never null unless their type says so: `"archived": null` or `"results": null` is a
// mismatch, as in Pydantic. A mismatch throws `Mismatch`; the client turns it into its unexpected-response
// error.
//
// Reads (`_read`, `model_validate_json`) and writes (`ProviderHTTP.parsed`: `json.loads`, then
// `model_validate`) parse JSON differently in one way that shows: pydantic's JSON parser refuses a lone
// surrogate escape ("\ud800") anywhere in the text, an ignored field or a key included, where `json.loads`
// keeps it. `fromJsonText` is the reads' parsing. Both accept NaN and Infinity, which parseJson refuses.

import { isDict, type Json, type JsonObject, parseModelJson } from "../../lib/json.ts";
import { stripWhitespace } from "../../lib/schema.ts";

/** A response that does not fit its model. */
export class Mismatch extends Error {
	constructor(expected: string) {
		super(`HubSpot's response does not fit its model: expected ${expected}.`);
		this.name = "Mismatch";
	}
}

export type Reader<T> = (value: Json) => T;

/**
 * `model_validate_json(text)`: JSON text (already decoded from strict UTF-8) read with `reader`, refused
 * like Pydantic's parser refuses it when a string anywhere holds a lone surrogate escape or it nests too deeply. Throws
 * SyntaxError or Mismatch.
 */
export function fromJsonText<T>(reader: Reader<T>, text: string): T {
	return reader(parseModelJson(text));
}

export function dict(value: Json): JsonObject {
	if (!isDict(value)) throw new Mismatch("an object");
	return value;
}

export const str: Reader<string> = (value) => {
	if (typeof value !== "string") throw new Mismatch("a string");
	return value;
};

/** Python's int as pydantic-core parses it from text. */
const INT_TEXT = /^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$/;

export const int: Reader<bigint> = (value) => {
	if (typeof value === "boolean") return value ? 1n : 0n;
	if (typeof value === "number") {
		if (!Number.isInteger(value)) throw new Mismatch("an integer");
		if (!Number.isSafeInteger(value)) throw new Mismatch("an integer that JSON parsing kept exact");
		return BigInt(value);
	}
	if (typeof value === "string") {
		const text = stripWhitespace(value);
		if (!INT_TEXT.test(text)) throw new Mismatch("an integer");
		return BigInt(text.replace(/\.0+$/, "").replaceAll("_", ""));
	}
	throw new Mismatch("an integer");
};

const TRUE: ReadonlySet<string> = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE: ReadonlySet<string> = new Set(["0", "off", "f", "false", "n", "no"]);

export const bool: Reader<boolean> = (value) => {
	if (typeof value === "boolean") return value;
	if (value === 0) return false;
	if (value === 1) return true;
	if (typeof value === "string") {
		const word = value.toLowerCase();
		if (TRUE.has(word)) return true;
		if (FALSE.has(word)) return false;
	}
	throw new Mismatch("a boolean");
};

export function nullable<T>(reader: Reader<T>): Reader<T | null> {
	return (value) => (value === null ? null : reader(value));
}

export function list<T>(reader: Reader<T>): Reader<T[]> {
	return (value) => {
		if (!Array.isArray(value)) throw new Mismatch("a list");
		return value.map(reader);
	};
}

/** `dict[str, str | None]`. */
export const stringMap: Reader<Map<string, string | null>> = (value) => {
	const object = dict(value);
	const out = new Map<string, string | null>();
	for (const key of Object.keys(object)) {
		const item = object[key] as Json;
		if (item !== null && typeof item !== "string") throw new Mismatch("a string or null");
		out.set(key, item);
	}
	return out;
};

/** Pydantic's `to_camel`, for the field names these models have: `display_order` is `displayOrder`. */
function camel(name: string): string {
	return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** A model's field: under its alias, else its name, else the default (a missing field without one is a mismatch). */
export function field<T>(object: JsonObject, name: string, reader: Reader<T>, fallback?: () => T): T {
	const alias = camel(name);
	for (const key of alias === name ? [name] : [alias, name]) {
		if (Object.hasOwn(object, key)) return reader(object[key] as Json);
	}
	if (fallback === undefined) throw new Mismatch(`the field ${name}`);
	return fallback();
}

// client.py's models.

export interface Details {
	portalId: bigint;
	portalName: string | null;
	uiDomain: string | null;
}

export const readDetails: Reader<Details> = (value) => {
	const object = dict(value);
	return {
		portalId: field(object, "portal_id", int),
		portalName: field(object, "portal_name", nullable(str), () => null),
		uiDomain: field(object, "ui_domain", nullable(str), () => null),
	};
};

/** A CRM record (`Record`). */
export interface HubRecord {
	id: string;
	properties: Map<string, string | null>;
	archived: boolean;
}

export const readRecord: Reader<HubRecord> = (value) => {
	const object = dict(value);
	return {
		id: field(object, "id", str),
		properties: field(object, "properties", stringMap, () => new Map()),
		archived: field(object, "archived", bool, () => false),
	};
};

export interface Next {
	after: string;
}

export interface Paging {
	next: Next | null;
}

export interface SearchPage {
	total: bigint;
	results: HubRecord[];
	paging: Paging | null;
}

const readNext: Reader<Next> = (value) => ({ after: field(dict(value), "after", str) });

const readPaging: Reader<Paging> = (value) => ({ next: field(dict(value), "next", nullable(readNext), () => null) });

export const readSearchPage: Reader<SearchPage> = (value) => {
	const object = dict(value);
	return {
		total: field(object, "total", int, () => 0n),
		results: field(object, "results", list(readRecord), () => []),
		paging: field(object, "paging", nullable(readPaging), () => null),
	};
};

export interface Batch {
	results: HubRecord[];
}

export const readBatch: Reader<Batch> = (value) => ({ results: field(dict(value), "results", list(readRecord), () => []) });

export interface Stage {
	id: string;
	label: string;
	displayOrder: bigint;
	archived: boolean;
	metadata: Map<string, string | null>;
}

export const readStage: Reader<Stage> = (value) => {
	const object = dict(value);
	return {
		id: field(object, "id", str),
		label: field(object, "label", str),
		displayOrder: field(object, "display_order", int, () => 0n),
		archived: field(object, "archived", bool, () => false),
		metadata: field(object, "metadata", stringMap, () => new Map()),
	};
};

export interface Pipeline {
	id: string;
	label: string;
	displayOrder: bigint;
	archived: boolean;
	stages: Stage[];
}

export const readPipeline: Reader<Pipeline> = (value) => {
	const object = dict(value);
	return {
		id: field(object, "id", str),
		label: field(object, "label", str),
		displayOrder: field(object, "display_order", int, () => 0n),
		archived: field(object, "archived", bool, () => false),
		stages: field(object, "stages", list(readStage), () => []),
	};
};

export interface Pipelines {
	results: Pipeline[];
}

export const readPipelines: Reader<Pipelines> = (value) => ({ results: field(dict(value), "results", list(readPipeline), () => []) });

/** `sorted(..., key=lambda x: x.display_order)`: stable, by the integer. */
export function byDisplayOrder<T extends { displayOrder: bigint }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.displayOrder < b.displayOrder ? -1 : a.displayOrder > b.displayOrder ? 1 : 0));
}
