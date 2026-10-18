// Settings parsed from the Worker's text bindings (cloudflare.config.ts). The build runs the same parser,
// so a malformed value fails the build; in the Worker it throws on first use, so a misconfigured deploy
// fails closed instead of running with a default.

import { RoutePrices } from "@minerva/contract/internal";
import { parseJson } from "./lib/json.ts";

export interface SettingsEnv {
	MINERVA_DEBUG: string;
	MINERVA_RUN_TIMEOUT_SECONDS: string;
	MINERVA_MODEL_PROVIDER: string;
	MINERVA_MODEL_NAME: string;
	MINERVA_MODEL_GATEWAY: string;
	/** The route's prices, which the deploy reads from models.dev (scripts/model-prices.ts); empty when the build has none. */
	MINERVA_MODEL_PRICES: string;
	MINERVA_MODEL_API: string;
	MINERVA_MODEL_MAX_OUTPUT_TOKENS: string;
	MINERVA_MODEL_REASONING_EFFORT: string;
	MINERVA_MODEL_REASONING_SUMMARY: string;
	MINERVA_FILES_FOLDER_BYTES: string;
	MINERVA_FILES_FOLDER_ENTRIES: string;
	MINERVA_FILES_RUN_UPLOAD_BYTES: string;
	MINERVA_FILES_UPLOAD_BYTES: string;
	MINERVA_FILES_MESSAGE_ATTACHMENTS: string;
	MINERVA_ENVIRONMENT: string;
	MINERVA_ACCESS_ISSUER: string;
	MINERVA_ACCESS_AUDIENCE: string;
	MINERVA_ACCESS_CLIENTS: string;
	MINERVA_LARAVEL_URL: string;
	MINERVA_GITHUB_APP_SLUG: string;
}

/** `fake` is the deterministic model of src/model/fake.ts, for tests and a test deployment. */
export type ModelProvider = "workers-ai" | "openai" | "anthropic" | "fake";

export interface Settings {
	/** Development mode: a jurisdiction local workerd lacks is put in the object's name instead (addressing.ts). Never on in production. */
	debug: boolean;
	/** A turn's wall-clock limit, or null for none (the default). */
	runTimeoutMs: number | null;
	model: {
		provider: ModelProvider;
		name: string;
		/** The AI Gateway every model request goes through, with prompt logging off. */
		gateway: string;
		/** The route's prices from models.dev, in µ$ per million tokens; null when the build has none (budget/prices.ts). */
		prices: RoutePrices | null;
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
		uploadBytes: number;
		messageAttachments: number;
	};
	/**
	 * The internal API Laravel calls (api/internal/, docs/plans/contract.md): the environment its commands must name, and the
	 * Cloudflare Access application whose service tokens may call it. Null when unset: every /internal/ path is then 404.
	 */
	internal: { environment: string; access: AccessSettings } | null;
	/** Laravel's origin, which the engine's requests and deliveries go to (laravel/client.ts); null when unset. */
	laravelUrl: string | null;
	/** The GitHub App's URL name (github.com/apps/<slug>), for GitHub's link to install it; null when unset, and then no link. */
	githubAppSlug: string | null;
}

/** What the Worker checks an Access assertion against (api/internal/access.ts). */
export interface AccessSettings {
	/** `https://<team>.cloudflareaccess.com`: the assertion's `iss`, and where its keys are published. */
	issuer: string;
	/** The Access application's audience tag. */
	audience: string;
	/** The client ids of the service tokens that may call; more than one while a token is rotated. */
	clients: string[];
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
	const provider = oneOf(env, "MINERVA_MODEL_PROVIDER", ["workers-ai", "openai", "anthropic", "fake"] as const);
	const name = required(env, "MINERVA_MODEL_NAME");
	return {
		debug: flag(env, "MINERVA_DEBUG"),
		runTimeoutMs: timeout === null ? null : timeout * 1000,
		model: {
			provider,
			name,
			gateway: required(env, "MINERVA_MODEL_GATEWAY"),
			prices: routePrices(env, provider, name),
			api: oneOf(env, "MINERVA_MODEL_API", ["chat", "responses"] as const),
			maxOutputTokens: count(env, "MINERVA_MODEL_MAX_OUTPUT_TOKENS"),
			reasoningEffort: env.MINERVA_MODEL_REASONING_EFFORT.trim(),
			reasoningSummary: oneOf(env, "MINERVA_MODEL_REASONING_SUMMARY", ["", "auto", "concise", "detailed"] as const),
		},
		files: {
			folderBytes,
			folderEntries: count(env, "MINERVA_FILES_FOLDER_ENTRIES"),
			runUploadBytes: optionalCount(env, "MINERVA_FILES_RUN_UPLOAD_BYTES") ?? 4 * folderBytes,
			uploadBytes: count(env, "MINERVA_FILES_UPLOAD_BYTES"),
			messageAttachments: count(env, "MINERVA_FILES_MESSAGE_ATTACHMENTS"),
		},
		internal: internal(env),
		laravelUrl: env.MINERVA_LARAVEL_URL.trim() ? origin(env, "MINERVA_LARAVEL_URL") : null,
		githubAppSlug: githubAppSlug(env),
	};
}

/** The GitHub connector reads its binding through this too (connectors/github/connector.ts), so it sees what the build checked. */
export function githubAppSlug(env: Pick<SettingsEnv, "MINERVA_GITHUB_APP_SLUG">): string | null {
	const value = env.MINERVA_GITHUB_APP_SLUG.trim();
	if (!value) return null;
	if (!/^[a-z0-9-]{1,100}$/.test(value)) throw invalid("MINERVA_GITHUB_APP_SLUG", "a GitHub App's URL name (github.com/apps/<slug>): lowercase letters, digits and hyphens, or empty");
	return value;
}

/** The route's prices: none when empty, else the configured route's, as the contract's catalog has them. */
function routePrices(env: SettingsEnv, provider: string, name: string): RoutePrices | null {
	const text = env.MINERVA_MODEL_PRICES.trim();
	if (!text) return null;
	let parsed: ReturnType<typeof RoutePrices.safeParse>;
	try {
		parsed = RoutePrices.safeParse(parseJson(text));
	} catch {
		throw invalid("MINERVA_MODEL_PRICES", "a route's prices as JSON, or empty");
	}
	if (!parsed.success) throw invalid("MINERVA_MODEL_PRICES", "a route's prices as JSON, or empty");
	if (parsed.data.provider !== provider || parsed.data.model !== name) throw invalid("MINERVA_MODEL_PRICES", `the prices of ${provider} ${name}, not of ${parsed.data.provider} ${parsed.data.model}`);
	return parsed.data;
}

const INTERNAL_NAMES = ["MINERVA_ENVIRONMENT", "MINERVA_ACCESS_ISSUER", "MINERVA_ACCESS_AUDIENCE", "MINERVA_ACCESS_CLIENTS"] as const;

/** The internal API's settings: all four, or none. */
function internal(env: SettingsEnv): Settings["internal"] {
	const set = INTERNAL_NAMES.filter((name) => env[name].trim());
	if (set.length === 0) return null;
	if (set.length < INTERNAL_NAMES.length) throw new Error(`${INTERNAL_NAMES.join(", ")} are set together or not at all; ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set.`);
	const environment = required(env, "MINERVA_ENVIRONMENT");
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) throw invalid("MINERVA_ENVIRONMENT", "lowercase letters, digits and hyphens, starting with a letter");
	const issuer = origin(env, "MINERVA_ACCESS_ISSUER");
	if (!issuer.startsWith("https://")) throw invalid("MINERVA_ACCESS_ISSUER", "an https origin such as https://team.cloudflareaccess.com");
	const clients = [...new Set(env.MINERVA_ACCESS_CLIENTS.split(",").map((client) => client.trim()).filter(Boolean))];
	if (clients.length === 0) throw invalid("MINERVA_ACCESS_CLIENTS", "one or more client ids, comma separated");
	return { environment, access: { issuer, audience: required(env, "MINERVA_ACCESS_AUDIENCE"), clients } };
}

/**
 * A build's rules beyond parsing (cloudflare.config.ts). The fake model answers from the last user message,
 * so a prompt could script it: only the test build's entry has it, so any other build refuses it rather
 * than fail every model call. A deployed build also needs debug off, an https MINERVA_LARAVEL_URL, and its route's prices,
 * so that every call it makes is charged (the test build has the fake model's in code, budget/prices.ts).
 */
export function checkBuild(parsed: Settings, build: { deployed: boolean; testBuild: boolean }): void {
	if (!build.testBuild && parsed.model.provider === "fake") throw new Error("MINERVA_MODEL_PROVIDER=fake is only for the test build.");
	if (!build.deployed) return;
	if (parsed.debug) throw new Error("MINERVA_DEBUG must be off in a deployed build.");
	if (parsed.laravelUrl !== null && !parsed.laravelUrl.startsWith("https://")) throw new Error("MINERVA_LARAVEL_URL must be an https origin in a deployed build's vars file.");
	if (parsed.model.provider !== "fake" && parsed.model.prices === null) throw new Error(`A deployed build needs the prices of ${parsed.model.provider} ${parsed.model.name}, which the deploy reads from models.dev.`);
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
