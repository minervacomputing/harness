// The attachment and upload limits a run start and an upload check, and their messages.

/** Unattached uploads a user may hold in a workspace. */
export const PENDING_UPLOADS = 30;
/** Uploads a user may have arriving at once. */
export const UPLOADS_IN_FLIGHT = 3;
/** A body still arriving 15 minutes after its start is refused. */
export const UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
/** Pending uploads whose object never completed are deleted after this (plan: Files). */
export const PENDING_UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
/** Unattached uploads are deleted a day after they were recorded, as the bucket's lifecycle rule does. */
export const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PAGE_BYTES = 4096;

export const UPLOADING_TOO_MANY = "You are uploading too many files at once.";
export const TOO_MANY_UPLOADS = "You have too many files waiting to be sent. Send or remove some, or try again tomorrow.";
export const NO_ROOM = "This workspace has no room for more files.";
export const ATTACHED_TWICE = "A file is attached twice.";
export const NO_LONGER_AVAILABLE = "An attached file is no longer available. Remove it and attach it again.";

/** What tmpfs charges for a file: whole pages, empty files nothing. */
export function pages(size: number): number {
	return Math.ceil(size / PAGE_BYTES) * PAGE_BYTES;
}

const SIZE = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6, useGrouping: false });

/** A size for a message: in GB from a GiB, else in MB, binary units either way ("256 MB", "1.5 GB"). */
export function sizeText(bytes: number): string {
	return bytes >= 2 ** 30 ? `${SIZE.format(bytes / 2 ** 30)} GB` : `${SIZE.format(bytes / 2 ** 20)} MB`;
}

/** A count with thousands separators ("10,000"). */
export function thousands(n: number): string {
	return n.toLocaleString("en-US");
}

export function tooManyAttachments(limit: number): string {
	return `Attach at most ${limit} files to a message.`;
}

/** The 413 of an attachment that would pass a folder limit. */
export function overFolder(limit: "folder_entries" | "folder_bytes", folderEntries: number, folderBytes: number): string {
	if (limit === "folder_entries") return `These files would put more than ${thousands(folderEntries)} files and folders in this conversation's folder.`;
	return `These files would make this conversation's folder larger than ${sizeText(folderBytes)}.`;
}
