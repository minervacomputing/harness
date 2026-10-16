// What `cf build` leaves in .cloudflare/output/ (the Build Output Specification), as scripts/deploy.ts and
// scripts/reset.ts read it before anything on the account changes: the Worker's name, its bindings with the
// resources they name, and its exports.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { namesOf } from "./instance.ts";

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

/** The image a build gives a container application: a registry reference, or an image the build made locally. */
export function builtImage(dir: string, container: string): { reference?: string; localReference?: string } | undefined {
	const file = join(dir, ".cloudflare", "output", "v0", "containers", container, "container.config.json");
	return (JSON.parse(readFileSync(file, "utf8")) as { images?: { base?: { reference?: string; localReference?: string } } }).images?.base;
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

/**
 * What is wrong with an instance's app build, one line each; empty when it is the instance's own. It fails closed:
 * the build must be the instance's Worker (scripts/instance.ts) and bind only the instance's buckets, so a test build
 * can never deploy over production's Worker or read production's buckets, nor the other way round.
 */
export function appBuildProblems(app: BuiltWorker, instance: string): string[] {
	const expected = namesOf(instance);
	const problems: string[] = [];
	if (app.name !== expected.app) problems.push(`The app's build is ${app.name ?? "unnamed"}, not ${expected.app}.`);
	const own = new Set([expected.bucket, expected.bucketEu]);
	const foreign = Object.values(app.env ?? {})
		.filter((binding) => binding.type === "r2" && !own.has(binding.name ?? ""))
		.map((binding) => binding.name ?? "unnamed");
	if (foreign.length) problems.push(`The app's build binds buckets that are not ${expected.app}'s: ${foreign.join(", ")}.`);
	return problems;
}

/** A binding of a deployed version, as `cf workers versions get` answers it. */
export interface LiveBinding {
	type?: string;
	bucket_name?: string;
	jurisdiction?: string;
	text?: string;
	/** A Durable Object binding's class. */
	class_name?: string;
}

/**
 * Whether a container (an application's name) is the instance's own: exactly the name scripts/instance.ts
 * derives (`<instance>-sandbox`), which cloudflare.config.ts gives it. So the test instance's sandbox is never
 * production's, and a container that merely starts with the instance's name is not its own.
 */
export function ownContainer(instance: string, name: string): boolean {
	return name === namesOf(instance).container;
}
