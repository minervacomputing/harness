// Settings parsed from the Worker's text bindings (cloudflare.config.ts). The build runs the same parser,
// so a malformed value fails the build; in the Worker it throws on first use, so a misconfigured deploy
// fails closed instead of running with a default.

export interface SettingsEnv {
	MINERVA_SITE_URL: string;
	MINERVA_DOWNLOAD_ORIGIN: string;
	MINERVA_DEBUG: string;
	MINERVA_SIGNUP_OPEN: string;
	MINERVA_EMAIL_FROM: string;
	MINERVA_RUN_TIMEOUT_SECONDS: string;
	MINERVA_MODEL_PROVIDER: string;
	MINERVA_MODEL_NAME: string;
	MINERVA_MODEL_GATEWAY: string;
	MINERVA_MODEL_API: string;
	MINERVA_MODEL_MAX_OUTPUT_TOKENS: string;
	MINERVA_MODEL_REASONING_EFFORT: string;
	MINERVA_MODEL_REASONING_SUMMARY: string;
	MINERVA_FILES_FOLDER_BYTES: string;
	MINERVA_FILES_FOLDER_ENTRIES: string;
	MINERVA_FILES_RUN_UPLOAD_BYTES: string;
	MINERVA_FILES_WORKSPACE_BYTES: string;
	MINERVA_FILES_UPLOAD_BYTES: string;
	MINERVA_FILES_MESSAGE_ATTACHMENTS: string;
}

/** `fake` is the deterministic model of src/model/fake.ts, for tests and a test deployment. */
export type ModelProvider = "workers-ai" | "openai" | "anthropic" | "fake";

export interface Settings {
	/** The public origin of the app, without a trailing slash: redirects, email links, OAuth callbacks, CSRF. */
	siteUrl: string;
	/** The download Worker's origin, where signed links point. */
	downloadOrigin: string;
	/** Development mode: insecure cookies, emailed codes in the logs, detail on 404s. Never on in production. */
	debug: boolean;
	signupOpen: boolean;
	emailFrom: string;
	/** A turn's wall-clock limit, or null for none (today's default). */
	runTimeoutMs: number | null;
	model: {
		provider: ModelProvider;
		name: string;
		/** The AI Gateway every model request goes through, with prompt logging off. */
		gateway: string;
		api: "chat" | "responses";
		maxOutputTokens: number;
		/** Empty when the model does not reason or none is requested. */
		reasoningEffort: string;
		reasoningSummary: string;
	};
	files: {
		folderBytes: number;
		folderEntries: number;
		/** Bytes a run may save; four times the folder by default. */
		runUploadBytes: number;
		/** The workspace's total, or null for no limit. */
		workspaceBytes: number | null;
		uploadBytes: number;
		messageAttachments: number;
	};
}

const cache = new WeakMap<object, Settings>();

export function settings(env: SettingsEnv): Settings {
	let parsed = cache.get(env);
	if (!parsed) {
		parsed = parse(env);
		cache.set(env, parsed);
	}
	return parsed;
}

export function parse(env: SettingsEnv): Settings {
	const folderBytes = count(env, "MINERVA_FILES_FOLDER_BYTES");
	const timeout = optionalCount(env, "MINERVA_RUN_TIMEOUT_SECONDS");
	return {
		siteUrl: origin(env, "MINERVA_SITE_URL"),
		downloadOrigin: origin(env, "MINERVA_DOWNLOAD_ORIGIN"),
		debug: flag(env, "MINERVA_DEBUG"),
		signupOpen: flag(env, "MINERVA_SIGNUP_OPEN"),
		emailFrom: env.MINERVA_EMAIL_FROM,
		runTimeoutMs: timeout === null ? null : timeout * 1000,
		model: {
			provider: oneOf(env, "MINERVA_MODEL_PROVIDER", ["workers-ai", "openai", "anthropic", "fake"] as const),
			name: required(env, "MINERVA_MODEL_NAME"),
			gateway: required(env, "MINERVA_MODEL_GATEWAY"),
			api: oneOf(env, "MINERVA_MODEL_API", ["chat", "responses"] as const),
			maxOutputTokens: count(env, "MINERVA_MODEL_MAX_OUTPUT_TOKENS"),
			reasoningEffort: env.MINERVA_MODEL_REASONING_EFFORT.trim(),
			reasoningSummary: oneOf(env, "MINERVA_MODEL_REASONING_SUMMARY", ["", "auto", "concise", "detailed"] as const),
		},
		files: {
			folderBytes,
			folderEntries: count(env, "MINERVA_FILES_FOLDER_ENTRIES"),
			runUploadBytes: optionalCount(env, "MINERVA_FILES_RUN_UPLOAD_BYTES") ?? 4 * folderBytes,
			workspaceBytes: optionalCount(env, "MINERVA_FILES_WORKSPACE_BYTES"),
			uploadBytes: count(env, "MINERVA_FILES_UPLOAD_BYTES"),
			messageAttachments: count(env, "MINERVA_FILES_MESSAGE_ATTACHMENTS"),
		},
	};
}

/**
 * A build's rules beyond parsing (cloudflare.config.ts). The fake model answers from the last user message,
 * so a prompt could script it: only the test build's entry has it, so any other build refuses it rather
 * than fail every model call. A deployed build also needs https origins and debug off.
 */
export function checkBuild(parsed: Settings, build: { deployed: boolean; testBuild: boolean }): void {
	if (!build.testBuild && parsed.model.provider === "fake") throw new Error("MINERVA_MODEL_PROVIDER=fake is only for the test build.");
	if (!build.deployed) return;
	if (!parsed.siteUrl.startsWith("https://") || !parsed.downloadOrigin.startsWith("https://")) {
		throw new Error("MINERVA_SITE_URL and MINERVA_DOWNLOAD_ORIGIN must be https origins in a deployed build's vars file.");
	}
	if (parsed.debug) throw new Error("MINERVA_DEBUG must be off in a deployed build.");
}

/** The OAuth apps of the connectors (`auth.app`); several connectors may share one app's client. */
export const OAUTH_APPS = ["todoist", "google", "github", "notion", "linear", "slack", "microsoft", "hubspot", "jira", "confluence", "intercom", "xero", "sentry"] as const;

/** MINERVA_<APP>_CLIENT_ID and MINERVA_<APP>_CLIENT_SECRET. */
export function clientSecretNames(app: string): [id: string, secret: string] {
	const prefix = `MINERVA_${app.toUpperCase()}_CLIENT_`;
	return [`${prefix}ID`, `${prefix}SECRET`];
}

/**
 * The connector clients a build declares as secrets (cloudflare.config.ts): both names of every app whose
 * client the operator configured, which `cf deploy` then requires and uploads. An app with neither stays
 * undeclared and its connectors are not offered (Todoist registers a client of its own); one with only half
 * a client fails the build rather than hide the connector. Only names are read, never values.
 */
export function connectorClientSecrets(source: Readonly<Record<string, string | undefined>>): string[] {
	const names: string[] = [];
	for (const app of OAUTH_APPS) {
		const [id, secret] = clientSecretNames(app);
		const hasId = Boolean(source[id]?.trim());
		const hasSecret = Boolean(source[secret]?.trim());
		if (hasId !== hasSecret) throw new Error(`${hasId ? id : secret} is set but ${hasId ? secret : id} is not: set both or neither.`);
		if (hasId) names.push(id, secret);
	}
	return names;
}

type Name = keyof SettingsEnv;

function invalid(name: Name, expected: string): Error {
	return new Error(`${name} must be ${expected}.`);
}

function required(env: SettingsEnv, name: Name): string {
	const value = env[name].trim();
	if (!value) throw invalid(name, "set");
	return value;
}

function flag(env: SettingsEnv, name: Name): boolean {
	const value = env[name].trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(value)) return true;
	if (["false", "0", "no", "off", ""].includes(value)) return false;
	throw invalid(name, "true or false");
}

function count(env: SettingsEnv, name: Name): number {
	const value = optionalCount(env, name);
	if (value === null) throw invalid(name, "a whole number above 0");
	return value;
}

function optionalCount(env: SettingsEnv, name: Name): number | null {
	const value = env[name].trim();
	if (!value) return null;
	if (!/^[0-9]+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
		throw invalid(name, "a whole number above 0, or empty");
	}
	return Number(value);
}

function origin(env: SettingsEnv, name: Name): string {
	const value = required(env, name);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid(name, "an http(s) origin such as https://minerva.example");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
		throw invalid(name, "an http(s) origin such as https://minerva.example");
	}
	return url.origin;
}

function oneOf<const T extends readonly string[]>(env: SettingsEnv, name: Name, choices: T): T[number] {
	const value = env[name].trim();
	if (!choices.includes(value)) throw invalid(name, `one of ${choices.map((choice) => `'${choice}'`).join(", ")}`);
	return value as T[number];
}
