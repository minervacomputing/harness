// `re.IGNORECASE` matches "i" with "İ" and "ı", which JavaScript's `/iu` does not (it matches "ſ" and the
// Kelvin sign alike): see `IGNORECASE_I`.

/** What `re.IGNORECASE` matches for "i", which `/iu` would not complete: dotted capital and dotless i. */
export const IGNORECASE_I = "[i\\u0130\\u0131]";
