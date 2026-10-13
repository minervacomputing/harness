// Measures the startup CPU of the Worker built in .cloudflare/output/ (`cf build`), locally, and fails above a
// threshold (cloudflare/README.md, Startup). Cloudflare refuses a version whose global scope takes more than
// its startup limit (`10021 Script startup exceeded CPU time limit`), which nothing checks before the upload.
//
//   node scripts/startup.ts            measures the build in .cloudflare/output/ (`pnpm run deploy` does, after its build)
//   node scripts/startup.ts --build    builds production's entry (src/index.ts) first, with local settings (`pnpm startup`)
//
// `cf workers check --prebuilt` imports the build's entry in a local workerd (from a handler of its own: no
// request reaches the Worker), profiles that, and reports the CPU time in it; nothing reaches the account. So
// what is loaded on first use (the connectors, the API router) is not measured. The measure is taken three
// times and the least kept: noise only adds. For a profile to read, run `cf workers check --prebuilt` itself.
// It is not Cloudflare's own number, which is several times higher (a build that measured about 160 ms here
// was refused), so the threshold keeps a wide margin under that.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.ts";

/** Active CPU in milliseconds, as `cf workers check` reports it, above which the build is refused. */
const STARTUP_LIMIT_MS = 110;
const RUNS = 3;

interface Check {
	bundle: { sizeBytes: number };
	startup: { activeTimeMs: number };
}

const unknown = process.argv.slice(2).filter((arg) => arg !== "--build");
if (unknown.length) {
	console.error(`Unknown arguments: ${unknown.join(" ")}. Usage: startup.ts [--build]`);
	process.exit(2);
}
// Mode standalone builds src/index.ts with the defaults of cloudflare.config.ts under a local name, so it needs no
// instance and no settings file.
if (process.argv.includes("--build")) run("cf", ["build", "--mode", "standalone"]);

const dir = mkdtempSync(join(tmpdir(), "minerva-startup-"));
const checks: Check[] = [];
try {
	for (let i = 0; i < RUNS; i++) {
		const { stdout } = run("cf", ["workers", "check", "--prebuilt", "--outfile", join(dir, `startup-${i}.cpuprofile`)]);
		checks.push(JSON.parse(stdout) as Check);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const active = checks.map((check) => check.startup.activeTimeMs);
const best = Math.min(...active);
const name = (JSON.parse(readFileSync(new URL("../.cloudflare/output/v0/workers/default/worker.config.json", import.meta.url), "utf8")) as { name: string }).name;
const size = (checks[0].bundle.sizeBytes / 2 ** 20).toFixed(1);
console.log(`Startup of ${name} (${size} MiB): ${best.toFixed(0)} ms of CPU at best (runs: ${active.map((ms) => ms.toFixed(0)).join(", ")} ms), limit ${STARTUP_LIMIT_MS} ms.`);
if (best > STARTUP_LIMIT_MS) {
	console.error(
		`The Worker's startup takes more CPU than ${STARTUP_LIMIT_MS} ms, too close to Cloudflare's startup limit: move work out of module scope (cloudflare/README.md, Startup).`,
	);
	process.exit(1);
}
