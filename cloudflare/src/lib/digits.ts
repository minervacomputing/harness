// Python 3.14's decimal digits (category Nd, Unicode 16.0.0): which characters `\d` matches in a str pattern and
// `int()` and `float()` read, and what each is worth. They are the runtime's `\p{Nd}` without the ten digits
// Unicode 17 added (U+11DE0 to U+11DE9, lib/unicode.ts), so a character made a digit after Unicode 16 is no
// digit here, as it is none to Python. They are written out as a table because the connectors build their
// patterns from it when they load, and a script cannot list a property's code points without scanning the
// whole code space: the table is ten lines, a scan at every start would cost more. test/unit/unicode.test.ts
// compares it with Python's `\d` and with the runtime's `\p{Nd}` for every code point.

import { hexRanges } from "./unicode.ts";

/** Ranges of the decimal digits (category Nd), in hex; each starts a run of digits 0 to 9. */
const DECIMAL_RANGES =
	"30-39,660-669,6f0-6f9,7c0-7c9,966-96f,9e6-9ef,a66-a6f,ae6-aef,b66-b6f,be6-bef,c66-c6f,ce6-cef,d66-d6f,de6-def," +
	"e50-e59,ed0-ed9,f20-f29,1040-1049,1090-1099,17e0-17e9,1810-1819,1946-194f,19d0-19d9,1a80-1a89,1a90-1a99," +
	"1b50-1b59,1bb0-1bb9,1c40-1c49,1c50-1c59,a620-a629,a8d0-a8d9,a900-a909,a9d0-a9d9,a9f0-a9f9,aa50-aa59,abf0-abf9," +
	"ff10-ff19,104a0-104a9,10d30-10d39,10d40-10d49,11066-1106f,110f0-110f9,11136-1113f,111d0-111d9,112f0-112f9," +
	"11450-11459,114d0-114d9,11650-11659,116c0-116c9,116d0-116e3,11730-11739,118e0-118e9,11950-11959,11bf0-11bf9," +
	"11c50-11c59,11d50-11d59,11da0-11da9,11f50-11f59,16130-16139,16a60-16a69,16ac0-16ac9,16b50-16b59,16d70-16d79," +
	"1ccf0-1ccf9,1d7ce-1d7ff,1e140-1e149,1e2f0-1e2f9,1e4f0-1e4f9,1e5f1-1e5fa,1e950-1e959,1fbf0-1fbf9";

const DECIMALS = hexRanges(DECIMAL_RANGES);

/**
 * Characters `str.isdigit()` accepts that `int()` refuses (superscripts, circled digits and the like; Unicode
 * 16.0.0): digit by `Numeric_Type`, not decimal. test/fixtures/connectors/google/generate.py checks this string
 * against Python's own `isdigit()` and `isdecimal()`.
 */
export const DIGIT_ONLY_RANGES =
	"b2-b3,b9,1369-1371,19da,2070,2074-2079,2080-2089,2460-2468,2474-247c,2488-2490,24ea,24f5-24fd,24ff,2776-277e," +
	"2780-2788,278a-2792,10a40-10a43,10e60-10e68,11052-1105a,1f100-1f10a";

const DIGIT_ONLY = hexRanges(DIGIT_ONLY_RANGES);

/** Whether `str.isdigit()` takes the character although `str.isdecimal()` and `int()` do not. */
export function isDigitOnly(char: string): boolean {
	const point = char.codePointAt(0);
	if (point === undefined || char.length > 2) return false;
	for (const [first, last] of DIGIT_ONLY) if (point >= first && point <= last) return true;
	return false;
}

function classBody(ranges: [number, number, number][]): string {
	return ranges.map(([first, last]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`).join("");
}

/** Python's `\d` in a str pattern, as the body of a character class for a pattern with the `u` flag. */
export const DIGIT_CLASS_BODY: string = classBody(DECIMALS);

/** Python's `\d` in a str pattern, as a character class for a pattern with the `u` flag. */
export const DIGIT_CLASS = `[${DIGIT_CLASS_BODY}]`;

/** What `str.isdigit()` accepts, as the body of a character class (the `u` flag): `\d` and `DIGIT_ONLY_RANGES`. */
export const ISDIGIT_CLASS_BODY: string = DIGIT_CLASS_BODY + classBody(DIGIT_ONLY);

/** Python's `text.isdigit()`: not empty, and every character a decimal digit or one `isdigit()` adds. */
export function pythonIsDigit(text: string): boolean {
	if (text.length === 0) return false;
	for (const char of text) if (digitValue(char) === null && !isDigitOnly(char)) return false;
	return true;
}

/** The value of a decimal digit `\d` matches, as `float()` reads it, or null for anything else. */
export function digitValue(char: string): number | null {
	const point = char.codePointAt(0);
	if (point === undefined || char.length > 2) return null;
	for (const [first, last] of DECIMALS) if (point >= first && point <= last) return (point - first) % 10;
	return null;
}

/** `int(text)` of a string of decimal digits (one a `\d+` pattern matched); a character that is no digit counts as 0. */
export function decimalValue(text: string): number {
	let value = 0;
	for (const char of text) value = value * 10 + (digitValue(char) ?? 0);
	return value;
}
