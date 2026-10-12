// Confluence Cloud's REST API, reached per site through api.atlassian.com, ported from
// backend/connectors/confluence/client.py.
//
// The v2 API serves spaces, pages and comments; search is v1's CQL search, the only one Confluence has. Both
// page with an opaque cursor in the `_links.next` address. This client takes only the `cursor` parameter from
// that address, checked to be printable and short enough to store, and sends it to the same endpoint with
// the same query again; the address itself is never followed.

import { z } from "zod";
import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { type Json, type JsonObject, parseJson, visibleJson } from "../../lib/json.ts";
import { parseQs, urlsplitStrict } from "../../lib/urlsplit.ts";
import { AtlassianClient, segment } from "../atlassian/index.ts";
import { laxInt, model, optionalStr } from "../atlassian/model.ts";
import { extend } from "../../lib/arrays.ts";

export const MAX_PAGES = 10;
export const BATCH_LIMIT = 250;
const TOKEN = /^[\x21-\x7e]{1,990}$/;
export const PREFIX = "c:";

const camel = { camel: true };
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);
const anything = () => z.custom<Json>().optional().transform((value) => value ?? null);

export const SpaceModel = model({ id: z.string(), key: z.string(), name: optionalStr, type: optionalStr, status: optionalStr }, camel);
export type Space = z.output<typeof SpaceModel>;

const Version = model({ number: optional(laxInt), created_at: optionalStr }, camel);
const Representation = model({ value: anything() }, camel);
export const BodyModel = model({ atlas_doc_format: optional(Representation) }, camel);
export type Body = z.output<typeof BodyModel>;

export const PageModel = model(
	{
		id: z.string(),
		status: optionalStr,
		title: optionalStr,
		space_id: optionalStr,
		parent_id: optionalStr,
		parent_type: optionalStr,
		created_at: optionalStr,
		version: optional(Version),
		body: optional(BodyModel),
	},
	camel,
);
export type Page = z.output<typeof PageModel>;

export const CommentModel = model({ id: z.string(), status: optionalStr, version: optional(Version), body: optional(BodyModel) }, camel);
export type Comment = z.output<typeof CommentModel>;

const Found = model({ id: z.string(), type: optionalStr }, camel);
const Result = model({ content: optional(Found) }, camel);
const Links = model({ next: optionalStr }, camel);
const Dict = z.custom<JsonObject>((value) => typeof value === "object" && value !== null && !Array.isArray(value));
export const ListingModel = model({ results: z.array(Dict).default([]), links: Links.prefault({}) }, { camel: true, aliases: { links: "_links" } });
export type Listing = z.output<typeof ListingModel>;

export function pageParams(cursor: string | null): { [name: string]: string } {
	if (cursor === null) return {};
	const token = cursor.startsWith(PREFIX) ? cursor.slice(PREFIX.length) : cursor;
	if (!cursor.startsWith(PREFIX) || !TOKEN.test(token)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return { cursor: token };
}

/** The cursor of the next page, from the `_links.next` address; null on the last page. */
export function nextToken(listing: Listing): string | null {
	if (!listing.links.next) return null;
	const tokens = parseQs(urlsplitStrict(listing.links.next).query).get("cursor") ?? [];
	if (tokens.length !== 1 || !TOKEN.test(tokens[0] as string)) throw new OperationError("PROVIDER_LIMIT", "Confluence returned a page token Minerva cannot use.");
	return tokens[0] as string;
}

export function nextCursor(listing: Listing): string | null {
	const token = nextToken(listing);
	return token ? `${PREFIX}${token}` : null;
}

/** The ADF document of a page's or comment's body; Confluence sends it as a JSON string. */
export function document(body: Body | null): Json | null {
	const value = body?.atlas_doc_format ? body.atlas_doc_format.value : null;
	if (typeof value !== "string" || !value) return null;
	try {
		return parseJson(value);
	} catch {
		return null;
	}
}

function writtenBody(adf: Json): JsonObject {
	// As Python's json.dumps writes it.
	return { representation: "atlas_doc_format", value: visibleJson(adf) };
}

/** Thin client for the parts of Confluence's API the connector uses. */
export class ConfluenceClient extends AtlassianClient {
	constructor(accessToken: string, io: ProviderIo) {
		super("Confluence", "confluence", accessToken, io, "read:page:confluence");
	}

	#v2(cloudId: string, path: string): string {
		return `${this.api(cloudId)}/wiki/api/v2${path}`;
	}

	async #listing(path: string, params: { [name: string]: string }): Promise<Listing> {
		return this.parse(ListingModel, await this.get(path, params));
	}

	#items<T>(schema: z.ZodType<T>, listing: Listing): T[] {
		return listing.results.map((item) => this.parse(schema, item));
	}

	/** One page of the spaces the account can see, and the token of the next page. */
	async spaces(cloudId: string, options: { limit: number; cursor?: string | null }): Promise<[Space[], string | null]> {
		const params: { [name: string]: string } = { limit: String(options.limit), sort: "name" };
		if (options.cursor) params.cursor = options.cursor;
		const listing = await this.#listing(this.#v2(cloudId, "/spaces"), params);
		return [this.#items(SpaceModel, listing), nextToken(listing)];
	}

	async space(cloudId: string, spaceId: string): Promise<Space> {
		return this.parse(SpaceModel, await this.get(this.#v2(cloudId, `/spaces/${segment(spaceId)}`)));
	}

	/** Every result of a filtered listing, following its pages. */
	async #all(path: string, params: { [name: string]: string }): Promise<JsonObject[]> {
		const found: JsonObject[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const listing = await this.#listing(path, cursor ? { ...params, cursor } : params);
			extend(found, listing.results);
			cursor = nextToken(listing);
			if (cursor === null) return found;
			if (seen.has(cursor)) throw this.unexpected();
			seen.add(cursor);
		}
		throw new OperationError("PROVIDER_LIMIT", "Confluence returned more than Minerva reads.");
	}

	/** The spaces the account can see whose `ids` or `keys` (the field) are among these values. */
	async spacesBy(cloudId: string, field: "ids" | "keys", values: readonly string[]): Promise<Space[]> {
		const found: Space[] = [];
		for (let start = 0; start < values.length; start += BATCH_LIMIT) {
			const params = { [field]: values.slice(start, start + BATCH_LIMIT).join(","), limit: String(BATCH_LIMIT) };
			for (const item of await this.#all(this.#v2(cloudId, "/spaces"), params)) found.push(this.parse(SpaceModel, item));
		}
		return found;
	}

	async page(cloudId: string, pageId: string, options: { body?: boolean } = {}): Promise<Page> {
		const params = options.body ? { "body-format": "atlas_doc_format" } : undefined;
		return this.parse(PageModel, await this.get(this.#v2(cloudId, `/pages/${segment(pageId)}`), params));
	}

	/** The current pages with these ids that the account can see, read fresh, in the order asked for. */
	async pages(cloudId: string, ids: readonly string[]): Promise<Page[]> {
		const found: Page[] = [];
		for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
			const params = { id: ids.slice(start, start + BATCH_LIMIT).join(","), status: "current", limit: String(BATCH_LIMIT) };
			for (const item of await this.#all(this.#v2(cloudId, "/pages"), params)) found.push(this.parse(PageModel, item));
		}
		const order = new Map<string, number>();
		ids.forEach((id, index) => order.set(id, index));
		// A dict by id: a page listed twice keeps its first place and its last value.
		const unique = new Map<string, Page>();
		for (const page of found) if (order.has(page.id)) unique.set(page.id, page);
		return [...unique.values()].sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
	}

	/** The ids of one page of pages matching `cql`. */
	async search(cloudId: string, cql: string, options: { limit: number; cursor: string | null }): Promise<[string[], string | null]> {
		const params = { cql, limit: String(options.limit), ...pageParams(options.cursor) };
		const listing = await this.#listing(`${this.api(cloudId)}/wiki/rest/api/search`, params);
		const results = this.#items(Result, listing);
		const ids = results.flatMap((result) => (result.content !== null && result.content.type === "page" ? [result.content.id] : []));
		return [ids, nextCursor(listing)];
	}

	/** The latest root footer comments, newest first, and whether there are more. */
	async footerComments(cloudId: string, pageId: string, options: { limit: number }): Promise<[Comment[], boolean]> {
		const params = { "body-format": "atlas_doc_format", sort: "-created-date", limit: String(options.limit) };
		const listing = await this.#listing(this.#v2(cloudId, `/pages/${segment(pageId)}/footer-comments`), params);
		return [this.#items(CommentModel, listing), Boolean(listing.links.next)];
	}

	// Writes: each operation sends exactly one.

	async addComment(cloudId: string, pageId: string, adf: Json): Promise<Comment> {
		return this.http.parsed({ method: "POST", path: this.#v2(cloudId, "/footer-comments"), json: { pageId, body: writtenBody(adf) } }, CommentModel);
	}

	async createPage(cloudId: string, options: { spaceId: string; title: string; parentId: string | null; adf: Json }): Promise<Page> {
		const body: JsonObject = { spaceId: options.spaceId, status: "current", title: options.title, body: writtenBody(options.adf) };
		if (options.parentId !== null) body.parentId = options.parentId;
		return this.http.parsed({ method: "POST", path: this.#v2(cloudId, "/pages"), json: body }, PageModel);
	}
}
