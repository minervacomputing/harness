// Names and types of uploaded files: a browser's file name
// made a valid name at the folder's root, the numbered name an attachment gets when its name is taken,
// and the media type sniffed for display. Names are cut by UTF-16 code unit, but a surrogate pair is never
// split. Categories and NFC come from the runtime's Unicode tables.

import { fromUtf8Strict } from "../lib/bytes.ts";
import { MAX_EXTENSION_CHARS, MAX_SEGMENT_BYTES } from "./limits.ts";

const ENCODER = new TextEncoder();
// Control and formatting characters, lone surrogates and line and paragraph separators: they could
// disguise an extension (U+202E) or break a line.
const UNWANTED = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function utf8Length(text: string): number {
	return ENCODER.encode(text).length;
}

/**
 * `clean_name(raw)`: the last segment (after `/` or `\`), without control or formatting characters, in NFC
 * and stripped, `file` for nothing, `.` or `..`, and at most 255 UTF-8 bytes with an extension of up to 16
 * characters kept.
 */
export function cleanName(raw: string): string {
	const segments = raw.replaceAll("\\", "/").split("/");
	let name = (segments[segments.length - 1] as string).replace(UNWANTED, "");
	name = name.normalize("NFC").trim();
	if (name === "" || name === "." || name === "..") name = "file";
	const [stem, extension] = split(name);
	return fit(stem, extension);
}

/** `numbered(name, taken)`: the name, or the first of `name (2).ext`, `name (3).ext`, … that is not taken. */
export function numbered(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name;
	const [stem, extension] = split(name);
	for (let n = 2; ; n++) {
		const candidate = fit(stem, extension, ` (${n})`);
		if (!taken.has(candidate)) return candidate;
	}
}

/** `_split(name)`: the stem and an extension of at most 16 characters with its dot; a leading dot is no extension. */
export function split(name: string): [string, string] {
	const points = Array.from(name);
	const dot = points.lastIndexOf(".");
	if (dot <= 0 || points.length - dot > MAX_EXTENSION_CHARS) return [name, ""];
	return [points.slice(0, dot).join(""), points.slice(dot).join("")];
}

/** `_fit(stem, extension, suffix)`: stem + suffix + extension, NFC after the join, the stem shortened until it fits 255 bytes. */
export function fit(stem: string, extension: string, suffix = ""): string {
	// No more characters than the name has bytes, so the loop is short for any name the browser sends.
	let points = Array.from(stem).slice(0, MAX_SEGMENT_BYTES);
	for (;;) {
		const name = (points.join("").trimEnd() + suffix + extension).normalize("NFC");
		if (utf8Length(name) <= MAX_SEGMENT_BYTES && name !== "" && name !== "." && name !== "..") return name;
		if (points.length === 0) {
			// Only the extension is too long, which split prevents; keep what fits, a cut character dropped.
			return firstBytes(name, MAX_SEGMENT_BYTES) || "file";
		}
		points = points.slice(0, -1);
	}
}

/** `name.encode()[:n].decode(errors="ignore")`: the first n bytes, a character cut at the end dropped. */
function firstBytes(text: string, n: number): string {
	let out = "";
	let used = 0;
	for (const char of text) {
		const size = utf8Length(char);
		if (used + size > n) break;
		out += char;
		used += size;
	}
	return out;
}

const ZIP_TYPES: { [extension: string]: string } = {
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt": "application/vnd.oasis.opendocument.text",
	".ods": "application/vnd.oasis.opendocument.spreadsheet",
};
const TEXT_TYPES: { [extension: string]: string } = {
	".csv": "text/csv",
	".json": "application/json",
	".md": "text/markdown",
	".tsv": "text/tab-separated-values",
};

/** `os.path.splitext(name)[1]`: from the last dot, unless the dots before it are all the name has (`.bashrc`). */
function extensionOf(name: string): string {
	const slash = name.lastIndexOf("/");
	const dot = name.lastIndexOf(".");
	if (dot <= slash) return "";
	for (let i = slash + 1; i < dot; i++) if (name[i] !== ".") return name.slice(dot);
	return "";
}

function startsWith(head: Uint8Array, prefix: readonly number[], at = 0): boolean {
	if (head.length < at + prefix.length) return false;
	return prefix.every((byte, index) => head[at + index] === byte);
}

const bytes = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/**
 * `sniff(head, name)` (files 9.3), for display only (downloads are always application/octet-stream): from
 * the contents, with the name telling apart only kinds of zip and of text. HTML is text/plain.
 */
export function sniff(head: Uint8Array, name: string): string {
	const extension = extensionOf(name).toLowerCase();
	if (startsWith(head, bytes("%PDF-"))) return "application/pdf";
	if (startsWith(head, [0x89, ...bytes("PNG\r\n\x1a\n")])) return "image/png";
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(head, bytes("GIF87a")) || startsWith(head, bytes("GIF89a"))) return "image/gif";
	if (startsWith(head, bytes("RIFF")) && startsWith(head, bytes("WEBP"), 8)) return "image/webp";
	if (startsWith(head, bytes("PK\x03\x04"))) return ZIP_TYPES[extension] ?? "application/zip";
	if (startsWith(head, [0x1f, 0x8b])) return "application/gzip";
	if (isText(head)) return TEXT_TYPES[extension] ?? "text/plain";
	return "application/octet-stream";
}

/** `_is_text(head)`: no NUL, and strict UTF-8 once 0 to 3 trailing bytes are dropped (the sample may end inside a character). */
function isText(head: Uint8Array): boolean {
	if (head.includes(0)) return false;
	for (let cut = 0; cut < 4; cut++) {
		// The first `length - cut` bytes; an end below zero counts from the end.
		let end = head.length - cut;
		if (end < 0) end = Math.max(0, head.length + end);
		try {
			fromUtf8Strict(head.subarray(0, end));
			return true;
		} catch {
			// Not UTF-8 at this cut.
		}
	}
	return false;
}

/**
 * The upload's name from its query string (files 9.1, check 6): `parse_qs(query.decode("ascii"),
 * errors="strict").get("name")` must be exactly one value. Pairs are split on `&`, a pair without `=` and a
 * blank value are dropped, `+` is a space, and a percent escape that is not valid UTF-8 refuses the whole
 * query; a `%` without two hex digits stays as it is. Null when the request must be refused with "Name the
 * file with ?name=.". `query` is the URL's search without `?`; the URL parser has already escaped anything
 * that was not ASCII.
 */
export function uploadName(query: string): string | null {
	const names: string[] = [];
	for (const pair of query.split("&")) {
		if (pair === "") continue;
		const equals = pair.indexOf("=");
		if (equals < 0) continue;
		const value = pair.slice(equals + 1);
		if (value === "") continue;
		const key = unquotePlusStrict(pair.slice(0, equals));
		const decoded = unquotePlusStrict(value);
		if (key === null || decoded === null) return null;
		if (key === "name") names.push(decoded);
	}
	return names.length === 1 ? (names[0] as string) : null;
}

/** `unquote_plus(text, errors="strict")`: null where the escaped bytes are not UTF-8. */
function unquotePlusStrict(text: string): string | null {
	const plain = text.replaceAll("+", " ");
	if (!plain.includes("%")) return plain;
	const out: number[] = [];
	for (let i = 0; i < plain.length; ) {
		const pair = plain.slice(i + 1, i + 3);
		if (plain[i] === "%" && /^[0-9a-fA-F]{2}$/.test(pair)) {
			out.push(Number.parseInt(pair, 16));
			i += 3;
		} else {
			for (const byte of ENCODER.encode(plain[i] as string)) out.push(byte);
			i += 1;
		}
	}
	try {
		return fromUtf8Strict(Uint8Array.from(out));
	} catch {
		return null;
	}
}
