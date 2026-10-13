// pi's file operations (`FsRequest`), run as the agent's user. Most go through @cloudflare/sandbox's Files,
// whose sandbox-shim runs each one in its own exec; what Files lacks (canonical paths, temporary files,
// truncate, sync, append, the watch's snapshot) is one coreutils command through the wrapper, with paths as
// arguments. Every operation ends within the file-operation limit: a shim waiting on a FIFO is killed then.
// What comes back from the container is untrusted: reads are bounded and every answer is checked.

import { Files, SandboxFileError, type SandboxFileStat } from "@cloudflare/sandbox";
import { type FileErrorCode, type FileInfo, type LineScan, LineScanner, type WatchTarget } from "@earendil-works/pi-durable/env";
import { TooLong } from "./bytes.ts";
import { AGENT_GID, AGENT_UID, MAX_BINARY_BYTES, TMP } from "./constants.ts";
import { join } from "./paths.ts";
import { ContainerGone, helperEnvironment, type Machine, spawn, startWrapped } from "./process.ts";

/** What a binary reader saw when it opened its file; every later call checks the path still shows it. */
export interface Opened {
	size: number;
	mtimeMs: number;
	noFollow: boolean;
}

export type FsRequest =
	| { op: "readFile"; path: string; maxBytes: number }
	| { op: "writeFile"; path: string; content: Uint8Array }
	| { op: "appendFile"; path: string; content: Uint8Array }
	| { op: "lstat"; path: string }
	| { op: "open"; path: string; noFollow: boolean }
	| { op: "read"; path: string; opened: Opened; offset: number; length: number }
	| { op: "scanLines"; path: string; opened: Opened; startLine: number; endLine?: number }
	| { op: "stat"; path: string; opened: Opened }
	| { op: "readDirectory"; path: string }
	| { op: "entries"; paths: string[] }
	| { op: "mkdir"; path: string; recursive: boolean }
	| { op: "remove"; path: string; recursive: boolean; force: boolean }
	| { op: "rename"; from: string; to: string }
	| { op: "truncate"; path: string; size: number }
	| { op: "flush"; path: string }
	| { op: "canonical"; path: string }
	| { op: "mktemp"; kind: "file" | "dir"; prefix: string; suffix: string }
	| { op: "snapshot"; targets: WatchTarget[]; maxEntries: number };

/** Each request's answer, by `op`. RPC payloads are limited to 32 MiB; no answer comes near it. */
export interface FsAnswers {
	readFile: Uint8Array;
	writeFile: null;
	appendFile: null;
	lstat: FileInfo;
	open: FileInfo;
	read: Uint8Array;
	scanLines: LineScan;
	stat: FileInfo;
	/** The names of the entries that are files, directories or symbolic links. */
	readDirectory: string[];
	/** Each path's information, or null where it is gone or of a kind pi does not list. */
	entries: (FileInfo | null)[];
	mkdir: null;
	remove: null;
	rename: null;
	truncate: null;
	flush: null;
	canonical: string;
	mktemp: string;
	snapshot: WatchSnapshot;
}

/**
 * What a watch's poll compares (the ExecutionEnv's `watch` polls): a signature per path under the targets
 * (kind, size, mtime, ctime, inode; a dangling symbolic link by what it points to), excluded entries left
 * out. `overflow` when the targets hold more than `maxEntries` entries.
 */
export type WatchSnapshot = { entries: { [path: string]: string } } | { overflow: true };

/** The answer to a request: its value (`FsAnswers[op]`), or pi's error code. */
export type FsResponse = { ok: true; value: FsAnswers[keyof FsAnswers] } | { ok: false; code: FileErrorCode; message: string };

/** The processes one operation runs at once: a listing page's `lstat`s, a snapshot's `find`s. */
const AT_ONCE = 16;
export const MAX_ENTRIES = 1000;
/** The output of one snapshot's `find`s together, shared equally among them; beyond its share the watch overflows. */
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** What a wrapped command may print, its output being a path. */
const PATH_OUTPUT = 64 * 1024;

/**
 * Sets an own property of a plain object, a path named `__proto__` included. Workers RPC cannot clone an
 * object without a prototype, so a map keyed by paths is a plain object with properties defined this way.
 */
export function setOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Linux error names as pi's codes, with our messages. Anything not here is `unknown`. */
const ERRORS: { readonly [errno: string]: readonly [FileErrorCode, string] } = {
	ENOENT: ["not_found", "No such file or directory"],
	EACCES: ["permission_denied", "Permission denied"],
	EPERM: ["permission_denied", "Operation not permitted"],
	ENOTDIR: ["not_directory", "Not a directory"],
	EISDIR: ["is_directory", "Is a directory"],
	EINVAL: ["invalid", "Invalid argument"],
	ENXIO: ["invalid", "No such device or address"],
	EEXIST: ["unknown", "File exists"],
	ENOTEMPTY: ["unknown", "Directory not empty"],
	ENOSPC: ["unknown", "No space left on device"],
	EDQUOT: ["unknown", "Disk quota exceeded"],
	EROFS: ["unknown", "Read-only file system"],
	ENAMETOOLONG: ["unknown", "File name too long"],
	ELOOP: ["unknown", "Too many levels of symbolic links"],
	EXDEV: ["unknown", "Cannot move across file systems"],
	EBUSY: ["unknown", "Device or resource busy"],
	EFBIG: ["unknown", "File too large"],
	ETXTBSY: ["unknown", "Text file busy"],
	EMLINK: ["unknown", "Too many links"],
	EIO: ["unknown", "Input/output error"],
};

function failure(code: FileErrorCode, message: string): FsResponse {
	return { ok: false, code, message };
}

/** A Linux error name as pi's code, and its message about `path`. */
export function errnoFailure(errno: string, path: string): FsResponse {
	const known = Object.hasOwn(ERRORS, errno) ? ERRORS[errno] : undefined;
	const [code, text] = known ?? ["unknown", `Failed with ${/^E[A-Z0-9]{1,15}$/.test(errno) ? errno : "an unknown error"}`];
	return failure(code, `${text}: ${path}`);
}

const FAILED = (): FsResponse => failure("unknown", "The file operation failed in the sandbox.");

/** A failure as pi's error: the shim's errno through the table, a refused argument `invalid`, anything else `unknown`. */
function failed(error: unknown, path: string, timeout: AbortSignal): FsResponse {
	if (error instanceof ContainerGone) throw error;
	if (SandboxFileError.is(error)) return errnoFailure(error.code, error.path || path);
	if (timeout.aborted) return failure("unknown", `The file operation timed out: ${path}`);
	if (error instanceof TypeError) return failure("invalid", `Invalid path: ${path}`);
	return FAILED();
}

class Failed extends Error {
	readonly response: FsResponse;
	constructor(response: FsResponse) {
		super("The file operation failed.");
		this.response = response;
	}
}

function kindOf(type: string): FileInfo["kind"] | null {
	return type === "file" || type === "directory" || type === "symlink" ? type : null;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** A stat as pi's FileInfo; another kind than file, directory and symbolic link is `invalid`, as in pi. */
function infoOf(path: string, stat: SandboxFileStat): FileInfo {
	const kind = kindOf(stat.type);
	if (!kind) throw new Failed(failure("invalid", `Unsupported file type: ${path}`));
	return { name: basename(path), path, kind, size: Number(stat.size), mtimeMs: stat.modifiedAt.getTime() };
}

/**
 * Bytes `[skip, skip + take)` of a file's stream: the rest is not read, and the shim is stopped. Returns
 * fewer at the end of the file.
 */
async function slice(files: Files, path: string, options: { user: string; signal: AbortSignal }, skip: number, take: number): Promise<Uint8Array> {
	const response = await files.readFile(path, options);
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const parts: Uint8Array[] = [];
	let skipped = 0;
	let taken = 0;
	try {
		while (taken < take) {
			const { done, value } = await reader.read();
			if (done) break;
			let chunk = value;
			if (skipped < skip) {
				const drop = Math.min(skip - skipped, chunk.length);
				skipped += drop;
				chunk = chunk.subarray(drop);
			}
			if (chunk.length === 0) continue;
			const part = chunk.subarray(0, take - taken);
			parts.push(part);
			taken += part.length;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (parts.length === 1) return parts[0] as Uint8Array;
	const bytes = new Uint8Array(taken);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** The file's whole stream through pi's line scanner. */
async function scanned(files: Files, path: string, options: { user: string; signal: AbortSignal }, scanner: LineScanner): Promise<LineScan> {
	const response = await files.readFile(path, options);
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return scanner.finish();
			scanner.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/**
 * A reader's file as its path shows it now, refused when it is not the file that was opened: shorter, or as
 * long with another mtime (a rewrite). A longer file is taken as the same file appended to, as pi's read
 * tool takes it.
 */
async function reopened(files: Files, path: string, opened: Opened, options: { user: string; signal: AbortSignal }): Promise<FileInfo> {
	const stat = opened.noFollow ? await files.lstat(path, options) : await files.stat(path, options);
	const info = stat.type === "file" ? infoOf(path, stat) : null;
	if (!info || info.size < opened.size || (info.size === opened.size && info.mtimeMs !== opened.mtimeMs)) {
		throw new Failed(failure("unknown", `The file changed since it was opened: ${path}`));
	}
	return info;
}

/**
 * A coreutils command through the wrapper as the agent's user: its exit code and its stdout, up to `maxOutput`
 * bytes. It is killed and the call fails after `seconds` or when `signal` aborts, even if the command's own
 * `timeout` was stopped.
 */
async function wrapped(
	machine: Machine,
	command: string[],
	seconds: number,
	options: { stdin?: Uint8Array; maxOutput?: number; signal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: Uint8Array }> {
	const signal = AbortSignal.any([AbortSignal.timeout(seconds * 1000), ...(options.signal ? [options.signal] : [])]);
	const work = (async () => {
		const child = await startWrapped(
			machine,
			{ command, cwd: "/", env: helperEnvironment(), timeoutSeconds: seconds },
			{ stderr: "ignore", signal, ...(options.stdin ? { stdin: new Blob([options.stdin as Uint8Array<ArrayBuffer>]).stream() } : {}) },
		);
		if (!child.admission.started) {
			await child.stdout.cancel();
			throw new Failed(FAILED());
		}
		try {
			const stdout = await child.stdout.rest(options.maxOutput ?? PATH_OUTPUT);
			return { exitCode: await child.proc.exitCode.catch(() => 137), stdout };
		} catch (error) {
			child.stop();
			throw error;
		}
	})();
	const ended = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	// After an abort the command is being killed; how its call ends no longer matters.
	work.catch(() => undefined);
	ended.catch(() => undefined);
	return await Promise.race([work, ended]);
}

/** The command that appends its stdin to `path`, creating the file if it is missing. */
export function appendCommand(path: string): string[] {
	return ["dd", `of=${path}`, "bs=65536", "oflag=append", "conv=notrunc", "status=none"];
}

/** A path printed by a command and ended by `end`, or null when the output is not one absolute path. */
function printedPath(stdout: Uint8Array, end: number): string | null {
	if (stdout.length < 2 || stdout[stdout.length - 1] !== end || stdout.indexOf(end) !== stdout.length - 1 || stdout.includes(0) !== (end === 0)) return null;
	const path = new TextDecoder().decode(stdout.subarray(0, -1));
	return path.startsWith("/") ? path : null;
}

/**
 * A temporary file or directory under /tmp, made by the agent's user (pi's createTempFile and
 * createTempDir): the prefix, random characters, then the suffix.
 */
export async function makeTemp(machine: Machine, kind: "file" | "dir", prefix: string, suffix: string, seconds: number, signal?: AbortSignal): Promise<string> {
	const command =
		kind === "dir" ? ["mktemp", "-d", `--tmpdir=${TMP}`, "--", `${prefix}XXXXXX`] : ["mktemp", `--tmpdir=${TMP}`, `--suffix=${suffix}`, "--", `${prefix}XXXXXXXXXX`];
	const { exitCode, stdout } = await wrapped(machine, command, seconds, signal ? { signal } : {});
	const path = exitCode === 0 ? printedPath(stdout, 0x0a) : null;
	if (!path?.startsWith(`${TMP}/`)) throw new Failed(failure("unknown", "A temporary file could not be made."));
	return path;
}

/** `find`'s escapes for a glob that matches exactly `text`. */
function literalGlob(text: string): string {
	return text.replace(/[\\*?[]/g, "\\$&");
}

/**
 * The `find` that lists one watch target: the target itself (followed when it is a symbolic link), a
 * directory's entries, and a recursive one's whole tree without following links below it, excluded names
 * pruned. Each entry prints as type, size, mtime, ctime, inode and link text, then its path, each record
 * ending in NUL.
 */
export function snapshotCommand(target: WatchTarget): string[] {
	const command = ["find", "-H", target.path];
	if (!target.recursive) command.push("-maxdepth", "1");
	const names = [...(target.exclude?.hidden ? [".*"] : []), ...(target.exclude?.names ?? []).map(literalGlob)];
	if (names.length > 0) {
		const below = `${literalGlob(target.path === "/" ? "" : target.path)}/*`;
		command.push("(", "-path", below, "(", ...names.flatMap((name, index) => (index === 0 ? ["-name", name] : ["-o", "-name", name])), ")", "-prune", ")", "-o");
	}
	command.push("-printf", "%y\\t%s\\t%T@\\t%C@\\t%i\\t%l\\0%p\\0");
	return command;
}

/**
 * Signatures from a snapshot `find`'s output: null when it is not that output, "overflow" past `maxEntries`
 * paths (counted as they are read).
 */
export function snapshotEntries(output: Uint8Array, maxEntries: number): Map<string, string> | null | "overflow" {
	const fields = new TextDecoder().decode(output).split("\0");
	if (fields.pop() !== "" || fields.length % 2 !== 0) return null;
	const entries = new Map<string, string>();
	for (let i = 0; i < fields.length; i += 2) {
		if (entries.size >= maxEntries) return "overflow";
		const meta = fields[i] as string;
		const path = fields[i + 1] as string;
		const parts = meta.split("\t");
		if (parts.length < 6 || !path.startsWith("/")) return null;
		const [type, size, mtime, ctime, inode] = parts as [string, string, string, string, string];
		const link = parts.slice(5).join("\t");
		entries.set(path, type === "d" ? `d:${inode}` : `${type}:${size}:${mtime}:${ctime}:${inode}:${link}`);
	}
	return entries;
}

/** Every target's entries, AT_ONCE `find`s at a time, each with an equal share of SNAPSHOT_BYTES. */
async function snapshot(machine: Machine, targets: WatchTarget[], maxEntries: number, seconds: number, signal: AbortSignal): Promise<WatchSnapshot> {
	const distinct = [...new Map(targets.map((target) => [JSON.stringify(snapshotCommand(target)), target])).values()];
	const share = Math.floor(SNAPSHOT_BYTES / Math.max(1, distinct.length));
	const outputs = await each(distinct, AT_ONCE, async (target) => {
		try {
			return await wrapped(machine, snapshotCommand(target), seconds, { maxOutput: share, signal });
		} catch (error) {
			if (error instanceof TooLong) return null;
			throw error;
		}
	});
	const entries: { [path: string]: string } = {};
	let count = 0;
	for (const output of outputs) {
		if (output === null) return { overflow: true };
		// 1: something below could not be read, or went away while find ran.
		if (output.exitCode !== 0 && output.exitCode !== 1) throw new Failed(failure("unknown", "The watched files could not be listed."));
		const found = snapshotEntries(output.stdout, maxEntries);
		if (found === "overflow") return { overflow: true };
		if (!found) throw new Failed(FAILED());
		for (const [path, signature] of found) {
			if (Object.hasOwn(entries, path)) continue;
			if (++count > maxEntries) return { overflow: true };
			setOwn(entries, path, signature);
		}
	}
	return { entries };
}

/** Runs `work` on at most `limit` items at once. */
async function each<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * One file operation, ended after `seconds`. Expected failures come back as pi's codes; a shim or command
 * that answers nonsense is `unknown`. A container that is gone throws ContainerGone.
 */
export async function fileOperation(machine: Machine, request: FsRequest, seconds: number): Promise<FsResponse> {
	const files = new Files({ exec: (argv, options) => spawn(machine, argv, options ?? {}) });
	const timeout = AbortSignal.timeout(seconds * 1000);
	// Ends the shims still running when one of the operation's calls fails.
	const done = new AbortController();
	const options = { user: `${AGENT_UID}:${AGENT_GID}`, signal: AbortSignal.any([timeout, done.signal]) };
	const path = request.op === "rename" ? request.from : request.op === "entries" || request.op === "mktemp" || request.op === "snapshot" ? "" : request.path;
	const ok = (value: FsAnswers[keyof FsAnswers]): FsResponse => ({ ok: true, value });
	try {
		switch (request.op) {
			case "readFile": {
				const max = Math.min(request.maxBytes, MAX_BINARY_BYTES);
				const bytes = await slice(files, path, options, 0, max + 1);
				if (bytes.length > max) return failure("unknown", `The file is larger than ${max} bytes: ${path}`);
				return ok(bytes);
			}
			case "writeFile":
				try {
					await files.writeFile(path, request.content, options);
				} catch (error) {
					if (!SandboxFileError.is(error) || error.code !== "ENOENT") throw error;
					// Its directory is missing: made, as pi's writeFile makes it.
					await files.mkdir(join(path, ".."), { ...options, recursive: true });
					await files.writeFile(path, request.content, options);
				}
				return ok(null);
			case "appendFile": {
				await files.mkdir(join(path, ".."), { ...options, recursive: true });
				const { exitCode } = await wrapped(machine, appendCommand(path), seconds, { stdin: request.content, signal: options.signal });
				if (exitCode === 0) return ok(null);
				const stat = await files.stat(path, options);
				return stat.type === "directory" ? errnoFailure("EISDIR", path) : failure("unknown", `The file could not be appended to: ${path}`);
			}
			case "lstat":
				return ok(infoOf(path, await files.lstat(path, options)));
			case "open": {
				const stat = request.noFollow ? await files.lstat(path, options) : await files.stat(path, options);
				if (stat.type === "symlink") return failure("invalid", `Refusing to follow a symbolic link: ${path}`);
				if (stat.type === "directory") return errnoFailure("EISDIR", path);
				if (stat.type !== "file") return failure("invalid", `Not a regular file: ${path}`);
				return ok(infoOf(path, stat));
			}
			case "read": {
				const length = Math.min(request.length, MAX_BINARY_BYTES);
				const [, bytes] = await Promise.all([reopened(files, path, request.opened, options), slice(files, path, options, request.offset, length)]);
				return ok(bytes);
			}
			case "scanLines": {
				const scanner = new LineScanner(request.startLine, request.endLine);
				const [, scan] = await Promise.all([reopened(files, path, request.opened, options), scanned(files, path, options, scanner)]);
				return ok(scan);
			}
			case "stat":
				return ok(await reopened(files, path, request.opened, options));
			case "readDirectory": {
				const entries = await files.readDirectory(path, options);
				return ok(entries.filter((entry) => kindOf(entry.type) !== null).map((entry) => entry.name));
			}
			case "entries":
				if (request.paths.length > MAX_ENTRIES) return failure("invalid", `At most ${MAX_ENTRIES} entries are read at once.`);
				return ok(
					await each(request.paths, AT_ONCE, async (entry) => {
						try {
							const stat = await files.lstat(entry, options);
							const kind = kindOf(stat.type);
							return kind ? infoOf(entry, stat) : null;
						} catch (error) {
							// Removed since it was listed: not part of the listing any more.
							if (SandboxFileError.is(error) && error.code === "ENOENT") return null;
							throw error;
						}
					}),
				);
			case "mkdir":
				await files.mkdir(path, { ...options, recursive: request.recursive });
				return ok(null);
			case "remove":
				await files.remove(path, { ...options, recursive: request.recursive, force: request.force });
				return ok(null);
			case "rename":
				await files.rename(request.from, request.to, options);
				return ok(null);
			case "truncate": {
				const stat = await files.stat(path, options);
				if (stat.type === "directory") return errnoFailure("EISDIR", path);
				if (stat.type !== "file") return failure("invalid", `Not a regular file: ${path}`);
				const { exitCode } = await wrapped(machine, ["truncate", "-c", "-s", String(request.size), "--", path], seconds, { signal: options.signal });
				return exitCode === 0 ? ok(null) : failure("unknown", `The file could not be truncated: ${path}`);
			}
			case "flush": {
				const stat = await files.stat(path, options);
				if (stat.type === "directory") return errnoFailure("EISDIR", path);
				const { exitCode } = await wrapped(machine, ["sync", "--", path], seconds, { signal: options.signal });
				return exitCode === 0 ? ok(null) : failure("unknown", `The file could not be flushed: ${path}`);
			}
			case "canonical": {
				const { exitCode, stdout } = await wrapped(machine, ["realpath", "-e", "-z", "--", path], seconds, { signal: options.signal });
				const canonical = exitCode === 0 ? printedPath(stdout, 0) : null;
				if (canonical !== null) return ok(canonical);
				// Why it failed is what following the path says: a missing file or directory is `not_found`.
				await files.stat(path, options);
				return failure("unknown", `The path could not be resolved: ${path}`);
			}
			case "mktemp":
				if (/[/\n\0]/.test(request.prefix + request.suffix)) return failure("invalid", "A temporary file's prefix and suffix cannot hold a slash or a line break.");
				return ok(await makeTemp(machine, request.kind, request.prefix, request.suffix, seconds, options.signal));
			case "snapshot":
				return ok(await snapshot(machine, request.targets, request.maxEntries, seconds, options.signal));
		}
	} catch (error) {
		if (error instanceof Failed) return error.response;
		return failed(error, path, timeout);
	} finally {
		done.abort();
	}
}
