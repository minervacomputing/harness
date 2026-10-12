// Python's text codecs as `bytes.decode(name, errors)` and `str.encode(name)` reach them, for the charsets
// mail and web pages name: a part's Content-Type charset, an encoded word's charset (gmail/mime.py,
// email.header, email._encoded_words), a page's charset from its header or its <meta> (web/fetch.py). The name is looked up as CPython does (lowercased, punctuation collapsed to "_",
// `encodings.aliases`, then the module of that name), so whether a charset is known, and so whether
// Minerva falls back to UTF-8, is decided as today.
//
// Exact: every single-byte codec (the tables are Python's own, codec-table.ts), ASCII, Latin-1, charmap,
// UTF-8 (with and without signature), UTF-16 and UTF-32 (with BOM detection, little-endian by default),
// UTF-7, punycode, `undefined`, unicode_escape and raw_unicode_escape, and gb2312, hz, iso2022_kr and johab
// (from Python's GB 2312 and KS X 1001 tables, cjk-table.ts), with the "strict", "replace" and
// "surrogateescape" error handlers. unicode_escape knows no `\N{name}` (every name is unknown).
// Approximate: the other CJK codecs decode with the runtime's TextDecoder, the Encoding Standard's nearest
// decoder (Shift_JIS is Windows-31J there, Big5 includes HKSCS), which accepts some byte sequences Python
// refuses; their "surrogateescape" replaces as "replace" does. Not implemented: IDNA decoding of xn-- labels.

import { GB2312, JOHAB_CHO, JOHAB_CHO_JAMO, JOHAB_JONG, JOHAB_JONG_JAMO, JOHAB_JUNG, JOHAB_JUNG_JAMO, KSX1001 as KSX1001_TABLE } from "./cjk-table.ts";
import { PunycodeError, punycodeDecode } from "./punycode.ts";
import { ALIASES, MODULES, TABLES } from "./codec-table.ts";
import { LookupError, UnicodeDecodeError, UnicodeEncodeError, UnicodeError, ValueError } from "./pyerrors.ts";

export type Errors = "strict" | "replace" | "surrogateescape";

/** CPython's `_Py_normalize_encoding` over the name's UTF-8: ASCII letters and digits lowercased, `.` kept, runs of anything else one `_` between them. */
function normalize(name: string): string {
	let out = "";
	let punct = false;
	for (const byte of new TextEncoder().encode(name)) {
		const alnum = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
		if (alnum || byte === 0x2e) {
			if (punct && out) out += "_";
			punct = false;
			out += String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
		} else {
			punct = true;
		}
	}
	return out;
}

/** The codec a name reaches (`codecs.lookup`), as the kind codec-table.ts gives it; LookupError otherwise. */
export function lookup(name: string): { module: string; kind: string } {
	// An argument that cannot be passed to C: a lone surrogate cannot be UTF-8, NUL ends a C string.
	if (!name.isWellFormed()) throw new UnicodeEncodeError("'utf-8' codec can't encode characters: surrogates not allowed");
	if (name.includes("\u0000")) throw new ValueError("embedded null character");
	const normalized = normalize(name);
	const aliased = (Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : undefined) ?? (Object.hasOwn(ALIASES, normalized.replaceAll(".", "_")) ? ALIASES[normalized.replaceAll(".", "_")] : undefined);
	const modules = aliased ? [aliased, normalized] : [normalized];
	for (const module of modules) {
		if (!module || module.includes(".")) continue;
		const kind = Object.hasOwn(MODULES, module) ? MODULES[module] : undefined;
		// A module that does not exist, or does not import on this platform: the next name is tried.
		if (kind === undefined || kind === "missing") continue;
		if (kind === "module" || kind === "unsupported") break;
		if (kind === "binary") throw new LookupError(`'${name}' is not a text encoding; use codecs.decode() to handle arbitrary codecs`);
		return { module, kind };
	}
	throw new LookupError(`unknown encoding: ${name}`);
}

/** Whether a name is a text codec Python has (and this port decodes). */
export function known(name: string): boolean {
	try {
		lookup(name);
		return true;
	} catch (error) {
		if (error instanceof LookupError) return false;
		throw error;
	}
}

// Decoding.

/** Collects the output of a decoder and applies the error handler to each undecodable range. */
class Output {
	private parts: string[] = [];

	private readonly bytes: Uint8Array;
	private readonly errors: Errors;
	private readonly codec: string;

	constructor(bytes: Uint8Array, errors: Errors, codec: string) {
		this.bytes = bytes;
		this.errors = errors;
		this.codec = codec;
	}

	text(chars: string): void {
		this.parts.push(chars);
	}

	point(point: number): void {
		this.parts.push(String.fromCodePoint(point));
	}

	/**
	 * The error handler for the undecodable range [start, end), as `unicode_decode_call_errorhandler` runs it:
	 * returns where decoding resumes. "replace" writes one U+FFFD and resumes at `end`. "surrogateescape"
	 * turns the range's bytes from 0x80 up into lone surrogates, at most four, and resumes after them; a
	 * range that starts below 0x80 it cannot handle, and the error is raised.
	 */
	error(start: number, end: number, reason: string): number {
		if (this.errors === "replace") {
			this.parts.push("�");
			return end;
		}
		if (this.errors === "surrogateescape") {
			let consumed = 0;
			while (consumed < 4 && consumed < end - start) {
				const byte = this.bytes[start + consumed] as number;
				if (byte < 0x80) break;
				this.parts.push(String.fromCharCode(0xdc00 + byte));
				consumed++;
			}
			if (consumed === 0) throw new UnicodeDecodeError(`'${this.codec}' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`);
			return start + consumed;
		}
		throw new UnicodeDecodeError(`'${this.codec}' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`);
	}

	done(): string {
		return this.parts.join("");
	}
}

function decodeAscii(bytes: Uint8Array, out: Output): void {
	let run = "";
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] as number;
		if (byte < 0x80) {
			run += String.fromCharCode(byte);
			continue;
		}
		out.text(run);
		run = "";
		out.error(i, i + 1, "ordinal not in range(128)");
	}
	out.text(run);
}

function latin1(bytes: Uint8Array): string {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return text;
}

const tableCache = new Map<string, string>();

function table(module: string): string {
	let found = tableCache.get(module);
	if (found === undefined) {
		const packed = TABLES[module] as string;
		found = packed.startsWith("~") && packed.length === 129 ? latin1(Uint8Array.from({ length: 128 }, (_, i) => i)) + packed.slice(1) : packed;
		tableCache.set(module, found);
	}
	return found;
}

function decodeTable(bytes: Uint8Array, out: Output, module: string): void {
	const chars = table(module);
	let run = "";
	for (let i = 0; i < bytes.length; i++) {
		const char = chars[bytes[i] as number] as string;
		if (char !== "￾") {
			run += char;
			continue;
		}
		out.text(run);
		run = "";
		out.error(i, i + 1, "character maps to <undefined>");
	}
	out.text(run);
}

/** CPython's UTF-8 decoder: each maximal invalid subpart is one error, a truncated sequence at the end one more. */
function decodeUtf8(bytes: Uint8Array, out: Output, from = 0): void {
	const n = bytes.length;
	let run: number[] = [];
	const flush = () => {
		if (run.length) out.text(String.fromCodePoint(...run));
		run = [];
	};
	let i = from;
	while (i < n) {
		const lead = bytes[i] as number;
		if (lead < 0x80) {
			run.push(lead);
			i++;
			if (run.length >= 4096) flush();
			continue;
		}
		let need: number;
		let low = 0x80;
		let high = 0xbf;
		if (lead >= 0xc2 && lead <= 0xdf) need = 1;
		else if (lead >= 0xe0 && lead <= 0xef) {
			need = 2;
			if (lead === 0xe0) low = 0xa0;
			if (lead === 0xed) high = 0x9f;
		} else if (lead >= 0xf0 && lead <= 0xf4) {
			need = 3;
			if (lead === 0xf0) low = 0x90;
			if (lead === 0xf4) high = 0x8f;
		} else {
			flush();
			out.error(i, i + 1, "invalid start byte");
			i++;
			continue;
		}
		let point = lead & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
		let j = i + 1;
		let ok = true;
		for (let k = 0; k < need; k++, j++) {
			if (j >= n) {
				flush();
				out.error(i, n, "unexpected end of data");
				return;
			}
			const byte = bytes[j] as number;
			const min = k === 0 ? low : 0x80;
			const max = k === 0 ? high : 0xbf;
			if (byte < min || byte > max) {
				ok = false;
				break;
			}
			point = (point << 6) | (byte & 0x3f);
		}
		if (!ok) {
			flush();
			out.error(i, j, "invalid continuation byte");
			i = j;
			continue;
		}
		run.push(point);
		// The run is spread into fromCodePoint: unbounded, a long run of multibyte characters overflows the stack.
		if (run.length >= 4096) flush();
		i = j;
	}
	flush();
}

function decodeUtf16(bytes: Uint8Array, out: Output, order: "le" | "be" | "detect"): void {
	let q = 0;
	let little = order !== "be";
	if (order === "detect" && bytes.length >= 2) {
		const bom = ((bytes[1] as number) << 8) | (bytes[0] as number);
		if (bom === 0xfeff) {
			q = 2;
			little = true;
		} else if (bom === 0xfffe) {
			q = 2;
			little = false;
		}
	}
	const e = bytes.length;
	const unit = (at: number) => (little ? ((bytes[at + 1] as number) << 8) | (bytes[at] as number) : ((bytes[at] as number) << 8) | (bytes[at + 1] as number));
	let run = "";
	while (true) {
		if (e - q < 2) {
			out.text(run);
			run = "";
			if (q === e) return;
			q = out.error(q, e, "truncated data");
			continue;
		}
		const ch = unit(q);
		q += 2;
		if (ch < 0xd800 || ch > 0xdfff) {
			run += String.fromCharCode(ch);
			continue;
		}
		if (ch >= 0xdc00) {
			out.text(run);
			run = "";
			q = out.error(q - 2, q, "illegal encoding");
			continue;
		}
		if (e - q < 2) {
			out.text(run);
			run = "";
			q = out.error(q - 2, e, "unexpected end of data");
			continue;
		}
		const ch2 = unit(q);
		q += 2;
		if (ch2 < 0xdc00 || ch2 > 0xdfff) {
			out.text(run);
			run = "";
			q = out.error(q - 4, q - 2, "illegal UTF-16 surrogate");
			continue;
		}
		run += String.fromCharCode(ch, ch2);
	}
}

function decodeUtf32(bytes: Uint8Array, out: Output, order: "le" | "be" | "detect"): void {
	let q = 0;
	let little = order !== "be";
	const word = (at: number, le: boolean) =>
		le
			? (((bytes[at + 3] as number) << 24) | ((bytes[at + 2] as number) << 16) | ((bytes[at + 1] as number) << 8) | (bytes[at] as number)) >>> 0
			: (((bytes[at] as number) << 24) | ((bytes[at + 1] as number) << 16) | ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number)) >>> 0;
	if (order === "detect" && bytes.length >= 4) {
		const bom = word(0, true);
		if (bom === 0x0000feff) {
			q = 4;
			little = true;
		} else if (bom === 0xfffe0000) {
			q = 4;
			little = false;
		}
	}
	const e = bytes.length;
	let run: number[] = [];
	const flush = () => {
		if (run.length) out.text(String.fromCodePoint(...run));
		run = [];
	};
	while (true) {
		if (e - q < 4) {
			flush();
			if (q === e) return;
			q = out.error(q, e, "truncated data");
			continue;
		}
		const ch = word(q, little);
		if (ch >= 0xd800 && ch <= 0xdfff) {
			flush();
			q = out.error(q, q + 4, "code point in surrogate code point range(0xd800, 0xe000)");
			continue;
		}
		if (ch > 0x10ffff) {
			flush();
			q = out.error(q, q + 4, "code point not in range(0x110000)");
			continue;
		}
		run.push(ch);
		if (run.length >= 4096) flush();
		q += 4;
	}
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** CPython's `PyUnicode_DecodeUTF7Stateful`, final. */
function decodeUtf7(bytes: Uint8Array, out: Output): void {
	const isBase64 = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;
	const direct = (c: number) => c <= 127 && c !== 0x2b;
	const e = bytes.length;
	let s = 0;
	let inShift = false;
	let bits = 0;
	let buffer = 0;
	let surrogate = 0;
	let startinpos = 0;
	const fail = (start: number, end: number, reason: string) => {
		s = out.error(start, end, reason);
	};
	restart: while (true) {
		while (s < e) {
			const ch = bytes[s] as number;
			if (inShift) {
				if (isBase64(ch)) {
					buffer = buffer * 64 + BASE64.indexOf(String.fromCharCode(ch));
					bits += 6;
					s++;
					if (bits >= 16) {
						const outCh = Math.floor(buffer / 2 ** (bits - 16)) & 0xffff;
						bits -= 16;
						buffer = buffer % 2 ** bits;
						if (surrogate) {
							if (outCh >= 0xdc00 && outCh <= 0xdfff) {
								out.point(0x10000 + ((surrogate - 0xd800) << 10) + (outCh - 0xdc00));
								surrogate = 0;
								continue;
							}
							out.text(String.fromCharCode(surrogate));
							surrogate = 0;
						}
						if (outCh >= 0xd800 && outCh <= 0xdbff) surrogate = outCh;
						else out.text(String.fromCharCode(outCh));
					}
				} else {
					inShift = false;
					if (bits > 0) {
						if (bits >= 6) {
							s++;
							fail(startinpos, s, "partial character in shift sequence");
							continue;
						}
						if (buffer !== 0) {
							s++;
							fail(startinpos, s, "non-zero padding bits in shift sequence");
							continue;
						}
					}
					if (surrogate && direct(ch)) out.text(String.fromCharCode(surrogate));
					surrogate = 0;
					if (ch === 0x2d) s++;
				}
			} else if (ch === 0x2b) {
				startinpos = s;
				s++;
				if (s < e && bytes[s] === 0x2d) {
					s++;
					out.text("+");
				} else if (s < e && !isBase64(bytes[s] as number)) {
					s++;
					fail(startinpos, s, "ill-formed sequence");
				} else {
					inShift = true;
					surrogate = 0;
					bits = 0;
					buffer = 0;
				}
			} else if (direct(ch)) {
				s++;
				out.text(String.fromCharCode(ch));
			} else {
				startinpos = s;
				s++;
				fail(startinpos, s, "unexpected special character");
			}
		}
		if (inShift) {
			inShift = false;
			if (surrogate || bits >= 6 || (bits > 0 && buffer !== 0)) {
				s = out.error(startinpos, e, "unterminated shift sequence");
				continue restart;
			}
		}
		return;
	}
}

/** A hex digit's value, or -1. */
function hexDigit(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return -1;
}

/**
 * CPython's unicode_escape decoder (`_PyUnicode_DecodeUnicodeEscapeInternal2`): bytes are Latin-1, a backslash
 * starts an escape, an unknown escape is kept as written. Each error spans from its backslash to where reading
 * stopped. Deviation: `\N{name}` needs the Unicode name database, which is not here, so every name is
 * unknown ("unknown Unicode character name"), where Python decodes the names it knows.
 */
function decodeUnicodeEscape(bytes: Uint8Array, out: Output): void {
	const end = bytes.length;
	const SIMPLE: { [c: number]: string } = { 0x5c: "\\", 0x27: "'", 0x22: '"', 0x62: "\b", 0x66: "\f", 0x74: "\t", 0x6e: "\n", 0x72: "\r", 0x76: "\v", 0x61: "\u0007" };
	let run: number[] = [];
	const flush = () => {
		for (let i = 0; i < run.length; i += 4096) out.text(String.fromCodePoint(...run.slice(i, i + 4096)));
		run = [];
	};
	let s = 0;
	while (s < end) {
		let c = bytes[s++] as number;
		if (c !== 0x5c) {
			run.push(c);
			continue;
		}
		const start = s - 1;
		let message: string;
		escape: {
			if (s >= end) {
				message = "\\ at end of string";
				break escape;
			}
			c = bytes[s++] as number;
			if (c === 0x0a) continue;
			const simple = SIMPLE[c];
			if (simple !== undefined) {
				run.push(simple.charCodeAt(0));
				continue;
			}
			if (c >= 0x30 && c <= 0x37) {
				let ch = c - 0x30;
				for (let k = 0; k < 2 && s < end && (bytes[s] as number) >= 0x30 && (bytes[s] as number) <= 0x37; k++) ch = (ch << 3) + (bytes[s++] as number) - 0x30;
				run.push(ch);
				continue;
			}
			if (c === 0x78 || c === 0x75 || c === 0x55) {
				let count = c === 0x78 ? 2 : c === 0x75 ? 4 : 8;
				message = c === 0x78 ? "truncated \\xXX escape" : c === 0x75 ? "truncated \\uXXXX escape" : "truncated \\UXXXXXXXX escape";
				let ch = 0;
				for (; count; s++, count--) {
					if (s >= end) break escape;
					const digit = hexDigit(bytes[s] as number);
					if (digit < 0) break escape;
					ch = ch * 16 + digit;
				}
				if (ch > 0x10ffff) {
					message = "illegal Unicode character";
					break escape;
				}
				run.push(ch);
				continue;
			}
			if (c === 0x4e) {
				message = "malformed \\N character escape";
				if (s >= end) break escape;
				if (bytes[s] === 0x7b) {
					const name = ++s;
					while (s < end && bytes[s] !== 0x7d) s++;
					if (s >= end) break escape;
					if (s > name) {
						s++;
						message = "unknown Unicode character name";
					}
				}
				break escape;
			}
			// An unknown escape is kept (Python warns that it is deprecated).
			run.push(0x5c, c);
			continue;
		}
		flush();
		s = out.error(start, s, message);
	}
	flush();
}

/** CPython's raw_unicode_escape decoder: only `\uXXXX` and `\UXXXXXXXX` are escapes; a final backslash is kept. */
function decodeRawUnicodeEscape(bytes: Uint8Array, out: Output): void {
	const end = bytes.length;
	let run: number[] = [];
	const flush = () => {
		for (let i = 0; i < run.length; i += 4096) out.text(String.fromCodePoint(...run.slice(i, i + 4096)));
		run = [];
	};
	let s = 0;
	while (s < end) {
		let c = bytes[s++] as number;
		if (c !== 0x5c || s >= end) {
			run.push(c);
			continue;
		}
		const start = s - 1;
		c = bytes[s++] as number;
		if (c !== 0x75 && c !== 0x55) {
			run.push(0x5c, c);
			continue;
		}
		let count = c === 0x75 ? 4 : 8;
		let message = c === 0x75 ? "truncated \\uXXXX escape" : "truncated \\UXXXXXXXX escape";
		let ch = 0;
		let ok = true;
		for (; count; s++, count--) {
			const digit = s < end ? hexDigit(bytes[s] as number) : -1;
			if (digit < 0) {
				ok = false;
				break;
			}
			ch = ch * 16 + digit;
		}
		if (ok && ch > 0x10ffff) {
			message = "\\Uxxxxxxxx out of range";
			ok = false;
		}
		if (ok) {
			run.push(ch);
			continue;
		}
		flush();
		s = out.error(start, s, message);
	}
	flush();
}

// CPython's CJK codecs (Modules/cjkcodecs) as multibytecodec runs them: an error spans the bytes the codec
// names (one, or a designation's width), "incomplete multibyte sequence" spans the rest of the input, and the
// codec's state (hz's mode, iso2022_kr's designations and shift) carries over errors.

/** A pair in a 94x94 table (bytes counted from the table's first byte), or null. */
function tableChar(packed: string, row: number, column: number): string | null {
	if (row < 0 || row >= 94 || column < 0 || column >= 94) return null;
	const char = packed[row * 94 + column] as string;
	return char === "￾" ? null : char;
}

function decodeGb2312(bytes: Uint8Array, out: Output): void {
	const end = bytes.length;
	let i = 0;
	while (i < end) {
		const c = bytes[i] as number;
		if (c < 0x80) {
			out.text(String.fromCharCode(c));
			i++;
			continue;
		}
		if (i + 1 >= end) {
			i = out.error(i, end, "incomplete multibyte sequence");
			continue;
		}
		const char = tableChar(GB2312, (c ^ 0x80) - 0x21, ((bytes[i + 1] as number) ^ 0x80) - 0x21);
		if (char === null) i = out.error(i, i + 1, "illegal multibyte sequence");
		else {
			out.text(char);
			i += 2;
		}
	}
}

function decodeHz(bytes: Uint8Array, out: Output): void {
	const end = bytes.length;
	let gb = false;
	let i = 0;
	while (i < end) {
		const c = bytes[i] as number;
		if (c === 0x7e) {
			if (i + 1 >= end) {
				i = out.error(i, end, "incomplete multibyte sequence");
				continue;
			}
			const c2 = bytes[i + 1] as number;
			if (c2 === 0x7e && !gb) out.text("~");
			else if (c2 === 0x7b && !gb) gb = true;
			else if (c2 === 0x0a && !gb) {
				// A line continuation.
			} else if (c2 === 0x7d && gb) gb = false;
			else {
				i = out.error(i, i + 1, "illegal multibyte sequence");
				continue;
			}
			i += 2;
			continue;
		}
		if (c & 0x80) {
			i = out.error(i, i + 1, "illegal multibyte sequence");
			continue;
		}
		if (!gb) {
			out.text(String.fromCharCode(c));
			i++;
			continue;
		}
		if (i + 1 >= end) {
			i = out.error(i, end, "incomplete multibyte sequence");
			continue;
		}
		const char = tableChar(GB2312, c - 0x21, (bytes[i + 1] as number) - 0x21);
		if (char === null) i = out.error(i, i + 1, "illegal multibyte sequence");
		else {
			out.text(char);
			i += 2;
		}
	}
}

/** `_codecs_iso2022.c` with iso2022_kr's configuration: KS X 1001 designated to G1 by ESC $ ) C, SO and SI. */
function decodeIso2022Kr(bytes: Uint8Array, out: Output): void {
	const ESC = 0x1b;
	const ASCII = 0x42;
	const KSX1001 = 0x43 | 0x80;
	const escEnd = (c: number) => (c >= 0x41 && c <= 0x5a) || c === 0x40;
	const end = bytes.length;
	const g = [ASCII, ASCII];
	let shifted = false;
	let through = false;
	let i = 0;
	while (i < end) {
		const c = bytes[i] as number;
		if (through) {
			// After an escape that is not ISO 2022's: bytes as Latin-1 up to a final letter.
			out.text(String.fromCharCode(c));
			i++;
			if (escEnd(c)) through = false;
			continue;
		}
		if (c === ESC) {
			if (i + 1 >= end) {
				i = out.error(i, end, "incomplete multibyte sequence");
				continue;
			}
			const c2 = bytes[i + 1] as number;
			if (c2 === 0x28 || c2 === 0x29 || c2 === 0x24 || c2 === 0x2e || c2 === 0x26) {
				// iso2022processesc
				let length = 0;
				let short = false;
				for (let k = 1; k < 16; k++) {
					if (k >= end - i) {
						short = true;
						break;
					}
					if (escEnd(bytes[i + k] as number)) {
						length = k + 1;
						break;
					}
				}
				if (short) {
					i = out.error(i, end, "incomplete multibyte sequence");
					continue;
				}
				if (length === 0) {
					i = out.error(i, i + 1, "illegal multibyte sequence");
					continue;
				}
				let charset: number;
				let designation: number;
				const b2 = bytes[i + 1] as number;
				const b3 = bytes[i + 2] as number;
				if (length === 3) {
					if (b2 === 0x24) {
						charset = b3 | 0x80;
						designation = 0;
					} else {
						charset = b3;
						if (b2 === 0x28) designation = 0;
						else if (b2 === 0x29) designation = 1;
						else {
							i = out.error(i, i + 3, "illegal multibyte sequence");
							continue;
						}
					}
				} else if (length === 4 && b2 === 0x24 && (b3 === 0x28 || b3 === 0x29)) {
					charset = (bytes[i + 3] as number) | 0x80;
					designation = b3 === 0x28 ? 0 : 1;
				} else {
					i = out.error(i, i + length, "illegal multibyte sequence");
					continue;
				}
				if (charset !== ASCII && charset !== KSX1001) {
					i = out.error(i, i + length, "illegal multibyte sequence");
					continue;
				}
				g[designation] = charset;
				i += length;
			} else {
				out.text("\u001b");
				through = true;
				i++;
			}
			continue;
		}
		if (c === 0x0f) {
			shifted = false;
			i++;
			continue;
		}
		if (c === 0x0e) {
			shifted = true;
			i++;
			continue;
		}
		if (c === 0x0a) {
			shifted = false;
			out.text("\n");
			i++;
			continue;
		}
		if (c >= 0x80) {
			i = out.error(i, i + 1, "illegal multibyte sequence");
			continue;
		}
		const charset = shifted ? g[1] : g[0];
		if (c < 0x20 || charset === ASCII) {
			out.text(String.fromCharCode(c));
			i++;
			continue;
		}
		if (i + 1 >= end) {
			i = out.error(i, end, "incomplete multibyte sequence");
			continue;
		}
		const char = tableChar(KSX1001_TABLE, c - 0x21, (bytes[i + 1] as number) - 0x21);
		if (char === null) i = out.error(i, i + 2, "illegal multibyte sequence");
		else {
			out.text(char);
			i += 2;
		}
	}
}

function decodeJohab(bytes: Uint8Array, out: Output): void {
	const end = bytes.length;
	let i = 0;
	while (i < end) {
		const c = bytes[i] as number;
		if (c < 0x80) {
			out.text(String.fromCharCode(c));
			i++;
			continue;
		}
		if (i + 1 >= end) {
			i = out.error(i, end, "incomplete multibyte sequence");
			continue;
		}
		const c2 = bytes[i + 1] as number;
		let point = -1;
		if (c < 0xd8) {
			// Hangul: five bits each for the initial, the medial and the final; a field may be the fill.
			const cho = (c >> 2) & 0x1f;
			const jung = ((c << 3) | (c2 >> 5)) & 0x1f;
			const jong = c2 & 0x1f;
			const [ci, ji, oi] = [JOHAB_CHO[cho] as number, JOHAB_JUNG[jung] as number, JOHAB_JONG[jong] as number];
			if (ci !== -1 && ji !== -1 && oi !== -1) {
				if (ci === -2 && ji === -2) point = oi === -2 ? 0x3000 : (JOHAB_JONG_JAMO[jong] as number);
				else if (ci === -2) point = oi === -2 ? (JOHAB_JUNG_JAMO[jung] as number) : -1;
				else if (ji === -2) point = oi === -2 ? (JOHAB_CHO_JAMO[cho] as number) : -1;
				else point = 0xac00 + ci * 588 + ji * 28 + (oi === -2 ? 0 : oi);
			}
		} else if (!(c === 0xdf || c > 0xf9 || c2 < 0x31 || (c2 >= 0x80 && c2 < 0x91) || (c2 & 0x7f) === 0x7f || (c === 0xda && c2 >= 0xa1 && c2 <= 0xd3))) {
			// KS X 1001 other than Hangul, rearranged.
			let t1 = c < 0xe0 ? 2 * (c - 0xd9) : 2 * c - 0x197;
			let t2 = c2 < 0x91 ? c2 - 0x31 : c2 - 0x43;
			t1 = t1 + (t2 < 0x5e ? 0 : 1) + 0x21;
			t2 = (t2 < 0x5e ? t2 : t2 - 0x5e) + 0x21;
			const char = tableChar(KSX1001_TABLE, (t1 & 0xff) - 0x21, (t2 & 0xff) - 0x21);
			if (char !== null) point = char.charCodeAt(0);
		}
		if (point < 0) i = out.error(i, i + 1, "illegal multibyte sequence");
		else {
			out.text(String.fromCharCode(point));
			i += 2;
		}
	}
}

/** `bytes.decode("punycode", errors)`; errors other than strict and replace are refused as Python refuses them. */
export function decodePunycode(bytes: Uint8Array, errors: Errors): string {
	try {
		return punycodeDecode(bytes, errors);
	} catch (error) {
		if (error instanceof PunycodeError) throw error.unsupported ? new UnicodeError(error.message) : new UnicodeDecodeError(error.message);
		throw error;
	}
}

function decodeWhatwg(bytes: Uint8Array, label: string, errors: Errors): string {
	try {
		return new TextDecoder(label, { fatal: errors === "strict", ignoreBOM: true }).decode(bytes);
	} catch (error) {
		if (error instanceof TypeError) throw new UnicodeDecodeError(`'${label}' codec can't decode bytes`);
		throw error;
	}
}

/** `bytes.decode(name, errors)`: LookupError for an unknown name, UnicodeDecodeError (strict) for undecodable bytes. */
export function decode(bytes: Uint8Array, name: string, errors: Errors = "strict"): string {
	// Empty bytes decode to "" without a codec lookup, whatever the name (`PyUnicode_FromEncodedObject`).
	if (bytes.length === 0) return "";
	const { module, kind } = lookup(name);
	const out = new Output(bytes, errors, module);
	switch (kind) {
		case "ascii":
			decodeAscii(bytes, out);
			break;
		case "latin_1":
		case "charmap":
			return latin1(bytes);
		case "table":
			decodeTable(bytes, out, module);
			break;
		case "utf_8":
			decodeUtf8(bytes, out);
			break;
		case "utf_8_sig":
			decodeUtf8(bytes, out, bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0);
			break;
		case "utf_16":
			decodeUtf16(bytes, out, "detect");
			break;
		case "utf_16_le":
			decodeUtf16(bytes, out, "le");
			break;
		case "utf_16_be":
			decodeUtf16(bytes, out, "be");
			break;
		case "utf_32":
			decodeUtf32(bytes, out, "detect");
			break;
		case "utf_32_le":
			decodeUtf32(bytes, out, "le");
			break;
		case "utf_32_be":
			decodeUtf32(bytes, out, "be");
			break;
		case "utf_7":
			decodeUtf7(bytes, out);
			break;
		case "punycode":
			return decodePunycode(bytes, errors);
		case "unicode_escape":
			decodeUnicodeEscape(bytes, out);
			break;
		case "raw_unicode_escape":
			decodeRawUnicodeEscape(bytes, out);
			break;
		case "gb2312":
			decodeGb2312(bytes, out);
			break;
		case "hz":
			decodeHz(bytes, out);
			break;
		case "iso2022_kr":
			decodeIso2022Kr(bytes, out);
			break;
		case "johab":
			decodeJohab(bytes, out);
			break;
		case "undefined":
			throw new UnicodeError("undefined encoding");
		case "idna": {
			if (errors !== "strict") throw new UnicodeError(`Unsupported error handling: ${errors}`);
			const text = latin1(bytes);
			if (/xn--/i.test(text) || /[^\u0000-\u007f]/.test(text)) throw new UnicodeDecodeError("'idna' codec can't decode bytes");
			return text;
		}
		default:
			if (kind.startsWith("whatwg:")) return decodeWhatwg(bytes, kind.slice("whatwg:".length), errors);
			throw new LookupError(`unknown encoding: ${name}`);
	}
	return out.done();
}

// Encoding.

/** `text.encode("raw-unicode-escape")`: Latin-1 as bytes, every other code point (lone surrogates too) as \\uXXXX or \\UXXXXXXXX. */
export function rawUnicodeEscape(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; ) {
		const point = text.codePointAt(i) as number;
		i += point > 0xffff ? 2 : 1;
		if (point < 0x100) bytes.push(point);
		else {
			const escape = point < 0x10000 ? `\\u${point.toString(16).padStart(4, "0")}` : `\\U${point.toString(16).padStart(8, "0")}`;
			for (const char of escape) bytes.push(char.charCodeAt(0));
		}
	}
	return Uint8Array.from(bytes);
}

const tableSets = new Map<string, Set<number>>();

/** The code points a packed 94x94 table maps to (U+FFFE marks none), built once. */
function tableSet(packed: string): Set<number> {
	let set = tableSets.get(packed);
	if (!set) {
		set = new Set(Array.from(packed, (char) => char.codePointAt(0) as number));
		set.delete(0xfffe);
		tableSets.set(packed, set);
	}
	return set;
}

let jis0208: Set<string> | null = null;

/** The characters JIS X 0208 holds, as the Encoding Standard's EUC-JP decoder reads its two-byte rows. */
function jisChars(): Set<string> {
	if (jis0208 !== null) return jis0208;
	const decoder = new TextDecoder("euc-jp");
	jis0208 = new Set();
	for (let lead = 0xa1; lead <= 0xfe; lead++) {
		for (let trail = 0xa1; trail <= 0xfe; trail++) {
			const char = decoder.decode(Uint8Array.of(lead, trail));
			if (char !== "�" && char.length >= 1) jis0208.add(char);
		}
	}
	return jis0208;
}

/**
 * Whether `text.encode(name)` succeeds (strict): LookupError for an unknown name. Exact for the codecs
 * decoding is exact for (the escape codecs encode anything, lone surrogates included; GB2312 and HZ take
 * ASCII and GB 2312, ISO-2022-KR ASCII and KS X 1001, Johab ASCII, KS X 1001 and every Hangul syllable,
 * though ISO-2022-KR decodes more); ISO-2022-JP takes ASCII, the yen sign, the overline and JIS X 0208;
 * the other CJK codecs are taken to encode what they decode, as text they decoded is all that reaches this.
 */
export function canEncode(text: string, name: string): boolean {
	const { module, kind } = lookup(name);
	const points = Array.from(text, (char) => char.codePointAt(0) as number);
	switch (kind) {
		case "ascii":
			return points.every((point) => point < 0x80);
		case "latin_1":
		case "charmap":
			return points.every((point) => point < 0x100);
		case "table": {
			const chars = new Set(table(module).replaceAll("￾", ""));
			return Array.from(text).every((char) => chars.has(char));
		}
		case "undefined":
			throw new UnicodeError("undefined encoding");
		case "idna":
			return /^[\u0000-\u007f]*$/.test(text);
		case "punycode":
		case "unicode_escape":
		case "raw_unicode_escape":
			return true;
		case "gb2312":
		case "hz": {
			const set = tableSet(GB2312);
			return points.every((point) => point < 0x80 || set.has(point));
		}
		case "iso2022_kr": {
			const set = tableSet(KSX1001_TABLE);
			return points.every((point) => point < 0x80 || set.has(point));
		}
		case "johab": {
			const set = tableSet(KSX1001_TABLE);
			return points.every((point) => point < 0x80 || (point >= 0xac00 && point <= 0xd7a3) || set.has(point));
		}
		default:
			if (kind.startsWith("utf_")) return text.isWellFormed();
			if (kind === "whatwg:iso-2022-jp") {
				const jis = jisChars();
				return Array.from(text).every((char) => char < "\u0080" || char === "¥" || char === "‾" || jis.has(char));
			}
			return text.isWellFormed();
	}
}
