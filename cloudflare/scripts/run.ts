// Running cf and the other scripts from scripts/deploy.ts and scripts/reset.ts: output is captured so that
// identifiers can be taken out before it is printed, and so that a command cf aborted (it prints `Aborted.`
// and can still exit 0 when it would have asked) counts as a failure.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { type Instance, checkDirectory } from "./instance.ts";
import { recordAccount } from "./instance-files.ts";

/** cloudflare/, where the app's cloudflare.config.ts is. */
export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Identifiers that are never printed: the account's id and resource ids, added as they become known. */
const hidden = new Set<string>();

export function hide(value: string | undefined): void {
	if (value) hidden.add(value);
}

/** Hides the account's workers.dev subdomain named by an origin, so that cf's own output (which names the Worker's URL, sometimes cut short) does not show it. */
export function hideOrigin(origin: unknown): void {
	if (typeof origin !== "string") return;
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return;
	}
	const labels = host.split(".");
	if (labels.length >= 4 && host.endsWith(".workers.dev")) hide(labels[labels.length - 3]);
}

/** The text with every hidden identifier and every workers.dev host replaced. */
export function redact(text: string): string {
	let out = text;
	for (const value of hidden) out = out.replaceAll(value, "<id>");
	return out.replace(/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev/gi, "<workers.dev>");
}

export class CommandFailed extends Error {}

export interface Ran {
	status: number;
	stdout: string;
	/** stdout and stderr together. */
	output: string;
}

/**
 * Runs a command and returns its exit status and output (stdout and stderr together). `print` echoes the
 * redacted output; a failure, or an output saying `Aborted`, throws unless `allowFailure`.
 */
export function run(command: string, args: string[], options: { cwd?: string; print?: boolean; allowFailure?: boolean } = {}): Ran {
	const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (options.print && output.trim()) console.log(redact(output.trimEnd()));
	const status = result.status ?? (result.error ? 127 : 1);
	const aborted = /^\s*\W*\s*Aborted\b/m.test(output);
	if (!options.allowFailure && (status !== 0 || aborted)) {
		const shown = options.print ? "" : `\n${redact(output.trim()) || "(no output)"}`;
		throw new CommandFailed(`\`${[command, ...args.slice(0, 3)].join(" ")}\` ${aborted ? "was aborted" : `failed (exit ${status})`}.${shown}`);
	}
	return { status: aborted && status === 0 ? 1 : status, stdout: result.stdout ?? "", output };
}

/**
 * The .env files cf reads in a directory for a mode (cf/dist's loadEnv): they can set CLOUDFLARE_API_TOKEN or
 * CLOUDFLARE_ACCOUNT_ID for the commands run there, so that one directory's commands would reach another account.
 */
function cfEnvFiles(dir: string, modes: string[]): string[] {
	const names = [".env", ".env.local", ...modes.flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];
	return names.map((name) => join(dir, name)).filter((file) => existsSync(file));
}

/**
 * Pins every cf command of this run to the instance's account, put in this process's environment, which every
 * command inherits and which cf prefers to .env files; a .env file that sets a CLOUDFLARE_ variable where cf
 * runs (`dirs`, for `modes`) stops the run instead.
 *
 * Once recorded in the instance's instance.json, the account is the instance's: CLOUDFLARE_ACCOUNT_ID, if set,
 * must be the same, and cf must reach it. Before that, it is the account in CLOUDFLARE_ACCOUNT_ID, which cf must
 * reach, or else the only account cf reaches; with `record` (the caller holds the instance's lock and is about
 * to change the account) it is written into instance.json before anything changes, and without it the run
 * stops, since the instance was never deployed. The accounts' ids are hidden from all output; nothing
 * identifying is printed. Returns the account's id.
 */
export function pinAccount(dirs: string[], modes: string[], instance: Instance, options: { record: boolean }): string {
	for (const file of dirs.flatMap((dir) => cfEnvFiles(dir, modes))) {
		if (/^\s*(export\s+)?CLOUDFLARE_/m.test(readFileSync(file, "utf8"))) throw new CommandFailed(`${file} sets a CLOUDFLARE_ variable for cf: remove it, and set CLOUDFLARE_ACCOUNT_ID in the environment instead.`);
	}
	hide(instance.account ?? undefined);
	const wanted = process.env.CLOUDFLARE_ACCOUNT_ID;
	hide(wanted);
	const who = cfJson<{ authenticated?: boolean; tokenValid?: boolean; accounts?: { id: string }[] }>(["auth", "whoami"]);
	const accounts = (who.accounts ?? []).map((account) => account.id);
	for (const id of accounts) hide(id);
	if (!who.authenticated || who.tokenValid === false) throw new CommandFailed("cf is not signed in: run `cf auth login`.");
	if (instance.account !== null) {
		if (wanted && wanted !== instance.account) throw new CommandFailed(`CLOUDFLARE_ACCOUNT_ID is not the account ${instance.name} is on (${instance.files.instance}).`);
		if (!accounts.includes(instance.account)) throw new CommandFailed(`cf cannot reach the account ${instance.name} is on (${instance.files.instance}): sign in to it.`);
		process.env.CLOUDFLARE_ACCOUNT_ID = instance.account;
		return instance.account;
	}
	const account = wanted ? accounts.find((id) => id === wanted) : accounts.length === 1 ? accounts[0] : undefined;
	if (!account) throw new CommandFailed(wanted ? "cf cannot reach the account in CLOUDFLARE_ACCOUNT_ID." : `cf reaches ${accounts.length} accounts: set CLOUDFLARE_ACCOUNT_ID to the instance's.`);
	if (!options.record) throw new CommandFailed(`${instance.name} has no account recorded yet (${instance.files.instance}): its first deploy records it.`);
	recordAccount(instance, account);
	process.env.CLOUDFLARE_ACCOUNT_ID = account;
	return account;
}

/**
 * The values of an env file's text, both as dotenv reads them (cf) and as each line's raw remainder
 * (scripts/secrets.ts reads `KEY=value` lines), empty ones left out.
 */
export function envValues(text: string): string[] {
	const raw = text.split("\n").map((line) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line)?.[1]?.replace(/^(["'])(.*)\1$/, "$2"));
	return [...Object.values(parseEnv(text) as Record<string, string>), ...raw].filter((value): value is string => !!value);
}

/** Hides the values of an env file of secrets (`envValues`), so that no command's output can show one. */
export function hideSecrets(file: string): void {
	if (!existsSync(file)) return;
	for (const value of envValues(readFileSync(file, "utf8"))) {
		// Short values (flags, numbers) would only blank out unrelated output; secrets are long.
		if (value.length >= 16) hide(value);
	}
}

/** The checkout's lock: one deploy or reset at a time builds into this checkout's .cloudflare/output/. */
export const CHECKOUT_LOCK = join(ROOT, ".cloudflare", "operations.lock");

/**
 * Holds lock files, in order: each appears with its holder's pid in it (a hard link of a finished file), and is
 * removed on exit, Ctrl-C included. A lock someone else holds stops the run before the next is tried, and one
 * left behind (a run killed outright) is never taken over: the run stops and says which file to remove.
 */
export function holdLocks(files: string[]): void {
	for (const file of files) holdLock(file);
}

function holdLock(file: string): void {
	// A fresh file of this run's own, never one that was there (or a link someone left in its place).
	const mine = `${file}.${process.pid}.${randomBytes(6).toString("hex")}`;
	const fd = openSync(mine, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeSync(fd, String(process.pid));
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(mine, file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const holder = Number(readFileSync(file, "utf8"));
		let alive = true;
		try {
			process.kill(holder, 0);
		} catch (signal) {
			alive = (signal as NodeJS.ErrnoException).code === "EPERM";
		}
		throw new CommandFailed(
			alive && Number.isInteger(holder) && holder > 0
				? `Another command holds ${file} (process ${holder}): wait for it to finish.`
				: `A command (process ${holder || "unknown"}) stopped without removing its lock: if none is running, remove ${file} and run this again.`,
		);
	} finally {
		rmSync(mine, { force: true });
	}
	process.on("exit", () => {
		try {
			if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file);
		} catch {}
	});
	// Exiting on a signal runs the handler above; a script with handlers of its own exits from them.
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) if (process.listenerCount(signal) === 0) process.on(signal, () => process.exit(130));
}

/**
 * The locks of a command that changes an instance's account (a deploy, a reset): the checkout's first (both
 * build into the same .cloudflare/output/ directories, which a second run would replace between another's
 * check and upload), then the instance's, which stops two checkouts on one machine from changing one instance
 * at once. Always in that order, so two commands never wait on each other.
 */
export function lockOperation(instance: Instance): void {
	holdLocks(operationLocks(instance));
}

/** The lock files of `lockOperation`, in their order. */
function operationLocks(instance: Instance): string[] {
	mkdirSync(join(ROOT, ".cloudflare"), { recursive: true });
	checkDirectory(instance.dir, `The directory of ${instance.name}`);
	return [CHECKOUT_LOCK, instance.files.lock];
}

/**
 * For a script that changes the account both alone and under scripts/deploy.ts (scripts/resources.ts): nothing
 * when the process that ran it holds the locks of `lockOperation`, as a deploy does while it runs its steps;
 * otherwise those locks, as a command of its own.
 */
export function lockOperationUnlessParentHolds(instance: Instance): void {
	holdLocksUnlessParentHolds(operationLocks(instance));
}

/**
 * `holdLocks`, unless the process that ran this one holds every one of the files. A lock left by a dead run
 * whose pid the parent now has reads as the parent's; it still stops every other command, so this one runs
 * alone all the same.
 */
export function holdLocksUnlessParentHolds(files: string[]): void {
	const parentHolds = (file: string) => {
		try {
			return readFileSync(file, "utf8") === String(process.ppid);
		} catch {
			return false;
		}
	};
	if (files.every(parentHolds)) return;
	holdLocks(files);
}

/** The instance's lock alone, for a command that writes its directory and builds nothing (scripts/secrets.ts). */
export function lockInstance(instance: Instance): void {
	checkDirectory(instance.dir, `The directory of ${instance.name}`);
	holdLocks([instance.files.lock]);
}

/** `cf …` with its answer parsed as JSON; a failure throws (with the output redacted). */
export function cfJson<T>(args: string[], cwd?: string): T {
	const { stdout } = run("cf", args, { cwd });
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new CommandFailed(`\`cf ${args.slice(0, 3).join(" ")}\` did not answer JSON: ${redact(stdout.slice(0, 200))}`);
	}
}
