// JSON request bodies. Every one is read with `readJson`, the contract's routes (api/orpc.ts `jsonBody`) and
// Better Auth's (accounts/auth.ts) alike, never with `c.req.json()`: `Content-Type: application/json`
// (parameters such as `; charset=utf-8` allowed), at most 2.5 MB declared or streamed, strict UTF-8, then
// lib/json.ts's `parseJson`, which the runtime's JSON.parse cannot replace (see there;
// test/unit/sources.test.ts checks it). Uploads are raw bodies and do not come through here.

import { concatAll } from "../lib/bytes.ts";
import { type Json, parseJsonBytes } from "../lib/json.ts";
import type { Outcome, Refusal } from "../shared/rpc.ts";

/** The largest JSON request body, in bytes. */
export const MAX_JSON_BODY = 2_621_440;

export const NOT_JSON: Refusal = { code: "UNSUPPORTED_MEDIA_TYPE", detail: "Send the body as application/json." };
export const TOO_LARGE: Refusal = { code: "PAYLOAD_TOO_LARGE", detail: "The request is too large." };
export const UNPARSEABLE: Refusal = { code: "INVALID_JSON", detail: "The body is not valid JSON." };

/** The body's JSON value, undefined for an empty body, or why it is refused (above). The internal API reads up to its own cap. */
export async function readJson(request: Request, limit = MAX_JSON_BODY): Promise<Outcome<Json | undefined>> {
	const type = request.headers.get("Content-Type");
	if (type === null || type.split(";")[0]!.trim().toLowerCase() !== "application/json") return { ok: false, refusal: NOT_JSON };
	const bytes = await readBytes(request, limit);
	if (bytes === null) return { ok: false, refusal: TOO_LARGE };
	if (bytes.byteLength === 0) return { ok: true, value: undefined };
	try {
		return { ok: true, value: parseJsonBytes(bytes) };
	} catch {
		return { ok: false, refusal: UNPARSEABLE };
	}
}

/** Whether the declared Content-Length is over `limit`, or not a number. */
export function declaredOver(message: Request | Response, limit: number): boolean {
	const declared = message.headers.get("Content-Length");
	return declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > limit);
}

/** A request's or a response's body, or null once a declared or streamed length passes `limit`. */
export async function readBytes(message: Request | Response, limit: number): Promise<Uint8Array | null> {
	if (declaredOver(message, limit)) return null;
	if (!message.body) return new Uint8Array(0);
	const reader = message.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return concatAll(chunks);
}
