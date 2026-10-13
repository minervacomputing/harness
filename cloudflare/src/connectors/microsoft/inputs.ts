// Tool input checks of the Microsoft connectors.
//
// - `after(schema, fn)`: `fn` runs on the value once its own checks passed, may change it (a well-known
//   folder name lowercased, a time put in UTC) or refuse it with a TextError, which is the field's message.
// - `objectCheck(fn)`: a check across the fields of an object, run only once every field passed; its
//   TextError is reported at the input as a whole.
//
// Any other error a check throws (a TypeError, a RangeError) is not a validation error: it propagates, and
// the call fails generically.

import { z } from "zod";
import type * as core from "zod/v4/core";
import { TextError, plainText, singleLine } from "../../lib/text.ts";

/** `fn` runs on the validated value, and its TextError is the field's error. */
export function after<S extends z.ZodType, O>(schema: S, fn: (value: z.output<S>) => O) {
	return schema.transform((value, ctx): O => {
		try {
			return fn(value);
		} catch (error) {
			if (!(error instanceof TextError)) throw error;
			ctx.addIssue({ code: "custom", message: error.message, input: value });
			return z.NEVER;
		}
	});
}

/** `singleLine` after the schema's own checks. */
export function singleLineOf<S extends z.ZodType<string>>(schema: S) {
	return after(schema, singleLine);
}

/** `plainText` after the schema's own checks. */
export function plainTextOf<S extends z.ZodType<string>>(schema: S) {
	return after(schema, plainText);
}

/**
 * A check of a strict object: `fn` sees the validated fields, and runs only when they all passed (zod would
 * run it after a field's length check failed too).
 */
export function objectCheck<T>(fn: (value: T) => void): (payload: core.ParsePayload<T>) => void {
	return (payload) => {
		if (payload.issues.length > 0) return;
		try {
			fn(payload.value);
		} catch (error) {
			if (!(error instanceof TextError)) throw error;
			payload.issues.push({ code: "custom", message: error.message, input: payload.value, path: [] });
		}
	};
}
