import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The download origin (plan: Files, Downloads): serves agent files from R2 behind links the app signs
// with MINERVA_DOWNLOAD_KEY, on an origin of its own, as sandboxed attachments. It holds no other secret.
export default defineConfig({
	worker: {
		name: "minerva-cf-files",
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		// No preview URLs: each version would stay reachable at an origin of its own, with the bucket and the
		// link key, after a fix (versions cannot be deleted). Signed links name the download origin too.
		workersDev: true,
		previewUrls: false,
		// Signed links travel in query strings; keep them out of the logs.
		observability: { enabled: true, redactQueryString: true },
		env: {
			FILES: bindings.r2({ name: "minerva-cf-files" }),
			FILES_EU: bindings.r2({ name: "minerva-cf-files-eu", jurisdiction: "eu" }),
			MINERVA_DOWNLOAD_KEY: bindings.secret(),
		},
	},
});
