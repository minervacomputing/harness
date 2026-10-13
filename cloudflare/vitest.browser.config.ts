import { defineConfig } from "vitest/config";

// The browser walk (test/account/browser.test.ts) on a test instance: `pnpm test:browser` (scripts/suite.ts), with
// the instance in MINERVA_INSTANCE or the only test instance (scripts/instance.ts).
export default defineConfig({
	test: {
		include: ["test/account/browser.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
