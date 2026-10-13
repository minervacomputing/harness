import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { instanceForMode } from "../scripts/instance.ts";

// The quiesced instance, deployed by scripts/reset.ts in place of an instance's app while its data is reset
// (cloudflare/README.md, Resetting an instance). It takes the app's name and retires every Durable Object
// class the app exports, with `exports` tombstones (`state: "deleted"`), which delete each class's namespace
// and all of its objects' storage, wherever they are located. Its own code exports no class and it has no
// binding, as a tombstone requires, so every request answers 503 until the next deploy of the app provisions
// the classes afresh.
//
// The name and the classes are read from the app's build in ../.cloudflare/output/ (`cf build`, which
// scripts/reset.ts runs first), never from a pattern, and only for the instance being reset (scripts/instance.ts,
// `instanceForMode`: MINERVA_INSTANCE, which scripts/reset.ts sets), whose kind must be the mode's: mode
// `reset-faults` for a test instance and `reset-production` for a production one. Any other mode, cf's default
// included, stops the build.

// This file runs in Node but is type-checked with the Worker's runtime types, which lack Node's.
const here = (import.meta as unknown as { url: string }).url;
interface BuildProcess {
	getBuiltinModule(id: "node:fs"): { readFileSync(path: URL, encoding: "utf8"): string };
}
const build = (globalThis as unknown as { process: BuildProcess }).process;

/** The app's mode for each of this Worker's. */
const MODES: Record<string, "faults" | "production"> = { "reset-faults": "faults", "reset-production": "production" };

interface BuiltWorker {
	name?: string;
	exports?: Record<string, { type?: string; state?: string }>;
}

export default defineConfig(({ mode }) => {
	const appMode = mode ? MODES[mode] : undefined;
	if (!appMode) throw new Error("The quiesced instance is built by scripts/reset.ts, with mode reset-faults or reset-production.");
	const name = instanceForMode(appMode).names.app;
	let built: BuiltWorker;
	try {
		built = JSON.parse(build.getBuiltinModule("node:fs").readFileSync(new URL("../.cloudflare/output/v0/workers/default/worker.config.json", here), "utf8")) as BuiltWorker;
	} catch {
		throw new Error("The app's build is missing: run `cf build` in cloudflare/ for the same instance first (scripts/reset.ts does).");
	}
	if (built.name !== name) throw new Error(`The app's build in .cloudflare/output/ is ${built.name ?? "unnamed"}, not ${name}.`);
	const classes = Object.entries(built.exports ?? {}).filter(([, entry]) => entry.type === "durable-object");
	if (classes.length === 0) throw new Error(`The app's build of ${name} exports no Durable Object class.`);
	const notLive = classes.filter(([, entry]) => (entry.state ?? "created") !== "created").map(([className]) => className);
	if (notLive.length) throw new Error(`The app's build of ${name} has Durable Object exports that are not live classes: ${notLive.join(", ")}.`);
	return {
		worker: {
			name,
			compatibilityDate: "2026-10-06",
			entrypoint,
			workersDev: true,
			previewUrls: false,
			observability: { enabled: true, redactQueryString: true },
			exports: Object.fromEntries(classes.map(([className]) => [className, exports.durableObject({ state: "deleted" })])),
		},
	};
});
