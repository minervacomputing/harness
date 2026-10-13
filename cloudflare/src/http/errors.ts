// The API's refusals, with the code's status (shared/rpc.ts REFUSALS), in the contract's error shape,
// `{"defined": true, "code": …, "status": …, "message": …}` (`errorAnswer`): every route of the contract
// (api/orpc.ts), the routes beside it whose paths it names (the upload, downloads, the run stream, the OAuth
// callback), our reader in front of Better Auth, and what the router answers before or instead of a route
// (CSRF, the declared body cap, no such route, a crash, too many session cookies). Better Auth answers
// /api/auth in its own format, `{code, message}`. Every JSON response is `no-store`.

import { REFUSALS, type RefusalCode } from "../shared/rpc.ts";

const JSON_TYPE = "application/json; charset=utf-8";

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
	const response = new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
	if (status !== 204) response.headers.set("Content-Type", JSON_TYPE);
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	return response;
}

/** A refusal in the contract's error shape (above), which its clients read as a declared error. */
export function errorAnswer(code: RefusalCode, message: string, headers?: HeadersInit): Response {
	return json(REFUSALS[code], { defined: true, code, status: REFUSALS[code], message }, headers);
}

/** Not signed in, or not a member of the workspace in the URL (never 403 or 404 there). */
export function unauthorized(): Response {
	return errorAnswer("UNAUTHORIZED", "Unauthorized");
}

/** An unsafe request that did not come from the site's pages (http/csrf.ts). */
export function crossSite(): Response {
	return errorAnswer("CROSS_SITE", "Cross-site request refused.");
}

/** No route answers this method and path. */
export function noRoute(): Response {
	return errorAnswer("NOT_FOUND", "Not found.");
}

/** What a crash answers. */
export const SERVER_ERROR = "Something went wrong on the server.";

export function serverError(): Response {
	return errorAnswer("INTERNAL_SERVER_ERROR", SERVER_ERROR);
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
