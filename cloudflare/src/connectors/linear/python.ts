// A JSON value as text, and the IGNORECASE pieces the sanitizer's expressions are written with (markdown.ts).

import type { Json } from "../../lib/json.ts";

/** A JSON value as text: a string as it is, anything else as JSON. */
export function strOf(value: Json): string {
	return typeof value === "string" ? value : JSON.stringify(value);
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
