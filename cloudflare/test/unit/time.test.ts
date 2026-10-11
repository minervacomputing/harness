import { expect, test } from "vitest";
import { epochSeconds, isoTime, runStartLabel } from "../../src/lib/time.ts";

test("the instructions' run start", () => {
	expect(runStartLabel(Date.UTC(2026, 9, 12, 14, 3, 59))).toBe("Monday, 2026-10-12 14:03");
	expect(runStartLabel(Date.UTC(2026, 0, 4, 0, 0))).toBe("Sunday, 2026-01-04 00:00");
});

test("API times", () => {
	expect(isoTime(Date.UTC(2026, 9, 10, 14, 3, 0, 120))).toBe("2026-10-10T14:03:00.120Z");
	expect(epochSeconds(1_760_000_000_120)).toBe(1_760_000_000.12);
});
