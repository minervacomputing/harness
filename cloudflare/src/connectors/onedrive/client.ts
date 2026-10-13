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

import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import type { Json } from "../../lib/json.ts";
import { API_URL, type Classify, Graph, MAX_RESPONSE_BYTES, classify, errorCode, jsonOf, nextCursor, pageParam } from "../microsoft/index.ts";
import { Invalid, dict, int, model, nullable, optional, required, str } from "../microsoft/model.ts";
import { isDict, truthy } from "../../lib/json.ts";
import { extend } from "../../lib/arrays.ts";
import { segment } from "../../lib/text.ts";

export const ITEM_FIELDS = "id,name,size,file,folder,root,package,remoteItem,parentReference,webUrl,lastModifiedDateTime";
export const DOWNLOAD_FIELDS = `${ITEM_FIELDS},@microsoft.graph.downloadUrl`;
export const DRIVE_FIELDS = "id,name,driveType,webUrl";
/** Where Graph's download URLs point: SharePoint (work and school) and OneDrive's personal file hosts. */
export const DOWNLOAD_HOSTS = [".sharepoint.com", ".1drv.com", ".microsoftpersonalcontent.com"];

const ItemReference = model({
	drive_id: optional(nullable(str), null),
	drive_type: optional(nullable(str), null),
	id: optional(nullable(str), null),
});
export type ItemReference = ReturnType<typeof ItemReference>;

const FileFacet = model({ mime_type: optional(nullable(str), null) });
const FolderFacet = model({ child_count: optional(nullable(int), null) });
const RemoteItem = model({ id: optional(nullable(str), null), parent_reference: optional(nullable(ItemReference), null) });

export const DriveItem = model({
	id: required(str),
	name: optional(str, ""),
	size: optional(nullable(int), null),
	file: optional(nullable(FileFacet), null),
	folder: optional(nullable(FolderFacet), null),
	// Facets that Graph may send empty ({}): test them for presence.
	root: optional(nullable(dict), null),
	package: optional(nullable(dict), null),
	remote_item: optional(nullable(RemoteItem), null),
	parent_reference: optional(nullable(ItemReference), null),
	web_url: optional(nullable(str), null),
	last_modified_date_time: optional(nullable(str), null),
	download_url: optional(nullable(str), null, "@microsoft.graph.downloadUrl"),
});
export type DriveItem = ReturnType<typeof DriveItem>;

export const Drive = model({
	id: required(str),
	name: optional(str, ""),
	drive_type: optional(nullable(str), null),
	web_url: optional(nullable(str), null),
});
export type Drive = ReturnType<typeof Drive>;

export const Site = model({
	id: required(str),
	name: optional(nullable(str), null),
	display_name: optional(nullable(str), null),
	web_url: optional(nullable(str), null),
});
export type Site = ReturnType<typeof Site>;

/** Graph's errors as OneDrive names them: a name that exists is a rejection, the rest as the other Graph connectors. */
export const driveClassify: Classify = (provider, response, body, bytes) => {
	if (response.status === 409 && errorCode(bytes) === "nameAlreadyExists") {
		return new OperationError("PROVIDER_REJECTED", "A file or folder with this name already exists in this folder.");
	}
	return classify(provider, response, body, bytes);
};

/**
 * Whether a download URL Graph gave is one Minerva fetches: HTTPS on Microsoft's file hosts, no user name or
 * password, the default port. The request goes where `fetch` (WHATWG) parses it to, so the URL is also held to
 * what httpx reads: `https://` and an ASCII host that parsing does not change (no percent escapes, full-width
 * letters or extra slashes), and no ":" before an "@". Hosts with characters httpx lets through and WHATWG
 * refuses (`<`, `>`, `[`, `]`, `^`, `|`), and Unicode hosts, are refused here and read by Python.
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

/** What Python would iterate in `for x in value`: a list's items, a dict's keys, a string's characters. */
function iterated(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return Array.from(value);
	if (typeof value === "object" && value !== null) return Object.keys(value);
	throw new TypeError(`'${value === null ? "NoneType" : typeof value}' object is not iterable`);
}

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
		const items = Object.hasOwn(body, "value") ? body.value : undefined;
		if (!Array.isArray(items)) throw this.unexpected();
		return items.slice(0, limit).map((item) => this.parse(Drive, item));
	}

	/** Microsoft Search over files: the items hit, in rank order, and whether there are more. */
	async searchWork(text: string, offset: number, size: number): Promise<[DriveItem[], boolean]> {
		const request = { entityTypes: ["driveItem"], query: { queryString: text }, from: offset, size };
		const response = await this.http.bounded(
			{ method: "POST", path: "/search/query", json: { requests: [request] } },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", "OneDrive returned more than Minerva reads."),
		);
		// `[c for answer in body["value"] for c in answer.get("hitsContainers") or []]`, where anything that is
		// not shaped so is an unexpected response.
		let containers: unknown[];
		try {
			const body = jsonOf(new Uint8Array(await response.arrayBuffer()));
			if (!isDict(body) || !Object.hasOwn(body, "value")) throw new Invalid();
			containers = [];
			for (const answer of iterated(body.value)) {
				if (!isDict(answer)) throw new Invalid();
				const found = Object.hasOwn(answer, "hitsContainers") ? answer.hitsContainers : null;
				if (truthy(found)) extend(containers, iterated(found));
			}
		} catch (error) {
			if (error instanceof OperationError) throw error;
			throw this.unexpected(error);
		}
		const items: DriveItem[] = [];
		let more = false;
		for (const container of containers) {
			if (!isDict(container)) throw this.unexpected();
			more = more || (Object.hasOwn(container, "moreResultsAvailable") && container.moreResultsAvailable === true);
			const hits = Object.hasOwn(container, "hits") ? container.hits : null;
			// A TypeError here (hits that cannot be iterated) is not caught.
			for (const hit of truthy(hits) ? iterated(hits) : []) {
				const resource = isDict(hit) && Object.hasOwn(hit, "resource") ? hit.resource : null;
				if (!isDict(resource)) continue;
				// A hit's resource may leave out its id; for a driveItem, hitId is the item's id.
				const own = Object.hasOwn(resource, "id") ? resource.id : null;
				const itemId = truthy(own) ? own : isDict(hit) && Object.hasOwn(hit, "hitId") ? hit.hitId : null;
				if (typeof itemId !== "string") continue;
				items.push(this.parse(DriveItem, { ...resource, id: itemId }));
			}
		}
		return [items, more];
	}

	/** A personal account's search: its own OneDrive and items shared with it. */
	async searchPersonal(text: string, limit: number, cursor: string | null): Promise<[DriveItem[], string | null]> {
		const literal = segment(text.replaceAll("'", "''"));
		const params = { $select: ITEM_FIELDS, $top: String(limit), ...(cursor ? pageParam(cursor) : {}) };
		const body = await this.get(`/me/drive/search(q='${literal}')`, { params });
		const items = Object.hasOwn(body, "value") ? body.value : undefined;
		if (!Array.isArray(items)) throw this.unexpected();
		return [items.map((item) => this.parse(DriveItem, item)), nextCursor(Object.hasOwn(body, "@odata.nextLink") ? body["@odata.nextLink"] : null)];
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

