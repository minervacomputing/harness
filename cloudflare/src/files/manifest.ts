// Folder manifests (files 4; backend/files/manifest.py, and the pure parts of backend/files/runs.py): the
// validation of what a scan reports, the form a version stores and its digest, warnings, and what a turn
// changed. Ported check by check, in today's order, with today's messages (paths in them as Python's `repr`).
//
// Manifests come from the container's scan, so they are untrusted: every one is validated here before it
// is recorded (files 15.1). They arrive over RPC as structured clones, not JSON text, so JavaScript numbers
// only: an integral float such as `1.0`, which Python refuses as a mode or mtime, cannot be told from `1`
// (files risk 4, a harmless widening). Booleans are refused, as Python refuses them.
//
// NFC and the Cc category come from the runtime's Unicode tables, as Python's come from its own (Unicode
// 16.0 in Python 3.14; files risk 23): a name normalized differently by the two would be refused here.

import type { Sha256 } from "../contracts/common.ts";
import type { FileMode, StoredEntries, WireManifest } from "../contracts/files.ts";
import { utf8Strict } from "../lib/bytes.ts";
import { hashInput } from "../lib/canonical.ts";
import { compareCodePoints, sortByCodePoint } from "../lib/order.ts";
import { codePointLength, pythonRepr } from "../lib/text.ts";
import {
	CHANGES_KEPT,
	FILE_MODES,
	MAX_DEPTH,
	MAX_MTIME,
	MAX_PATH_BYTES,
	MAX_SEGMENT_BYTES,
	QuotaExceeded,
	WARNING_PATH_CHARS,
	WARNING_REASONS,
	WARNINGS_KEPT,
	folderBytes,
} from "./limits.ts";
import { sha256HexSync } from "./sha256.ts";

/** What `parse` refuses: a malformed manifest or warnings. */
export class InvalidManifest extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidManifest";
	}
}

export interface FileEntry {
	sha256: Sha256;
	mode: FileMode;
	mtime: number;
}

/** A parsed manifest: files in the order given, empty directories sorted, and every entry counted. */
export interface Manifest {
	files: Map<string, FileEntry>;
	dirs: string[];
	/** Files plus every directory, listed or implied, apart from the root: each takes an inode. */
	entryCount: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /\p{Cc}/u;
const ENCODER = new TextEncoder();

export function isSha256(value: unknown): value is Sha256 {
	return typeof value === "string" && SHA256.test(value);
}

/** The distinct hashes a manifest names. */
export function hashesOf(manifest: { files: Map<string, FileEntry> } | StoredEntries): Set<Sha256> {
	const hashes = new Set<Sha256>();
	if (manifest.files instanceof Map) for (const entry of manifest.files.values()) hashes.add(entry.sha256);
	else for (const entry of Object.values(manifest.files)) hashes.add(entry.sha256);
	return hashes;
}

/** Python's `isinstance(value, dict)`: a plain object, as a structured clone or a parsed JSON value has them. */
function isDict(value: unknown): value is { [key: string]: unknown } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactly(value: { [key: string]: unknown }, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** `isinstance(value, int) and not isinstance(value, bool)`, for the numbers a structured clone can carry. */
function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function utf8Length(text: string): number {
	return ENCODER.encode(text).length;
}

/** `_check_path`, in its order. */
function checkPath(path: unknown): string {
	if (typeof path !== "string") throw new InvalidManifest("A path is a string.");
	if (!path.isWellFormed()) throw new InvalidManifest("A path is valid UTF-8.");
	if (utf8Length(path) > MAX_PATH_BYTES) throw new InvalidManifest(`A path has at most ${MAX_PATH_BYTES} bytes.`);
	if (path.normalize("NFC") !== path) throw new InvalidManifest(`${pythonRepr(path)} is not in NFC.`);
	if (CONTROL.test(path)) throw new InvalidManifest(`${pythonRepr(path)} contains a control character.`);
	const segments = path.split("/");
	if (segments.length > MAX_DEPTH) throw new InvalidManifest(`${pythonRepr(path)} is more than ${MAX_DEPTH} levels deep.`);
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new InvalidManifest(`${pythonRepr(path)} is not a relative path without empty, . or .. segments.`);
		}
		if (utf8Length(segment) > MAX_SEGMENT_BYTES) throw new InvalidManifest(`${pythonRepr(path)} has a name longer than ${MAX_SEGMENT_BYTES} bytes.`);
	}
	return path;
}

/** Whether a path passes `_check_path` (hydration checks every path it is sent, files 8.1). */
export function isValidPath(path: unknown): path is string {
	try {
		checkPath(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * `parse(data, max_entries)` (files 4.2): throws InvalidManifest, or QuotaExceeded("folder_entries"). The
 * cheap entry check comes before any entry is examined, and the count includes implied directories, checked
 * as each is added.
 */
export function parseManifest(data: unknown, maxEntries: number): Manifest {
	if (!isDict(data) || !hasExactly(data, ["files", "dirs"])) throw new InvalidManifest('A manifest is an object with exactly "files" and "dirs".');
	const rawFiles = data.files;
	const rawDirs = data.dirs;
	if (!Array.isArray(rawFiles) || !Array.isArray(rawDirs)) throw new InvalidManifest('"files" and "dirs" are lists.');
	// Checked first, so an oversized manifest costs nothing more.
	if (rawFiles.length + rawDirs.length > maxEntries) throw new QuotaExceeded("folder_entries");

	const files = new Map<string, FileEntry>();
	for (const item of rawFiles) {
		if (!isDict(item) || !hasExactly(item, ["path", "sha256", "mode", "mtime"])) {
			throw new InvalidManifest("A file entry has exactly path, sha256, mode and mtime.");
		}
		const path = checkPath(item.path);
		const { sha256, mode, mtime } = item;
		if (!isSha256(sha256)) throw new InvalidManifest(`${pythonRepr(path)}: sha256 is 64 lowercase hex digits.`);
		if (!isInt(mode) || !FILE_MODES.includes(mode)) throw new InvalidManifest(`${pythonRepr(path)}: mode is 0644 or 0755.`);
		if (!isInt(mtime) || mtime < 0 || mtime > MAX_MTIME) {
			throw new InvalidManifest(`${pythonRepr(path)}: mtime is an integer number of milliseconds within range.`);
		}
		if (files.has(path)) throw new InvalidManifest(`${pythonRepr(path)} is listed twice.`);
		files.set(path, { sha256, mode: mode as FileMode, mtime });
	}

	// Python keeps the listed directories in a set, whose order is the hash's: insertion order here, the
	// same answer whenever at most one entry is wrong.
	const dirs = new Set<string>();
	for (const item of rawDirs) {
		const path = checkPath(item);
		if (files.has(path) || dirs.has(path)) throw new InvalidManifest(`${pythonRepr(path)} is listed twice.`);
		dirs.add(path);
	}

	// Every ancestor of a listed path is a directory. Counting stops as soon as the limit is passed.
	const implied = new Set<string>();
	for (const path of [...files.keys(), ...dirs]) {
		let end = path.lastIndexOf("/");
		while (end > 0) {
			const parent = path.slice(0, end);
			if (implied.has(parent)) break;
			if (files.has(parent)) throw new InvalidManifest(`${pythonRepr(parent)} is both a file and a directory.`);
			if (dirs.has(parent)) throw new InvalidManifest(`${pythonRepr(parent)} is listed as an empty directory but has entries.`);
			implied.add(parent);
			if (files.size + dirs.size + implied.size > maxEntries) throw new QuotaExceeded("folder_entries");
			end = path.lastIndexOf("/", end - 1);
		}
	}
	const entryCount = files.size + dirs.size + implied.size;
	if (entryCount > maxEntries) throw new QuotaExceeded("folder_entries");
	return { files, dirs: sortByCodePoint(dirs), entryCount };
}

/** `stored_entries(manifest, sizes)` (files 4.3): files by path in code point order, each with its size from the store. */
export function storedEntries(manifest: Manifest, sizes: ReadonlyMap<Sha256, number>): StoredEntries {
	const files: StoredEntries["files"] = {};
	for (const path of sortByCodePoint(manifest.files.keys())) {
		const entry = manifest.files.get(path) as FileEntry;
		const size = sizes.get(entry.sha256);
		if (size === undefined) throw new Error("A file's size is not known.");
		// An own property even for "__proto__", a valid path, which assignment would make the prototype.
		Object.defineProperty(files, path, { value: { sha256: entry.sha256, size, mode: entry.mode, mtime: entry.mtime }, writable: true, enumerable: true, configurable: true });
	}
	return { files, dirs: [...manifest.dirs] };
}

/**
 * A version's files in code point order. An object's own order puts integer-like keys ("9", "10") first,
 * so the entries' order is never read from the object itself.
 */
export function filesOf(entries: StoredEntries): [string, StoredEntries["files"][string]][] {
	return sortByCodePoint(Object.keys(entries.files)).map((path) => [path, entries.files[path] as StoredEntries["files"][string]]);
}

/**
 * `digest(entries)`: SHA-256 over `minerva:folder-version:` and the canonical JSON (lib/canonical.ts) of the
 * entries, as UTF-8, which does not depend on the order of the input. The store keeps that JSON as the
 * version's text and hashes the same (store.ts `#insertVersion`).
 */
export function digestOf(entries: StoredEntries): Sha256 {
	return sha256HexSync(utf8Strict(hashInput("folder-version", entries)));
}

/** A version's size: Σ ceil(size/4096)·4096 over its files. */
export function entriesBytes(entries: StoredEntries): number {
	return folderBytes(Object.values(entries.files).map((entry) => entry.size));
}

/** Files, directories listed and implied (the root not counted): what a version's entries take. */
export function entryCountOf(entries: StoredEntries): number {
	return Object.keys(entries.files).length + directories(entries).size;
}

/** The first segment of every file and directory at the root: what attachment names are numbered against (files 10). */
export function rootNames(entries: StoredEntries | null): Set<string> {
	const names = new Set<string>();
	if (entries === null) return names;
	for (const path of [...Object.keys(entries.files), ...entries.dirs]) names.add(path.split("/", 1)[0] as string);
	return names;
}

/** A version as a scan would report it: its files with sizes left out, in path order, and its empty directories. */
export function wireOf(entries: StoredEntries): WireManifest {
	return {
		files: filesOf(entries).map(([path, entry]) => ({ path, sha256: entry.sha256, mode: entry.mode, mtime: entry.mtime })),
		dirs: [...entries.dirs],
	};
}

/**
 * `_same(current, manifest)` (files 7.3): the same paths with the same hash, mode and mtime, and the same
 * empty directories; sizes are not compared. With no current version, only an empty manifest is the same.
 */
export function sameManifest(current: StoredEntries | null, manifest: Manifest): boolean {
	if (current === null) return manifest.files.size === 0 && manifest.dirs.length === 0;
	const paths = Object.keys(current.files);
	if (paths.length !== manifest.files.size) return false;
	for (const path of paths) {
		const ours = manifest.files.get(path);
		const theirs = current.files[path];
		if (!ours || !theirs || ours.sha256 !== theirs.sha256 || ours.mode !== theirs.mode || ours.mtime !== theirs.mtime) return false;
	}
	return current.dirs.length === manifest.dirs.length && current.dirs.every((dir, index) => dir === manifest.dirs[index]);
}

/** What the scan left out, as stored: `{"total", "items": [{"path", "reason"}]}`. */
export interface StoredWarnings {
	total: number;
	items: { path: string; reason: string }[];
}

// What `unicodedata.category(char) in ("Cc", "Cs")` refuses: control characters and lone surrogates.
const CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/**
 * `parse_warnings(data)` (files 7.5): at most 100 items, a total that counts them below 2^31, a known reason
 * each, and a path of 1 to 1,024 code points without control characters or lone surrogates. Throws
 * InvalidManifest.
 */
export function parseWarnings(data: unknown): StoredWarnings {
	if (!isDict(data) || !hasExactly(data, ["total", "items"])) throw new InvalidManifest('Warnings are {"total", "items"}.');
	const { total, items } = data;
	if (!Array.isArray(items) || items.length > WARNINGS_KEPT) throw new InvalidManifest(`Warnings list at most ${WARNINGS_KEPT} items.`);
	if (!isInt(total) || !(items.length <= total && total < 2 ** 31)) throw new InvalidManifest("The warnings' total is not a count of their items.");
	const kept: StoredWarnings["items"] = [];
	for (const item of items) {
		if (!isDict(item) || !hasExactly(item, ["path", "reason"]) || typeof item.reason !== "string" || !WARNING_REASONS.includes(item.reason)) {
			throw new InvalidManifest('A warning is {"path", "reason"}, with a known reason.');
		}
		const path = item.path;
		if (typeof path !== "string" || path.length === 0 || codePointLength(path) > WARNING_PATH_CHARS || CONTROL_OR_SURROGATE.test(path)) {
			throw new InvalidManifest("A warning's path is empty, too long, or has control characters.");
		}
		kept.push({ path, reason: item.reason });
	}
	return { total, items: kept };
}

/** `_directories(entries)`: every directory of a version, listed or implied. */
export function directories(entries: StoredEntries | null): Set<string> {
	const implied = new Set<string>();
	if (entries === null) return implied;
	for (const path of [...Object.keys(entries.files), ...entries.dirs]) {
		let end = path.lastIndexOf("/");
		// A directory's parents were added with it.
		while (end > 0 && !implied.has(path.slice(0, end))) {
			implied.add(path.slice(0, end));
			end = path.lastIndexOf("/", end - 1);
		}
	}
	for (const dir of entries.dirs) implied.add(dir);
	return implied;
}

type ChangeKind = "added" | "modified" | "deleted" | "dirs_added" | "dirs_deleted";

/** What a turn changed (files 7.7), in the shape `RunOut.folder_changes` has. */
export type FolderChanges = {
	counts: { [kind in ChangeKind]: number };
	added: { path: string; size: number }[];
	modified: { path: string; size: number }[];
	deleted: { path: string; size: number }[];
	dirs_added: string[];
	dirs_deleted: string[];
};

type ChangeEntries = { files: { [path: string]: { sha256: string; mode: number; size: number } }; dirs: string[] };

/**
 * `folder_changes(before, after)`: files added, modified (contents or mode; mtime alone does not count) and
 * deleted, and directories added and deleted (listed or implied), each list cut to its first 100 in code
 * point order with complete counts; null when nothing changed.
 */
export function folderChanges(before: ChangeEntries | null, after: ChangeEntries): FolderChanges | null {
	const old = (before ?? { files: {}, dirs: [] }).files;
	const now = after.files;
	const sorted = (paths: Iterable<string>) => sortByCodePoint(paths);
	const added = sorted(Object.keys(now).filter((path) => !Object.hasOwn(old, path)));
	const modified = sorted(
		Object.keys(now).filter((path) => {
			const was = old[path];
			const is = now[path];
			return Object.hasOwn(old, path) && was !== undefined && is !== undefined && (is.sha256 !== was.sha256 || is.mode !== was.mode);
		}),
	);
	const deleted = sorted(Object.keys(old).filter((path) => !Object.hasOwn(now, path)));
	const oldDirs = directories(before as StoredEntries | null);
	const newDirs = directories(after as StoredEntries);
	const dirsAdded = sorted([...newDirs].filter((dir) => !oldDirs.has(dir)));
	const dirsDeleted = sorted([...oldDirs].filter((dir) => !newDirs.has(dir)));
	if (!added.length && !modified.length && !deleted.length && !dirsAdded.length && !dirsDeleted.length) return null;
	const withSizes = (paths: string[], from: ChangeEntries["files"]) =>
		paths.slice(0, CHANGES_KEPT).map((path) => ({ path, size: (from[path] as { size: number }).size }));
	return {
		counts: { added: added.length, modified: modified.length, deleted: deleted.length, dirs_added: dirsAdded.length, dirs_deleted: dirsDeleted.length },
		added: withSizes(added, now),
		modified: withSizes(modified, now),
		deleted: withSizes(deleted, old),
		dirs_added: dirsAdded.slice(0, CHANGES_KEPT),
		dirs_deleted: dirsDeleted.slice(0, CHANGES_KEPT),
	};
}

/** Code point order for anything keyed by path. */
export const byPath = compareCodePoints;
