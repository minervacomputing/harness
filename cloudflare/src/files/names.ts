// Names and types of uploaded files: a browser's file name
// made a valid name at the folder's root, the numbered name an attachment gets when its name is taken,
// and the media type sniffed for display. Names are cut by UTF-16 code unit, but a surrogate pair is never
// split. Categories and NFC come from the runtime's Unicode tables.

import { MAX_EXTENSION_CHARS, MAX_SEGMENT_BYTES } from "./limits.ts";

const ENCODER = new TextEncoder();
// Control and formatting characters, lone surrogates and line and paragraph separators: they could
// disguise an extension (U+202E) or break a line.
const UNWANTED = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function utf8Length(text: string): number {
	return ENCODER.encode(text).length;
}

/**
 * A browser's file name made a valid name: the last segment (after `/` or `\`), without control or formatting characters, in NFC
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

/** The name, or the first of `name (2).ext`, `name (3).ext`, … that is not taken. */
export function numbered(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name;
	const [stem, extension] = split(name);
	for (let n = 2; ; n++) {
		const candidate = fit(stem, extension, ` (${n})`);
		if (!taken.has(candidate)) return candidate;
	}
}

/** The stem and an extension of at most 16 characters with its dot; a leading dot is no extension. */
export function split(name: string): [string, string] {
	const points = Array.from(name);
	const dot = points.lastIndexOf(".");
	if (dot <= 0 || points.length - dot > MAX_EXTENSION_CHARS) return [name, ""];
	return [points.slice(0, dot).join(""), points.slice(dot).join("")];
}

/** stem + suffix + extension, NFC after the join, the stem shortened until it fits 255 bytes. */
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

/** The characters of `text` that fit in its first n UTF-8 bytes. */
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

function startsWith(head: Uint8Array, prefix: readonly number[], at = 0): boolean {
	if (head.length < at + prefix.length) return false;
	return prefix.every((byte, index) => head[at + index] === byte);
}

const bytes = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/**
 * The media type of an upload, for display only (downloads are always application/octet-stream): from
 * the contents, with the name telling apart only kinds of zip and of text. HTML is text/plain.
 */
export function sniff(head: Uint8Array, name: string): string {
	const extension = split(name)[1].toLowerCase();
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

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** No NUL, and UTF-8 once 0 to 3 trailing bytes are dropped (the sample may end inside a character). */
function isText(head: Uint8Array): boolean {
	if (head.includes(0)) return false;
	for (let cut = 0; cut < 4; cut++) {
		try {
			strictUtf8.decode(head.subarray(0, Math.max(0, head.length - cut)));
			return true;
		} catch {
			// Not UTF-8 at this cut.
		}
	}
	return false;
}

/**
 * The upload's name from its query string: exactly one non-empty `name`, else null (the request is refused
 * with "Name the file with ?name=."). `+` is a space; a percent escape that is not UTF-8, or a `%` without
 * two hex digits, refuses the whole query.
 */
export function uploadName(query: string): string | null {
	const names: string[] = [];
	for (const pair of query.split("&")) {
		const equals = pair.indexOf("=");
		const key = formDecoded(equals < 0 ? pair : pair.slice(0, equals));
		const value = formDecoded(equals < 0 ? "" : pair.slice(equals + 1));
		if (key === null || value === null) return null;
		if (key === "name" && value !== "") names.push(value);
	}
	return names.length === 1 ? (names[0] as string) : null;
}

/** A form-encoded key or value decoded, or null when its escapes are malformed or not UTF-8. */
function formDecoded(text: string): string | null {
	try {
		return decodeURIComponent(text.replaceAll("+", " "));
	} catch {
		return null;
	}
}
