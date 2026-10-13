// The Todoist API v1 client: a thin client on
// ProviderHTTP whose responses are validated before use, with the models' rules.
//
// The Python models validate the decoded JSON in Pydantic's lax mode, so the schemas here accept what
// they accept, not only what Todoist sends today: an int field also takes a bool, an integral number and
// a string written as an int ("4", " +1_0.00 "); a bool field takes 0 and 1 and the words Pydantic
// knows ("true", "off", "Y"); TodoistUser's strings also take numbers (`coerce_numbers_to_str`). Unknown
// fields are ignored (`extra="ignore"`).
//
// Where a JavaScript number cannot hold what Python reads, the two differ. A parsed number cannot tell
// `12` from `12.0`, so a number written with a fraction of zero becomes the string "12", not "12.0", and an
// integer written out beyond 2^53 has lost digits before it is read (it is read as the float it now is).
// An int beyond 2^53, which Python keeps exactly, is refused rather than rounded, so a record never holds
// a rounded or infinite number; Python refuses floats from about 9.2e18 (int_parsing_size) as well.
// The user's id is the connection's account id, which must be exact: a number that may have lost digits
// (an integral one beyond 2^53, or an infinity, which an integer written out with 309 digits becomes) is
// refused there too, so two accounts can never share an id; its labels are the number as JavaScript writes
// it ("100000000000000000000", "Infinity").
// Todoist's ids are strings and its priorities 1 to 4 in API v1.

import { z } from "zod";
import type { ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { ProviderHTTP } from "../../gateway/http.ts";

export const API_URL = "https://api.todoist.com/api/v1";

/** A str as Pydantic reads it as an int: White_Space around, a sign, digits with single underscores between, `.0…`. */
const INT_TEXT = /^[+-]?[0-9]+(?:_[0-9]+)*(?:\.0+)?$/;
const TRUE_WORDS: ReadonlySet<string> = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_WORDS: ReadonlySet<string> = new Set(["0", "off", "f", "false", "n", "no"]);

/** An int a number holds exactly; `+ 0` turns -0 into 0, as Python's ints have no negative zero. */
function exactInt(value: number): number | null {
	return Number.isSafeInteger(value) ? value + 0 : null;
}

/** Pydantic's lax `int`, or null where it fails (or the int is beyond 2^53). */
export function laxInt(value: unknown): number | null {
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return exactInt(value);
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!INT_TEXT.test(text)) return null;
	return exactInt(Number(text.replace(/\.0+$/, "").replaceAll("_", "")));
}

/** Pydantic's lax `bool`, or null where it fails. */
export function laxBool(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
	if (typeof value !== "string") return null;
	const word = value.toLowerCase();
	return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
}

/** A string as it is, or a number as JavaScript writes it. */
export function numberAsStr(value: unknown): string | null {
	if (typeof value === "string") return value;
	return typeof value === "number" ? String(value + 0) : null;
}

/**
 * The user's id with `coerce_numbers_to_str`, or null for a number that may not be the one Todoist wrote:
 * an integral one beyond 2^53 or an infinity. A safe integer and a number with a fraction are exact.
 */
export function numberAsId(value: unknown): string | null {
	if (typeof value === "number" && !Number.isSafeInteger(value) && (Number.isInteger(value) || !Number.isFinite(value))) return null;
	return numberAsStr(value);
}

function lax<T>(read: (value: unknown) => T | null, expected: string): z.ZodType<T> {
	return z.unknown().transform((value, ctx) => {
		const out = read(value);
		if (out !== null) return out;
		ctx.issues.push({ code: "custom", message: `Input should be a valid ${expected}`, input: value });
		return z.NEVER;
	}) as unknown as z.ZodType<T>;
}

const LaxInt = () => lax(laxInt, "integer");
const LaxBool = () => lax(laxBool, "boolean");
const CoercedStr = () => lax(numberAsStr, "string");
const CoercedId = () => lax(numberAsId, "string");

export const TodoistUser = z.object({
	id: CoercedId(),
	full_name: CoercedStr().nullable().default(null),
	email: CoercedStr().nullable().default(null),
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
	priority: LaxInt().default(1),
	due: TodoistDue.nullable().default(null),
	checked: LaxBool().default(false),
});
export type TodoistTask = z.output<typeof TodoistTask>;

/** `Page[T]`. */
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
