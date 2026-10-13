// Microsoft Graph for files in OneDrive and SharePoint document libraries.
//
// Items are addressed by drive and item id (`/drives/{drive}/items/{item}`), never by path, except for the
// name of a file being created. A file's content comes from the pre-authenticated download URL Graph gives
// with the item: a second client that sends no token fetches it, only over HTTPS from Microsoft's file
// hosts, and follows no redirect. Uploads send `conflictBehavior=fail`, so an existing file is never
// replaced.
//
// Microsoft Search (`/search/query`) covers what a work or school account can open; personal accounts search
// their own OneDrive and what was shared with them (`/me/drive/search`).

import { z } from "zod";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP, type ProviderIo, segment } from "../../gateway/http.ts";
import { type Json, parseJsonBytes } from "../../lib/json.ts";
import { API_URL, type Classify, Graph, MAX_RESPONSE_BYTES, classify, errorCode, pageParam } from "../microsoft/index.ts";
import { percentEncode } from "../../lib/text.ts";

export const ITEM_FIELDS = "id,name,size,file,folder,root,package,remoteItem,parentReference,webUrl,lastModifiedDateTime";
export const DOWNLOAD_FIELDS = `${ITEM_FIELDS},@microsoft.graph.downloadUrl`;
export const DRIVE_FIELDS = "id,name,driveType,webUrl";
/** Where Graph's download URLs point: SharePoint (work and school) and OneDrive's personal file hosts. */
export const DOWNLOAD_HOSTS = [".sharepoint.com", ".1drv.com", ".microsoftpersonalcontent.com"];

const ItemReference = z.object({
	driveId: z.string().nullable().default(null),
	driveType: z.string().nullable().default(null),
	id: z.string().nullable().default(null),
});

const FileFacet = z.object({ mimeType: z.string().nullable().default(null) });
const FolderFacet = z.object({ childCount: z.number().int().nullable().default(null) });
const RemoteItem = z.object({ id: z.string().nullable().default(null), parentReference: ItemReference.nullable().default(null) });

export const DriveItem = z.object({
	id: z.string(),
	name: z.string().default(""),
	size: z.number().int().nullable().default(null),
	file: FileFacet.nullable().default(null),
	folder: FolderFacet.nullable().default(null),
	// Facets that Graph may send empty ({}): test them for presence.
	root: z.object({}).nullable().default(null),
	package: z.object({}).nullable().default(null),
	remoteItem: RemoteItem.nullable().default(null),
	parentReference: ItemReference.nullable().default(null),
	webUrl: z.string().nullable().default(null),
	lastModifiedDateTime: z.string().nullable().default(null),
	"@microsoft.graph.downloadUrl": z.string().nullable().default(null),
});
export type DriveItem = z.output<typeof DriveItem>;

export const Drive = z.object({
	id: z.string(),
	name: z.string().default(""),
	driveType: z.string().nullable().default(null),
	webUrl: z.string().nullable().default(null),
});
export type Drive = z.output<typeof Drive>;

export const Site = z.object({
	id: z.string(),
	name: z.string().nullable().default(null),
	displayName: z.string().nullable().default(null),
	webUrl: z.string().nullable().default(null),
});
export type Site = z.output<typeof Site>;

/** Graph's errors as OneDrive names them: a name that exists is a rejection, the rest as the other Graph connectors. */
export const driveClassify: Classify = (provider, response, body, bytes) => {
	if (response.status === 409 && errorCode(bytes) === "nameAlreadyExists") {
		return new OperationError("PROVIDER_REJECTED", "A file or folder with this name already exists in this folder.");
	}
	return classify(provider, response, body, bytes);
};

/**
 * Whether a download URL Graph gave is one Minerva fetches: HTTPS on Microsoft's file hosts, no user name or
 * password, the default port. The request goes where `fetch` (WHATWG) parses it to, so the URL as written must
 * already say the same: `https://` and an ASCII host that parsing does not change (no percent escapes,
 * full-width letters or extra slashes), and no ":" before an "@". Unicode hosts are refused.
 */
export function downloadAllowed(url: string): boolean {
	if (url.length > 8000 || url.includes("\\") || [...url].some((char) => (char.codePointAt(0) as number) <= 0x20 || char === "\u007f")) return false;
	const authority = /^https:\/\/([^/?#]*)/i.exec(url)?.[1];
	if (!authority) return false;
	const at = authority.lastIndexOf("@");
	if (at > 0) return false;
	const written = authority.slice(at + 1).replace(/:[0-9]*$/, "");
	if (!/^[\x21-\x7e]+$/.test(written)) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	return (
		written.toLowerCase() === host &&
		parsed.protocol === "https:" &&
		!parsed.username &&
		!parsed.password &&
		parsed.port === "" &&
		DOWNLOAD_HOSTS.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
	);
}

/** Microsoft Search's answer: hits in containers, each hit's resource a driveItem that may leave out its id. */
const SearchAnswer = z.object({
	value: z.array(
		z.object({
			hitsContainers: z
				.array(
					z.object({
						hits: z.array(z.object({ hitId: z.string().nullable().default(null), resource: z.looseObject({ id: z.string().nullable().default(null) }) })).nullable().default(null),
						moreResultsAvailable: z.boolean().default(false),
					}),
				)
				.nullable()
				.default(null),
		}),
	),
});

/** Thin client for the parts of Microsoft Graph OneDrive and SharePoint files use. */
export class DriveClient extends Graph {
	/** Download URLs carry their own authorization; this client never holds the token. */
	readonly files: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		super("OneDrive", accessToken, io, { baseUrl, classify: driveClassify });
		this.files = new ProviderHTTP(io, { provider: "OneDrive", baseUrl: "", headers: {} });
	}

	override async close(): Promise<void> {
		await super.close();
		await this.files.close();
	}

	/** The account's own OneDrive, or null when it has none (say, a guest or an unlicensed user). */
	async myDrive(): Promise<Drive | null> {
		let body: { [key: string]: Json };
		try {
			body = await this.get("/me/drive", { params: { $select: DRIVE_FIELDS } });
		} catch (error) {
			if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN" || error.code === "PROVIDER_REJECTED")) return null;
			throw error;
		}
		return this.parse(Drive, body);
	}

	async drive(driveId: string): Promise<Drive> {
		return this.parse(Drive, await this.get(`/drives/${segment(driveId)}`, { params: { $select: DRIVE_FIELDS } }));
	}

	async myRoot(): Promise<DriveItem> {
		return this.parse(DriveItem, await this.get("/me/drive/root", { params: { $select: ITEM_FIELDS } }));
	}

	async driveRoot(driveId: string): Promise<DriveItem> {
		return this.parse(DriveItem, await this.get(`/drives/${segment(driveId)}/root`, { params: { $select: ITEM_FIELDS } }));
	}

	/** An item by id. With `download`, Graph includes a short-lived download URL for a file. */
	async item(driveId: string, itemId: string, download = false): Promise<DriveItem> {
		const params = { $select: download ? DOWNLOAD_FIELDS : ITEM_FIELDS };
		return this.parse(DriveItem, await this.get(`/drives/${segment(driveId)}/items/${segment(itemId)}`, { params }));
	}

	async children(driveId: string, itemId: string, limit: number, cursor: string | null): Promise<[DriveItem[], string | null]> {
		const params = { $select: ITEM_FIELDS, $top: String(limit), ...(cursor ? pageParam(cursor) : {}) };
		return this.page(DriveItem, await this.get(`/drives/${segment(driveId)}/items/${segment(itemId)}/children`, { params }));
	}

	/** The SharePoint sites the account follows, at most `limit`, and whether there are more. */
	async followedSites(limit: number): Promise<[Site[], boolean]> {
		const body = await this.get("/me/followedSites", { params: { $select: "id,name,displayName,webUrl", $top: String(limit) } });
		const [sites, more] = this.page(Site, body);
		return [sites.slice(0, limit), more !== null || sites.length > limit];
	}

	/** A site's document libraries, at most `limit`. */
	async libraries(siteId: string, limit: number): Promise<Drive[]> {
		const body = await this.get(`/sites/${segment(siteId)}/drives`, { params: { $select: DRIVE_FIELDS, $top: String(limit) } });
		const [drives] = this.page(Drive, body, () => null);
		return drives.slice(0, limit);
	}

	/** Microsoft Search over files: the items hit, in rank order, and whether there are more. */
	async searchWork(text: string, offset: number, size: number): Promise<[DriveItem[], boolean]> {
		const request = { entityTypes: ["driveItem"], query: { queryString: text }, from: offset, size };
		const response = await this.http.bounded(
			{ method: "POST", path: "/search/query", json: { requests: [request] } },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", "OneDrive returned more than Minerva reads."),
		);
		let answer: unknown;
		try {
			answer = parseJsonBytes(await response.arrayBuffer());
		} catch (error) {
			throw this.unexpected(error);
		}
		const items: DriveItem[] = [];
		let more = false;
		for (const container of this.parse(SearchAnswer, answer).value.flatMap((found) => found.hitsContainers ?? [])) {
			more ||= container.moreResultsAvailable;
			for (const hit of container.hits ?? []) {
				// For a driveItem, hitId is the item's id.
				const itemId = hit.resource.id || hit.hitId;
				if (!itemId) throw this.unexpected();
				items.push(this.parse(DriveItem, { ...hit.resource, id: itemId }));
			}
		}
		return [items, more];
	}

	/** A personal account's search: its own OneDrive and items shared with it. */
	async searchPersonal(text: string, limit: number, cursor: string | null): Promise<[DriveItem[], string | null]> {
		const literal = percentEncode(text.replaceAll("'", "''"));
		const params = { $select: ITEM_FIELDS, $top: String(limit), ...(cursor ? pageParam(cursor) : {}) };
		return this.page(DriveItem, await this.get(`/me/drive/search(q='${literal}')`, { params }));
	}

	async content(url: string, limit: number): Promise<Uint8Array> {
		if (!downloadAllowed(url)) throw new OperationError("PROVIDER_FAILED", "OneDrive offered this file from an address Minerva does not download from.");
		const response = await this.files.download({ method: "GET", path: url }, limit);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** The one write of an operation: a new file in a folder, refused if the name is taken. */
	async upload(driveId: string, folderId: string, name: string, content: Uint8Array): Promise<DriveItem> {
		const body = await this.http.json({
			method: "PUT",
			path: `/drives/${segment(driveId)}/items/${segment(folderId)}:/${segment(name)}:/content`,
			query: { "@microsoft.graph.conflictBehavior": "fail" },
			body: content,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
		return this.parse(DriveItem, body);
	}
}

