// The engine's refusals, with the code's status (shared/rpc.ts REFUSALS), in the contract's error shape,
// `{"defined": true, "code": …, "status": …, "message": …}` (`errorAnswer`): what the router answers before or instead of a
// route (no such route, a crash), the internal API's mount and Laravel's run stream. Every JSON response is `no-store`.

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

/** No valid credential: Access's assertion, or a stream token. Nothing says why. */
export function unauthorized(): Response {
	return errorAnswer("UNAUTHORIZED", "Unauthorized");
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
