// The API's refusals: `{"code": …, "detail": …}` with the code's status (shared/rpc.ts REFUSALS). Better
// Auth answers /api/auth in its own format. Every JSON response is `no-store`.

import type { core } from "zod";
import { REFUSALS, type RefusalCode } from "../shared/rpc.ts";

const JSON_TYPE = "application/json; charset=utf-8";

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
	const response = new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
	if (status !== 204) response.headers.set("Content-Type", JSON_TYPE);
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	return response;
}

/** A refusal with this code and text. */
export function refused(code: RefusalCode, detail: string, headers?: HeadersInit): Response {
	return json(REFUSALS[code], { code, detail }, headers);
}

/** Not signed in, or not a member of the workspace in the URL (never 403 or 404 there). */
export function unauthorized(): Response {
	return refused("UNAUTHORIZED", "Unauthorized");
}

/** No such route, or nothing the caller may see there. */
export function notFound(): Response {
	return refused("NOT_FOUND", "Not found.");
}

/** An unsafe request that did not come from the site's pages (http/csrf.ts). */
export function crossSite(): Response {
	return refused("CROSS_SITE", "Cross-site request refused.");
}

export function serverError(): Response {
	return refused("INTERNAL_SERVER_ERROR", "Something went wrong on the server.");
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

// Validation errors: 422 `VALIDATION_FAILED` whose detail is a list of `{type, loc, msg}`, zod's issue code
// and message. `loc` starts with where the value came from ("body" or "query"), then the issue's path. The
// frontend shows "<last loc>: <msg>".

export type Location = "body" | "query" | "path";

export interface ValidationItem {
	type: string;
	loc: (string | number)[];
	msg: string;
}

export function validationError(items: ValidationItem[]): Response {
	return json(REFUSALS.VALIDATION_FAILED, { code: "VALIDATION_FAILED", detail: items });
}

export function validationItems(issues: readonly core.$ZodIssue[], where: Location): ValidationItem[] {
	return issues.map((issue) => ({ type: issue.code, loc: [where, ...issue.path.map((part) => (typeof part === "number" ? part : String(part)))], msg: issue.message }));
}
