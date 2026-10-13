// The parts of Python's datetime the Slack connector computes with (connectors/slack/connector.py
// `_moment` and `_time`), as CPython 3.14 computes them with the C module the backend runs
// (test/fixtures/connectors/slack/vectors.json pins it):
//
// - `datetime.fromisoformat(value)`, which lib/isoformat.ts reads, a time with no zone being UTC, as the
//   instant in microseconds;
// - `f"{dt.timestamp():.6f}"`: the instant as a float (Python's int true division, correctly rounded), then
//   written with six decimals rounded half to even on the float's exact value, so instants far from 1970
//   lose their last microsecond as Python's do ("8000-06-15T12:34:56.789012Z" is 190302784496.789001);
// - `datetime.fromtimestamp(float(ts), UTC).isoformat()`, with the microseconds rounded half to even from
//   the float's fraction as CPython's `_PyTime_ObjectToTimeval` does, and left out when zero.
//
// Times are integers (BigInt microseconds) throughout; the one float is the value Python itself writes, and
// no step goes through `Date`, whose milliseconds would drop the microseconds of a Slack `ts`.

import { datetimeFromIsoFormat, fromOrdinal, pad, unixMicros } from "../../lib/isoformat.ts";
import { TextError } from "../../lib/text.ts";

export class IsoFormatError extends Error {
	constructor() {
		super("Invalid isoformat string");
		this.name = "IsoFormatError";
	}
}

const MINYEAR = 1;
const MAXYEAR = 9999;
const US_PER_SECOND = 1_000_000n;
/** `_ymd2ord(1970, 1, 1)`. */
const EPOCH_ORDINAL = 719_163;

/**
 * `datetime.fromisoformat(value)` as the instant it names, in microseconds since 1970-01-01T00:00:00Z; a
 * time without a zone is UTC. Throws IsoFormatError for anything the parser refuses, whichever
 * message.
 */
export function isoInstant(value: string): bigint {
	try {
		return unixMicros(datetimeFromIsoFormat(value));
	} catch (error) {
		if (error instanceof TextError) throw new IsoFormatError();
		throw error;
	}
}

function bitLength(value: bigint): number {
	return value === 0n ? 0 : value.toString(2).length;
}

/** `n / d` as Python's int true division gives it: the double nearest the exact quotient, ties to even. */
export function trueDivide(n: bigint, d: bigint): number {
	if (d <= 0n) throw new RangeError("The divisor is positive.");
	if (n === 0n) return 0;
	const negative = n < 0n;
	const a = negative ? -n : n;
	// m = a * 2^k / d with 2^52 <= m < 2^53, then rounded half to even.
	let k = 53 - (bitLength(a) - bitLength(d));
	const scaled = (shift: number): [bigint, bigint] => {
		const numerator = shift >= 0 ? a << BigInt(shift) : a;
		const denominator = shift >= 0 ? d : d << BigInt(-shift);
		return [numerator / denominator, numerator % denominator];
	};
	let [m, r] = scaled(k);
	while (m >= 1n << 53n) [m, r] = scaled(--k);
	while (m < 1n << 52n) [m, r] = scaled(++k);
	const denominator = k >= 0 ? d : d << BigInt(-k);
	if (2n * r > denominator || (2n * r === denominator && (m & 1n) === 1n)) m += 1n;
	const value = Number(m) * 2 ** -k;
	return negative ? -value : value;
}

/** The exact value of a finite double as a sign, an integer mantissa and a power of two. */
function exact(x: number): { negative: boolean; mantissa: bigint; exponent: number } {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, x);
	const bits = view.getBigUint64(0);
	const negative = bits >> 63n === 1n;
	const biased = Number((bits >> 52n) & 0x7ffn);
	const fraction = bits & ((1n << 52n) - 1n);
	if (biased === 0x7ff) throw new RangeError("Not a finite number.");
	return biased === 0
		? { negative, mantissa: fraction, exponent: -1074 }
		: { negative, mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/** `f"{x:.6f}"`: the double's exact value rounded half to even to six decimals. */
export function fixed6(x: number): string {
	const { negative, mantissa, exponent } = exact(x);
	let units: bigint;
	if (exponent >= 0) units = (mantissa * US_PER_SECOND) << BigInt(exponent);
	else {
		const numerator = mantissa * US_PER_SECOND;
		const denominator = 1n << BigInt(-exponent);
		units = numerator / denominator;
		const twice = 2n * (numerator % denominator);
		if (twice > denominator || (twice === denominator && (units & 1n) === 1n)) units += 1n;
	}
	const whole = units / US_PER_SECOND;
	const fraction = (units % US_PER_SECOND).toString().padStart(6, "0");
	return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** `f"{datetime.fromisoformat(value).timestamp():.6f}"`, a time without a zone being UTC. */
export function isoTimestamp(value: string): string {
	return fixed6(trueDivide(isoInstant(value), US_PER_SECOND));
}

/** C's `round()`: halves away from zero. */
function roundAway(x: number): number {
	return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** CPython's `_PyTime_RoundHalfEven`. */
function roundHalfEven(x: number): number {
	const rounded = roundAway(x);
	return Math.abs(x - rounded) === 0.5 ? 2 * roundAway(x / 2) : rounded;
}

/** `datetime.fromtimestamp(seconds, UTC).isoformat()`, which ends in "+00:00". */
export function utcIsoformat(seconds: number): string {
	if (!Number.isFinite(seconds)) throw new RangeError("Not a finite number.");
	let whole = Math.trunc(seconds);
	let us = roundHalfEven((seconds - whole) * 1e6);
	if (us >= 1e6) {
		us -= 1e6;
		whole += 1;
	} else if (us < 0) {
		us += 1e6;
		whole -= 1;
	}
	const days = Math.floor(whole / 86400);
	const rest = whole - days * 86400;
	const { year, month, day } = fromOrdinal(days + EPOCH_ORDINAL);
	if (year < MINYEAR || year > MAXYEAR) throw new RangeError("year is out of range");
	const clock = `${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor(rest / 60) % 60, 2)}:${pad(rest % 60, 2)}`;
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${clock}${us ? `.${pad(us, 6)}` : ""}+00:00`;
}
