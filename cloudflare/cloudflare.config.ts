import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { parse, type SettingsEnv } from "./src/config.ts";

const NAME = "minerva-cf";

// Plain settings are text bindings, read when the Worker is built and checked then with src/config.ts's
// parser, so a malformed value fails the build. Development and tests read the environment, with the
// defaults below. A production build (cf build, cf deploy) reads ../.env.cloudflare.vars alone, which is
// gitignored because it names the deployed origins: the shell's MINERVA_* are ignored there (the Django
// app uses the same names), the file must exist, both origins must be https, and MINERVA_DEBUG must be
// off. Secrets never go here: they are in ../.env.cloudflare.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const VARS = new URL("../.env.cloudflare.vars", (import.meta as unknown as { url: string }).url);
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

/** The production build's settings: ../.env.cloudflare.vars and nothing else. */
function productionVars(): Record<string, string | undefined> {
	let text: string;
	try {
		text = build.getBuiltinModule("node:fs").readFileSync(VARS, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
		throw new Error("A production build reads its settings from ../.env.cloudflare.vars, which is missing (cloudflare/README.md).");
	}
	return build.getBuiltinModule("node:util").parseEnv(text);
}

function settingsFor(mode: string | undefined): SettingsEnv {
	const source = mode === "production" ? productionVars() : build.env;
	const values = Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => [name, source[name] ?? fallback])) as unknown as SettingsEnv;
	const parsed = parse(values);
	if (mode === "production") {
		if (!parsed.siteUrl.startsWith("https://") || !parsed.downloadOrigin.startsWith("https://")) {
			throw new Error("MINERVA_SITE_URL and MINERVA_DOWNLOAD_ORIGIN must be https origins in .env.cloudflare.vars.");
		}
		if (parsed.debug) throw new Error("MINERVA_DEBUG must be off in a production build.");
	}
	return values;
}

export default defineConfig(({ mode }) => {
	const values = settingsFor(mode);
	const setting = (name: keyof SettingsEnv) => bindings.text(values[name]);
	return {
		worker: {
			name: NAME,
			compatibilityDate: "2026-10-06",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
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
				DB: bindings.d1({ name: "minerva-cf" }),
				// An EU workspace's files stay in a bucket in R2's EU jurisdiction (src/addressing.ts).
				FILES: bindings.r2({ name: "minerva-cf-files" }),
				FILES_EU: bindings.r2({ name: "minerva-cf-files-eu", jurisdiction: "eu" }),
				// Workers AI has no local simulation: in local dev it is the account's, and the tests leave it off.
				AI: bindings.ai({ dev: { remote: true } }),
				LOADER: bindings.workerLoader(),
				WORKSPACE: bindings.durableObject({ worker: NAME, exportName: "Workspace" }),
				CONVERSATION: bindings.durableObject({ worker: NAME, exportName: "Conversation" }),
				SCRIPTS: bindings.durableObject({ worker: NAME, exportName: "Scripts" }),
				// The Sandbox class gets its container in step 3; a container class cannot be bound by its own
				// Worker's name, so it is reached through ctx.exports.Sandbox instead of a binding.

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
				Sandbox: exports.durableObject({ storage: "sqlite" }),
				ScriptHost: exports.worker(),
			},
		},
	};
});
