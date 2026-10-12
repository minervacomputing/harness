// Jira Cloud, ported from backend/connectors/jira/connector.py. Resources are sites and their projects;
// agents read, search, comment on, create and move issues.
//
// One connection reaches the Jira sites the user picked on Atlassian's consent screen (see `atlassian`).
// Sites and projects are one hierarchical kind: a site's id is its cloud id, a project's is
// `<cloud id>/<project id>` with its site as ancestor (project ids repeat across sites). What is allowed on
// a site covers every project in it, projects created later included. Calls take an optional `site_id`; a
// connection that reaches several sites must name one.
//
// Issues are named by key or id. Jira also answers to an issue's former keys, so `prepare` resolves the
// issue to its id and the project it is in now, and authorizes there; just before reading or writing, the
// issue is read again by id and refused if it moved (`ISSUE_MOVED`). Search takes fields, never JQL, which
// has functions that select issues by their relations to other issues. It always names one project,
// searches summaries only (text search also matches descriptions and comments, whose links can carry other
// issues' titles), and reads each result again, since the search index can lag behind moves. Related issues
// (parent, sub-tasks, links) are read to find their project: those in the same project are shown, the others
// only counted.
//
// Text is Atlassian Document Format: reading and writing it is in `atlassian/adf.ts`. Written text is plain,
// without mentions or links to Atlassian, which Jira can show as previews of issues the agent may not read.
//
// What stays outside Minerva's reach: watchers and assignees are notified of changes, and a project's
// automation rules may act on issues, in that project or others, after an agent's change.
//
// Reading needs `read:jira-work`; the writes ask for `write:jira-work` once the user allows one.
//
// This module assembles the connector. The operations are in `reads.ts` and `writes.ts`; what they share
// (sites, names, where issues sit) is in `issues.ts`.

import type { Connector, DiscoveryItem, DiscoveryPage } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { casefold } from "../../lib/casefold.ts";
import { DIGIT_CLASS, decimalValue } from "../../lib/digits.ts";
import { CLOUD_ID, type Site, oauth } from "../atlassian/index.ts";
import { JiraClient, type Project } from "./client.ts";
import { ID, PROJECT, projectId, unseen } from "./issues.ts";
import { GET_ISSUE, LIST_PROJECTS, SEARCH_ISSUES } from "./reads.ts";
import { ADD_COMMENT, CREATE_ISSUE, TRANSITION_ISSUE } from "./writes.ts";

export const DISCOVERY_PAGE = 50;
export const MAX_DESCRIBE = 100;
export const CONCURRENCY = 8;

const CURSOR = new RegExp(`^(${DIGIT_CLASS}{1,2}):(${DIGIT_CLASS}{1,6})$`, "u");

function projectName(site: Site, project: Project, sites: readonly Site[]): string {
	const name = `${project.name || project.key} (${project.key})`;
	return sites.length > 1 ? `${name} · ${site.name || site.host || site.id}` : name;
}

/** A discovery cursor, `<site index>:<offset>`; the browser holds it, so it is checked as tool input is. */
export function discoveryCursor(cursor: string | null, sites: readonly unknown[]): [number, number] {
	if (cursor === null) return [0, 0];
	const match = CURSOR.exec(cursor);
	if (match === null || decimalValue(match[1] as string) >= sites.length) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return [decimalValue(match[1] as string), decimalValue(match[2] as string)];
}

/** Runs `work` on each item, at most `limit` at once, keeping their order. */
async function limited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function jiraConnector(): Connector<JiraClient> {
	return {
		slug: "jira",
		name: "Jira",
		kinds: [
			{
				id: PROJECT,
				label: "Project",
				actions: ["read", "comment", "create", "transition"],
				wildcard: true,
				hierarchical: true,
				note: "Access to a site covers all its projects, including projects added later. Agents act as you: watchers are notified, and a project's automation rules may act on what they change.",
			},
		],
		actions: [
			{ id: "read", label: "Read issues" },
			{ id: "comment", label: "Comment on issues", requires: "read" },
			{ id: "create", label: "Create issues", requires: "read" },
			{ id: "transition", label: "Change status", requires: "read" },
		],
		auth: oauth("jira", "read:jira-work"),
		operations: [LIST_PROJECTS, SEARCH_ISSUES, GET_ISSUE, ADD_COMMENT, CREATE_ISSUE, TRANSITION_ISSUE],

		client: (accessToken, io) => new JiraClient(accessToken, io),

		async account(client) {
			const me = await client.me();
			if ((await client.sites()).length === 0) throw new OperationError("UNSUPPORTED_ACCOUNT", "This Atlassian account gave Minerva no Jira site.");
			const label = me.name && me.email ? `${me.name} (${me.email})` : me.name || me.email || "Jira";
			return { id: me.account_id, label };
		},

		manageLink: () => ["Atlassian connected apps", "https://id.atlassian.com/manage-profile/apps"],

		/** Sites first, then one page of one site's projects per call. */
		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			const sites = await client.sites();
			const [index, start] = discoveryCursor(cursor, sites);
			const folded = query ? casefold(query) : null;
			const items: DiscoveryItem[] = [];
			if (cursor === null) {
				for (const site of sites) if (folded === null || casefold(site.label).includes(folded)) items.push({ id: site.id, name: site.label });
			}
			if (sites.length === 0) return { items, nextCursor: null };
			const site = sites[index] as Site;
			const [projects, after] = await client.projects(site.id, { start, limit: DISCOVERY_PAGE, query });
			for (const project of projects) items.push({ id: projectId(site, project.id), name: projectName(site, project, sites) });
			if (after !== null) return { items, nextCursor: `${index}:${after}` };
			return { items, nextCursor: index + 1 < sites.length ? `${index + 1}:0` : null };
		},

		async describe(client, _kind, ids) {
			const sites = await client.sites();
			const byId = new Map(sites.map((site) => [site.id, site]));
			const names: { [id: string]: string } = {};
			for (const id of ids) {
				const site = byId.get(id);
				if (CLOUD_ID.test(id) && site !== undefined) names[id] = site.label;
			}
			const name = async (resourceId: string): Promise<string | null> => {
				const slash = resourceId.indexOf("/");
				const cloudId = slash >= 0 ? resourceId.slice(0, slash) : resourceId;
				const project = slash >= 0 ? resourceId.slice(slash + 1) : "";
				const site = byId.get(cloudId);
				if (site === undefined || !ID.test(project)) return null;
				let found: Project;
				try {
					found = await client.project(site.id, project);
				} catch (error) {
					if (unseen(error)) return null;
					throw error;
				}
				return found.id === project ? projectName(site, found, sites) : null;
			};
			const wanted = ids.filter((id) => id.includes("/")).slice(0, MAX_DESCRIBE);
			const found = await limited(wanted, CONCURRENCY, name);
			wanted.forEach((id, index) => {
				const value = found[index];
				if (value !== null && value !== undefined) names[id] = value;
			});
			return names;
		},
	};
}
