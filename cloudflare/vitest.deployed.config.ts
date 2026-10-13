import { defineConfig } from "vitest/config";

// Requests to a deployed instance of either kind (test/account/deployed.test.ts): `pnpm test:deployed --instance
// <name>` (scripts/suite.ts), which names it in MINERVA_INSTANCE (scripts/instance.ts). Its origins are in the
// instance's vars.env.
export default defineConfig({
	test: {
		include: ["test/account/deployed.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
