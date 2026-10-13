import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { type Instance, LOCAL_INSTANCES, type Names, instanceForMode, instanceVars, namesOf } from "../scripts/instance.ts";

// The download origin (plan: Files, Downloads): serves agent files from R2 behind links the app signs
// with MINERVA_DOWNLOAD_KEY, on an origin of its own, as sandboxed attachments. It holds no other secret.
//
// MINERVA_DOWNLOAD_ORIGIN is the origin links are signed for, and the only host it answers: as the app's
// settings (../cloudflare.config.ts), a deployed build reads it from its instance's vars.env alone (outside the
// checkout: it names the deployed origin), which must exist and give an https origin; other builds read the
// environment, with a local default.
//
// Every name comes from scripts/instance.ts: the Worker is the instance's download Worker (`namesOf`), over the
// instance's two buckets. Modes `production` and `faults` are an instance's, as the app's (`instanceForMode`:
// MINERVA_INSTANCE, which scripts/deploy.ts sets, or for mode faults the only test instance), with the same
// vars.env as its app, so the origins match; a mode that disagrees with the instance's kind stops, so the test
// build never takes a production instance's names, and scripts/deploy.ts checks the built output against the
// app's before uploading it. Other modes are local and take a local name.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
interface BuildProcess {
	env: Record<string, string | undefined>;
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

interface Target {
	names: Names;
	/** The instance of a deployed build, whose vars.env it reads; null reads the environment. */
	instance: Instance | null;
}

function targetFor(mode: string | undefined): Target {
	if (mode === "production" || mode === "faults") {
		const instance = instanceForMode(mode);
		return { names: instance.names, instance };
	}
	return { names: namesOf(LOCAL_INSTANCES.test), instance: null };
}

function downloadOrigin(target: Target): string {
	const value = target.instance ? instanceVars(target.instance).MINERVA_DOWNLOAD_ORIGIN : (build.env.MINERVA_DOWNLOAD_ORIGIN ?? "http://localhost:8788");
	let url: URL;
	try {
		url = new URL(value ?? "");
	} catch {
		throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an http(s) origin such as https://files.minerva.example.");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an http(s) origin such as https://files.minerva.example.");
	}
	if (target.instance && url.protocol !== "https:") throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an https origin in a deployed build's vars file.");
	return url.origin;
}

export default defineConfig(({ mode }) => {
	const target = targetFor(mode);
	return {
		worker: {
			name: target.names.download,
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
				FILES: bindings.r2({ name: target.names.bucket }),
				FILES_EU: bindings.r2({ name: target.names.bucketEu, jurisdiction: "eu" }),
				MINERVA_DOWNLOAD_ORIGIN: bindings.text(downloadOrigin(target)),
				MINERVA_DOWNLOAD_KEY: bindings.secret(),
			},
		},
	};
});
