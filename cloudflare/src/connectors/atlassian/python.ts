// Python's string semantics that the Atlassian connectors rely on and JavaScript does not share, each
// checked per code point against Python in test/unit/connectors-atlassian.test.ts (vectors from
// test/fixtures/connectors/atlassian/generate.py):
//
// - `re`'s `\w`, `\d` and `\s` are Unicode-aware for str patterns: `\w` is [\p{L}\p{N}_], `\d` is the decimal
//   digits (so "١٢" is an id: lib/digits.ts), and `\s` is `str.isspace()`, which differs from JavaScript's `\s`
//   (U+001C to U+001F are spaces, U+FEFF is not: lib/text.ts).
// - `re.IGNORECASE` matches "i" with "İ" and "ı", which JavaScript's `/iu` does not (it matches "ſ" and the
//   Kelvin sign as Python does): see `IGNORECASE_I`.
// - `str.casefold()` is lib/casefold.ts.
// - `int(text)`, as the Python code calls it. (`urlsplit`, `parse_qs` and `quote` are lib/urlsplit.ts.)
//
// `str.lower()` and `str.upper()` are JavaScript's `toLowerCase()` and `toUpperCase()`: both apply the
// full mappings with Final_Sigma and no language rules, and agree for every code point (Unicode 17 added
// two uppercase mappings Python 3.14's Unicode 16 lacks: U+A7D3 and U+A7D5).
//
// `\w` comes from the runtime's Unicode tables (17 in Node 24), Python's from its own (16 in 3.14), so the
// vectors cover the code points Python has assigned. A character assigned since matches here and not there.
// (The digits and the whitespace are Python's own tables.)

import { DIGIT_CLASS, digitValue } from "../../lib/digits.ts";

/** What `re.IGNORECASE` matches for "i", which `/iu` would not complete: dotted capital and dotless i. */
export const IGNORECASE_I = "[i\\u0130\\u0131]";

/** Python's limit on the digits `int()` converts from text (sys.int_info.default_max_str_digits). */
const MAX_STR_DIGITS = 4300;
const INT_TEXT = new RegExp(`^([+-]?)(${DIGIT_CLASS}+(?:_${DIGIT_CLASS}+)*)$`, "u");

/**
 * `int(value)` of a JSON value: a bool is 0 or 1, a number is cut toward zero, a string is decimal digits
 * in any script with an optional sign, single underscores between digits and spaces around them (Unicode
 * White_Space, without the separators U+001C to U+001F that `str.isspace()` adds). Null when Python would
 * raise (TypeError, ValueError or OverflowError).
 */
export function pythonInt(value: unknown): bigint | null {
	if (typeof value === "boolean") return value ? 1n : 0n;
	if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
	if (typeof value !== "string") return null;
	const match = INT_TEXT.exec(value.trim());
	if (match === null) return null;
	const digits = Array.from((match[2] as string).replaceAll("_", ""));
	if (digits.length > MAX_STR_DIGITS) return null;
	let result = 0n;
	for (const char of digits) result = result * 10n + BigInt(digitValue(char) ?? 0);
	return match[1] === "-" ? -result : result;
}
