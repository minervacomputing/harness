// Numeric strings the Google connectors read (Drive's `size`, Gmail's `internalDate`).

import { OperationError } from "../../gateway/connector.ts";

/** The integer written as ASCII digits, or `fallback` for anything else. */
export function digitsOr<T>(text: string | null, fallback: T): bigint | T {
	return text && /^\d+$/.test(text) ? BigInt(text) : fallback;
}

/**
 * A JSON number for an integer read by `digitsOr`. A number JSON readers hold exactly stops at 2^53 - 1,
 * and a size beyond that (nine petabytes) is no answer Drive gives, so it is refused as an unexpected
 * response rather than rounded.
 */
export function jsonInteger(value: bigint, provider: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new OperationError("PROVIDER_FAILED", `${provider} returned an unexpected response.`);
	return Number(value);
}
