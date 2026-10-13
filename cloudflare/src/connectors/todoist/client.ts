// The Todoist API v1 client: a thin client on ProviderHTTP whose responses are validated before use.
// Unknown fields are dropped; a field of another type makes the response unexpected. Todoist's ids are
// strings and its priorities 1 to 4.

import { z } from "zod";
import type { ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { ProviderHTTP } from "../../gateway/http.ts";

export const API_URL = "https://api.todoist.com/api/v1";

export const TodoistUser = z.object({
	id: z.string(),
	full_name: z.string().nullable().default(null),
	email: z.string().nullable().default(null),
});
export type TodoistUser = z.output<typeof TodoistUser>;

export const TodoistProject = z.object({
	id: z.string(),
	name: z.string(),
	color: z.string().nullable().default(null),
	parent_id: z.string().nullable().default(null),
});
export type TodoistProject = z.output<typeof TodoistProject>;

export const TodoistDue = z.object({
	date: z.string(),
	string: z.string().nullable().default(null),
});

export const TodoistTask = z.object({
	id: z.string(),
	project_id: z.string(),
	content: z.string(),
	description: z.string().default(""),
	priority: z.int().default(1),
	due: TodoistDue.nullable().default(null),
	checked: z.boolean().default(false),
});
export type TodoistTask = z.output<typeof TodoistTask>;

/** A page of results and the cursor to the next. */
function page<T extends z.ZodType>(item: T) {
	return z.object({ results: z.array(item), next_cursor: z.string().nullable().default(null) });
}

export const ProjectPage = page(TodoistProject);
export const TaskPage = page(TodoistTask);
export interface Page<T> {
	results: T[];
	next_cursor: string | null;
}

export interface PageOptions {
	cursor: string | null;
	limit: number;
}

/** Thin client for the Todoist API v1. Responses are validated before use. */
export class TodoistClient implements ProviderClient {
	readonly http: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		this.http = new ProviderHTTP(io, { provider: "Todoist", baseUrl, headers: { Authorization: `Bearer ${accessToken}` } });
	}

	close(): Promise<void> {
		return this.http.close();
	}

	user(): Promise<TodoistUser> {
		return this.http.parsed({ method: "GET", path: "/user" }, TodoistUser);
	}

	projects(cursor: string | null = null, limit = 200): Promise<Page<TodoistProject>> {
		return this.http.parsed({ method: "GET", path: "/projects", query: { limit, ...(cursor ? { cursor } : {}) } }, ProjectPage);
	}

	tasks(projectId: string, { cursor, limit }: PageOptions): Promise<Page<TodoistTask>> {
		return this.http.parsed({ method: "GET", path: "/tasks", query: { project_id: projectId, limit, ...(cursor ? { cursor } : {}) } }, TaskPage);
	}

	filterTasks(query: string, { cursor, limit }: PageOptions): Promise<Page<TodoistTask>> {
		return this.http.parsed({ method: "GET", path: "/tasks/filter", query: { query, limit, ...(cursor ? { cursor } : {}) } }, TaskPage);
	}

	task(taskId: string): Promise<TodoistTask> {
		return this.http.parsed({ method: "GET", path: `/tasks/${taskId}` }, TodoistTask);
	}

	createTask(projectId: string, content: string): Promise<TodoistTask> {
		return this.http.parsed({ method: "POST", path: "/tasks", json: { project_id: projectId, content } }, TodoistTask);
	}
}
