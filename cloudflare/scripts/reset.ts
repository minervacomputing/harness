// Resets an instance's data: its Durable Objects, its R2 buckets and its D1 database (cloudflare/README.md,
// Resetting an instance). For an instance that holds nothing worth keeping, such as after a change of a stored
// format; it cannot be undone.
//
//   node scripts/reset.ts --test                                lists what a reset of the test instance deletes (the only
//                                                               one, or the one --instance names); changes nothing
//   node scripts/reset.ts --test --yes                          resets it; then `pnpm run deploy:test`
//   node scripts/reset.ts --instance <name> --production [--yes]  the same for a production instance, which needs both
//                                                               its name and --production; then `pnpm run deploy --instance <name>`
//
// The instance comes from scripts/instance.ts (`chooseInstance`), and its kind must be the flag's, both in
// instance.json and on the account (scripts/identity.ts): --test for a test instance, --production for any other,
// which is never chosen by default. `pnpm assets` first. In order:
// 1. Takes the checkout's lock and the instance's, and pins every cf command to the instance's account
//    (scripts/run.ts, lockOperation and pinAccount; a first run records the account), then builds the app and the quiesced
//    instance (reset-worker/), locally. Every name below comes from the app's build, and each must be the
//    instance's own (scripts/instance.ts: its database, its two buckets, its container), or nothing happens.
// 2. Checks the instance's identity on the account (scripts/identity.ts: D1's identity row, else the live app's
//    bindings, else an empty D1), which must be the flag's kind; with --yes it then writes the identity row when it
//    is missing, the reset's first change, so that a reset that stops after quiescing still finds it when run
//    again. Then checks that the Worker, the database and the buckets the build binds exist on that account, that
//    the Worker has no Durable Object namespace of a class the build does not export, and that the container
//    applications linked to its namespaces are the build's own, by exact name. Nothing identifying is
//    printed: ids and the workers.dev subdomain are replaced in all output. Only the checked quiesced build is
//    uploaded.
// 3. Runs the read-only schema check (drift is expected and reported; a check that did not finish stops the
//    reset) and lists what the reset deletes: objects per class, objects per bucket and prefix, rows per table.
// With --yes:
// 4. Quiesces the instance: deploys reset-worker/ as its Worker, which answers 503, has no binding and retires
//    every class with an `exports` tombstone. That deletes each class's namespace with every object's storage
//    and alarms, wherever the object is located (EU included); a Sandbox object's container goes with it. It
//    waits until the Worker has no namespace left and its container applications run no instance, then
//    deletes those applications, which stay linked to the retired namespace (the deploy recreates them).
// 5. Empties each bucket, pages of up to 1,000 keys listed and deleted until a listing is empty, deletes it,
//    which R2 refuses while a multipart upload is in progress, and recreates it with its jurisdiction,
//    location, storage class and exactly r2-lifecycle.json's rules, checked afterwards. A bucket with settings
//    the recreation would lose (CORS, domains, notifications, locks, lifecycle rules not exactly as in
//    r2-lifecycle.json) stops the reset at step 2.
// 6. Deletes the D1 database and recreates it empty, with its location (or jurisdiction) and replication mode.
//    This comes last: the database holds the identity row, and once it is deleted the instance holds nothing,
//    which is what the identity check then finds (no row, the quiesced Worker, no tables).
// The instance answers 503 until the next deploy, which writes the identity row again, applies the migrations
// to the empty database and provisions every class afresh; the schema check must pass then. A reset that stops
// leaves what it did done: rerun it (a missing bucket or database is created first with README's First deploy
// commands).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workerExists } from "./account.ts";
import { buildAccount, buildDigest, ownContainer, readBuild } from "./builds.ts";
import { type Instance, chooseInstance, parseInstanceArgs } from "./instance.ts";
import { type LifecycleRule, lifecycleExtras, lifecycleMatches, lifecycleProblems } from "./lifecycle.ts";
import { CommandFailed, ROOT, cfJson, hide, hideOrigin, lockOperation, pinAccount, redact, run } from "./run.ts";
import { readOnly, rowsFrom } from "./schema.ts";

const USAGE = "Usage: reset.ts --test [--instance <name>] [--yes] | reset.ts --instance <name> --production [--yes]";
let INSTANCE: Instance;
let YES: boolean;
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const unknown = rest.filter((arg) => !["--test", "--production", "--yes"].includes(arg));
	const test = rest.includes("--test");
	const production = rest.includes("--production");
	if (unknown.length || test === production) {
		console.error(USAGE);
		process.exit(2);
	}
	// A production instance's name is given on the command line, never taken from the environment alone.
	if (production && flag === undefined) throw new Error(`A production instance is reset only by name: ${USAGE}`);
	INSTANCE = chooseInstance({ flag, test });
	if (production && INSTANCE.test) throw new Error(`${INSTANCE.name} is a test instance: reset it with --test.`);
	YES = rest.includes("--yes");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const NAMES = INSTANCE.names;
const NAME = NAMES.app;
const TEST = INSTANCE.test;
const MODE = TEST ? "faults" : "production";
/** This reset's own command line, for its messages. */
const COMMAND = `node scripts/reset.ts --instance ${INSTANCE.name} ${TEST ? "--test" : "--production"}`;
// Every command run below (cf build, the checks) chooses this instance.
process.env.MINERVA_INSTANCE = INSTANCE.name;
/** The only names a reset touches. */
const OWN = new Set([NAMES.d1, NAMES.bucket, NAMES.bucketEu]);
const RESET_DIR = join(ROOT, "reset-worker");
const PAGE = 1000;
const LOCATION_HINTS = ["apac", "eeur", "enam", "weur", "wnam", "oc"];

interface Bucket {
	name: string;
	jurisdiction: string | null;
	location?: string;
	storageClass?: string;
}
interface Namespace {
	id: string;
	name: string;
	script: string;
	class: string;
}
interface ContainerApp {
	id: string;
	name: string;
	durable_objects?: { namespace_id?: string };
	health?: { instances?: { active?: number; starting?: number } };
}

function step(message: string): void {
	console.log(`\n== ${message}`);
}

function stop(message: string): never {
	throw new CommandFailed(message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const scope = (bucket: Bucket) => (bucket.jurisdiction ? ["--cf-r2-jurisdiction", bucket.jurisdiction] : []);

/** One page of a bucket's keys, from the start or after `after`. */
function keys(bucket: Bucket, after?: string): string[] {
	const page = cfJson<{ key: string }[]>(["r2", "objects", "list", "--bucket-name", bucket.name, ...scope(bucket), "--per-page", String(PAGE), ...(after ? ["--start-after", after] : [])]);
	return page.map((object) => object.key);
}

/** Every key of a bucket, page by page. */
function allKeys(bucket: Bucket): string[] {
	const all: string[] = [];
	for (let page = keys(bucket); page.length; page = keys(bucket, page[page.length - 1])) all.push(...page);
	return all;
}

function countBy<T>(items: T[], key: (item: T) => string): string {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${name} ${count}`).join(", ") || "none";
}

/**
 * Whether a setting exists that cf reports as missing with an error: false only for that error's code
 * (`absentCode`), true when cf answers, and a stop for any other failure, so that a check that did not run
 * never reads as "nothing to lose".
 */
function absent(args: string[], absentCode: string): boolean {
	const answer = run("cf", args, { allowFailure: true });
	if (answer.status === 0) return true;
	if (answer.output.includes(`[${absentCode}]`)) return false;
	return stop(`\`cf ${args.slice(0, 4).join(" ")}\` failed:\n${redact(answer.output.trim())}`);
}

const lifecycleFile = () => JSON.parse(readFileSync(join(ROOT, "r2-lifecycle.json"), "utf8")) as LifecycleRule[];

/** Settings of a bucket that deleting and recreating it would lose, one line each. */
function bucketExtras(bucket: Bucket): string[] {
	const extras: string[] = [];
	const lifecycle = cfJson<{ rules?: LifecycleRule[] }>(["r2", "buckets", "lifecycle", "get", bucket.name, ...scope(bucket)]);
	for (const id of lifecycleExtras(lifecycleFile(), lifecycle.rules)) extras.push(`lifecycle rule "${id}" (not as in r2-lifecycle.json)`);
	if (absent(["r2", "buckets", "cors", "get", bucket.name, ...scope(bucket)], "10059")) extras.push("a CORS policy");
	const custom = cfJson<{ domains?: unknown[] } | unknown[]>(["r2", "buckets", "domains", "custom", "list", "--bucket-name", bucket.name, ...scope(bucket)]);
	if ((Array.isArray(custom) ? custom : (custom.domains ?? [])).length) extras.push("custom domains");
	const managed = cfJson<{ enabled?: boolean }>(["r2", "buckets", "domains", "managed", "list", "--bucket-name", bucket.name, ...scope(bucket)]);
	if (managed.enabled) extras.push("its r2.dev domain");
	if (absent(["r2", "buckets", "event-notifications", "list", "--bucket-name", bucket.name, ...scope(bucket)], "11015")) extras.push("event notifications");
	const locks = cfJson<{ rules?: unknown[] }>(["r2", "buckets", "locks", "get", bucket.name, ...scope(bucket)]);
	if ((locks.rules ?? []).length) extras.push("object locks");
	return extras;
}

function ownNamespaces(): Namespace[] {
	const namespaces = cfJson<Namespace[]>(["durable-objects", "namespaces", "list", "--per-page", "1000"]);
	if (namespaces.length >= 1000) stop("The account has 1,000 Durable Object namespaces or more, more than one page: list them by hand.");
	for (const namespace of namespaces) hide(namespace.id);
	return namespaces.filter((namespace) => namespace.script === NAME);
}

function containerApps(namespaceIds: Set<string>, names: Set<string>): ContainerApp[] {
	const apps = cfJson<ContainerApp[]>(["containers", "applications", "list"]);
	for (const app of apps) hide(app.id);
	return apps.filter((app) => names.has(app.name) || namespaceIds.has(app.durable_objects?.namespace_id ?? ""));
}

const running = (app: ContainerApp) => (app.health?.instances?.active ?? 0) + (app.health?.instances?.starting ?? 0);

function d1Query(id: string, sql: string) {
	return rowsFrom(run("cf", ["d1", "query", id, "--sql", readOnly(sql)]).stdout);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

let current = "taking the lock";
try {
	lockOperation(INSTANCE);
	current = "pinning the account";
	const account = pinAccount([ROOT, RESET_DIR], [MODE, `reset-${MODE}`], INSTANCE, { record: true });
	// 1. The builds, locally.
	current = "building";
	step("Building the app and the quiesced instance (local only)");
	if (!existsSync(join(ROOT, ".assets", "index.html"))) stop("Run `pnpm assets` first: the app's build needs the frontend in .assets/.");
	run("cf", ["build", "--mode", MODE]);
	run(process.execPath, ["scripts/bundle.ts"], { print: true });
	run("cf", ["build", "--mode", `reset-${MODE}`], { cwd: RESET_DIR });
	// The quiesced build is the one uploaded: its digest, taken now, is checked once it is checked and right
	// before the upload.
	const quietDigest = buildDigest(RESET_DIR);
	const named = buildAccount(RESET_DIR);
	if (named !== undefined && named !== account) stop("The quiesced instance's build names an account other than the one this reset is pinned to.");
	const app = readBuild(ROOT);
	const quiet = readBuild(RESET_DIR);
	hideOrigin(app.env?.MINERVA_SITE_URL?.value);
	hideOrigin(app.env?.MINERVA_DOWNLOAD_ORIGIN?.value);

	current = "reading the names from the build";
	if (app.name !== NAME) stop(`The app's build is ${app.name ?? "unnamed"}, not ${NAME}.`);
	if (quiet.name !== NAME) stop(`The quiesced instance's build is ${quiet.name ?? "unnamed"}, not ${NAME}.`);
	const bindings = Object.values(app.env ?? {});
	const databases = bindings.filter((binding) => binding.type === "d1");
	const d1Name = databases[0]?.name;
	if (databases.length !== 1 || !d1Name) stop(`The app's build binds ${databases.length} D1 databases, not one.`);
	const buckets: Bucket[] = bindings.filter((binding) => binding.type === "r2").map((binding) => ({ name: binding.name ?? "", jurisdiction: binding.jurisdiction ?? null }));
	if (buckets.length === 0) stop("The app's build binds no R2 bucket.");
	const classes = Object.entries(app.exports ?? {})
		.filter(([, entry]) => entry.type === "durable-object")
		.map(([name]) => name)
		.sort();
	const containers = new Set(
		Object.values(app.exports ?? {})
			.map((entry) => entry.container)
			.filter((name): name is string => typeof name === "string"),
	);
	const foreign = [d1Name, ...buckets.map((bucket) => bucket.name)].filter((name) => !OWN.has(name));
	const foreignContainers = [...containers].filter((name) => !ownContainer(INSTANCE.name, name));
	if (foreign.length || foreignContainers.length) stop(`The app's build of ${NAME} names resources that are not its own: ${[...foreign, ...foreignContainers].join(", ")}.`);
	const tombstones = Object.entries(quiet.exports ?? {});
	const retired = tombstones
		.filter(([, entry]) => entry.type === "durable-object" && entry.state === "deleted")
		.map(([name]) => name)
		.sort();
	if (tombstones.length !== retired.length || JSON.stringify(retired) !== JSON.stringify(classes)) stop(`The quiesced instance retires ${retired.join(", ") || "nothing"}, not the app's classes ${classes.join(", ")}.`);
	if (Object.keys(quiet.env ?? {}).length || quiet.assets) stop("The quiesced instance must have no binding and no assets.");
	if (buildDigest(RESET_DIR) !== quietDigest) stop("The quiesced instance's build changed while it was checked: run this again.");
	console.log(`${NAME}: D1 ${d1Name}; R2 ${buckets.map((bucket) => `${bucket.name}${bucket.jurisdiction ? ` (${bucket.jurisdiction})` : ""}`).join(", ")}; Durable Object classes ${classes.join(", ")}${containers.size ? `; containers ${[...containers].join(", ")}` : ""}.`);

	// 2. The account: the identity first, then the names.
	current = "checking the instance's identity";
	step(`The identity of ${NAME} on the account${YES ? " (recorded in D1 if it is not yet, the reset's first change)" : ""}`);
	run(process.execPath, ["scripts/identity.ts", "--instance", INSTANCE.name, TEST ? "--test" : "--production", ...(YES ? ["--record"] : [])], { print: true });

	current = "checking the account";
	step("Checking that each name is the instance's own on the account");
	if (!workerExists(NAME)) stop(`No Worker named ${NAME} on the account.`);

	const database = cfJson<{ uuid: string; name: string }[]>(["d1", "list", "--name", d1Name]).find((candidate) => candidate.name === d1Name);
	if (!database) stop(`No D1 database named ${d1Name}: create it with README's First deploy commands, then run this again.`);
	hide(database.uuid);
	const databaseInfo = cfJson<{ running_in_region?: string; read_replication?: { mode?: string }; jurisdiction?: string | null }>(["d1", "get", database.uuid]);

	for (const bucket of buckets) {
		const info = cfJson<{ jurisdiction?: string; location?: string; storage_class?: string }>(["r2", "buckets", "get", bucket.name, ...scope(bucket)]);
		if ((info.jurisdiction ?? "default") !== (bucket.jurisdiction ?? "default")) stop(`R2 bucket ${bucket.name} is in jurisdiction ${info.jurisdiction}, not ${bucket.jurisdiction ?? "default"}.`);
		bucket.location = info.location?.toLowerCase();
		bucket.storageClass = info.storage_class;
		const extras = bucketExtras(bucket);
		if (extras.length) stop(`R2 bucket ${bucket.name} has settings its recreation would lose: ${extras.join(", ")}. Reset it by hand.`);
	}

	const namespaces = ownNamespaces();
	const strays = namespaces.filter((namespace) => !classes.includes(namespace.class));
	if (strays.length) stop(`${NAME} has Durable Object namespaces of classes its build does not export (${strays.map((namespace) => namespace.class).join(", ")}): no tombstone would retire them.`);
	const apps = containerApps(new Set(namespaces.map((namespace) => namespace.id)), containers);
	const strayApps = apps.filter((containerApp) => !containers.has(containerApp.name));
	if (strayApps.length) stop(`Container applications that are not ${NAME}'s are linked to its namespaces: ${strayApps.map((containerApp) => containerApp.name).join(", ")}.`);
	console.log(`cf is signed in to the instance's account, where ${NAME}, its database, its ${buckets.length} buckets and ${namespaces.length} Durable Object namespaces were found.`);

	// 3. The schema check and what the reset deletes.
	current = "the schema check";
	step(`The schema check of ${d1Name}, read-only (drift is expected before a reset)`);
	const schema = run(process.execPath, ["scripts/schema-check.ts"], { print: true, allowFailure: true });
	if (schema.status === 1 && schema.output.includes(`The schema of ${NAME} is not what the migrations make:`)) console.log("Drift, as expected after a change of the stored formats: the reset recreates the database.");
	else if (schema.status !== 0) stop("The schema check could not run: fix it before the reset, which deletes what it reads.");

	current = "listing what the reset deletes";
	step("What the reset deletes");
	for (const namespace of namespaces) {
		const objects = cfJson<{ id: string; hasStoredData?: boolean }[]>(["durable-objects", "namespaces", "objects", "list", "--id", namespace.id, "--limit", "10000"]);
		const stored = objects.filter((object) => object.hasStoredData).length;
		console.log(`Durable Objects ${namespace.class}: ${objects.length >= 10000 ? "at least " : ""}${objects.length} objects, ${stored} with stored data`);
	}
	for (const containerApp of apps) console.log(`Container application ${containerApp.name}: ${running(containerApp)} instances running`);
	for (const bucket of buckets) {
		const all = allKeys(bucket);
		console.log(`R2 ${bucket.name}: ${all.length} objects (${countBy(all, (key) => `${key.split("/")[0]}/`)})`);
	}
	const tables = d1Query(database.uuid, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").map((row) => String(row.name));
	if (tables.length) {
		// One row of scalar subqueries: D1 limits the terms of a compound SELECT.
		const [counts = {}] = d1Query(database.uuid, `SELECT ${tables.map((table) => `(SELECT count(*) FROM ${quote(table)}) AS ${quote(table)}`).join(", ")}`);
		console.log(`D1 ${d1Name}: ${tables.length} tables (${tables.map((table) => `${table} ${String(counts[table])}`).join(", ")})`);
	} else console.log(`D1 ${d1Name}: no tables`);

	if (!YES) {
		console.log(`\nRead-only: nothing was changed. \`${COMMAND} --yes\` deletes all of the above.`);
		process.exit(0);
	}

	// 4. Quiesce: retire every class.
	current = "quiescing the instance";
	step(`Quiescing ${NAME}: deploying reset-worker/, which answers 503 and retires ${classes.join(", ")}`);
	if (buildDigest(RESET_DIR) !== quietDigest) stop("The quiesced instance's build changed after it was checked: run this again.");
	run("cf", ["deploy", "--prebuilt", "--no-provision"], { cwd: RESET_DIR, print: true });
	let left = ownNamespaces();
	for (let wait = 0; left.length && wait < 24; wait++) {
		await sleep(5000);
		left = ownNamespaces();
	}
	if (left.length) stop(`${NAME} still has the namespaces of ${left.map((namespace) => namespace.class).join(", ")} after two minutes: run this again.`);
	console.log(`${NAME} has no Durable Object namespace left: every object of ${classes.join(", ")} is deleted.`);
	let busy = containerApps(new Set(namespaces.map((namespace) => namespace.id)), containers).filter((containerApp) => running(containerApp) > 0);
	for (let wait = 0; busy.length && wait < 12; wait++) {
		await sleep(5000);
		busy = containerApps(new Set(namespaces.map((namespace) => namespace.id)), containers).filter((containerApp) => running(containerApp) > 0);
	}
	if (busy.length) stop(`Container applications still run instances: ${busy.map((containerApp) => containerApp.name).join(", ")}.`);
	// A container application stays linked to its retired namespace, and a deploy cannot move it to the new
	// one (cf: "could not finish applying its Durable Object-managed Container application settings"), so it
	// goes too; the next deploy creates it again, from the image already in the registry.
	const stale = containerApps(new Set(namespaces.map((namespace) => namespace.id)), containers);
	for (const containerApp of stale) {
		if (!containers.has(containerApp.name)) stop(`Container application ${containerApp.name} is not ${NAME}'s.`);
		run("cf", ["containers", "applications", "delete", containerApp.id, "--force"]);
	}
	const remaining = containerApps(new Set(namespaces.map((namespace) => namespace.id)), containers);
	if (remaining.length) stop(`Container applications ${remaining.map((containerApp) => containerApp.name).join(", ")} were not deleted.`);
	console.log(`No container instance is running${stale.length ? `; deleted the container applications ${stale.map((containerApp) => containerApp.name).join(", ")}, which the deploy recreates` : ""}.`);

	// 5. The buckets.
	for (const bucket of buckets) {
		current = `emptying ${bucket.name}`;
		step(`Emptying, deleting and recreating R2 ${bucket.name}`);
		let deleted = 0;
		let previous = "";
		for (let page = keys(bucket); page.length; page = keys(bucket)) {
			const first = page[0] as string;
			if (first === previous) stop(`R2 refused to delete ${first} in ${bucket.name}; ${deleted} objects were deleted.`);
			previous = first;
			run("cf", ["r2", "objects", "bulk-delete", "--bucket-name", bucket.name, ...scope(bucket), "--body", JSON.stringify(page), "--force"]);
			deleted += page.length;
		}
		if (keys(bucket).length) stop(`R2 ${bucket.name} is not empty after deleting ${deleted} objects.`);
		console.log(`Deleted ${deleted} objects; the listing is empty.`);
		current = `deleting ${bucket.name}`;
		const removal = run("cf", ["r2", "buckets", "delete", bucket.name, ...scope(bucket), "--force"], { allowFailure: true });
		if (removal.status !== 0) {
			stop(`R2 refused to delete the empty bucket ${bucket.name}, which it does while a multipart upload is in progress: abort them with the S3 API (ListMultipartUploads, AbortMultipartUpload), then run this again.\n${redact(removal.output.trim())}`);
		}
		if (run("cf", ["r2", "buckets", "get", bucket.name, ...scope(bucket)], { allowFailure: true }).status === 0) stop(`R2 bucket ${bucket.name} still exists after its deletion.`);
		current = `recreating ${bucket.name}`;
		const placement = bucket.jurisdiction ? [] : bucket.location && LOCATION_HINTS.includes(bucket.location) ? ["--location-hint", bucket.location] : [];
		run("cf", ["r2", "buckets", "create", "--name", bucket.name, ...scope(bucket), ...placement, ...(bucket.storageClass ? ["--storage-class", bucket.storageClass] : [])]);
		run("cf", ["r2", "buckets", "lifecycle", "update", bucket.name, ...scope(bucket), "--rules", "@r2-lifecycle.json", "--force"]);
		const info = cfJson<{ jurisdiction?: string; location?: string }>(["r2", "buckets", "get", bucket.name, ...scope(bucket)]);
		if ((info.jurisdiction ?? "default") !== (bucket.jurisdiction ?? "default")) stop(`The recreated bucket ${bucket.name} is in jurisdiction ${info.jurisdiction}.`);
		const rules = cfJson<{ rules?: LifecycleRule[] }>(["r2", "buckets", "lifecycle", "get", bucket.name, ...scope(bucket)]).rules;
		const problems = lifecycleProblems(bucket.name, rules);
		if (problems.length) stop(problems.join("\n"));
		if (!lifecycleMatches(lifecycleFile(), rules)) stop(`The recreated bucket ${bucket.name}'s lifecycle rules are not exactly r2-lifecycle.json's.`);
		if (keys(bucket).length) stop(`The recreated bucket ${bucket.name} is not empty.`);
		console.log(`Recreated ${bucket.name} (${info.jurisdiction ?? "default"} jurisdiction, ${info.location ?? "no location"}) with r2-lifecycle.json; it is empty.`);
	}

	// 6. The database.
	current = `deleting D1 ${d1Name}`;
	step(`Deleting and recreating D1 ${d1Name}`);
	run("cf", ["d1", "delete", database.uuid, "--force"]);
	if (cfJson<{ name: string }[]>(["d1", "list", "--name", d1Name]).some((candidate) => candidate.name === d1Name)) stop(`D1 ${d1Name} still exists after its deletion.`);
	current = `recreating D1 ${d1Name}`;
	const region = databaseInfo.running_in_region?.toLowerCase();
	const placement = databaseInfo.jurisdiction ? ["--jurisdiction", databaseInfo.jurisdiction] : region && LOCATION_HINTS.includes(region) ? ["--primary-location-hint", region] : [];
	const created = run("cf", ["d1", "create", "--name", d1Name, ...placement, "--read-replication-mode", databaseInfo.read_replication?.mode === "auto" ? "auto" : "disabled"]);
	const fresh = cfJson<{ uuid: string; name: string }[]>(["d1", "list", "--name", d1Name]).find((candidate) => candidate.name === d1Name);
	if (!fresh) stop(`D1 ${d1Name} was not recreated:\n${redact(created.output.trim())}`);
	hide(fresh.uuid);
	const tablesLeft = d1Query(fresh.uuid, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
	if (Number(tablesLeft[0]?.n) !== 0) stop(`The recreated database ${d1Name} has tables.`);
	console.log(`Recreated ${d1Name} (${databaseInfo.jurisdiction ?? region ?? "default location"}, replication ${databaseInfo.read_replication?.mode ?? "disabled"}); it has no tables.`);

	console.log(
		`\n${NAME} is reset and answers 503 until it is deployed: run \`pnpm run deploy --instance ${INSTANCE.name}\`, which applies the migrations to the empty database and provisions every Durable Object class afresh, then \`node scripts/schema-check.ts --instance ${INSTANCE.name}\`, which must pass.`,
	);
} catch (error) {
	console.error(`\nThe reset stopped while ${current}:\n${redact(error instanceof Error ? error.message : String(error))}`);
	console.error("What was done before stays done; see cloudflare/README.md, Resetting an instance.");
	process.exit(1);
}
