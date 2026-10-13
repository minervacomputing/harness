// The dates calls take: `_day` checks a value with
// Python 3.14's `date.fromisoformat` (lib/isoformat.ts) and keeps it as it was sent. That parser takes more
// than YYYY-MM-DD in ten characters: an ISO week date (2026-W40-4), and, since it stops once it has a date,
// the basic form followed by anything (20261001xx). What it reads is what the filter and the draft use.

import { dateFromIsoFormat } from "../../lib/isoformat.ts";
import { TextError } from "../../lib/text.ts";

export const NOT_A_DATE = "must be a date such as 2026-10-01";
export const OUT_OF_RANGE = "must be a date such as 2026-10-01, between the years 1900 and 2200";

/**
 * `date.fromisoformat(value)`: [year, month, day], or null where it refuses the value. Text with any
 * character beyond ASCII is refused outright. Python would read "00010114é" (ten bytes) as a date, and
 * word the refusal of its length differently; the port has always refused it as not a date.
 */
export function fromIsoFormat(value: string): [number, number, number] | null {
	if (!/^[\u0000-\u007f]*$/.test(value)) return null;
	try {
		const { year, month, day } = dateFromIsoFormat(value);
		return [year, month, day];
	} catch (error) {
		if (error instanceof TextError) return null;
		throw error;
	}
}

/** reads.py `_day`: why a date is refused, or null for one it keeps. */
export function dayProblem(value: string): string | null {
	const found = fromIsoFormat(value);
	if (found === null) return NOT_A_DATE;
	if ([...value].length !== 10 || found[0] < 1900 || found[0] > 2200) return OUT_OF_RANGE;
	return null;
}
