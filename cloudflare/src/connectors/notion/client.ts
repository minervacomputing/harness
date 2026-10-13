// The Notion API client: a thin client over ProviderHTTP whose responses are
// validated before use. Unknown fields are dropped, and a field of another type
// makes the response unexpected. Objects whose keys are Notion's (properties,
// rich text items, search results) are checked and kept as they were parsed, so
// a property named "__proto__" is an ordinary key.

import { z } from "zod";
import { OperationError, type OperationErrorShape } from "../../gateway/connector.ts";
import { ProviderHTTP, type ProviderIo, type ProviderRequest } from "../../gateway/http.ts";
import { type Json, type JsonObject, isDict, parseJsonBytes } from "../../lib/json.ts";

export const API_URL = "https://api.notion.com/v1";
/** Pinned: the markdown endpoints and data sources behave as documented for this version. */
export const NOTION_VERSION = "2026-03-11";
export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

const maybeText = () => z.string().nullable().default(null);

/**
 * The value of one of the object's own keys, or null. Keys that come from Notion or from the agent (property
 * names, option names, a property's type) are read this way, so "constructor" or "__proto__" is an ordinary
 * key.
 */
export function own(value: JsonObject, key: string): Json {
	return Object.hasOwn(value, key) ? (value[key] as Json) : null;
}

/** An object of objects, `{}` when missing, kept as parsed. */
const dictOfDicts = () =>
	z.custom<{ [name: string]: JsonObject }>((value) => isDict(value) && Object.values(value).every(isDict)).default(() => ({}));

/** A list of objects, `[]` when missing, kept as parsed. */
const listOfDicts = () => z.custom<JsonObject[]>((value) => Array.isArray(value) && value.every(isDict)).default(() => []);

export const Parent = z.object({
	type: z.string(),
	page_id: maybeText(),
	database_id: maybeText(),
	data_source_id: maybeText(),
	block_id: maybeText(),
});
export type Parent = z.output<typeof Parent>;

export const Page = z.object({
	object: z.string(),
	id: z.string(),
	parent: Parent,
	url: maybeText(),
	in_trash: z.boolean().default(false),
	is_locked: z.boolean().default(false),
	created_time: maybeText(),
	last_edited_time: maybeText(),
	properties: dictOfDicts(),
});
export type Page = z.output<typeof Page>;

/** A page's title: its title property's text. */
export function pageTitle(page: Page): string {
	for (const value of Object.values(page.properties)) {
		if (own(value, "type") === "title") return textOf(own(value, "title"));
	}
	return "";
}

export const DataSourceRef = z.object({ id: z.string(), name: z.string().default("") });

export const Database = z.object({
	object: z.string(),
	id: z.string(),
	parent: Parent,
	title: listOfDicts(),
	url: maybeText(),
	in_trash: z.boolean().default(false),
	is_inline: z.boolean().default(false),
	data_sources: z.array(DataSourceRef).default(() => []),
});
export type Database = z.output<typeof Database>;

export function databaseName(database: Database): string {
	return textOf(database.title);
}

export const DataSource = z.object({
	object: z.string(),
	id: z.string(),
	parent: Parent,
	title: listOfDicts(),
	properties: dictOfDicts(),
});
export type DataSource = z.output<typeof DataSource>;

export function sourceName(source: DataSource): string {
	return textOf(source.title);
}

/** The database a data source belongs to, when Notion says so. */
export function sourceDatabaseId(source: DataSource): string | null {
	return source.parent.type === "database_id" ? source.parent.database_id : null;
}

export const Block = z.object({ object: z.string(), id: z.string(), parent: Parent });
export type Block = z.output<typeof Block>;

const RequestStatus = z.object({ type: z.string().default("complete") });

export const SearchPage = z.object({
	results: listOfDicts(),
	next_cursor: maybeText(),
	has_more: z.boolean().default(false),
	request_status: RequestStatus.nullable().default(null),
});
export type SearchPage = z.output<typeof SearchPage>;

/** Notion did not search everything it could have. */
export function searchIncomplete(page: SearchPage): boolean {
	return page.request_status !== null && page.request_status.type === "incomplete";
}

export const PageMarkdown = z.object({
	id: z.string(),
	markdown: z.string(),
	truncated: z.boolean().default(false),
	unknown_block_ids: z.array(z.string()).default(() => []),
});
export type PageMarkdown = z.output<typeof PageMarkdown>;

const Author = z.object({ id: z.string() });

export const Comment = z.object({
	id: z.string(),
	discussion_id: maybeText(),
	parent: Parent,
	created_time: maybeText(),
	created_by: Author.nullable().default(null),
	rich_text: listOfDicts(),
});
export type Comment = z.output<typeof Comment>;

export const CommentPage = z.object({
	results: z.array(Comment).default(() => []),
	next_cursor: maybeText(),
	has_more: z.boolean().default(false),
});
export type CommentPage = z.output<typeof CommentPage>;

const Bot = z.object({ workspace_id: maybeText(), workspace_name: maybeText() });

export const BotUser = z.object({
	id: z.string(),
	name: maybeText(),
	type: z.string(),
	bot: Bot.nullable().default(null),
});
export type BotUser = z.output<typeof BotUser>;

/** Mentions of these show the other object's title, which the agent may not be allowed to read. */
export const TITLED_MENTIONS: ReadonlySet<string> = new Set(["page", "database", "data_source", "agent"]);

function titledMention(item: JsonObject): JsonObject | null {
	const mention = own(item, "type") === "mention" ? own(item, "mention") : null;
	if (isDict(mention)) {
		const type = own(mention, "type");
		if (typeof type === "string" && TITLED_MENTIONS.has(type)) return mention;
	}
	return null;
}

export function hasTitledMention(items: Json): boolean {
	return Array.isArray(items) && items.some((item) => isDict(item) && titledMention(item) !== null);
}

/** Plain text of rich text. Mentions of pages and databases show their id instead of their title. */
export function textOf(items: Json | undefined): string {
	if (!Array.isArray(items)) return "";
	const parts: string[] = [];
	for (const item of items) {
		if (!isDict(item)) continue;
		const mention = titledMention(item);
		if (mention !== null) {
			const type = own(mention, "type") as string;
			const target = own(mention, type);
			const targetId = isDict(target) ? own(target, "id") : null;
			parts.push(typeof targetId === "string" ? `(mention of ${type} ${targetId})` : `(mention of ${type})`);
		} else {
			const text = own(item, "plain_text");
			parts.push(typeof text === "string" ? text : "");
		}
	}
	return parts.join("");
}

/** Notion answers 403 when the integration lacks a capability (say, inserting comments). */
export function forbidden(): OperationErrorShape {
	return new OperationError(
		"PROVIDER_FORBIDDEN",
		"Notion does not let Minerva's integration do this. Its capabilities are set by whoever runs this Minerva instance, in Notion's integration settings.",
	);
}

export interface NotionClientOptions {
	baseUrl?: string;
	/** Tree's MAX_LOOKUPS: how many objects one call may look up to place what it touches. */
	maxLookups?: number;
}

export const MAX_LOOKUPS = 150;

/** Thin client for the Notion API. Responses are validated before use. */
export class NotionClient {
	readonly http: ProviderHTTP;
	readonly maxLookups: number;

	constructor(accessToken: string, io: ProviderIo, options: NotionClientOptions = {}) {
		this.http = new ProviderHTTP(io, {
			provider: "Notion",
			baseUrl: options.baseUrl ?? API_URL,
			headers: { Authorization: `Bearer ${accessToken}`, "Notion-Version": NOTION_VERSION },
			forbidden,
		});
		this.maxLookups = options.maxLookups ?? MAX_LOOKUPS;
	}

	async close(): Promise<void> {
		await this.http.close();
	}

	#parsed<T>(request: ProviderRequest, schema: z.ZodType<T>): Promise<T> {
		return this.http.parsed(request, schema);
	}

	me(): Promise<BotUser> {
		return this.#parsed({ method: "GET", path: "/users/me" }, BotUser);
	}

	page(pageId: string): Promise<Page> {
		return this.#parsed({ method: "GET", path: `/pages/${pageId}` }, Page);
	}

	database(databaseId: string): Promise<Database> {
		return this.#parsed({ method: "GET", path: `/databases/${databaseId}` }, Database);
	}

	dataSource(dataSourceId: string): Promise<DataSource> {
		return this.#parsed({ method: "GET", path: `/data_sources/${dataSourceId}` }, DataSource);
	}

	block(blockId: string): Promise<Block> {
		return this.#parsed({ method: "GET", path: `/blocks/${blockId}` }, Block);
	}

	async markdown(pageId: string): Promise<PageMarkdown> {
		const response = await this.http.bounded(
			{ method: "GET", path: `/pages/${pageId}/markdown` },
			MAX_MARKDOWN_BYTES,
			new OperationError("PAGE_TOO_LARGE", "This page is larger than Minerva reads."),
		);
		let body: Json;
		try {
			body = parseJsonBytes(await response.arrayBuffer());
		} catch (error) {
			throw this.http.unexpected(error);
		}
		const parsed = PageMarkdown.safeParse(body);
		if (!parsed.success) throw this.http.unexpected(parsed.error);
		return parsed.data;
	}

	search(query: string | null, options: { limit: number; cursor: string | null; only?: string | null }): Promise<SearchPage> {
		const body: JsonObject = { page_size: options.limit };
		if (query) body.query = query;
		if (options.cursor) body.start_cursor = options.cursor;
		if (options.only) body.filter = { property: "object", value: options.only };
		return this.#parsed({ method: "POST", path: "/search", json: body, mutating: false }, SearchPage);
	}

	query(
		dataSourceId: string,
		options: { limit: number; cursor: string | null; filter: JsonObject | null; sorts: JsonObject[] | null },
	): Promise<SearchPage> {
		const body: JsonObject = { page_size: options.limit, result_type: "page" };
		if (options.cursor) body.start_cursor = options.cursor;
		if (options.filter !== null && Object.keys(options.filter).length > 0) body.filter = options.filter;
		if (options.sorts !== null && options.sorts.length > 0) body.sorts = options.sorts;
		return this.#parsed({ method: "POST", path: `/data_sources/${dataSourceId}/query`, json: body, mutating: false }, SearchPage);
	}

	comments(blockId: string, options: { cursor: string | null }): Promise<CommentPage> {
		const query: { [name: string]: string } = { block_id: blockId, page_size: "100" };
		if (options.cursor) query.start_cursor = options.cursor;
		return this.#parsed({ method: "GET", path: "/comments", query }, CommentPage);
	}

	// Writes: each operation sends exactly one.

	createPage(body: JsonObject): Promise<Page> {
		return this.#parsed({ method: "POST", path: "/pages", json: body }, Page);
	}

	updatePage(pageId: string, body: JsonObject): Promise<Page> {
		return this.#parsed({ method: "PATCH", path: `/pages/${pageId}`, json: body }, Page);
	}

	updateMarkdown(pageId: string, body: JsonObject): Promise<PageMarkdown> {
		return this.#parsed({ method: "PATCH", path: `/pages/${pageId}/markdown`, json: body }, PageMarkdown);
	}

	addComment(body: JsonObject): Promise<Comment> {
		return this.#parsed({ method: "POST", path: "/comments", json: body }, Comment);
	}
}
