import { daysBeforeYear, isLeap, pad } from "../../lib/calendar.ts";
// The parts of Python's datetime the Slack connector computes with (connectors/slack/connector.py
// `_moment` and `_time`), as CPython 3.14 computes them with the C module the backend runs
// (Modules/_datetimemodule.c; test/fixtures/connectors/slack/vectors.json pins it):
//
// - `datetime.fromisoformat(value)`, a time with no zone read as UTC, as the instant in microseconds. The C
//   module parses the text's UTF-8 bytes and differs from the pure-Python _pydatetime.py in what it lets
//   through: a separator of several bytes is skipped whole, a character before the zone's sign is not
//   checked ("2026-10-01T09x+01:00" is 09:00 at +01:00), digits after the sixth decimal before a zone are
//   not checked either, and a date followed by a separator and nothing else is refused;
// - `f"{dt.timestamp():.6f}"`: the instant as a float (Python's int true division, correctly rounded), then
//   written with six decimals rounded half to even on the float's exact value, so instants far from 1970
//   lose their last microsecond as Python's do ("8000-06-15T12:34:56.789012Z" is 190302784496.789001);
// - `datetime.fromtimestamp(float(ts), UTC).isoformat()`, with the microseconds rounded half to even from
//   the float's fraction as CPython's `_PyTime_ObjectToTimeval` does, and left out when zero.
//
// Times are integers (BigInt microseconds) throughout; the one float is the value Python itself writes.

export class IsoFormatError extends Error {
	constructor() {
		super("Invalid isoformat string");
		this.name = "IsoFormatError";
	}
}

const MINYEAR = 1;
const MAXYEAR = 9999;
const DAYS_IN_MONTH = [-1, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const DAYS_BEFORE_MONTH: readonly number[] = (() => {
	const before = [-1];
	let days = 0;
	for (const length of DAYS_IN_MONTH.slice(1)) {
		before.push(days);
		days += length;
	}
	return before;
})();
const US_PER_SECOND = 1_000_000n;
const US_PER_DAY = 86_400n * US_PER_SECOND;
/** `_ymd2ord(1970, 1, 1)`. */
const EPOCH_ORDINAL = 719_163;
const FRACTION_CORRECTION = [100000, 10000, 1000, 100, 10] as const;

function fail(): never {
	throw new IsoFormatError();
}

/** Floor division, as Python's `//`. */
function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

function daysInMonth(year: number, month: number): number {
	return month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month] as number);
}

function daysBeforeMonth(year: number, month: number): number {
	return (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && isLeap(year) ? 1 : 0);
}

/** `_ymd2ord`: days since 0001-01-01, which is day 1. */
export function ymdToOrdinal(year: number, month: number, day: number): number {
	return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

const DI400Y = daysBeforeYear(401);
const DI100Y = daysBeforeYear(101);
const DI4Y = daysBeforeYear(5);

/** `_ord2ymd`. */
export function ordinalToYmd(ordinal: number): [year: number, month: number, day: number] {
	let n = ordinal - 1;
	const n400 = floorDiv(n, DI400Y);
	n -= n400 * DI400Y;
	let year = n400 * 400 + 1;
	const n100 = floorDiv(n, DI100Y);
	n -= n100 * DI100Y;
	const n4 = floorDiv(n, DI4Y);
	n -= n4 * DI4Y;
	const n1 = floorDiv(n, 365);
	n -= n1 * 365;
	year += n100 * 100 + n4 * 4 + n1;
	if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
	const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
	let month = (n + 50) >> 5;
	let preceding = (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && leap ? 1 : 0);
	if (preceding > n) {
		month -= 1;
		preceding -= (DAYS_IN_MONTH[month] as number) + (month === 2 && leap ? 1 : 0);
	}
	return [year, month, n - preceding + 1];
}

function isoWeek1Monday(year: number): number {
	const firstDay = ymdToOrdinal(year, 1, 1);
	const firstWeekday = (firstDay + 6) % 7;
	let monday = firstDay - firstWeekday;
	if (firstWeekday > 3) monday += 7;
	return monday;
}

/** `iso_to_ymd`; the year it returns may be 10000, which the constructor's checks refuse. */
function isoToYmd(year: number, week: number, day: number): [number, number, number] {
	if (year < MINYEAR || year > MAXYEAR) fail();
	if (week <= 0 || week >= 53) {
		let outOfRange = true;
		if (week === 53) {
			// ISO years have 53 weeks when they start on a Thursday, or on a Wednesday in a leap year.
			const firstWeekday = (ymdToOrdinal(year, 1, 1) + 6) % 7;
			if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))) outOfRange = false;
		}
		if (outOfRange) fail();
	}
	if (day <= 0 || day >= 8) fail();
	return ordinalToYmd(isoWeek1Monday(year) + (week - 1) * 7 + (day - 1));
}

// The C module parses the string's UTF-8 bytes, which end in a NUL that some of its checks read: a byte
// past the text is 0 here, as there, and a NUL inside the text ends a component as the terminator does.

const NUL = 0;
const DASH = 0x2d;
const PLUS = 0x2b;
const COLON = 0x3a;
const DOT = 0x2e;
const COMMA = 0x2c;
const UPPER_W = 0x57;
const UPPER_Z = 0x5a;

type Bytes = Uint8Array;

function at(bytes: Bytes, index: number): number {
	return bytes[index] ?? NUL;
}

function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39;
}

/** `parse_digits`: `count` ASCII digits at `start`, or null. */
function digits(bytes: Bytes, start: number, count: number): number | null {
	let value = 0;
	for (let i = 0; i < count; i++) {
		const byte = at(bytes, start + i);
		if (!isDigit(byte)) return null;
		value = value * 10 + (byte - 0x30);
	}
	return value;
}

function required(value: number | null): number {
	return value === null ? fail() : value;
}

/**
 * `_find_isoformat_datetime_separator`: where the date ends (7, 8 or 10, or after the digits of a week
 * date without separators), or -1.
 */
function separatorAt(bytes: Bytes, length: number): number {
	if (length === 7) return 7;
	if (at(bytes, 4) === DASH) {
		if (at(bytes, 5) !== UPPER_W) return 10;
		if (length < 8) return -1;
		if (length > 8 && at(bytes, 8) === DASH) {
			if (length === 9) return -1;
			if (length > 10 && isDigit(at(bytes, 10))) return 8;
			return 10;
		}
		return 8;
	}
	if (at(bytes, 4) !== UPPER_W) return 8;
	let index = 7;
	while (index < length && isDigit(at(bytes, index))) index++;
	if (index < 9) return index;
	return index % 2 === 0 ? 7 : 8;
}

/**
 * `parse_isoformat_date` over the first `length` bytes (-1: no limit, as C's size_t reads it). It reads
 * only what its format needs, so bytes before `length` may go unread.
 */
function parseDate(bytes: Bytes, length: number): [number, number, number] {
	let p = 0;
	const year = required(digits(bytes, p, 4));
	p += 4;
	const separated = at(bytes, p) === DASH;
	if (separated) p++;
	if (at(bytes, p) === UPPER_W) {
		p++;
		const week = required(digits(bytes, p, 2));
		p += 2;
		let day = 1;
		if (length < 0 || p < length) {
			if (separated && at(bytes, p++) !== DASH) fail();
			day = required(digits(bytes, p, 1));
		}
		return isoToYmd(year, week, day);
	}
	const month = required(digits(bytes, p, 2));
	p += 2;
	if (separated && at(bytes, p++) !== DASH) fail();
	return [year, month, required(digits(bytes, p, 2))];
}

/** `parse_hh_mm_ss_ff`'s answer: negative for an error, 1 when it did not end at the text's end, else 0. */
interface Clock {
	rv: number;
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
}

/** `parse_hh_mm_ss_ff` over bytes `start` to `end`: HH[:?MM[:?SS[{.,}ffffff…]]]. */
function parseClock(bytes: Bytes, start: number, end: number): Clock {
	const values = [0, 0, 0];
	const clock = (rv: number, microsecond = 0): Clock => ({
		rv,
		hour: values[0] as number,
		minute: values[1] as number,
		second: values[2] as number,
		microsecond,
	});
	let p = start;
	let separated = true;
	for (let i = 0; i < 3; i++) {
		const value = digits(bytes, p, 2);
		if (value === null) return clock(-3);
		values[i] = value;
		p += 2;
		const c = at(bytes, p++);
		if (i === 0) separated = c === COLON;
		// A decimal mark with no digits after it is refused (CPython 3.14); any other character left at the
		// end only says that the text goes on.
		if (p >= end) return clock(c === DOT || c === COMMA ? -3 : c !== NUL ? 1 : 0);
		if (separated && c === COLON) {
			if (i === 2) return clock(-4);
			continue;
		}
		if (c === DOT || c === COMMA) {
			if (i < 2) return clock(-3);
			break;
		}
		if (separated) return clock(-4);
		p--;
	}
	const count = Math.min(end - p, 6);
	let microsecond = digits(bytes, p, count);
	if (microsecond === null) return clock(-3);
	p += count;
	if (count < 6) microsecond *= FRACTION_CORRECTION[count - 1] as number;
	while (isDigit(at(bytes, p))) p++;
	return clock(at(bytes, p) !== NUL ? 1 : 0, microsecond);
}

interface ParsedTime {
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
	/** The zone's offset east of UTC; null for none. */
	offsetUs: bigint | null;
}

function microseconds(hours: number, minutes: number, seconds: number, us: number): bigint {
	return ((BigInt(hours) * 60n + BigInt(minutes)) * 60n + BigInt(seconds)) * US_PER_SECOND + BigInt(us);
}

/**
 * `parse_isoformat_time` over bytes `start` to `end`: the clock up to the first "Z", "+" or "-", then the
 * zone. What the clock leaves unread before a zone is not checked (the C module's own leniency:
 * "09x+01:00" is 09:00 at +01:00).
 */
function parseTime(bytes: Bytes, start: number, end: number): ParsedTime {
	let zone = start;
	do {
		const c = at(bytes, zone);
		if (c === UPPER_Z || c === PLUS || c === DASH) break;
	} while (++zone < end);
	const clock = parseClock(bytes, start, zone);
	if (clock.rv < 0) fail();
	const time = { hour: clock.hour, minute: clock.minute, second: clock.second, microsecond: clock.microsecond };
	if (zone === end) {
		if (clock.rv === 1) fail();
		return { ...time, offsetUs: null };
	}
	if (at(bytes, zone) === UPPER_Z) {
		if (at(bytes, zone + 1) !== NUL) fail();
		return { ...time, offsetUs: 0n };
	}
	const offset = parseClock(bytes, zone + 1, end);
	if (offset.rv !== 0) fail();
	const offsetUs = microseconds(offset.hour, offset.minute, offset.second, offset.microsecond) * (at(bytes, zone) === DASH ? -1n : 1n);
	// `timezone(offset)` takes only offsets strictly within a day.
	if (offsetUs <= -US_PER_DAY || offsetUs >= US_PER_DAY) fail();
	return { ...time, offsetUs };
}

/** The bytes of a separator that starts with this byte, as `datetime_fromisoformat` skips it. */
function separatorBytes(lead: number): number {
	if ((lead & 0x80) === 0) return 1;
	if ((lead & 0xf0) === 0xe0) return 3;
	if ((lead & 0xf0) === 0xf0) return 4;
	return 2;
}

/**
 * The text as `datetime_fromisoformat` encodes it: fewer than 7 characters are refused, a lone surrogate
 * is allowed only as the separator (at character 7, 8 or 10, the first of these that is one), where it
 * stands for "T", and any other one cannot be encoded. Tool inputs never hold lone surrogates.
 */
function encoded(value: string): Bytes {
	const chars = Array.from(value);
	if (chars.length < 7) fail();
	const lone = (char: string | undefined) => char !== undefined && char.length === 1 && char >= "\ud800" && char <= "\udfff";
	for (const position of [7, 8, 10]) {
		if (position > chars.length) break;
		if (lone(chars[position])) {
			chars[position] = "T";
			break;
		}
	}
	if (chars.some(lone)) fail();
	return new TextEncoder().encode(chars.join(""));
}

/**
 * `datetime.fromisoformat(value)` as CPython's C module parses it, as the instant it names, in
 * microseconds since 1970-01-01T00:00:00Z; a time without a zone is UTC. Throws IsoFormatError for
 * anything Python refuses (its ValueError, whichever message).
 */
export function isoInstant(value: string): bigint {
	const bytes = encoded(value);
	const length = bytes.length;
	const separator = separatorAt(bytes, length);
	let [year, month, day] = parseDate(bytes, separator);
	let time: ParsedTime = { hour: 0, minute: 0, second: 0, microsecond: 0, offsetUs: null };
	if (length > separator) {
		const start = separator + separatorBytes(at(bytes, separator));
		if (start > length) fail();
		time = parseTime(bytes, start, length);
	}
	if (time.hour === 24 && month >= 1 && month <= 12) {
		// A day past the month's end is left to the constructor's checks, as is month 0.
		const days = daysInMonth(year, month);
		if (day <= days) {
			if (time.minute !== 0 || time.second !== 0 || time.microsecond !== 0) fail();
			// Midnight at the end of the day is the next day's start.
			time.hour = 0;
			day += 1;
			if (day > days) {
				day = 1;
				month += 1;
				if (month > 12) {
					month = 1;
					year += 1;
				}
			}
		}
	}
	// The datetime constructor's checks.
	if (year < MINYEAR || year > MAXYEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail();
	if (time.hour > 23 || time.minute > 59 || time.second > 59) fail();
	const days = BigInt(ymdToOrdinal(year, month, day) - EPOCH_ORDINAL);
	return days * US_PER_DAY + microseconds(time.hour, time.minute, time.second, time.microsecond) - (time.offsetUs ?? 0n);
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
	const [year, month, day] = ordinalToYmd(days + EPOCH_ORDINAL);
	if (year < MINYEAR || year > MAXYEAR) throw new RangeError("year is out of range");
	const clock = `${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor(rest / 60) % 60, 2)}:${pad(rest % 60, 2)}`;
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${clock}${us ? `.${pad(us, 6)}` : ""}+00:00`;
}
