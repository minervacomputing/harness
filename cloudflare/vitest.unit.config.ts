import { defineConfig } from "vitest/config";

// Unit tests: plain TypeScript in Node (lib/, http/ helpers, settings, contracts' types).
export default defineConfig({
	test: {
		include: ["test/unit/**/*.test.ts"],
		environment: "node",
	},
});
