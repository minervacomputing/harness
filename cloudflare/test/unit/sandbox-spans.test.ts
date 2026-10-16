// A container incarnation's span (src/sandbox/store.ts): how each change of the Sandbox's state row opens,
// extends or closes it, and how a run's spans are charged. The same rules through SandboxCore are in
// sandbox-core.test.ts.

import { describe, expect, test } from "vitest";
import { containerCharge, type ContainerSpan, EMPTY, spanChange, type SpanEnd, type StateRow } from "../../src/sandbox/store.ts";

const RUN = "0199b000-0000-7000-8000-000000000001";
const LIVE: StateRow = { ...EMPTY, state: "starting", incarnation: "a", runId: RUN, attempt: 1, startedAt: 100, leaseUntil: 1000 };
const NONE: StateRow = { ...LIVE, state: "none", incarnation: null, leaseUntil: null };

describe("spanChange", () => {
	const cases: { name: string; previous: StateRow; next: StateRow; ended: SpanEnd | null; changes: ReturnType<typeof spanChange> }[] = [
		{
			name: "a start opens the incarnation's span",
			previous: EMPTY,
			next: LIVE,
			ended: null,
			changes: [{ kind: "open", incarnation: "a", runId: RUN, attempt: 1, startedAt: 100, leaseUntil: 1000 }],
		},
		{ name: "a step that keeps the incarnation and its lease changes nothing", previous: LIVE, next: { ...LIVE, state: "hardening", hardened: true }, ended: null, changes: [] },
		{ name: "a use that moves the lease moves the span's", previous: { ...LIVE, state: "verified" }, next: { ...LIVE, state: "in_use", leaseUntil: 2000 }, ended: null, changes: [{ kind: "lease", incarnation: "a", leaseUntil: 2000 }] },
		{ name: "a destroy that failed keeps the span open", previous: LIVE, next: { ...LIVE, state: "destroying", cleanupPending: true }, ended: null, changes: [] },
		{ name: "a destroy that answered closes it", previous: { ...LIVE, state: "destroying", cleanupPending: true }, next: NONE, ended: "destroyed", changes: [{ kind: "close", incarnation: "a", endedAt: 5000, ended: "destroyed" }] },
		{ name: "a container found stopped closes it as gone", previous: { ...LIVE, state: "in_use" }, next: NONE, ended: "gone", changes: [{ kind: "close", incarnation: "a", endedAt: 5000, ended: "gone" }] },
		{
			name: "one incarnation replacing another closes the first and opens the second",
			previous: LIVE,
			next: { ...LIVE, incarnation: "b", attempt: 2, startedAt: 5000, leaseUntil: 9000 },
			ended: "destroyed",
			changes: [
				{ kind: "close", incarnation: "a", endedAt: 5000, ended: "destroyed" },
				{ kind: "open", incarnation: "b", runId: RUN, attempt: 2, startedAt: 5000, leaseUntil: 9000 },
			],
		},
		{ name: "a destroy with no incarnation closes nothing", previous: NONE, next: NONE, ended: "destroyed", changes: [] },
	];

	test.each(cases)("$name", ({ previous, next, ended, changes }) => {
		expect(spanChange(previous, next, 5000, ended)).toEqual(changes);
	});

	test("an incarnation cannot go away without saying how, nor start without a run, start and lease", () => {
		expect(() => spanChange(LIVE, NONE, 5000, null)).toThrow("The incarnation a went away without saying how.");
		expect(() => spanChange(EMPTY, { ...LIVE, leaseUntil: null }, 5000, null)).toThrow("The incarnation a has no run, start or lease.");
	});
});

describe("containerCharge", () => {
	// A lease at 1000 is charged to no later than 1000 + 10 minutes.
	const span = (startedAt: number, endedAt: number | null, ended: SpanEnd = "destroyed"): ContainerSpan =>
		endedAt === null ? { startedAt, leaseUntil: 1000, endedAt: null, ended: null } : { startedAt, leaseUntil: 1000, endedAt, ended };

	test.each([
		{ name: "no container", spans: [], since: 0, charge: { containers: 0, containerMs: 0, containerEstimated: false } },
		{ name: "a span destroyed before its cutoff, to its end", spans: [span(100, 400)], since: 0, charge: { containers: 1, containerMs: 300, containerEstimated: false } },
		{ name: "spans add up", spans: [span(100, 400), span(500, 1500)], since: 0, charge: { containers: 2, containerMs: 1300, containerEstimated: false } },
		{ name: "a span destroyed past its cutoff, to the cutoff", spans: [span(100, 700_000)], since: 0, charge: { containers: 1, containerMs: 600_900, containerEstimated: true } },
		{ name: "a span still open, to the cutoff", spans: [span(100, null)], since: 0, charge: { containers: 1, containerMs: 600_900, containerEstimated: true } },
		{ name: "a span found gone, to when it was noticed", spans: [span(100, 400, "gone")], since: 0, charge: { containers: 1, containerMs: 300, containerEstimated: true } },
		{ name: "a run created before spans were kept", spans: [span(100, 400)], since: 60, charge: { containers: 1, containerMs: 300, containerEstimated: true } },
		{ name: "a run created when spans began to be kept", spans: [], since: 50, charge: { containers: 0, containerMs: 0, containerEstimated: true } },
	])("$name", ({ spans, since, charge }) => {
		expect(containerCharge({ since, spans }, 50)).toEqual(charge);
	});
});
