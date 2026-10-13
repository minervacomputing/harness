import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Platform tests: the Worker from cloudflare.config.ts in local workerd (Miniflare), with its Durable
// Objects, D1 and R2 simulated locally. Remote bindings stay off, so nothing reaches the account.
process.env.MINERVA_DEBUG ??= "true";
process.env.MINERVA_SITE_URL ??= "http://localhost";
// Throwaway values for local runs; a deployed instance's secrets are in its secrets.env (scripts/instance.ts).
process.env.MINERVA_SECRET_KEY ??= "test-secret-key-for-local-platform-tests-only";
process.env.MINERVA_ENCRYPTION_KEYS ??= "v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
process.env.MINERVA_DOWNLOAD_KEY ??= "test-download-key-for-local-platform-tests-only";
process.env.MINERVA_SETUP_KEY ??= "test-setup-key-for-local-platform-tests-only";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("migrations");
	return {
		// The frontend's `@/` imports, for test/platform/frontend-auth.test.ts, which runs its auth client.
		resolve: { alias: [{ find: /^@\//, replacement: `${fileURLToPath(new URL("../frontend/src/", import.meta.url))}` }] },
		plugins: [
			cloudflareTest({
				experimental: { newConfig: true },
				remoteBindings: false,
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
					// Empty databases the schema tests migrate themselves (test/platform/accounts-schema.test.ts).
					d1Databases: ["UPGRADE_DB", "UPGRADE_TWO_FACTOR_DB", "UPGRADE_PLAIN_DB", "UPGRADE_VERIFICATION_DB"],
					// cloudflare.config.ts binds the Worker's own classes by its name; the tests run it under
					// another name, so the bindings name the classes alone.
					durableObjects: {
						WORKSPACE: { className: "Workspace", useSQLite: true },
						CONVERSATION: { className: "Conversation", useSQLite: true },
						SCRIPTS: { className: "Scripts", useSQLite: true },
						// Mode `test` builds the test Worker's entry (src/faults/index.ts), with its fake provider.
						FAULT_PROVIDER: { className: "FaultProvider", useSQLite: true },
						FAULT_MAILBOX: { className: "FaultMailbox", useSQLite: true },
					},
				},
			}),
		],
		test: {
			include: ["test/platform/**/*.test.ts"],
			setupFiles: ["test/platform/setup.ts"],
			// A fault's `ctx.abort()` inside a DurableObject's RPC leaves the reset's own rejection unhandled in
			// the isolate the tests share with the objects (src/faults/plan.ts); only those are ignored.
			onUnhandledError: (error: unknown) => !(String((error as { message?: unknown }).message).startsWith("fault: ") && (error as { durableObjectReset?: unknown }).durableObjectReset === true),
		},
	};
});
