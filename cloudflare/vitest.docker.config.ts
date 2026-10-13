import { defineConfig } from "vitest/config";

// Docker tests: the Sandbox against the real image (`pnpm sandbox:image`) in a local container. They
// skip when Docker or the image is missing.
export default defineConfig({
	test: {
		include: ["test/docker/**/*.test.ts"],
		environment: "node",
	},
});
