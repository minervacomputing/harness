// The constants and messages of agent files (files 2, 7.10, 10; backend/files/{manifest,limits,runs,
// uploads}.py and the folder parts of backend/gateway/views.py). The limits that are settings come from
// config.ts (`Settings.files`); the rest are constants, as today.

import type { FolderLimit } from "../contracts/files.ts";
import { NO_LONGER_AVAILABLE, NO_ROOM, sizeText } from "../workspace/limits.ts";

export { NO_LONGER_AVAILABLE, NO_ROOM, sizeText };

/** UTF-8 bytes of a relative path, and of one of its names (manifest.py). */
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
/** Segments in a path. */
export const MAX_DEPTH = 32;
/** 9999-12-31T23:59:59.999Z, in milliseconds since the epoch. */
export const MAX_MTIME = 253_402_300_799_999;
export const PAGE_BYTES = 4096;
/** 0o644 and 0o755. */
export const FILE_MODES: readonly number[] = [0o644, 0o755];

/** Why the scan left an entry out (runs.py WARNING_REASONS). */
export const WARNING_REASONS: readonly string[] = ["symlink", "special", "invalid_name", "too_long", "too_deep", "unreadable"];
/** Warning items kept per checkpoint, and the code points of a warning's path. */
export const WARNINGS_KEPT = 100;
export const WARNING_PATH_CHARS = 1024;
/** Paths listed of each kind of change; the counts are complete. */
export const CHANGES_KEPT = 100;

/** The longest suffix kept as a file's extension when its name is shortened or numbered (uploads.py). */
export const MAX_EXTENSION_CHARS = 16;
/** The head of an upload its media type is sniffed from. */
export const SNIFF_BYTES = 8192;

/** A limit would be passed: `QuotaExceeded(limit)`, with Python's message. */
export class QuotaExceeded extends Error {
	readonly limit: FolderLimit;

	constructor(limit: FolderLimit) {
		super(`The ${limit} limit would be exceeded.`);
		this.name = "QuotaExceeded";
		this.limit = limit;
	}
}

/** `folder_bytes(sizes)`: bytes as tmpfs charges them, each file rounded up to whole pages (an empty file takes none). */
export function folderBytes(sizes: Iterable<number>): number {
	let total = 0;
	for (const size of sizes) total += pages(size);
	return total;
}

export function pages(size: number): number {
	return Math.ceil(size / PAGE_BYTES) * PAGE_BYTES;
}

/**
 * Python's `f"{x:.0f}"`: the nearest integer, a tie to the even one. `n / 2**20` is exact in binary, so a
 * tie is exactly half.
 */
function roundHalfEven(x: number): number {
	const floor = Math.floor(x);
	const fraction = x - floor;
	if (fraction > 0.5) return floor + 1;
	if (fraction < 0.5) return floor;
	return floor % 2 === 0 ? floor : floor + 1;
}

/** gateway/views.py `_mib(n)`: `f"{n / 2**20:.0f} MiB"` from one MiB, else `f"{n} bytes"`. */
export function mib(bytes: number): string {
	return bytes >= 2 ** 20 ? `${roundHalfEven(bytes / 2 ** 20)} MiB` : `${bytes} bytes`;
}

export interface FolderLimits {
	folderBytes: number;
	folderEntries: number;
	runUploadBytes: number;
}

/**
 * The run's error for a folder over `limit` (gateway/views.py `_limit_message`, runs 2.3): its own text,
 * never the worker's. `folder_entries` has no thousands separator, unlike the attachment refusal (files 10).
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

/** `upload_app.py`: the 413 of a body over the upload limit. */
export function uploadTooLarge(uploadBytes: number): string {
	return `A file can be at most ${sizeText(uploadBytes)}.`;
}

// Uploads (files 9.1), in the order the checks run.
export const USE_POST = "Use POST.";
export const SEND_LENGTH = "Send a Content-Length.";
export const INVALID_LENGTH = "Invalid Content-Length.";
export const NAME_THE_FILE = "Name the file with ?name=.";
export const TOO_SLOW = "The file took too long to arrive.";
export const BODY_LONGER = "The body is longer than its Content-Length.";
export const BODY_SHORTER = "The body is shorter than its Content-Length.";

/** An upload's body still arriving 15 minutes after its start is refused (upload_app.py DEADLINE_SECONDS). */
export const UPLOAD_DEADLINE_MS = 15 * 60 * 1000;

// Checkpoints (files 7.3): `CheckpointRefused`'s messages.
export const STALE = "This attempt is no longer the run's current one.";
export const CONFLICT = "The parent is not the run's last checkpoint.";
export const BLOB_GONE = "A blob is no longer in the store.";

export function unreadableMessage(count: number): string {
	return `${count} blob(s) are not readable by this run.`;
}

export function quotaRefusal(limit: FolderLimit): string {
	return `The folder is over its ${limit} limit.`;
}

/** Loose objects not claimed within this are deleted (files 13.1; plan: Files). */
export const LOOSE_GRACE_MS = 60 * 60 * 1000;
/** An object is deleted once more this long after its first deletion, for a write that was still in flight. */
export const SECOND_DELETION_MS = 24 * 60 * 60 * 1000;
/** A download link is good for this long (plan: Files, Downloads). */
export const LINK_LIFETIME_MS = 5 * 60 * 1000;
