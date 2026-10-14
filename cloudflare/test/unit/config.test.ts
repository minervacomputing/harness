import { expect, test } from "vitest";
import { OAUTH_APPS, checkBuild, clientSecretNames, connectorClientSecrets, parse, settings } from "../../src/config.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { settingsEnv } from "./settings.ts";

test("the defaults", () => {
	const parsed = parse(settingsEnv());
	expect(parsed.siteUrl).toBe("https://minerva.example");
	expect(parsed.debug).toBe(false);
	expect(parsed.runTimeoutMs).toBeNull();
	expect(parsed.files).toEqual({
		folderBytes: 268_435_456,
		folderEntries: 10_000,
		runUploadBytes: 4 * 268_435_456,
		workspaceBytes: null,
		uploadBytes: 52_428_800,
		messageAttachments: 10,
	});
	expect(parsed.model.provider).toBe("workers-ai");
});

test("values are parsed and checked", () => {
	const parsed = parse(settingsEnv({ MINERVA_DEBUG: "true", MINERVA_RUN_TIMEOUT_SECONDS: "60", MINERVA_SITE_URL: "http://localhost:5173/" }));
	expect(parsed.debug).toBe(true);
	expect(parsed.runTimeoutMs).toBe(60_000);
	expect(parsed.siteUrl).toBe("http://localhost:5173");
});

test("a malformed value fails closed", () => {
	expect(() => parse(settingsEnv({ MINERVA_DEBUG: "maybe" }))).toThrow("MINERVA_DEBUG must be true or false.");
	expect(() => parse(settingsEnv({ MINERVA_FILES_FOLDER_BYTES: "-1" }))).toThrow("MINERVA_FILES_FOLDER_BYTES");
	expect(() => parse(settingsEnv({ MINERVA_SITE_URL: "https://minerva.example/app" }))).toThrow("MINERVA_SITE_URL");
	expect(() => parse(settingsEnv({ MINERVA_MODEL_API: "grpc" }))).toThrow("MINERVA_MODEL_API must be one of 'chat', 'responses'.");
});

test("settings are parsed once per environment", () => {
	const env = settingsEnv();
	expect(settings(env)).toBe(settings(env));
});

test("a build refuses the fake model unless it is the test build; a deployed one needs https origins and debug off", () => {
	const parsed = (values: Parameters<typeof settingsEnv>[0] = {}) => parse(settingsEnv(values));
	const deployed = { deployed: true, testBuild: false };
	expect(() => checkBuild(parsed(), deployed)).not.toThrow();
	expect(() => checkBuild(parsed({ MINERVA_SITE_URL: "http://minerva.example" }), deployed)).toThrow("must be https origins");
	expect(() => checkBuild(parsed({ MINERVA_SITE_URL: "http://minerva.example" }), { deployed: false, testBuild: false })).not.toThrow();
	expect(() => checkBuild(parsed({ MINERVA_DEBUG: "true" }), { deployed: true, testBuild: true })).toThrow("MINERVA_DEBUG must be off in a deployed build.");
	// The fake model answers from the last user message: production would no longer use a real model.
	for (const build of [deployed, { deployed: false, testBuild: false }]) {
		expect(() => checkBuild(parsed({ MINERVA_MODEL_PROVIDER: "fake" }), build)).toThrow("MINERVA_MODEL_PROVIDER=fake is only for the test build.");
	}
	expect(() => checkBuild(parsed({ MINERVA_MODEL_PROVIDER: "fake" }), { deployed: true, testBuild: true })).not.toThrow();
});

test("connector clients are declared in pairs, for the OAuth apps of the registry", async () => {
	expect(clientSecretNames("github")).toEqual(["MINERVA_GITHUB_CLIENT_ID", "MINERVA_GITHUB_CLIENT_SECRET"]);
	expect(connectorClientSecrets({})).toEqual([]);
	const source = { MINERVA_GITHUB_CLIENT_ID: "id", MINERVA_GITHUB_CLIENT_SECRET: "secret", MINERVA_SLACK_CLIENT_ID: " ", MINERVA_SLACK_CLIENT_SECRET: "" };
	expect(connectorClientSecrets(source)).toEqual(["MINERVA_GITHUB_CLIENT_ID", "MINERVA_GITHUB_CLIENT_SECRET"]);
	expect(() => connectorClientSecrets({ MINERVA_GITHUB_CLIENT_ID: "id" })).toThrow("MINERVA_GITHUB_CLIENT_ID is set but MINERVA_GITHUB_CLIENT_SECRET is not: set both or neither.");
	expect(() => connectorClientSecrets({ MINERVA_XERO_CLIENT_SECRET: "secret" })).toThrow("MINERVA_XERO_CLIENT_SECRET is set but MINERVA_XERO_CLIENT_ID is not: set both or neither.");
	const apps = new Set((await connectorRegistry()).all().flatMap((connector) => (connector.auth.type === "oauth2" ? [connector.auth.app] : [])));
	expect([...apps].filter((app) => !(OAUTH_APPS as readonly string[]).includes(app))).toEqual([]);
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
