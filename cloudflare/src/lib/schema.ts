// zod strings with Pydantic's rules, for every schema ported from a Pydantic model: the API's request
// bodies (web-api 8) and connector inputs (connectors 1.2).
//
// - Lengths count code points, as Python's `len()` and Pydantic's `min_length`/`max_length` do. zod's
//   `.min()`/`.max()` count UTF-16 units, so an emoji would count twice and a message at the limit that
//   today's API accepts would be refused. The checks still raise zod's `too_small`/`too_big` with origin
//   `string`, so http/errors.ts words them as Pydantic does, and JSON Schema still says `minLength` and
//   `maxLength`, which mean code points there too.
// - Stripping (`str_strip_whitespace`, connector inputs only) removes Unicode White_Space from both ends,
//   as pydantic-core does (Rust's `str::trim`). `String.prototype.trim` differs: it also strips U+FEFF and
//   keeps U+0085, so zod's `.trim()` is not used either.
//
// So a port of `Field(min_length=…, max_length=…)` is `str({min, max})` (API) or `strippedStr({min, max})`
// (connector input), never `z.string().min().max().trim()`.
//
// A connector input's `dict[str, …]` is `strictRecord(value)`, and `dict[str, Any]` is `anyRecord()`, never
// `z.record`: zod's record skips a "__proto__" key, and assigns the others to a fresh `{}`, so a key that
// strips to "__proto__" replaces the result's prototype. Python keeps "__proto__" as an ordinary key.

import { z } from "zod";
import * as core from "zod/v4/core";
import { codePointLength } from "./text.ts";
import { extend } from "./arrays.ts";

/** Unicode White_Space, as Rust's `char::is_whitespace` (and so Pydantic) strips it. All are one UTF-16 unit. */
export const WHITE_SPACE: readonly number[] = [
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
	0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

const SPACE = new Set(WHITE_SPACE);

/** `str.strip()` as Pydantic's `str_strip_whitespace` does it: White_Space off both ends. */
export function stripWhitespace(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && SPACE.has(text.charCodeAt(start))) start++;
	while (end > start && SPACE.has(text.charCodeAt(end - 1))) end--;
	return start === 0 && end === text.length ? text : text.slice(start, end);
}

interface CodePointsDef extends core.$ZodCheckDef {
	check: "min_length" | "max_length";
	limit: number;
}

interface CodePointsInternals extends core.$ZodCheckInternals<string> {
	def: CodePointsDef;
}

interface CodePoints extends core.$ZodCheck<string> {
	_zod: CodePointsInternals;
}

// An assertion function must be called through a name with an explicit type.
const Check: core.$constructor<core.$ZodCheck<string>> = core.$ZodCheck;

const CodePoints = core.$constructor<CodePoints>("MinervaCodePoints", (inst, def) => {
	Check.init(inst, def);
	const max = def.check === "max_length";
	// What zod's own length checks record, so JSON Schema writes minLength and maxLength.
	inst._zod.onattach.push((schema) => {
		const bag = schema._zod.bag as { minimum?: number; maximum?: number };
		if (max) bag.maximum = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, def.limit);
		else bag.minimum = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, def.limit);
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = codePointLength(input);
		if (max ? length <= def.limit : length >= def.limit) return;
		payload.issues.push(
			max
				? { origin: "string", code: "too_big", maximum: def.limit, inclusive: true, input, inst, continue: !def.abort }
				: { origin: "string", code: "too_small", minimum: def.limit, inclusive: true, input, inst, continue: !def.abort },
		);
	};
});

export interface Limits {
	/** `min_length`, in code points. */
	min?: number;
	/** `max_length`, in code points. */
	max?: number;
}

function limited(schema: z.ZodString, limits: Limits): z.ZodString {
	const checks: CodePoints[] = [];
	if (limits.min !== undefined) checks.push(new CodePoints({ check: "min_length", limit: limits.min }));
	if (limits.max !== undefined) checks.push(new CodePoints({ check: "max_length", limit: limits.max }));
	return checks.length ? schema.check(...checks) : schema;
}

/** A Pydantic `str` with `Field(min_length, max_length)`: an API body field (not stripped). */
export function str(limits: Limits = {}): z.ZodString {
	return limited(z.string(), limits);
}

/** The same in a connector's input, which strips White_Space before the limits (connectors 1.2). */
export function strippedStr(limits: Limits = {}): z.ZodString {
	return limited(z.string().overwrite(stripWhitespace), limits);
}

/** A length check of `str` or `strippedStr`, which counts code points (zod's own count UTF-16 units). */
export function countsCodePoints(check: core.$ZodCheck<never>): boolean {
	// zod's constructors answer `instanceof` by the instance's traits.
	return check instanceof CodePoints;
}

// Records.

export interface RecordLimits {
	/** `min_length`: items after validation, so keys that strip alike count once. */
	min?: number;
	/** `max_length`, counted the same way. */
	max?: number;
}

export interface StrictRecordDef<V extends core.$ZodType = core.$ZodType> extends core.$ZodTypeDef {
	/** A type zod's own tools do not know, which `checkStrict` (gateway/registry.ts) tells by its trait. */
	type: "custom";
	valueType: V;
	min?: number | undefined;
	max?: number | undefined;
}

export interface StrictRecordInternals<V extends core.$ZodType = core.$ZodType>
	extends core.$ZodTypeInternals<Record<string, core.output<V>>, Record<string, core.input<V>>> {
	def: StrictRecordDef<V>;
}

export interface StrictRecord<V extends core.$ZodType = core.$ZodType>
	extends z.ZodType<Record<string, core.output<V>>, Record<string, core.input<V>>, StrictRecordInternals<V>> {}

/** Python's dict: a plain object, not an array, null or an instance of a class. */
function isDict(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// An assertion function must be called through a name with an explicit type.
const ZodType: core.$constructor<z.ZodType> = z.ZodType;

type Item = readonly [raw: string, result: core.ParsePayload];

const StrictRecordType = core.$constructor<StrictRecord>("MinervaRecord", (inst, def) => {
	ZodType.init(inst, def);
	const finish = (payload: core.ParsePayload, input: Record<string, unknown>, items: readonly Item[]): core.ParsePayload => {
		// Own properties only, defined rather than assigned: "__proto__" is a key like any other, and no
		// prototype is read or replaced. Keys that strip alike keep the first one's place and the last value,
		// as a dict does; each item is validated, and a failure is reported at the key as it was sent.
		const output: Record<string, unknown> = {};
		let valid = true;
		for (const [raw, result] of items) {
			if (result.issues.length) {
				valid = false;
				extend(payload.issues, core.util.prefixIssues(raw, result.issues));
				continue;
			}
			Object.defineProperty(output, stripWhitespace(raw), { value: result.value, enumerable: true, writable: true, configurable: true });
		}
		payload.value = output;
		if (!valid) {
			// An item's issue may let zod go on (a length check's does), but Pydantic runs neither the length
			// check nor an AfterValidator (a refinement here) on a dict whose items failed.
			payload.aborted = true;
			return payload;
		}
		// Pydantic checks the length after validation, and only when every item passed.
		const actual = Object.keys(output).length;
		if (def.min !== undefined && actual < def.min) {
			payload.issues.push({ code: "too_small", origin: "record", minimum: def.min, inclusive: true, actual, input, inst });
		} else if (def.max !== undefined && actual > def.max) {
			payload.issues.push({ code: "too_big", origin: "record", maximum: def.max, inclusive: true, actual, input, inst });
		}
		return payload;
	};
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isDict(input)) {
			payload.issues.push({ code: "invalid_type", expected: "record", input, inst });
			return payload;
		}
		// In the object's own order, which is the text's except that integer-like keys come first: so of
		// " 1 " and "1", the padded one wins wherever it was sent, where Python keeps the later one.
		const pending: (readonly [string, core.util.MaybeAsync<core.ParsePayload>])[] = Object.keys(input).map((raw) => [
			raw,
			def.valueType._zod.run({ value: input[raw], issues: [] }, ctx),
		]);
		if (pending.every((item): item is Item => !(item[1] instanceof Promise))) return finish(payload, input, pending);
		return Promise.all(pending.map(async ([raw, result]): Promise<Item> => [raw, await result])).then((items) => finish(payload, input, items));
	};
	// Pydantic's: an object whose every value is the value's schema, with minProperties and maxProperties.
	inst._zod.processJSONSchema = (ctx, json, params) => {
		json.type = "object";
		json.additionalProperties = core.process(def.valueType, ctx, { ...params, path: [...params.path, "additionalProperties"] });
		if (def.min !== undefined) json.minProperties = def.min;
		if (def.max !== undefined) json.maxProperties = def.max;
	};
});

/**
 * A connector input's `dict[str, V]` with `Field(min_length, max_length)`: keys stripped as strings are,
 * values validated by `valueType`, and errors in Pydantic's words through http/errors.ts.
 */
export function strictRecord<V extends core.$ZodType>(valueType: V, limits: RecordLimits = {}): StrictRecord<V> {
	return new StrictRecordType({ type: "custom", valueType, min: limits.min, max: limits.max }) as StrictRecord<V>;
}

/** `dict[str, Any]`: keys stripped, values left as they are (nested keys too, as Pydantic leaves them). */
export function anyRecord(limits: RecordLimits = {}): StrictRecord<z.ZodUnknown> {
	return strictRecord(z.unknown(), limits);
}

/** Whether a schema is `strictRecord`'s (or `anyRecord`'s). */
export function isStrictRecord(schema: core.$ZodType): schema is StrictRecord {
	return schema instanceof StrictRecordType;
}
