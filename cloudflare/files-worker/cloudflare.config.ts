import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { LOCAL_INSTANCES, type Names, namesOf, todaysInstance } from "../scripts/instance.ts";

// The download origin (plan: Files, Downloads): serves agent files from R2 behind links the app signs
// with MINERVA_DOWNLOAD_KEY, on an origin of its own, as sandboxed attachments. It holds no other secret.
//
// MINERVA_DOWNLOAD_ORIGIN is the origin links are signed for, and the only host it answers: as the app's
// settings (../cloudflare.config.ts), a deployed build reads it from its vars file alone (gitignored: it names
// the deployed origin), which must exist and give an https origin; other builds read the environment, with a
// local default.
//
// Every name comes from scripts/instance.ts (`namesOf`): the Worker is the instance's download Worker, over the
// instance's two buckets. Mode `production` is production's, with ../../.env.cloudflare.vars. Mode `faults` is
// the test instance's own, with ../../.env.cloudflare-test.vars (the same file as the test app's, so the
// origins match); it refuses any name of production's, and scripts/deploy.ts checks the built output again
// before uploading it. Other modes are local and take a local name.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const here = (import.meta as unknown as { url: string }).url;
interface BuildProcess {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:fs"): { readFileSync(path: URL, encoding: "utf8"): string };
	getBuiltinModule(id: "node:util"): { parseEnv(content: string): Record<string, string> };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

interface Target {
	names: Names;
	/** The settings file of a deployed build; null reads the environment. */
	vars: URL | null;
}

function targetFor(mode: string | undefined): Target {
	if (mode === "production") return { names: namesOf(todaysInstance(false)), vars: new URL("../../.env.cloudflare.vars", here) };
	if (mode === "faults") {
		const names = namesOf(todaysInstance(true));
		// Fails closed: the test build never takes a name or a bucket of production's.
		const production = namesOf(todaysInstance(false));
		const own = new Set([production.download, production.bucket, production.bucketEu]);
		const taken = [names.download, names.bucket, names.bucketEu].filter((name) => own.has(name));
		if (taken.length) throw new Error(`The test files Worker would bind production's ${taken.join(", ")}.`);
		return { names, vars: new URL("../../.env.cloudflare-test.vars", here) };
	}
	return { names: namesOf(LOCAL_INSTANCES.test), vars: null };
}

function downloadOrigin(target: Target): string {
	let value: string | undefined;
	if (target.vars) {
		const name = target.vars.pathname.split("/").pop();
		let text: string;
		try {
			text = build.getBuiltinModule("node:fs").readFileSync(target.vars, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
			throw new Error(`A deployed build reads its settings from ../${name}, which is missing (cloudflare/README.md).`);
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
	if (target.vars && url.protocol !== "https:") throw new Error("MINERVA_DOWNLOAD_ORIGIN must be an https origin in a deployed build's vars file.");
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
