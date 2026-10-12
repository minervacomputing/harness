// Dates and times as Google Calendar's inputs check them (backend/connectors/google_calendar/connector.py
// `_date_time`, `_date_or_date_time`): a pattern first, then Python's `date.fromisoformat` and
// `datetime.fromisoformat` (CPython's C implementation), whose error messages reach the model as
// "Value error, …". Both patterns use Python's `\d`, which matches any Unicode decimal digit (Unicode 16, as lib/digits.ts pins it); the parsers
// then refuse non-ASCII digits as an invalid isoformat string.
//
// What CPython checks, in order: the string's format (date, time, offset); the offset, strictly within
// ±24 h; an hour of 24, which with a valid month and a day not past its end needs zero minutes, seconds
// and microseconds and then means midnight of the next day; then the date's fields and the time's.

import { DIGIT_CLASS } from "../../lib/digits.ts";
import { pythonRepr } from "../../lib/text.ts";
import { daysBeforeYear, isLeap } from "../../lib/calendar.ts";

// Python's `\d` is pinned to Unicode 16 (src/lib/digits.ts), not the runtime's `\p{Nd}`.
const D = DIGIT_CLASS;
export const DATE = new RegExp(`^${D}{4}-${D}{2}-${D}{2}$`, "u");
export const DATE_TIME = new RegExp(`^${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}(:${D}{2}(\\.${D}{1,6})?)?(Z|[+-]${D}{2}:${D}{2})$`, "u");

export const DATE_TIME_MESSAGE = "must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00";

/** Python's ValueError: its message is the validator's. */
export class TimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeError";
	}
}

function invalid(value: string): TimeError {
	return new TimeError(`Invalid isoformat string: ${pythonRepr(value)}`);
}

const ASCII_DIGITS = /^[0-9]+$/;

function digits(text: string, value: string): number {
	if (!ASCII_DIGITS.test(text)) throw invalid(value);
	return Number(text);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeap(year) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

interface DateFields {
	year: number;
	month: number;
	day: number;
}

function checkDate({ year, month, day }: DateFields): void {
	if (year < 1 || year > 9999) throw new TimeError(`year must be in 1..9999, not ${year}`);
	if (month < 1 || month > 12) throw new TimeError(`month must be in 1..12, not ${month}`);
	const dim = daysInMonth(year, month);
	if (day < 1 || day > dim) throw new TimeError(`day ${day} must be in range 1..${dim} for month ${month} in year ${year}`);
}

/** `datetime.timedelta`'s repr, as `offset must be … not datetime.timedelta(days=1)` shows it. */
export function timedeltaRepr(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const rest = seconds - days * 86400;
	const parts: string[] = [];
	if (days !== 0) parts.push(`days=${days}`);
	if (rest !== 0) parts.push(`seconds=${rest}`);
	return `datetime.timedelta(${parts.length ? parts.join(", ") : "0"})`;
}

/** `date.fromisoformat` for a string the DATE pattern matched; throws TimeError with Python's message. */
export function parseDate(value: string): DateFields {
	const [year, month, day] = value.split("-").map((part) => digits(part, value)) as [number, number, number];
	const fields = { year, month, day };
	checkDate(fields);
	return fields;
}

export interface DateTime extends DateFields {
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
	/** East of UTC. */
	offsetSeconds: number;
}

/** `datetime.fromisoformat` for a string the DATE_TIME pattern matched; throws TimeError with Python's message. */
export function parseDateTime(value: string): DateTime {
	const [datePart, rest] = value.split("T") as [string, string];
	const [year, month, day] = datePart.split("-").map((part) => digits(part, value)) as [number, number, number];
	const match = /(Z|[+-][^+-]*)$/u.exec(rest) as RegExpExecArray;
	const zone = match[1] as string;
	const time = rest.slice(0, match.index);
	const [clock, fraction] = time.split(".") as [string, string | undefined];
	const [hour, minute, second = 0] = clock.split(":").map((part) => digits(part, value)) as [number, number, number?];
	const microsecond = fraction === undefined ? 0 : digits(fraction, value) * 10 ** (6 - fraction.length);
	let offsetSeconds = 0;
	if (zone !== "Z") {
		const sign = zone.startsWith("-") ? -1 : 1;
		const [hours, minutes] = zone.slice(1).split(":").map((part) => digits(part, value)) as [number, number];
		offsetSeconds = sign * (hours * 3600 + minutes * 60);
		if (offsetSeconds <= -86400 || offsetSeconds >= 86400) {
			throw new TimeError(
				`offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(offsetSeconds)}`,
			);
		}
	}
	const fields: DateTime = { year, month, day, hour, minute, second, microsecond, offsetSeconds };
	// CPython looks at an hour of 24 only when the month is valid and the day not past the month's end (a
	// day of 0 and a year of 0 pass, and day 0 becomes day 1); otherwise the date's own check fails below.
	if (hour === 24 && month >= 1 && month <= 12 && day <= daysInMonth(year, month)) {
		if (minute !== 0 || second !== 0 || microsecond !== 0) throw new TimeError("minute, second, and microsecond must be 0 when hour is 24");
		// Midnight of the next day.
		fields.hour = 0;
		fields.day += 1;
		if (fields.day > daysInMonth(year, month)) {
			fields.day = 1;
			fields.month += 1;
			if (fields.month > 12) {
				fields.month = 1;
				fields.year += 1;
			}
		}
	}
	checkDate(fields);
	if (fields.hour > 23) throw new TimeError(`hour must be in 0..23, not ${fields.hour}`);
	if (fields.minute > 59) throw new TimeError(`minute must be in 0..59, not ${fields.minute}`);
	if (fields.second > 59) throw new TimeError(`second must be in 0..59, not ${fields.second}`);
	return fields;
}

/** Days from 0001-01-01 to the date, in the proleptic Gregorian calendar (Python's ordinal minus one). */
function ordinal({ year, month, day }: DateFields): number {
	let days = daysBeforeYear(year);
	for (let m = 1; m < month; m++) days += daysInMonth(year, m);
	return days + day - 1;
}

/** A date as a comparable number (Python compares `date`s by their fields). */
export function dateOrdinal(fields: DateFields): number {
	return ordinal(fields);
}

/** An aware datetime as UTC microseconds since 0001-01-01, as Python compares aware datetimes. */
export function instant(fields: DateTime): bigint {
	const seconds = BigInt(ordinal(fields)) * 86400n + BigInt(fields.hour * 3600 + fields.minute * 60 + fields.second - fields.offsetSeconds);
	return seconds * 1_000_000n + BigInt(fields.microsecond);
}

/** `_date_time`: the pattern, then `datetime.fromisoformat`. */
export function checkDateTime(value: string): string {
	if (!DATE_TIME.test(value)) throw new TimeError(DATE_TIME_MESSAGE);
	parseDateTime(value);
	return value;
}

/** `_date_or_date_time`: a date, or else a date-time. */
export function checkDateOrDateTime(value: string): string {
	if (DATE.test(value)) {
		parseDate(value);
		return value;
	}
	return checkDateTime(value);
}

/** `datetime.now(UTC).isoformat(timespec="seconds")`. */
export function nowIso(ms: number = Date.now()): string {
	return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}+00:00`;
}
