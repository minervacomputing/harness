// Provider responses read as backend/connectors/<google>/client.py's Pydantic models read them: unknown
// fields ignored (`extra="ignore"`), each field found under its camelCase alias or its own snake_case name
// (`alias_generator=to_camel, populate_by_name=True`; the alias wins when both are sent), and lax types:
// an `int` also takes a numeric string or a float without a fraction, a `bool` the strings and numbers
// Pydantic accepts. A `str` takes only a string, as in Pydantic. These schemas read what a provider sent,
// never a tool's input (which is strict, lib/schema.ts).

import { z } from "zod";
import { type ModelOptions, laxBoolValue, laxIntValue, model as laxModel } from "../../lib/lax.ts";

/** A response model with the camelCase aliases the Google models have (`alias_generator=to_camel`). */
export function model<Shape extends z.ZodRawShape>(shape: Shape, options: ModelOptions = {}) {
	return laxModel(shape, { camel: true, ...options });
}

/** Pydantic's lax `int` (lib/lax.ts); an integer of 2^53 or more is refused. */
export const laxInt = z.preprocess((value) => laxIntValue(value, 2 ** 53) ?? Number.NaN, z.number());

/** `d[key] = value` on a plain object, as a dict does: an own property even for a key such as "__proto__". */
export function setOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Pydantic's lax `bool` (lib/lax.ts). */
export const laxBool = z.preprocess((value) => laxBoolValue(value) ?? value, z.boolean());
