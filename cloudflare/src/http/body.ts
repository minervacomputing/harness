// JSON request bodies, capped before parsing as Django caps them today (web-api spec 1): a declared or
// streamed length over 2.5 MB is 413 `The request is too large.`, and a body that is not JSON is 400
// `Cannot parse request body`. Uploads are raw bodies and do not come through here. Routes read bodies
// only with `readJson`, never `c.req.json()`: it parses with lib/json.ts's `parseJson`, which the
// runtime's JSON.parse cannot replace (see there), and test/unit/sources.test.ts checks it.

import { type Json, parseJson } from "../lib/json.ts";
import { HttpError, tooLarge, unparseableBody } from "./errors.ts";

/** Django's DATA_UPLOAD_MAX_MEMORY_SIZE. */
export const MAX_JSON_BODY = 2_621_440;

export async function readJson(request: Request, limit = MAX_JSON_BODY): Promise<Json> {
	const declared = request.headers.get("Content-Length");
	if (declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > limit)) {
		throw new HttpError(tooLarge());
	}
	const text = await readText(request, limit);
	try {
		return parseJson(text);
	} catch {
		throw new HttpError(unparseableBody());
	}
}

async function readText(request: Request, limit: number): Promise<string> {
	if (!request.body) return "";
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
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new HttpError(unparseableBody());
	}
}
