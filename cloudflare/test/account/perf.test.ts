// The perf probe of chunk 14a on the test instance: 20 turns, one after
// another in one conversation, each of six model calls of the `fake-remote` model (src/faults/ports.ts), whose first five
// answers call a tool that does not exist, which pi answers at once with an error. Each call sends one request to a
// FaultProvider of the workspace's that does nothing else before its answer, and the Conversation marks it on its own clock, which moves only when I/O
// completes. Per call, calls 2 to 6 of each turn (100 samples):
//
// - M1, the previous call's terminal event to this call's request answered: pi's step, any write before the send, the
//   output gate's wait for them, and one round trip;
// - M2, this call's `host.begin` to its request answered: what happens between them, and the same round trip.
//
// Per turn (20 samples), for chunk 19a:
//
// - S, the run's `created_at`, which the start's final transaction writes, to its first call's request answered: what the
//   start does after it (the attempt, pi's session and submit), pi's first step, the call's admission, the output gate's
//   wait and one round trip.
//
// Every turn is given a large allowance, so each call's admission runs its check
// and none is refused.
//
// Run only with MINERVA_PERF=1, and then alone (vitest.faults.config.ts): `MINERVA_PERF=1 pnpm test:faults` after
// `pnpm run deploy:test`. MINERVA_PERF_CALIBRATE=write writes 1 MiB of random bytes (MINERVA_PERF_CALIBRATE_BYTES) through
// `outside` before each request, the calibration; MINERVA_PERF_CALIBRATE=cpu only generates them, its control. M2 must rise
// with the write beyond the control. MINERVA_PERF_OUT names a file for the samples and their summary. A turn that restarted
// fails the probe: its marks would not be one attempt's.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { LARGE_ALLOWANCE, finish, outcome, post, script, settled, world } from "./driver.ts";

const TURNS = 20;
const CALLS = 6;
const mode = process.env.MINERVA_PERF_CALIBRATE ?? "";
if (!["", "write", "cpu"].includes(mode)) throw new Error("MINERVA_PERF_CALIBRATE is write, cpu or unset.");
const calibrate = mode === "" ? null : { bytes: Number(process.env.MINERVA_PERF_CALIBRATE_BYTES ?? 1 << 20), write: mode === "write" };

/** The value below which a fraction `q` of the sorted samples lie, interpolated between neighbours. */
function quantile(sorted: readonly number[], q: number): number {
	const at = (sorted.length - 1) * q;
	const below = sorted[Math.floor(at)] as number;
	const above = sorted[Math.ceil(at)] as number;
	return below + (above - below) * (at - Math.floor(at));
}

function summary(samples: readonly number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const q1 = quantile(sorted, 0.25);
	const q3 = quantile(sorted, 0.75);
	return { n: sorted.length, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), q1, q3, iqr: q3 - q1, min: sorted[0], max: sorted.at(-1) };
}

afterAll(finish, 300_000);

describe("perf probe", () => {
	test(
		`M1, M2 and S over ${TURNS} turns of ${CALLS} model calls`,
		async () => {
			const w = await world({ model: "fake-remote", ...(calibrate ? { calibrate } : {}) });
			const prompt = script([...Array.from({ length: CALLS - 1 }, () => ({ tools: [{ name: "no_such_tool", arguments: {} }] })), { text: "Done." }]);
			const m1: number[] = [];
			const m2: number[] = [];
			const s: number[] = [];
			for (let turn = 0; turn < TURNS; turn++) {
				const view = await settled(w, await post(w, prompt, [], { allowance: LARGE_ALLOWANCE }), 120_000);
				expect(view.head?.status, outcome(view)).toBe("completed");
				expect(view.internals.attempts, outcome(view)).toHaveLength(1);
				expect(view.internals.entered.model, outcome(view)).toBe(CALLS);
				expect(view.internals.run?.model_calls, outcome(view)).toBe(CALLS);
				const marks = view.internals.marks;
				expect(marks, `turn ${turn + 1}'s marks: ${JSON.stringify(marks)}`).toHaveLength(CALLS);
				const createdAt = view.internals.run?.created_at;
				const first = marks[0]?.answered;
				if (typeof createdAt !== "number" || first == null) throw new Error(`Turn ${turn + 1}'s start or first call is not marked: ${outcome(view)} ${JSON.stringify(marks)}`);
				s.push(first - createdAt);
				for (let call = 1; call < CALLS; call++) {
					const { begin, answered } = marks[call] as (typeof marks)[number];
					const previous = marks[call - 1]?.last;
					if (answered === null || previous == null) throw new Error(`Turn ${turn + 1}, call ${call + 1} is not marked: ${JSON.stringify(marks)}`);
					m1.push(answered - previous);
					m2.push(answered - begin);
				}
			}
			const result = { calibrate, turns: TURNS, m1: summary(m1), m2: summary(m2), s: summary(s), samples: { m1, m2, s } };
			console.info(`perf probe (calibrate ${JSON.stringify(calibrate)}): M1 ${JSON.stringify(result.m1)}; M2 ${JSON.stringify(result.m2)}; S ${JSON.stringify(result.s)}`);
			if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(result, null, 2)}\n`);
		},
		900_000,
	);
});
