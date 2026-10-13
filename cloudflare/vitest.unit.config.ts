import { defineConfig } from "vitest/config";

// Unit tests: plain TypeScript in Node (lib/, http/ helpers, settings).
export default defineConfig({
	// @cloudflare/sandbox imports `cloudflare:workers`, which Node does not have: it is bundled with a stub.
	resolve: { alias: { "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname } },
	test: {
		server: { deps: { inline: ["@cloudflare/sandbox"] } },
		include: ["test/unit/**/*.test.ts"],
		environment: "node",
	},
});
