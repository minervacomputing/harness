// The attachment and upload limits a run start and an upload check, and their messages.

/** Unattached uploads a user may hold in a workspace. */
export const PENDING_UPLOADS = 30;
/** Uploads a user may have arriving at once. */
export const UPLOADS_IN_FLIGHT = 3;
/** A body still arriving 15 minutes after its start is refused. */
export const UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
/** Pending uploads whose object never completed are deleted after this (ARCHITECTURE.md: Files). */
export const PENDING_UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
/** Unattached uploads are deleted a day after they were recorded, as the bucket's lifecycle rule does. */
export const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const UPLOADING_TOO_MANY = "You are uploading too many files at once.";
export const TOO_MANY_UPLOADS = "You have too many files waiting to be sent. Send or remove some, or try again tomorrow.";
export const ATTACHED_TWICE = "A file is attached twice.";

export function tooManyAttachments(limit: number): string {
	return `Attach at most ${limit} files to a message.`;
}
