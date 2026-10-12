// Confluence's read operations, ported from backend/connectors/confluence/reads.py: spaces, page search and
// single pages.

import { z } from "zod";
import type { Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, WORD_CLASS, isSingleLine, truncate } from "../../lib/text.ts";
import * as adf from "../atlassian/adf.ts";
import type { Site } from "../atlassian/index.ts";
import { type Comment, type ConfluenceClient, type Page, type Space, document } from "./client.ts";
import { ID, SPACE, SPACE_KEY, confirmPage, hosts, link, pageName, resolvePage, resolveSpace, siteId, spaceId, spaceName, spaceResource } from "./pages.ts";

export const MAX_SPACE_PAGES = 20;
export const SPACE_PAGE = 50;
export const MAX_SEARCH_WORDS = 8;
export const MAX_BODY = 20_000;
export const MAX_COMMENT = 4_000;
export const MAX_COMMENTS = 30;
export const MAX_SHORT = 500;

const cursor = () => strippedStr({ max: 1000 }).nullable().default(null);
const WORD = new RegExp(`[${WORD_CLASS}]+`, "gu");

export function short(value: string | null, siteHosts: readonly string[]): string | null {
	const [shown] = truncate(value ? adf.redact(value, siteHosts) : null, MAX_SHORT);
	return shown || null;
}

function spaceData(site: Site, space: Space, siteHosts: readonly string[]): JsonObject {
	return {
		id: space.id,
		site_id: site.id,
		site: site.label,
		key: space.key,
		name: short(space.name, siteHosts),
		type: space.type,
		status: space.status,
	};
}

const ListSpaces = z.strictObject({
	site_id: siteId().nullable().default(null).describe("A site's id; without one, every site."),
});

export const LIST_SPACES = defineOperation<z.output<typeof ListSpaces>>({
	name: "list_spaces",
	title: "List spaces",
	description: "List the Confluence spaces you may read, with the site each is on.",
	input: ListSpaces,
	needs: [[SPACE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: SPACE, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as ConfluenceClient;
				const sites = data.site_id ? [await client.site(data.site_id)] : await client.sites();
				const siteHosts = hosts(await client.sites());
				const records: ScopedRecord[] = [];
				let incomplete = false;
				for (const site of sites) {
					let token: string | null = null;
					const seen = new Set<string>();
					for (let page = 0; page < MAX_SPACE_PAGES; page++) {
						let spaces: Space[];
						[spaces, token] = await client.spaces(site.id, { limit: SPACE_PAGE, cursor: token });
						for (const space of spaces) records.push({ resource: spaceResource(binding, site, space.id), data: spaceData(site, space, siteHosts) });
						if (token === null) break;
						if (seen.has(token)) throw client.unexpected();
						seen.add(token);
					}
					incomplete = incomplete || token !== null;
				}
				return { records, incomplete };
			},
		};
	},
});

export function searchWords(text: string): string {
	const words = (text.match(WORD) ?? []).slice(0, MAX_SEARCH_WORDS);
	if (words.length === 0) throw new OperationError("INVALID_ARGUMENTS", "text must contain letters or digits.");
	return words.join(" ");
}

const SearchPages = z.strictObject({
	site_id: siteId().nullable().default(null),
	space: spaceName(),
	text: strippedStr({ min: 1, max: 200 })
		.describe("Words to find in page titles (page bodies are not searched).")
		.refine(isSingleLine, SINGLE_LINE)
		.nullable()
		.default(null),
	limit: z.int().min(1).max(50).default(25),
	cursor: cursor(),
});

function updated(page: Page): string | null {
	return page.version ? page.version.created_at : null;
}

export const SEARCH_PAGES = defineOperation<z.output<typeof SearchPages>>({
	name: "search_pages",
	title: "Search pages",
	description:
		"Find a space's pages, most recently changed first, by words in the title. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: SearchPages,
	needs: [[SPACE, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, space] = await resolveSpace(binding, data.site_id, data.space);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as ConfluenceClient;
				if (!SPACE_KEY.test(space.key)) throw client.unexpected();
				// The query is built from fields, never taken from the agent: CQL can select pages by their
				// relations to content elsewhere. Titles only: text search also matches bodies, whose links can
				// carry titles of pages the agent may not read.
				const clauses = ["type = page", `space = "${space.key}"`];
				if (data.text !== null) clauses.push(`title ~ "${searchWords(data.text)}"`);
				const cql = `${clauses.join(" AND ")} ORDER BY lastmodified DESC`;
				let ids: string[];
				let next: string | null;
				try {
					[ids, next] = await client.search(site.id, cql, { limit: data.limit, cursor: data.cursor });
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED") throw new OperationError("INVALID_ARGUMENTS", "Confluence could not run this search.");
					throw error;
				}
				// Search reads an index that can lag behind moves: each page is read again, and shown under the
				// space it is in now. What the index returned beside the id (titles, excerpts, breadcrumbs) is not
				// used.
				ids = [...new Set(ids.filter((id) => ID.test(id)))];
				const pages = ids.length ? await client.pages(site.id, ids) : [];
				const siteHosts = hosts(await client.sites());
				const records: ScopedRecord[] = [];
				for (const page of pages) {
					if (page.status !== "current" || page.space_id === null || !ID.test(page.space_id)) continue;
					const record: JsonObject = {
						id: page.id,
						site_id: site.id,
						space_id: page.space_id,
						title: short(page.title, siteHosts),
						updated: updated(page),
						link: link(site, page.id),
					};
					records.push({ resource: spaceResource(binding, site, page.space_id), data: record });
				}
				return { records, nextCursor: next };
			},
		};
	},
});

export const READ_NOTE =
	"Links to Atlassian appear without their titles, and macros without their content. Only the latest top-level footer comments are shown: not replies or inline comments.";

/** A comment; its text is null when Confluence sent none that could be read. */
function comment(found: Comment, siteHosts: readonly string[]): JsonObject {
	const doc = document(found.body);
	const [body, truncated] = doc !== null ? truncate(adf.read(doc, siteHosts), MAX_COMMENT) : [null, false];
	return {
		id: found.id,
		// The latest version's time: Confluence gives a comment's creation time only with its version history.
		updated: found.version ? found.version.created_at : null,
		text: body,
		text_truncated: truncated,
	};
}

/** The parent page, read fresh, when it is a current page in the same space; otherwise nothing. */
async function parent(client: ConfluenceClient, site: Site, resource: Resource, page: Page, siteHosts: readonly string[]): Promise<Json> {
	if (page.parent_id === null || page.parent_type !== "page" || !ID.test(page.parent_id)) return null;
	const found = await client.pages(site.id, [page.parent_id]);
	const above = found[0] ?? null;
	if (above === null || above.space_id === null || spaceId(site, above.space_id) !== resource.id) return null;
	return { id: above.id, title: short(above.title, siteHosts) };
}

const GetPage = z.strictObject({ site_id: siteId().nullable().default(null), page: pageName() });

export const GET_PAGE = defineOperation<z.output<typeof GetPage>>({
	name: "get_page",
	title: "Read a page",
	description: `Read one Confluence page with its body and latest comments. ${READ_NOTE}`,
	input: GetPage,
	needs: [[SPACE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, found] = await resolvePage(binding, data.site_id, data.page);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as ConfluenceClient;
				const siteHosts = hosts(await client.sites());
				const [comments, more] = await client.footerComments(site.id, found.id, { limit: MAX_COMMENTS });
				// Last, so the page is seen in the space after its comments were read.
				const page = await confirmPage(binding, site, resource, found.id, { body: true });
				const above = await parent(client, site, resource, page, siteHosts);
				const foundBody = document(page.body);
				if (foundBody === null) throw client.unexpected();
				const [body, bodyTruncated] = truncate(adf.read(foundBody, siteHosts), MAX_BODY);
				const record: JsonObject = {
					id: page.id,
					site_id: site.id,
					space_id: page.space_id,
					title: short(page.title, siteHosts),
					parent: above,
					created: page.created_at,
					updated: updated(page),
					version: page.version ? page.version.number : null,
					body,
					body_truncated: bodyTruncated,
					comments: [...comments].reverse().map((item) => comment(item, siteHosts)),
					more_comments: more,
					link: link(site, page.id),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
