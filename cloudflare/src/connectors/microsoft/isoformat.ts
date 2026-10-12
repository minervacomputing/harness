// Python's `datetime.fromisoformat` and `date.fromisoformat` as CPython 3.14's C implementation reads them
// (Modules/_datetimemodule.c), with its error messages, and the arithmetic the Microsoft connectors do with
// the result: conversion to UTC, `strftime("%Y-%m-%dT%H:%M:%SZ")`, `isoformat()` and timedeltas. The C
// parser works on the UTF-8 bytes of the text: the date and time are ASCII, and only the one character
// between them may be anything. Instants are counted in BigInt microseconds, as Python's integers do.
//
// Errors are Python's (lib/pyerrors.ts): `ValueError`, which Pydantic reports as "Value error, ...", and
// `OverflowError`, which it does not catch, so the call fails generically.

import { utf8 } from "../../lib/bytes.ts";
import { OverflowError, ValueError } from "../../lib/pyerrors.ts";
import { pythonRepr } from "../../lib/text.ts";
import { daysBeforeYear, isLeap, pad } from "../../lib/calendar.ts";

export interface PyDate {
	year: number;
	month: number;
	day: number;
}

export interface PyDateTime extends PyDate {
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
	/** The UTC offset in microseconds, or null for a naive datetime. */
	offset: number | null;
}

const MINYEAR = 1;
const MAXYEAR = 9999;
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export const MICROS_PER_DAY = 86_400_000_000n;
const DI400Y = 146097;
const DI100Y = 36524;
const DI4Y = 1461;

/** `days_in_month`, with C's table for a month of 0. */
function daysInMonth(year: number, month: number): number {
	return month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month] ?? 0);
}

/** `ymd_to_ord`: 0001-01-01 is day 1. */
export function ordinal(year: number, month: number, day: number): number {
	return daysBeforeYear(year) + (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && isLeap(year) ? 1 : 0) + day;
}

/** `ord_to_ymd`. */
export function fromOrdinal(n: number): PyDate {
	let rest = n - 1;
	const n400 = Math.floor(rest / DI400Y);
	rest -= n400 * DI400Y;
	let year = n400 * 400 + 1;
	const n100 = Math.floor(rest / DI100Y);
	rest -= n100 * DI100Y;
	const n4 = Math.floor(rest / DI4Y);
	rest -= n4 * DI4Y;
	const n1 = Math.floor(rest / 365);
	rest -= n1 * 365;
	year += n100 * 100 + n4 * 4 + n1;
	if (n1 === 4 || n100 === 4) return { year: year - 1, month: 12, day: 31 };
	const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
	let month = (rest + 50) >> 5;
	let preceding = (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && leap ? 1 : 0);
	if (preceding > rest) {
		month -= 1;
		preceding -= (DAYS_IN_MONTH[month] as number) + (month === 2 && leap ? 1 : 0);
	}
	return { year, month, day: rest - preceding + 1 };
}

function isoWeek1Monday(year: number): number {
	const first = ordinal(year, 1, 1);
	const weekday = (first + 6) % 7;
	let monday = first - weekday;
	if (weekday > 3) monday += 7;
	return monday;
}

/** `iso_to_ymd`: null when the week or day is out of range. */
function isoToYmd(year: number, week: number, day: number): PyDate | null {
	if (year < MINYEAR || year > MAXYEAR) return null;
	if (week <= 0 || week >= 53) {
		let outOfRange = true;
		if (week === 53) {
			const firstWeekday = ordinal(year, 1, 1) % 7;
			if (firstWeekday === 4 || (firstWeekday === 3 && isLeap(year))) outOfRange = false;
		}
		if (outOfRange) return null;
	}
	if (day <= 0 || day >= 8) return null;
	return fromOrdinal(isoWeek1Monday(year) + (week - 1) * 7 + day - 1);
}

// The C parser's view of the text: its UTF-8 bytes, NUL-terminated, so a read past the end is a 0.

class Bytes {
	readonly data: Uint8Array;

	constructor(data: Uint8Array) {
		this.data = data;
	}

	at(index: number): number {
		return this.data[index] ?? 0;
	}

	get length(): number {
		return this.data.length;
	}
}

function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39;
}

/** `parse_digits`: `count` ASCII digits from `at` (reading past the end as C does), or null. */
function digits(text: Bytes, at: number, count: number): [value: number, next: number] | null {
	let value = 0;
	for (let i = 0; i < count; i++) {
		const byte = text.at(at + i);
		if (!isDigit(byte)) return null;
		value = value * 10 + (byte - 0x30);
	}
	return [value, at + count];
}

/** `_find_isoformat_datetime_separator`. */
function separatorOf(text: Bytes): number {
	const len = text.length;
	if (len === 7) return 7;
	if (text.at(4) === 0x2d) {
		if (text.at(5) === 0x57) {
			if (len < 8) return -1;
			if (len > 8 && text.at(8) === 0x2d) {
				if (len === 9) return -1;
				if (len > 10 && isDigit(text.at(10))) return 8;
				return 10;
			}
			return 8;
		}
		return 10;
	}
	if (text.at(4) === 0x57) {
		let index = 7;
		while (index < len && isDigit(text.at(index))) index++;
		if (index < 9) return index;
		return index % 2 === 0 ? 7 : 8;
	}
	return 8;
}

/** `parse_isoformat_date` of the first `len` bytes (a negative `len` is C's size_t, larger than any text). */
function parseDate(text: Bytes, len: number): PyDate | null {
	const year = digits(text, 0, 4);
	if (year === null) return null;
	let p = year[1];
	const separated = text.at(p) === 0x2d;
	if (separated) p++;
	if (text.at(p) === 0x57) {
		p++;
		const week = digits(text, p, 2);
		if (week === null) return null;
		p = week[1];
		let weekday = 1;
		if (len < 0 || p < len) {
			if (separated && text.at(p++) !== 0x2d) return null;
			const day = digits(text, p, 1);
			if (day === null) return null;
			weekday = day[0];
		}
		return isoToYmd(year[0], week[0], weekday);
	}
	const month = digits(text, p, 2);
	if (month === null) return null;
	p = month[1];
	if (separated && text.at(p++) !== 0x2d) return null;
	const day = digits(text, p, 2);
	if (day === null) return null;
	return { year: year[0], month: month[0], day: day[0] };
}

interface Clock {
	hour: number;
	minute: number;
	second: number;
	microsecond: number;
}

const CORRECTION = [100000, 10000, 1000, 100, 10];

/**
 * `parse_hh_mm_ss_ff` of the bytes from `start` to `end`: 0 when the text ends there, 1 when more follows,
 * and below 0 for an error. Its digits may be read past `end`, as C reads them.
 */
function parseClock(text: Bytes, start: number, end: number): [number, Clock] {
	const clock: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
	const fields = ["hour", "minute", "second"] as const;
	let p = start;
	let separated = true;
	for (let i = 0; i < 3; i++) {
		const read = digits(text, p, 2);
		if (read === null) return [-3, clock];
		clock[fields[i] as "hour"] = read[0];
		p = read[1];
		const c = text.at(p++);
		if (i === 0) separated = c === 0x3a;
		if (c === 0x2e || c === 0x2c) {
			// A decimal mark on the hour or minute, or one not followed by any digit.
			if (i < 2 || p >= end) return [-3, clock];
			break;
		}
		if (p >= end) return [c !== 0 ? 1 : 0, clock];
		if (separated && c === 0x3a) {
			if (i === 2) return [-4, clock];
			continue;
		}
		if (!separated) p--;
		else return [-4, clock];
	}
	const remains = end - p;
	const count = remains >= 6 ? 6 : remains;
	const micro = digits(text, p, count);
	if (micro === null) return [-3, clock];
	// C's `correction[to_parse - 1]`; nothing reaches here with no digits to parse.
	clock.microsecond = count < 6 ? micro[0] * (CORRECTION[count - 1] as number) : micro[0];
	p = micro[1];
	while (isDigit(text.at(p))) p++;
	return [text.at(p) !== 0 ? 1 : 0, clock];
}

/**
 * `parse_isoformat_time` of the bytes from `start`: the clock and, when the text names one, the offset's
 * seconds and microseconds (signed alike), or null for an invalid string.
 */
function parseTime(text: Bytes, start: number): [Clock, [seconds: number, micros: number] | null] | null {
	const end = text.length;
	let zone = start;
	do {
		const byte = text.at(zone);
		if (byte === 0x5a || byte === 0x2b || byte === 0x2d) break;
	} while (++zone < end);
	const [code, clock] = parseClock(text, start, zone);
	if (code < 0) return null;
	if (zone === end) return code === 1 ? null : [clock, null];
	if (text.at(zone) === 0x5a) return text.at(zone + 1) !== 0 ? null : [clock, [0, 0]];
	const sign = text.at(zone) === 0x2d ? -1 : 1;
	const [tzCode, tz] = parseClock(text, zone + 1, end);
	if (tzCode !== 0) return null;
	// `+ 0` keeps a zero offset written with a minus sign (-00:00) from becoming -0.
	return [clock, [sign * (tz.hour * 3600 + tz.minute * 60 + tz.second) + 0, sign * tz.microsecond + 0]];
}

function invalid(text: string): ValueError {
	return new ValueError(`Invalid isoformat string: ${pythonRepr(text)}`);
}

/** `check_date_args`. */
function checkDate(year: number, month: number, day: number): void {
	if (year < MINYEAR || year > MAXYEAR) throw new ValueError(`year must be in ${MINYEAR}..${MAXYEAR}, not ${year}`);
	if (month < 1 || month > 12) throw new ValueError(`month must be in 1..12, not ${month}`);
	const dim = daysInMonth(year, month);
	if (day < 1 || day > dim) throw new ValueError(`day ${day} must be in range 1..${dim} for month ${month} in year ${year}`);
}

/** `check_time_args`. */
function checkTime(clock: Clock): void {
	if (clock.hour < 0 || clock.hour > 23) throw new ValueError(`hour must be in 0..23, not ${clock.hour}`);
	if (clock.minute < 0 || clock.minute > 59) throw new ValueError(`minute must be in 0..59, not ${clock.minute}`);
	if (clock.second < 0 || clock.second > 59) throw new ValueError(`second must be in 0..59, not ${clock.second}`);
	if (clock.microsecond < 0 || clock.microsecond > 999999) throw new ValueError(`microsecond must be in 0..999999, not ${clock.microsecond}`);
}

const DAY_MICROS = 86_400_000_000;

/** `new_timezone`: an offset strictly between -24 h and 24 h. */
function checkOffset(offset: number): void {
	if (Math.abs(offset) >= DAY_MICROS) {
		throw new ValueError(`offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(BigInt(offset))}`);
	}
}

/** `repr(timedelta)`. */
export function timedeltaRepr(micros: bigint): string {
	let days = micros / MICROS_PER_DAY;
	let rest = micros % MICROS_PER_DAY;
	if (rest < 0n) {
		rest += MICROS_PER_DAY;
		days -= 1n;
	}
	const seconds = rest / 1_000_000n;
	const microseconds = rest % 1_000_000n;
	const parts: string[] = [];
	if (days !== 0n) parts.push(`days=${days}`);
	if (seconds !== 0n) parts.push(`seconds=${seconds}`);
	if (microseconds !== 0n) parts.push(`microseconds=${microseconds}`);
	return `datetime.timedelta(${parts.length ? parts.join(", ") : "0"})`;
}

function isSurrogate(unit: string): boolean {
	const code = unit.charCodeAt(0);
	return unit.length === 1 && code >= 0xd800 && code <= 0xdfff;
}

/**
 * `_sanitize_isoformat_str`: the text with a lone surrogate at code point 7, 8 or 10 (where the separator
 * may be), the first of them, replaced with "T"; null for a text shorter than 7 code points.
 */
function sanitized(text: string): string | null {
	const points = Array.from(text);
	if (points.length < 7) return null;
	for (const position of [7, 8, 10]) {
		if (position > points.length) break;
		if (position < points.length && isSurrogate(points[position] as string)) {
			points[position] = "T";
			return points.join("");
		}
	}
	return text;
}

/** The text's UTF-8 bytes, or null where Python could not encode it (a lone surrogate). */
function encoded(text: string): Uint8Array | null {
	return text.isWellFormed() ? utf8(text) : null;
}

/** `datetime.fromisoformat(text)`. */
export function datetimeFromIsoFormat(text: string): PyDateTime {
	const clean = sanitized(text);
	if (clean === null) throw invalid(text);
	const data = encoded(clean);
	if (data === null) throw invalid(text);
	const bytes = new Bytes(data);
	const separator = separatorOf(bytes);
	const date = parseDate(bytes, separator);
	if (date === null) throw invalid(text);
	let clock: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
	let zone: [number, number] | null = null;
	if (bytes.length > separator) {
		// The separator may be any one character: its first byte says how long it is.
		const lead = bytes.at(separator);
		const width = (lead & 0x80) === 0 ? 1 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf0) === 0xf0 ? 4 : 2;
		const time = parseTime(bytes, separator + width);
		if (time === null) throw invalid(text);
		[clock, zone] = time;
	}
	// `tzinfo_from_isoformat_results`: no seconds and no microseconds is UTC.
	let offset: number | null = null;
	if (zone !== null) {
		offset = zone[0] * 1_000_000 + zone[1];
		checkOffset(offset);
	}
	let { year, month, day } = date;
	if (clock.hour === 24 && month >= 1 && month <= 12) {
		const dim = daysInMonth(year, month);
		if (day <= dim) {
			if (clock.minute !== 0 || clock.second !== 0 || clock.microsecond !== 0) {
				throw new ValueError("minute, second, and microsecond must be 0 when hour is 24");
			}
			clock = { ...clock, hour: 0 };
			day += 1;
			if (day > dim) {
				day = 1;
				month += 1;
				if (month > 12) {
					month = 1;
					year += 1;
				}
			}
		}
	}
	checkDate(year, month, day);
	checkTime(clock);
	return { year, month, day, ...clock, offset };
}

/** `date.fromisoformat(text)`. */
export function dateFromIsoFormat(text: string): PyDate {
	const data = encoded(text);
	if (data === null) throw invalid(text);
	const bytes = new Bytes(data);
	const date = bytes.length === 7 || bytes.length === 8 || bytes.length === 10 ? parseDate(bytes, bytes.length) : null;
	if (date === null) throw invalid(text);
	checkDate(date.year, date.month, date.day);
	return date;
}

/** Microseconds from 0001-01-01 of the wall clock, without the offset. */
function wallMicros(value: PyDateTime): bigint {
	const days = BigInt(ordinal(value.year, value.month, value.day));
	const time = BigInt(((value.hour * 60 + value.minute) * 60 + value.second) * 1_000_000 + value.microsecond);
	return days * MICROS_PER_DAY + time;
}

/** The instant of an aware datetime, in microseconds (its UTC wall clock). */
export function instant(value: PyDateTime): bigint {
	if (value.offset === null) throw new TypeError("A naive datetime has no instant.");
	return wallMicros(value) - BigInt(value.offset);
}

/** A datetime at `micros` of wall clock with `offset`, or OverflowError outside years 1 to 9999. */
function atWall(micros: bigint, offset: number | null): PyDateTime {
	let days = micros / MICROS_PER_DAY;
	let rest = micros % MICROS_PER_DAY;
	if (rest < 0n) {
		rest += MICROS_PER_DAY;
		days -= 1n;
	}
	if (days < 1n || days > BigInt(ordinal(MAXYEAR, 12, 31))) throw new OverflowError("date value out of range");
	const date = fromOrdinal(Number(days));
	const time = Number(rest);
	const microsecond = time % 1_000_000;
	const seconds = (time - microsecond) / 1_000_000;
	return { ...date, hour: Math.floor(seconds / 3600), minute: Math.floor(seconds / 60) % 60, second: seconds % 60, microsecond, offset };
}

/** `value.astimezone(UTC)` of an aware datetime. */
export function toUtc(value: PyDateTime): PyDateTime {
	return atWall(instant(value), 0);
}

/** `value + timedelta(microseconds=delta)`: the wall clock moves, the offset stays. */
export function plus(value: PyDateTime, delta: bigint): PyDateTime {
	return atWall(wallMicros(value) + delta, value.offset);
}

/** `value.replace(tzinfo=UTC)`. */
export function asUtc(value: PyDateTime): PyDateTime {
	return { ...value, offset: 0 };
}

/** `strftime("%Y-%m-%dT%H:%M:%SZ")`. */
export function utcStamp(value: PyDateTime): string {
	return `${pad(value.year, 4)}-${pad(value.month, 2)}-${pad(value.day, 2)}T${pad(value.hour, 2)}:${pad(value.minute, 2)}:${pad(value.second, 2)}Z`;
}

function offsetText(offset: number): string {
	const sign = offset < 0 ? "-" : "+";
	let rest = Math.abs(offset);
	const micro = rest % 1_000_000;
	rest = (rest - micro) / 1_000_000;
	const hours = Math.floor(rest / 3600);
	const minutes = Math.floor(rest / 60) % 60;
	const seconds = rest % 60;
	let text = `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`;
	if (seconds || micro) text += `:${pad(seconds, 2)}`;
	if (micro) text += `.${pad(micro, 6)}`;
	return text;
}

/** `isoformat(timespec=...)`: "auto" shows microseconds only when there are some. */
export function isoformat(value: PyDateTime, timespec: "auto" | "seconds" | "microseconds" = "auto"): string {
	let text = `${pad(value.year, 4)}-${pad(value.month, 2)}-${pad(value.day, 2)}T${pad(value.hour, 2)}:${pad(value.minute, 2)}:${pad(value.second, 2)}`;
	if (timespec === "microseconds" || (timespec === "auto" && value.microsecond)) text += `.${pad(value.microsecond, 6)}`;
	if (value.offset !== null) text += offsetText(value.offset);
	return text;
}

/** `datetime.now(UTC)`. */
export function nowUtc(epochMs: number = Date.now()): PyDateTime {
	const epochDay = BigInt(ordinal(1970, 1, 1));
	return atWall(epochDay * MICROS_PER_DAY + BigInt(epochMs) * 1000n, 0);
}

export function dateOrdinal(value: PyDate): number {
	return ordinal(value.year, value.month, value.day);
}
