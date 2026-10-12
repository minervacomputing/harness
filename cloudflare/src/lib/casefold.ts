// Python's `str.casefold()`, which the connectors' searches match names with (their connector.py `discover`)
// and which Linear and Jira match a named write target with. JavaScript has no case folding: `toLowerCase()`
// keeps "ß", "ς" and "ﬁ" as they are, and `toLowerCase()` of "ΑΣ" ends in the final sigma "ς" where Python
// folds to "σ". Full case folding is almost `toLowerCase(toUpperCase(c))` for each code point, which the
// runtime does from its own Unicode tables, so that is what is used, with the few characters where it is not:
//
// - "ß" and "ﬁ" (the full mappings) come out as "ss" and "fi" through the capital ("SS", "FI");
// - every sigma is made "σ" before lowercasing, so no context turns one into "ς";
// - "ı" (dotless i) folds to itself, where its capital "I" would send it to "i";
// - "ẞ" (capital sharp s) folds to "ss", where lowercasing it gives "ß";
// - Cherokee folds to capitals, for stability: the small letters become capitals and capitals stay;
// - the code points Unicode 17 assigned (lib/unicode.ts) stay as they are: Python 3.14, which has Unicode 16,
//   knows no case for them.
//
// test/unit/unicode.test.ts compares this with Python 3.14 for every code point, and several connectors'
// vectors do the same. Lone surrogates, which Python leaves alone, are kept too.

import { UNICODE_17_CLASS } from "./unicode.ts";

/** The characters that are folded one by one, kept by `split`. */
const APART = new RegExp(`([\\u0131\\u1e9e\\u13a0-\\u13fd\\uab70-\\uabbf${UNICODE_17_CLASS}])`, "u");

function foldApart(char: string): string {
	const point = char.codePointAt(0) as number;
	if (point === 0x1e9e) return "ss";
	if ((point >= 0x13a0 && point <= 0x13fd) || (point >= 0xab70 && point <= 0xabbf)) return char.toUpperCase();
	return char;
}

/** `text.casefold()`. */
export function casefold(text: string): string {
	if (!/[^\u0000-\u007f]/.test(text)) return text.toLowerCase();
	return text
		.split(APART)
		.map((part, index) => (index % 2 === 1 ? foldApart(part) : part.toUpperCase().replaceAll("Σ", "σ").toLowerCase()))
		.join("");
}
