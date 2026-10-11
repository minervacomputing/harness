// The error shapes the frontend reads (web-api spec 4): Django Ninja's `{detail}` for the JSON API and
// allauth's envelope for /api/auth. Every JSON response is `no-store`.

import type { core } from "zod";

const JSON_TYPE = "application/json; charset=utf-8";

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
	const response = new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
	if (status !== 204) response.headers.set("Content-Type", JSON_TYPE);
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	return response;
}

/** Ninja's `HttpError`: `{"detail": "<message>"}` with that status. */
export function detail(status: number, message: string, headers?: HeadersInit): Response {
	return json(status, { detail: message }, headers);
}

/** Not signed in, or not a member of the workspace in the URL (never 403 or 404 there). */
export function unauthorized(): Response {
	return detail(401, "Unauthorized");
}

/** `get_object_or_404`: capital F. With debug on, the reason is appended as Django does. */
export function notFound(reason?: string, debug = false): Response {
	return detail(404, debug && reason ? `Not Found: ${reason}` : "Not Found");
}

export function csrfFailed(): Response {
	return detail(403, "CSRF check Failed");
}

export function unparseableBody(): Response {
	return detail(400, "Cannot parse request body");
}

export function tooLarge(): Response {
	return detail(413, "The request is too large.");
}

export function serverError(): Response {
	return detail(500, "Something went wrong on the server.");
}

/** Thrown to answer a request early with a ready response. */
export class HttpError extends Error {
	readonly response: Response;

	constructor(response: Response) {
		super(`HTTP ${response.status}`);
		this.name = "HttpError";
		this.response = response;
	}
}

// Validation errors: Ninja answers 422 with Pydantic's error list, `input` stripped. `loc` starts with
// where the value came from; body fields sit under `payload`. The frontend shows "<last loc>: <msg>".

export type Location = "body" | "query" | "path";

export interface ValidationItem {
	type: string;
	loc: (string | number)[];
	msg: string;
	ctx?: Record<string, string | number>;
}

export function validationError(items: ValidationItem[]): Response {
	return json(422, { detail: items });
}

/**
 * Zod's issues in Pydantic's words, for the cases the API's schemas produce. `input` is what was parsed:
 * the value an issue is about is read from it by the issue's path, since zod leaves `issue.input` out
 * unless parsing asked for it (`reportInput`), and a missing field must not read as a wrong type.
 */
export function validationItems(issues: readonly core.$ZodIssue[], where: Location, input: unknown): ValidationItem[] {
	const prefix: (string | number)[] = where === "body" ? ["body", "payload"] : [where];
	return issues.map((issue) => ({ ...pydantic(issue, valueAt(input, issue.path)), loc: [...prefix, ...issue.path.map(pathPart)] }));
}

/** The value at `path` in `input`, or `missing` when some step of the path does not exist. */
const missing = Symbol("missing");

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
	let value = input;
	for (const part of path) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return missing;
		value = (value as Record<PropertyKey, unknown>)[part];
	}
	return value;
}

function pathPart(part: PropertyKey): string | number {
	return typeof part === "number" ? part : String(part);
}

function pydantic(issue: core.$ZodIssue, value: unknown): Omit<ValidationItem, "loc"> {
	switch (issue.code) {
		case "invalid_type":
			if (value === missing) return { type: "missing", msg: "Field required" };
			if (issue.expected === "string") return { type: "string_type", msg: "Input should be a valid string" };
			if (issue.expected === "array") return { type: "list_type", msg: "Input should be a valid list" };
			if (issue.expected === "object") return { type: "model_type", msg: "Input should be an object" };
			if (issue.expected === "boolean") return { type: "bool_type", msg: "Input should be a valid boolean" };
			if (issue.expected === "int") return { type: "int_type", msg: "Input should be a valid integer" };
			if (issue.expected === "number") return { type: "float_type", msg: "Input should be a valid number" };
			return { type: "type_error", msg: issue.message };
		case "too_big":
			if (issue.origin === "string") {
				return { type: "string_too_long", msg: `String should have at most ${plural(issue.maximum, "character")}`, ctx: { max_length: Number(issue.maximum) } };
			}
			if (issue.origin === "array") {
				const actual = Array.isArray(value) ? value.length : Number(issue.maximum) + 1;
				return {
					type: "too_long",
					msg: `List should have at most ${plural(issue.maximum, "item")} after validation, not ${actual}`,
					ctx: { field_type: "List", max_length: Number(issue.maximum), actual_length: actual },
				};
			}
			return { type: "less_than_equal", msg: `Input should be less than or equal to ${issue.maximum}`, ctx: { le: Number(issue.maximum) } };
		case "too_small":
			if (issue.origin === "string") {
				return { type: "string_too_short", msg: `String should have at least ${plural(issue.minimum, "character")}`, ctx: { min_length: Number(issue.minimum) } };
			}
			if (issue.origin === "array") {
				const actual = Array.isArray(value) ? value.length : 0;
				return {
					type: "too_short",
					msg: `List should have at least ${plural(issue.minimum, "item")} after validation, not ${actual}`,
					ctx: { field_type: "List", min_length: Number(issue.minimum), actual_length: actual },
				};
			}
			return { type: "greater_than_equal", msg: `Input should be greater than or equal to ${issue.minimum}`, ctx: { ge: Number(issue.minimum) } };
		case "invalid_format":
			if (issue.format === "uuid" || issue.format === "guid") return { type: "uuid_parsing", msg: "Input should be a valid UUID" };
			return { type: "string_pattern_mismatch", msg: issue.message };
		case "invalid_value":
			return { type: "enum", msg: `Input should be ${issue.values.map((value) => `'${String(value)}'`).join(" or ")}` };
		default:
			return { type: "value_error", msg: issue.message };
	}
}

function plural(count: number | bigint, noun: string): string {
	return `${count} ${noun}${Number(count) === 1 ? "" : "s"}`;
}

// allauth's headless envelope (web-api spec 5.2): `{status, data?, meta?, errors?}`, the status repeated
// from the HTTP status. An error without `param` is form-wide.

export interface AllauthError {
	message: string;
	code: string;
	param?: string;
}

export interface AllauthBody {
	data?: unknown;
	meta?: unknown;
	errors?: AllauthError[];
}

export function allauth(status: number, body: AllauthBody = {}): Response {
	return json(status, { status, ...body });
}

/** Today Django answers a failed CSRF check on allauth routes with an HTML page; the port answers this. */
export function allauthCsrfFailed(): Response {
	return allauth(403, { errors: [{ message: "CSRF check failed.", code: "csrf" }] });
}
