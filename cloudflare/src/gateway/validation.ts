// Strict validation of a tool call's arguments, with Pydantic's outcome (connectors 1.2, 7.1 step 3):
// `op.input.model_validate(raw if raw is not None else {})` and the message
// `"Invalid arguments. " + "; ".join(first 5 "<dotted loc or 'input'>: <msg>")`. The registry already
// requires inputs that are strict at every depth (registry.ts `checkStrict`); this file words zod's issues
// as pydantic-core does and closes the three gaps between them that step 2a left to the executor:
//
// - Unknown fields are one `extra_forbidden` error per key ("Extra inputs are not permitted"), after the
//   object's field errors and in the order the keys were sent, where zod has one `unrecognized_keys`.
// - Every `str` refuses a lone surrogate (`string_unicode`) before its other checks; so does a dict's key,
//   at `<dict>.<key with each surrogate as three U+FFFD>.[key]`. Values validated as `Any` are left as
//   they are, as Pydantic leaves them.
// - A refinement (Pydantic's AfterValidator, "Value error, ...") runs only on a value whose own checks and
//   items all passed, and only the first one that fails; zod runs a list's or an object's refinements
//   after an item failed, and every refinement of a value.
//
// Errors are ordered as pydantic-core reports them: fields in declaration order, then unknown keys, a
// list's items and a dict's keys in input order. Messages follow the vectors in
// test/unit/executor-validation.test.ts, taken from pydantic 2.13 with OperationInput's config. One known
// difference: a nested object that is not one names its model in Pydantic ("Input should be a valid
// dictionary or instance of Inner"); zod has no class name, so the object's `.meta({ title })` is used
// when it has one, and "Input should be a valid dictionary" otherwise.

import { z } from "zod";
import type { $ZodIssue, $ZodLazy, $ZodType, $ZodTypes } from "zod/v4/core";
import type { Json } from "../lib/json.ts";
import { pythonFloat } from "../lib/json.ts";
import { isStrictRecord } from "../lib/schema.ts";
import { pythonRepr } from "../lib/text.ts";

/** At most this many problems are named in the message. */
export const MAX_PROBLEMS = 5;
export const STRING_UNICODE = "Input should be a valid string, unable to parse raw data as a unicode string";
export const EXTRA_FORBIDDEN = "Extra inputs are not permitted";

export type Validated = { ok: true; data: { [key: string]: Json } } | { ok: false; message: string };

type Loc = (string | number)[];

interface Problem {
	loc: Loc;
	msg: string;
	/** Where pydantic-core reports it: indexes along the path, see `orderOf`. */
	order: number[];
	/** A refinement's failure (zod `custom`). */
	custom: boolean;
	/** The order zod reported it in, for ties. */
	seq: number;
	/** A lone surrogate in a str (which fails before its other checks), or in a dict's key. */
	surrogate?: "string" | "key";
	/** A length limit: a list's maximum is checked before its items, a list's minimum and a dict's limits after. */
	bound?: "before" | "after";
}

const MISSING: unique symbol = Symbol("missing");

function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema that validates a value, through the wrappers that only pass it on. */
function unwrap(schema: $ZodType): $ZodType {
	let node = schema;
	for (;;) {
		if (isStrictRecord(node)) return node;
		const def = (node as $ZodTypes)._zod.def;
		switch (def.type) {
			case "optional":
			case "nullable":
			case "default":
			case "prefault":
			case "nonoptional":
			case "readonly":
				node = def.innerType;
				continue;
			case "lazy":
				node = (node as $ZodLazy)._zod.innerType;
				continue;
			case "pipe":
				node = def.in;
				continue;
			default:
				return node;
		}
	}
}

/** One step down the path: the child's schema and where pydantic-core reports it among its siblings. */
function step(schema: $ZodType | null, value: unknown, part: PropertyKey): { schema: $ZodType | null; index: number } {
	if (schema === null) return { schema: null, index: 0 };
	const node = unwrap(schema);
	const inputIndex = () => (isObject(value) ? Object.keys(value).indexOf(String(part)) : 0);
	if (isStrictRecord(node)) return { schema: node._zod.def.valueType, index: inputIndex() };
	const def = (node as $ZodTypes)._zod.def;
	if (def.type === "object") {
		const fields = Object.keys(def.shape);
		const index = fields.indexOf(String(part));
		// Unknown keys are reported after every field, in the order they were sent.
		return index >= 0 ? { schema: def.shape[String(part)] ?? null, index } : { schema: null, index: fields.length + inputIndex() };
	}
	if (def.type === "array") return { schema: def.element, index: Number(part) };
	if (def.type === "tuple") return { schema: def.items[Number(part)] ?? def.rest, index: Number(part) };
	return { schema: null, index: 0 };
}

function child(value: unknown, part: PropertyKey): unknown {
	if ((isObject(value) || Array.isArray(value)) && Object.hasOwn(value, part)) return (value as { [key: PropertyKey]: unknown })[part];
	return MISSING;
}

/** The value at `loc`, or MISSING when a step does not exist. */
function valueAt(input: unknown, loc: readonly PropertyKey[]): unknown {
	let value = input;
	for (const part of loc) {
		value = child(value, part);
		if (value === MISSING) return MISSING;
	}
	return value;
}

/** The schema at `loc` (unwrapped) and the order pydantic-core reports a problem there in. */
function locate(root: $ZodType, input: unknown, loc: readonly PropertyKey[]): { schema: $ZodType | null; order: number[] } {
	let schema: $ZodType | null = root;
	let value = input;
	const order: number[] = [];
	for (const part of loc) {
		const next = step(schema, value, part);
		order.push(next.index);
		schema = next.schema;
		value = child(value, part);
	}
	return { schema: schema === null ? null : unwrap(schema), order };
}

function compareOrder(a: Problem, b: Problem): number {
	for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) {
		const difference = (a.order[i] as number) - (b.order[i] as number);
		if (difference !== 0) return difference;
	}
	return a.order.length - b.order.length || a.seq - b.seq;
}

function sameLoc(a: Loc, b: Loc): boolean {
	return a.length === b.length && a.every((part, i) => String(part) === String(b[i]));
}

/** Whether `inner` is strictly inside `outer`. */
function inside(inner: Loc, outer: Loc): boolean {
	return inner.length > outer.length && outer.every((part, i) => String(part) === String(inner[i]));
}

function plural(count: number | bigint, noun: string): string {
	return `${count} ${noun}${Number(count) === 1 ? "" : "s"}`;
}

function pythonNumber(value: number | bigint): string {
	return typeof value === "bigint" || Number.isInteger(value) ? String(value) : pythonFloat(value);
}

/** A literal as Python's `repr` writes it in "Input should be 'a', 'b' or 'c'". */
function literal(value: unknown): string {
	if (typeof value === "string") return pythonRepr(value);
	if (typeof value === "number" || typeof value === "bigint") return pythonNumber(value);
	if (value === true) return "True";
	if (value === false) return "False";
	return "None";
}

function expected(values: readonly unknown[]): string {
	const shown = values.map(literal);
	if (shown.length <= 1) return `Input should be ${shown[0] ?? "None"}`;
	return `Input should be ${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
}

function isInteger(schema: $ZodType): boolean {
	const format = (schema._zod.bag as { format?: unknown }).format;
	return typeof format === "string" && format.includes("int");
}

/** pydantic-core's message when a value has the wrong type for `schema`. */
function wrongType(schema: $ZodType | null, issue: Extract<$ZodIssue, { code: "invalid_type" }>): string {
	if (schema !== null && isStrictRecord(schema)) return "Input should be a valid dictionary";
	const def = schema === null ? null : (schema as $ZodTypes)._zod.def;
	const type = def?.type ?? issue.expected;
	switch (type) {
		case "string":
			return "Input should be a valid string";
		case "number":
			return schema !== null && isInteger(schema) ? "Input should be a valid integer" : "Input should be a valid number";
		case "int":
			return "Input should be a valid integer";
		case "boolean":
			return "Input should be a valid boolean";
		case "array":
			return "Input should be a valid list";
		case "tuple":
			return "Input should be a valid tuple";
		case "record":
			return "Input should be a valid dictionary";
		case "null":
			return "Input should be None";
		case "object": {
			const title = schema === null ? undefined : z.globalRegistry.get(schema as z.ZodType)?.title;
			return typeof title === "string" ? `Input should be a valid dictionary or instance of ${title}` : "Input should be a valid dictionary";
		}
		case "literal":
			return def?.type === "literal" ? expected(def.values) : issue.message;
		case "enum":
			return def?.type === "enum" ? expected(Object.values(def.entries)) : issue.message;
		default:
			return issue.message;
	}
}

function message(issue: $ZodIssue, schema: $ZodType | null, value: unknown): string {
	switch (issue.code) {
		case "invalid_type":
			return value === MISSING ? "Field required" : wrongType(schema, issue);
		case "too_big":
			if (issue.origin === "string") return `String should have at most ${plural(issue.maximum, "character")}`;
			if (issue.origin === "array") return `List should have at most ${plural(issue.maximum, "item")} after validation, not ${Array.isArray(value) ? value.length : "more"}`;
			if (issue.origin === "record") {
				return `Dictionary should have at most ${plural(issue.maximum, "item")} after validation, not ${(issue as { actual?: unknown }).actual ?? (isObject(value) ? Object.keys(value).length : "more")}`;
			}
			return issue.inclusive === false ? `Input should be less than ${pythonNumber(issue.maximum)}` : `Input should be less than or equal to ${pythonNumber(issue.maximum)}`;
		case "too_small":
			if (issue.origin === "string") return `String should have at least ${plural(issue.minimum, "character")}`;
			if (issue.origin === "array") return `List should have at least ${plural(issue.minimum, "item")} after validation, not ${Array.isArray(value) ? value.length : 0}`;
			if (issue.origin === "record") {
				return `Dictionary should have at least ${plural(issue.minimum, "item")} after validation, not ${(issue as { actual?: unknown }).actual ?? (isObject(value) ? Object.keys(value).length : 0)}`;
			}
			return issue.inclusive === false ? `Input should be greater than ${pythonNumber(issue.minimum)}` : `Input should be greater than or equal to ${pythonNumber(issue.minimum)}`;
		case "invalid_format": {
			if (issue.format !== "regex") return issue.message;
			// Pydantic shows the pattern as it was given; zod writes it as a regex literal.
			const pattern = /^\/(.*)\/[a-z]*$/s.exec(String((issue as { pattern?: unknown }).pattern ?? ""));
			return pattern === null ? issue.message : `String should match pattern '${pattern[1]}'`;
		}
		case "invalid_value":
			return expected(issue.values);
		case "not_multiple_of":
			return `Input should be a multiple of ${pythonNumber(issue.divisor)}`;
		case "custom":
			return `Value error, ${issue.message}`;
		default:
			return issue.message;
	}
}

/** A dict key with lone surrogates as pydantic-core shows it: each one's three UTF-8 bytes as U+FFFD. */
function shownKey(key: string): string {
	let out = "";
	for (let i = 0; i < key.length; i++) {
		const unit = key.charCodeAt(i);
		const next = key.charCodeAt(i + 1);
		if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			out += key[i] + (key[i + 1] as string);
			i++;
		} else if (unit >= 0xd800 && unit <= 0xdfff) out += "���";
		else out += key[i];
	}
	return out;
}

/** Every value validated as a `str`, and every dict key, that holds a lone surrogate. */
function loneSurrogates(root: $ZodType, input: unknown): Problem[] {
	const found: Problem[] = [];
	const walk = (schema: $ZodType, value: unknown, loc: Loc, order: number[]): void => {
		if (value === undefined || value === null) return;
		const node = unwrap(schema);
		if (isStrictRecord(node)) {
			if (!isObject(value)) return;
			Object.keys(value).forEach((key, index) => {
				if (!key.isWellFormed()) found.push({ loc: [...loc, shownKey(key), "[key]"], msg: STRING_UNICODE, order: [...order, index, -1], custom: false, seq: -1, surrogate: "key" });
				walk(node._zod.def.valueType, value[key], [...loc, key], [...order, index]);
			});
			return;
		}
		const def = (node as $ZodTypes)._zod.def;
		if (def.type === "string") {
			if (typeof value === "string" && !value.isWellFormed()) found.push({ loc, msg: STRING_UNICODE, order, custom: false, seq: -1, surrogate: "string" });
		} else if (def.type === "object") {
			if (!isObject(value)) return;
			Object.keys(def.shape).forEach((key, index) => {
				if (Object.hasOwn(value, key)) walk(def.shape[key] as $ZodType, value[key], [...loc, key], [...order, index]);
			});
		} else if (def.type === "array") {
			if (Array.isArray(value)) value.forEach((item, index) => walk(def.element, item, [...loc, index], [...order, index]));
		} else if (def.type === "tuple") {
			if (!Array.isArray(value)) return;
			value.forEach((item, index) => {
				const itemSchema = def.items[index] ?? def.rest;
				if (itemSchema) walk(itemSchema, item, [...loc, index], [...order, index]);
			});
		} else if (def.type === "union") {
			// Pydantic tries each member, and a str member never takes a lone surrogate: the value passes only if
			// a member zod accepts it with takes it without one (an `Any` member does). Which members failed and
			// why is not worded as Pydantic's tagged errors; no connector input has a union besides `X | None`.
			const accepting = def.options.filter((option) => {
				try {
					return (option as z.ZodType).safeParse(value).success;
				} catch {
					return false;
				}
			});
			if (accepting.length > 0 && accepting.every((option) => loneSurrogates(option, value).length > 0)) {
				found.push({ loc, msg: STRING_UNICODE, order, custom: false, seq: -1, surrogate: "string" });
			}
		}
	};
	walk(root, input, [], []);
	return found;
}

function render(problem: Problem): string {
	return `${problem.loc.map(String).join(".") || "input"}: ${problem.msg}`;
}

/** Validates `raw` (null or missing validate as `{}`) and returns the normalized arguments, defaults included. */
export async function validateInput(schema: z.ZodType, raw: Json | undefined): Promise<Validated> {
	const input: Json = raw === undefined || raw === null ? {} : raw;
	const surrogates = loneSurrogates(schema, input);
	const parsed = await schema.safeParseAsync(input);
	if (parsed.success && surrogates.length === 0) return { ok: true, data: parsed.data as { [key: string]: Json } };
	// A str that holds a lone surrogate fails before any other check of it.
	const failedStrings = surrogates.filter((problem) => problem.surrogate === "string");
	const problems: Problem[] = [];
	let seq = 0;
	for (const issue of parsed.success ? [] : parsed.error.issues) {
		const path = issue.path.map((part) => (typeof part === "number" ? part : String(part)));
		const locs: Loc[] = issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...path, key]) : [path];
		for (const loc of locs) {
			if (failedStrings.some((problem) => sameLoc(problem.loc, loc))) continue;
			const { schema: at, order } = locate(schema, input, loc);
			const msg = issue.code === "unrecognized_keys" ? EXTRA_FORBIDDEN : message(issue, at, valueAt(input, loc));
			const length = (issue.code === "too_big" || issue.code === "too_small") && (issue.origin === "array" || issue.origin === "record");
			const bound = !length ? undefined : issue.code === "too_big" && issue.origin === "array" ? "before" : "after";
			problems.push({ loc, msg, order, custom: issue.code === "custom", seq: seq++, ...(bound === undefined ? {} : { bound }) });
		}
	}
	problems.push(...surrogates.map((problem) => ({ ...problem, seq: seq++ })));
	// pydantic-core reports one error per value: the first of its own checks that fails (a str's length, then
	// its pattern), and a refinement's only when none of the others did; refinements stop at the first.
	const first = new Map<string, Problem>();
	for (const problem of problems) {
		const at = JSON.stringify(problem.loc.map(String));
		const seen = first.get(at);
		if (seen === undefined || (seen.custom && !problem.custom)) first.set(at, problem);
	}
	let kept = [...first.values()];
	// A list longer than its maximum is refused before its items are validated (its length is known); a
	// list's minimum, a dict's limits (counted after its keys are stripped), a refinement and a model
	// validator run only once everything inside passed, a dict key with a lone surrogate included.
	const long = kept.filter((problem) => problem.bound === "before");
	kept = kept.filter((problem) => !long.some((list) => inside(problem.loc, list.loc)));
	kept = kept.filter((problem) => !(problem.custom || problem.bound === "after") || !kept.some((other) => inside(other.loc, problem.loc)));
	kept.sort(compareOrder);
	return { ok: false, message: `Invalid arguments. ${kept.slice(0, MAX_PROBLEMS).map(render).join("; ")}` };
}
