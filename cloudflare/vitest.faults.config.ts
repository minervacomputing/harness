import { defineConfig } from "vitest/config";

// Fault tests on the account: the test Worker minerva-cf-test (`pnpm run deploy:test`), driven through its
// token-gated /api/faults/ (src/faults/routes.ts). Restarts wait for the platform, so tests are long.
export default defineConfig({
	test: {
		include: ["test/account/faults.test.ts"],
		environment: "node",
		testTimeout: 420_000,
		hookTimeout: 60_000,
	},
});
