import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The download origin (plan: Files, Downloads): serves agent files from R2 behind links the app signs
// with MINERVA_DOWNLOAD_KEY, on an origin of its own, as sandboxed attachments. It holds no other secret.
//
// MINERVA_DOWNLOAD_ORIGIN is the origin links are signed for, and the only host it answers: as the app's
// settings (../cloudflare.config.ts), a production build reads it from ../../.env.cloudflare.vars alone
// (gitignored: it names the deployed origin), which must exist and give an https origin; other builds read
// the environment, with a local default.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const here = (import.meta as unknown as { url: string }).url;
interface BuildProcess {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:fs"): { readFileSync(path: URL, encoding: "utf8"): string };
	getBuiltinModule(id: "node:util"): { parseEnv(content: string): Record<string, string> };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

function downloadOrigin(mode: string | undefined): string {
	let value: string | undefined;
	if (mode === "production") {
		const file = new URL("../../.env.cloudflare.vars", here);
		let text: string;
		try {
			text = build.getBuiltinModule("node:fs").readFileSync(file, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
			throw new Error("A deployed build reads its settings from ../.env.cloudflare.vars, which is missing (cloudflare/README.md).");
		}
		value = build.getBuiltinModule("node:util").parseEnv(text).MINERVA_DOWNLOAD_ORIGIN;
	} else {
		value = build.env.MINERVA_DOWNLOAD_ORIGIN ?? "http://localhost:8788";
	}
	let url: URL;
	try {
		url = new URL(value ?? "");
	} catch {
		throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an http(s) origin such as https://files.minerva.example.");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an http(s) origin such as https://files.minerva.example.");
	}
	if (mode === "production" && url.protocol !== "https:") throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an https origin in a deployed build's vars file.");
	return url.origin;
}

export default defineConfig(({ mode }) => ({
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
			MINERVA_DOWNLOAD_ORIGIN: bindings.text(downloadOrigin(mode)),
			MINERVA_DOWNLOAD_KEY: bindings.secret(),
		},
	},
}));
