// Writing to an instance's directory (scripts/instance.ts, The instance directory): only the scripts do, and
// only while they hold the instance's lock (scripts/run.ts, `lockInstance` and `lockOperation`), which every
// write here checks. A write goes to a temporary file in the same directory, owner-only, which is then renamed
// into place, so a reader sees the old file or the new one, never part of one. Nothing written is printed.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_FILES, type Instance, type InstanceFile, checkDirectory, instanceNameProblem, parseInstance, readInstance, readInstanceText } from "./instance.ts";

/**
 * Writes `text` to `name` in `dir` atomically: a fresh owner-only file beside it, synced, then renamed over it.
 * A symbolic link or anything but a plain file in its place stops the write.
 */
function writeAtomically(dir: string, name: string, text: string): void {
	const target = join(dir, name);
	const existing = lstatSync(target, { throwIfNoEntry: false });
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`${target} is not a plain file: it is not replaced.`);
	const temporary = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			chmodSync(temporary, 0o600);
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	// The rename is durable once the directory is synced.
	const dirFd = openSync(dir, constants.O_RDONLY);
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/** Stops unless this process holds the instance's lock. */
function holdsLock(instance: Instance): void {
	let holder = "";
	try {
		holder = readFileSync(instance.files.lock, "utf8");
	} catch {}
	if (holder !== String(process.pid)) throw new Error(`Writing to ${instance.dir} needs its lock, which this command does not hold.`);
}

/** Replaces one of an instance's files, atomically, while holding its lock. */
export function writeInstanceFile(instance: Instance, file: Exclude<InstanceFile, "lock">, text: string): void {
	checkDirectory(instance.dir, `The directory of ${instance.name}`);
	holdsLock(instance);
	writeAtomically(instance.dir, INSTANCE_FILES[file], text);
}

/** The instance.json of an instance. */
function instanceJson(instance: { name: string; test: boolean; account: string | null }): string {
	return `${JSON.stringify({ name: instance.name, test: instance.test, ...(instance.account ? { account: instance.account } : {}) }, null, "\t")}\n`;
}

/**
 * Records the account an instance is on, in its instance.json, before the command that pinned it changes anything
 * there (scripts/run.ts, pinAccount). An instance's account never changes once recorded.
 */
export function recordAccount(instance: Instance, account: string): Instance {
	if (instance.account !== null) throw new Error(`${instance.name} is already recorded on an account.`);
	const recorded = parseInstance(instanceJson({ ...instance, account }), instance.dir);
	const current = readInstanceText(instance, "instance");
	if (current === null || parseInstance(current, instance.dir).account !== null) throw new Error(`${instance.files.instance} changed while it was read: run this again.`);
	writeInstanceFile(instance, "instance", instanceJson(recorded));
	return recorded;
}

/**
 * Makes the directory of a new instance, with its instance.json and no account yet. The instances directory is
 * created too (owner-only) when it does not exist.
 */
export function createInstance(root: string, name: string, test: boolean): Instance {
	const problem = instanceNameProblem(name);
	if (problem) throw new Error(problem);
	if (!lstatSync(root, { throwIfNoEntry: false })) mkdirSync(root, { recursive: true, mode: 0o700 });
	checkDirectory(root, "The instances directory");
	const dir = join(root, name);
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${dir} already exists.`);
		throw error;
	}
	chmodSync(dir, 0o700);
	// The directory is new and this process made it, so nothing else writes here yet: no lock is needed.
	writeAtomically(dir, INSTANCE_FILES.instance, instanceJson({ name, test, account: null }));
	return readInstance(root, name);
}
