// Tool inputs as the Microsoft connectors declare them in Pydantic.
//
// - `after(schema, fn)` is `Annotated[..., AfterValidator(fn)]`: `fn` runs on the value once its own checks
//   passed, may change it (a well-known folder name lowercased, a time put in UTC) or refuse it with a
//   ValueError, which Pydantic reports as "Value error, <message>".
// - `modelValidator(fn)` is `@model_validator(mode="after")`: it runs only once every field passed, and its
//   ValueError is reported at the input as a whole.
// - `pythonPattern` is `Field(pattern=...)` where Python's `\d` (any decimal digit) differs from JavaScript's.
//
// Any other exception a validator raises (a TypeError, an OverflowError) is not a validation error: it
// propagates, and the call fails generically, as it does today.

import { z } from "zod";
import type * as core from "zod/v4/core";
import { TextError, plainText, singleLine } from "../../lib/text.ts";
import { ValueError } from "../../lib/pyerrors.ts";

export { ValueError };

/** A ValueError raised by a validator: Python's own, or a text helper's. */
export function isValueError(error: unknown): error is Error {
	return error instanceof ValueError || error instanceof TextError;
}

export function valueError(message: string): ValueError {
	return new ValueError(message);
}

/** `Annotated[..., AfterValidator(fn)]`: `fn` runs on the validated value, and its ValueError is the field's error. */
export function after<S extends z.ZodType, O>(schema: S, fn: (value: z.output<S>) => O) {
	return schema.transform((value, ctx): O => {
		try {
			return fn(value);
		} catch (error) {
			if (!isValueError(error)) throw error;
			ctx.addIssue({ code: "custom", message: error.message, input: value });
			return z.NEVER;
		}
	});
}

/** `AfterValidator(single_line)`. */
export function singleLineOf<S extends z.ZodType<string>>(schema: S) {
	return after(schema, singleLine);
}

/** `AfterValidator(plain_text)`. */
export function plainTextOf<S extends z.ZodType<string>>(schema: S) {
	return after(schema, plainText);
}

/**
 * `@model_validator(mode="after")` as a check of a strict object: `fn` sees the validated fields, and runs
 * only when they all passed (zod would run it after a field's length check failed too).
 */
export function modelValidator<T>(fn: (value: T) => void): (payload: core.ParsePayload<T>) => void {
	return (payload) => {
		if (payload.issues.length > 0) return;
		try {
			fn(payload.value);
		} catch (error) {
			if (!isValueError(error)) throw error;
			payload.issues.push({ code: "custom", message: error.message, input: payload.value, path: [] });
		}
	};
}

/**
 * A pattern written as Python writes it (`shown`, which the JSON Schema and "String should match pattern"
 * show), matched as Python's regex engine matches it (`actual`): in pydantic-core's regex, `\d` is any
 * Unicode decimal digit, where JavaScript's is ASCII only.
 */
export function pythonPattern(shown: string, actual: RegExp): RegExp {
	const pattern = new RegExp(actual.source, actual.flags);
	Object.defineProperty(pattern, "source", { value: shown });
	Object.defineProperty(pattern, "toString", { value: () => `/${shown}/` });
	return pattern;
}
