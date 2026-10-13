// Dates and times in tool inputs, provider answers and the API.
//
// Inputs are RFC 3339: a date (2026-10-01), or a date-time (2026-10-01T09:00, seconds and a fraction of up
// to six digits optional) with `Z` or a numeric offset, or without one. The fields are checked against the calendar, so
// February 30th or an hour of 24 is refused rather than rolled over. A date-time without an offset is read
// as UTC, never in the runtime's zone; callers that need a zone ask for an offset. Instants are counted in
// microseconds (BigInt) because Slack's message times carry microseconds, which a Date would drop.

/** A day of the calendar. */
export interface CalendarDate {
	year: number;
	month: number;
	day: number;
}

/** A date-time as written: its wall clock, and its offset in minutes, or null when it gave none. */
export interface DateTime extends CalendarDate {
	hour: number;
	minute: number;
	second: number;
	/** Microseconds past the second. */
	micro: number;
	offset: number | null;
}

export const DATE_MESSAGE = "must be a date such as 2026-10-01";

export const DAY_MICROS = 86_400_000_000n;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|([+-])(\d{2}):(\d{2}))?$/;
/** The Gregorian calendar repeats every 400 years, which are 146,097 days. */
const CYCLE_MS = 146_097 * 86_400_000;

function daysInMonth(year: number, month: number): number {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDate(year: number, month: number, day: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** YYYY-MM-DD naming a real day, or null. */
export function parseDate(text: string): CalendarDate | null {
	const match = DATE.exec(text);
	if (match === null) return null;
	const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
	return validDate(year, month, day) ? { year, month, day } : null;
}

export function isDate(text: string): boolean {
	return parseDate(text) !== null;
}

/** A date-time naming a real moment (hours 0 to 23, no leap seconds, offsets within ±23:59), or null. */
export function parseDateTime(text: string): DateTime | null {
	const match = DATE_TIME.exec(text);
	if (match === null) return null;
	const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
	const second = Number(match[6] ?? 0);
	const micro = Number((match[7] ?? "").padEnd(6, "0"));
	let offset: number | null = null;
	if (match[8] === "Z") offset = 0;
	else if (match[8] !== undefined) {
		const [hours, minutes] = [Number(match[10]), Number(match[11])];
		if (hours > 23 || minutes > 59) return null;
		offset = match[9] === "-" ? 0 - (hours * 60 + minutes) : hours * 60 + minutes;
	}
	if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
	return { year, month, day, hour, minute, second, micro, offset };
}

/** A date-time with `Z` or a numeric offset, or null. */
export function parseZonedDateTime(text: string): DateTime | null {
	const parsed = parseDateTime(text);
	return parsed !== null && parsed.offset !== null ? parsed : null;
}

/** Microseconds since 1970-01-01T00:00:00Z; a date is its midnight in UTC, and so is a time without an offset. */
export function epochMicros(value: CalendarDate | DateTime): bigint {
	const time = "hour" in value ? value : { hour: 0, minute: 0, second: 0, micro: 0, offset: 0 };
	// Date.UTC reads years 0 to 99 as 1900 to 1999, so count from 400 years later.
	const ms = Date.UTC(value.year + 400, value.month - 1, value.day, time.hour, time.minute, time.second) - CYCLE_MS;
	return BigInt(ms) * 1000n + BigInt(time.micro) - BigInt(time.offset ?? 0) * 60_000_000n;
}

/** 0000-01-01T00:00:00Z and 10000-01-01T00:00:00Z: instants in between are written with a four-digit year. */
const FIRST_INSTANT = epochMicros({ year: 0, month: 1, day: 1 });
const END_INSTANT = epochMicros({ year: 10_000, month: 1, day: 1 });

/**
 * The instant a date or a date-time names (see `epochMicros`), or null; also null when its offset takes it
 * out of the years 0000 to 9999 in UTC, which ISO 8601 would write with more digits.
 */
export function parseInstant(text: string): bigint | null {
	const value = parseDate(text) ?? parseDateTime(text);
	if (value === null) return null;
	const micros = epochMicros(value);
	return micros >= FIRST_INSTANT && micros < END_INSTANT ? micros : null;
}

/** An instant in UTC, `2026-10-01T09:00:00Z`, with six digits of fraction when it has any. */
export function formatUtc(micros: bigint): string {
	const ms = micros / 1000n - (micros % 1000n < 0n ? 1n : 0n);
	const fraction = Number(((micros % 1_000_000n) + 1_000_000n) % 1_000_000n);
	const iso = new Date(Number(ms)).toISOString();
	return `${iso.slice(0, iso.length - 5)}${fraction ? `.${String(fraction).padStart(6, "0")}` : ""}Z`;
}

/** Epoch milliseconds as the API writes times: ISO 8601 in UTC with milliseconds and `Z`. */
export function isoTime(ms: number): string {
	return new Date(ms).toISOString();
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `Monday, 2026-10-10 14:03`, how the run's instructions give its start in UTC. */
export function runStartLabel(ms: number): string {
	const iso = new Date(ms).toISOString();
	return `${DAYS[new Date(ms).getUTCDay()]}, ${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Whether the runtime's tz database knows an IANA time zone name, aliases such as US/Pacific included. Intl
 * ignores case, so us/pacific passes too. Offsets such as +01:00, which Intl also takes as zones, are not
 * names.
 */
export function isTimeZone(text: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(text)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: text });
		return true;
	} catch (error) {
		if (error instanceof RangeError) return false;
		throw error;
	}
}
