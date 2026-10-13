import { defineConfig } from "vitest/config";

// Code mode on the account: a test instance's lab Worker (test/account/scripts-worker/), deployed with
// `pnpm run deploy:cm` while these run and deleted after (cloudflare/README.md, Code mode's lab). `pnpm test:cm`
// runs scripts/suite.ts, which names the instance in MINERVA_INSTANCE, or it is the only test instance.
export default defineConfig({
	test: {
		include: ["test/account/scripts.test.ts"],
		environment: "node",
		testTimeout: 180_000,
	},
});
