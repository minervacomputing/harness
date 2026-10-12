import { defineConfig } from "vitest/config";

// Code mode on the account: the lab Worker minerva-cf-cm (test/account/scripts-worker/), deployed with
// `pnpm run deploy:cm` while these run and deleted after (cloudflare/README.md, Code mode).
export default defineConfig({
	test: {
		include: ["test/account/scripts.test.ts"],
		environment: "node",
		testTimeout: 180_000,
	},
});
