// Before a deploy: checks that the account's resources exist with the settings the engine relies on, then
// applies D1's migrations (migrations/) before `cf deploy` uploads code that may need them. Migrations are
// additive, so the running version keeps working (ARCHITECTURE.md: Spike results, Versions). cf would otherwise create a missing D1
// database or bucket with default settings on deploy (no lifecycle rule, no schema, no jurisdiction), so a
// missing one stops the deploy here. Resource ids are never printed. scripts/deploy.ts runs it for the instance it
// deploys (MINERVA_INSTANCE; by hand, `--instance <name>`, or `--test` for the only test instance, as
// scripts/instance.ts chooses), whose names come from scripts/instance.ts; `--check` only checks, for a deploy of
// the download origin alone. Its cf commands go to the instance's recorded account (scripts/run.ts, pinAccount),
// and run by hand it takes the deploy's locks before applying migrations (under scripts/deploy.ts, which holds
// them, it does not).

import { execFileSync } from "node:child_process";
import { type Names, chooseInstance, parseInstanceArgs } from "./instance.ts";
import { type LifecycleRule, lifecycleProblems } from "./lifecycle.ts";
import { ROOT, lockOperationUnlessParentHolds, pinAccount } from "./run.ts";

let NAMES: Names;
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const unknown = rest.filter((arg) => arg !== "--test" && arg !== "--check");
	if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(" ")}. Usage: resources.ts [--instance <name> | --test] [--check]`);
	const instance = chooseInstance({ flag, test: rest.includes("--test") });
	if (!rest.includes("--check")) lockOperationUnlessParentHolds(instance);
	pinAccount([ROOT], [], instance, { record: false });
	NAMES = instance.names;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
const D1 = NAMES.d1;
const BUCKETS: { name: string; jurisdiction: string | null }[] = [
	{ name: NAMES.bucket, jurisdiction: null },
	{ name: NAMES.bucketEu, jurisdiction: "eu" },
];
const GATEWAY = NAMES.gateway;

function cf(args: string[]): unknown {
	try {
		return JSON.parse(execFileSync("cf", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch {
		return null;
	}
}

function fail(message: string): never {
	console.error(`${message} See cloudflare/README.md, First deploy.`);
	process.exit(1);
}

const databases = (cf(["d1", "list", "--name", D1]) ?? []) as { uuid: string; name: string }[];
const database = databases.find((candidate) => candidate.name === D1);
if (!database) fail(`No D1 database named ${D1}.`);

for (const bucket of BUCKETS) {
	const scope = bucket.jurisdiction ? ["--cf-r2-jurisdiction", bucket.jurisdiction] : [];
	const found = cf(["r2", "buckets", "get", bucket.name, ...scope]) as { jurisdiction?: string } | null;
	if (!found) fail(`No R2 bucket named ${bucket.name}${bucket.jurisdiction ? ` in the ${bucket.jurisdiction} jurisdiction` : ""}.`);
	if ((found.jurisdiction ?? "default") !== (bucket.jurisdiction ?? "default")) fail(`R2 bucket ${bucket.name} is in the wrong jurisdiction.`);
	const lifecycle = cf(["r2", "buckets", "lifecycle", "get", bucket.name, ...scope]) as { rules?: LifecycleRule[] } | null;
	// Both buckets carry both rules (r2-lifecycle.json); only the default one holds static/ (src/http/assets.ts).
	const problems = lifecycleProblems(bucket.name, lifecycle?.rules);
	if (problems.length) fail(problems.join("\n"));
}

const gateway = cf(["ai-gateway", "gateways", "get", GATEWAY]) as { collect_logs?: boolean; authentication?: boolean } | null;
if (!gateway) fail(`No AI Gateway named ${GATEWAY}.`);
if (gateway.collect_logs !== false) fail(`AI Gateway ${GATEWAY} must not log prompts (collect_logs false).`);
// The gateway uses the provider keys it stores (OpenAI, Anthropic) only when authenticated; the binding needs no token.
if (gateway.authentication !== true) fail(`AI Gateway ${GATEWAY} must be authenticated (authentication true), or it never uses its stored provider keys.`);
console.log("D1, R2 and AI Gateway are in place.");
if (process.argv.includes("--check")) process.exit(0);

// It answers with the migrations it applied, as JSON. Its output and errors name the database's id, so
// both are captured and the id replaced before anything is printed.
let applied: string;
try {
	applied = execFileSync("cf", ["d1", "migrations", "apply", database.uuid, "--dir", "migrations"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		.replaceAll(database.uuid, "<database>")
		.trim();
} catch (error) {
	const { stdout, stderr } = error as { stdout?: string; stderr?: string };
	const output = `${stdout ?? ""}${stderr ?? ""}`.replaceAll(database.uuid, "<database>").trim();
	fail(`Applying D1 migrations failed:\n${output || "(no output)"}\n`);
}
console.log(applied === "[]" ? "D1 migrations are up to date." : `Applied D1 migrations: ${applied}`);
