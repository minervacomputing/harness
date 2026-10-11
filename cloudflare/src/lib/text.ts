// The text helpers of backend/connectors/text.py, with Python's semantics: input validators, cutting
// long text by code point, and undoing the encodings a browser or renderer undoes in an address. Also
// Python's `urllib.parse.unquote` and `html.unescape`, which `decoded` is built from.
//
// NFKC and the Cf category come from the runtime's Unicode tables, as Python's come from its own: Python
// 3.14 has Unicode 16, and V8 may be newer. Characters assigned since then (rare in addresses) can decode
// differently; the vectors in test/fixtures pin the cases the connectors rely on.

import { fromUtf8 } from "./bytes.ts";
import { DROPPED, NAMED, REPLACED } from "./html-entities.ts";

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

/** Characters (code points) in a string, as Python's `len()` counts them. */
export function codePointLength(text: string): number {
	let length = 0;
	for (const _ of text) length++;
	return length;
}

/** `text[start:end]` in code points, as Python slices. A surrogate pair is never split. */
export function sliceCodePoints(text: string, start: number, end?: number): string {
	return Array.from(text).slice(start, end).join("");
}

/** The text cut to `limit` characters, and whether it was cut. Callers expose `<field>_truncated`. */
export function truncate(value: string, limit: number): [string, boolean];
export function truncate(value: string | null | undefined, limit: number): [string | null, boolean];
export function truncate(value: string | null | undefined, limit: number): [string | null, boolean] {
	if (value === null || value === undefined) return [null, false];
	if (value.length <= limit) return [value, false];
	const points = Array.from(value);
	if (points.length <= limit) return [value, false];
	return [points.slice(0, limit).join(""), true];
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
 * Python's `urllib.parse.unquote(text)`: runs of ASCII have their `%XX` escapes turned into bytes and
 * decoded as UTF-8 with U+FFFD for invalid sequences; other characters pass through, and a `%` without
 * two hex digits stays as it is.
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

/** Python's `html.unescape(text)`: named and numeric character references, with HTML5's rules. */
export function htmlUnescape(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(CHARREF, (_, reference: string) => {
		if (reference[0] === "#") {
			const hex = reference[1] === "x" || reference[1] === "X";
			const digits = reference.slice(hex ? 2 : 1).replace(/;$/, "");
			const point = Number.parseInt(digits, hex ? 16 : 10);
			const replaced = REPLACED.get(point);
			if (replaced !== undefined) return replaced;
			if ((point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff) return "\ufffd";
			if (DROPPED.has(point)) return "";
			return String.fromCodePoint(point);
		}
		const named = entity(reference);
		if (named !== undefined) return named;
		// The longest name that starts the reference, as the standard defines for names without `;`.
		const points = Array.from(reference);
		for (let length = points.length - 1; length > 1; length--) {
			const prefix = points.slice(0, length).join("");
			const value = entity(prefix);
			if (value !== undefined) return value + points.slice(length).join("");
		}
		return `&${reference}`;
	});
}

function entity(name: string): string | undefined {
	return Object.hasOwn(NAMED, name) ? NAMED[name] : undefined;
}
