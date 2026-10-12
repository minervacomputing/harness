// A thin client for the Google Drive API v3, ported from backend/connectors/google_drive/client.py.
// Responses are validated before use.

import { z } from "zod";
import type { ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { concat, utf8 } from "../../lib/bytes.ts";
import { type JsonObject, visibleJson } from "../../lib/json.ts";
import { tokenHex } from "../../lib/random.ts";
import { GoogleUser, USERINFO_URL, classify, segment } from "../google/index.ts";
import { laxBool, model } from "../google/model.ts";

export const API_URL = "https://www.googleapis.com/drive/v3";
export const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const FOLDER = "application/vnd.google-apps.folder";
export const SHORTCUT = "application/vnd.google-apps.shortcut";
export const FILE_FIELDS =
	"id,name,mimeType,parents,driveId,size,modifiedTime,webViewLink,trashed,shortcutDetails(targetId,targetMimeType),capabilities(canAddChildren,canListChildren,canDownload)";
/** Files may be in shared drives; without these Drive acts as if they did not exist. */
const ALL_DRIVES = { supportsAllDrives: "true" };

/** A string literal in Drive's query language. */
export function quoted(text: string): string {
	return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

const Capabilities = model({
	can_add_children: laxBool.nullable().default(null),
	can_list_children: laxBool.nullable().default(null),
	can_download: laxBool.nullable().default(null),
});

const ShortcutDetails = model({
	target_id: z.string().nullable().default(null),
	target_mime_type: z.string().nullable().default(null),
});

export const DriveFile = model({
	id: z.string(),
	name: z.string().default(""),
	mime_type: z.string().default(""),
	parents: z.array(z.string()).nullable().default(null),
	drive_id: z.string().nullable().default(null),
	size: z.string().nullable().default(null),
	modified_time: z.string().nullable().default(null),
	web_view_link: z.string().nullable().default(null),
	trashed: laxBool.default(false),
	shortcut_details: ShortcutDetails.nullable().default(null),
	capabilities: Capabilities.nullable().default(null),
});
export type DriveFile = z.output<typeof DriveFile>;

export function isFolder(file: DriveFile): boolean {
	return file.mime_type === FOLDER;
}

const FilePage = model({
	files: z.array(DriveFile).default([]),
	next_page_token: z.string().nullable().default(null),
	incomplete_search: laxBool.default(false),
});
export type FilePage = z.output<typeof FilePage>;

const SharedDrive = model({ id: z.string(), name: z.string().default("") });
export type SharedDrive = z.output<typeof SharedDrive>;

const DrivePage = model({
	drives: z.array(SharedDrive).default([]),
	next_page_token: z.string().nullable().default(null),
});
export type DrivePage = z.output<typeof DrivePage>;

const RootId = model({ id: z.string() });

export interface FileQuery {
	limit: number;
	pageToken: string | null;
	driveId?: string | null;
	allDrives?: boolean;
	orderBy?: string | null;
}

export class GoogleDriveClient implements ProviderClient {
	readonly http: ProviderHTTP;
	readonly #uploadUrl: string;

	constructor(accessToken: string, io: ProviderIo, options: { baseUrl?: string; uploadUrl?: string } = {}) {
		this.#uploadUrl = options.uploadUrl ?? UPLOAD_URL;
		this.http = new ProviderHTTP(io, {
			provider: "Google Drive",
			baseUrl: options.baseUrl ?? API_URL,
			headers: { Authorization: `Bearer ${accessToken}` },
			classify,
		});
	}

	close(): Promise<void> {
		return this.http.close();
	}

	user(): Promise<GoogleUser> {
		return this.http.parsed({ method: "GET", path: USERINFO_URL }, GoogleUser);
	}

	async rootId(): Promise<string> {
		return (await this.http.parsed({ method: "GET", path: "/files/root", query: { fields: "id" } }, RootId)).id;
	}

	file(fileId: string): Promise<DriveFile> {
		return this.http.parsed({ method: "GET", path: `/files/${segment(fileId)}`, query: { ...ALL_DRIVES, fields: FILE_FIELDS } }, DriveFile);
	}

	files(q: string, options: FileQuery): Promise<FilePage> {
		const query: { [name: string]: string | number } = {
			...ALL_DRIVES,
			includeItemsFromAllDrives: "true",
			q,
			pageSize: options.limit,
			fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
		};
		if (options.driveId) {
			query.corpora = "drive";
			query.driveId = options.driveId;
		} else if (options.allDrives) {
			query.corpora = "allDrives";
		}
		if (options.orderBy) query.orderBy = options.orderBy;
		if (options.pageToken) query.pageToken = options.pageToken;
		return this.http.parsed({ method: "GET", path: "/files", query }, FilePage);
	}

	drives(pageToken: string | null): Promise<DrivePage> {
		const query: { [name: string]: string | number } = { pageSize: 100 };
		if (pageToken) query.pageToken = pageToken;
		return this.http.parsed({ method: "GET", path: "/drives", query }, DrivePage);
	}

	drive(driveId: string): Promise<SharedDrive> {
		return this.http.parsed({ method: "GET", path: `/drives/${segment(driveId)}` }, SharedDrive);
	}

	async export(fileId: string, mimeType: string, limit: number): Promise<Uint8Array> {
		const response = await this.http.download({ method: "GET", path: `/files/${segment(fileId)}/export`, query: { mimeType } }, limit);
		return new Uint8Array(await response.arrayBuffer());
	}

	async content(fileId: string, limit: number): Promise<Uint8Array> {
		const response = await this.http.download({ method: "GET", path: `/files/${segment(fileId)}`, query: { ...ALL_DRIVES, alt: "media" } }, limit);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** One multipart upload: the file's metadata and its text in a single request. */
	create(metadata: JsonObject, content: Uint8Array): Promise<DriveFile> {
		const boundary = `minerva-${tokenHex(16)}`;
		if (contains(content, utf8(boundary))) throw new OperationError("PROVIDER_REJECTED", "The file content could not be encoded. Try again.");
		const body = concat(
			utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
			utf8(visibleJson(metadata)),
			utf8(`\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`),
			content,
			utf8(`\r\n--${boundary}--`),
		);
		return this.http.parsed(
			{
				method: "POST",
				path: this.#uploadUrl,
				query: {
					...ALL_DRIVES,
					uploadType: "multipart",
					// A domain's default link sharing would otherwise apply to the new file.
					ignoreDefaultVisibility: "true",
					fields: FILE_FIELDS,
				},
				headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
				body,
			},
			DriveFile,
		);
	}
}

/** `needle in haystack` for bytes. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}
