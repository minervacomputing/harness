// What 13b retired and a deploy deletes from the instance's account, once the app is uploaded: the app Worker's
// retired secrets, which `cf deploy --secrets-file` keeps since it never deletes one, and the download Worker
// (docs/plans/chunk-13c-design.md, amendment 6). Unit 5 of 13c deletes this file, once every instance has had a
// deploy with it.

import { workerExists } from "./account.ts";
import { type BuiltWorker, declaredSecrets } from "./builds.ts";
import { CommandFailed, cfJson, redact, run } from "./run.ts";

const RETIRED = new Set(["MINERVA_ENCRYPTION_KEYS", "MINERVA_DOWNLOAD_KEY", "MINERVA_SETUP_KEY"]);
/** The connectors' OAuth clients, which Laravel registers since 13b. */
const RETIRED_CLIENT = /^MINERVA_[A-Z0-9_]+_CLIENT_(ID|SECRET)$/;

/**
 * The secrets on a Worker that its build does not declare: `retired`, those 13b retired, which a deploy deletes, and
 * `other`, which it only names. Any other undeclared secret stays: MINERVA_LARAVEL_TOKEN, say, is declared only while
 * secrets.env sets it, and a missing line there must not delete the live token.
 */
export function undeclaredSecrets(onWorker: string[], app: BuiltWorker): { retired: string[]; other: string[] } {
	const declared = new Set(declaredSecrets(app));
	const undeclared = [...new Set(onWorker)].filter((name) => !declared.has(name)).sort();
	const isRetired = (name: string) => RETIRED.has(name) || RETIRED_CLIENT.test(name);
	return { retired: undeclared.filter(isRetired), other: undeclared.filter((name) => !isRetired(name)) };
}

function secretNames(worker: string): string[] {
	const secrets = cfJson<{ name?: unknown }[]>(["workers", "secrets", "list", "--worker", worker]);
	if (!Array.isArray(secrets) || secrets.some((secret) => typeof secret?.name !== "string")) throw new CommandFailed("`cf workers secrets list` did not answer a list of names.");
	return secrets.map((secret) => String(secret.name));
}

/**
 * Deletes the retired secrets from the Worker, names the other undeclared ones, and checks the result. One bulk patch
 * makes one new version for all of them, where `cf workers secrets delete` makes one per secret; whatever the patch
 * leaves (it is untried on the account) is then deleted one at a time, and the output says which way each went.
 */
export function deleteRetiredSecrets(worker: string, app: BuiltWorker): void {
	const { retired, other } = undeclaredSecrets(secretNames(worker), app);
	if (other.length) console.log(`Left on ${worker}, neither declared by its build nor retired: ${other.join(", ")}.`);
	if (!retired.length) {
		console.log(`${worker} has none of the retired secrets.`);
		return;
	}
	// The API's body: `secrets`, a JSON Merge Patch of the Worker's secrets, in which null deletes.
	const bulk = run("cf", ["workers", "secrets", "bulk", "--worker", worker, "--body", JSON.stringify({ secrets: Object.fromEntries(retired.map((name) => [name, null])) })], { allowFailure: true });
	const unpatched = undeclaredSecrets(secretNames(worker), app).retired;
	const patched = retired.filter((name) => !unpatched.includes(name));
	if (patched.length) console.log(`Deleted ${patched.join(", ")} from ${worker} with one bulk patch.`);
	if (unpatched.length) {
		const failed = bulk.status === 0 ? "" : ` failed (exit ${bulk.status}): ${redact(bulk.output.trim())}\nIt`;
		console.log(`The bulk patch${failed} left ${unpatched.join(", ")}: deleting them one at a time.`);
		for (const name of unpatched) run("cf", ["workers", "secrets", "delete", name, "--worker", worker, "--force"]);
		const left = undeclaredSecrets(secretNames(worker), app).retired;
		if (left.length) throw new CommandFailed(`${worker} still has the retired secrets ${left.join(", ")} after their deletion.`);
		console.log(`Deleted ${unpatched.join(", ")} from ${worker} one at a time.`);
	}
}

/** Deletes the Worker `name` when the account has it, and checks that it is gone: an aborted delete exits 0. */
export function deleteWorker(name: string): void {
	if (!workerExists(name)) {
		console.log(`The account has no Worker named ${name}.`);
		return;
	}
	run("cf", ["workers", "delete", name, "--force"]);
	if (workerExists(name)) throw new CommandFailed(`${name} still exists after its deletion.`);
	console.log(`Deleted the Worker ${name}.`);
}
