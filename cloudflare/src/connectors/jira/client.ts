// Jira Cloud's REST API (v3), reached per site through api.atlassian.com.
//
// Search pages with an opaque `nextPageToken`; this client keeps it as the page cursor, checked to be
// printable and short enough to store, and sends it back as a query parameter. Other lists page by offset.

import { z } from "zod";
import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { AtlassianClient } from "../atlassian/index.ts";
import { laxBool, model, optionalStr } from "../atlassian/model.ts";
import { extend } from "../../lib/arrays.ts";
import { segment } from "../../lib/text.ts";

export const MAX_PAGES = 10;
export const BULK_LIMIT = 100;
const TOKEN = /^[\x21-\x7e]{1,990}$/;
export const PREFIX = "t:";

const camel = { camel: true };
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);

export const ProjectModel = model(
	{ id: z.string(), key: z.string(), name: optionalStr, project_type_key: optionalStr, archived: optional(laxBool) },
	camel,
);
export type Project = z.output<typeof ProjectModel>;

const Named = model({ name: optionalStr }, camel);
const StatusCategory = model({ key: optionalStr, name: optionalStr }, camel);
const Status = model({ name: optionalStr, status_category: optional(StatusCategory) }, camel);
export const IssueTypeModel = model({ id: optionalStr, name: optionalStr, subtask: optional(laxBool) }, camel);
export type IssueType = z.output<typeof IssueTypeModel>;
const Person = model({ display_name: optionalStr }, camel);
const ProjectRef = model({ id: z.string(), key: optionalStr }, camel);
const Related = model({ id: z.string() }, camel);
const LinkType = model({ name: optionalStr, inward: optionalStr, outward: optionalStr }, camel);
const IssueLink = model({ type: optional(LinkType), inward_issue: optional(Related), outward_issue: optional(Related) }, camel);
/** `dict[str, Any]`: an object, whatever it holds. */
const Dict = z.custom<JsonObject>((value) => typeof value === "object" && value !== null && !Array.isArray(value));

const Fields = model(
	{
		project: optional(ProjectRef),
		summary: optionalStr,
		status: optional(Status),
		issuetype: optional(IssueTypeModel),
		priority: optional(Named),
		assignee: optional(Person),
		reporter: optional(Person),
		labels: z.array(z.string()).default([]),
		created: optionalStr,
		updated: optionalStr,
		duedate: optionalStr,
		resolution: optional(Named),
		description: z.custom<Json>().optional().transform((value) => value ?? null),
		parent: optional(Related),
		subtasks: z.array(Related).default([]),
		issuelinks: z.array(IssueLink).default([]),
		attachment: z.array(Dict).default([]),
	},
	camel,
);

export const IssueModel = model({ id: z.string(), key: z.string(), fields: Fields.prefault({}) }, camel);
export type Issue = z.output<typeof IssueModel>;
export type IssueStatus = NonNullable<Issue["fields"]["status"]>;

export const CommentModel = model(
	{
		id: z.string(),
		author: optional(Person),
		body: z.custom<Json>().optional().transform((value) => value ?? null),
		created: optionalStr,
		updated: optionalStr,
	},
	camel,
);
export type Comment = z.output<typeof CommentModel>;

export const TransitionModel = model({ id: z.string(), name: optionalStr, to: optional(Status) }, camel);
export type Transition = z.output<typeof TransitionModel>;

const Found = model({ id: z.string() }, camel);
const Created = model({ id: z.string(), key: optionalStr }, camel);

export function pageParams(cursor: string | null): { [name: string]: string } {
	if (cursor === null) return {};
	const token = cursor.startsWith(PREFIX) ? cursor.slice(PREFIX.length) : cursor;
	if (!cursor.startsWith(PREFIX) || !TOKEN.test(token)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return { nextPageToken: token };
}

export function nextCursor(body: JsonObject): string | null {
	const token = Object.hasOwn(body, "nextPageToken") ? body.nextPageToken : null;
	if (token === null || token === undefined || body.isLast === true) return null;
	if (typeof token !== "string" || !TOKEN.test(token)) throw new OperationError("PROVIDER_LIMIT", "Jira returned a page token Minerva cannot use.");
	return `${PREFIX}${token}`;
}

/**
 * Python's `isinstance(value, int)`, where a bool is an int. A JSON float with an integral value (`2.0`)
 * reads as the number 2 here, where Python would not count it; Jira writes totals as integers.
 */
function intOrNull(value: Json | undefined): number | null {
	if (typeof value === "boolean") return Number(value);
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Thin client for the parts of Jira's API the connector uses. */
export class JiraClient extends AtlassianClient {
	constructor(accessToken: string, io: ProviderIo) {
		super("Jira", "jira", accessToken, io, "read:jira-work");
	}

	#path(cloudId: string, path: string): string {
		return `${this.api(cloudId)}/rest/api/3${path}`;
	}

	async #object(cloudId: string, path: string, params?: { [name: string]: string }): Promise<JsonObject> {
		const body = await this.get(this.#path(cloudId, path), params);
		if (typeof body !== "object" || body === null || Array.isArray(body)) throw this.unexpected();
		return body;
	}

	#items<T>(schema: z.ZodType<T>, body: JsonObject, field: string): T[] {
		const items = Object.hasOwn(body, field) ? body[field] : undefined;
		if (!Array.isArray(items)) throw this.unexpected();
		return items.map((item) => this.parse(schema, item));
	}

	/** One page of the projects the account may browse, and the offset of the next page. */
	async projects(cloudId: string, options: { start: number; limit: number; query?: string | null }): Promise<[Project[], number | null]> {
		const params: { [name: string]: string } = { startAt: String(options.start), maxResults: String(options.limit), action: "browse", orderBy: "key" };
		if (options.query) params.query = options.query;
		const body = await this.#object(cloudId, "/project/search", params);
		const projects = this.#items(ProjectModel, body, "values");
		const isLast = Object.hasOwn(body, "isLast") ? body.isLast : true;
		const last = isLast !== false || projects.length === 0;
		return [projects, last ? null : options.start + projects.length];
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
		return this.parse(ProjectModel, await this.#object(cloudId, `/project/${segment(keyOrId)}`));
	}

	async issue(cloudId: string, keyOrId: string, fields: string): Promise<Issue> {
		return this.parse(IssueModel, await this.#object(cloudId, `/issue/${segment(keyOrId)}`, { fields }));
	}

	/** The issues with these ids, read fresh; ones the account cannot see are left out. */
	async bulk(cloudId: string, ids: readonly string[], fields: readonly string[]): Promise<Issue[]> {
		const found: Issue[] = [];
		for (let start = 0; start < ids.length; start += BULK_LIMIT) {
			const body = await this.readPost(this.#path(cloudId, "/issue/bulkfetch"), { issueIdsOrKeys: ids.slice(start, start + BULK_LIMIT), fields: [...fields] });
			if (typeof body !== "object" || body === null || Array.isArray(body)) throw this.unexpected();
			extend(found, this.#items(IssueModel, body, "issues"));
		}
		// Jira answers in ascending id order; the caller's order (a search's) is kept.
		const order = new Map<string, number>();
		ids.forEach((id, index) => order.set(id, index));
		return found.filter((issue) => order.has(issue.id)).sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
	}

	/** The ids of one page of issues matching `jql`. */
	async search(cloudId: string, jql: string, options: { limit: number; cursor: string | null }): Promise<[string[], string | null]> {
		const params = { jql, maxResults: String(options.limit), fields: "id", ...pageParams(options.cursor) };
		const body = await this.#object(cloudId, "/search/jql", params);
		return [this.#items(Found, body, "issues").map((issue) => issue.id), nextCursor(body)];
	}

	/** The latest comments, newest first, and how many there are in all. */
	async comments(cloudId: string, issueId: string, options: { limit: number }): Promise<[Comment[], number]> {
		const body = await this.#object(cloudId, `/issue/${segment(issueId)}/comment`, { orderBy: "-created", maxResults: String(options.limit), startAt: "0" });
		const comments = this.#items(CommentModel, body, "comments");
		const total = intOrNull(Object.hasOwn(body, "total") ? body.total : undefined);
		return [comments, total ?? comments.length];
	}

	/** The issue types issues can be created with in a project. */
	async issueTypes(cloudId: string, projectId: string): Promise<IssueType[]> {
		const found: IssueType[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const body = await this.#object(cloudId, `/issue/createmeta/${segment(projectId)}/issuetypes`, { startAt: String(found.length), maxResults: "50" });
			const field = Object.hasOwn(body, "issueTypes") ? "issueTypes" : "values";
			const types = this.#items(IssueTypeModel, body, field);
			extend(found, types);
			const total = intOrNull(Object.hasOwn(body, "total") ? body.total : undefined);
			if (types.length === 0 || total === null || found.length >= total) return found;
		}
		throw new OperationError("PROVIDER_LIMIT", "This Jira project has more issue types than Minerva reads.");
	}

	async transitions(cloudId: string, issueId: string): Promise<Transition[]> {
		const body = await this.#object(cloudId, `/issue/${segment(issueId)}/transitions`);
		return this.#items(TransitionModel, body, "transitions");
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
