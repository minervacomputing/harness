import { defineConfig } from "vitest/config";

// Fault tests on the account: a test instance (`pnpm run deploy:test`; `pnpm test:faults` runs scripts/suite.ts,
// which names it in MINERVA_INSTANCE, or it is the only test instance), driven through its
// token-gated /api/faults/ (src/faults/routes.ts), and its sandbox lab (src/faults/lab.ts) with the real
// container. Two groups, one after the other: first every file but the memory-limit resets, at once, with
// their tests at once within them; then resets.test.ts alone, since a memory-limit reset takes every object of
// its isolate with it. With MINERVA_PERF=1, only the probes, one file after another, so no other turn shares their numbers:
// chunk 14a's (perf.test.ts), chunk 15a's measurement (retention-measure.test.ts) and its perf probe (retention-perf.test.ts);
// name one to run it alone.
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 420_000,
		hookTimeout: 240_000,
		// Per file: every concurrent test of a file starts at once (vitest's default is 5).
		maxConcurrency: 16,
		fileParallelism: process.env.MINERVA_PERF !== "1",
		projects: process.env.MINERVA_PERF === "1" ? [{ extends: true, test: { name: "perf", include: ["test/account/perf.test.ts", "test/account/retention-measure.test.ts", "test/account/retention-perf.test.ts"] } }] : [
			{
				extends: true,
				test: {
					name: "account",
					// Before the first group: until the deployed image starts containers promptly (test/account/warm.ts).
					// Here, not at the root: each project would run the root's again.
					globalSetup: ["test/account/warm.ts"],
					include: ["test/account/faults.test.ts", "test/account/sandbox.test.ts", "test/account/sandbox-faults.test.ts", "test/account/turns.test.ts", "test/account/retention.test.ts"],
					sequence: { groupOrder: 1 },
				},
			},
			{
				extends: true,
				test: { name: "resets", include: ["test/account/resets.test.ts"], sequence: { groupOrder: 2 } },
			},
		],
	},
});
