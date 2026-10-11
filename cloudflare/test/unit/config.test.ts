import { expect, test } from "vitest";
import { parse, settings } from "../../src/config.ts";
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
