import { defineConfig } from "vitest/config";

// Account tests: requests to the deployed Workers. The origins come from MINERVA_SITE_URL and
// MINERVA_DOWNLOAD_ORIGIN, in the environment or in ../.env.cloudflare.vars.
export default defineConfig({
	test: {
		include: ["test/account/**/*.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
