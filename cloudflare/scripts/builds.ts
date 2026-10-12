// What `cf build` leaves in .cloudflare/output/ (the Build Output Specification), as scripts/deploy.ts and
// scripts/reset.ts read it before anything on the account changes: the Worker's name, its bindings with the
// resources they name, and its exports.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const OUTPUT = ".cloudflare/output/v0/workers/default/worker.config.json";

export interface Binding {
	type?: string;
	name?: string;
	jurisdiction?: string;
	value?: unknown;
}

export interface BuiltWorker {
	name?: string;
	env?: Record<string, Binding>;
	exports?: Record<string, { type?: string; state?: string; container?: string }>;
	assets?: unknown;
}

export function readBuild(dir: string): BuiltWorker {
	return JSON.parse(readFileSync(join(dir, OUTPUT), "utf8")) as BuiltWorker;
}

/**
 * A digest of everything in a directory's build output, which `cf deploy --prebuilt` uploads: taken right
 * after the build, compared after the build is checked (so the digest is of the checked build) and again right
 * before the upload, so that only the checked build goes up. A symbolic link or other special file in the
 * output throws: what it points to could change unseen.
 */
export function buildDigest(dir: string): string {
	const root = join(dir, ".cloudflare", "output");
	const hash = createHash("sha256");
	const entries = readdirSync(root, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[];
	const special = entries.filter((entry) => !entry.isFile() && !entry.isDirectory());
	if (special.length) throw new Error(`The build output in ${root} has entries that are not plain files: ${special.map((entry) => entry.name).join(", ")}.`);
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	for (const file of files) {
		hash.update(`${file.slice(root.length)}\0`);
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** A digest of a file's content (a secrets file read twice, say: the same digest, the same values). */
export function fileDigest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The account a directory's build output names, if any: `cf deploy --prebuilt` would upload there instead of
 * the account the run is pinned to (cloudflare.config.ts's `accountId`, which no config here sets).
 */
export function buildAccount(dir: string): string | undefined {
	const named = [join(dir, ".cloudflare", "output", "v0", "config.json"), join(dir, OUTPUT)]
		.map((file) => (JSON.parse(readFileSync(file, "utf8")) as { accountId?: unknown; account_id?: unknown }))
		.flatMap((config) => [config.accountId, config.account_id])
		.filter((id) => id !== undefined);
	return named.length ? String(named[0]) : undefined;
}

/** A Worker's R2 bindings, one line each (`FILES=bucket (jurisdiction)`), sorted. */
function buckets(worker: BuiltWorker): string[] {
	return Object.entries(worker.env ?? {})
		.filter(([, binding]) => binding.type === "r2")
		.map(([variable, binding]) => `${variable}=${binding.name ?? ""}${binding.jurisdiction ? ` (${binding.jurisdiction})` : ""}`)
		.sort();
}

/**
 * What is wrong with an instance's two builds, one line each; empty when the download origin is the
 * instance's own. It fails closed: the app must be `expected.app`, the download origin `expected.files`,
 * bound to exactly the app's buckets, every bucket one of the instance's (`<app>-files`, `<app>-files-eu`),
 * with MINERVA_DOWNLOAD_KEY its only secret and the app's MINERVA_DOWNLOAD_ORIGIN. So a test build can never
 * deploy over production's download origin or read production's buckets, nor the other way round.
 */
export function filesBuildProblems(app: BuiltWorker, files: BuiltWorker, expected: { app: string; files: string }): string[] {
	const problems: string[] = [];
	if (app.name !== expected.app) problems.push(`The app's build is ${app.name ?? "unnamed"}, not ${expected.app}.`);
	if (files.name !== expected.files) problems.push(`The download origin's build is ${files.name ?? "unnamed"}, not ${expected.files}.`);
	const own = new Set([`${expected.app}-files`, `${expected.app}-files-eu`]);
	for (const [worker, build] of [
		["app", app],
		["download origin", files],
	] as const) {
		const foreign = Object.values(build.env ?? {})
			.filter((binding) => binding.type === "r2" && !own.has(binding.name ?? ""))
			.map((binding) => binding.name ?? "unnamed");
		if (foreign.length) problems.push(`The ${worker}'s build binds buckets that are not ${expected.app}'s: ${foreign.join(", ")}.`);
	}
	const appBuckets = buckets(app);
	const filesBuckets = buckets(files);
	if (filesBuckets.length === 0 || JSON.stringify(filesBuckets) !== JSON.stringify(appBuckets)) {
		problems.push(`The download origin's buckets (${filesBuckets.join(", ") || "none"}) are not the app's (${appBuckets.join(", ") || "none"}).`);
	}
	const kinds = Object.values(files.env ?? {}).map((binding) => binding.type);
	if (kinds.some((kind) => kind !== "r2" && kind !== "text" && kind !== "secret")) problems.push(`The download origin's build has bindings it should not have: ${kinds.join(", ")}.`);
	const secrets = Object.entries(files.env ?? {})
		.filter(([, binding]) => binding.type === "secret")
		.map(([variable]) => variable);
	if (JSON.stringify(secrets) !== JSON.stringify(["MINERVA_DOWNLOAD_KEY"])) problems.push(`The download origin must hold MINERVA_DOWNLOAD_KEY alone, not ${secrets.join(", ") || "nothing"}.`);
	const origin = (worker: BuiltWorker) => worker.env?.MINERVA_DOWNLOAD_ORIGIN?.value;
	if (typeof origin(files) !== "string" || origin(files) !== origin(app)) problems.push("The download origin's MINERVA_DOWNLOAD_ORIGIN is not the app's.");
	return problems;
}

/** A binding of a deployed version, as `cf workers versions get` answers it. */
export interface LiveBinding {
	type?: string;
	bucket_name?: string;
	jurisdiction?: string;
	text?: string;
}

/**
 * How the app actually serving (`live`, its deployed version's bindings) differs from the app's local build in
 * what the download origin shares with it, one line each: the buckets and MINERVA_DOWNLOAD_ORIGIN. A deploy of
 * the download origin alone checks it, since it compares the download origin's build with the local app build.
 */
export function liveAppProblems(live: Record<string, LiveBinding> | undefined, app: BuiltWorker): string[] {
	const problems: string[] = [];
	const liveBuckets = Object.entries(live ?? {})
		.filter(([, binding]) => binding.type === "r2_bucket")
		.map(([variable, binding]) => `${variable}=${binding.bucket_name ?? ""}${binding.jurisdiction && binding.jurisdiction !== "default" ? ` (${binding.jurisdiction})` : ""}`)
		.sort();
	if (JSON.stringify(liveBuckets) !== JSON.stringify(buckets(app))) problems.push(`The deployed app binds ${liveBuckets.join(", ") || "no bucket"}, its local build ${buckets(app).join(", ") || "none"}.`);
	const origin = live?.MINERVA_DOWNLOAD_ORIGIN;
	if (origin?.type !== "plain_text" || origin.text !== app.env?.MINERVA_DOWNLOAD_ORIGIN?.value) problems.push("The deployed app's MINERVA_DOWNLOAD_ORIGIN is not its local build's.");
	return problems;
}

/**
 * Whether a container (an application's name) is the instance's own: `<instance>-<word>`, one word, as
 * cloudflare.config.ts names it (`${name}-sandbox`). So minerva-cf-test-sandbox is never production's.
 */
export function ownContainer(instance: string, name: string): boolean {
	return name.startsWith(`${instance}-`) && /^[a-z0-9]+$/.test(name.slice(instance.length + 1));
}
