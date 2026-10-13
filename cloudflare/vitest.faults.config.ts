import { defineConfig } from "vitest/config";

// Fault tests on the account: a test instance (`pnpm run deploy:test`; `pnpm test:faults` runs scripts/suite.ts,
// which names it in MINERVA_INSTANCE, or it is the only test instance), driven through its
// token-gated /api/faults/ (src/faults/routes.ts), and its sandbox lab (src/faults/lab.ts) with the real
// container. Two groups, one after the other: first every file but the memory-limit resets, at once, with
// their tests at once within them; then resets.test.ts alone, since a memory-limit reset takes every object of
// its isolate with it.
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 420_000,
		hookTimeout: 240_000,
		// Per file: every concurrent test of a file starts at once (vitest's default is 5).
		maxConcurrency: 16,
		projects: [
			{
				extends: true,
				test: {
					name: "account",
					include: ["test/account/faults.test.ts", "test/account/sandbox.test.ts", "test/account/sandbox-faults.test.ts", "test/account/turns.test.ts"],
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
