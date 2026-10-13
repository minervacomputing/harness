// The attempt gate's decision (plan: Attempts and recovery): the restart rules and the cases of the gate
// proof's review.

import { describe, expect, test } from "vitest";
import { classifyWork, decideGate, type GateRun, MAX_ATTEMPTS, RESTART_MIN_REMAINING_MS } from "../../src/conversation/gate.ts";

const NOW = 1_800_000_000_000;

function run(fields: Partial<GateRun> = {}): GateRun {
	return { status: "running", attempt: 1, activated: true, deadline: null, ...fields };
}

describe("what pi holds for a run", () => {
	test.each([
		[undefined, 0, "not_submitted"],
		["queued", 0, "in_progress"],
		["placed", 0, "in_progress"],
		["done", 0, "settled"],
		["unanswered", 0, "settled"],
		// Live tasks mean work in progress, background ones included, even after the submission settled.
		["done", 1, "in_progress"],
		[undefined, 2, "in_progress"],
	] as const)("submission %s with %i live tasks is %s", (submission, live, work) => {
		expect(classifyWork(submission, live)).toBe(work);
	});
});

describe("the gate's decision", () => {
	test("an activated acting run with unsettled pi work gets a new attempt, its deadline untouched", () => {
		expect(decideGate(run(), "in_progress", NOW)).toEqual({ kind: "restart", attempt: 2 });
		expect(decideGate(run({ status: "provisioning", attempt: 2 }), "in_progress", NOW)).toEqual({ kind: "restart", attempt: 3 });
		expect(decideGate(run({ deadline: NOW + RESTART_MIN_REMAINING_MS }), "in_progress", NOW)).toEqual({ kind: "restart", attempt: 2 });
	});

	test("at most three attempts, and none with under 30 s left: worker_exited", () => {
		expect(MAX_ATTEMPTS).toBe(3);
		expect(decideGate(run({ attempt: 3 }), "in_progress", NOW)).toEqual({ kind: "worker_exited" });
		expect(decideGate(run({ deadline: NOW + RESTART_MIN_REMAINING_MS - 1 }), "in_progress", NOW)).toEqual({ kind: "worker_exited" });
	});

	test("a deadline that passed while the object was away ends the run as timed_out first", () => {
		expect(decideGate(run({ deadline: NOW }), "in_progress", NOW)).toEqual({ kind: "timed_out" });
		expect(decideGate(run({ deadline: NOW - 1, attempt: 3 }), "in_progress", NOW)).toEqual({ kind: "timed_out" });
		// Also a queued run, and one pi never had: an expired run is inactive whatever its state.
		expect(decideGate(run({ status: "queued", activated: false, deadline: NOW - 1 }), null, NOW)).toEqual({ kind: "timed_out" });
	});

	test("no restart: no active run, a queued one, one not activated, or one pi has settled or never had", () => {
		expect(decideGate(null, null, NOW)).toEqual({ kind: "none" });
		expect(decideGate(run({ status: "completed" }), "in_progress", NOW)).toEqual({ kind: "none" });
		expect(decideGate(run({ status: "queued", activated: false }), null, NOW)).toEqual({ kind: "none" });
		expect(decideGate(run({ status: "queued", activated: true }), "in_progress", NOW)).toEqual({ kind: "none" });
		expect(decideGate(run({ activated: false }), "in_progress", NOW)).toEqual({ kind: "none" });
		expect(decideGate(run(), "settled", NOW)).toEqual({ kind: "none" });
		expect(decideGate(run(), "not_submitted", NOW)).toEqual({ kind: "none" });
		expect(decideGate(run({ attempt: 3 }), "settled", NOW)).toEqual({ kind: "none" });
	});

	test("a run without a deadline is restarted, and keeps none", () => {
		expect(decideGate(run({ deadline: null, attempt: 2 }), "in_progress", NOW)).toEqual({ kind: "restart", attempt: 3 });
	});
});
