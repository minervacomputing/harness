// The email package's older interfaces that gmail/mime.py uses: `decode_header` and `make_header` (with
// `Header.__str__` and `Charset`) to show a header's value, and the compat32 `Message` methods that read a
// part's Content-Type and Content-Disposition parameters (`get_content_charset`, `get_param`,
// `get_content_disposition`), with `_parseparam`'s quirks and RFC 2231 parameters.

import { pythonIsSpace, pythonLstrip, pythonRstrip, pythonStrip } from "../../../lib/text.ts";
import { a2bBase64 } from "./base64.ts";
import { canEncode, decode, rawUnicodeEscape } from "../../../lib/codecs.ts";
import { concatAll } from "../../../lib/bytes.ts";
import { asciiSurrogateEscape, surrogateEscapeBytes } from "./ew.ts";
import { BinasciiError, CharsetError, HeaderParseError, LookupError, UnicodeEncodeError, UnicodeError } from "./errors.ts";

/** `str.splitlines()`. */
export function pySplitlines(text: string): string[] {
	const lines = text.split(/\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return text === "" ? [] : lines;
}

function bytesOf(text: string): Uint8Array {
	return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

// email.charset

const CHARSET_OUTPUT: Readonly<Record<string, string | null>> = {
	"iso-8859-1": null,
	"iso-8859-2": null,
	"iso-8859-3": null,
	"iso-8859-4": null,
	"iso-8859-9": null,
	"iso-8859-10": null,
	"iso-8859-13": null,
	"iso-8859-14": null,
	"iso-8859-15": null,
	"iso-8859-16": null,
	"windows-1252": null,
	viscii: null,
	"us-ascii": null,
	big5: null,
	gb2312: null,
	"euc-jp": "iso-2022-jp",
	shift_jis: "iso-2022-jp",
	"iso-2022-jp": null,
	"koi8-r": null,
	"utf-8": "utf-8",
};

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
	latin_1: "iso-8859-1",
	"latin-1": "iso-8859-1",
	latin_2: "iso-8859-2",
	"latin-2": "iso-8859-2",
	latin_3: "iso-8859-3",
	"latin-3": "iso-8859-3",
	latin_4: "iso-8859-4",
	"latin-4": "iso-8859-4",
	latin_5: "iso-8859-9",
	"latin-5": "iso-8859-9",
	latin_6: "iso-8859-10",
	"latin-6": "iso-8859-10",
	latin_7: "iso-8859-13",
	"latin-7": "iso-8859-13",
	latin_8: "iso-8859-14",
	"latin-8": "iso-8859-14",
	latin_9: "iso-8859-15",
	"latin-9": "iso-8859-15",
	latin_10: "iso-8859-16",
	"latin-10": "iso-8859-16",
	cp949: "ks_c_5601-1987",
	euc_jp: "euc-jp",
	euc_kr: "euc-kr",
	ascii: "us-ascii",
};

const UNKNOWN8BIT = "unknown-8bit";

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** email.charset.Charset: the codecs a charset name is decoded and checked with. */
export class Charset {
	readonly inputCharset: string;
	readonly outputCharset: string;
	/** null for us-ascii: no conversion. */
	readonly inputCodec: string | null;
	readonly outputCodec: string | null;

	constructor(name = "us-ascii") {
		if (!/^[\u0000-\u007f]*$/.test(name)) throw new CharsetError(name);
		const lowered = name.toLowerCase();
		this.inputCharset = own(CHARSET_ALIASES, lowered) ?? lowered;
		const known = own(CHARSET_OUTPUT, this.inputCharset);
		const conv = known ? known : this.inputCharset;
		this.outputCharset = own(CHARSET_ALIASES, conv) ?? conv;
		this.inputCodec = this.inputCharset === "us-ascii" ? null : this.inputCharset;
		this.outputCodec = this.outputCharset === "us-ascii" ? null : this.outputCharset;
	}

	toString(): string {
		return this.inputCharset.toLowerCase();
	}

	/** `Charset.__eq__`: compares names, so a charset equals the string of its name (and one named "none" equals None). */
	equals(other: Charset | string | null): boolean {
		return this.toString() === String(other === null ? "None" : other).toLowerCase();
	}
}

const USASCII = new Charset("us-ascii");
const UTF8 = new Charset("utf-8");

type CharsetLike = Charset | null;

function same(a: CharsetLike | string, b: CharsetLike | string): boolean {
	if (a instanceof Charset) return a.equals(b as Charset | string | null);
	if (b instanceof Charset) return b.equals(a);
	return a === b;
}

// email.header

/** `ecre`: an encoded word, as decode_header finds it. */
const ECRE_SOURCE = "=\\?([^?]*?)\\?([qQbB])\\?([^\\n]*?)\\?=";

type Word = [text: string | Uint8Array, encoding: string | null, charset: string | null];

/** `email.header.decode_header(header)` for a string. */
export function decodeHeader(header: string): [string | Uint8Array, string | null][] {
	if (!new RegExp(ECRE_SOURCE).test(header)) return [[header, null]];
	const words: Word[] = [];
	for (const line of pySplitlines(header)) {
		// Python pops parts from the front; an index walks them in linear time.
		const parts = line.split(new RegExp(ECRE_SOURCE));
		let at = 0;
		let first = true;
		while (at < parts.length) {
			let unencoded = parts[at++] as string;
			if (first) {
				unencoded = pythonLstrip(unencoded);
				first = false;
			}
			if (unencoded) words.push([unencoded, null, null]);
			if (at < parts.length) {
				const charset = (parts[at++] as string).toLowerCase();
				const encoding = (parts[at++] as string).toLowerCase();
				const encoded = parts[at++] as string;
				words.push([encoded, encoding, charset]);
			}
		}
	}
	// Remove words that consist of whitespace between two encoded strings (filtered once, not spliced).
	const dropped = new Set<number>();
	words.forEach((w, n) => {
		if (n > 1 && w[1] && (words[n - 2] as Word)[1] && pythonIsSpace((words[n - 1] as Word)[0] as string)) dropped.add(n - 1);
	});
	const decoded: [string | Uint8Array, string | null][] = [];
	for (const [encodedString, encoding, charset] of words.filter((_, n) => !dropped.has(n))) {
		const text = encodedString as string;
		if (encoding === null) decoded.push([text, charset]);
		else if (encoding === "q") {
			// quoprimime.header_decode: underscores are spaces, =XX the character of that byte.
			const word = text.replaceAll("_", " ").replace(/=[a-fA-F0-9]{2}/g, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16)));
			decoded.push([word, charset]);
		} else {
			const padErr = Array.from(text).length % 4;
			const padded = padErr ? text + "===".slice(0, 4 - padErr) : text;
			let word: Uint8Array;
			try {
				// base64mime.decode: the text's raw-unicode-escape bytes, read leniently.
				word = padded ? a2bBase64(rawUnicodeEscape(padded), false) : new Uint8Array();
			} catch (error) {
				if (error instanceof BinasciiError) throw new HeaderParseError("Base64 decoding error");
				throw error;
			}
			decoded.push([word, charset]);
		}
	}
	// Now convert all words to bytes and collapse consecutive runs of similarly encoded words (each run
	// joined once at its end, where Python grows it word by word).
	const collapsed: [Uint8Array, string | null][] = [];
	const SPACE = Uint8Array.of(0x20);
	let run: Uint8Array[] = [];
	let lastCharset: string | null = null;
	for (const [raw, charset] of decoded) {
		const word = typeof raw === "string" ? rawUnicodeEscape(raw) : raw;
		if (!run.length) {
			run = [word];
			lastCharset = charset;
		} else if (charset !== lastCharset) {
			collapsed.push([concatAll(run), lastCharset]);
			run = [word];
			lastCharset = charset;
		} else if (lastCharset === null) {
			run.push(SPACE, word);
		} else {
			run.push(word);
		}
	}
	collapsed.push([concatAll(run), lastCharset]);
	return collapsed;
}

/** email.header.Header, as make_header builds it and `str()` reads it. */
export class Header {
	private chunks: [string, CharsetLike][] = [];
	private readonly charset: Charset;

	constructor(text: string | null = null, charset: Charset | null = null) {
		this.charset = charset ?? USASCII;
		if (text !== null) this.append(text, this.charset);
	}

	append(s: string | Uint8Array, given: Charset | null = null): void {
		let charset: Charset = given ?? this.charset;
		let text: string;
		if (typeof s !== "string") {
			// `or`, not `??`: a charset named "" (=?=?q?x?=) has an empty codec, which is falsy.
			const inputCharset = charset.inputCodec || "us-ascii";
			text = inputCharset === UNKNOWN8BIT ? asciiSurrogateEscape(s) : decode(s, inputCharset, "strict");
		} else text = s;
		// Ensure that the bytes we're storing can be decoded to the output character set.
		const outputCharset = charset.outputCodec || "us-ascii";
		if (outputCharset !== UNKNOWN8BIT && !canEncode(text, outputCharset)) {
			if (outputCharset !== "us-ascii") throw new UnicodeEncodeError(`'${outputCharset}' codec can't encode characters`);
			charset = UTF8;
		}
		this.chunks.push([text, charset]);
	}

	private normalize(): void {
		const chunks: [string, CharsetLike][] = [];
		let lastCharset: CharsetLike = null;
		let lastChunk: string[] = [];
		for (const [text, charset] of this.chunks) {
			if (same(charset, lastCharset)) lastChunk.push(text);
			else {
				if (lastCharset !== null) chunks.push([lastChunk.join(" "), lastCharset]);
				lastChunk = [text];
				lastCharset = charset;
			}
		}
		if (lastChunk.length) chunks.push([lastChunk.join(" "), lastCharset]);
		this.chunks = chunks;
	}

	toString(): string {
		this.normalize();
		const nonctext = (char: string) => pythonIsSpace(char) || char === "(" || char === ")" || char === "\\";
		const uchunks: string[] = [];
		let lastcs: CharsetLike | string = null;
		let lastspace = false;
		const plain = (cs: CharsetLike | string) => cs === null || same(cs, "us-ascii");
		for (const [chunk, charset] of this.chunks) {
			let string = chunk;
			let nextcs: CharsetLike | string = charset;
			if (nextcs !== null && same(nextcs, UNKNOWN8BIT)) string = decodeAsciiReplace(surrogateEscapeBytes(string));
			const chars = Array.from(string);
			if (uchunks.length) {
				const hasspace = chars.length > 0 && nonctext(chars[0] as string);
				if (!plain(lastcs)) {
					if (plain(nextcs) && !hasspace) {
						uchunks.push(" ");
						nextcs = null;
					}
				} else if (!plain(nextcs) && !lastspace) uchunks.push(" ");
			}
			lastspace = chars.length > 0 && nonctext(chars[chars.length - 1] as string);
			lastcs = nextcs;
			uchunks.push(string);
		}
		return uchunks.join("");
	}
}

function decodeAsciiReplace(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : "�";
	return text;
}

/** `email.header.make_header(decoded)`. */
export function makeHeader(decoded: [string | Uint8Array, string | null][]): Header {
	const header = new Header();
	for (const [text, charset] of decoded) header.append(text, charset === null ? null : new Charset(charset));
	return header;
}

// compat32 Message parameters.

/** str.find(sub, start, end) with Python's slice rules. */
function find(s: string, sub: string, start: number, end?: number): number {
	const slice = s.slice(start, end);
	const at = slice.indexOf(sub);
	if (at < 0) return -1;
	const base = start < 0 ? Math.max(0, s.length + start) : Math.min(start, s.length);
	return base + at;
}

function count(s: string, sub: string, start: number, end: number): number {
	const slice = s.slice(start, end);
	let n = 0;
	for (let at = slice.indexOf(sub); at >= 0; at = slice.indexOf(sub, at + sub.length)) n++;
	return n;
}

/** `email.message._parseparam`, quirks included. */
export function parseParam(value: string): string[] {
	const s = `;${value}`;
	const plist: string[] = [];
	let start = 0;
	while (find(s, ";", start) === start) {
		start += 1;
		let end = find(s, ";", start);
		let ind = start;
		let diff = 0;
		while (end > 0) {
			diff += count(s, '"', ind, end) - count(s, '\\"', ind, end);
			if (diff % 2 === 0) break;
			[end, ind] = [ind, find(s, ";", end + 1)];
		}
		if (end < 0) end = s.length;
		const i = find(s, "=", start, end);
		const f = i === -1 ? s.slice(start, end) : `${pythonRstrip(s.slice(start, i)).toLowerCase()}=${pythonLstrip(s.slice(i + 1, end))}`;
		plist.push(pythonStrip(f));
		start = end;
	}
	return plist;
}

/** `email.message._splitparam(param)[0]`. */
function splitParamHead(param: string): string {
	const at = param.indexOf(";");
	return pythonStrip(at < 0 ? param : param.slice(0, at));
}

/** `email.utils.unquote`. */
export function unquote(text: string): string {
	if (text.length > 1) {
		if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll("\\\\", "\\").replaceAll('\\"', '"');
		if (text.startsWith("<") && text.endsWith(">")) return text.slice(1, -1);
	}
	return text;
}

/** `email.utils.quote`. */
function quote(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** `urllib.parse.unquote(text, encoding="latin-1")`. */
function unquoteLatin1(text: string): string {
	return text.replace(/[\u0000-\u007f]+/g, (run) => run.replace(/%[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16))));
}

/** An RFC 2231 value: (charset, language, value), charset and language null when it could not be split. */
export type Rfc2231 = [charset: string | null, language: string | null, value: string];
type ParamValue = string | Rfc2231;

const CONTINUATION = /^([A-Za-z0-9_]+)\*(([0-9]+)\*?)?$/;

/** `email.utils.decode_params`. */
function decodeParams(params: [string, string][]): [string, ParamValue][] {
	const out: [string, ParamValue][] = [params[0] as [string, string]];
	const rfc2231 = new Map<string, [number | null, string, boolean][]>();
	for (const [name, raw] of params.slice(1)) {
		const encoded = name.endsWith("*");
		const value = unquote(raw);
		const match = CONTINUATION.exec(name);
		if (match) {
			const key = match[1] as string;
			const num = match[3] === undefined ? null : Number.parseInt(match[3], 10);
			if (!rfc2231.has(key)) rfc2231.set(key, []);
			rfc2231.get(key)?.push([num, value, encoded]);
		} else out.push([name, `"${quote(value)}"`]);
	}
	for (const [name, all] of rfc2231) {
		let continuations = all;
		const hasZero = continuations.some((x) => x[0] === 0);
		if (hasZero) continuations = continuations.filter((x) => x[0] !== null);
		else continuations = continuations.map((x) => [x[0] || 0, x[1], x[2]]);
		continuations = [...continuations].sort((a, b) => (a[0] as number) - (b[0] as number));
		let extended = false;
		const parts: string[] = [];
		for (const [, s, encoded] of continuations) {
			if (encoded) {
				parts.push(unquoteLatin1(s));
				extended = true;
			} else parts.push(s);
		}
		const value = quote(parts.join(""));
		if (extended) {
			const split = value.split("'");
			if (split.length <= 2) out.push([name, [null, null, `"${value}"`]]);
			else out.push([name, [split[0] as string, split[1] as string, `"${split.slice(2).join("'")}"`]]);
		} else out.push([name, `"${value}"`]);
	}
	return out;
}

/** A part's Content-Type and Content-Disposition as a compat32 Message holds them (gmail/mime.py `_content_type`). */
export class ContentHeaders {
	private readonly headers: readonly [name: string, value: string][];

	constructor(headers: readonly [name: string, value: string][]) {
		this.headers = headers;
	}

	/** `Message.get(name)`: the first header of that name, sanitized as compat32 fetches it. */
	get(name: string): string | null {
		const lowered = name.toLowerCase();
		for (const [key, value] of this.headers) {
			if (key.toLowerCase() !== lowered) continue;
			// A value with surrogate-escaped bytes becomes an unknown-8bit Header, whose text replaces them.
			if (!value.isWellFormed()) return new Header(value, new Charset(UNKNOWN8BIT)).toString();
			return value;
		}
		return null;
	}

	has(name: string): boolean {
		const lowered = name.toLowerCase();
		return this.headers.some(([key]) => key.toLowerCase() === lowered);
	}

	private paramsPreserve(header: string): [string, ParamValue][] | null {
		const value = this.get(header);
		if (value === null) return null;
		const params: [string, string][] = parseParam(value).map((p) => {
			const at = p.indexOf("=");
			return at < 0 ? [pythonStrip(p), ""] : [pythonStrip(p.slice(0, at)), pythonStrip(p.slice(at + 1))];
		});
		return decodeParams(params);
	}

	/** `Message.get_param(param, header="content-type")`, unquoted. */
	getParam(param: string, header = "content-type"): ParamValue | null {
		if (!this.has(header)) return null;
		for (const [key, value] of this.paramsPreserve(header) ?? []) {
			if (key.toLowerCase() !== param.toLowerCase()) continue;
			return typeof value === "string" ? unquote(value) : [value[0], value[1], unquote(value[2])];
		}
		return null;
	}

	/** `Message.get_content_charset()`. */
	getContentCharset(): string | null {
		const found = this.getParam("charset");
		if (found === null) return null;
		let charset: string;
		if (typeof found !== "string") {
			// RFC 2231 encoded, so decode it, and it better end up as ascii.
			const pcharset = found[0] || "us-ascii";
			try {
				charset = decode(rawUnicodeEscape(found[2]), pcharset, "strict");
			} catch (error) {
				if (!(error instanceof LookupError || error instanceof UnicodeError)) throw error;
				charset = found[2];
			}
		} else charset = found;
		if (!/^[\u0000-\u007f]*$/.test(charset)) return null;
		return charset.toLowerCase();
	}

	/** `Message.get_content_disposition()`. */
	getContentDisposition(): string | null {
		const value = this.get("content-disposition");
		if (value === null) return null;
		return splitParamHead(value).toLowerCase();
	}
}

export { bytesOf };
