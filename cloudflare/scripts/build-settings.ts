// The text settings a build gets (cloudflare.config.ts): each from its source (a deployed build's vars file, or the
// environment), else its default, which depends on the build. The Worker configs import this module and are type-checked
// with the Worker's types, so it imports nothing of Node's.

import type { SettingsEnv } from "../src/config.ts";
import { FAULTS_SETTINGS } from "../src/faults/settings.ts";

type Defaults = Omit<SettingsEnv, "MINERVA_MODEL_GATEWAY">;

/** The settings with a default. MINERVA_MODEL_GATEWAY is not one: the build sets it to the instance's name. */
const DEFAULTS: Defaults = {
	MINERVA_DEBUG: "false",
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
	MINERVA_FILES_UPLOAD_BYTES: "52428800",
	MINERVA_FILES_MESSAGE_ATTACHMENTS: "10",
	MINERVA_ENVIRONMENT: "",
	MINERVA_ACCESS_ISSUER: "",
	MINERVA_ACCESS_AUDIENCE: "",
	MINERVA_ACCESS_CLIENTS: "",
	MINERVA_LARAVEL_URL: "",
};

/**
 * What the dev server's mode `offline` sets besides DEFAULTS, unless the shell sets it: debug on (addressing.ts
 * stands in for the jurisdictions local workerd lacks), the fake model (the test build's entry has it), and a
 * fake model name for the settings parser.
 */
const OFFLINE_DEFAULTS: Partial<Defaults> = {
	MINERVA_DEBUG: "true",
	MINERVA_MODEL_PROVIDER: "fake",
	MINERVA_MODEL_NAME: "fake-1",
};

/** What a deployed test build (mode `faults`) sets besides DEFAULTS, unless its vars file sets it: the internal API and its fake Laravel. */
const FAULTS_DEFAULTS: Partial<Defaults> = FAULTS_SETTINGS;

export interface SettingsBuild {
	/** A deployed instance's build, whose source is its vars file. */
	deployed: boolean;
	/** The test build's entry (modes `faults`, `test` and `offline`). */
	faults: boolean;
	/** The dev server's mode `offline`. */
	offline: boolean;
}

/** Every setting of the build: the source's value where it has one, else the build's default. */
export function buildSettings(build: SettingsBuild, source: Record<string, string | undefined>, gateway: string): SettingsEnv {
	const defaults = { ...DEFAULTS, ...(build.offline ? OFFLINE_DEFAULTS : {}), ...(build.deployed && build.faults ? FAULTS_DEFAULTS : {}) };
	const settings = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, source[name] ?? fallback]));
	return { ...settings, MINERVA_MODEL_GATEWAY: gateway } as unknown as SettingsEnv;
}
