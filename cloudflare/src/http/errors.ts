// The error shapes the frontend reads: `{detail}` for the JSON API (Better Auth answers /api/auth in its
// own format). Every JSON response is `no-store`.

import type { core } from "zod";

const JSON_TYPE = "application/json; charset=utf-8";

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
	const response = new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
	if (status !== 204) response.headers.set("Content-Type", JSON_TYPE);
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	return response;
}

/** `{"detail": "<message>"}` with that status. */
export function detail(status: number, message: string, headers?: HeadersInit): Response {
	return json(status, { detail: message }, headers);
}

/** Not signed in, or not a member of the workspace in the URL (never 403 or 404 there). */
export function unauthorized(): Response {
	return detail(401, "Unauthorized");
}

/** 404 Not Found; with debug on, the reason is appended. */
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

// Validation errors: 422 with a list of `{type, loc, msg}`, zod's issue code and message. `loc` starts with
// where the value came from ("body" or "query"), then the issue's path. The frontend shows
// "<last loc>: <msg>".

export type Location = "body" | "query" | "path";

export interface ValidationItem {
	type: string;
	loc: (string | number)[];
	msg: string;
}

export function validationError(items: ValidationItem[]): Response {
	return json(422, { detail: items });
}

export function validationItems(issues: readonly core.$ZodIssue[], where: Location): ValidationItem[] {
	return issues.map((issue) => ({ type: issue.code, loc: [where, ...issue.path.map((part) => (typeof part === "number" ? part : String(part)))], msg: issue.message }));
}
