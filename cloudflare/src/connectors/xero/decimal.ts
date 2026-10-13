// Exact decimals for Xero's amounts, quantities and rates: a sign, a string of digits and a power of ten, so
// nothing is ever rounded through a binary float on the way to the text an agent reads or the number Xero
// receives.
//
// Xero sends amounts as JSON numbers. `fromNumber` reads the shortest digits that name the parsed number
// (0.1 is 0.1, 100.0 is 100), which Number#toString gives. An integer beyond 2^53 may already have been
// rounded by parsing, so it is refused (null) rather than shown rounded.

export interface Decimal {
	/** Never set for zero, so zero is shown without a sign. */
	readonly negative: boolean;
	/** Digits without leading zeros; "0" for zero. */
	readonly digits: string;
	/** The value is digits × 10^exponent. */
	readonly exponent: number;
}

const SHORTEST = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;
const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;

function make(negative: boolean, digits: string, exponent: number): Decimal {
	const trimmed = digits.replace(/^0+(?=\d)/, "");
	return { negative: negative && trimmed !== "0", digits: trimmed, exponent };
}

/** A JSON number as the decimal its shortest digits name. Null for one Minerva cannot read exactly. */
export function fromNumber(value: number): Decimal | null {
	if (!Number.isFinite(value)) return null;
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
	const match = SHORTEST.exec(Math.abs(value).toString());
	if (match === null) return null;
	const [, whole = "", fraction = "", power = "0"] = match;
	return make(value < 0, whole + fraction, Number(power) - fraction.length);
}

/** A decimal written as digits, an optional point and fraction, and an optional leading minus. */
export function parsePlain(text: string): Decimal | null {
	const match = PLAIN.exec(text);
	if (match === null) return null;
	const [, sign = "", whole = "", fraction = ""] = match;
	return make(sign === "-", whole + fraction, -fraction.length);
}

export function isZero(value: Decimal): boolean {
	return value.digits === "0";
}

/** Trailing zeros removed; zero has exponent 0. */
export function normalize(value: Decimal): Decimal {
	if (isZero(value)) return { negative: false, digits: "0", exponent: 0 };
	const digits = value.digits.replace(/0+$/, "");
	return { negative: value.negative, digits, exponent: value.exponent + (value.digits.length - digits.length) };
}

/** Positional notation, with as many places as the exponent says. */
export function plain(value: Decimal): string {
	const sign = value.negative ? "-" : "";
	if (value.exponent >= 0) return `${sign}${isZero(value) ? "0" : value.digits + "0".repeat(value.exponent)}`;
	const places = -value.exponent;
	const padded = value.digits.padStart(places + 1, "0");
	return `${sign}${padded.slice(0, padded.length - places)}.${padded.slice(padded.length - places)}`;
}

/** The value with exactly `places` decimal places, when it has at most that many; else null. */
function fixed(value: Decimal, places: number): string | null {
	const normal = normalize(value);
	if (normal.exponent < -places) return null;
	return plain({ negative: normal.negative, digits: normal.digits + "0".repeat(normal.exponent + places), exponent: -places });
}

/** An amount: as precise as Xero gave it, with at least two places. */
export function money(value: Decimal): string;
export function money(value: Decimal | null): string | null;
export function money(value: Decimal | null): string | null {
	if (value === null) return null;
	return fixed(value, 2) ?? plain(normalize(value));
}

/** A quantity or rate, without trailing zeros. */
export function number(value: Decimal): string;
export function number(value: Decimal | null): string | null;
export function number(value: Decimal | null): string | null {
	return value === null ? null : plain(normalize(value));
}

function scaledTo(value: Decimal, exponent: number): bigint {
	const magnitude = BigInt(value.digits) * 10n ** BigInt(value.exponent - exponent);
	return value.negative ? -magnitude : magnitude;
}

/** Negative, zero or positive as `a` is less than, equal to or more than `b`. */
export function compare(a: Decimal, b: Decimal): number {
	const exponent = Math.min(a.exponent, b.exponent);
	const left = scaledTo(a, exponent);
	const right = scaledTo(b, exponent);
	return left < right ? -1 : left > right ? 1 : 0;
}
