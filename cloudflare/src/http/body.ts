// JSON request bodies, capped before parsing: a declared or streamed length over 2.5 MB is 413 `The request
// is too large.`, and a body that is not UTF-8 JSON is 400 `Cannot parse request body`. Uploads are raw
// bodies and do not come through here. Routes read bodies only with `readJson`, never `c.req.json()`: it
// parses with lib/json.ts's `parseJsonBytes`, which the runtime's JSON.parse cannot replace (see there),
// and test/unit/sources.test.ts checks it.

import { concatAll } from "../lib/bytes.ts";
import { type Json, parseJsonBytes } from "../lib/json.ts";
import { HttpError, tooLarge, unparseableBody } from "./errors.ts";

/** The largest JSON request body, in bytes. */
export const MAX_JSON_BODY = 2_621_440;

export async function readJson(request: Request, limit = MAX_JSON_BODY): Promise<Json> {
	return parse(await readBytes(request, limit));
}

/**
 * A body that may be absent: null when it is empty, so the route validates the request as if no payload
 * was sent (a required body is 422 `missing`, api/input.ts); otherwise as `readJson`.
 */
export async function readOptionalJson(request: Request, limit = MAX_JSON_BODY): Promise<{ value: Json } | null> {
	const bytes = await readBytes(request, limit);
	return bytes.byteLength === 0 ? null : { value: parse(bytes) };
}

function parse(bytes: Uint8Array): Json {
	try {
		return parseJsonBytes(bytes);
	} catch {
		throw new HttpError(unparseableBody());
	}
}

/** The body's bytes, refused with 413 once a declared or streamed length passes `limit`. */
export async function readBytes(request: Request, limit = MAX_JSON_BODY): Promise<Uint8Array> {
	const declared = request.headers.get("Content-Length");
	if (declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > limit)) {
		throw new HttpError(tooLarge());
	}
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new HttpError(tooLarge());
		}
		chunks.push(value);
	}
	return concatAll(chunks);
}
