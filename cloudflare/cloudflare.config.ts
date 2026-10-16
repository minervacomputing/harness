import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as faultsEntrypoint from "./src/faults/index.ts" with { type: "cf-worker" };
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { parseFrom } from "./src/accounts/emails.ts";
import { checkBuild, connectorClientSecrets, parse, type SettingsEnv } from "./src/config.ts";
import { buildSettings } from "./scripts/build-settings.ts";
import { type Instance, LOCAL_INSTANCES, type Names, SANDBOX_IMAGE_REFERENCE, chooseInstance, instanceForMode, instanceVars, namesOf, readInstanceEnv } from "./scripts/instance.ts";
import { instanceOrigins } from "./scripts/origins.ts";

// Plain settings are text bindings, read when the Worker is built and checked then with src/config.ts's
// parser, so a malformed value fails the build. Development and tests read the environment, with the
// defaults of scripts/build-settings.ts. A deployed build (mode production or faults) reads its instance's vars.env alone
// (scripts/instance.ts, The instance directory, outside the checkout): the shell's MINERVA_* are ignored there
// (a shell may hold another deployment's), the file must exist, and MINERVA_DEBUG must be off. Both origins must be the
// instance's own Workers on workers.dev, `https://<name>.<subdomain>.workers.dev` and
// `https://<name>-files.<subdomain>.workers.dev`, on one subdomain (scripts/origins.ts), which scripts/deploy.ts
// then compares with the account's. No build but the test build's accepts the fake model, which only its entry
// contains. Secrets never go here: they are in the instance's secrets.env.

// Every name comes from scripts/instance.ts: the instance a build is for (`instanceForMode`: MINERVA_INSTANCE,
// which the deploy scripts set, or for mode faults the only test instance), and through it the Worker, the
// database, the AI Gateway, the buckets and the container application (`namesOf`). MINERVA_MODEL_GATEWAY is
// derived from the name (a vars file that sets it is refused).

// Mode `production` builds a production instance, which is never chosen by default. Mode `faults` builds a test
// instance (`pnpm run deploy:test`): the same code built from src/faults/index.ts, which adds a fake connector,
// its provider object, fault points and a token-gated driver for the account tests, with resources of its own,
// under the same rules as production's. A mode that disagrees with the instance's kind stops the build. The
// platform tests (mode `test`, under a local name, locally) run that entry too. Production builds
// src/index.ts, which imports nothing of src/faults/.

// Mode `offline` is the dev server's (`pnpm dev:offline`, cloudflare/README.md, Local development): the test
// build's entry (it has the fake model), debug on, no AI binding (Workers AI and the AI Gateway need an
// account) and the container only if Docker runs, under a local name (LOCAL_INSTANCES.offline). It exists only
// under `vite --mode offline`, which marks the process (vite.config.ts); `cf build` or `cf deploy` in that mode
// stops, so a local build cannot be deployed by accident. Mode `development` is vite's own dev server
// (`pnpm exec vite`), which reaches the account's Workers AI and AI Gateway as remote bindings: production's
// entry under the local name, with a test instance's gateway (MINERVA_INSTANCE, or the only test instance).
// Any other mode (`standalone`, which `pnpm build` and `pnpm startup` build in, and the mode of `cf workers
// types`, which has none) builds production's entry with the environment's settings under the platform tests'
// local name, which reaches no instance. (Vite reserves the mode name `local`.) `cf build` without a mode is
// mode `production`, so it needs an instance.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
interface Target {
	names: Names;
	/** The instance a deployed build is for, whose vars.env and secrets.env it reads; null reads the environment. */
	instance: Instance | null;
	faults: boolean;
	/** The dev server's mode `offline`: no AI binding, the container only if Docker runs, local defaults. */
	offline: boolean;
}

function targetFor(mode: string | undefined): Target {
	if (mode === "production" || mode === "faults") {
		const instance = instanceForMode(mode);
		return { names: instance.names, instance, faults: instance.test, offline: false };
	}
	if (mode === "offline") {
		// Only the dev server, which vite.config.ts marks: a build or deploy in this mode would carry the
		// fake model and the debug settings into an account.
		if (build.env.MINERVA_DEV_OFFLINE !== "1") throw new Error("Mode offline is the dev server's (pnpm dev:offline); it cannot be built or deployed.");
		return { names: namesOf(LOCAL_INSTANCES.offline), instance: null, faults: true, offline: true };
	}
	if (mode === "test") {
		// The platform tests' (vitest sets VITEST): the test build's entry under a local name, never an
		// instance's, so even a deploy in this mode could not put the fault code in one.
		if (build.env.VITEST !== "true") throw new Error("Mode test is the platform tests' (vitest); deploy the test build with mode faults.");
		return { names: namesOf(LOCAL_INSTANCES.test), instance: null, faults: true, offline: false };
	}
	if (mode === "development") {
		// Its model turns go through the account's AI Gateway, which only an instance has: a test instance's,
		// never production's. Everything else stays local, under the local name.
		const gateway = chooseInstance({ test: true }).names.gateway;
		return { names: { ...namesOf(LOCAL_INSTANCES.test), gateway }, instance: null, faults: false, offline: false };
	}
	return { names: namesOf(LOCAL_INSTANCES.test), instance: null, faults: false, offline: false };
}
interface BuildProcess {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:child_process"): { spawnSync(command: string, args: string[], options: { stdio: "ignore"; timeout: number }): { status: number | null } };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

/** The id of the dev server's local D1 database in mode `offline`: nothing in an account. */
const OFFLINE_D1_ID = "00000000-0000-4000-8000-00000000d1d1";

/**
 * The connector clients the operator configured, declared so the deploy uploads them (src/config.ts
 * `connectorClientSecrets`): read by name from the deployed build's instance's secrets.env (a missing file
 * declares none; `pnpm run deploy` checks it first), or from the environment. Values are never used here.
 */
function connectorSecrets(target: Target) {
	const source: Record<string, string | undefined> = target.instance ? (readInstanceEnv(target.instance, "secrets") ?? {}) : build.env;
	return Object.fromEntries(connectorClientSecrets(source).map((name) => [name, bindings.secret()]));
}

/**
 * Laravel's secrets, each declared only where it is set, as the connector clients are: an engine that does not work with
 * Laravel yet needs none. MINERVA_LARAVEL_TOKEN is the Sanctum token the engine calls Laravel with (src/laravel/client.ts);
 * MINERVA_STREAM_KEYS, the keys of the stream tokens Laravel signs (src/stream/token.ts).
 */
function laravelSecrets(target: Target) {
	const source: Record<string, string | undefined> = target.instance ? (readInstanceEnv(target.instance, "secrets") ?? {}) : build.env;
	// One shape whether they are set or not, as `connectorSecrets` has: a union would break the inferred Env.
	const names = ["MINERVA_LARAVEL_TOKEN", "MINERVA_STREAM_KEYS"].filter((name) => source[name]?.trim());
	return Object.fromEntries(names.map((name) => [name, bindings.secret()]));
}

function settingsFor(target: Target): SettingsEnv {
	// The gateway is the instance's own, whatever the shell says; a vars file that sets it stops the build
	// (`instanceVars`), since it would send the model's requests through another gateway.
	const source: Record<string, string | undefined> = target.instance ? instanceVars(target.instance) : build.env;
	const values = buildSettings({ deployed: target.instance !== null, faults: target.faults, offline: target.offline }, source, target.names.gateway);
	const parsed = parse(values);
	checkBuild(parsed, { deployed: target.instance !== null, testBuild: target.faults });
	if (target.instance) {
		const where = `in ${target.instance.files.vars}`;
		instanceOrigins(values.MINERVA_SITE_URL, values.MINERVA_DOWNLOAD_ORIGIN, { site: `MINERVA_SITE_URL ${where}`, download: `MINERVA_DOWNLOAD_ORIGIN ${where}` }, target.names);
	}
	return values;
}

/**
 * The sandbox's Container application (ARCHITECTURE.md: The sandbox lifecycle): the image in container/, started by the
 * Sandbox Durable Object (`durable_object` scheduling), which picks the instance, starts it with no route out
 * and passes it nothing secret. Its name follows the instance's (scripts/instance.ts), so every instance has an
 * application of its own. The platform tests run in local workerd, which has no containers: there the class has
 * none, and a start says so.
 *
 * A deploy (scripts/deploy.ts) passes the image already in the account's registry in MINERVA_SANDBOX_IMAGE
 * (scripts/image.ts, cloudflare/README.md: The sandbox image), so that the build skips Docker and an unchanged
 * container/ keeps its image. Only a deployed build reads it; every other build, and a deployed one without it
 * (a reset's, a --files-only deploy's, which upload no image), builds container/Dockerfile locally.
 */
function sandboxContainer(target: Target) {
	const reference = target.instance ? build.env.MINERVA_SANDBOX_IMAGE : undefined;
	if (reference && !SANDBOX_IMAGE_REFERENCE.test(reference)) throw new Error(`MINERVA_SANDBOX_IMAGE is not a sandbox image reference (scripts/image.ts): ${reference}`);
	return defineContainer({
		name: target.names.container,
		schedulingPolicy: "durable-object",
		images: { base: reference ? { reference } : { dockerfile: "./container/Dockerfile" } },
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
			// Upload names and download links travel in query strings; keep them out of the logs.
			observability: { enabled: true, redactQueryString: true },
			env: {
				// The dev server's database has an id of its own, only so that `cf d1 migrations apply --local` can name it.
				DB: bindings.d1({ name: target.names.d1, ...(target.offline ? { id: OFFLINE_D1_ID } : {}) }),
				// An EU workspace's files stay in a bucket in R2's EU jurisdiction (src/addressing.ts).
				FILES: bindings.r2({ name: target.names.bucket }),
				FILES_EU: bindings.r2({ name: target.names.bucketEu, jurisdiction: "eu" }),
				// Workers AI has no local simulation: in local dev it is the account's, and the tests leave it off.
				// Mode offline has none at all: it runs the fake model and needs no account.
				...(target.offline ? {} : { AI: bindings.ai({ dev: { remote: true } }) }),
				// Prepares the images `read` gives the model (src/conversation/images.ts); without it, only images
				// already within the model's limits are read.
				...(target.offline ? {} : { IMAGES: bindings.images({ dev: { remote: true } }) }),
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

				// The internal API (docs/plans/contract.md): off until all four Access settings are set.
				MINERVA_ENVIRONMENT: setting("MINERVA_ENVIRONMENT"),
				MINERVA_ACCESS_ISSUER: setting("MINERVA_ACCESS_ISSUER"),
				MINERVA_ACCESS_AUDIENCE: setting("MINERVA_ACCESS_AUDIENCE"),
				MINERVA_ACCESS_CLIENTS: setting("MINERVA_ACCESS_CLIENTS"),
				MINERVA_LARAVEL_URL: setting("MINERVA_LARAVEL_URL"),

				// Uploaded from the instance's secrets.env by `pnpm run deploy`. A declared secret is required, so model
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
				...laravelSecrets(target),
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
