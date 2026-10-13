// Notion. Resources are pages and databases; what is allowed on one covers everything inside it.
//
// Minerva connects as a public integration (`owner=user`). Notion itself decides which pages the integration
// can reach: the user picks them when connecting. Notion has no scopes, so the connector declares no
// consent. Notion's token endpoint takes HTTP Basic client authentication with a JSON body and no PKCE
// (`clientAuth: "basic"`, `jsonBody: true`, `pkce: false`). The workspace id is the account id.
//
// Pages and databases are one hierarchical kind, keyed by Notion's id; tools also accept links, which are
// reduced to the id before authorization. Each call resolves where the pages it touches sit (their chain of
// parent pages and databases, through any blocks in between such as columns, and from a database row
// through its data source to its database, up to the workspace) and hands that to the policy. Ancestry that
// cannot be resolved completely (a parent Notion does not show, a limit reached) is marked partial, and the
// policy then treats it conservatively. Ancestry is resolved again just before content is read or written:
// a call whose page moved in between is refused (`PAGE_MOVED`). Rows of a linked database belong to the
// database they come from, which grants on this one do not cover, so they are refused.
//
// Page text hides what belongs to other pages (see `markdown`), and database rows show only their own values
// (see `properties`). Database filters and sorts may use only the properties agents are shown, since
// filtering on a hidden value reveals it, and a row is dropped when a text property they use mentions another
// page, since Notion matches the mention's title. What stays outside Minerva's reach: Notion automations,
// which may act on a row or page an agent changed, and the integration's own capabilities, which the
// operator sets in Notion.
//
// This module assembles the connector. The operations are in `reads` and `writes`; what they share (ids,
// where pages and databases sit, how they are shown) is in `pages`.

import { type Connector, type DiscoveryItem, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { DataSource, NotionClient, type NotionClientOptions, Page, databaseName, own, pageTitle, sourceDatabaseId, sourceName } from "./client.ts";
import { PAGE, canonical } from "./pages.ts";
import { GET_DATABASE, GET_PAGE, LIST_COMMENTS, QUERY_DATABASE, READ_PAGE, SEARCH } from "./reads.ts";
import { ADD_COMMENT, APPEND_TO_PAGE, CREATE_DATABASE_ROW, CREATE_PAGE, EDIT_PAGE, UPDATE_PAGE_PROPERTIES } from "./writes.ts";

export const DESCRIBE_CONCURRENCY = 8;
const CURSOR = /^[A-Za-z0-9_=-]{1,300}$/u;

function discoveryCursor(cursor: string | null): string | null {
	if (cursor !== null && !CURSOR.test(cursor)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return cursor;
}

/** Codes under which Notion does not show an object, so `describe` leaves it out. */
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"]);

function hidden(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

/** `fn` over `items` with at most `limit` running at once, results in order. */
async function limited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function notionConnector(options: NotionClientOptions = {}): Connector<NotionClient> {
	return {
		slug: "notion",
		name: "Notion",
		kinds: [
			{
				id: PAGE,
				label: "Page or database",
				actions: ["read", "comment", "create", "edit"],
				wildcard: true,
				hierarchical: true,
				note: "What is allowed on a page or database also covers the pages inside it. Notion decides which pages Minerva can reach at all: they are chosen when connecting Notion, and connecting again changes them. Where Notion does not show where a page sits, blocking an action anywhere in this connection also blocks it there.",
			},
		],
		actions: [
			{ id: "read", label: "Read pages" },
			{ id: "comment", label: "Comment on pages", requires: "read" },
			{ id: "create", label: "Create pages", requires: "read" },
			{ id: "edit", label: "Edit pages", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: "notion",
			authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
			tokenUrl: "https://api.notion.com/v1/oauth/token",
			scopes: [],
			authorizeParams: [["owner", "user"]],
			clientAuth: "basic",
			jsonBody: true,
			pkce: false,
		},
		operations: [SEARCH, GET_PAGE, READ_PAGE, GET_DATABASE, QUERY_DATABASE, LIST_COMMENTS, CREATE_PAGE, CREATE_DATABASE_ROW, UPDATE_PAGE_PROPERTIES, EDIT_PAGE, APPEND_TO_PAGE, ADD_COMMENT],

		client(secret, io) {
			return new NotionClient(secret, io, options);
		},

		async account(client) {
			// The workspace is what the connection reaches; the bot id may change when the user reconnects.
			const me = await client.me();
			const workspaceId = me.bot ? canonical(me.bot.workspace_id) : null;
			if (workspaceId === null) throw new OperationError("PROVIDER_FAILED", "Notion did not say which workspace was connected.");
			return { id: workspaceId, label: (me.bot ? me.bot.workspace_name : null) || "Notion" };
		},

		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			const found = await client.search(query || null, { limit: 100, cursor: discoveryCursor(cursor) });
			const items: DiscoveryItem[] = [];
			const seen = new Set<string>();
			for (const item of found.results) {
				const object = own(item, "object");
				let objectId: string | null;
				let name: string;
				if (object === "page") {
					const parsed = Page.safeParse(item);
					if (!parsed.success) continue;
					objectId = canonical(parsed.data.id);
					name = pageTitle(parsed.data) || "Untitled";
				} else if (object === "data_source") {
					const parsed = DataSource.safeParse(item);
					if (!parsed.success) continue;
					objectId = canonical(sourceDatabaseId(parsed.data));
					name = `${sourceName(parsed.data) || "Untitled"} (database)`;
				} else continue;
				if (objectId !== null && !seen.has(objectId)) {
					seen.add(objectId);
					items.push({ id: objectId, name });
				}
			}
			const next = found.has_more ? found.next_cursor : null;
			return { items, nextCursor: discoveryCursor(next) };
		},

		async describe(client, _kind, ids) {
			const name = async (objectId: string): Promise<string | null> => {
				if (canonical(objectId) !== objectId) return null;
				try {
					return pageTitle(await client.page(objectId)) || "Untitled";
				} catch (error) {
					if (!hidden(error)) throw error;
				}
				try {
					return `${databaseName(await client.database(objectId)) || "Untitled"} (database)`;
				} catch (error) {
					if (!hidden(error)) throw error;
				}
				return null;
			};
			const names = await limited(ids, DESCRIBE_CONCURRENCY, name);
			const out: { [id: string]: string } = {};
			ids.forEach((objectId, index) => {
				const found = names[index];
				if (found !== null && found !== undefined) Object.defineProperty(out, objectId, { value: found, enumerable: true, writable: true, configurable: true });
			});
			return out;
		},
	};
}
