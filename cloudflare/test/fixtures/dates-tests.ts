// Dates and times (src/lib/dates.ts and the connectors that read them). test/unit/dates.test.ts runs these in
// Node and test/platform/dates.test.ts in workerd, which production runs in: time zone names depend on the
// runtime's Intl.

import { describe, expect, test } from "vitest";
import { sinceProblem, sinceTimestamp, NOT_IN_RANGE } from "../../src/connectors/intercom/reads.ts";
import { iso as intercomTime } from "../../src/connectors/intercom/inboxes.ts";
import { moment as outlookMoment } from "../../src/connectors/outlook/reads.ts";
import { checkDateOrDateTime, eventPayload, windowOf } from "../../src/connectors/outlook_calendar/connector.ts";
import { isoTime as slackTime, moment as slackMoment } from "../../src/connectors/slack/connector.ts";
import { epochMicros, formatUtc, isoTime, parseDate, parseDateTime, parseInstant, runStartLabel, isTimeZone, parseZonedDateTime } from "../../src/lib/dates.ts";
import { TextError } from "../../src/lib/text.ts";

/** The message of the TextError a check throws, or "accepted". */
function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof TextError) return error.message;
		throw error;
	}
	return "accepted";
}

const micros = (ms: number) => BigInt(ms) * 1000n;

export function dateTests(): void {
	describe("dates", () => {
		test("YYYY-MM-DD naming a real day", () => {
			for (const text of ["2026-10-01", "2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"]) expect(parseDate(text), text).not.toBeNull();
			expect(parseDate("2026-10-01")).toEqual({ year: 2026, month: 10, day: 1 });
			const refused = [
				"2026-02-29", "1900-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00",
				"20261001", "2026-W40-4", "2026-10-1", " 2026-10-01", "2026-10-01T09:00", "2026-10-0٣", "+12026-10-01",
			];
			for (const text of refused) expect(parseDate(text), text).toBeNull();
		});
	});

	describe("date-times", () => {
		test("RFC 3339, with or without seconds, a fraction and an offset", () => {
			expect(parseDateTime("2026-10-01T09:00")).toEqual({ year: 2026, month: 10, day: 1, hour: 9, minute: 0, second: 0, micro: 0, offset: null });
			expect(parseDateTime("2026-10-01T09:00:30.5Z")).toMatchObject({ second: 30, micro: 500000, offset: 0 });
			expect(parseDateTime("2026-10-01T09:00:00.123456-05:30")).toMatchObject({ micro: 123456, offset: -330 });
			expect(parseZonedDateTime("2026-10-01T09:00:00Z")).not.toBeNull();
			expect(parseZonedDateTime("2026-10-01T09:00:00")).toBeNull();
			expect(parseDateTime("2026-10-01T09:00:00-00:00")).toMatchObject({ offset: 0 });
			expect(parseDateTime("2026-10-01T23:59:59+23:59")).toMatchObject({ offset: 1439 });
		});

		test("the calendar and the clock are checked, never rolled over", () => {
			const refused = [
				"2026-02-29T09:00Z", "2026-02-30T09:00Z", "2026-10-01T24:00Z", "2026-10-01T23:60Z", "2026-10-01T23:59:60Z",
				"2026-10-01T09:00+24:00", "2026-10-01T09:00+05:60", "2026-10-01T09:00+0100", "2026-10-01T09:00+01",
				"2026-10-01 09:00Z", "2026-10-01t09:00z", "2026-10-01T09", "2026-10-01T09:00:00.Z", "2026-10-01T09:00:00.1234567Z",
				"2026-10-01", "20261001T0900", "2026-10-01T٠٩:00Z",
			];
			for (const text of refused) expect(parseDateTime(text), text).toBeNull();
		});

		test("an instant counts microseconds; a date and a time without an offset are UTC, whatever the runtime's zone", () => {
			expect(parseInstant("2026-10-01T09:00:00.123456+05:30")).toBe(1790825400123456n);
			expect(parseInstant("2026-10-01")).toBe(micros(Date.UTC(2026, 9, 1)));
			// Berlin's spring gap and New York's autumn fold mean nothing here.
			expect(parseInstant("2026-03-29T02:30:00")).toBe(micros(Date.UTC(2026, 2, 29, 2, 30)));
			expect(parseInstant("2026-11-01T01:30:00")).toBe(micros(Date.UTC(2026, 10, 1, 1, 30)));
			expect(parseInstant("2026-10-25T02:30:00+01:00")! - parseInstant("2026-10-25T02:30:00+02:00")!).toBe(3_600_000_000n);
			expect(parseInstant("0001-01-01")).toBe(-62135596800000000n);
			expect(epochMicros({ year: 99, month: 3, day: 1 })).toBe(micros(new Date("0099-03-01T00:00:00Z").getTime()));
			expect(parseInstant("2026-02-30")).toBeNull();
			// Written in UTC, these would need a fifth digit or a sign for the year.
			expect(parseInstant("0000-01-01T00:00:00+01:00")).toBeNull();
			expect(parseInstant("9999-12-31T23:59:59-01:00")).toBeNull();
			expect(parseInstant("9999-12-31T23:59:59.999999Z")).toBe(253402300799999999n);
		});

		test("UTC as ISO text, with a fraction only when there is one", () => {
			expect(formatUtc(1790845200000000n)).toBe("2026-10-01T09:00:00Z");
			expect(formatUtc(1790845200123456n)).toBe("2026-10-01T09:00:00.123456Z");
			expect(formatUtc(-1n)).toBe("1969-12-31T23:59:59.999999Z");
			expect(isoTime(Date.UTC(2026, 9, 10, 14, 3, 0, 120))).toBe("2026-10-10T14:03:00.120Z");
			expect(runStartLabel(Date.UTC(2026, 9, 12, 14, 3, 59))).toBe("Monday, 2026-10-12 14:03");
			expect(runStartLabel(Date.UTC(2026, 0, 4, 0, 0))).toBe("Sunday, 2026-01-04 00:00");
		});
	});

	describe("time zones", () => {
		test("IANA names the runtime knows, aliases included; not offsets", () => {
			for (const name of ["Europe/Berlin", "UTC", "US/Pacific", "us/pacific", "Asia/Kolkata", "Asia/Calcutta", "Etc/GMT+5", "America/Argentina/Buenos_Aires"]) {
				expect(isTimeZone(name), name).toBe(true);
			}
			for (const name of ["Mars/Olympus", "+01:00", "-05:30", "Z", "", "Europe/Berlin ", "Europe//Berlin", "/Europe/Berlin", "Europe/Berlin\n"]) {
				expect(isTimeZone(name), name).toBe(false);
			}
		});
	});

	describe("the connectors", () => {
		test("a time without an offset is UTC where an ISO 8601 time is asked for", () => {
			expect(slackMoment("2026-03-29T02:30:00")).toBe("1774751400.000000");
			expect(sinceTimestamp("2026-03-29T02:30:00")).toBe(1774751400);
			expect(outlookMoment("2026-03-29T02:30:00")).toBe("2026-03-29T02:30:00Z");
			expect(outlookMoment("2026-10-01")).toBe("2026-10-01T00:00:00Z");
			expect(outlookMoment("2026-10-25T02:30:00.5+02:00")).toBe("2026-10-25T00:30:00.500000Z");
			expect(refusal(() => outlookMoment("2026-02-30"))).toBe("must be an ISO 8601 time such as 2026-10-01T09:00:00Z");
		});

		test("Intercom's updated_after is held to the years 2000 to 2100 in UTC; its times are whole seconds", () => {
			expect(sinceProblem("2000-01-01T00:00:00Z")).toBeNull();
			expect(sinceProblem("2000-01-01T00:30:00+01:00")).toBe(NOT_IN_RANGE);
			expect(sinceProblem("2101-01-01")).toBe(NOT_IN_RANGE);
			expect(intercomTime(1790845200)).toBe("2026-10-01T09:00:00Z");
			for (const value of [0, -1, 1.5, 253402300800, null]) expect(intercomTime(value)).toBeNull();
		});

		test("a Slack ts and its time are the same microseconds, never a float", () => {
			for (const ts of ["1727780000.123456", "1000000000.000001", "9999999999.999999", "4294967295.999999"]) {
				const time = slackTime(ts) as string;
				expect(slackMoment(time)).toBe(ts);
			}
			expect(slackTime("9999999999.999999")).toBe("2286-11-20T17:46:39.999999Z");
			expect(slackTime("1790845200.000000")).toBe("2026-10-01T09:00:00Z");
			expect(slackMoment("1969-12-31T23:59:59.999999Z")).toBe("-0.000001");
			expect(slackTime("1790845200.5")).toBeNull();
		});

		test("Outlook Calendar: an all-day event's midnight goes with its zone's name, a timed event in UTC", () => {
			const base = { calendar_id: "primary", subject: "Switch", body: null, location: null };
			const allDay = eventPayload({ ...base, start: "2026-03-29", end: "2026-03-30", time_zone: "Europe/Berlin" });
			expect([allDay.start, allDay.end]).toEqual([
				{ dateTime: "2026-03-29T00:00:00", timeZone: "Europe/Berlin" },
				{ dateTime: "2026-03-30T00:00:00", timeZone: "Europe/Berlin" },
			]);
			const timed = eventPayload({ ...base, start: "2026-10-25T02:30:00+02:00", end: "2026-10-25T02:30:00.25+01:00", time_zone: null });
			expect([timed.start, timed.end]).toEqual([
				{ dateTime: "2026-10-25T00:30:00", timeZone: "UTC" },
				{ dateTime: "2026-10-25T01:30:00.250000", timeZone: "UTC" },
			]);
			expect(windowOf({ time_min: "2026-10-01T09:00:00+02:00", time_max: null }, 0)).toEqual(["2026-10-01T07:00:00Z", "2026-10-31T07:00:00Z"]);
			expect(windowOf({ time_min: null, time_max: null }, Date.UTC(2026, 9, 1))).toEqual(["2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"]);
			expect(refusal(() => checkDateOrDateTime("2026-10-01T09:00:00"))).toContain("with an offset");
			expect(refusal(() => checkDateOrDateTime("1899-12-31"))).toBe("must be between the years 1900 and 2999");
		});
	});
}
