// Bounded decompression of a page sent with Content-Encoding gzip or deflate: the inflater never produces
// more than it is given room for, so memory stays near the 3 MB cap however the page was compressed.
//
// The Worker asks fetch for the body as sent (`encodeResponseBody: "manual"`), so a gzip body arrives
// encoded and the cap applies before decompression as well as after it. On the account the platform
// decodes br and deflate itself (it asks the site for `gzip, br` whatever the request says; fetch.ts
// REQUEST_HEADERS), so those arrive as is and only the cap after decompression applies; the deflate path
// stays for a runtime that hands it on.
//
// The decoder is zlib's inflate as pako ports it (pako/lib/zlib, pinned in package.json), driven with
// Z_SYNC_FLUSH into output blocks that never pass the room left. Input still unread when the room is full
// means the page is too large; bytes after the end of the stream are ignored. So a gzip stream ends after
// its first member; its header flags, header CRC, CRC-32 and length are checked, as a zlib stream's
// Adler-32 is; a stream cut short yields what was decoded; and "deflate" is retried as raw DEFLATE when
// zlib fails on the first chunk it was given (some servers send raw DEFLATE under that name).
//
// DecompressionStream is not used: as the Compression Streams standard defines it, each chunk written is
// inflated whole and enqueued before a reader can stop it, so one small chunk of a bomb would expand in
// memory past the cap.

import { inflate, inflateInit2 } from "pako/lib/zlib/inflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import { OperationError } from "../../gateway/connector.ts";

const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;
const Z_SYNC_FLUSH = 2;
const MAX_WBITS = 15;
/** The output is gathered in blocks of this size, never past the limit. */
const BLOCK = 64 * 1024;

export function unsupportedEncoding(): OperationError {
	return new OperationError("UNSUPPORTED_CONTENT", "This site sent its page in an encoding Minerva cannot read.");
}

function damaged(): OperationError {
	return new OperationError("UNSUPPORTED_CONTENT", "This site sent a damaged page.");
}

/** The stream is not valid gzip, zlib or DEFLATE. */
class ZlibError extends Error {}

/** One inflate stream (zlib's windowBits: gzip, zlib or raw DEFLATE), fed chunk by chunk. */
class Decompressor {
	readonly #strm = new ZStream();
	/** Where each block is decoded before it is copied out (zlib keeps its own window between calls). */
	readonly #scratch = new Uint8Array(BLOCK);
	/** Input was left unread when the output reached the limit. */
	tail = false;

	constructor(wbits: number) {
		if (inflateInit2(this.#strm, wbits) !== Z_OK) throw new ZlibError(this.#strm.msg);
	}

	/** The decoded bytes of `data`, at most `maxLength` (at least 1) of them. */
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
			// Z_NEED_DICT included: no preset dictionary is given.
			if (status !== Z_OK && status !== Z_BUF_ERROR && status !== Z_STREAM_END) throw new ZlibError(strm.msg);
			if (strm.avail_out !== 0) break;
		}
		// After the end of the stream, what is left is ignored, never decoded.
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
