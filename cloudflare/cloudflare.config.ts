import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as faultsEntrypoint from "./src/faults/index.ts" with { type: "cf-worker" };
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { checkBuild, parse, type SettingsEnv } from "./src/config.ts";

const NAME = "minerva-cf";

// Plain settings are text bindings, read when the Worker is built and checked then with src/config.ts's
// parser, so a malformed value fails the build. Development and tests read the environment, with the
// defaults below. A production build (cf build, cf deploy) reads ../.env.cloudflare.vars alone, which is
// gitignored because it names the deployed origins: the shell's MINERVA_* are ignored there (the Django
// app uses the same names), the file must exist, both origins must be https, and MINERVA_DEBUG must be
// off. No build but the test build's accepts the fake model, which only its entry contains. Secrets never
// go here: they are in ../.env.cloudflare.

// The test Worker (mode `faults`, `pnpm run deploy:test`) is minerva-cf-test: the same code built from
// src/faults/index.ts, which adds a fake connector, its provider object, fault points and a token-gated
// driver for the account tests, with resources of its own (minerva-cf-test-*) and its settings from
// ../.env.cloudflare-test.vars, under the same rules as production's. The platform tests (mode `test`, under
// names of their own, locally) run that entry too. Production builds src/index.ts, which imports nothing of
// src/faults/.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const here = (import.meta as unknown as { url: string }).url;

interface Target {
	name: string;
	d1: string;
	files: string;
	filesEu: string;
	/** The settings file of a deployed build; null reads the environment. */
	vars: URL | null;
	faults: boolean;
}

function targetFor(mode: string | undefined): Target {
	const own = { name: NAME, d1: "minerva-cf", files: "minerva-cf-files", filesEu: "minerva-cf-files-eu" };
	if (mode === "production") return { ...own, vars: new URL("../.env.cloudflare.vars", here), faults: false };
	if (mode === "faults") {
		return {
			name: "minerva-cf-test",
			d1: "minerva-cf-test",
			files: "minerva-cf-test-files",
			filesEu: "minerva-cf-test-files-eu",
			vars: new URL("../.env.cloudflare-test.vars", here),
			faults: true,
		};
	}
	if (mode === "test") {
		// The platform tests' (vitest sets VITEST): the test build's entry under names of its own, never
		// production's, so even a deploy in this mode could not put the fault code in minerva-cf.
		if (build.env.VITEST !== "true") throw new Error("Mode test is the platform tests' (vitest); deploy the test build with mode faults.");
		const local = "minerva-cf-local";
		return { name: local, d1: local, files: `${local}-files`, filesEu: `${local}-files-eu`, vars: null, faults: true };
	}
	return { ...own, vars: null, faults: false };
}
interface BuildProcess {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:fs"): { readFileSync(path: URL, encoding: "utf8"): string };
	getBuiltinModule(id: "node:util"): { parseEnv(content: string): Record<string, string> };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

const DEFAULTS: SettingsEnv = {
	MINERVA_SITE_URL: "http://localhost:5173",
	MINERVA_DOWNLOAD_ORIGIN: "http://localhost:8788",
	MINERVA_DEBUG: "false",
	MINERVA_SIGNUP_OPEN: "true",
	MINERVA_EMAIL_FROM: "Minerva <noreply@localhost>",
	MINERVA_RUN_TIMEOUT_SECONDS: "",
	MINERVA_MODEL_PROVIDER: "workers-ai",
	MINERVA_MODEL_NAME: "@cf/zai-org/glm-5.3-flash",
	MINERVA_MODEL_GATEWAY: "minerva-cf",
	MINERVA_MODEL_API: "chat",
	MINERVA_MODEL_MAX_OUTPUT_TOKENS: "8192",
	MINERVA_MODEL_REASONING_EFFORT: "",
	MINERVA_MODEL_REASONING_SUMMARY: "",
	MINERVA_FILES_FOLDER_BYTES: "268435456",
	MINERVA_FILES_FOLDER_ENTRIES: "10000",
	MINERVA_FILES_RUN_UPLOAD_BYTES: "",
	MINERVA_FILES_WORKSPACE_BYTES: "",
	MINERVA_FILES_UPLOAD_BYTES: "52428800",
	MINERVA_FILES_MESSAGE_ATTACHMENTS: "10",
};

/** A deployed build's settings: its vars file and nothing else. */
function deployedVars(file: URL): Record<string, string | undefined> {
	const name = file.pathname.split("/").pop();
	let text: string;
	try {
		text = build.getBuiltinModule("node:fs").readFileSync(file, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
		throw new Error(`A deployed build reads its settings from ../${name}, which is missing (cloudflare/README.md).`);
	}
	return build.getBuiltinModule("node:util").parseEnv(text);
}

function settingsFor(target: Target): SettingsEnv {
	const source = target.vars ? deployedVars(target.vars) : build.env;
	const values = Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => [name, source[name] ?? fallback])) as unknown as SettingsEnv;
	const parsed = parse(values);
	checkBuild(parsed, { deployed: target.vars !== null, testBuild: target.faults });
	return values;
}

/**
 * The sandbox's Container application (plan: The sandbox lifecycle): the image in container/, started by the
 * Sandbox Durable Object (`durable_object` scheduling), which picks the instance, starts it with no route out
 * and passes it nothing secret. Its name follows the Worker's, so the test Worker has an application of its
 * own. The platform tests run in local workerd, which has no containers: there the class has none, and a
 * start says so.
 */
function sandboxContainer(target: Target) {
	return defineContainer({
		name: `${target.name}-sandbox`,
		schedulingPolicy: "durable-object",
		images: { base: { dockerfile: "./container/Dockerfile" } },
		observability: { enabled: true, logs: { enabled: true } },
	});
}

export default defineConfig(({ mode }) => {
	const target = targetFor(mode);
	const values = settingsFor(target);
	const setting = (name: keyof SettingsEnv) => bindings.text(values[name]);
	const container = mode === "test" ? null : sandboxContainer(target);
	return {
		...(container ? { containers: [container] } : {}),
		worker: {
			name: target.name,
			compatibilityDate: "2026-10-06",
			compatibilityFlags: ["nodejs_compat"],
			// One module type for the Env cf infers: both entries export the same classes.
			entrypoint: target.faults ? (faultsEntrypoint as unknown as typeof entrypoint) : entrypoint,
			// workers.dev, but no preview URLs: every uploaded version would stay reachable at an origin of
			// its own, with the bindings and secrets of its day, and versions cannot be deleted.
			workersDev: true,
			previewUrls: false,
			// The frontend is served as static assets; the Worker runs first for the API and for /assets/,
			// where a missing file must be a 404 rather than the app shell (src/http/assets.ts).
			assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "/assets/*"] },
			// Upload names and download links travel in query strings; keep them out of the logs.
			observability: { enabled: true, redactQueryString: true },
			env: {
				ASSETS: bindings.assets(),
				DB: bindings.d1({ name: target.d1 }),
				// An EU workspace's files stay in a bucket in R2's EU jurisdiction (src/addressing.ts).
				FILES: bindings.r2({ name: target.files }),
				FILES_EU: bindings.r2({ name: target.filesEu, jurisdiction: "eu" }),
				// Workers AI has no local simulation: in local dev it is the account's, and the tests leave it off.
				AI: bindings.ai({ dev: { remote: true } }),
				LOADER: bindings.workerLoader(),
				WORKSPACE: bindings.durableObject({ worker: target.name, exportName: "Workspace" }),
				CONVERSATION: bindings.durableObject({ worker: target.name, exportName: "Conversation" }),
				SCRIPTS: bindings.durableObject({ worker: target.name, exportName: "Scripts" }),
				// The test build's fake provider (src/faults/provider.ts).
				...(target.faults ? { FAULT_PROVIDER: bindings.durableObject({ worker: target.name, exportName: "FaultProvider" }) } : {}),
				// A container class cannot be bound by its own Worker's name, so the Sandbox is reached through
				// ctx.exports.Sandbox instead of a binding (src/addressing.ts).

				MINERVA_SITE_URL: setting("MINERVA_SITE_URL"),
				MINERVA_DOWNLOAD_ORIGIN: setting("MINERVA_DOWNLOAD_ORIGIN"),
				MINERVA_DEBUG: setting("MINERVA_DEBUG"),
				MINERVA_SIGNUP_OPEN: setting("MINERVA_SIGNUP_OPEN"),
				MINERVA_EMAIL_FROM: setting("MINERVA_EMAIL_FROM"),
				MINERVA_RUN_TIMEOUT_SECONDS: setting("MINERVA_RUN_TIMEOUT_SECONDS"),

				MINERVA_MODEL_PROVIDER: setting("MINERVA_MODEL_PROVIDER"),
				MINERVA_MODEL_NAME: setting("MINERVA_MODEL_NAME"),
				MINERVA_MODEL_GATEWAY: setting("MINERVA_MODEL_GATEWAY"),
				MINERVA_MODEL_API: setting("MINERVA_MODEL_API"),
				MINERVA_MODEL_MAX_OUTPUT_TOKENS: setting("MINERVA_MODEL_MAX_OUTPUT_TOKENS"),
				MINERVA_MODEL_REASONING_EFFORT: setting("MINERVA_MODEL_REASONING_EFFORT"),
				MINERVA_MODEL_REASONING_SUMMARY: setting("MINERVA_MODEL_REASONING_SUMMARY"),

				MINERVA_FILES_FOLDER_BYTES: setting("MINERVA_FILES_FOLDER_BYTES"),
				MINERVA_FILES_FOLDER_ENTRIES: setting("MINERVA_FILES_FOLDER_ENTRIES"),
				MINERVA_FILES_RUN_UPLOAD_BYTES: setting("MINERVA_FILES_RUN_UPLOAD_BYTES"),
				MINERVA_FILES_WORKSPACE_BYTES: setting("MINERVA_FILES_WORKSPACE_BYTES"),
				MINERVA_FILES_UPLOAD_BYTES: setting("MINERVA_FILES_UPLOAD_BYTES"),
				MINERVA_FILES_MESSAGE_ATTACHMENTS: setting("MINERVA_FILES_MESSAGE_ATTACHMENTS"),

				// Uploaded from ../.env.cloudflare by `pnpm run deploy`. A declared secret is required, so model
				// keys and connector clients (MINERVA_MODEL_API_KEY, MINERVA_BRAVE_SEARCH_API_KEY,
				// MINERVA_<APP>_CLIENT_ID and _SECRET) join this list in the steps that use them; until then they
				// are commented-out placeholders in that file.
				MINERVA_SECRET_KEY: bindings.secret(),
				MINERVA_ENCRYPTION_KEYS: bindings.secret(),
				MINERVA_DOWNLOAD_KEY: bindings.secret(),
			},
			exports: {
				Workspace: exports.durableObject({ storage: "sqlite" }),
				Conversation: exports.durableObject({ storage: "sqlite" }),
				Scripts: exports.durableObject({ storage: "sqlite" }),
				Sandbox: container ? exports.durableObject({ storage: "sqlite", container }) : exports.durableObject({ storage: "sqlite" }),
				...(target.faults ? { FaultProvider: exports.durableObject({ storage: "sqlite" }) } : {}),
			},
		},
	};
});
