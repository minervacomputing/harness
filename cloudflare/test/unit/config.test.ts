import { expect, test } from "vitest";
import { checkBuild, parse, settings } from "../../src/config.ts";
import { settingsEnv } from "./settings.ts";

test("defaults are today's", () => {
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
