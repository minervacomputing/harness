// What Notion's operations share, ported from backend/connectors/notion/pages.py: ids, where pages and
// databases sit, and how they are shown.

import { z } from "zod";
import type { Binding, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import { type JsonObject, visibleJson } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { hostnameOf, urlsplit } from "../../lib/urlsplit.ts";
import { type Block, type Comment, type DataSource, type Database, type NotionClient, type Page, type Parent, pageTitle, sourceDatabaseId, textOf } from "./client.ts";

export const PAGE = "page";
export const MAX_DEPTH = 32;
export const MAX_HOPS = 64;
export const MAX_FILTER = 8000;

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;
/** `([0-9a-f]{32})$` under IGNORECASE; Python's `$` also matches before a final "\n". */
const LINK_ID = /([0-9a-fA-F]{32})(?=\n?$)/u;

/** A Notion id as a lowercase UUID with dashes, or null when it is not one. */
export function canonical(value: unknown): string | null {
	if (typeof value !== "string" || !UUID.test(value)) return null;
	const h = value.replaceAll("-", "").toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function notionHost(host: string): boolean {
	return host === "notion.so" || host === "www.notion.so" || host === "notion.site" || host.endsWith(".notion.site");
}

/**
 * The path of `value` read as an https link to a Notion host, or null: Python's `urlsplit(value)` and its
 * `hostname`, for what `_object_id` asks of them (lib/urlsplit.ts). Every outcome that is not such a link
 * (another scheme, no host, another host, or a ValueError) is null, as each is refused alike.
 */
function notionLinkPath(value: string): string | null {
	const parts = urlsplit(value);
	if (parts === null || parts.scheme !== "https") return null;
	// `hostname` lowercases all but an IPv6 zone, and `_object_id` lowercases the rest.
	const host = hostnameOf(parts.netloc);
	return host !== null && notionHost(host.toLowerCase()) ? parts.path : null;
}

export const OBJECT_ID_ERROR = "must be a Notion id, or a link to a Notion page or database";

/** `_object_id`: a Notion id, or the id at the end of a link to a Notion page or database; null otherwise. */
export function objectId(value: string): string | null {
	const found = canonical(value);
	if (found !== null) return found;
	const path = notionLinkPath(value);
	if (path === null) return null;
	const trimmed = path.replace(/\/+$/u, "");
	const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	const match = LINK_ID.exec(segment);
	return match === null ? null : canonical(match[1]);
}

/**
 * `len(json.dumps(value))`, with Python's default separators and ASCII escapes (so UTF-16 units and code
 * points count alike), including the infinity that a number too large for a double ("1e400") parses as,
 * which `json.dumps` writes as `Infinity`.
 */
export function dumpsLength(value: unknown): number {
	if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? 3 : value > 0 ? 8 : 9;
	if (Array.isArray(value)) return value.reduce((length: number, item) => length + dumpsLength(item), 2) + 2 * Math.max(0, value.length - 1);
	if (typeof value === "object" && value !== null) {
		const object = value as { [key: string]: unknown };
		const keys = Object.keys(object);
		const items = keys.reduce((length, key) => length + visibleJson(key).length + 2 + dumpsLength(object[key]), 2);
		return items + 2 * Math.max(0, keys.length - 1);
	}
	return visibleJson(value).length;
}

/** `json_size`: at most MAX_FILTER characters as `json.dumps` writes it. */
export function jsonSizeOk(value: unknown): boolean {
	return dumpsLength(value) <= MAX_FILTER;
}

export const JSON_SIZE_ERROR = `must be at most ${MAX_FILTER} characters as JSON`;

const idString = () => strippedStr({ min: 32, max: 300 }).describe("A Notion id, or a link to the page or database.");

/** `_object_id` as the AfterValidator of a validated string. */
function toObjectId<T>(value: string, ctx: z.core.$RefinementCtx<T>): string {
	const id = objectId(value);
	if (id !== null) return id;
	ctx.issues.push({ code: "custom", message: OBJECT_ID_ERROR, input: value });
	return z.NEVER;
}

/** `ObjectId`: a Notion id, or a link to the page or database, normalized to the id. */
export function objectIdField() {
	return idString().transform(toObjectId);
}

/**
 * `ObjectId | None = None`. The default sits inside the transform, since zod's JSON Schema leaves out the
 * default of a field that transforms: so the model sees `"default": null`, as Pydantic shows it.
 */
export function optionalObjectIdField() {
	return idString()
		.nullable()
		.default(null)
		.transform((value, ctx): string | null => (value === null ? null : toObjectId(value, ctx)));
}

export function moved(): OperationError {
	return new OperationError("PAGE_MOVED", "This page or database moved while Minerva was using it. Try again.");
}

/** Codes under which Notion does not show an object. */
const UNSEEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"]);

function code(error: unknown): string | null {
	return error instanceof OperationError ? error.code : null;
}

type Placed = Page | Database;

/** Where pages and databases sit, resolved for one call. Lookups are cached and limited. */
export class Tree {
	readonly client: NotionClient;
	readonly #pages = new Map<string, Page | null>();
	readonly #databases = new Map<string, Database | null>();
	readonly #sources = new Map<string, DataSource | null>();
	readonly #blocks = new Map<string, Block | null>();
	#lookups = 0;

	constructor(client: NotionClient) {
		this.client = client;
	}

	/** Null when Notion does not show the object, or the call looked up too many. */
	async #lookup<T extends { id: string }>(cache: Map<string, T | null>, fetch: (id: string) => Promise<T>, objectId: string): Promise<T | null> {
		if (cache.has(objectId)) return cache.get(objectId) as T | null;
		if (this.#lookups >= this.client.maxLookups) return null;
		this.#lookups += 1;
		let found: T | null;
		try {
			found = await fetch(objectId);
		} catch (error) {
			if (!UNSEEN.has(code(error) ?? "")) throw error;
			found = null;
		}
		if (found !== null && canonical(found.id) !== objectId) found = null;
		cache.set(objectId, found);
		return found;
	}

	async #blockParent(blockId: string): Promise<Parent | null> {
		const block = await this.#lookup(this.#blocks, (id) => this.client.block(id), blockId);
		return block !== null ? block.parent : null;
	}

	remember(page: Page): void {
		const pageId = canonical(page.id);
		if (pageId !== null && !this.#pages.has(pageId)) this.#pages.set(pageId, page);
	}

	/** A page the call names. Pages Notion does not show are refused like pages without a grant. */
	async page(pageId: string): Promise<Page> {
		let page: Page;
		try {
			page = await this.client.page(pageId);
		} catch (error) {
			if (code(error) === "NOT_FOUND") throw denied();
			if (code(error) === "PROVIDER_REJECTED") throw new OperationError("NOT_FOUND", "There is no page with this id. Databases have their own tools.");
			throw error;
		}
		if (canonical(page.id) !== pageId) throw denied();
		this.#pages.set(pageId, page);
		return page;
	}

	async database(databaseId: string): Promise<Database> {
		let database: Database;
		try {
			database = await this.client.database(databaseId);
		} catch (error) {
			if (code(error) === "NOT_FOUND") throw denied();
			if (code(error) === "PROVIDER_REJECTED") throw new OperationError("NOT_FOUND", "There is no database with this id. Pages have their own tools.");
			throw error;
		}
		if (canonical(database.id) !== databaseId) throw denied();
		this.#databases.set(databaseId, database);
		return database;
	}

	knownDatabase(databaseId: string): Promise<Database | null> {
		return this.#lookup(this.#databases, (id) => this.client.database(id), databaseId);
	}

	/** The object's ancestors (pages and databases), nearest first, and whether the chain is partial. */
	async place(obj: Placed): Promise<[within: string[], partial: boolean]> {
		const within: string[] = [];
		const seen = new Set<string | null>([canonical(obj.id)]);
		let current = obj.parent;
		for (let hop = 0; hop < MAX_HOPS; hop++) {
			let nextId: string | null;
			let found: Placed | null;
			switch (current.type) {
				case "workspace":
					return [within, false];
				case "block_id": {
					const blockId = canonical(current.block_id);
					if (blockId === null || seen.has(blockId)) return [within, true];
					seen.add(blockId);
					const parent = await this.#blockParent(blockId);
					if (parent === null) return [within, true];
					current = parent;
					continue;
				}
				case "page_id":
					nextId = canonical(current.page_id);
					if (nextId === null || seen.has(nextId) || within.length >= MAX_DEPTH) return [within, true];
					seen.add(nextId);
					within.push(nextId);
					found = await this.#lookup(this.#pages, (id) => this.client.page(id), nextId);
					break;
				case "database_id":
				case "data_source_id":
					nextId = canonical(current.database_id);
					if (nextId === null && current.type === "data_source_id") nextId = await this.#sourceDatabase(current.data_source_id);
					if (nextId === null || seen.has(nextId) || within.length >= MAX_DEPTH) return [within, true];
					seen.add(nextId);
					within.push(nextId);
					found = await this.#lookup(this.#databases, (id) => this.client.database(id), nextId);
					break;
				default:
					return [within, true];
			}
			if (found === null) return [within, true];
			current = found.parent;
		}
		return [within, true];
	}

	async #sourceDatabase(dataSourceId: string | null): Promise<string | null> {
		const sourceId = canonical(dataSourceId);
		if (sourceId === null) return null;
		const source = await this.#lookup(this.#sources, (id) => this.client.dataSource(id), sourceId);
		return source !== null ? canonical(sourceDatabaseId(source)) : null;
	}

	async resource(binding: Binding, obj: Placed): Promise<Resource> {
		const [within, partial] = await this.place(obj);
		return binding.resource(PAGE, canonical(obj.id) ?? obj.id, within, partial);
	}

	async #confirm<T extends Placed>(resource: Resource, fetch: (id: string) => Promise<T>): Promise<T> {
		const fresh = new Tree(this.client);
		let obj: T;
		try {
			obj = await fetch(resource.id);
		} catch (error) {
			if (code(error) === "NOT_FOUND" || code(error) === "PROVIDER_REJECTED") throw moved();
			throw error;
		}
		const [within, partial] = await fresh.place(obj);
		const same = canonical(obj.id) === resource.id && partial === resource.partial && sameIds(within, resource.within);
		if (!same) throw moved();
		return obj;
	}

	/** The page again, from Notion, refused if it moved since `resource` was authorized. */
	confirmPage(resource: Resource): Promise<Page> {
		return this.#confirm(resource, (id) => this.client.page(id));
	}

	confirmDatabase(resource: Resource): Promise<Database> {
		return this.#confirm(resource, (id) => this.client.database(id));
	}
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function parentId(resource: Resource): string | null {
	return resource.within[0] ?? null;
}

function pageData(resource: Resource, page: Page): JsonObject {
	return {
		id: resource.id,
		type: "page",
		title: pageTitle(page),
		url: page.url,
		parent_id: parentId(resource),
		in_trash: page.in_trash,
		created_time: page.created_time,
		last_edited_time: page.last_edited_time,
	};
}

export function pageRecord(resource: Resource, page: Page, extra: JsonObject = {}): ScopedRecord {
	return { resource, data: { ...pageData(resource, page), ...extra } };
}

/** The database's data source the call uses, which must belong to this database itself. */
export async function dataSource(client: NotionClient, database: Database, requested: string | null): Promise<DataSource> {
	// A dict keyed by canonical id: in Notion's order, each id once.
	const sources = new Set(database.data_sources.map((source) => canonical(source.id)));
	let chosen: string | null;
	if (requested !== null) {
		if (!sources.has(requested)) throw new OperationError("INVALID_ARGUMENTS", "This database has no data source with that id.");
		chosen = requested;
	} else if (sources.size === 1) {
		chosen = [...sources][0] as string | null;
	} else {
		const ids = [...sources].map((id) => id ?? "None").join(", ");
		throw new OperationError("INVALID_ARGUMENTS", `This database has several data sources; pass data_source_id: ${ids}.`);
	}
	if (chosen === null) throw new OperationError("PROVIDER_FAILED", "Notion returned an unexpected response.");
	const source = await client.dataSource(chosen);
	// A linked database shows a data source that belongs to another database, which grants on this one
	// do not cover.
	if (canonical(source.id) !== chosen || canonical(sourceDatabaseId(source)) !== canonical(database.id)) {
		throw new OperationError("UNSUPPORTED_DATABASE", "This database shows data from another database. Use the original database instead.");
	}
	return source;
}

export async function pageResource(binding: Binding, pageId: string): Promise<[Tree, Resource]> {
	const tree = new Tree(binding.client as NotionClient);
	const page = await tree.page(pageId);
	return [tree, await tree.resource(binding, page)];
}

export async function databaseResource(binding: Binding, databaseId: string): Promise<[Tree, Resource]> {
	const tree = new Tree(binding.client as NotionClient);
	const database = await tree.database(databaseId);
	return [tree, await tree.resource(binding, database)];
}

export function commentData(comment: Comment): JsonObject {
	return {
		id: comment.id,
		discussion_id: comment.discussion_id,
		text: textOf(comment.rich_text),
		created_time: comment.created_time,
		author_id: comment.created_by ? comment.created_by.id : null,
	};
}

