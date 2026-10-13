// Python's string semantics that Linear's rules depend on, where JavaScript's differ: `str()` of a JSON
// value, and the pieces of `re`'s Unicode patterns (`\w`, `\d` and
// IGNORECASE) that the sanitizer's expressions are written with (markdown.ts; `\s` is PYTHON_SPACE_CLASS of
// lib/text.ts).
//
// Category data come from the runtime's Unicode tables, as Python's come from its own (Python 3.14 has
// Unicode 16). (`str.casefold()` is lib/casefold.ts.)

import type { Json } from "../../lib/json.ts";
import { pythonFloat, pythonRepr } from "../../lib/text.ts";

// str()

function reprOf(value: Json): string {
	if (typeof value === "string") return pythonRepr(value);
	return strOf(value);
}

/** Python's `str(value)` of a value `json.loads` returned: "None", "True", reprs inside lists and dicts. */
export function strOf(value: Json): string {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return value;
	// A number too large for a double (1e400) parses as Infinity, which Python's float shows as "inf".
	if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
	if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 2 ** 53 ? String(value) : pythonFloat(value);
	if (Array.isArray(value)) return `[${value.map(reprOf).join(", ")}]`;
	return `{${Object.entries(value)
		.map(([key, item]) => `${pythonRepr(key)}: ${reprOf(item)}`)
		.join(", ")}}`;
}

// re

/**
 * `i` under IGNORECASE, for patterns compiled with JavaScript's `iu` flags. `re` matches U+0130 (whose
 * lowercase is `i`) and U+0131 (one of its fixed equivalences) to `i`; JavaScript's simple case folding
 * matches neither. The other two non-ASCII letters `re` matches to ASCII ones, U+017F to `s` and U+212A
 * to `k`, fold to them in JavaScript too.
 */
export const RE_I = "[i\\u0130\\u0131]";
/** What IGNORECASE adds to an ASCII letter class beyond JavaScript's `iu` folding: U+0130 and U+0131. */
export const RE_LETTERS_EXTRA = "\\u0130\\u0131";
