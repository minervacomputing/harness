import { defineConfig } from "vitest/config";

// Fault tests on the account: the test Worker minerva-cf-test (`pnpm run deploy:test`), driven through its
// token-gated /api/faults/ (src/faults/routes.ts), and its sandbox lab (src/faults/lab.ts) with the real
// container. Restarts wait for the platform, so tests are long.
export default defineConfig({
	test: {
		include: ["test/account/faults.test.ts", "test/account/sandbox.test.ts", "test/account/turns.test.ts"],
		environment: "node",
		// One file at a time: a memory-limit reset in faults.test.ts takes every object of its isolate with it,
		// the sandbox lab's included.
		fileParallelism: false,
		testTimeout: 420_000,
		hookTimeout: 60_000,
	},
});
