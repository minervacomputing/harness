import { defineConfig } from "vitest/config";

// Docker tests: the Sandbox against the real image (`pnpm sandbox:image`) in a local container. They
// skip when Docker or the image is missing.
export default defineConfig({
	// @cloudflare/sandbox imports `cloudflare:workers`, which Node does not have: it is bundled with a stub.
	resolve: { alias: { "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname } },
	test: {
		server: { deps: { inline: ["@cloudflare/sandbox"] } },
		include: ["test/docker/**/*.test.ts"],
		environment: "node",
	},
});
