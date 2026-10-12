import { isLeap } from "../../lib/calendar.ts";
// The dates calls take, read as backend/connectors/xero/reads.py reads them: `_day` checks a value with
// Python 3.14's `date.fromisoformat` and keeps it as it was sent. That parser takes more than YYYY-MM-DD in
// ten characters: an ISO week date (2026-W40-4), and, since it stops once it has a date, the basic form
// followed by anything (20261001xx). What it reads is what the filter and the draft use, as today.

export const NOT_A_DATE = "must be a date such as 2026-10-01";
export const OUT_OF_RANGE = "must be a date such as 2026-10-01, between the years 1900 and 2200";

/** Days since 1970-01-01 of a proleptic Gregorian date. */
function daysFromCivil(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** Monday 0 to Sunday 6. */
function weekday(year: number, month: number, day: number): number {
	return (((daysFromCivil(year, month, day) + 3) % 7) + 7) % 7;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function valid(year: number, month: number, day: number): boolean {
	if (year < 1 || year > 9999 || month < 1 || month > 12) return false;
	const most = month === 2 && isLeap(year) ? 29 : (MONTH_DAYS[month - 1] as number);
	return day >= 1 && day <= most;
}

/** CPython's `iso_to_ymd`. */
function isoToYmd(isoYear: number, week: number, isoDay: number): [number, number, number] | null {
	if (isoYear < 1 || isoYear > 9999) return null;
	if (week <= 0 || week >= 53) {
		const first = weekday(isoYear, 1, 1);
		if (!(week === 53 && (first === 3 || (first === 2 && isLeap(isoYear))))) return null;
	}
	if (isoDay <= 0 || isoDay >= 8) return null;
	const january = daysFromCivil(isoYear, 1, 1);
	const first = weekday(isoYear, 1, 1);
	const monday = january - first + (first > 3 ? 7 : 0);
	return civilFromDays(monday + (week - 1) * 7 + isoDay - 1);
}

/**
 * Python 3.14's `date.fromisoformat(value)` (CPython's `parse_isoformat_date`): [year, month, day], or null
 * where it raises ValueError. It reads the UTF-8 bytes, takes only 7, 8 or 10 of them, and digits only in
 * ASCII.
 */
export function fromIsoFormat(value: string): [number, number, number] | null {
	if (!/^[\u0000-\u007f]*$/.test(value) || ![7, 8, 10].includes(value.length)) return null;
	let at = 0;
	// The bytes end in NUL, which no step accepts.
	const char = (): string => value[at] ?? "\u0000";
	const digits = (count: number): number | null => {
		let out = 0;
		for (let i = 0; i < count; i++) {
			const found = char();
			if (found < "0" || found > "9") return null;
			out = out * 10 + Number(found);
			at++;
		}
		return out;
	};
	const year = digits(4);
	if (year === null) return null;
	const separated = char() === "-";
	if (separated) at++;
	if (char() === "W") {
		at++;
		const week = digits(2);
		if (week === null) return null;
		let isoDay = 1;
		if (at < value.length) {
			if (separated && value[at++] !== "-") return null;
			const found = digits(1);
			if (found === null) return null;
			isoDay = found;
		}
		const ymd = isoToYmd(year, week, isoDay);
		return ymd !== null && valid(...ymd) ? ymd : null;
	}
	const month = digits(2);
	if (month === null) return null;
	if (separated && value[at++] !== "-") return null;
	const day = digits(2);
	if (day === null) return null;
	return valid(year, month, day) ? [year, month, day] : null;
}

/** reads.py `_day`: why a date is refused, or null for one it keeps. */
export function dayProblem(value: string): string | null {
	const found = fromIsoFormat(value);
	if (found === null) return NOT_A_DATE;
	if ([...value].length !== 10 || found[0] < 1900 || found[0] > 2200) return OUT_OF_RANGE;
	return null;
}
