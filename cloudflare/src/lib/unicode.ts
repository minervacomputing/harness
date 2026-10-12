// Which Unicode Minerva follows. Python 3.14 has Unicode 16.0 and the runtime (Node 24, and workerd at our
// compatibility date) has Unicode 17.0. Where Minerva follows Python's rules for text (`str.lower()`,
// `str.casefold()`, `\w` in a str pattern, `repr()`, the labels IDNA accepts), the runtime's own tables
// answer, with the code points Unicode 17 assigned taken out: Python 3.14 leaves them as it leaves any
// unassigned one (no case, no letter, escaped by `repr()`), so every result for text that does not hold them
// is the runtime's, and every result for text that does is Python's.
//
// UNICODE_17 is exactly the code points the runtime assigns and Python 3.14 does not. test/unit/unicode.test.ts
// derives it from Python's unassigned code points (test/fixtures/unicode/generate.py, run on Python 3.14) and
// the runtime's `\p{Cn}`, so it fails when the runtime moves to Unicode 18: its new code points are then in
// neither list. That is the moment to decide whether Python (3.15 has Unicode 17) has moved too.

/** Ranges in a table: `<first>-<last>` (or one code point), `/2` for every other one, in hex. */
export function hexRanges(table: string): [first: number, last: number, step: number][] {
	return table.split(",").map((entry) => {
		const [span = "", step = "1"] = entry.split("/");
		const [first = "", last = first] = span.split("-");
		return [Number.parseInt(first, 16), Number.parseInt(last, 16), Number(step)];
	});
}

/** The 4,803 code points Unicode 17.0 assigned (U+088F, the Garay letters, Extension J and the rest). */
const ADDED =
	"88f,c5c,cdc,1acf-1add,1ae0-1aeb,20c1,2b96,a7ce-a7cf,a7d2,a7d4,a7f1,fbc3-fbd2,fd90-fd91,fdc8-fdce,10940-10959," +
	"10ec5-10ec7,10ed0-10ed8,10efa-10efb,11b60-11b67,11db0-11ddb,11de0-11de9,16ea0-16eb8,16ebb-16ed3,16ff2-16ff6," +
	"187f8-187ff,18d09-18d1e,18d80-18df2,1ccfa-1ccfc,1ceba-1ced0,1cee0-1cef0,1e6c0-1e6de,1e6e0-1e6f5,1e6fe-1e6ff," +
	"1f6d8,1f777-1f77a,1f8d0-1f8d8,1fa54-1fa57,1fa8a,1fa8e,1fac8,1facd,1faea,1faef,1fbfa,2b73a-2b73f,2cea2-2cead," +
	"323b0-33479";

/** `[first, last]` of each run of code points that Unicode 17 assigned and Unicode 16 did not. */
export const UNICODE_17: readonly (readonly [first: number, last: number])[] = hexRanges(ADDED).map(([first, last]) => [first, last]);

function unit(point: number): string {
	return `\\u{${point.toString(16)}}`;
}

/** UNICODE_17 as the body of a character class for a pattern with the `u` flag. */
export const UNICODE_17_CLASS: string = UNICODE_17.map(([first, last]) => (first === last ? unit(first) : `${unit(first)}-${unit(last)}`)).join("");

/** Whether Unicode 17 assigned the code point (and Python 3.14 knows nothing of it). */
export function isUnicode17(point: number): boolean {
	let low = 0;
	let high = UNICODE_17.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const [first, last] = UNICODE_17[middle] as readonly [number, number];
		if (point < first) high = middle - 1;
		else if (point > last) low = middle + 1;
		else return true;
	}
	return false;
}

/**
 * A pattern that matches one character that `property` (a character class body for the `u` flag, such as
 * `\p{L}\p{N}_`) matches in Python 3.14's Unicode: the runtime's property without UNICODE_17.
 */
export function pythonProperty(property: string): string {
	return `(?:(?![${UNICODE_17_CLASS}])[${property}])`;
}

/** Matches one code point of UNICODE_17 and keeps it when used to split a string. */
export const UNICODE_17_SPLIT = new RegExp(`([${UNICODE_17_CLASS}])`, "u");
