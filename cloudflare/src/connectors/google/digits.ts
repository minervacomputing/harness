// `int(text) if text.isdigit() else fallback`, as the Google connectors read numeric strings (Drive's
// `size`, Gmail's `internalDate`). `isdigit()` accepts any Unicode digit, `int()` only decimal ones, so a
// superscript passes the first and fails the second: Python then raises, and so does this. The digit tables
// are Python's (src/lib/digits.ts).

import { OperationError } from "../../gateway/connector.ts";
import { digitValue, isDigitOnly } from "../../lib/digits.ts";

export class NotAnInteger extends Error {
	constructor(text: string) {
		super(`invalid literal for int() with base 10: '${text}'`);
		this.name = "ValueError";
	}
}

/** The integer, `fallback` when `isdigit()` is false, or NotAnInteger where `int()` would raise. */
export function digitsOr<T>(text: string | null, fallback: T): bigint | T {
	if (!text) return fallback;
	let value = 0n;
	let decimal = true;
	for (const char of text) {
		const digit = digitValue(char);
		if (digit !== null) {
			value = value * 10n + BigInt(digit);
		} else if (isDigitOnly(char)) {
			decimal = false;
		} else {
			return fallback;
		}
	}
	if (!decimal) throw new NotAnInteger(text);
	return value;
}

/**
 * A JSON number for an integer read by `digitsOr`. Python keeps any size; a number JSON readers hold exactly
 * stops at 2^53 - 1, and a size beyond that (nine petabytes) is no answer Drive gives, so it is refused as an
 * unexpected response rather than rounded.
 */
export function jsonInteger(value: bigint, provider: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new OperationError("PROVIDER_FAILED", `${provider} returned an unexpected response.`);
	return Number(value);
}
