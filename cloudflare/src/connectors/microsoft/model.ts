// Graph's answers read as backend/connectors/microsoft/__init__.py's `Model` reads them: Pydantic models in
// lax mode with `extra="ignore"`, camelCase aliases and `populate_by_name=True`. A field is taken from its
// alias, else from its own name, else its default; a field without a default must be there. Values convert
// as Pydantic's lax mode converts them from JSON (an int from "5" or 5.0, a bool from "yes" or 1); anything
// else does not fit, and the client answers that Graph returned an unexpected response.
//
// These are not tool inputs (those are zod schemas held to OperationInput's strict rules); they only read
// what a provider sent.

import { laxBoolValue, laxIntValue, toCamel } from "../../lib/lax.ts";

/** A value that does not fit its field. */
export class Invalid extends Error {
	constructor(message = "invalid") {
		super(message);
		this.name = "Invalid";
	}
}

export type Reader<T> = (value: unknown) => T;

export function isDict(value: unknown): value is { [key: string]: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** `str`: a string only. */
export const str: Reader<string> = (value) => {
	if (typeof value !== "string") throw new Invalid();
	return value;
};

/**
 * `int` in lax mode (lib/lax.ts): an integer, a bool, an integral float, or a string of ASCII digits. Integers
 * of 2^53 or more are refused (Python reads them exactly; a double would round them).
 */
export const int: Reader<number> = (value) => {
	const found = laxIntValue(value, 2 ** 53);
	if (found === null) throw new Invalid();
	return found;
};

/** `bool` in lax mode (lib/lax.ts): a bool, 0 or 1, or one of Pydantic's words for them. */
export const bool: Reader<boolean> = (value) => {
	const found = laxBoolValue(value);
	if (found === null) throw new Invalid();
	return found;
};

/** `dict[str, Any]`. */
export const dict: Reader<{ [key: string]: unknown }> = (value) => {
	if (!isDict(value)) throw new Invalid();
	return value;
};

/** `X | None`. */
export function nullable<T>(reader: Reader<T>): Reader<T | null> {
	return (value) => (value === null ? null : reader(value));
}

/** `list[X]`. */
export function list<T>(reader: Reader<T>): Reader<T[]> {
	return (value) => {
		if (!Array.isArray(value)) throw new Invalid();
		return value.map((item) => reader(item));
	};
}

export interface Field<T> {
	read: Reader<T>;
	/** Graph's name for it; by default the field's name in camelCase. */
	alias?: string;
	/** Absent: the field is required. */
	fallback?: () => T;
}

/** A required field. */
export function required<T>(read: Reader<T>, alias?: string): Field<T> {
	return alias === undefined ? { read } : { read, alias };
}

/** A field with a default (`= value`). */
export function optional<T>(read: Reader<T>, fallback: T, alias?: string): Field<T> {
	const field: Field<T> = { read, fallback: () => (Array.isArray(fallback) ? ([...fallback] as T) : fallback) };
	if (alias !== undefined) field.alias = alias;
	return field;
}

type Shape = { [name: string]: Field<unknown> };
export type Out<S extends Shape> = { [K in keyof S]: S[K] extends Field<infer T> ? T : never };

/** A model: a dict whose fields are read by alias, then by name, then defaulted; other keys are ignored. */
export function model<S extends Shape>(shape: S): Reader<Out<S>> {
	return (value) => {
		if (!isDict(value)) throw new Invalid();
		const out: { [name: string]: unknown } = {};
		for (const [name, field] of Object.entries(shape)) {
			const alias = field.alias ?? toCamel(name);
			let raw: unknown;
			let present = true;
			if (Object.hasOwn(value, alias)) raw = value[alias];
			else if (Object.hasOwn(value, name)) raw = value[name];
			else present = false;
			if (present) out[name] = field.read(raw);
			else if (field.fallback !== undefined) out[name] = field.fallback();
			else throw new Invalid(`missing ${name}`);
		}
		return out as Out<S>;
	};
}
