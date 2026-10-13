// Checks a built Worker (`cf build`, in .cloudflare/output/) for the test build's code (src/faults/ and the
// fake model it uses, src/model/fake.ts): the production build must contain none of it, the test build all
// of it. scripts/deploy.ts and scripts/reset.ts run it on the build of the instance they work on
// (MINERVA_INSTANCE; by hand, `--instance <name>`, or `--test` for the only test instance): the build must be
// that instance's, and the test build exactly when it is a test instance.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Instance, chooseInstance, parseInstanceArgs } from "./instance.ts";

const OUTPUT = fileURLToPath(new URL("../.cloudflare/output/v0/workers/default/", import.meta.url));
// Strings only the test build has: src/faults/'s objects (the fake provider and the mailbox that captures
// emails), its tables, its fake provider's host, its driver's token label (`minerva.faults-token`) and header
// (`X-Minerva-Faults-Token`), and the fake model's API name.
const MARKERS = ["FaultProvider", "FaultMailbox", "fault_plan", "notes.fake.invalid", "minerva.faults", "X-Minerva-Faults", "minerva-fake"];

let instance: Instance;
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	if (rest.some((arg) => arg !== "--test")) throw new Error("Usage: bundle.ts [--instance <name> | --test]");
	instance = chooseInstance({ flag, test: rest.includes("--test") });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const test = instance.test;
const config = JSON.parse(readFileSync(join(OUTPUT, "worker.config.json"), "utf8")) as { name: string };
const expected = instance.names.app;
if (config.name !== expected) {
	console.error(`The build in .cloudflare/output/ is ${config.name}, not ${expected}.`);
	process.exit(1);
}
const found = new Set<string>();
for (const path of readdirSync(join(OUTPUT, "bundle"), { recursive: true, encoding: "utf8" })) {
	if (!path.endsWith(".js")) continue;
	const text = readFileSync(join(OUTPUT, "bundle", path), "utf8");
	for (const marker of MARKERS) if (text.includes(marker)) found.add(marker);
}
if (test && found.size !== MARKERS.length) {
	console.error(`The test build lacks ${MARKERS.filter((marker) => !found.has(marker)).join(", ")}.`);
	process.exit(1);
}
if (!test && found.size > 0) {
	console.error(`The production build contains the test build's ${[...found].join(", ")}.`);
	process.exit(1);
}
console.log(test ? "The test build has its fault points, driver and fake model." : "The production build has no fault points, driver or fake model.");
