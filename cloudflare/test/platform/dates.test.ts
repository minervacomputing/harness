// Dates and times (test/fixtures/dates-tests.ts) in workerd, which production runs in; test/unit/dates.test.ts
// runs the same tests in Node. And what the runtime offers for dates, which is why lib/isoformat.ts and
// lib/zones.ts are our own (docs/plans/cloudflare.md, "Dates and time zones").

import { describe, expect, test } from "vitest";
import { ZONES } from "../../src/lib/zones.ts";
import { dateTests } from "../fixtures/dates-tests.ts";

dateTests();

/** The zone `Intl` resolves a name to, or null where it refuses the name. */
function resolved(timeZone: string): string | null {
	try {
		return new Intl.DateTimeFormat("en-US", { calendar: "gregory", numberingSystem: "latn", hourCycle: "h23", timeZone }).resolvedOptions().timeZone;
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
}

describe("the runtime's dates", () => {
	test("there is no Temporal at the compatibility date (when this fails, review lib/isoformat.ts: Temporal reads none of its grammar)", () => {
		expect(typeof (globalThis as { Temporal?: unknown }).Temporal).toBe("undefined");
	});

	test("Intl knows every name Python lists, and resolves aliases such as US/Pacific", () => {
		expect([...ZONES].filter((name) => resolved(name) === null)).toEqual([]);
		expect(resolved("US/Pacific")).toBe("America/Los_Angeles");
		expect(resolved("Asia/Kolkata")).toBe("Asia/Calcutta");
		expect(resolved("EST5EDT")).toBe("America/New_York");
		expect(Intl.supportedValuesOf("timeZone").filter((name) => !ZONES.has(name))).toEqual([]);
	});

	test("Intl also accepts what Python's list refuses, so it cannot decide which names are valid", () => {
		const refusedByPython = ["us/pacific", "US/PACIFIC", "utc", "gmt", "etc/gmt+5", "+01:00", "-05:30", "+0100", "SystemV/AST4"];
		expect(refusedByPython.filter((name) => ZONES.has(name))).toEqual([]);
		expect(refusedByPython.filter((name) => resolved(name) === null)).toEqual([]);
		for (const name of ["Z", "Europe/Berlin ", " Europe/Berlin", "Europe/Berlin\n", "Mars/Olympus"]) expect(resolved(name)).toBeNull();
	});
});
