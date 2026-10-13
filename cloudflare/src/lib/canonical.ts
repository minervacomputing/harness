// Canonical JSON for the values Minerva hashes or encrypts, which are stored formats: RFC 8785, the JSON
// Canonicalization Scheme (JCS), written by `canonicalize`. Write keys, query hashes, operation
// fingerprints and folder-version digests hash it (`hashInput`); encrypted values (lib/encryption.ts) are
// it, and so is their associated data. What the model or a provider reads is not this: it is
// `JSON.stringify`'s.
//
// The domain is what `parseJson` returns and our own plain objects: null, booleans, finite numbers,
// well-formed strings, arrays and plain objects (prototype Object.prototype or null). Everything else throws
// a TypeError instead of being coerced as JSON.stringify (and `canonicalize`, which follows it) would:
// undefined anywhere (JSON.stringify leaves a member out, so `{a: undefined}` and `{}` would hash alike),
// holes in arrays and properties beside their items, functions, symbols, bigints, boxed primitives, dates,
// maps and other class instances, getters, setters and hidden properties (a hidden `toJSON` included), NaN
// and the infinities, strings and keys with a lone surrogate, cycles. What is written is a checked copy, so
// a value cannot change between the check and the writing, and no `toJSON` is called. A hash is an
// identity, so it also refuses integers beyond ±(2^53 − 1): `parseJson` has already rounded such a
// literal, and two different ones can be the same number. Tool inputs cannot hold one (their integers are
// checked to that range).
//
// JCS sorts keys by UTF-16 code unit and writes numbers as ECMAScript does (-0 as 0); it does not normalize
// Unicode, so "é" and "é" stay different. Each hash covers a purpose label before the JSON
// (`minerva:write-key:` and so on), so equal values hashed for different purposes never collide.

import canonicalize from "canonicalize";

/** Deeper nesting than `parseJson` reads (1,000) plus the objects our callers wrap around it. */
const MAX_DEPTH = 1100;

export interface CanonicalOptions {
	/** The value is an identity: integers beyond ±(2^53 − 1) are refused too. */
	identity?: boolean;
}

/** The RFC 8785 text of `value`, which must be in the domain above. Throws TypeError. */
export function canonicalJson(value: unknown, options: CanonicalOptions = {}): string {
	return canonicalize(snapshot(value, options.identity ?? false, new Set())) as string;
}

/** What each hash is for; the label is part of what it covers. */
export type HashPurpose = "write-key" | "query" | "operation" | "folder-version";

/** The label a hash for `purpose` starts with. */
export function hashLabel(purpose: HashPurpose): string {
	return `minerva:${purpose}:`;
}

/** What a hash for `purpose` covers: its label, then the value's canonical JSON as an identity. */
export function hashInput(purpose: HashPurpose, value: unknown): string {
	return hashLabel(purpose) + canonicalJson(value, { identity: true });
}

/**
 * A detached copy of `value` after checking it, which is what `canonicalize` writes: every property is read
 * once, as a data property (a getter could answer differently the second time), and the copies' prototypes
 * are null, so no `toJSON` (an own hidden one, or one added to Object.prototype or Array.prototype) is called.
 */
function snapshot(value: unknown, identity: boolean, path: Set<object>): unknown {
	switch (typeof value) {
		case "boolean":
			return value;
		case "string":
			if (!value.isWellFormed()) throw new TypeError("A string with a lone surrogate is not canonical JSON.");
			return value;
		case "number":
			if (!Number.isFinite(value)) throw new TypeError(`${value} is not canonical JSON.`);
			if (identity && Number.isInteger(value) && !Number.isSafeInteger(value)) {
				throw new TypeError(`${value} is beyond the integers an identity holds exactly.`);
			}
			return value;
		case "object":
			if (value === null) return null;
			break;
		default:
			throw new TypeError(`A ${value === undefined ? "undefined value" : typeof value} is not canonical JSON.`);
	}
	if (path.has(value)) throw new TypeError("A cyclic value is not canonical JSON.");
	if (path.size >= MAX_DEPTH) throw new TypeError("The value nests too deeply for canonical JSON.");
	path.add(value);
	let copy: unknown[] | Record<string, unknown>;
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("An array subclass is not canonical JSON.");
		// Only its indices and length: JSON has no place for other properties, which would be left out.
		for (const key of Reflect.ownKeys(value)) {
			if (key !== "length" && (typeof key === "symbol" || !isIndex(key, value.length))) throw new TypeError("An array with other properties is not canonical JSON.");
		}
		const items: unknown[] = [];
		// Every index, so a hole throws as an explicit undefined does.
		for (let index = 0; index < value.length; index++) items.push(snapshot(dataOf(value, String(index)), identity, path));
		copy = Object.setPrototypeOf(items, null) as unknown[];
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			// Named without reading the object, whose `constructor` could be a getter.
			throw new TypeError("An object that is not plain is not canonical JSON.");
		}
		const members = Object.create(null) as Record<string, unknown>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("A symbol key is not canonical JSON.");
			if (!key.isWellFormed()) throw new TypeError("A key with a lone surrogate is not canonical JSON.");
			Object.defineProperty(members, key, { value: snapshot(dataOf(value, key), identity, path), enumerable: true, writable: true, configurable: true });
		}
		copy = members;
	}
	path.delete(value);
	return copy;
}

/**
 * An own data property's value; a missing one (a hole) is undefined. A getter or setter throws, and so does
 * a hidden property, which JSON.stringify leaves out (a hidden `toJSON` would replace the whole value).
 */
function dataOf(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) throw new TypeError("A getter or setter is not canonical JSON.");
	if (!descriptor.enumerable) throw new TypeError("A hidden property is not canonical JSON.");
	return descriptor.value;
}

/** Whether `key` is an array index below `length`, in its one spelling. */
function isIndex(key: string, length: number): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
