// Dates and times as Google Calendar's inputs check them (backend/connectors/google_calendar/connector.py
// `_date_time`, `_date_or_date_time`): a pattern first, then Python's `date.fromisoformat` and
// `datetime.fromisoformat` (lib/isoformat.ts: CPython's C implementation), whose error messages reach the
// model as "Value error, ...". Both patterns use Python's `\d`, which matches any Unicode decimal digit
// (Unicode 16, as lib/digits.ts pins it); the parsers then refuse non-ASCII digits as an invalid isoformat
// string.
//
// What CPython checks, in order: the string's format (date, time, offset); the offset, strictly within
// ±24 h; an hour of 24, which with a valid month and a day not past its end needs zero minutes, seconds
// and microseconds and then means midnight of the next day; then the date's fields and the time's.

import { DIGIT_CLASS } from "../../lib/digits.ts";
import { dateFromIsoFormat, datetimeFromIsoFormat } from "../../lib/isoformat.ts";
import { ValueError } from "../../lib/pyerrors.ts";

// Python's `\d` is pinned to Unicode 16 (src/lib/digits.ts), not the runtime's `\p{Nd}`.
const D = DIGIT_CLASS;
export const DATE = new RegExp(`^${D}{4}-${D}{2}-${D}{2}$`, "u");
export const DATE_TIME = new RegExp(`^${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}(:${D}{2}(\\.${D}{1,6})?)?(Z|[+-]${D}{2}:${D}{2})$`, "u");

export const DATE_TIME_MESSAGE = "must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00";

/** `_date_time`: the pattern, then `datetime.fromisoformat`. */
export function checkDateTime(value: string): string {
	if (!DATE_TIME.test(value)) throw new ValueError(DATE_TIME_MESSAGE);
	datetimeFromIsoFormat(value);
	return value;
}

/** `_date_or_date_time`: a date, or else a date-time. */
export function checkDateOrDateTime(value: string): string {
	if (DATE.test(value)) {
		dateFromIsoFormat(value);
		return value;
	}
	return checkDateTime(value);
}

/** `datetime.now(UTC).isoformat(timespec="seconds")`. */
export function nowIso(ms: number = Date.now()): string {
	return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}+00:00`;
}
