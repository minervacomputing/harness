// Dates and times as the connectors read them: what a time without an offset means (docs/plans/cloudflare.md,
// "Dates and time zones"), the grammar of `datetime.fromisoformat` with Python's words for what it refuses,
// and Slack's timestamps, whose microseconds never go through `Date`. For test/unit/dates.test.ts (Node) and
// test/platform/dates.test.ts (workerd, which production runs in). The expected values were computed with
// Python 3.14.8.

import { describe, expect, test } from "vitest";
import { NOT_ISO, sinceProblem, sinceTimestamp } from "../../src/connectors/intercom/reads.ts";
import { DATE_TIME_MESSAGE, checkDateTime as googleCheckDateTime } from "../../src/connectors/google_calendar/times.ts";
import { moment as outlookMoment } from "../../src/connectors/outlook/reads.ts";
import { checkDateTime as outlookCalendarCheckDateTime, eventPayload } from "../../src/connectors/outlook_calendar/connector.ts";
import { MOMENT_MESSAGE, isoTime, moment as slackMoment } from "../../src/connectors/slack/connector.ts";
import { isoInstant } from "../../src/connectors/slack/times.ts";
import { NOT_A_DATE, OUT_OF_RANGE, dayProblem } from "../../src/connectors/xero/dates.ts";
import { dateFromIsoFormat, datetimeFromIsoFormat, isoDate, isoformat, unixMicros } from "../../src/lib/isoformat.ts";
import { TextError } from "../../src/lib/text.ts";
import { ZONES } from "../../src/lib/zones.ts";

/** The message of the TextError a call raises (a validator's refusal), or "accepted". */
function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof TextError) return error.message;
		throw error;
	}
	return "accepted";
}

// [what it is, the text, Slack's ts, Intercom's seconds, Outlook's UTC time]. The zones in the names are
// where the gap or fold would be; no code here knows them.
const LOCAL_TIMES = [
	["Berlin, the hour that does not exist (spring)", "2026-03-29T02:30:00", "1774751400.000000", 1774751400, "2026-03-29T02:30:00Z"],
	["Berlin, the hour that happens twice (autumn)", "2026-10-25T02:30:00", "1792895400.000000", 1792895400, "2026-10-25T02:30:00Z"],
	["New York, the hour that does not exist", "2026-03-08T02:30:00", "1772937000.000000", 1772937000, "2026-03-08T02:30:00Z"],
	["New York, the hour that happens twice", "2026-11-01T01:30:00", "1793496600.000000", 1793496600, "2026-11-01T01:30:00Z"],
	["the first Berlin 02:30 of the fold, by its offset", "2026-10-25T02:30:00+02:00", "1792888200.000000", 1792888200, "2026-10-25T00:30:00Z"],
	["the second Berlin 02:30 of the fold, by its offset", "2026-10-25T02:30:00+01:00", "1792891800.000000", 1792891800, "2026-10-25T01:30:00Z"],
] as const;

// [text, what Python's datetime.fromisoformat makes of it (isoformat()), or the message it is refused with]
const GRAMMAR: readonly (readonly [string, string, boolean])[] = [
	["2026-10-01", "2026-10-01T00:00:00", true],
	["20261001T0900", "2026-10-01T09:00:00", true],
	["2026-W40-4", "2026-10-01T00:00:00", true],
	["2026W404", "2026-10-01T00:00:00", true],
	["2026-10-01 09:00", "2026-10-01T09:00:00", true],
	["2026-10-01x09:00", "2026-10-01T09:00:00", true],
	["2026-10-01T09:00:00.1234567Z", "2026-10-01T09:00:00.123456+00:00", true],
	["2026-10-01T09:00:00-23:59:59.999999", "2026-10-01T09:00:00-23:59:59.999999", true],
	["2026-10-01T09:00:00+01:00:30", "2026-10-01T09:00:00+01:00:30", true],
	["2026-10-01T09:00:00-00:00", "2026-10-01T09:00:00+00:00", true],
	["2026-10-01T24:00", "2026-10-02T00:00:00", true],
	["2024-02-29T24:00", "2024-03-01T00:00:00", true],
	["2026-10-01T09:00:00+24:00", "offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not datetime.timedelta(days=1)", false],
	["2026-10-01T24:00:01", "minute, second, and microsecond must be 0 when hour is 24", false],
	["2026-10-01T25:00", "hour must be in 0..23, not 25", false],
	["2026-02-29", "day 29 must be in range 1..28 for month 2 in year 2026", false],
	["2026-13-01", "month must be in 1..12, not 13", false],
	["0000-01-01", "year must be in 1..9999, not 0", false],
	["9999-12-31T24:00", "year must be in 1..9999, not 10000", false],
	["2026-10-01T09,5", 'Invalid isoformat string: "2026-10-01T09,5"', false],
	["2026-10-01T", 'Invalid isoformat string: "2026-10-01T"', false],
	["2026-10-01T09:00:00.Z", 'Invalid isoformat string: "2026-10-01T09:00:00.Z"', false],
	["2026-10-01T\u0660\u0669:00", 'Invalid isoformat string: "2026-10-01T\u0660\u0669:00"', false],
];

/** Whole seconds and microseconds of an instant as the ISO text of the UTC time. */
function utcText(seconds: number, micros: number): string {
	return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}Z`;
}

/** A small deterministic generator (mulberry32). */
function randoms(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function dateTests(): void {
	describe("a time without an offset", () => {
		for (const [name, text, ts, seconds, utc] of LOCAL_TIMES) {
			const hasOffset = /[+-]\d\d:\d\d$/.test(text);
			test(`${name}: ${hasOffset ? "read at its offset" : "UTC, refused where an offset is required"}`, () => {
				expect(slackMoment(text)).toBe(ts);
				expect(sinceProblem(text)).toBeNull();
				expect(sinceTimestamp(text)).toBe(seconds);
				expect(outlookMoment(text)).toBe(utc);
				if (hasOffset) {
					expect(refusal(() => googleCheckDateTime(text))).toBe("accepted");
					expect(refusal(() => outlookCalendarCheckDateTime(text))).toBe("accepted");
				} else {
					// Google Calendar and Outlook's calendar create and list timed events only with an offset.
					expect(refusal(() => googleCheckDateTime(text))).toBe(DATE_TIME_MESSAGE);
					expect(refusal(() => outlookCalendarCheckDateTime(text))).toBe(DATE_TIME_MESSAGE);
				}
			});
		}

		test("the two readings of the hour that happens twice are an hour apart", () => {
			expect(Number(slackMoment("2026-10-25T02:30:00+01:00")) - Number(slackMoment("2026-10-25T02:30:00+02:00"))).toBe(3600);
		});

		test("an all-day event's midnight is sent with its zone's name, never converted", () => {
			const body = eventPayload({
				calendar_id: "primary",
				subject: "Switch",
				start: "2026-03-29",
				end: "2026-03-30",
				time_zone: "Europe/Berlin",
				body: null,
				location: null,
			});
			expect([body.start, body.end]).toEqual([
				{ dateTime: "2026-03-29T00:00:00", timeZone: "Europe/Berlin" },
				{ dateTime: "2026-03-30T00:00:00", timeZone: "Europe/Berlin" },
			]);
		});

		test("a timed event is sent in UTC, converted from its offset", () => {
			const body = eventPayload({
				calendar_id: "primary",
				subject: "Fold",
				start: "2026-10-25T02:30:00+02:00",
				end: "2026-10-25T02:30:00+01:00",
				time_zone: null,
				body: null,
				location: null,
			});
			expect([body.start, body.end]).toEqual([
				{ dateTime: "2026-10-25T00:30:00", timeZone: "UTC" },
				{ dateTime: "2026-10-25T01:30:00", timeZone: "UTC" },
			]);
		});
	});

	describe("time zone names", () => {
		test("a name is valid when Python's zoneinfo lists it, spelled as it lists it", () => {
			for (const name of ["US/Pacific", "Europe/Berlin", "Asia/Calcutta", "Asia/Kolkata", "Etc/GMT+5", "UTC", "EST5EDT", "Zulu"]) expect(ZONES.has(name)).toBe(true);
			// Intl accepts all of these but "Z" and the names with a space or a newline (test/platform/dates.test.ts),
			// which is why it cannot be the check.
			for (const name of ["us/pacific", "US/PACIFIC", "utc", "gmt", "etc/gmt+5", "+01:00", "-05:30", "+0100", "Z", "SystemV/AST4", "Europe/Berlin ", " Europe/Berlin", "Europe/Berlin\n"]) {
				expect(ZONES.has(name)).toBe(false);
			}
		});
	});

	describe("datetime.fromisoformat and date.fromisoformat", () => {
		for (const [text, expected, ok] of GRAMMAR) {
			test(`${JSON.stringify(text)} is ${ok ? "read" : "refused"}`, () => {
				if (ok) expect(isoformat(datetimeFromIsoFormat(text))).toBe(expected);
				else expect(refusal(() => datetimeFromIsoFormat(text))).toBe(expected);
			});
		}

		test("date.fromisoformat reads week dates and stops after the date", () => {
			expect(dateFromIsoFormat("2026-W53-1")).toEqual({ year: 2026, month: 12, day: 28 });
			expect(dateFromIsoFormat("20261001xx")).toEqual({ year: 2026, month: 10, day: 1 });
			expect(refusal(() => dateFromIsoFormat("1900-W53-1"))).toBe('Invalid isoformat string: "1900-W53-1"');
			expect(refusal(() => dateFromIsoFormat("2026-10-01T09:00"))).toBe('Invalid isoformat string: "2026-10-01T09:00"');
		});

		test("the connectors that call it say what they say when it refuses", () => {
			expect(refusal(() => slackMoment("2026-13-01"))).toBe(MOMENT_MESSAGE);
			expect(sinceProblem("2026-13-01")).toBe(NOT_ISO);
			expect(refusal(() => outlookMoment("2026-13-01"))).toBe("must be an ISO 8601 time such as 2026-10-01T09:00:00Z");
			expect(isoDate("2026-13-01")).toBeNull();
			expect(dayProblem("2026-13-01")).toBe(NOT_A_DATE);
			expect(dayProblem("1899-12-31")).toBe(OUT_OF_RANGE);
			expect(isoDate("2026W404")).toBe("2026-10-01");
		});

		test("a lone surrogate may stand for the separator, which Intercom and Xero have always refused", () => {
			const text = "2026-10-01\ud80009:00:00Z";
			expect(isoformat(datetimeFromIsoFormat(text))).toBe("2026-10-01T09:00:00+00:00");
			expect(isoInstant(text)).toBe(1790845200000000n);
			expect(sinceProblem(text)).toBe(NOT_ISO);
			expect(refusal(() => datetimeFromIsoFormat("2026-10-01T09:00:00\ud800"))).toContain("Invalid isoformat string");
		});

		test("Xero reads only ASCII, where Python reads ten bytes (the length check of the field comes first)", () => {
			expect(isoDate("00010114\u00e9")).toBe("0001-01-14");
			expect(dayProblem("00010114\u00e9")).toBe(NOT_A_DATE);
			expect(dayProblem("2026-10-0\u0663")).toBe(NOT_A_DATE);
		});
	});

	describe("Slack timestamps", () => {
		test("a ts and its time are the same microseconds, through integers", () => {
			const next = randoms(5);
			// From 2001 to 2242-03-16 (2^33 seconds), where a double still holds every microsecond.
			for (let i = 0; i < 20_000; i++) {
				const seconds = 1_000_000_000 + Math.floor(next() * (2 ** 33 - 1_000_000_000));
				const micros = Math.floor(next() * 1_000_000);
				const ts = `${seconds}.${String(micros).padStart(6, "0")}`;
				const time = utcText(seconds, micros);
				expect(isoTime(ts)).toBe(time);
				expect(slackMoment(time)).toBe(ts);
				expect(unixMicros(datetimeFromIsoFormat(time))).toBe(BigInt(seconds) * 1_000_000n + BigInt(micros));
			}
		});

		test("Python's float is kept past 2^33 seconds, where a ts has lost its last microsecond there too", () => {
			expect(isoTime("4294967295.999999")).toBe("2106-02-07T06:28:15.999999Z");
			expect(isoTime("8589934591.999999")).toBe("2242-03-16T12:56:31.999999Z");
			expect(isoTime("9000000000.000001")).toBe("2255-03-14T16:00:00.000002Z");
			expect(isoTime("9999999999.999999")).toBe("2286-11-20T17:46:39.999998Z");
			expect(slackMoment("2286-11-20T17:46:39.999999Z")).toBe("9999999999.999998");
			expect(slackMoment("8000-06-15T12:34:56.789012Z")).toBe("190302784496.789001");
		});

		test("the microseconds of an instant are exact in the integers behind the ts", () => {
			expect(isoInstant("2026-10-01T09:00:00.123456Z")).toBe(1790845200123456n);
			expect(isoInstant("2026-10-01T09:00:00.123456+05:30")).toBe(1790825400123456n);
			expect(isoInstant("2026-10-01T09:00:00,5+05:30")).toBe(1790825400500000n);
			expect(slackMoment("2026-10-01T09:00:00.123456Z")).toBe("1790845200.123456");
			expect(slackMoment("1969-12-31T23:59:59.999999Z")).toBe("-0.000001");
		});
	});
}
