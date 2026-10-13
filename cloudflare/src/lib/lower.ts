// Python's `str.lower()`, as Python 3.14 has it (Unicode 16.0): the runtime's `toLowerCase()`, which maps
// characters as Python does, including the final sigma ("ς" ends a word, as in "ΟΔΟΣ"), with two differences
// between the runtime's Unicode 17.0 and Python's 16.0 made up (lib/unicode.ts):
//
// - The code points Unicode 17 assigned are, to Python 3.14, unassigned: no case, and neither a letter nor a
//   mark that the final-sigma rule looks through. The text is lowercased in the runs between them.
// - U+0295 became a plain letter in Unicode 17 and is no longer Cased, so a capital sigma next to it would
//   come out the other way. A run beside one is lowercased with a cased stand-in ("a") on that side, which
//   puts the rule in the same position as with the letter.
//
// `str.casefold()` is lib/casefold.ts.

import { UNICODE_17_CLASS } from "./unicode.ts";

const SPLIT = new RegExp(`([\\u0295${UNICODE_17_CLASS}])`, "u");
const CASED_BEFORE_17 = "ʕ";
const STAND_IN = "a";

/** Python's `text.lower()`. */
export function pythonLower(text: string): string {
	const parts = text.split(SPLIT);
	if (parts.length === 1) return text.toLowerCase();
	return parts
		.map((part, index) => {
			if (index % 2 === 1) return part;
			const before = parts[index - 1] === CASED_BEFORE_17;
			const after = parts[index + 1] === CASED_BEFORE_17;
			if (!before && !after) return part.toLowerCase();
			const lowered = ((before ? STAND_IN : "") + part + (after ? STAND_IN : "")).toLowerCase();
			return lowered.slice(before ? 1 : 0, after ? -1 : undefined);
		})
		.join("");
}
