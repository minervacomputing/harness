import { defineConfig } from "vitest/config";

// Account tests: requests to the deployed Workers. The origins come from MINERVA_SITE_URL and
// MINERVA_DOWNLOAD_ORIGIN, in the environment or in ../.env.cloudflare.vars.
export default defineConfig({
	test: {
		include: ["test/account/**/*.test.ts"],
		// The test Worker's fault tests and code mode's lab have their own runs (vitest.faults.config.ts, vitest.cm.config.ts).
		exclude: ["test/account/faults.test.ts", "test/account/resets.test.ts", "test/account/sandbox.test.ts", "test/account/sandbox-faults.test.ts", "test/account/scripts.test.ts", "test/account/turns.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
