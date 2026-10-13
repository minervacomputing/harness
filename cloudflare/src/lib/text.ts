// Text helpers, with Python's semantics: input validators, cutting
// long text by code point, and undoing the encodings a browser or renderer undoes in an address. Also
// Python's `urllib.parse.unquote` and `html.unescape`, which `decoded` is built from.
//
// NFKC and the Cf category come from the runtime's Unicode tables, as Python's come from its own: Python
// 3.14 has Unicode 16, and V8 may be newer. Characters assigned since then (rare in addresses) can decode
// differently; the vectors in test/fixtures pin the cases the connectors rely on.

import { decodeHTML, replaceCodePoint } from "entities/decode";
import { fromUtf8 } from "./bytes.ts";
import { isUnicode17 } from "./unicode.ts";

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

/**
 * Python's `html.unescape(text)`: named and numeric character references, with HTML5's rules.
 *
 * Names are the `entities` package's: the standard's table, which is what Python's `html.entities.html5`
 * holds (test/unit/text.test.ts pins both to one digest), with the standard's rule for a name without ";"
 * (the longest name that starts the reference). Numeric references are Python's, which differ from the
 * standard's in what they drop: the `entities` package keeps those code points, so they are handled here.
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

/**
 * Python's `str.isspace()` set, which `str.strip()` removes: Unicode White_Space and the information
 * separators U+001C to U+001F.
 */
export const PYTHON_WHITESPACE: readonly number[] = [
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
	0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

const PYTHON_SPACE = new Set(PYTHON_WHITESPACE);

/** `PYTHON_WHITESPACE` as the body of a regular expression's character class (`\s` in a Python str pattern). */
export const PYTHON_SPACE_CLASS: string = PYTHON_WHITESPACE.map((point) => `\\u${point.toString(16).padStart(4, "0")}`).join("");

/**
 * `re`'s `\w` in a str pattern, as the body of a character class (the `u` flag): letters, numbers and the
 * underscore. The runtime's Unicode tables (17 in Node 24) stand for Python's (16 in 3.14), so a character
 * assigned since differs, and only those (test/unit/unicode.test.ts). Intercom's pattern leaves them out
 * (`pythonProperty` of lib/unicode.ts, in connectors/intercom/python.ts); a class body cannot.
 */
export const WORD_CLASS = "\\p{L}\\p{N}_";

/** Whether a UTF-16 code unit is one of `PYTHON_WHITESPACE` (all of them are one unit; a surrogate never is). */
export function isPythonSpace(unit: number): boolean {
	return PYTHON_SPACE.has(unit);
}

/** Python's `text.split()` without arguments: runs of whitespace separate, and empty parts are dropped. */
export function pythonSplit(text: string): string[] {
	const parts: string[] = [];
	let part = "";
	for (let i = 0; i < text.length; i++) {
		if (PYTHON_SPACE.has(text.charCodeAt(i))) {
			if (part) parts.push(part);
			part = "";
		} else part += text[i];
	}
	if (part) parts.push(part);
	return parts;
}

/** `" ".join(text.split())`: runs of Python's whitespace become one space, none at either end. */
export function pythonCollapse(text: string): string {
	return pythonSplit(text).join(" ");
}

/** Python's `text.lstrip()` without arguments. */
export function pythonLstrip(text: string): string {
	let start = 0;
	while (start < text.length && PYTHON_SPACE.has(text.charCodeAt(start))) start++;
	return start === 0 ? text : text.slice(start);
}

/** Python's `text.rstrip()` without arguments. */
export function pythonRstrip(text: string): string {
	let end = text.length;
	while (end > 0 && PYTHON_SPACE.has(text.charCodeAt(end - 1))) end--;
	return end === text.length ? text : text.slice(0, end);
}

/** Python's `text.strip()` without arguments. */
export function pythonStrip(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && PYTHON_SPACE.has(text.charCodeAt(start))) start++;
	while (end > start && PYTHON_SPACE.has(text.charCodeAt(end - 1))) end--;
	return start === 0 && end === text.length ? text : text.slice(start, end);
}

/** Python's `text.isspace()`: not empty, and only whitespace. */
export function pythonIsSpace(text: string): boolean {
	if (text.length === 0) return false;
	for (let i = 0; i < text.length; i++) if (!PYTHON_SPACE.has(text.charCodeAt(i))) return false;
	return true;
}

/**
 * Python's `repr(float)`: the shortest digits that read back as the same double (JavaScript finds the same
 * ones), in fixed notation when the decimal exponent is in [-4, 16), else as `d.ddde±XX`.
 */
export function pythonFloat(value: number): string {
	if (!Number.isFinite(value)) throw new TypeError(`${value} is not a finite number.`);
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const sign = value < 0 ? "-" : "";
	const [mantissa = "", exponent = "0"] = Math.abs(value).toExponential().split("e");
	const digits = mantissa.replace(".", "");
	const point = Number(exponent) + 1; // digits are 0.d1d2... × 10^point
	if (point <= -4 || point > 16) {
		const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
		const power = point - 1;
		return `${sign}${digits[0]}${fraction}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
	}
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// What `str.isprintable()` refuses: categories Other and Separator, except the ASCII space.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * Python's `repr(text)`, as `f"{value!r}"` writes a string into a message: single quotes, or double ones
 * when the text has a single quote and no double quote; backslash escapes for the quote, backslash, tab,
 * newline and carriage return; `\xhh`, `\uhhhh` or `\Uhhhhhhhh` for other characters that are not
 * printable. Printability comes from the runtime's Unicode tables, except that the code points Unicode 17
 * assigned (lib/unicode.ts) are unprintable, as they are to Python 3.14, whose Unicode is 16.
 */
export function pythonRepr(text: string): string {
	const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
	let out = quote;
	for (const char of text) {
		const point = char.codePointAt(0) as number;
		if (char === quote || char === "\\") out += `\\${char}`;
		else if (char === "\t") out += "\\t";
		else if (char === "\n") out += "\\n";
		else if (char === "\r") out += "\\r";
		else if (point < 0x20 || point === 0x7f) out += `\\x${hex(point, 2)}`;
		else if (point < 0x7f || !(UNPRINTABLE.test(char) || isUnicode17(point))) out += char;
		else if (point < 0x100) out += `\\x${hex(point, 2)}`;
		else if (point < 0x10000) out += `\\u${hex(point, 4)}`;
		else out += `\\U${hex(point, 8)}`;
	}
	return out + quote;
}

function hex(point: number, digits: number): string {
	return point.toString(16).padStart(digits, "0");
}
