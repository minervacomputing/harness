// The folder's scan: one `find -P` over /workspace as the agent's user, read as a stream of NUL-separated
// records, and the folder's policy applied here. `find` never follows a symbolic link and prunes what the
// policy would refuse wholesale (names with control bytes, paths past 1,024 bytes, depth past 32, directories
// the agent's user cannot read); every name it reports is checked again here as raw bytes. Every entry it
// reports counts against the entry limit, and the process is killed past it, except what lies inside a
// directory refused for a name `find` cannot judge (invalid UTF-8, decomposed, C1 controls): that is left out
// as if pruned, and bounded by the folder's inodes and twice the limit. Regular files are measured in
// pages before anything is hashed; those the index does not vouch for are hashed with one `sha256sum` over
// their absolute paths. The scan runs only after the agent cgroup was emptied, and nothing else writes the
// folder until it ends. The Conversation validates the manifest and warnings again.

import type { FolderLimit } from "../files/limits.ts";
import { MAX_DEPTH, MAX_MTIME, MAX_PATH_BYTES, MAX_SEGMENT_BYTES, pages, WARNING_PATH_CHARS, WARNINGS_KEPT } from "../files/limits.ts";
import type { FileMode, FolderWarnings, WarningReason, WireManifest } from "../files/manifest.ts";
import { TooLong } from "./bytes.ts";
import { WORKSPACE } from "./constants.ts";
import { setOwn } from "./files.ts";
import { helperEnvironment, type Machine, startWrapped } from "./process.ts";

/** A file the scan hashed: what its stat said then, its hash, and its manifest mtime. */
export interface IndexEntry {
	size: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
	ino: string;
	dev: string;
	sha256: string;
	mtime: number;
	/** Its ctime was within a second of the scan: a later change might not show in its stat, so it is hashed again. */
	racy: boolean;
}

/** The index the Sandbox keeps for its container, by path: unchanged files are not hashed again. */
export type FolderIndex = Map<string, IndexEntry>;

/**
 * The scan's answer. Its claims are untrusted: the Conversation Durable Object validates the manifest and
 * warnings again.
 */
export type ScanResult =
	| { ok: true; manifest: WireManifest; sizes: { [path: string]: number }; warnings: FolderWarnings }
	| { ok: false; limit: Extract<FolderLimit, "folder_bytes" | "folder_entries"> }
	| { ok: false; reason: "failed"; message: string };

/** Scans and hydration take this long at most. */
export const FOLDER_SECONDS = 600;
/** A field of `find`'s or `sha256sum`'s output; a path the scan reports is at most 1,035 + 256 bytes. */
const MAX_FIELD = 4096;
/** A file whose ctime is this close to the scan's start is racy. */
const RACY_NS = 1_000_000_000n;
const PREFIX = new TextEncoder().encode(`${WORKSPACE}/`);
/** What `find` prints for each entry: readable, type, size, mtime, ctime, inode, device, mode and path. */
const FIELDS = "%y\\0%s\\0%T@\\0%C@\\0%i\\0%D\\0%m\\0%p\\0";
const FIELD_COUNT = 9;

/**
 * The `find` that lists the folder: never following links, at most one level past the depth limit, names
 * with control bytes and paths past the length limit pruned, directories it cannot read or search and files
 * it cannot read printed as unreadable and pruned, everything printed (FIELDS).
 */
export function findArgv(): string[] {
	const longer = `${WORKSPACE}/.{${MAX_PATH_BYTES + 1},}`;
	return [
		"find",
		"-P",
		WORKSPACE,
		"-mindepth",
		"1",
		"-maxdepth",
		String(MAX_DEPTH + 1),
		"(",
		"-name",
		"*[[:cntrl:]]*",
		"-o",
		"-regextype",
		"posix-extended",
		"-regex",
		longer,
		")",
		"-prune",
		"-printf",
		`r\\0${FIELDS}`,
		"-o",
		"(",
		"-type",
		"d",
		"!",
		"(",
		"-readable",
		"-executable",
		")",
		"-o",
		"-type",
		"f",
		"!",
		"-readable",
		")",
		"-prune",
		"-printf",
		`u\\0${FIELDS}`,
		"-o",
		"-printf",
		`r\\0${FIELDS}`,
	];
}

/** One entry `find` reported, its path relative to the folder and still raw bytes. */
export interface Listed {
	readable: boolean;
	/** `find`'s %y: f, d, l, p, s, c, b or D. */
	type: string;
	size: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
	ino: string;
	dev: string;
	mode: number;
	path: Uint8Array;
}

const ascii = new TextDecoder("latin1");
const DECIMAL = /^[0-9]{1,20}$/;
const TIME = /^(-?)([0-9]{1,19})(?:\.([0-9]{1,10}))?$/;

/** `find`'s %T@: seconds and up to ten fractional digits, as nanoseconds. */
function nanoseconds(field: string): bigint | null {
	const match = TIME.exec(field);
	if (!match) return null;
	const value = BigInt(match[2] as string) * 1_000_000_000n + BigInt(((match[3] ?? "") + "000000000").slice(0, 9));
	return match[1] ? -value : value;
}

/** One record's fields as an entry; null for anything `find` would not print. */
export function parseRecord(fields: readonly Uint8Array[]): Listed | null {
	if (fields.length !== FIELD_COUNT) return null;
	const [flag, type, size, mtime, ctime, ino, dev, mode] = fields.slice(0, 8).map((field) => ascii.decode(field)) as string[] as [string, string, string, string, string, string, string, string];
	const path = fields[8] as Uint8Array;
	if ((flag !== "r" && flag !== "u") || !/^[a-zA-Z]$/.test(type) || !/^[0-9]{1,16}$/.test(size) || !DECIMAL.test(ino) || !DECIMAL.test(dev) || !/^[0-7]{1,4}$/.test(mode)) return null;
	const mtimeNs = nanoseconds(mtime);
	const ctimeNs = nanoseconds(ctime);
	if (mtimeNs === null || ctimeNs === null || !Number.isSafeInteger(Number(size))) return null;
	if (path.length <= PREFIX.length || PREFIX.some((byte, index) => path[index] !== byte)) return null;
	return { readable: flag === "r", type, size: Number(size), mtimeNs, ctimeNs, ino, dev, mode: Number.parseInt(mode, 8), path: path.subarray(PREFIX.length) };
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
/** C0, DEL and C1: what the manifest calls control characters (\p{Cc}). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Why the policy refuses one name, the last of a path `pathBytes` long at `depth`. */
function refusedName(name: Uint8Array, pathBytes: number, depth: number): WarningReason | null {
	let text: string;
	try {
		text = strict.decode(name);
	} catch {
		return "invalid_name";
	}
	if (text === "" || text === "." || text === ".." || text.normalize("NFC") !== text || CONTROL.test(text)) return "invalid_name";
	if (name.length > MAX_SEGMENT_BYTES || pathBytes > MAX_PATH_BYTES) return "too_long";
	if (depth > MAX_DEPTH) return "too_deep";
	return null;
}

/**
 * Why the policy refuses a path, and whether the refused name is above its last (the path lies below an entry
 * already refused, which is left out without a warning); null for a path it keeps.
 */
export function refusal(path: Uint8Array): { reason: WarningReason; below: boolean } | null {
	let start = 0;
	for (let depth = 1; ; depth++) {
		const slash = path.indexOf(0x2f, start);
		const end = slash === -1 ? path.length : slash;
		const reason = refusedName(path.subarray(start, end), end, depth);
		if (reason) return { reason, below: slash !== -1 };
		if (slash === -1) return null;
		start = slash + 1;
	}
}

/** A path as the chat can show it: invalid UTF-8 and control characters as U+FFFD, at most 1,024 UTF-16 units. */
export function displayPath(path: Uint8Array): string {
	const text = lenient.decode(path).replace(CONTROLS, "\ufffd");
	if (text.length <= WARNING_PATH_CHARS) return text;
	let end = WARNING_PATH_CHARS - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
	return a.length - b.length;
}

/** A regular file the scan keeps. */
export interface Kept {
	path: string;
	key: Uint8Array;
	size: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
	ino: string;
	dev: string;
	mode: FileMode;
}

/**
 * The folder's policy over `find`'s entries, one at a time: regular files kept, directories noted, and what
 * is left out warned about, the first 100 by path bytes kept for display and all of them counted.
 */
export class Listing {
	readonly files: Kept[] = [];
	readonly #dirs: Uint8Array[] = [];
	readonly #warnings: { key: Uint8Array; reason: WarningReason }[] = [];
	#total = 0;

	/**
	 * Takes one entry; false for one inside a directory refused for its name, which is left out without a
	 * warning and does not count as an entry of the folder.
	 */
	add(entry: Listed): boolean {
		const refused = refusal(entry.path);
		if (refused) {
			if (refused.below) return false;
			this.#warn(entry.path, refused.reason);
		} else if (!entry.readable) this.#warn(entry.path, "unreadable");
		else if (entry.type === "l") this.#warn(entry.path, "symlink");
		else if (entry.type === "d") this.#dirs.push(entry.path.slice());
		else if (entry.type !== "f") this.#warn(entry.path, "special");
		else {
			const { size, mtimeNs, ctimeNs, ino, dev } = entry;
			const key = entry.path.slice();
			this.files.push({ path: strict.decode(key), key, size, mtimeNs, ctimeNs, ino, dev, mode: entry.mode & 0o100 ? 0o755 : 0o644 });
		}
		return true;
	}

	#warn(path: Uint8Array, reason: WarningReason): void {
		this.#total++;
		const kept = this.#warnings;
		if (kept.length === WARNINGS_KEPT && compareBytes(path, (kept.at(-1) as { key: Uint8Array }).key) >= 0) return;
		let low = 0;
		let high = kept.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (compareBytes((kept[middle] as { key: Uint8Array }).key, path) <= 0) low = middle + 1;
			else high = middle;
		}
		kept.splice(low, 0, { key: path.slice(), reason });
		if (kept.length > WARNINGS_KEPT) kept.pop();
	}

	get warnings(): FolderWarnings {
		return { total: this.#total, items: this.#warnings.map(({ key, reason }) => ({ path: displayPath(key), reason })) };
	}

	/** Files in path byte order. */
	sorted(): Kept[] {
		return this.files.sort((a, b) => compareBytes(a.key, b.key));
	}

	/** The directories nothing kept or listed lies in, in path byte order. */
	emptyDirs(): string[] {
		const parents = new Set<string>();
		const parent = (key: Uint8Array) => {
			const slash = key.lastIndexOf(0x2f);
			if (slash !== -1) parents.add(strict.decode(key.subarray(0, slash)));
		};
		for (const file of this.files) parent(file.key);
		for (const dir of this.#dirs) parent(dir);
		return this.#dirs
			.sort(compareBytes)
			.map((key) => strict.decode(key))
			.filter((dir) => !parents.has(dir));
	}
}

/** Whether `entry` vouches for `file`'s hash: settled, and its stat unchanged in every field. */
export function vouches(entry: IndexEntry | undefined, file: Kept): entry is IndexEntry {
	return (
		entry !== undefined &&
		!entry.racy &&
		entry.size === file.size &&
		entry.mtimeNs === file.mtimeNs &&
		entry.ctimeNs === file.ctimeNs &&
		entry.ino === file.ino &&
		entry.dev === file.dev
	);
}

/** Milliseconds of a nanosecond time, within what a manifest holds. */
export function mtimeOf(ns: bigint): number {
	const ms = Number(ns / 1_000_000n);
	return ms < 0 ? 0 : Math.min(ms, MAX_MTIME);
}

/**
 * A freshly hashed file's index entry. A file whose mtime did not change keeps the manifest mtime its last
 * entry had, which setting it may have rounded.
 */
export function indexEntry(file: Kept, sha256: string, previous: IndexEntry | undefined, now: bigint): IndexEntry {
	const mtime = previous && previous.mtimeNs === file.mtimeNs ? previous.mtime : mtimeOf(file.mtimeNs);
	return { size: file.size, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs, ino: file.ino, dev: file.dev, sha256, mtime, racy: file.ctimeNs + RACY_NS >= now };
}

type Failed = { ok: false; reason: "failed"; message: string };
const failed = (message: string): Failed => ({ ok: false, reason: "failed", message });

/**
 * Lists the folder: the container's clock (`date`), then `find`'s records, each counted against
 * `maxEntries` unless it lies inside a refused directory. Fails on any malformed or partial output or a
 * non-zero exit.
 */
export async function list(machine: Machine, maxEntries: number): Promise<{ ok: true; now: bigint; listing: Listing } | { ok: false; limit: "folder_entries" } | Failed> {
	const command = ["/bin/sh", "-c", 'date +%s%N && exec "$@"', "scan", ...findArgv()];
	const wrapped = await startWrapped(machine, { command, cwd: "/", env: { ...helperEnvironment(), LC_ALL: "C" }, timeoutSeconds: FOLDER_SECONDS }, { stderr: "ignore" });
	if (!wrapped.admission.started) return failed("The folder could not be listed.");
	try {
		const clock = await wrapped.stdout.until(0x0a, 32);
		const now = clock && /^[0-9]{1,20}$/.test(ascii.decode(clock)) ? BigInt(ascii.decode(clock)) : null;
		if (now === null) return failed("The folder could not be listed.");
		const listing = new Listing();
		let count = 0;
		let records = 0;
		for (;;) {
			const fields: Uint8Array[] = [];
			for (let i = 0; i < FIELD_COUNT; i++) {
				const field = await wrapped.stdout.until(0, MAX_FIELD);
				if (field === null) break;
				fields.push(field);
			}
			if (fields.length === 0) break;
			if (++records > 2 * maxEntries) return { ok: false, limit: "folder_entries" };
			const entry = parseRecord(fields);
			if (!entry) return failed("The folder's listing is unreadable.");
			if (listing.add(entry) && ++count > maxEntries) return { ok: false, limit: "folder_entries" };
		}
		if ((await wrapped.proc.exitCode.catch(() => -1)) !== 0) return failed("The folder could not be listed.");
		return { ok: true, now, listing };
	} catch (error) {
		if (error instanceof TooLong) return failed("The folder's listing is unreadable.");
		return failed("The folder could not be listed.");
	} finally {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
	}
}

const HASH = /^[0-9a-f]{64}$/;

/** The SHA-256 of each file, in order, from one `sha256sum` (through `xargs`) over their absolute paths. */
async function hashes(machine: Machine, files: readonly Kept[]): Promise<string[] | null> {
	if (files.length === 0) return [];
	const paths = files.map((file) => new Uint8Array([...PREFIX, ...file.key, 0]));
	const wrapped = await startWrapped(
		machine,
		{ command: ["xargs", "-0", "-r", "sha256sum", "--zero", "--"], cwd: "/", env: { ...helperEnvironment(), LC_ALL: "C" }, timeoutSeconds: FOLDER_SECONDS },
		{ stdin: new Blob(paths as Uint8Array<ArrayBuffer>[]).stream(), stderr: "ignore" },
	);
	if (!wrapped.admission.started) return null;
	try {
		const out: string[] = [];
		for (const path of paths) {
			const line = await wrapped.stdout.until(0, MAX_FIELD);
			// `<hash>  <path>`, the path exactly as given.
			if (!line || line.length !== 66 + path.length - 1 || line[64] !== 0x20 || line[65] !== 0x20) return null;
			if (compareBytes(line.subarray(66), path.subarray(0, -1)) !== 0) return null;
			const hash = ascii.decode(line.subarray(0, 64));
			if (!HASH.test(hash)) return null;
			out.push(hash);
		}
		if ((await wrapped.stdout.until(0, 0)) !== null) return null;
		return (await wrapped.proc.exitCode.catch(() => -1)) === 0 ? out : null;
	} catch {
		return null;
	} finally {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
	}
}

/**
 * The scan, with the Sandbox's index of the files it last hashed: the manifest, each file's size, the
 * warnings, and the next index. Sizes are measured in pages before anything is hashed.
 */
export async function scan(
	machine: Machine,
	index: FolderIndex,
	limits: { bytes: number; entries: number },
	rehashAll: boolean,
): Promise<{ result: ScanResult; index: FolderIndex | null }> {
	const listed = await list(machine, limits.entries);
	if (!listed.ok) return { result: listed, index: null };
	const files = listed.listing.sorted();
	let bytes = 0;
	for (const file of files) bytes += pages(file.size);
	if (bytes > limits.bytes) return { result: { ok: false, limit: "folder_bytes" }, index: null };
	const stale = files.filter((file) => rehashAll || !vouches(index.get(file.path), file));
	const hashed = await hashes(machine, stale);
	if (!hashed) return { result: failed("The folder's files could not be hashed."), index: null };
	const fresh = new Map(stale.map((file, i) => [file.path, hashed[i] as string]));
	const next: FolderIndex = new Map();
	const result: ScanResult & { ok: true } = { ok: true, manifest: { files: [], dirs: listed.listing.emptyDirs() }, sizes: {}, warnings: listed.listing.warnings };
	for (const file of files) {
		const previous = index.get(file.path);
		const sha256 = fresh.get(file.path);
		const entry = sha256 === undefined ? (previous as IndexEntry) : indexEntry(file, sha256, previous, listed.now);
		next.set(file.path, entry);
		result.manifest.files.push({ path: file.path, sha256: entry.sha256, mode: file.mode, mtime: entry.mtime });
		setOwn(result.sizes, file.path, file.size);
	}
	return { result, index: next };
}
