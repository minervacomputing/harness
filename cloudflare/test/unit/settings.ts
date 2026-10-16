// Text settings as cloudflare.config.ts declares them by default, for tests that build an Env by hand.
import type { SettingsEnv } from "../../src/config.ts";

export function settingsEnv(overrides: Partial<SettingsEnv> = {}): SettingsEnv {
	return {
		MINERVA_DEBUG: "false",
		MINERVA_RUN_TIMEOUT_SECONDS: "",
		MINERVA_MODEL_PROVIDER: "workers-ai",
		MINERVA_MODEL_NAME: "@cf/zai-org/glm-5.3-flash",
		MINERVA_MODEL_GATEWAY: "acme",
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
		...overrides,
	};
}
