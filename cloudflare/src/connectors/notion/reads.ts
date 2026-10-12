// Notion's read operations, ported from backend/connectors/notion/reads.py: search, pages, databases and
// comments.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { anyRecord, strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, codePointLength, isSingleLine } from "../../lib/text.ts";
import { DataSource, type Database, type NotionClient, Page, databaseName, searchIncomplete, sourceDatabaseId, sourceName } from "./client.ts";
import { redact } from "./markdown.ts";
import {
	JSON_SIZE_ERROR,
	PAGE,
	Tree,
	canonical,
	commentData,
	dataSource,
	databaseResource,
	jsonSizeOk,
	objectIdField,
	optionalObjectIdField,
	pageRecord,
	pageResource,
	parentId,
} from "./pages.ts";
import { checkFilter, mentionsHidden, readable, schema } from "./properties.ts";
import { has } from "./python.ts";

export const MAX_CURSOR = 1000;

const cursorField = () => strippedStr({ max: MAX_CURSOR }).nullable().default(null);

function nextCursor(cursor: string | null, hasMore: boolean): string | null {
	if (!hasMore || !cursor) return null;
	if (codePointLength(cursor) > MAX_CURSOR) throw new OperationError("PROVIDER_LIMIT", "Notion returned a page token that is too long.");
	return cursor;
}

function databaseRecord(resource: Resource, database: Database, extra: JsonObject = {}): ScopedRecord {
	return {
		resource,
		data: {
			id: resource.id,
			type: "database",
			title: databaseName(database),
			url: database.url,
			parent_id: parentId(resource),
			in_trash: database.in_trash,
			// Names only once a source is known to be this database's own (see get_database): a linked
			// database lists another database's source, with its name.
			data_sources: database.data_sources.map((source) => ({ id: source.id })),
			...extra,
		},
	};
}

function sliceCodePoints(text: string, start: number, end: number): string {
	// Code points, as Python slices; most pages have no astral characters to count.
	if (!/[\ud800-\udfff]/.test(text)) return text.slice(start, end);
	return Array.from(text).slice(start, end).join("");
}

const Search = z
	.strictObject({
		text: strippedStr({ max: 200 }).refine(isSingleLine, SINGLE_LINE).nullable().default(null),
		limit: z.int().min(1).max(50).default(20),
		cursor: cursorField(),
	})
	.meta({ title: "Search" });

export const SEARCH = defineOperation<z.output<typeof Search>>({
	name: "search",
	title: "Search pages",
	description:
		"Search the Notion pages and databases you may read, by title. Without text, lists recently edited ones. To get the next page, repeat the call with identical arguments plus the returned next_cursor. incomplete: true means Notion did not search everything.",
	input: Search,
	needs: [[PAGE, "read"]],
	paginated: true,
	async prepare(binding: Binding, data): Promise<Prepared> {
		const tree = new Tree(binding.client as NotionClient);
		return {
			requirements: [{ enumerate: PAGE, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await tree.client.search(data.text, { limit: data.limit, cursor: data.cursor });
				const records: ScopedRecord[] = [];
				const databases = new Set<string>();
				for (const item of found.results) {
					const object = has(item, "object") ? item.object : null;
					if (object === "page") {
						const parsed = Page.safeParse(item);
						if (!parsed.success) continue;
						const page = parsed.data;
						if (canonical(page.id) === null) continue;
						tree.remember(page);
						records.push(pageRecord(await tree.resource(binding, page), page));
					} else if (object === "data_source") {
						const parsed = DataSource.safeParse(item);
						if (!parsed.success) continue;
						const source = parsed.data;
						const databaseId = canonical(sourceDatabaseId(source));
						if (databaseId === null || databases.has(databaseId)) continue;
						databases.add(databaseId);
						const database = await tree.knownDatabase(databaseId);
						if (database !== null) records.push(databaseRecord(await tree.resource(binding, database), database));
					}
				}
				return { records, nextCursor: nextCursor(found.next_cursor, found.has_more), incomplete: searchIncomplete(found) };
			},
		};
	},
});

const PageInput = z.strictObject({ page_id: objectIdField() }).meta({ title: "PageInput" });

export const GET_PAGE = defineOperation<z.output<typeof PageInput>>({
	name: "get_page",
	title: "Get page details",
	description: "Read the title, properties and place of one Notion page by id or link.",
	input: PageInput,
	needs: [[PAGE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await tree.confirmPage(resource);
				return { records: [pageRecord(resource, page, { properties: readable(page.properties) })] };
			},
		};
	},
});

export const READ_TEXT_NOTE =
	"Links to child pages and databases, and mentions of pages, appear without their titles (use get_page or get_database to see one you may read). Content synced from other pages is hidden.";

const ReadPage = z
	.strictObject({
		page_id: objectIdField(),
		offset: z.int().min(0).max(10_000_000).default(0),
		max_chars: z.int().min(1).max(100_000).default(20_000),
	})
	.meta({ title: "ReadPage" });

export const READ_PAGE = defineOperation<z.output<typeof ReadPage>>({
	name: "read_page",
	title: "Read a page",
	description: `Read the content of one Notion page as Notion-flavored markdown, with its properties. Long pages are cut at max_chars and marked truncated; continue with offset. ${READ_TEXT_NOTE}`,
	input: ReadPage,
	needs: [[PAGE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await tree.confirmPage(resource);
				const body = await tree.client.markdown(resource.id);
				const text = redact(body.markdown);
				const end = data.offset + data.max_chars;
				const total = codePointLength(text);
				return {
					records: [
						pageRecord(resource, page, {
							properties: readable(page.properties),
							text: sliceCodePoints(text, data.offset, end),
							offset: data.offset,
							total_chars: total,
							truncated: end < total || body.truncated,
							unreadable_blocks: body.unknown_block_ids.length,
						}),
					],
				};
			},
		};
	},
});

const DatabaseInput = z.strictObject({ database_id: objectIdField() }).meta({ title: "DatabaseInput" });

export const GET_DATABASE = defineOperation<z.output<typeof DatabaseInput>>({
	name: "get_database",
	title: "Get a database",
	description:
		"Read a Notion database: its data sources and their properties, with the options of select and status properties. Properties marked hidden are never shown or used by Minerva.",
	input: DatabaseInput,
	needs: [[PAGE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await databaseResource(binding, data.database_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const database = await tree.confirmDatabase(resource);
				const sources: Json[] = [];
				for (const ref of database.data_sources.slice(0, 10)) {
					let source: z.output<typeof DataSource>;
					try {
						source = await dataSource(tree.client, database, canonical(ref.id));
					} catch (error) {
						if (!(error instanceof OperationError) || error.code !== "UNSUPPORTED_DATABASE") throw error;
						sources.push({ id: ref.id, linked_from_elsewhere: true });
						continue;
					}
					sources.push({ id: ref.id, name: sourceName(source), properties: schema(source.properties) });
				}
				return { records: [databaseRecord(resource, database, { data_sources: sources })] };
			},
		};
	},
});

const QueryDatabase = z
	.strictObject({
		database_id: objectIdField(),
		data_source_id: optionalObjectIdField(),
		filter: anyRecord().refine(jsonSizeOk, JSON_SIZE_ERROR).describe("A Notion data source query filter.").nullable().default(null),
		sorts: z.array(anyRecord()).max(10).refine(jsonSizeOk, JSON_SIZE_ERROR).describe("Notion data source query sorts.").nullable().default(null),
		limit: z.int().min(1).max(100).default(25),
		cursor: cursorField(),
	})
	.meta({ title: "QueryDatabase" });

export const QUERY_DATABASE = defineOperation<z.output<typeof QueryDatabase>>({
	name: "query_database",
	title: "Query a database",
	description:
		"List rows of a Notion database, optionally with a Notion filter and sorts on properties that are not hidden. A database with several data sources needs data_source_id. Rows you may not read are left out. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: QueryDatabase,
	needs: [[PAGE, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await databaseResource(binding, data.database_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const database = await tree.confirmDatabase(resource);
				const source = await dataSource(tree.client, database, data.data_source_id);
				const filter = (data.filter ?? null) as JsonObject | null;
				const sorts = (data.sorts ?? null) as JsonObject[] | null;
				const used = new Set([...checkFilter(source.properties, filter), ...checkFilter(source.properties, sorts)]);
				const found = await tree.client.query(source.id, { limit: data.limit, cursor: data.cursor, filter, sorts });
				const within = [resource.id, ...resource.within];
				const records: ScopedRecord[] = [];
				for (const item of found.results) {
					const parsed = Page.safeParse(item);
					if (!parsed.success) continue;
					const row = parsed.data;
					const rowId = canonical(row.id);
					// Only rows that sit in this data source, still in this database, are placed by this query.
					if (
						rowId === null ||
						row.parent.type !== "data_source_id" ||
						canonical(row.parent.data_source_id) !== canonical(source.id) ||
						canonical(row.parent.database_id) !== resource.id
					) {
						continue;
					}
					// Notion matches and sorts text by the titles of pages it mentions, which are not shown.
					if ([...used].some((name) => mentionsHidden(Object.hasOwn(row.properties, name) ? (row.properties[name] as Json) : null))) continue;
					const rowResource = binding.resource(PAGE, rowId, within, resource.partial);
					records.push(pageRecord(rowResource, row, { properties: readable(row.properties) }));
				}
				return { records, nextCursor: nextCursor(found.next_cursor, found.has_more), incomplete: searchIncomplete(found) };
			},
		};
	},
});

const ListComments = z.strictObject({ page_id: objectIdField(), cursor: cursorField() }).meta({ title: "ListComments" });

export const LIST_COMMENTS = defineOperation<z.output<typeof ListComments>>({
	name: "list_comments",
	title: "List comments",
	description:
		"List the open comments on a Notion page itself (not comments on text inside it). To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListComments,
	needs: [[PAGE, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				await tree.confirmPage(resource);
				const found = await tree.client.comments(resource.id, { cursor: data.cursor });
				const records = found.results
					.filter((comment) => comment.parent.type === "page_id" && canonical(comment.parent.page_id) === resource.id)
					.map((comment): ScopedRecord => ({ resource, data: commentData(comment) }));
				return { records, nextCursor: nextCursor(found.next_cursor, found.has_more) };
			},
		};
	},
});
