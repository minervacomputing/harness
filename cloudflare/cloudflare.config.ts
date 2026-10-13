import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as faultsEntrypoint from "./src/faults/index.ts" with { type: "cf-worker" };
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { parseFrom } from "./src/accounts/emails.ts";
import { checkBuild, connectorClientSecrets, parse, type SettingsEnv } from "./src/config.ts";
import { LOCAL_INSTANCES, type Names, namesOf, todaysInstance } from "./scripts/instance.ts";

// Plain settings are text bindings, read when the Worker is built and checked then with src/config.ts's
// parser, so a malformed value fails the build. Development and tests read the environment, with the
// defaults below. A production build (cf build, cf deploy) reads ../.env.cloudflare.vars alone, which is
// gitignored because it names the deployed origins: the shell's MINERVA_* are ignored there (the Django
// app uses the same names), the file must exist, both origins must be https, and MINERVA_DEBUG must be
// off. No build but the test build's accepts the fake model, which only its entry contains. Secrets never
// go here: they are in ../.env.cloudflare.

// Every name comes from scripts/instance.ts (`namesOf`): the Worker, the database, the AI Gateway, the buckets
// and the container application all follow the instance's name, and MINERVA_MODEL_GATEWAY is derived from it
// (a vars file that sets it is refused).

// The test instance (mode `faults`, `pnpm run deploy:test`) is the same code built from src/faults/index.ts,
// which adds a fake connector, its provider object, fault points and a token-gated driver for the account
// tests, with resources of its own and its settings from ../.env.cloudflare-test.vars, under the same rules as
// production's. The platform tests (mode `test`, under a local name, locally) run that entry too. Production
// builds src/index.ts, which imports nothing of src/faults/.

// Mode `offline` is the dev server's (`pnpm dev:offline`, cloudflare/README.md, Local development): the test
// build's entry (it has the fake model), debug on, no AI binding (Workers AI and the AI Gateway need an
// account) and the container only if Docker runs, under a local name (LOCAL_INSTANCES.offline). It exists only
// under `vite --mode offline`, which marks the process (vite.config.ts); `cf build` or `cf deploy` in that mode
// stops, so a local build cannot be deployed by accident. Any other mode (cf's default, which `cf workers
// types` uses, and `development`, which `pnpm startup` builds in) builds production's entry with the
// environment's settings under the platform tests' local name, which reaches no instance. `cf build` itself
// is mode `production`.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const here = (import.meta as unknown as { url: string }).url;

interface Target {
	names: Names;
	/** The settings file of a deployed build; null reads the environment. */
	vars: URL | null;
	/** The secrets file `cf deploy --secrets-file` uploads, for a deployed build; null reads the environment. */
	secrets: URL | null;
	faults: boolean;
	/** The dev server's mode `offline`: no AI binding, the container only if Docker runs, local defaults. */
	offline: boolean;
}

function targetFor(mode: string | undefined): Target {
	if (mode === "production") return { names: namesOf(todaysInstance(false)), vars: new URL("../.env.cloudflare.vars", here), secrets: new URL("../.env.cloudflare", here), faults: false, offline: false };
	if (mode === "faults") {
		return { names: namesOf(todaysInstance(true)), vars: new URL("../.env.cloudflare-test.vars", here), secrets: new URL("../.env.cloudflare-test", here), faults: true, offline: false };
	}
	if (mode === "offline") {
		// Only the dev server, which vite.config.ts marks: a build or deploy in this mode would carry the
		// fake model and the debug settings into an account.
		if (build.env.MINERVA_DEV_OFFLINE !== "1") throw new Error("Mode offline is the dev server's (pnpm dev:offline); it cannot be built or deployed.");
		return { names: namesOf(LOCAL_INSTANCES.offline), vars: null, secrets: null, faults: true, offline: true };
	}
	if (mode === "test") {
		// The platform tests' (vitest sets VITEST): the test build's entry under a local name, never an
		// instance's, so even a deploy in this mode could not put the fault code in one.
		if (build.env.VITEST !== "true") throw new Error("Mode test is the platform tests' (vitest); deploy the test build with mode faults.");
		return { names: namesOf(LOCAL_INSTANCES.test), vars: null, secrets: null, faults: true, offline: false };
	}
	return { names: namesOf(LOCAL_INSTANCES.test), vars: null, secrets: null, faults: false, offline: false };
}
interface BuildProcess {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:fs"): { readFileSync(path: URL, encoding: "utf8"): string };
	getBuiltinModule(id: "node:util"): { parseEnv(content: string): Record<string, string> };
	getBuiltinModule(id: "node:child_process"): { spawnSync(command: string, args: string[], options: { stdio: "ignore"; timeout: number }): { status: number | null } };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

/** The id of the dev server's local D1 database in mode `offline`: nothing in an account. */
const OFFLINE_D1_ID = "00000000-0000-4000-8000-00000000d1d1";

/** The settings with a default. MINERVA_MODEL_GATEWAY is not one: the build sets it to the instance's name. */
const DEFAULTS: Omit<SettingsEnv, "MINERVA_MODEL_GATEWAY"> = {
	MINERVA_SITE_URL: "http://localhost:5173",
	MINERVA_DOWNLOAD_ORIGIN: "http://localhost:8788",
	MINERVA_DEBUG: "false",
	MINERVA_SIGNUP_OPEN: "true",
	MINERVA_EMAIL_FROM: "Minerva <noreply@localhost>",
	MINERVA_RUN_TIMEOUT_SECONDS: "",
	MINERVA_MODEL_PROVIDER: "workers-ai",
	MINERVA_MODEL_NAME: "@cf/zai-org/glm-5.3-flash",
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

/**
 * What the dev server's mode `offline` sets besides DEFAULTS, unless the shell sets it: debug on (emails are
 * written to the log, cookies work over http), the fake model (the test build's entry has it), and a
 * fake model name for the settings parser.
 */
const OFFLINE_DEFAULTS: Partial<Omit<SettingsEnv, "MINERVA_MODEL_GATEWAY">> = {
	MINERVA_DEBUG: "true",
	MINERVA_MODEL_PROVIDER: "fake",
	MINERVA_MODEL_NAME: "fake-1",
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

/**
 * The connector clients the operator configured, declared so the deploy uploads them (src/config.ts
 * `connectorClientSecrets`): read by name from the deployed build's secrets file (a missing file declares
 * none; `pnpm run deploy` checks it first), or from the environment. Values are never read here.
 */
function connectorSecrets(target: Target) {
	let source: Record<string, string | undefined> = build.env;
	if (target.secrets) {
		try {
			source = build.getBuiltinModule("node:util").parseEnv(build.getBuiltinModule("node:fs").readFileSync(target.secrets, "utf8"));
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
			source = {};
		}
	}
	return Object.fromEntries(connectorClientSecrets(source).map((name) => [name, bindings.secret()]));
}

function settingsFor(target: Target): SettingsEnv {
	const source = target.vars ? deployedVars(target.vars) : build.env;
	// The gateway is the instance's own, whatever a file or the shell says: a vars file that sets it is a
	// mistake that would send the model's requests through another gateway, so it stops the build.
	if (target.vars && source.MINERVA_MODEL_GATEWAY !== undefined) {
		throw new Error(`MINERVA_MODEL_GATEWAY is not a setting: the build sets it to the instance's name. Remove it from ../${target.vars.pathname.split("/").pop()}.`);
	}
	const defaults = target.offline ? { ...DEFAULTS, ...OFFLINE_DEFAULTS } : DEFAULTS;
	const settings = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, source[name] ?? fallback]));
	const values = { ...settings, MINERVA_MODEL_GATEWAY: target.names.gateway } as unknown as SettingsEnv;
	const parsed = parse(values);
	checkBuild(parsed, { deployed: target.vars !== null, testBuild: target.faults });
	return values;
}

/**
 * The sandbox's Container application (plan: The sandbox lifecycle): the image in container/, started by the
 * Sandbox Durable Object (`durable_object` scheduling), which picks the instance, starts it with no route out
 * and passes it nothing secret. Its name follows the instance's (scripts/instance.ts), so every instance has an
 * application of its own. The platform tests run in local workerd, which has no containers: there the class has
 * none, and a start says so.
 */
function sandboxContainer(target: Target) {
	return defineContainer({
		name: target.names.container,
		schedulingPolicy: "durable-object",
		images: { base: { dockerfile: "./container/Dockerfile" } },
		observability: { enabled: true, logs: { enabled: true } },
	});
}

/** Whether Docker answers, which the dev server needs to run the sandbox's container. */
function dockerRuns(): boolean {
	return build.getBuiltinModule("node:child_process").spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

export default defineConfig(({ mode }) => {
	const target = targetFor(mode);
	const values = settingsFor(target);
	const setting = (name: keyof SettingsEnv) => bindings.text(values[name]);
	// The platform tests run in local workerd, which has no containers. The dev server in mode offline has the
	// container when Docker runs; without it the Sandbox class has none, and a tool that needs it says so.
	const docker = target.offline ? dockerRuns() : false;
	if (target.offline && !docker) console.warn("Docker is not running: the sandbox has no container, so tools that need it will fail. Start Docker and restart the dev server for them.");
	const container = mode === "test" || (target.offline && !docker) ? null : sandboxContainer(target);
	return {
		...(container ? { containers: [container] } : {}),
		worker: {
			name: target.names.app,
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
				// The dev server's database has an id of its own, only so that `cf d1 migrations apply --local` can name it.
				DB: bindings.d1({ name: target.names.d1, ...(target.offline ? { id: OFFLINE_D1_ID } : {}) }),
				// An EU workspace's files stay in a bucket in R2's EU jurisdiction (src/addressing.ts).
				FILES: bindings.r2({ name: target.names.bucket }),
				FILES_EU: bindings.r2({ name: target.names.bucketEu, jurisdiction: "eu" }),
				// Workers AI has no local simulation: in local dev it is the account's, and the tests leave it off.
				// Mode offline has none at all: it runs the fake model and needs no account.
				...(target.offline ? {} : { AI: bindings.ai({ dev: { remote: true } }) }),
				LOADER: bindings.workerLoader(),
				WORKSPACE: bindings.durableObject({ worker: target.names.app, exportName: "Workspace" }),
				CONVERSATION: bindings.durableObject({ worker: target.names.app, exportName: "Conversation" }),
				SCRIPTS: bindings.durableObject({ worker: target.names.app, exportName: "Scripts" }),
				// The test build's fake provider (src/faults/provider.ts) and the mailbox that keeps its emails (mailbox.ts).
				...(target.faults
					? {
							FAULT_PROVIDER: bindings.durableObject({ worker: target.names.app, exportName: "FaultProvider" }),
							FAULT_MAILBOX: bindings.durableObject({ worker: target.names.app, exportName: "FaultMailbox" }),
						}
					: {}),
				// Sign-up and sign-in codes (src/accounts/emails.ts), sent from MINERVA_EMAIL_FROM's address only. The
				// test build has none: its emails go to its mailbox, or to the log in the platform tests (debug on).
				...(target.faults ? {} : { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [parseFrom(values.MINERVA_EMAIL_FROM).email] }) }),
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
				// keys (MINERVA_MODEL_API_KEY, MINERVA_BRAVE_SEARCH_API_KEY) join this list in the steps that use
				// them; until then they are commented-out placeholders in that file. MINERVA_SETUP_KEY claims the
				// instance's first admin, once (src/accounts/instance.ts).
				MINERVA_SECRET_KEY: bindings.secret(),
				MINERVA_ENCRYPTION_KEYS: bindings.secret(),
				MINERVA_DOWNLOAD_KEY: bindings.secret(),
				MINERVA_SETUP_KEY: bindings.secret(),
				// Connector clients (MINERVA_<APP>_CLIENT_ID and _SECRET), only those the operator set: an unset
				// one hides its connectors, as today.
				...connectorSecrets(target),
			},
			exports: {
				Workspace: exports.durableObject({ storage: "sqlite" }),
				Conversation: exports.durableObject({ storage: "sqlite" }),
				Scripts: exports.durableObject({ storage: "sqlite" }),
				Sandbox: container ? exports.durableObject({ storage: "sqlite", container }) : exports.durableObject({ storage: "sqlite" }),
				...(target.faults ? { FaultProvider: exports.durableObject({ storage: "sqlite" }), FaultMailbox: exports.durableObject({ storage: "sqlite" }) } : {}),
			},
		},
	};
});
