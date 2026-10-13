// Python's datetime as Intercom's operations use it: `datetime.fromisoformat` for `updated_after`, the POSIX
// timestamp it searches with, and `datetime.fromtimestamp(t, UTC).isoformat()` for the times records show.
//
// `fromisoformat` is lib/isoformat.ts, CPython's C implementation (3.14), which is what runs today.
// test/fixtures/connectors/intercom/vectors.json compares it with Python on hand-written and random strings.

import { type PyDateTime, datetimeFromIsoFormat, pad, unixMicros } from "../../lib/isoformat.ts";
import { TextError } from "../../lib/text.ts";

/** What the times records show: 9999-12-31T23:59:59 is the last. */
const MAX_TIMESTAMP = 253_402_300_799;

export type IsoMoment = PyDateTime;

/**
 * `datetime.fromisoformat(value)`, or null where it refuses the value. A string with a lone surrogate is
 * refused outright: Python takes one standing for the separator, but values reach here as JSON text, and
 * the port has always refused them.
 */
export function fromIsoFormat(value: string): IsoMoment | null {
	if (!value.isWellFormed()) return null;
	try {
		return datetimeFromIsoFormat(value);
	} catch (error) {
		if (error instanceof TextError) return null;
		throw error;
	}
}

/** `int(moment.timestamp())`, a time without a zone taken as UTC. */
export function timestamp(moment: IsoMoment): number {
	// timedelta.total_seconds() divides microseconds by 10**6 as floats; int() truncates. The microseconds
	// stay exact up to 2**53, the year 2255, and `updated_after` is held to the years 2000 to 2100.
	return Math.trunc(Number(unixMicros(moment)) / 1_000_000);
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
