import { expect, test } from "vitest";
import { type SettingsBuild, buildSettings } from "../../scripts/build-settings.ts";
import { checkBuild, parse, settings } from "../../src/config.ts";
import { settingsEnv } from "./settings.ts";

test("the defaults", () => {
	const parsed = parse(settingsEnv());
	expect(parsed.debug).toBe(false);
	expect(parsed.runTimeoutMs).toBeNull();
	expect(parsed.files).toEqual({
		folderBytes: 268_435_456,
		folderEntries: 10_000,
		runUploadBytes: 4 * 268_435_456,
		uploadBytes: 52_428_800,
		messageAttachments: 10,
	});
	expect(parsed.model.provider).toBe("workers-ai");
});

test("values are parsed and checked", () => {
	const parsed = parse(settingsEnv({ MINERVA_DEBUG: "true", MINERVA_RUN_TIMEOUT_SECONDS: "60" }));
	expect(parsed.debug).toBe(true);
	expect(parsed.runTimeoutMs).toBe(60_000);
});

test("a malformed value fails closed", () => {
	expect(() => parse(settingsEnv({ MINERVA_DEBUG: "maybe" }))).toThrow("MINERVA_DEBUG must be true or false.");
	expect(() => parse(settingsEnv({ MINERVA_FILES_FOLDER_BYTES: "-1" }))).toThrow("MINERVA_FILES_FOLDER_BYTES");
	expect(() => parse(settingsEnv({ MINERVA_MODEL_API: "grpc" }))).toThrow("MINERVA_MODEL_API must be one of 'chat', 'responses'.");
});

test("settings are parsed once per environment", () => {
	const env = settingsEnv();
	expect(settings(env)).toBe(settings(env));
});

/** What the deploy reads from models.dev for the default route (scripts/model-prices.ts). */
const PRICES = { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", input: 150_000, cachedInput: 30_000, cacheWrite: 150_000, output: 500_000 };
const PRICED = { MINERVA_MODEL_PRICES: JSON.stringify(PRICES) };

test("a build refuses the fake model unless it is the test build; a deployed one needs debug off", () => {
	const parsed = (values: Parameters<typeof settingsEnv>[0] = {}) => parse(settingsEnv({ ...PRICED, ...values }));
	const deployed = { deployed: true, testBuild: false };
	expect(() => checkBuild(parsed(), deployed)).not.toThrow();
	expect(() => checkBuild(parsed({ MINERVA_DEBUG: "true" }), { deployed: true, testBuild: true })).toThrow("MINERVA_DEBUG must be off in a deployed build.");
	// The fake model answers from the last user message: production would no longer use a real model.
	for (const build of [deployed, { deployed: false, testBuild: false }]) {
		expect(() => checkBuild(parsed({ MINERVA_MODEL_PROVIDER: "fake", MINERVA_MODEL_PRICES: "" }), build)).toThrow("MINERVA_MODEL_PROVIDER=fake is only for the test build.");
	}
	expect(() => checkBuild(parsed({ MINERVA_MODEL_PROVIDER: "fake", MINERVA_MODEL_PRICES: "" }), { deployed: true, testBuild: true })).not.toThrow();
});

test("a deployed build refuses a route without prices; the route's prices are parsed, and must be its own", () => {
	const unpriced = parse(settingsEnv());
	expect(unpriced.model.prices).toBeNull();
	// Every call a deployed build makes is charged; the fake model's prices are in the test build's code.
	for (const testBuild of [false, true]) {
		expect(() => checkBuild(unpriced, { deployed: true, testBuild })).toThrow("A deployed build needs the prices of workers-ai @cf/zai-org/glm-5.3-flash, which the deploy reads from models.dev.");
	}
	expect(() => checkBuild(unpriced, { deployed: false, testBuild: false })).not.toThrow();
	expect(parse(settingsEnv(PRICED)).model.prices).toEqual(PRICES);
	const tiered = { ...PRICES, above: { inputTokens: 272_000, input: 4_000_000, cachedInput: 200_000, cacheWrite: 5_000_000, output: 15_000_000 } };
	expect(parse(settingsEnv({ MINERVA_MODEL_PRICES: JSON.stringify(tiered) })).model.prices).toEqual(tiered);
	expect(() => parse(settingsEnv({ MINERVA_MODEL_PRICES: JSON.stringify({ ...PRICES, model: "@cf/other" }) }))).toThrow(
		"MINERVA_MODEL_PRICES must be the prices of workers-ai @cf/zai-org/glm-5.3-flash, not of workers-ai @cf/other.",
	);
	for (const malformed of ["{", JSON.stringify({ ...PRICES, input: 0.15 }), JSON.stringify({ ...PRICES, output: -1 }), "[]"]) {
		expect(() => parse(settingsEnv({ MINERVA_MODEL_PRICES: malformed }))).toThrow("MINERVA_MODEL_PRICES must be a route's prices as JSON, or empty.");
	}
});

test("a deployed build ignores the names it does not know, such as retired settings left in a vars file", () => {
	const vars = {
		MINERVA_SITE_URL: "http://acme.minerva.example/app",
		MINERVA_DOWNLOAD_ORIGIN: "not an origin",
		MINERVA_SIGNUP_OPEN: "maybe",
		MINERVA_EMAIL_FROM: "",
		MINERVA_FILES_WORKSPACE_BYTES: "-1",
		MINERVA_RUN_TIMEOUT_SECONDS: "60",
	};
	const values = buildSettings({ deployed: true, faults: false, offline: false }, { ...vars, MINERVA_MODEL_PRICES: "{}" }, "acme", PRICED.MINERVA_MODEL_PRICES);
	expect(Object.keys(values).filter((name) => Object.hasOwn(vars, name))).toEqual(["MINERVA_RUN_TIMEOUT_SECONDS"]);
	// The prices are the deploy's, never the source's.
	expect(values.MINERVA_MODEL_PRICES).toBe(PRICED.MINERVA_MODEL_PRICES);
	const parsed = parse(values);
	expect(parsed.runTimeoutMs).toBe(60_000);
	expect(() => checkBuild(parsed, { deployed: true, testBuild: false })).not.toThrow();
});

test("the internal API's settings are all set or none", () => {
	const internal = {
		MINERVA_ENVIRONMENT: "staging",
		MINERVA_ACCESS_ISSUER: "https://team.cloudflareaccess.example",
		MINERVA_ACCESS_AUDIENCE: "aud-tag",
		MINERVA_ACCESS_CLIENTS: " old.access , laravel.access,,old.access ",
	};
	expect(parse(settingsEnv()).internal).toBeNull();
	expect(parse(settingsEnv(internal)).internal).toEqual({
		environment: "staging",
		access: { issuer: "https://team.cloudflareaccess.example", audience: "aud-tag", clients: ["old.access", "laravel.access"] },
	});
	expect(() => parse(settingsEnv({ MINERVA_ENVIRONMENT: "staging" }))).toThrow("are set together or not at all; MINERVA_ENVIRONMENT is set.");
	expect(() => parse(settingsEnv({ ...internal, MINERVA_ACCESS_ISSUER: "http://team.cloudflareaccess.example" }))).toThrow("MINERVA_ACCESS_ISSUER must be an https origin");
	expect(() => parse(settingsEnv({ ...internal, MINERVA_ACCESS_ISSUER: "https://team.cloudflareaccess.example/path" }))).toThrow("MINERVA_ACCESS_ISSUER");
	expect(() => parse(settingsEnv({ ...internal, MINERVA_ACCESS_CLIENTS: " , " }))).toThrow("MINERVA_ACCESS_CLIENTS must be one or more client ids");
	expect(() => parse(settingsEnv({ ...internal, MINERVA_ENVIRONMENT: "Staging" }))).toThrow("MINERVA_ENVIRONMENT must be lowercase");
});

test("Laravel's origin is optional, and https in a deployed build", () => {
	expect(parse(settingsEnv()).laravelUrl).toBeNull();
	expect(parse(settingsEnv({ MINERVA_LARAVEL_URL: "https://app.minerva.example/" })).laravelUrl).toBe("https://app.minerva.example");
	expect(() => parse(settingsEnv({ MINERVA_LARAVEL_URL: "https://app.minerva.example/internal" }))).toThrow("MINERVA_LARAVEL_URL");
	const plain = parse(settingsEnv({ MINERVA_LARAVEL_URL: "http://localhost:8000" }));
	expect(() => checkBuild(plain, { deployed: false, testBuild: false })).not.toThrow();
	expect(() => checkBuild(plain, { deployed: true, testBuild: false })).toThrow("MINERVA_LARAVEL_URL must be an https origin in a deployed build's vars file.");
});

test("GitHub's App slug is optional, its vars file's when deployed, and a GitHub App's URL name", () => {
	const deployed = { deployed: true, faults: false, offline: false };
	expect(parse(buildSettings(deployed, {}, "acme")).githubAppSlug).toBeNull();
	expect(parse(buildSettings(deployed, { MINERVA_GITHUB_APP_SLUG: "acme-minerva" }, "acme")).githubAppSlug).toBe("acme-minerva");
	expect(parse(settingsEnv({ MINERVA_GITHUB_APP_SLUG: " minerva-dev-2 " })).githubAppSlug).toBe("minerva-dev-2");
	expect(parse(settingsEnv({ MINERVA_GITHUB_APP_SLUG: "  " })).githubAppSlug).toBeNull();
	for (const slug of ["Minerva", "minerva_dev", "evil.example/x", "minerva dev", "a".repeat(101)]) {
		expect(() => parse(buildSettings(deployed, { MINERVA_GITHUB_APP_SLUG: slug }, "acme"))).toThrow(
			"MINERVA_GITHUB_APP_SLUG must be a GitHub App's URL name (github.com/apps/<slug>): lowercase letters, digits and hyphens, or empty.",
		);
	}
	expect(parse(settingsEnv({ MINERVA_GITHUB_APP_SLUG: "a".repeat(100) })).githubAppSlug).toBe("a".repeat(100));
});

test("a deployed test build has the internal API and its fake Laravel unless its vars file says otherwise; no other build does", () => {
	const parsed = (build: SettingsBuild, source: Record<string, string> = {}) => parse(buildSettings(build, source, "acme"));
	const faults = { deployed: true, faults: true, offline: false };
	expect(parsed(faults).internal).toEqual({ environment: "faults", access: { issuer: "https://faults.cloudflareaccess.example", audience: "faults", clients: ["faults"] } });
	expect(parsed(faults).laravelUrl).toBe("https://laravel.fake.invalid");
	const vars = {
		MINERVA_ENVIRONMENT: "staging",
		MINERVA_ACCESS_ISSUER: "https://team.cloudflareaccess.example",
		MINERVA_ACCESS_AUDIENCE: "aud-tag",
		MINERVA_ACCESS_CLIENTS: "laravel.access",
		MINERVA_LARAVEL_URL: "https://app.minerva.example",
	};
	expect(parsed(faults, vars).internal).toEqual({ environment: "staging", access: { issuer: "https://team.cloudflareaccess.example", audience: "aud-tag", clients: ["laravel.access"] } });
	expect(parsed(faults, vars).laravelUrl).toBe("https://app.minerva.example");
	const others = {
		production: { deployed: true, faults: false, offline: false },
		test: { deployed: false, faults: true, offline: false },
		offline: { deployed: false, faults: true, offline: true },
		standalone: { deployed: false, faults: false, offline: false },
	};
	for (const [mode, build] of Object.entries(others)) {
		expect({ mode, internal: parsed(build).internal, laravelUrl: parsed(build).laravelUrl }).toEqual({ mode, internal: null, laravelUrl: null });
	}
	expect(parsed(others.production, vars).internal?.environment).toBe("staging");
});
