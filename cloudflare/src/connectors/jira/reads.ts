// Jira's read operations, ported from backend/connectors/jira/reads.py: projects, issue search and single
// issues.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, WORD_CLASS, isSingleLine, truncate } from "../../lib/text.ts";
import * as adf from "../atlassian/adf.ts";
import type { Site } from "../atlassian/index.ts";
import type { Comment, Issue, JiraClient, Project } from "./client.ts";
import { ID, PROJECT, confirmIssue, hosts, issueName, link, projectId, projectName, projectResource, resolveIssue, resolveProject, siteId } from "./issues.ts";

export const MAX_PROJECT_PAGES = 20;
export const MAX_SEARCH_WORDS = 8;
export const MAX_DESCRIPTION = 20_000;
export const MAX_COMMENT = 4_000;
export const MAX_COMMENTS = 30;
export const MAX_RELATED = 50;
export const MAX_SHORT = 500;

/** Jira's status categories by id: "To Do" 2, "In Progress" 4, "Done" 3. */
export const STATUS_CATEGORIES = { to_do: 2, in_progress: 4, done: 3 } as const;
export const SEARCH_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated", "project"];
export const ISSUE_FIELDS =
	"summary,status,issuetype,priority,assignee,reporter,labels,created,updated,duedate,resolution,description,parent,subtasks,issuelinks,attachment,project";
export const RELATED_FIELDS = ["summary", "status", "project"];

const cursor = () => strippedStr({ max: 1000 }).nullable().default(null);
const WORD = new RegExp(`[${WORD_CLASS}]+`, "gu");

function short(value: string | null, siteHosts: readonly string[]): string | null {
	const [shown] = truncate(value ? adf.redact(value, siteHosts) : null, MAX_SHORT);
	return shown || null;
}

function status(issue: Pick<Issue, "fields">): Json {
	const found = issue.fields.status;
	if (found === null) return null;
	const category = found.status_category;
	return { name: found.name, category: category ? category.name : null };
}

function projectData(site: Site, project: Project): JsonObject {
	return {
		id: project.id,
		site_id: site.id,
		site: site.label,
		key: project.key,
		name: project.name,
		type: project.project_type_key,
		archived: Boolean(project.archived),
	};
}

const ListProjects = z.strictObject({
	site_id: siteId().nullable().default(null).describe("A site's id; without one, every site."),
});

export const LIST_PROJECTS = defineOperation<z.output<typeof ListProjects>>({
	name: "list_projects",
	title: "List projects",
	description: "List the Jira projects you may read, with the site each is on.",
	input: ListProjects,
	needs: [[PROJECT, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: PROJECT, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				const sites = data.site_id ? [await client.site(data.site_id)] : await client.sites();
				const records: ScopedRecord[] = [];
				let incomplete = false;
				for (const site of sites) {
					let start: number | null = 0;
					for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
						let projects: Project[];
						[projects, start] = await client.projects(site.id, { start: start ?? 0, limit: 50 });
						for (const project of projects) records.push({ resource: projectResource(binding, site, project.id), data: projectData(site, project) });
						if (start === null) break;
					}
					incomplete = incomplete || start !== null;
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


const SearchIssues = z.strictObject({
	site_id: siteId().nullable().default(null),
	project: projectName(),
	text: strippedStr({ min: 1, max: 200 })
		.describe("Words to find in the summary (descriptions and comments are not searched).")
		.refine(isSingleLine, SINGLE_LINE)
		.nullable()
		.default(null),
	status_category: z.enum(["to_do", "in_progress", "done"]).nullable().default(null),
	assigned_to_me: z.boolean().default(false),
	limit: z.int().min(1).max(50).default(25),
	cursor: cursor(),
});

export const SEARCH_ISSUES = defineOperation<z.output<typeof SearchIssues>>({
	name: "search_issues",
	title: "Search issues",
	description:
		"Find a project's issues, most recently updated first, by words in the summary, status category or assignment to you. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: SearchIssues,
	needs: [[PROJECT, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, project] = await resolveProject(binding, data.site_id, data.project);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				// The query is built from fields, never taken from the agent: JQL functions can select issues by
				// their relations to issues in other projects. Summaries only: Jira's text search also matches
				// descriptions and comments, whose links can carry titles of issues the agent may not read.
				const clauses = [`project = ${project.id}`];
				if (data.text !== null) clauses.push(`summary ~ "${searchWords(data.text)}"`);
				if (data.status_category !== null) clauses.push(`statusCategory = ${STATUS_CATEGORIES[data.status_category]}`);
				if (data.assigned_to_me) clauses.push("assignee = currentUser()");
				const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
				let ids: string[];
				let next: string | null;
				try {
					[ids, next] = await client.search(site.id, jql, { limit: data.limit, cursor: data.cursor });
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED") throw new OperationError("INVALID_ARGUMENTS", "Jira could not run this search.");
					throw error;
				}
				// Search reads an index that can lag behind moves: each issue is read again, and shown under the
				// project it is in now.
				const issues = ids.length ? await client.bulk(site.id, ids.filter((id) => ID.test(id)), SEARCH_FIELDS) : [];
				const siteHosts = hosts(await client.sites());
				const records: ScopedRecord[] = [];
				for (const issue of issues) {
					const fields = issue.fields;
					if (!ID.test(issue.id) || fields.project === null) continue;
					const record: JsonObject = {
						id: issue.id,
						key: issue.key,
						site_id: site.id,
						project_id: fields.project.id,
						summary: short(fields.summary, siteHosts),
						status: status(issue),
						type: fields.issuetype ? fields.issuetype.name : null,
						priority: fields.priority ? fields.priority.name : null,
						assignee: fields.assignee ? fields.assignee.display_name : null,
						updated: fields.updated,
						link: link(site, issue.key),
					};
					records.push({ resource: projectResource(binding, site, fields.project.id), data: record });
				}
				return { records, nextCursor: next };
			},
		};
	},
});

export const READ_NOTE = "Links to Atlassian appear without their titles, macros without their content, and related issues in other projects only as a count.";

function comment(found: Comment, siteHosts: readonly string[]): JsonObject {
	const [body, truncated] = truncate(adf.read(found.body, siteHosts), MAX_COMMENT);
	return {
		id: found.id,
		author: found.author ? found.author.display_name : null,
		created: found.created,
		updated: found.updated,
		text: body,
		text_truncated: truncated,
	};
}

/** The issues this one is related to, as (id, relation), once each. */
function relations(issue: Issue): [string, string][] {
	const fields = issue.fields;
	const found: [string, string][] = [];
	if (fields.parent !== null) found.push([fields.parent.id, "parent"]);
	for (const subtask of fields.subtasks) found.push([subtask.id, "subtask"]);
	for (const issueLink of fields.issuelinks) {
		const kind = issueLink.type;
		if (issueLink.outward_issue !== null) found.push([issueLink.outward_issue.id, (kind ? kind.outward : null) || "related"]);
		if (issueLink.inward_issue !== null) found.push([issueLink.inward_issue.id, (kind ? kind.inward : null) || "related"]);
	}
	const seen = new Set<string>();
	return found.filter((relation) => {
		if (!ID.test(relation[0])) return false;
		const key = JSON.stringify(relation);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Related issues in the same project, read fresh; the others only counted. An issue's embedded relations do
 * not say which project the other issue is in, so each is read to find out.
 */
async function related(client: JiraClient, site: Site, resource: Resource, issue: Issue, siteHosts: readonly string[]): Promise<JsonObject> {
	const all = relations(issue);
	const shown = all.slice(0, MAX_RELATED);
	const ids = [...new Set(shown.map(([id]) => id))];
	const found = new Map<string, Issue>();
	if (ids.length) for (const other of await client.bulk(site.id, ids, RELATED_FIELDS)) found.set(other.id, other);
	const out: Json[] = [];
	let elsewhere = 0;
	for (const [id, relation] of shown) {
		const other = found.get(id);
		const project = other ? other.fields.project : null;
		if (other === undefined || project === null || projectId(site, project.id) !== resource.id) {
			elsewhere += 1;
			continue;
		}
		out.push({ relation: short(relation, siteHosts), key: other.key, summary: short(other.fields.summary, siteHosts), status: status(other) });
	}
	return { related: out, related_elsewhere: elsewhere, related_not_shown: all.length - shown.length };
}

const GetIssue = z.strictObject({ site_id: siteId().nullable().default(null), issue: issueName() });

export const GET_ISSUE = defineOperation<z.output<typeof GetIssue>>({
	name: "get_issue",
	title: "Read an issue",
	description: `Read one Jira issue with its description, latest comments and related issues. ${READ_NOTE}`,
	input: GetIssue,
	needs: [[PROJECT, "read"]],
	async prepare(binding: Binding, data): Promise<Prepared> {
		const [site, resource, issueId] = await resolveIssue(binding, data.site_id, data.issue);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				const [comments, total] = await client.comments(site.id, issueId, { limit: MAX_COMMENTS });
				// Last, so the issue is seen in the project after its comments were read.
				const issue = await confirmIssue(binding, site, resource, issueId, ISSUE_FIELDS);
				const siteHosts = hosts(await client.sites());
				const fields = issue.fields;
				const [description, descriptionTruncated] = truncate(adf.read(fields.description, siteHosts), MAX_DESCRIPTION);
				const record: JsonObject = {
					id: issue.id,
					key: issue.key,
					site_id: site.id,
					project_id: fields.project ? fields.project.id : null,
					summary: short(fields.summary, siteHosts),
					status: status(issue),
					type: fields.issuetype ? fields.issuetype.name : null,
					priority: fields.priority ? fields.priority.name : null,
					assignee: fields.assignee ? fields.assignee.display_name : null,
					reporter: fields.reporter ? fields.reporter.display_name : null,
					labels: fields.labels,
					created: fields.created,
					updated: fields.updated,
					due_date: fields.duedate,
					resolution: fields.resolution ? fields.resolution.name : null,
					description,
					description_truncated: descriptionTruncated,
					attachments: fields.attachment.length,
					comments: [...comments].reverse().map((found) => comment(found, siteHosts)),
					comments_not_shown: Math.max(total - comments.length, 0),
					link: link(site, issue.key),
					...(await related(client, site, resource, issue, siteHosts)),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
