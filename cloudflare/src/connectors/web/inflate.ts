// fetch.py's `_Inflater`: bounded decompression of a page sent with Content-Encoding gzip or deflate, as
// Python's zlib does it, never producing more than it is given room for.
//
// The Worker asks fetch for the body as sent (`encodeResponseBody: "manual"`), so the runtime decodes
// nothing and the cap applies before decompression as well as after it, as today. The decoder is zlib's own
// inflate as pako ports it (pako/lib/zlib, pinned in package.json), driven the way CPython's
// `Decompress.decompress(data, max_length)` drives zlib: Z_SYNC_FLUSH, output in blocks up to the limit,
// the input left over at the limit kept as `unconsumed_tail`, and after the end of the stream every further
// byte ignored as `unused_data`. So the outcomes are Python's: a gzip stream ends after its first member,
// its header flags, header CRC, CRC-32 and length are checked, a zlib stream's Adler-32 likewise, a stream
// cut short yields what was decoded, and "deflate" is retried as raw DEFLATE when zlib fails on the first
// chunk it was given. Memory stays near the 3 MB cap, however the page was compressed.

import { inflate, inflateInit2 } from "pako/lib/zlib/inflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import { OperationError } from "../../gateway/connector.ts";

const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;
const Z_SYNC_FLUSH = 2;
const MAX_WBITS = 15;
/** The output is gathered in blocks of this size, never past the limit (CPython's output buffer grows the same way). */
const BLOCK = 64 * 1024;

export function unsupportedEncoding(): OperationError {
	return new OperationError("UNSUPPORTED_CONTENT", "This site sent its page in an encoding Minerva cannot read.");
}

function damaged(): OperationError {
	return new OperationError("UNSUPPORTED_CONTENT", "This site sent a damaged page.");
}

/** `zlib.error`. */
class ZlibError extends Error {}

/** `zlib.decompressobj(wbits)`, with the parts of `decompress` `_Inflater` relies on. */
class Decompressor {
	readonly #strm = new ZStream();
	/** Where each block is decoded before it is copied out (zlib keeps its own window between calls). */
	readonly #scratch = new Uint8Array(BLOCK);
	/** Input left over when the output reached `max_length` (`unconsumed_tail` is not empty). */
	tail = false;

	constructor(wbits: number) {
		if (inflateInit2(this.#strm, wbits) !== Z_OK) throw new ZlibError(this.#strm.msg);
	}

	/** `decompress(data, max_length)` with `max_length` at least 1. */
	decompress(data: Uint8Array, maxLength: number): Uint8Array[] {
		const strm = this.#strm;
		strm.input = data;
		strm.next_in = 0;
		strm.avail_in = data.length;
		const out: Uint8Array[] = [];
		let produced = 0;
		let status = Z_OK;
		for (;;) {
			const size = Math.min(BLOCK, maxLength - produced);
			// The limit: whatever input is left stays unread.
			if (size === 0) break;
			strm.output = this.#scratch;
			strm.next_out = 0;
			strm.avail_out = size;
			status = inflate(strm, Z_SYNC_FLUSH);
			if (strm.next_out) {
				out.push(this.#scratch.slice(0, strm.next_out));
				produced += strm.next_out;
			}
			// Z_NEED_DICT included: Python gives no dictionary.
			if (status !== Z_OK && status !== Z_BUF_ERROR && status !== Z_STREAM_END) throw new ZlibError(strm.msg);
			if (strm.avail_out !== 0) break;
		}
		// After the end of the stream, what is left is `unused_data`, never decoded.
		this.tail = status !== Z_STREAM_END && strm.avail_in > 0;
		strm.input = null;
		return out;
	}
}

/** Bounded decompression: never produces more than it is given room for. */
export class Inflater {
	#encoding: "gzip" | "deflate" | "raw-deflate" | null;
	#started = false;
	#obj: Decompressor | null;
	readonly #tooLarge: () => OperationError;

	/** `encoding`: the one Content-Encoding (not identity), or null. */
	constructor(encoding: string | null, tooLarge: () => OperationError) {
		this.#tooLarge = tooLarge;
		if (encoding === "gzip" || encoding === "x-gzip") {
			this.#encoding = "gzip";
			this.#obj = new Decompressor(16 + MAX_WBITS);
		} else if (encoding === "deflate") {
			this.#encoding = "deflate";
			this.#obj = new Decompressor(MAX_WBITS);
		} else if (encoding === null) {
			this.#encoding = null;
			this.#obj = null;
		} else {
			throw unsupportedEncoding();
		}
	}

	/** `feed(data, room)`: the decoded bytes of the next chunk, at most `room` of them, or PAGE_TOO_LARGE. */
	feed(data: Uint8Array, room: number): Uint8Array[] {
		if (this.#encoding === null || this.#obj === null) return [data];
		let out: Uint8Array[];
		try {
			out = this.#obj.decompress(data, room);
		} catch (error) {
			if (!(error instanceof ZlibError)) throw error;
			// Some servers send raw deflate data without the zlib header.
			if (this.#encoding !== "deflate" || this.#started) throw damaged();
			this.#obj = new Decompressor(-MAX_WBITS);
			this.#encoding = "raw-deflate";
			return this.feed(data, room);
		}
		this.#started = true;
		if (this.#obj.tail) throw this.#tooLarge();
		return out;
	}
}
