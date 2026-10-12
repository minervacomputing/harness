// Python's datetime as Intercom's operations use it: `datetime.fromisoformat` for `updated_after`, the POSIX
// timestamp it searches with, and `datetime.fromtimestamp(t, UTC).isoformat()` for the times records show.
//
// `fromisoformat` is CPython's C implementation (Modules/_datetimemodule.c, 3.14), which is what runs today,
// not the pure-Python one, which differs at the edges: it reads the UTF-8 bytes of the text, takes any one
// byte as the separator between date and time, finds the time zone at the first "Z", "+" or "-", and ignores
// what follows a fraction's seventh digit. test/fixtures/connectors/intercom/vectors.json compares it with
// Python on hand-written and random strings.

import { utf8 } from "../../lib/bytes.ts";
import { codePointLength } from "../../lib/text.ts";
import { daysBeforeYear, isLeap, pad } from "../../lib/calendar.ts";

const DASH = 0x2d;
const COLON = 0x3a;
const WEEK = 0x57;
const PLUS = 0x2b;
const ZULU = 0x5a;
const DOT = 0x2e;
const COMMA = 0x2c;
const MAX_YEAR = 9999;
/** What `fromtimestamp` can show: 9999-12-31T23:59:59. */
const MAX_TIMESTAMP = 253_402_300_799;
const DAY_MICROSECONDS = 86_400_000_000;

export interface IsoMoment {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
	/** The UTC offset in microseconds, or null for a naive time. */
	offset: number | null;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2 && isLeap(year)) return 29;
	return [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 0;
}

function daysBeforeMonth(year: number, month: number): number {
	let days = 0;
	for (let m = 1; m < month; m++) days += daysInMonth(year, m);
	return days;
}

/** datetime's ordinal: 0001-01-01 is day 1. */
function ordinal(year: number, month: number, day: number): number {
	return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

/** The date of an ordinal (`ord_to_ymd`). */
function fromOrdinal(n: number): [year: number, month: number, day: number] {
	// 400 years have 146097 days, 100 years 36524, 4 years 1461.
	let rest = n - 1;
	const n400 = Math.floor(rest / 146097);
	rest -= n400 * 146097;
	const n100 = Math.floor(rest / 36524);
	rest -= n100 * 36524;
	const n4 = Math.floor(rest / 1461);
	rest -= n4 * 1461;
	const n1 = Math.floor(rest / 365);
	rest -= n1 * 365;
	let year = n400 * 400 + n100 * 100 + n4 * 4 + n1 + 1;
	if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
	let month = 1;
	while (rest >= daysInMonth(year, month)) {
		rest -= daysInMonth(year, month);
		month += 1;
	}
	if (month > 12) {
		year += 1;
		month = 1;
	}
	return [year, month, rest + 1];
}

/** `iso_to_ymd`: an ISO week date as a calendar date, or a negative code. */
function isoToYmd(isoYear: number, week: number, weekday: number): [number, number, number] | number {
	if (isoYear < 1 || isoYear > MAX_YEAR) return -4;
	if (week <= 0 || week >= 53) {
		let outOfRange = true;
		if (week === 53) {
			const firstWeekday = (ordinal(isoYear, 1, 1) + 6) % 7;
			if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))) outOfRange = false;
		}
		if (outOfRange) return -2;
	}
	if (weekday <= 0 || weekday >= 8) return -3;
	const first = ordinal(isoYear, 1, 1);
	const firstWeekday = (first + 6) % 7;
	let monday = first - firstWeekday;
	if (firstWeekday > 3) monday += 7;
	return fromOrdinal(monday + (week - 1) * 7 + weekday - 1);
}

/** The text's UTF-8 bytes, read as C reads a NUL-terminated string: past the end is 0. */
class Bytes {
	readonly #bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	at(index: number): number {
		return this.#bytes[index] ?? 0;
	}

	isDigit(index: number): boolean {
		const byte = this.at(index);
		return byte >= 0x30 && byte <= 0x39;
	}

	/** `parse_digits`: `count` digits at `at`, as [value, position after them], or null. */
	digits(at: number, count: number): [number, number] | null {
		let value = 0;
		for (let i = 0; i < count; i++) {
			if (!this.isDigit(at + i)) return null;
			value = value * 10 + (this.at(at + i) - 0x30);
		}
		return [value, at + count];
	}
}

/** `_find_isoformat_datetime_separator`: where the separator is, from characters 4 and 5. */
function separatorAt(text: Bytes, length: number): number {
	if (length === 7) return 7;
	if (text.at(4) === DASH) {
		if (text.at(5) === WEEK) {
			if (length < 8) return -1;
			if (length > 8 && text.at(8) === DASH) {
				if (length === 9) return -1;
				// YYYY-Www-## is taken to be a hyphen at 8 rather than a number at 10.
				if (length > 10 && text.isDigit(10)) return 8;
				return 10;
			}
			return 8;
		}
		return 10;
	}
	if (text.at(4) === WEEK) {
		let index = 7;
		while (index < length && text.isDigit(index)) index++;
		if (index < 9) return index;
		return index % 2 === 0 ? 7 : 8;
	}
	return 8;
}

/** `parse_isoformat_date`: the date in the first `length` bytes (C's size_t: -1 is unbounded), or null. */
function parseDate(text: Bytes, length: number): [number, number, number] | null {
	const limit = length < 0 ? Number.POSITIVE_INFINITY : length;
	const year = text.digits(0, 4);
	if (year === null) return null;
	let p = year[1];
	const dashed = text.at(p) === DASH;
	if (dashed) p++;
	if (text.at(p) === WEEK) {
		p++;
		const week = text.digits(p, 2);
		if (week === null) return null;
		p = week[1];
		let weekday = 1;
		if (p < limit) {
			if (dashed && text.at(p++) !== DASH) return null;
			const day = text.digits(p, 1);
			if (day === null) return null;
			weekday = day[0];
		}
		const ymd = isoToYmd(year[0], week[0], weekday);
		return typeof ymd === "number" ? null : ymd;
	}
	const month = text.digits(p, 2);
	if (month === null) return null;
	p = month[1];
	if (dashed && text.at(p++) !== DASH) return null;
	const day = text.digits(p, 2);
	if (day === null) return null;
	return [year[0], month[0], day[0]];
}

interface Clock {
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
}

/** `parse_hh_mm_ss_ff` between `start` and `stop`: the fields and C's return code (negative on failure). */
function parseClock(text: Bytes, start: number, stop: number): [Clock, number] {
	const clock: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
	const fields = ["hour", "minute", "second"] as const;
	let p = start;
	let separated = true;
	for (let i = 0; i < 3; i++) {
		const read = text.digits(p, 2);
		if (read === null) return [clock, -3];
		clock[fields[i] as (typeof fields)[number]] = read[0];
		p = read[1];
		const c = text.at(p++);
		if (i === 0) separated = c === COLON;
		// A decimal mark needs digits after it, and only seconds take one.
		if (c === DOT || c === COMMA) {
			if (i < 2) return [clock, -3];
			break;
		}
		if (p >= stop) return [clock, c !== 0 ? 1 : 0];
		if (separated && c === COLON) {
			if (i === 2) return [clock, -4];
			continue;
		}
		if (!separated) p--;
		else return [clock, -4];
	}
	const count = Math.min(stop - p, 6);
	if (count <= 0) return [clock, -3];
	const fraction = text.digits(p, count);
	if (fraction === null) return [clock, -3];
	clock.microsecond = fraction[0] * 10 ** (6 - count);
	p = fraction[1];
	// Digits past the sixth are dropped.
	while (text.isDigit(p)) p++;
	return [clock, text.at(p) !== 0 ? 1 : 0];
}

function validClock(clock: Clock): boolean {
	return clock.hour <= 23 && clock.minute <= 59 && clock.second <= 59 && clock.microsecond <= 999_999;
}

/** `parse_isoformat_time` from `start` to `stop`: the time, its UTC offset (microseconds) or null, or null when malformed. */
function parseTime(text: Bytes, start: number, stop: number): [Clock, number | null] | null {
	let tz = start;
	do {
		const byte = text.at(tz);
		if (byte === ZULU || byte === PLUS || byte === DASH) break;
	} while (++tz < stop);
	const [clock, rv] = parseClock(text, start, tz);
	if (rv < 0) return null;
	if (tz === stop) return rv === 1 ? null : [clock, null];
	if (text.at(tz) === ZULU) return text.at(tz + 1) !== 0 ? null : [clock, 0];
	const sign = text.at(tz) === DASH ? -1 : 1;
	const [zone, zoneRv] = parseClock(text, tz + 1, stop);
	if (zoneRv !== 0) return null;
	// The offset's fields are not limited ("+01:75" is 2:15), but a timezone is less than a day off UTC.
	const offset = sign * ((zone.hour * 3600 + zone.minute * 60 + zone.second) * 1_000_000 + zone.microsecond);
	if (Math.abs(offset) >= DAY_MICROSECONDS) return null;
	return [clock, offset];
}

/** `datetime.fromisoformat(value)`, or null where it raises ValueError. */
export function fromIsoFormat(value: string): IsoMoment | null {
	if (!value.isWellFormed() || codePointLength(value) < 7) return null;
	// Any one character may separate date and time: one beyond ASCII where the separator is (found on the
	// characters) reads as "T". Everything else is parsed as UTF-8 bytes, where no byte beyond ASCII matches.
	const characters = Array.from(value);
	const view = Uint8Array.from(characters, (char) => Math.min(char.codePointAt(0) as number, 0xff));
	const at = separatorAt(new Bytes(view), characters.length);
	if (at >= 0 && (characters[at]?.codePointAt(0) ?? 0) > 0x7f) characters[at] = "T";
	const encoded = utf8(characters.join(""));
	const length = encoded.length;
	const text = new Bytes(encoded);
	const separator = separatorAt(text, length);
	const date = parseDate(text, separator);
	if (date === null) return null;
	let [year, month, day] = date;
	let clock: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
	let offset: number | null = null;
	if (length > separator) {
		const time = parseTime(text, separator + 1, length);
		if (time === null) return null;
		[clock, offset] = time;
	}
	let { hour } = clock;
	// 24:00 is midnight of the next day, for a month that exists and a day up to its last (day 0 included).
	if (hour === 24 && month >= 1 && month <= 12) {
		const days = daysInMonth(year, month);
		if (day <= days) {
			if (clock.minute !== 0 || clock.second !== 0 || clock.microsecond !== 0) return null;
			// Midnight of the next day.
			hour = 0;
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
	if (year < 1 || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
	if (!validClock({ ...clock, hour })) return null;
	return { year, month, day, hour, minute: clock.minute, second: clock.second, microsecond: clock.microsecond, offset };
}

/** `int(moment.timestamp())`, a time without a zone taken as UTC. */
export function timestamp(moment: IsoMoment): number {
	const days = ordinal(moment.year, moment.month, moment.day) - ordinal(1970, 1, 1);
	const seconds = days * 86400 + moment.hour * 3600 + moment.minute * 60 + moment.second;
	const micros = seconds * 1_000_000 + moment.microsecond - (moment.offset ?? 0);
	// timedelta.total_seconds() divides microseconds by 10**6 as floats; int() truncates.
	return Math.trunc(micros / 1_000_000);
}

/** `datetime.fromtimestamp(t, UTC).isoformat()` with "Z", for a positive timestamp it can show; else null. */
export function isoOf(seconds: number | null): string | null {
	if (seconds === null || seconds <= 0 || seconds > MAX_TIMESTAMP || !Number.isInteger(seconds)) return null;
	const date = new Date(seconds * 1000);
	return (
		`${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
	);
}
