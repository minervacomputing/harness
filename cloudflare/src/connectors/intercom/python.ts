// Python's string semantics that Intercom's rules depend on, where JavaScript's differ: the pieces of `re`'s
// Unicode patterns (`\w` and IGNORECASE; `\s` is PYTHON_SPACE_CLASS of lib/text.ts) that html.ts and reads.ts
// are written with.
//
// `\w` is the runtime's letters and numbers without what Unicode 17 assigned, which is Python 3.14's table
// (Unicode 16.0) for every code point (lib/unicode.ts). test/fixtures/connectors/intercom/ pins it and the
// IGNORECASE letters against Python for every code point; casefold is lib/casefold.ts.

import { pythonProperty } from "../../lib/unicode.ts";

// re

/** One character of `re`'s `\w` in a str pattern (needs the `u` flag): `str.isalnum()` characters and the underscore. */
export const RE_WORD_CHAR = pythonProperty("\\p{L}\\p{N}_");

/**
 * `i` under IGNORECASE, for patterns compiled with JavaScript's `iu` flags. `re` matches U+0130 (whose
 * lowercase is `i`) and U+0131 (one of its fixed equivalences) to `i`; JavaScript's simple case folding
 * matches neither. The other two non-ASCII letters `re` matches to ASCII ones, U+017F to `s` and U+212A to
 * `k`, fold to them in JavaScript too.
 */
export const RE_I = "[i\\u0130\\u0131]";
/** What IGNORECASE adds to an ASCII letter class beyond JavaScript's `iu` folding: U+0130 and U+0131. */
export const RE_LETTERS_EXTRA = "\\u0130\\u0131";
