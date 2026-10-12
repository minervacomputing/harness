// What Python's `re` means by the classes and flags the Notion connector's patterns use, written for
// JavaScript's (always with the `u` flag, so a pattern matches code points, lone surrogates included, as
// Python's does). The patterns are ported from markdown.py, pages.py and properties.py with these in place
// of `\s`, `\w`, `\b`, `\d`, `re.IGNORECASE` and `re.MULTILINE`'s `^`, which JavaScript reads differently:
//
// - `\s` is `str.isspace()`: Unicode White_Space plus U+001C to U+001F; JavaScript's adds U+FEFF and
//   leaves out U+0085 and U+001C to U+001F.
// - `\w` is `str.isalnum()` or "_", which is exactly letters and numbers (categories L and N); JavaScript's
//   is ASCII only, and so is its `\b`.
// - `\d` is any decimal digit (category Nd); JavaScript's is ASCII only.
// - IGNORECASE matches each ASCII letter in either case, "i" also as "İ" (U+0130) and "ı" (U+0131), "k"
//   as the Kelvin sign (U+212A) and "s" as "ſ" (U+017F); JavaScript's `i` without `u` matches neither
//   extra, and with `u` only the last two. The patterns spell the cases out instead of using a flag.
// - MULTILINE's `^` matches only after "\n"; JavaScript's `m` also after "\r", U+2028 and U+2029.
//
// Python 3.14 has Unicode 16 and Node 24 Unicode 17: letters and numbers assigned since differ in `\w`.

import { WORD_CLASS } from "../../lib/text.ts";

/** `\b` before a word character: the previous character is none of `\w` (or there is none). */
export const WORD_START = `(?<![${WORD_CLASS}])`;

/** `\b` after a word character: the next character is none of `\w` (or there is none). */
export const WORD_END = `(?![${WORD_CLASS}])`;

/** MULTILINE's `^`: the start of the text, or right after "\n". */
export const LINE_START = "(?<![^\\n])";

/** Characters IGNORECASE takes as one, beyond a letter's two cases. */
const FOLDED: ReadonlyMap<string, string> = new Map([
	["i", "Ii\\u{130}\\u{131}"],
	["k", "Kk\\u{212a}"],
	["s", "Ss\\u{17f}"],
]);

const SYNTAX = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"]);

/** One character as a pattern with the `u` flag: syntax characters escaped (`-` is not one outside a class). */
export function escapeChar(char: string): string {
	return SYNTAX.has(char) ? `\\${char}` : char;
}

/** The characters `char` matches under IGNORECASE, as a class body, or null for a character without case. */
function caseless(char: string): string | null {
	if (char === "İ" || char === "ı") return FOLDED.get("i") as string;
	if (char === "K") return FOLDED.get("k") as string;
	if (char === "ſ") return FOLDED.get("s") as string;
	if (!/^[A-Za-z]$/.test(char)) return null;
	const lower = char.toLowerCase();
	return FOLDED.get(lower) ?? `${char.toUpperCase()}${lower}`;
}

/** `re.escape(text)` compiled with IGNORECASE, for text of ASCII letters, digits, punctuation and the four folded letters. */
export function ignoreCase(text: string): string {
	let out = "";
	for (const char of text) {
		const folded = caseless(char);
		out += folded === null ? escapeChar(char) : `[${folded}]`;
	}
	return out;
}

/** `[a-z0-9-]` under IGNORECASE, as a class body. */
export const ALNUM_DASH_CASELESS = "A-Za-z0-9\\u{130}\\u{131}\\u{17f}\\u{212a}-";

/** `[0-9a-f]` under IGNORECASE, as a class body: no folded letter is a hex digit. */
export const HEX_CASELESS = "0-9a-fA-F";

/** Python's `text.count(part)` for a non-empty part: occurrences that do not overlap. */
export function countOf(text: string, part: string): number {
	let count = 0;
	for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++;
	return count;
}

/** Python's `text.rfind(part, 0, end)` for a one-character part. */
export function rfindBefore(text: string, part: string, end: number): number {
	return end <= 0 ? -1 : text.lastIndexOf(part, end - 1);
}
