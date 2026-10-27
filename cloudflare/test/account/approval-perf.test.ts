// Chunk 4's probe on the test instance: 10 rounds, one after another in one conversation, each an attended turn whose save of
// a note is held under a layer that asks before saving, then its continuation approving it. Per round, the time from the
// continuation's acceptance, its run's `created_at`, which the start's final transaction writes, to the approved save's
// settlement, its `run.write` fact's `at`, written in the transaction that settles it: both on the object's clock. What lies
// between is the start section up to the carry-out (the settle, the tools installed) and the approved call itself: its
// lease from the fake Laravel, its prepare, its dispatch and the fake provider's answer. The rule: a median under 2 s.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts): `MINERVA_PERF=1 pnpm test:faults test/account/approval-perf.test.ts`
// after `pnpm run deploy:test`. MINERVA_PERF_OUT names a file for the samples and their summary.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { askingToSave, delivered, finish, outcome, post, save, script, settled, world } from "./driver.ts";

const ROUNDS = 10;
const RULE_MS = 2000;

afterAll(finish, 300_000);

describe("approval probe", () => {
	test(
		`acceptance to the approved save settled, over ${ROUNDS} continuations`,
		async () => {
			const w = await world();
			const samples: number[] = [];
			for (let round = 1; round <= ROUNDS; round++) {
				const heldRun = await post(w, script([save(`Note ${round}`), { text: "It waits for your approval." }]), [], { authority: askingToSave(w), attended: true });
				const held = await settled(w, heldRun, 120_000);
				expect(held.internals.holds.map(({ state }) => state), outcome(held)).toEqual(["open"]);
				const runId = await post(w, script([{ text: "Saved." }]), [], { authority: askingToSave(w), attended: true, approval: { run: heldRun, decisions: [{ position: 1, approve: true }] } });
				const view = await settled(w, runId, 120_000);
				expect(view.head?.status, outcome(view)).toBe("completed");
				expect(view.internals.attempts, outcome(view)).toHaveLength(1);
				const write = (await delivered(w, runId)).find((fact) => fact.run === runId && fact.type === "run.write");
				const createdAt = view.internals.run?.created_at;
				if (write === undefined || typeof createdAt !== "number") throw new Error(`Round ${round} has no settled save or no start: ${outcome(view)}`);
				expect(write.data, `round ${round}`).toMatchObject({ outcome: "done", approved: { run: heldRun, position: 1 } });
				samples.push(Date.parse(write.at) - createdAt);
			}
			const sorted = [...samples].sort((a, b) => a - b);
			const median = ((sorted[ROUNDS / 2 - 1] as number) + (sorted[ROUNDS / 2] as number)) / 2;
			const result = { rounds: ROUNDS, median, min: sorted[0], max: sorted.at(-1), samples };
			console.info(`approval probe: ${JSON.stringify(result)}`);
			if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(result, null, 2)}\n`);
			expect(median, `the median of ${JSON.stringify(samples)}`).toBeLessThan(RULE_MS);
		},
		900_000,
	);
});
