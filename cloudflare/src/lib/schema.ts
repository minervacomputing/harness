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

import { z } from "zod";
import * as core from "zod/v4/core";
import { codePointLength } from "./text.ts";

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
