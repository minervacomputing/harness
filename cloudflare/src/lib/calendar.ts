// The proleptic Gregorian arithmetic of Python's `datetime`, which the connectors' `fromisoformat` ports
// (xero/dates.ts, linear/python.ts, intercom/dates.ts, slack/times.ts, microsoft/isoformat.ts,
// google_calendar/times.ts) and their formatters share.

/** `calendar.isleap(year)`. */
export function isLeap(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** `days_before_year`: the days from 0001-01-01 to January 1st of `year`. */
export function daysBeforeYear(year: number): number {
	const y = year - 1;
	return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

/** `String(value)` padded with zeros to at least `width` digits, as `%02d` and `%04d` write. */
export function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}
