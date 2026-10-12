// Before a deploy: checks that the account's resources exist with the settings the plan relies on, then
// applies D1's migrations (migrations/) before `cf deploy` uploads code that may need them. Migrations are
// additive, so the running version keeps working (plan: Versions). cf would otherwise create a missing D1
// database or bucket with default settings on deploy (no lifecycle rule, no schema, no jurisdiction), so a
// missing one stops the deploy here. Resource ids are never printed. `pnpm run deploy` runs it, and
// `pnpm run deploy:test` with `--test` for the test Worker's own minerva-cf-test resources.

import { execFileSync } from "node:child_process";

const PREFIX = process.argv.includes("--test") ? "minerva-cf-test" : "minerva-cf";
const D1 = PREFIX;
const BUCKETS: { name: string; jurisdiction: string | null }[] = [
	{ name: `${PREFIX}-files`, jurisdiction: null },
	{ name: `${PREFIX}-files-eu`, jurisdiction: "eu" },
];
const GATEWAY = PREFIX;
const UPLOADS_RULE = "Expire unattached uploads";
const ARCHIVE_RULE = "Expire archived assets";

function cf(args: string[]): unknown {
	try {
		return JSON.parse(execFileSync("cf", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch {
		return null;
	}
}

interface LifecycleRule {
	id: string;
	enabled?: boolean;
	conditions?: { prefix?: string };
	deleteObjectsTransition?: { condition?: { type?: string; maxAge?: number } };
}

/** The rule in r2-lifecycle.json, enabled and deleting uploads/ objects at most a day after they were written. */
function expiresUploads(rule: LifecycleRule): boolean {
	const condition = rule.deleteObjectsTransition?.condition;
	return (
		rule.id === UPLOADS_RULE &&
		rule.enabled === true &&
		rule.conditions?.prefix === "uploads/" &&
		condition?.type === "Age" &&
		typeof condition.maxAge === "number" &&
		condition.maxAge > 0 &&
		condition.maxAge <= 86400
	);
}

/** The rule that deletes the asset archive (static/) 30 days after a build's files were copied; without it old builds' files stay. */
function expiresArchive(rule: LifecycleRule): boolean {
	const condition = rule.deleteObjectsTransition?.condition;
	return rule.id === ARCHIVE_RULE && rule.enabled === true && rule.conditions?.prefix === "static/" && condition?.type === "Age" && typeof condition.maxAge === "number" && condition.maxAge > 0;
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
	if (!lifecycle?.rules?.some(expiresUploads)) {
		fail(`R2 bucket ${bucket.name} lacks the enabled lifecycle rule that deletes uploads/ after a day (r2-lifecycle.json).`);
	}
	// Only a cost, not a safety rule: the files bucket keeps previous builds' hashed assets under static/ (src/http/assets.ts).
	if (bucket.jurisdiction === null && !lifecycle.rules.some(expiresArchive)) {
		console.warn(`Warning: R2 bucket ${bucket.name} has no lifecycle rule that expires static/ (r2-lifecycle.json), so archived assets of old builds stay.`);
	}
}

const gateway = cf(["ai-gateway", "gateways", "get", GATEWAY]) as { collect_logs?: boolean } | null;
if (!gateway) fail(`No AI Gateway named ${GATEWAY}.`);
if (gateway.collect_logs !== false) fail(`AI Gateway ${GATEWAY} must not log prompts (collect_logs false).`);
console.log("D1, R2 and AI Gateway are in place.");

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
