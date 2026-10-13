// Text helpers: input validators, cutting long text without splitting a character, and undoing the
// encodings a browser or renderer undoes in an address (percent escapes, character references, NFKC).

import { decodeHTML, replaceCodePoint } from "entities/decode";
import { fromUtf8 } from "./bytes.ts";

/** What a validator throws; its message becomes the validation error's. */
export class TextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TextError";
	}
}

export const SINGLE_LINE = "must be a single line without control characters";
export const PLAIN_TEXT = "must not contain control characters other than tabs and newlines";

/** Refuses every C0 control character, tab and newlines included, and DEL. For names, titles, paths and queries. */
export function isSingleLine(value: string): boolean {
	return !/[\u0000-\u001f\u007f]/.test(value);
}

/** Refuses C0 control characters and DEL, except tab, LF and CR. For bodies, messages and markdown. */
export function isPlainText(value: string): boolean {
	return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function singleLine(value: string): string {
	if (!isSingleLine(value)) throw new TextError(SINGLE_LINE);
	return value;
}

export function plainText(value: string): string {
	if (!isPlainText(value)) throw new TextError(PLAIN_TEXT);
	return value;
}

/**
 * `text.slice(start, end)`, with either end moved back by one where it would fall between the two halves of a
 * surrogate pair, so a cut never leaves half a character. Offsets count UTF-16 units, as `length` does.
 */
export function sliceText(text: string, start: number, end: number = text.length): string {
	return text.slice(pairStart(text, start), pairStart(text, end));
}

function pairStart(text: string, at: number): number {
	if (at <= 0 || at >= text.length) return at;
	const before = text.charCodeAt(at - 1);
	const after = text.charCodeAt(at);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? at - 1 : at;
}

/**
 * UTF-16 units per part of a long text kept in SQLite: at most 1.5 MB of UTF-8, under the 2 MB a Durable
 * Object's string, BLOB or row may have (local workerd does not enforce it).
 */
export const VALUE_PART = 500_000;

/** `text` in parts of at most `size` UTF-16 units, never between the two halves of a surrogate pair. */
export function splitParts(text: string, size: number): string[] {
	if (size < 2) throw new RangeError("A part holds at least two units.");
	const parts: string[] = [];
	for (let at = 0; at < text.length; ) {
		let end = Math.min(at + size, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		parts.push(text.slice(at, end));
		at = end;
	}
	return parts;
}

/** The text cut to `limit` UTF-16 units (`sliceText`), and whether it was cut. Callers expose `<field>_truncated`. */
export function truncate(value: string, limit: number): [string, boolean];
export function truncate(value: string | null | undefined, limit: number): [string | null, boolean];
export function truncate(value: string | null | undefined, limit: number): [string | null, boolean] {
	if (value === null || value === undefined) return [null, false];
	if (value.length <= limit) return [value, false];
	return [sliceText(value, 0, limit), true];
}

/** The text with the encodings a browser or renderer undoes in an address, undone, three times over. */
export function decoded(text: string): string {
	for (let round = 0; round < 3; round++) {
		text = htmlUnescape(unquote(text)).normalize("NFKC");
		text = text.replace(/\p{Cf}/gu, "");
		text = text.replace(/[\u3002\uff0e\uff61]/g, ".").replaceAll("\\", "");
	}
	return text;
}

/**
 * One URL path segment: everything but ASCII letters, digits and `-._~` (RFC 3986's unreserved characters)
 * percent-encoded as UTF-8, so an id holding `/`, `?`, `#` or a quote stays one segment of the path.
 */
export function segment(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Percent escapes undone: runs of ASCII have their `%XX` escapes turned into bytes and decoded as UTF-8 with
 * U+FFFD for invalid sequences; other characters pass through, and a `%` without two hex digits stays as it
 * is. Unlike `decodeURIComponent`, it never throws.
 */
export function unquote(text: string): string {
	if (!text.includes("%")) return text;
	return text.replace(/[\u0000-\u007f]+/g, (run) => {
		if (!run.includes("%")) return run;
		const bytes: number[] = [];
		for (let i = 0; i < run.length; ) {
			const pair = run.slice(i + 1, i + 3);
			if (run[i] === "%" && /^[0-9a-fA-F]{2}$/.test(pair)) {
				bytes.push(Number.parseInt(pair, 16));
				i += 3;
			} else {
				bytes.push(run.charCodeAt(i));
				i += 1;
			}
		}
		return fromUtf8(Uint8Array.from(bytes));
	});
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/**
 * Named and numeric character references undone, with HTML5's rules: names are the `entities` package's
 * table, with the standard's rule for a name without ";" (the longest name that starts the reference).
 * Numeric references to most C0 controls, DEL and the noncharacters become nothing, which the package
 * would keep.
 */
export function htmlUnescape(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(CHARREF, (whole, reference: string) => {
		if (reference[0] !== "#") return decodeHTML(whole);
		const hex = reference[1] === "x" || reference[1] === "X";
		const point = Number.parseInt(reference.slice(hex ? 2 : 1).replace(/;$/, ""), hex ? 16 : 10);
		// NUL, the surrogates and what is beyond Unicode become U+FFFD, and U+0080 to U+009F their Windows-1252 letters.
		const replaced = replaceCodePoint(point);
		return replaced === point && isDropped(point) ? "" : String.fromCodePoint(replaced);
	});
}

/** The code points a numeric reference makes into nothing: most C0 controls, DEL, and the noncharacters. */
function isDropped(point: number): boolean {
	return (
		(point >= 0x1 && point <= 0x8) ||
		point === 0xb ||
		(point >= 0xe && point <= 0x1f) ||
		point === 0x7f ||
		(point >= 0xfdd0 && point <= 0xfdef) ||
		(point & 0xfffe) === 0xfffe
	);
}

/** Letters, numbers and the underscore, as the body of a character class for a pattern with the `u` flag. */
export const WORD_CLASS = "\\p{L}\\p{N}_";

/**
 * Runs of text between whitespace, to look for addresses word by word. U+FEFF, which `\s` counts as
 * whitespace, is invisible and stays inside a word, so it cannot split a host name into harmless parts.
 */
export const WORDS = /(?:\S|\uFEFF)+/gu;
