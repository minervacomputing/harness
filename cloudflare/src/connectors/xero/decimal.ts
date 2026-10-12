// Exact decimals for Xero's amounts, quantities and rates, as backend/connectors/xero uses Python's Decimal:
// a sign, a string of digits and a power of ten, so nothing is ever rounded through a binary float on the way
// to the text an agent reads or the number Xero receives.
//
// What Xero sends is a JSON number, which Pydantic reads as Python reads a float and then turns into the
// decimal its shortest repr names (Decimal('0.1') for 0.1, Decimal('100') for 100.0, Decimal('-0') for
// -0.0); JavaScript's Number#toString gives the same shortest digits, so `fromNumber` reads them from it. An
// integer token beyond 2^53, which Python keeps exactly, has already been rounded by the time it is a
// JavaScript number, so such a value is refused (null) rather than shown rounded.

export interface Decimal {
	/** Also for zero: Python keeps the sign of -0 (`f"{Decimal('-0'):.2f}"` is "-0.00"). */
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
	return { negative, digits: trimmed, exponent };
}

/** The decimal Pydantic makes of a JSON number: its shortest digits. Null for one Minerva cannot read exactly. */
export function fromNumber(value: number): Decimal | null {
	if (!Number.isFinite(value)) return null;
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
	const match = SHORTEST.exec(Math.abs(value).toString());
	if (match === null) return null;
	const [, whole = "", fraction = "", power = "0"] = match;
	return make(value < 0 || Object.is(value, -0), whole + fraction, Number(power) - fraction.length);
}

/** A decimal written as digits, an optional point and fraction, and an optional leading minus. */
export function parsePlain(text: string): Decimal | null {
	const match = PLAIN.exec(text);
	if (match === null) return null;
	const [, sign = "", whole = "", fraction = ""] = match;
	return make(sign === "-", whole + fraction, -fraction.length);
}

export function isZero(value: Decimal): boolean {
	return /^0+$/.test(value.digits);
}

/** `value.normalize()`: trailing zeros removed; zero keeps its sign and has exponent 0. */
export function normalize(value: Decimal): Decimal {
	if (isZero(value)) return { negative: value.negative, digits: "0", exponent: 0 };
	const digits = value.digits.replace(/0+$/, "");
	return { negative: value.negative, digits, exponent: value.exponent + (value.digits.length - digits.length) };
}

/** `f"{value:f}"`: positional notation, the sign kept (also on zero), as many places as the exponent says. */
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
	const scaled: Decimal = { negative: normal.negative, digits: normal.digits + "0".repeat(normal.exponent + places), exponent: -places };
	return plain(isZero(normal) ? { negative: normal.negative, digits: "0".repeat(places + 1), exponent: -places } : scaled);
}

/** organisations.py `money`: as precise as Xero gave it, with at least two places. */
export function money(value: Decimal): string;
export function money(value: Decimal | null): string | null;
export function money(value: Decimal | null): string | null {
	if (value === null) return null;
	return fixed(value, 2) ?? plain(normalize(value));
}

/** organisations.py `number`: a quantity or rate without trailing zeros, and never "-0". */
export function number(value: Decimal): string;
export function number(value: Decimal | null): string | null;
export function number(value: Decimal | null): string | null {
	if (value === null) return null;
	const shown = plain(normalize(value));
	return shown === "-0" ? "0" : shown;
}

function scaledTo(value: Decimal, exponent: number): bigint {
	const magnitude = BigInt(value.digits) * 10n ** BigInt(value.exponent - exponent);
	return value.negative ? -magnitude : magnitude;
}

/** Negative, zero or positive as `a` is less than, equal to or more than `b` (-0 equals 0). */
export function compare(a: Decimal, b: Decimal): number {
	const exponent = Math.min(a.exponent, b.exponent);
	const left = scaledTo(a, exponent);
	const right = scaledTo(b, exponent);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** A value as JSON writes a number: the text is the decimal itself (Xero takes amounts as JSON numbers). */
export class JsonNumber {
	readonly text: string;

	constructor(value: Decimal) {
		const shown = plain(normalize(value));
		this.text = shown === "-0" ? "0" : shown;
	}
}

export type JsonBody = null | boolean | string | JsonNumber | JsonBody[] | { [key: string]: JsonBody };

/** A request body as compact JSON (httpx's separators), with amounts written as their decimal text. */
export function jsonText(value: JsonBody): string {
	if (value instanceof JsonNumber) return value.text;
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(jsonText).join(",")}]`;
	return `{${Object.entries(value)
		.map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item)}`)
		.join(",")}}`;
}
