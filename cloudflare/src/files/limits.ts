// The constants and messages of agent files. The limits that are settings come from config.ts
// (`Settings.files`); the rest are constants.

/** The four limits a folder can hit; the same strings everywhere. */
export type FolderLimit = "folder_bytes" | "folder_entries" | "run_uploads" | "workspace";

export const NO_ROOM = "This workspace has no room for more files.";
export const NO_LONGER_AVAILABLE = "An attached file is no longer available. Remove it and attach it again.";

/** UTF-8 bytes of a relative path, and of one of its names. */
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
/** Segments in a path. */
export const MAX_DEPTH = 32;
/** 9999-12-31T23:59:59.999Z, in milliseconds since the epoch. */
export const MAX_MTIME = 253_402_300_799_999;
export const PAGE_BYTES = 4096;
/** 0o644 and 0o755. */
export const FILE_MODES: readonly number[] = [0o644, 0o755];

/** Why the scan left an entry out. */
export const WARNING_REASONS: readonly string[] = ["symlink", "special", "invalid_name", "too_long", "too_deep", "unreadable"];
/** Warning items kept per checkpoint, and the UTF-16 units of a warning's path. */
export const WARNINGS_KEPT = 100;
export const WARNING_PATH_CHARS = 1024;
/** Paths listed of each kind of change; the counts are complete. */
export const CHANGES_KEPT = 100;

/** The longest suffix kept as a file's extension when its name is shortened or numbered. */
export const MAX_EXTENSION_CHARS = 16;
/** The head of an upload its media type is sniffed from. */
export const SNIFF_BYTES = 8192;

/** A limit would be passed. */
export class QuotaExceeded extends Error {
	readonly limit: FolderLimit;

	constructor(limit: FolderLimit) {
		super(`The ${limit} limit would be exceeded.`);
		this.name = "QuotaExceeded";
		this.limit = limit;
	}
}

/** Bytes as tmpfs charges them, each file rounded up to whole pages (an empty file takes none). */
export function folderBytes(sizes: Iterable<number>): number {
	let total = 0;
	for (const size of sizes) total += pages(size);
	return total;
}

export function pages(size: number): number {
	return Math.ceil(size / PAGE_BYTES) * PAGE_BYTES;
}

// Made on first use: a number format built at module load costs the Worker's startup (cloudflare/README.md, Startup).
let size: Intl.NumberFormat | undefined;

/** A size for a message: in GB from a GiB, else in MB, binary units either way ("256 MB", "1.5 GB"). */
export function sizeText(bytes: number): string {
	size ??= new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6, useGrouping: false });
	return bytes >= 2 ** 30 ? `${size.format(bytes / 2 ** 30)} GB` : `${size.format(bytes / 2 ** 20)} MB`;
}

/** A count with thousands separators ("10,000"). */
export function thousands(n: number): string {
	return n.toLocaleString("en-US");
}

/** Whole MiB from one MiB, else bytes. */
export function mib(bytes: number): string {
	return bytes >= 2 ** 20 ? `${Math.round(bytes / 2 ** 20)} MiB` : `${bytes} bytes`;
}

export interface FolderLimits {
	folderBytes: number;
	folderEntries: number;
	runUploadBytes: number;
}

/**
 * The run's error for a folder over `limit`: its own text, never the worker's. `folder_entries` has no
 * thousands separator, unlike the attachment refusal.
 */
export function folderLimitMessage(limit: FolderLimit, limits: FolderLimits): string {
	switch (limit) {
		case "folder_bytes":
			return `The agent's files grew past the ${mib(limits.folderBytes)} a conversation can keep.`;
		case "folder_entries":
			return `The agent made more than the ${limits.folderEntries} files and folders a conversation can keep.`;
		case "run_uploads":
			return `The agent saved more than the ${mib(limits.runUploadBytes)} of files a turn may save.`;
		default:
			return "The workspace has used all of its storage for files.";
	}
}

/** The 413 of an attachment that would pass a folder limit. */
export function overFolder(limit: "folder_entries" | "folder_bytes", folderEntries: number, folderBytes: number): string {
	if (limit === "folder_entries") return `These files would put more than ${thousands(folderEntries)} files and folders in this conversation's folder.`;
	return `These files would make this conversation's folder larger than ${sizeText(folderBytes)}.`;
}

// Checkpoints: `CheckpointRefused`'s messages.
export const STALE = "This attempt is no longer the run's current one.";
export const CONFLICT = "The parent is not the run's last checkpoint.";
export const BLOB_GONE = "A blob is no longer in the store.";

export function unreadableMessage(count: number): string {
	return `${count} blob(s) are not readable by this run.`;
}

export function quotaRefusal(limit: FolderLimit): string {
	return `The folder is over its ${limit} limit.`;
}

/** Loose objects not claimed within this are deleted (ARCHITECTURE.md: Files). */
export const LOOSE_GRACE_MS = 60 * 60 * 1000;
/** An object is deleted once more this long after its first deletion, for a write that was still in flight. */
export const SECOND_DELETION_MS = 24 * 60 * 60 * 1000;
