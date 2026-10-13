// Domain names in ASCII, for mail domains and site names (sites.ts `canonicalHost`). The runtime's WHATWG
// domain to ASCII (`node:url`, UTS #46 mapping without the STD3 rules, non-transitional, then Punycode) maps
// and encodes. On each label it gives, the rules of IDNA 2008 that UTS #46 leaves out are checked here, as
// the backend's idna package checks them (`idna.encode(text, uts46=True)`):
//
// - every code point PVALID, derived from the runtime's Unicode properties as RFC 5892 derives it, or valid
//   in its CONTEXTO context (RFC 5892 appendix A, with the runtime's scripts);
// - the Bidi rule (RFC 5893) for a label that holds a right-to-left character;
// - no hyphens in the third and fourth places, none first or last, no combining mark first, NFC;
// - an A-label in the input is the canonical Punycode of a valid U-label;
// - labels of at most 63 and names of at most 253 characters.
//
// Checked against the port of the idna package this replaced, for every code point alone, between letters,
// between "l"s and inside a right-to-left label, in Node and in workerd (both Unicode 17), and on a million
// random names: nothing it refused is accepted, and what both accept is encoded alike. What is refused now:
// - U+200C ZERO WIDTH NON-JOINER where only its second CONTEXTJ rule would allow it (between letters that
//   join, as in Persian): that rule needs joining types the runtime does not expose. After a virama, the
//   rule both joiners share, it is allowed as before;
// - in a label with a right-to-left character, the few neutral letters (Bidi class ON, such as U+02B9),
//   which count as left-to-right here;
// - 64 code points Unicode 18 adds that the port's newer tables accepted, which the runtime does not know;
// - what the runtime refuses itself: a last label that is a number (an IPv4 address to it; sites.ts refuses
//   these anyway), some recent right-to-left letters, marks and digits inside right-to-left labels (Arabic
//   Extended-B, Garay and others its IDNA tables lack), and A-labels whose Punycode holds "xn--".

import { domainToASCII, domainToUnicode } from "node:url";

/** Python's IDNAError, a UnicodeError: the text cannot be encoded. */
export class IdnaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IDNAError";
	}
}

const MAX_INPUT = 1024;
const MAX_LABEL = 63;
const MAX_DOMAIN = 253;
const PREFIX = "xn--";

/** ASCII the name may hold; the rest is never valid, and would end the host for `domainToASCII` (`/`, `:`, `@`). */
const ASCII_ALLOWED = /^[A-Za-z0-9.-]$/;

function points(text: string): number[] {
	return Array.from(text, (char) => char.codePointAt(0) as number);
}

function inRange(point: number, low: number, high: number): boolean {
	return point >= low && point <= high;
}

// RFC 5892 section 2: the categories that derive each code point's IDNA 2008 property.

/** 2.6 Exceptions: PVALID, CONTEXTO or DISALLOWED whatever their properties say. */
const EXCEPTIONS_PVALID: ReadonlySet<number> = new Set([0x00df, 0x03c2, 0x06fd, 0x06fe, 0x0f0b, 0x3007]);
const EXCEPTIONS_DISALLOWED: ReadonlySet<number> = new Set([0x0640, 0x07fa, 0x302e, 0x302f, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b]);
function isContexto(point: number): boolean {
	return point === 0x00b7 || point === 0x0375 || point === 0x05f3 || point === 0x05f4 || point === 0x30fb || isArabicIndic(point) || isExtendedArabicIndic(point);
}
/** 2.3 Unstable (NFKC_Casefold changes it), 2.4 IgnorableProperties. */
const UNSTABLE_OR_IGNORABLE = /[\p{Changes_When_NFKC_Casefolded}\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Noncharacter_Code_Point}]/u;
/** 2.1 LetterDigits. */
const LETTER_DIGITS = /[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]/u;
const ASSIGNED = /\p{Assigned}/u;

function isArabicIndic(point: number): boolean {
	return inRange(point, 0x0660, 0x0669);
}

function isExtendedArabicIndic(point: number): boolean {
	return inRange(point, 0x06f0, 0x06f9);
}

/** 2.5 IgnorableBlocks and 2.9 OldHangulJamo. */
function inDisallowedBlock(point: number): boolean {
	return (
		inRange(point, 0x20d0, 0x20ff) ||
		inRange(point, 0x1d100, 0x1d24f) ||
		inRange(point, 0x1100, 0x11ff) ||
		inRange(point, 0xa960, 0xa97f) ||
		inRange(point, 0xd7b0, 0xd7ff)
	);
}

type Property = "PVALID" | "CONTEXTJ" | "CONTEXTO" | "DISALLOWED";

/** RFC 5892 section 3, in its order (BackwardCompatible is empty). */
function property(point: number): Property {
	if (EXCEPTIONS_PVALID.has(point)) return "PVALID";
	if (isContexto(point)) return "CONTEXTO";
	if (EXCEPTIONS_DISALLOWED.has(point)) return "DISALLOWED";
	const char = String.fromCodePoint(point);
	if (!ASSIGNED.test(char)) return "DISALLOWED";
	if (inRange(point, 0x61, 0x7a) || inRange(point, 0x30, 0x39) || point === 0x2d) return "PVALID";
	if (point === 0x200c || point === 0x200d) return "CONTEXTJ";
	if (UNSTABLE_OR_IGNORABLE.test(char) || inDisallowedBlock(point)) return "DISALLOWED";
	return LETTER_DIGITS.test(char) ? "PVALID" : "DISALLOWED";
}

const GREEK = /\p{Script=Greek}/u;
const HEBREW = /\p{Script=Hebrew}/u;
const KANA_OR_HAN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** RFC 5892 appendix A, rules 3 to 9. */
function validContexto(label: number[], pos: number): boolean {
	const point = label[pos] as number;
	const at = (i: number): string => String.fromCodePoint(label[i] as number);
	if (point === 0x00b7) return pos > 0 && pos < label.length - 1 && label[pos - 1] === 0x6c && label[pos + 1] === 0x6c;
	if (point === 0x0375) return pos < label.length - 1 && GREEK.test(at(pos + 1));
	if (point === 0x05f3 || point === 0x05f4) return pos > 0 && HEBREW.test(at(pos - 1));
	if (point === 0x30fb) return label.some((other) => other !== 0x30fb && KANA_OR_HAN.test(String.fromCodePoint(other)));
	if (isArabicIndic(point)) return !label.some(isExtendedArabicIndic);
	return !label.some(isArabicIndic);
}

// The Bidi rule (RFC 5893 section 2) needs each code point's Bidi class, which the runtime does not expose.
// For the code points a label may hold, the class follows from the general category and the script, with
// the few exceptions below (checked against Python 3.14's unicodedata for every PVALID and CONTEXTO code
// point): R and AL are told apart nowhere in the rule, so both are "R" here.

/** Scripts written right to left: their letters and digits are R or AL. */
const RIGHT_TO_LEFT = new RegExp(
	`[${[
		"Adlam",
		"Arabic",
		"Avestan",
		"Chorasmian",
		"Cypriot",
		"Elymaic",
		"Garay",
		"Hanifi_Rohingya",
		"Hatran",
		"Hebrew",
		"Imperial_Aramaic",
		"Inscriptional_Pahlavi",
		"Inscriptional_Parthian",
		"Kharoshthi",
		"Lydian",
		"Mandaic",
		"Manichaean",
		"Mende_Kikakui",
		"Meroitic_Cursive",
		"Meroitic_Hieroglyphs",
		"Nabataean",
		"Nko",
		"Old_Hungarian",
		"Old_North_Arabian",
		"Old_Sogdian",
		"Old_South_Arabian",
		"Old_Turkic",
		"Old_Uyghur",
		"Palmyrene",
		"Phoenician",
		"Psalter_Pahlavi",
		"Samaritan",
		"Sogdian",
		"Syriac",
		"Thaana",
		"Yezidi",
	]
		.map((script) => `\\p{Script=${script}}`)
		.join("")}]`,
	"u",
);
const NONSPACING_MARK = /\p{Mn}/u;
/** Nonspacing marks whose Bidi class is L, not NSM. */
const LEFT_TO_RIGHT_MARKS: ReadonlySet<number> = new Set([0x0cbf, 0x0cc6, 0x11a07, 0x11a08, 0x11c3f]);

type Direction = "L" | "R" | "AN" | "EN" | "ES" | "NSM";

function direction(point: number): Direction {
	if (point === 0x2d) return "ES";
	if (inRange(point, 0x30, 0x39) || isExtendedArabicIndic(point)) return "EN";
	// Arabic-Indic, Hanifi Rohingya and Garay digits.
	if (isArabicIndic(point) || inRange(point, 0x10d30, 0x10d39) || inRange(point, 0x10d40, 0x10d49)) return "AN";
	const char = String.fromCodePoint(point);
	if (NONSPACING_MARK.test(char)) return LEFT_TO_RIGHT_MARKS.has(point) ? "L" : "NSM";
	return RIGHT_TO_LEFT.test(char) ? "R" : "L";
}

/** `check_bidi`: a label with a right-to-left character must be a valid right-to-left label. */
function checkBidi(label: number[]): void {
	const directions = label.map(direction);
	if (!directions.some((found) => found === "R" || found === "AN")) return;
	// A label that starts left to right may not hold a right-to-left character at all.
	if (directions[0] !== "R") throw new IdnaError("Invalid direction in a label");
	if (directions.includes("L")) throw new IdnaError("Invalid direction in a right-to-left label");
	if (directions.includes("AN") && directions.includes("EN")) throw new IdnaError("Can not mix numeral types in a right-to-left label");
	const last = directions.findLast((found) => found !== "NSM");
	if (last !== "R" && last !== "EN" && last !== "AN") throw new IdnaError("Label ends with illegal codepoint directionality");
}

/**
 * Whether the code point's canonical combining class is 9 (a virama), read from the runtime's normalization:
 * NFD puts marks in the order of their classes, so a mark of class 9 moves before U+05B0 (class 10) and
 * stays where it is beside U+094D (class 9), in either order.
 */
function isVirama(point: number): boolean {
	const mark = String.fromCodePoint(point);
	const nfd = (text: string): string => text.normalize("NFD");
	return (
		nfd(mark) === mark &&
		nfd(`a\u05b0${mark}`) === `a${mark}\u05b0` &&
		nfd(`a\u094d${mark}`) === `a\u094d${mark}` &&
		nfd(`a${mark}\u094d`) === `a${mark}\u094d`
	);
}

const MARK = /^\p{M}/u;

/** `check_label`: the IDNA 2008 rules for one label (a U-label, or an ASCII label that is no A-label). */
function checkLabel(text: string): void {
	const label = points(text);
	if (label.length === 0) throw new IdnaError("Empty Label");
	if (text.normalize("NFC") !== text) throw new IdnaError("Label must be in Normalization Form C");
	if (label[2] === 0x2d && label[3] === 0x2d) throw new IdnaError("Label has disallowed hyphens in 3rd and 4th position");
	if (text.startsWith("-") || text.endsWith("-")) throw new IdnaError("Label must not start or end with a hyphen");
	if (MARK.test(text)) throw new IdnaError("Label begins with an illegal combining character");
	label.forEach((point, pos) => {
		const found = property(point);
		if (found === "PVALID" || (found === "CONTEXTO" && validContexto(label, pos))) return;
		// RFC 5892 appendix A, rules 1 and 2: a joiner right after a virama.
		if (found === "CONTEXTJ" && pos > 0 && isVirama(label[pos - 1] as number)) return;
		throw new IdnaError(`Codepoint U+${point.toString(16).toUpperCase().padStart(4, "0")} at position ${pos + 1} not allowed`);
	});
	checkBidi(label);
}

/** An ASCII label as the runtime wrote it: an A-label must decode to a valid U-label it is the encoding of. */
function checkAscii(label: string): void {
	if (label.length > MAX_LABEL) throw new IdnaError("Label too long");
	if (!label.startsWith(PREFIX)) {
		checkLabel(label);
		return;
	}
	const decoded = domainToUnicode(label);
	if (!decoded || decoded.includes(".") || decoded === label || domainToASCII(decoded) !== label) throw new IdnaError("Invalid A-label");
	checkLabel(decoded);
}

/** `idna.encode(text, uts46=True).decode("ascii")`, or IdnaError. */
export function idnaEncode(text: string): string {
	if (points(text).length > MAX_INPUT) throw new IdnaError("Domain too long");
	for (const char of text) {
		if (char.charCodeAt(0) < 0x80 && !ASCII_ALLOWED.test(char)) throw new IdnaError("Codepoint not allowed");
	}
	// "" where the runtime refuses the name, and an IPv4 address where its last label is a number: neither
	// is a domain name the package would give (which sites.ts refuses for its numeric last label anyway).
	const encoded = domainToASCII(text);
	if (!encoded || /^[0-9.]+$/.test(encoded)) throw new IdnaError("Invalid domain");
	const labels = encoded.split(".");
	const trailingDot = labels.length > 1 && labels[labels.length - 1] === "";
	if (trailingDot) labels.pop();
	for (const label of labels) checkAscii(label);
	if (encoded.length > MAX_DOMAIN + (trailingDot ? 1 : 0)) throw new IdnaError("Domain too long");
	return encoded;
}
