import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { FAULTS_SETTINGS } from "./src/faults/settings.ts";

// Platform tests: the Worker from cloudflare.config.ts in local workerd (Miniflare), with its Durable
// Objects, D1 and R2 simulated locally. Remote bindings stay off, so nothing reaches the account.
process.env.MINERVA_DEBUG ??= "true";
process.env.MINERVA_SITE_URL ??= "http://localhost";
// Throwaway values for local runs; a deployed instance's secrets are in its secrets.env (scripts/instance.ts).
process.env.MINERVA_SECRET_KEY ??= "test-secret-key-for-local-platform-tests-only";
process.env.MINERVA_ENCRYPTION_KEYS ??= "v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
process.env.MINERVA_DOWNLOAD_KEY ??= "test-download-key-for-local-platform-tests-only";
process.env.MINERVA_SETUP_KEY ??= "test-setup-key-for-local-platform-tests-only";
// The internal API (test/platform/internal.test.ts signs its own Access assertions) and the fake Laravel's origin, the one
// the test build hosts (src/faults/laravel.ts); the in-memory fakes the tests install answer any. Its token is the test's
// own: a secret's value comes from .dev.vars where that file exists, so the tests do not rely on one.
process.env.MINERVA_ENVIRONMENT ??= "test";
process.env.MINERVA_ACCESS_ISSUER ??= "https://test.cloudflareaccess.example";
process.env.MINERVA_ACCESS_AUDIENCE ??= "test-audience";
process.env.MINERVA_ACCESS_CLIENTS ??= "laravel-old.access,laravel.access";
process.env.MINERVA_LARAVEL_URL ??= FAULTS_SETTINGS.MINERVA_LARAVEL_URL;

export default defineConfig(async () => {
	const migrations = await readD1Migrations("migrations");
	return {
		plugins: [
			cloudflareTest({
				experimental: { newConfig: true },
				remoteBindings: false,
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
					// cloudflare.config.ts binds the Worker's own classes by its name; the tests run it under
					// another name, so the bindings name the classes alone.
					durableObjects: {
						CONVERSATION: { className: "Conversation", useSQLite: true },
						SCRIPTS: { className: "Scripts", useSQLite: true },
						// Mode `test` builds the test Worker's entry (src/faults/index.ts), with its fake provider.
						FAULT_PROVIDER: { className: "FaultProvider", useSQLite: true },
					},
				},
			}),
		],
		test: {
			include: ["test/platform/**/*.test.ts"],
			// The Worker runs whole turns in these tests: a test that takes 2 s on a laptop takes
			// over 5 s on CI's two cores, so the default timeout is too short.
			testTimeout: 30_000,
			setupFiles: ["test/platform/setup.ts"],
			// A fault's `ctx.abort()` inside a DurableObject's RPC leaves the reset's own rejection unhandled in
			// the isolate the tests share with the objects (src/faults/plan.ts); only those are ignored.
			onUnhandledError: (error: unknown) => !(String((error as { message?: unknown }).message).startsWith("fault: ") && (error as { durableObjectReset?: unknown }).durableObjectReset === true),
		},
	};
});
