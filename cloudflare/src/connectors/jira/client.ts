// Jira Cloud's REST API (v3), reached per site through api.atlassian.com.
//
// Search pages with an opaque `nextPageToken`; this client keeps it as the page cursor, checked to be
// printable and short enough to store, and sends it back as a query parameter. Other lists page by offset.

import { z } from "zod";
import { OperationError } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { AtlassianClient } from "../atlassian/index.ts";
import { extend } from "../../lib/arrays.ts";
import { type ProviderIo, segment } from "../../gateway/http.ts";

export const MAX_PAGES = 10;
export const BULK_LIMIT = 100;
const TOKEN = /^[\x21-\x7e]{1,990}$/;
export const PREFIX = "t:";

const optional = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);

export const ProjectModel = z.object({
	id: z.string(),
	key: z.string(),
	name: optional(z.string()),
	projectTypeKey: optional(z.string()),
	archived: optional(z.boolean()),
});
export type Project = z.output<typeof ProjectModel>;

const Named = z.object({ name: optional(z.string()) });
const StatusCategory = z.object({ key: optional(z.string()), name: optional(z.string()) });
const Status = z.object({ name: optional(z.string()), statusCategory: optional(StatusCategory) });
export const IssueTypeModel = z.object({ id: optional(z.string()), name: optional(z.string()), subtask: optional(z.boolean()) });
export type IssueType = z.output<typeof IssueTypeModel>;
const Person = z.object({ displayName: optional(z.string()) });
const ProjectRef = z.object({ id: z.string(), key: optional(z.string()) });
const Related = z.object({ id: z.string() });
const LinkType = z.object({ name: optional(z.string()), inward: optional(z.string()), outward: optional(z.string()) });
const IssueLink = z.object({ type: optional(LinkType), inwardIssue: optional(Related), outwardIssue: optional(Related) });
/** A JSON object, whatever it holds. */
const Dict = z.custom<JsonObject>((value) => typeof value === "object" && value !== null && !Array.isArray(value));

const Fields = z.object({
	project: optional(ProjectRef),
	summary: optional(z.string()),
	status: optional(Status),
	issuetype: optional(IssueTypeModel),
	priority: optional(Named),
	assignee: optional(Person),
	reporter: optional(Person),
	labels: z.array(z.string()).default([]),
	created: optional(z.string()),
	updated: optional(z.string()),
	duedate: optional(z.string()),
	resolution: optional(Named),
	description: z.custom<Json>().optional().transform((value) => value ?? null),
	parent: optional(Related),
	subtasks: z.array(Related).default([]),
	issuelinks: z.array(IssueLink).default([]),
	attachment: z.array(Dict).default([]),
});

export const IssueModel = z.object({ id: z.string(), key: z.string(), fields: Fields.prefault({}) });
export type Issue = z.output<typeof IssueModel>;

export const CommentModel = z.object({
	id: z.string(),
	author: optional(Person),
	body: z.custom<Json>().optional().transform((value) => value ?? null),
	created: optional(z.string()),
	updated: optional(z.string()),
});
export type Comment = z.output<typeof CommentModel>;

export const TransitionModel = z.object({ id: z.string(), name: optional(z.string()), to: optional(Status) });
export type Transition = z.output<typeof TransitionModel>;

const Found = z.object({ id: z.string() });
const Created = z.object({ id: z.string(), key: optional(z.string()) });

const ProjectPage = z.object({ values: z.array(ProjectModel), isLast: z.boolean().default(true) });
const SearchPage = z.object({ issues: z.array(Found), nextPageToken: optional(z.string()), isLast: z.boolean().default(false) });
const BulkIssues = z.object({ issues: z.array(IssueModel) });
const CommentPage = z.object({ comments: z.array(CommentModel), total: optional(z.number().int()) });
const IssueTypePage = z.object({ issueTypes: z.array(IssueTypeModel), total: optional(z.number().int()) });
const Transitions = z.object({ transitions: z.array(TransitionModel) });

export function pageParams(cursor: string | null): { [name: string]: string } {
	if (cursor === null) return {};
	const token = cursor.startsWith(PREFIX) ? cursor.slice(PREFIX.length) : cursor;
	if (!cursor.startsWith(PREFIX) || !TOKEN.test(token)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return { nextPageToken: token };
}

export function nextCursor(page: { nextPageToken: string | null; isLast: boolean }): string | null {
	const token = page.nextPageToken;
	if (token === null || page.isLast) return null;
	if (!TOKEN.test(token)) throw new OperationError("PROVIDER_LIMIT", "Jira returned a page token Minerva cannot use.");
	return `${PREFIX}${token}`;
}

/** Thin client for the parts of Jira's API the connector uses. */
export class JiraClient extends AtlassianClient {
	constructor(accessToken: string, io: ProviderIo) {
		super("Jira", "jira", accessToken, io, "read:jira-work");
	}

	#path(cloudId: string, path: string): string {
		return `${this.api(cloudId)}/rest/api/3${path}`;
	}

	/** A GET of the site's API, its answer read with `schema`. */
	async #read<T>(schema: z.ZodType<T>, cloudId: string, path: string, params?: { [name: string]: string }): Promise<T> {
		return this.parse(schema, await this.get(this.#path(cloudId, path), params));
	}

	/** One page of the projects the account may browse, and the offset of the next page. */
	async projects(cloudId: string, options: { start: number; limit: number; query?: string | null }): Promise<[Project[], number | null]> {
		const params: { [name: string]: string } = { startAt: String(options.start), maxResults: String(options.limit), action: "browse", orderBy: "key" };
		if (options.query) params.query = options.query;
		const page = await this.#read(ProjectPage, cloudId, "/project/search", params);
		const projects = page.values;
		return [projects, page.isLast || projects.length === 0 ? null : options.start + projects.length];
	}

	async allProjects(cloudId: string): Promise<Project[]> {
		const found: Project[] = [];
		let start: number | null = 0;
		for (let page = 0; page < MAX_PAGES; page++) {
			let projects: Project[];
			[projects, start] = await this.projects(cloudId, { start: start ?? 0, limit: 50 });
			extend(found, projects);
			if (start === null) return found;
		}
		throw new OperationError("PROVIDER_LIMIT", "There are more Jira projects than Minerva reads.");
	}

	async project(cloudId: string, keyOrId: string): Promise<Project> {
		return this.#read(ProjectModel, cloudId, `/project/${segment(keyOrId)}`);
	}

	async issue(cloudId: string, keyOrId: string, fields: string): Promise<Issue> {
		return this.#read(IssueModel, cloudId, `/issue/${segment(keyOrId)}`, { fields });
	}

	/** The issues with these ids, read fresh; ones the account cannot see are left out. */
	async bulk(cloudId: string, ids: readonly string[], fields: readonly string[]): Promise<Issue[]> {
		const found: Issue[] = [];
		for (let start = 0; start < ids.length; start += BULK_LIMIT) {
			const body = await this.readPost(this.#path(cloudId, "/issue/bulkfetch"), { issueIdsOrKeys: ids.slice(start, start + BULK_LIMIT), fields: [...fields] });
			extend(found, this.parse(BulkIssues, body).issues);
		}
		// Jira answers in ascending id order; the caller's order (a search's) is kept.
		const order = new Map<string, number>();
		ids.forEach((id, index) => order.set(id, index));
		return found.filter((issue) => order.has(issue.id)).sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
	}

	/** The ids of one page of issues matching `jql`. */
	async search(cloudId: string, jql: string, options: { limit: number; cursor: string | null }): Promise<[string[], string | null]> {
		const params = { jql, maxResults: String(options.limit), fields: "id", ...pageParams(options.cursor) };
		const page = await this.#read(SearchPage, cloudId, "/search/jql", params);
		return [page.issues.map((issue) => issue.id), nextCursor(page)];
	}

	/** The latest comments, newest first, and how many there are in all. */
	async comments(cloudId: string, issueId: string, options: { limit: number }): Promise<[Comment[], number]> {
		const page = await this.#read(CommentPage, cloudId, `/issue/${segment(issueId)}/comment`, { orderBy: "-created", maxResults: String(options.limit), startAt: "0" });
		return [page.comments, page.total ?? page.comments.length];
	}

	/** The issue types issues can be created with in a project. */
	async issueTypes(cloudId: string, projectId: string): Promise<IssueType[]> {
		const found: IssueType[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const answer = await this.#read(IssueTypePage, cloudId, `/issue/createmeta/${segment(projectId)}/issuetypes`, { startAt: String(found.length), maxResults: "50" });
			const types = answer.issueTypes;
			extend(found, types);
			if (types.length === 0 || answer.total === null || found.length >= answer.total) return found;
		}
		throw new OperationError("PROVIDER_LIMIT", "This Jira project has more issue types than Minerva reads.");
	}

	async transitions(cloudId: string, issueId: string): Promise<Transition[]> {
		return (await this.#read(Transitions, cloudId, `/issue/${segment(issueId)}/transitions`)).transitions;
	}

	// Writes: each operation sends exactly one.

	async addComment(cloudId: string, issueId: string, body: Json): Promise<Comment> {
		return this.http.parsed({ method: "POST", path: this.#path(cloudId, `/issue/${segment(issueId)}/comment`), json: { body } }, CommentModel);
	}

	async createIssue(cloudId: string, fields: JsonObject): Promise<z.output<typeof Created>> {
		return this.http.parsed({ method: "POST", path: this.#path(cloudId, "/issue"), json: { fields } }, Created);
	}

	async transition(cloudId: string, issueId: string, transitionId: string): Promise<void> {
		await this.http.request({ method: "POST", path: this.#path(cloudId, `/issue/${segment(issueId)}/transitions`), json: { transition: { id: transitionId } } });
	}
}
