// The attachment limits a run start checks, with today's messages (backend/files/uploads.py `attach`,
// `_over`, `size_text`; files 2, 9, 10).

/** Unattached uploads a user may hold in a workspace (uploads.py PENDING_UPLOADS). */
export const PENDING_UPLOADS = 30;
/** Uploads a user may have arriving at once (files 9.1, check 13). */
export const UPLOADS_IN_FLIGHT = 3;
/** A body still arriving 15 minutes after its start is refused (files 9.1, check 14). */
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

/** What tmpfs charges for a file: whole pages, empty files nothing (files 4.4). */
export function pages(size: number): number {
	return Math.ceil(size / PAGE_BYTES) * PAGE_BYTES;
}

/** Python's `format(value, "g")`: six significant digits, trailing zeros dropped, exponent outside [-4, 6). */
export function formatG(value: number): string {
	if (value === 0) return Object.is(value, -0) ? "-0" : "0";
	if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
	const [mantissa = "", power = "0"] = value.toExponential(5).split("e");
	const exponent = Number(power);
	const trim = (digits: string) => (digits.includes(".") ? digits.replace(/0+$/, "").replace(/\.$/, "") : digits);
	if (exponent < -4 || exponent >= 6) return `${trim(mantissa)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
	return trim(value.toFixed(Math.max(0, 5 - exponent)));
}

/** `size_text(n)`: `f"{n/2**30:g} GB"` from a GiB, else `f"{n/2**20:g} MB"`. */
export function sizeText(bytes: number): string {
	return bytes >= 2 ** 30 ? `${formatG(bytes / 2 ** 30)} GB` : `${formatG(bytes / 2 ** 20)} MB`;
}

/** `f"{n:,}"`. */
export function thousands(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function tooManyAttachments(limit: number): string {
	return `Attach at most ${limit} files to a message.`;
}

/** `_over(limit)`: the 413 of an attachment that would pass a folder limit. */
export function overFolder(limit: "folder_entries" | "folder_bytes", folderEntries: number, folderBytes: number): string {
	if (limit === "folder_entries") return `These files would put more than ${thousands(folderEntries)} files and folders in this conversation's folder.`;
	return `These files would make this conversation's folder larger than ${sizeText(folderBytes)}.`;
}
