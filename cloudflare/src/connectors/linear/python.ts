// Python's string semantics that Linear's rules depend on, where JavaScript's differ: `str()` of a JSON
// value, `date.fromisoformat()`, and the pieces of `re`'s Unicode patterns (`\w`, `\d` and IGNORECASE) that the
// sanitizer's expressions are written with (markdown.ts; `\s` is PYTHON_SPACE_CLASS of lib/text.ts).
//
// Category data come from the runtime's Unicode tables, as Python's come from its own (Python 3.14 has
// Unicode 16). (`str.casefold()` is lib/casefold.ts; test/fixtures/connectors/linear/casefold.json pins it
// against Python.)

import { pythonFloat } from "../../lib/json.ts";
import type { Json } from "../../lib/json.ts";
import { pythonRepr } from "../../lib/text.ts";
import { isLeap } from "../../lib/calendar.ts";

// str()

function reprOf(value: Json): string {
	if (typeof value === "string") return pythonRepr(value);
	return strOf(value);
}

/** Python's `str(value)` of a value `json.loads` returned: "None", "True", reprs inside lists and dicts. */
export function strOf(value: Json): string {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return value;
	// A number too large for a double (1e400) parses as Infinity, which Python's float shows as "inf".
	if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
	if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 2 ** 53 ? String(value) : pythonFloat(value);
	if (Array.isArray(value)) return `[${value.map(reprOf).join(", ")}]`;
	return `{${Object.entries(value)
		.map(([key, item]) => `${pythonRepr(key)}: ${reprOf(item)}`)
		.join(", ")}}`;
}

// date.fromisoformat

/** Days since 0000-03-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil, shifted). */
function daysFromCivil(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe;
}

function civilFromDays(days: number): [year: number, month: number, day: number] {
	const era = Math.floor(days / 146097);
	const doe = days - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** datetime's ordinal: 0001-01-01 is day 1. */
function ordinal(year: number, month: number, day: number): number {
	return daysFromCivil(year, month, day) - daysFromCivil(1, 1, 1) + 1;
}

function daysIn(year: number, month: number): number {
	return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/** `parse_digits`: `count` ASCII digits at `at`, or null. */
function digits(bytes: Uint8Array, at: number, count: number): number | null {
	let value = 0;
	for (let i = 0; i < count; i++) {
		const byte = bytes[at + i];
		if (byte === undefined || byte < 0x30 || byte > 0x39) return null;
		value = value * 10 + (byte - 0x30);
	}
	return value;
}

/** `iso_to_ymd`: an ISO week date as a calendar date, or null. */
function isoToYmd(isoYear: number, week: number, weekday: number): [number, number, number] | null {
	if (isoYear < 1 || isoYear > 9999) return null;
	if (week <= 0 || week >= 53) {
		const firstWeekday = (ordinal(isoYear, 1, 1) + 6) % 7;
		if (!(week === 53 && (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))))) return null;
	}
	if (weekday <= 0 || weekday >= 8) return null;
	const first = ordinal(isoYear, 1, 1);
	const firstWeekday = (first + 6) % 7;
	let monday = first - firstWeekday;
	if (firstWeekday > 3) monday += 7;
	return civilFromDays(monday + (week - 1) * 7 + weekday - 1 + daysFromCivil(1, 1, 1) - 1);
}

/**
 * Python's `date.fromisoformat(value).isoformat()` (CPython's C implementation, 3.11 and later), or null
 * where it raises: YYYY-MM-DD, YYYYMMDD and the ISO week forms YYYY-Www[-D] and YYYYWww[D], read from the
 * UTF-8 bytes of a value of 7, 8 or 10 bytes, with ASCII digits only. As CPython does, it does not check
 * that every byte was read, so "20261001xx" is 2026-10-01.
 */
export function isoDate(value: string): string | null {
	if (!value.isWellFormed()) return null;
	const bytes = new TextEncoder().encode(value);
	if (bytes.length !== 7 && bytes.length !== 8 && bytes.length !== 10) return null;
	const year = digits(bytes, 0, 4);
	if (year === null) return null;
	let at = 4;
	const dashed = bytes[at] === 0x2d;
	if (dashed) at++;
	let ymd: [number, number, number] | null;
	if (bytes[at] === 0x57) {
		at++;
		const week = digits(bytes, at, 2);
		if (week === null) return null;
		at += 2;
		let weekday = 1;
		if (at < bytes.length) {
			if (dashed && bytes[at++] !== 0x2d) return null;
			const day = digits(bytes, at, 1);
			if (day === null) return null;
			weekday = day;
		}
		ymd = isoToYmd(year, week, weekday);
	} else {
		const month = digits(bytes, at, 2);
		if (month === null) return null;
		at += 2;
		if (dashed && bytes[at++] !== 0x2d) return null;
		const day = digits(bytes, at, 2);
		if (day === null) return null;
		ymd = [year, month, day];
	}
	if (ymd === null) return null;
	const [y, m, d] = ymd;
	if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// re

/**
 * `i` under IGNORECASE, for patterns compiled with JavaScript's `iu` flags. `re` matches U+0130 (whose
 * lowercase is `i`) and U+0131 (one of its fixed equivalences) to `i`; JavaScript's simple case folding
 * matches neither. The other two non-ASCII letters `re` matches to ASCII ones, U+017F to `s` and U+212A
 * to `k`, fold to them in JavaScript too.
 */
export const RE_I = "[i\\u0130\\u0131]";
/** What IGNORECASE adds to an ASCII letter class beyond JavaScript's `iu` folding: U+0130 and U+0131. */
export const RE_LETTERS_EXTRA = "\\u0130\\u0131";
