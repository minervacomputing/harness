// Confluence Cloud. Resources are sites and their
// spaces; agents read and search pages, comment on them and create them.
//
// One connection reaches the Confluence sites the user picked on Atlassian's consent screen (see
// `atlassian`). Sites and spaces are one hierarchical kind: a site's id is its cloud id, a space's is
// `<cloud id>/<space id>` with its site as ancestor (space ids repeat across sites). What is allowed on a
// site covers every space in it, spaces created later included. Calls take an optional `site_id`; a
// connection that reaches several sites must name one.
//
// Spaces are named by key or id and resolved to the id; pages are named by id, resolved to the space they
// are in now, and only current pages are used (drafts, archived and trashed pages are refused like unseen
// ones). Just before reading or writing, the page is read again by id and refused if it moved
// (`PAGE_MOVED`). Search takes fields, never CQL, which can select pages by their relations to content
// elsewhere. It always names one space, searches titles only (text search also matches bodies, whose links
// can carry other pages' titles), and reads each result again, since the search index can lag behind moves.
// A page's parent is shown only when it is a page in the same space; child pages are not listed.
//
// Text is Atlassian Document Format: reading and writing it is in `atlassian/adf.ts`. Written text is plain,
// without mentions or links to Atlassian, which Confluence can show as previews of pages the agent may not
// read. Comments are root footer comments: replies and inline comments are neither read nor written. Pages
// are not edited: plain text would replace their formatting.
//
// What stays outside Minerva's reach: watchers are notified of changes, and a space's automation rules may
// act on pages after an agent's change.
//
// Reading needs `read:space:confluence`, `read:page:confluence`, `read:comment:confluence` and
// `read:content-details:confluence` (search); the writes ask for `write:comment:confluence` or
// `write:page:confluence` once the user allows one.
//
// This module assembles the connector. The operations are in `reads.ts` and `writes.ts`; what they share
// (sites, names, where pages sit) is in `pages.ts`.

import { type Connector, type DiscoveryItem, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { CLOUD_ID, type Site, TENANCY, oauth, siteTenants } from "../atlassian/index.ts";
import { BATCH_LIMIT, ConfluenceClient, type Space } from "./client.ts";
import { ID, SPACE, spaceId } from "./pages.ts";
import { GET_PAGE, LIST_SPACES, SEARCH_PAGES } from "./reads.ts";
import { ADD_COMMENT, CREATE_PAGE } from "./writes.ts";

export const DISCOVERY_PAGE = 50;
export const MAX_DESCRIBE = BATCH_LIMIT;

const CURSOR = /^(\d{1,2}):([\x21-\x7e]{0,990})$/u;

function spaceName(site: Site, space: Space, sites: readonly Site[]): string {
	let name = `${space.name || space.key} (${space.key})`;
	if (space.status === "archived") name += " · archived";
	return sites.length > 1 ? `${name} · ${site.name || site.host || site.id}` : name;
}

/** A discovery cursor, `<site index>:<Confluence's cursor>`; the browser holds it, so it is checked as tool input is. */
export function discoveryCursor(cursor: string | null, sites: readonly unknown[]): [number, string | null] {
	if (cursor === null) return [0, null];
	const match = CURSOR.exec(cursor);
	if (match === null || Number(match[1]) >= sites.length) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return [Number(match[1]), match[2] || null];
}

export function confluenceConnector(): Connector<ConfluenceClient> {
	return {
		slug: "confluence",
		name: "Confluence",
		kinds: [
			{
				id: SPACE,
				label: "Space",
				actions: ["read", "comment", "create"],
				wildcard: true,
				hierarchical: true,
				note: "Access to a site covers all its spaces, including spaces added later. Agents act as you: watchers are notified, and a space's automation rules may act on what they change.",
			},
		],
		actions: [
			{ id: "read", label: "Read pages" },
			{ id: "comment", label: "Comment on pages", requires: "read" },
			{ id: "create", label: "Create pages", requires: "read" },
		],
		tenancy: TENANCY,
		auth: oauth("confluence", "read:space:confluence", "read:page:confluence", "read:comment:confluence", "read:content-details:confluence"),
		operations: [LIST_SPACES, SEARCH_PAGES, GET_PAGE, ADD_COMMENT, CREATE_PAGE],

		client: (accessToken, io) => new ConfluenceClient(accessToken, io),

		async account(client) {
			const me = await client.me();
			const sites = await client.sites();
			if (sites.length === 0) throw new OperationError("UNSUPPORTED_ACCOUNT", "This Atlassian account gave Minerva no Confluence site.");
			const label = me.name && me.email ? `${me.name} (${me.email})` : me.name || me.email || "Confluence";
			return { id: me.account_id, label, tenants: siteTenants(sites) };
		},

		manageLink: () => ["Atlassian connected apps", "https://id.atlassian.com/manage-profile/apps"],

		/**
		 * Sites first, then one page of one site's spaces per call. Confluence cannot filter spaces by name, so a
		 * query filters each page as it comes.
		 */
		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			const sites = await client.sites();
			const [index, token] = discoveryCursor(cursor, sites);
			const folded = query ? query.toLowerCase() : null;
			const items: DiscoveryItem[] = [];
			if (cursor === null) {
				for (const site of sites) if (folded === null || site.label.toLowerCase().includes(folded)) items.push({ id: site.id, name: site.label, tenant: site.id });
			}
			if (sites.length === 0) return { items, nextCursor: null };
			const site = sites[index] as Site;
			const [spaces, after] = await client.spaces(site.id, { limit: DISCOVERY_PAGE, cursor: token });
			for (const space of spaces) {
				if (ID.test(space.id) && (folded === null || `${space.name || ""} ${space.key}`.toLowerCase().includes(folded))) {
					items.push({ id: spaceId(site, space.id), name: spaceName(site, space, sites), tenant: site.id });
				}
			}
			if (after !== null) return { items, nextCursor: `${index}:${after}` };
			return { items, nextCursor: index + 1 < sites.length ? `${index + 1}:` : null };
		},

		async describe(client, _kind, ids) {
			const sites = await client.sites();
			const byId = new Map(sites.map((site) => [site.id, site]));
			const names: { [id: string]: string } = {};
			for (const id of ids) {
				const site = byId.get(id);
				if (CLOUD_ID.test(id) && site !== undefined) names[id] = site.label;
			}
			const wanted = new Map<string, string[]>();
			for (const resourceId of ids.filter((id) => id.includes("/")).slice(0, MAX_DESCRIBE)) {
				const slash = resourceId.indexOf("/");
				const cloudId = resourceId.slice(0, slash);
				const space = resourceId.slice(slash + 1);
				if (byId.has(cloudId) && ID.test(space)) wanted.set(cloudId, [...(wanted.get(cloudId) ?? []), space]);
			}
			for (const [cloudId, spaces] of wanted) {
				const site = byId.get(cloudId) as Site;
				for (const found of await client.spacesBy(site.id, "ids", spaces)) {
					if (spaces.includes(found.id)) names[spaceId(site, found.id)] = spaceName(site, found, sites);
				}
			}
			return names;
		},
	};
}
