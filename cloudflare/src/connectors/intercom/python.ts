// The pieces of Intercom's patterns (html.ts and reads.ts) that JavaScript's flags do not give.

/** One letter, number or underscore (needs the `u` flag). */
export const RE_WORD_CHAR = "[\\p{L}\\p{N}_]";

/**
 * `i` under IGNORECASE, for patterns compiled with JavaScript's `iu` flags. `re` matches U+0130 (whose
 * lowercase is `i`) and U+0131 (one of its fixed equivalences) to `i`; JavaScript's simple case folding
 * matches neither. The other two non-ASCII letters `re` matches to ASCII ones, U+017F to `s` and U+212A to
 * `k`, fold to them in JavaScript too.
 */
export const RE_I = "[i\\u0130\\u0131]";
/** What IGNORECASE adds to an ASCII letter class beyond JavaScript's `iu` folding: U+0130 and U+0131. */
export const RE_LETTERS_EXTRA = "\\u0130\\u0131";
