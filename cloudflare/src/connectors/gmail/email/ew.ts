// RFC 2047 encoded words as Python's email._encoded_words reads and writes them: `decode` for the header
// parser (parser.ts) and `encode` for the folder (fold.ts), which always writes UTF-8 (or unknown-8bit).

import { utf8 } from "../../../lib/bytes.ts";
import { a2bBase64, b64encode } from "./base64.ts";
import { decode as decodeBytes } from "../../../lib/codecs.ts";
import { BinasciiError, Defect, KeyError, LookupError, UnicodeDecodeError, UnicodeEncodeError, ValueError } from "./errors.ts";

/** `str.encode("ascii", "surrogateescape")`: ASCII, and U+DC80 to U+DCFF as the bytes they escape. */
export function surrogateEscapeBytes(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) bytes[i] = unit;
		else if (unit >= 0xdc80 && unit <= 0xdcff) bytes[i] = unit - 0xdc00;
		else throw new UnicodeEncodeError("'ascii' codec can't encode character");
	}
	return bytes;
}

/** `bytes.decode("ascii", "surrogateescape")`. */
export function asciiSurrogateEscape(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte < 0x80 ? byte : 0xdc00 + byte);
	return text;
}

function decodeQ(encoded: Uint8Array): [Uint8Array, Defect[]] {
	const out: number[] = [];
	const hex = (byte: number) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
	for (let i = 0; i < encoded.length; i++) {
		const byte = encoded[i] as number;
		if (byte === 0x5f) out.push(0x20);
		else if (byte === 0x3d && i + 2 < encoded.length && hex(encoded[i + 1] as number) && hex(encoded[i + 2] as number)) {
			out.push(Number.parseInt(String.fromCharCode(encoded[i + 1] as number, encoded[i + 2] as number), 16));
			i += 2;
		} else out.push(byte);
	}
	return [Uint8Array.from(out), []];
}

function concatPad(encoded: Uint8Array, pad: string): Uint8Array {
	const out = new Uint8Array(encoded.length + pad.length);
	out.set(encoded);
	for (let i = 0; i < pad.length; i++) out[encoded.length + i] = pad.charCodeAt(i);
	return out;
}

function decodeB(encoded: Uint8Array): [Uint8Array, Defect[]] {
	// First try with validate=True, fixing the padding if needed; then without, then with extra padding.
	const padErr = encoded.length % 4;
	const missing = padErr ? "===".slice(0, 4 - padErr) : "";
	try {
		return [a2bBase64(concatPad(encoded, missing), true), padErr ? [new Defect("InvalidBase64PaddingDefect")] : []];
	} catch (error) {
		if (!(error instanceof BinasciiError)) throw error;
	}
	try {
		return [a2bBase64(encoded, false), [new Defect("InvalidBase64CharactersDefect")]];
	} catch (error) {
		if (!(error instanceof BinasciiError)) throw error;
	}
	try {
		return [a2bBase64(concatPad(encoded, "=="), false), [new Defect("InvalidBase64CharactersDefect"), new Defect("InvalidBase64PaddingDefect")]];
	} catch (error) {
		if (!(error instanceof BinasciiError)) throw error;
	}
	// The encoded string's length is 1 more than a multiple of 4; there is no way to decode it.
	return [encoded, [new Defect("InvalidBase64LengthDefect")]];
}

export interface DecodedWord {
	text: string;
	charset: string;
	lang: string;
	defects: Defect[];
}

/** `_encoded_words.decode(ew)`: ValueError for a malformed word, KeyError for an unknown transfer encoding. */
export function decodeEncodedWord(ew: string): DecodedWord {
	const parts = ew.split("?");
	if (parts.length !== 5) throw new ValueError(`not enough values to unpack (expected 5, got ${parts.length})`);
	const [, rawCharset, rawCte, cteString] = parts as [string, string, string, string, string];
	const star = rawCharset.indexOf("*");
	const charset = star < 0 ? rawCharset : rawCharset.slice(0, star);
	const lang = star < 0 ? "" : rawCharset.slice(star + 1);
	const cte = rawCte.toLowerCase();
	// Recover the original bytes and do CTE decoding.
	const bstring = surrogateEscapeBytes(cteString);
	let decoded: [Uint8Array, Defect[]];
	if (cte === "q") decoded = decodeQ(bstring);
	else if (cte === "b") decoded = decodeB(bstring);
	else throw new KeyError(cte);
	const [bytes, defects] = decoded;
	let text: string;
	try {
		text = decodeBytes(bytes, charset);
	} catch (error) {
		if (error instanceof UnicodeDecodeError) {
			defects.push(new Defect("UndecodableBytesDefect", `Encoded word contains bytes not decodable using '${charset}' charset`));
			text = decodeBytes(bytes, charset, "surrogateescape");
		} else if (error instanceof LookupError || error instanceof UnicodeEncodeError) {
			text = asciiSurrogateEscape(bytes);
			if (charset.toLowerCase() !== "unknown-8bit") defects.push(new Defect("CharsetError", `Unknown charset '${charset}' in encoded word; decoded as unknown bytes`));
		} else throw error;
	}
	return { text, charset, lang, defects };
}

const Q_SAFE = new Set([..."-!*+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"].map((char) => char.charCodeAt(0)));

function qByte(byte: number): string {
	if (byte === 0x20) return "_";
	if (Q_SAFE.has(byte)) return String.fromCharCode(byte);
	return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

function lenB(bytes: Uint8Array): number {
	const groups = Math.floor(bytes.length / 3);
	return groups * 4 + (bytes.length % 3 ? 4 : 0);
}

/** `str.encode("utf-8", "surrogateescape")`: lone surrogates U+DC80 to U+DCFF as the bytes they escape. */
function utf8SurrogateEscape(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; ) {
		const unit = text.charCodeAt(i);
		if (unit >= 0xdc80 && unit <= 0xdcff) {
			out.push(unit - 0xdc00);
			i++;
			continue;
		}
		const point = text.codePointAt(i) as number;
		if (point >= 0xd800 && point <= 0xdfff) throw new UnicodeEncodeError("'utf-8' codec can't encode character: surrogates not allowed");
		const char = String.fromCodePoint(point);
		out.push(...utf8(char));
		i += char.length;
	}
	return Uint8Array.from(out);
}

/** `_encoded_words.encode(string, charset)`: the shorter of q and b, q preferred unless b is 5 shorter. */
export function encodeWord(text: string, charset: string): string {
	let bytes: Uint8Array;
	if (charset === "unknown-8bit") bytes = utf8SurrogateEscape(text);
	else if (charset === "utf-8") {
		if (!text.isWellFormed()) throw new UnicodeEncodeError("'utf-8' codec can't encode character: surrogates not allowed");
		bytes = utf8(text);
	} else throw new LookupError(`unsupported charset ${charset}`);
	let qlen = 0;
	for (const byte of bytes) qlen += qByte(byte).length;
	const blen = lenB(bytes);
	const encoding = qlen - blen < 5 ? "q" : "b";
	const encoded = encoding === "q" ? Array.from(bytes, qByte).join("") : b64encode(bytes);
	return `=?${charset}?${encoding}?${encoded}?=`;
}
