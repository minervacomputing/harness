// Python's `idna.encode(text, uts46=True)` (the idna package 3.20, which backend/connectors/web/sites.py
// encodes mail domains with): UTS #46 mapping without the STD3 rules, then IDNA 2008 for each label (NFC,
// hyphens, no leading mark, every code point PVALID or valid in its CONTEXTJ or CONTEXTO context, the
// Bidi rule) and Punycode. The tables are the package's own, with Python's unicodedata for bidirectional
// classes, marks and viramas (idna-table.ts), so a domain is accepted, refused and encoded as today. NFC
// comes from the runtime's Unicode tables.

import { PunycodeError, punycodeDecode } from "./punycode.ts";
import {
	BIDI_CLASSES,
	BIDI_NAMES,
	BIDI_RANGES,
	CONTEXTJ,
	CONTEXTO,
	JOINING,
	MARKS,
	PVALID,
	SCRIPTS,
	UNNAMED,
	UTS46_REPLACEMENTS,
	UTS46_STARTS,
	UTS46_STATUSES,
	VIRAMA,
} from "./idna-table.ts";

/** Python's IDNAError, a UnicodeError: the text cannot be encoded. */
export class IdnaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IDNAError";
	}
}

const MAX_INPUT = 1024;
const MAX_DOMAIN = 253;
const PREFIX = "xn--";

/** Half-open ranges, searched by bisection. */
class Ranges {
	readonly starts: number[] = [];
	readonly ends: number[] = [];

	find(point: number): number {
		let low = 0;
		let high = this.starts.length - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (point < (this.starts[mid] as number)) high = mid - 1;
			else if (point >= (this.ends[mid] as number)) low = mid + 1;
			else return mid;
		}
		return -1;
	}

	has(point: number): boolean {
		return this.find(point) >= 0;
	}
}

/** Ranges packed as base-36 gaps (start - previous end) and lengths. */
function unpack(text: string): Ranges {
	const ranges = new Ranges();
	if (!text) return ranges;
	const numbers = text.split(",").map((part) => Number.parseInt(part, 36));
	let last = 0;
	for (let i = 0; i + 1 < numbers.length; i += 2) {
		const start = last + (numbers[i] as number);
		const end = start + (numbers[i + 1] as number);
		ranges.starts.push(start);
		ranges.ends.push(end);
		last = end;
	}
	return ranges;
}

interface Tables {
	pvalid: Ranges;
	contextj: Ranges;
	contexto: Ranges;
	scripts: Map<string, Ranges>;
	joining: [string, Ranges][];
	virama: Ranges;
	unnamed: Ranges;
	marks: Ranges;
	bidi: Ranges;
	starts: number[];
	replacement: number[];
}

let tables: Tables | null = null;

/** Decoded on first use, so a Worker that never encodes a domain does not pay for it. */
function loaded(): Tables {
	if (tables !== null) return tables;
	const starts: number[] = [];
	let start = 0;
	for (const part of UTS46_STARTS.split(",")) {
		start += Number.parseInt(part, 36);
		starts.push(start);
	}
	const replacement: number[] = [];
	let mapped = 0;
	for (const status of UTS46_STATUSES) replacement.push(status === "M" ? mapped++ : -1);
	tables = {
		pvalid: unpack(PVALID),
		contextj: unpack(CONTEXTJ),
		contexto: unpack(CONTEXTO),
		scripts: new Map(Object.entries(SCRIPTS).map(([name, packed]) => [name, unpack(packed)])),
		joining: JOINING.map(([kind, packed]) => [kind, unpack(packed)]),
		virama: unpack(VIRAMA),
		unnamed: unpack(UNNAMED),
		marks: unpack(MARKS),
		bidi: unpack(BIDI_RANGES),
		starts,
		replacement,
	};
	return tables;
}

function points(text: string): number[] {
	return Array.from(text, (char) => char.codePointAt(0) as number);
}

function isAscii(text: string): boolean {
	return /^[\u0000-\u007f]*$/.test(text);
}

function unot(point: number): string {
	return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** `uts46_remap(domain, std3_rules=False)`: each code point kept, mapped, ignored or refused; then NFC. */
export function uts46Remap(domain: string): string {
	if (points(domain).length > MAX_INPUT) throw new IdnaError("Domain too long");
	if (isAscii(domain)) return domain.toLowerCase();
	const { starts, replacement } = loaded();
	let out = "";
	let position = 0;
	for (const point of points(domain)) {
		position++;
		let index: number;
		if (point < 256) index = point;
		else {
			// bisect_right(starts, point) - 1
			let low = 0;
			let high = starts.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (point < (starts[mid] as number)) high = mid;
				else low = mid + 1;
			}
			index = low - 1;
		}
		const status = UTS46_STATUSES[index];
		if (status === "V" || status === "D") out += String.fromCodePoint(point);
		else if (status === "M") out += UTS46_REPLACEMENTS[replacement[index] as number] as string;
		else if (status !== "I") throw new IdnaError(`Codepoint ${unot(point)} not allowed at position ${position}`);
	}
	return out.normalize("NFC");
}

function bidiOf(point: number): string {
	const { bidi } = loaded();
	const index = bidi.find(point);
	if (index < 0) return "";
	return BIDI_NAMES[Number.parseInt(BIDI_CLASSES[index] as string, 36)] as string;
}

function joiningOf(point: number): string | null {
	for (const [kind, ranges] of loaded().joining) if (ranges.has(point)) return kind;
	return null;
}

/** `_combining_class(cp) == 9`; a code point without a name raises, which `check_label` reports. */
function isVirama(point: number): boolean {
	const { virama, unnamed } = loaded();
	if (unnamed.has(point)) throw new IdnaError(`Unknown codepoint adjacent to joiner ${unot(point)}`);
	return virama.has(point);
}

const RTL_FIRST = new Set(["R", "AL"]);
const RTL_CATEGORIES = new Set(["R", "AL", "AN"]);
const RTL_ALLOWED = new Set(["R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"]);
const RTL_VALID_ENDING = new Set(["R", "AL", "EN", "AN"]);
const RTL_NUMERIC = new Set(["AN", "EN"]);
const LTR_ALLOWED = new Set(["L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"]);
const LTR_VALID_ENDING = new Set(["L", "EN"]);

/** `check_bidi(label)`: RFC 5893, for labels that hold a right-to-left character. */
function checkBidi(label: number[]): void {
	if (label.length > MAX_INPUT) throw new IdnaError("Label too long");
	let bidiLabel = false;
	for (const point of label) {
		const direction = bidiOf(point);
		if (direction === "") throw new IdnaError("Unknown directionality");
		if (RTL_CATEGORIES.has(direction)) bidiLabel = true;
	}
	if (!bidiLabel) return;
	const first = bidiOf(label[0] as number);
	let rtl: boolean;
	if (RTL_FIRST.has(first)) rtl = true;
	else if (first === "L") rtl = false;
	else throw new IdnaError("First codepoint must be directionality L, R or AL");
	let validEnding = false;
	let numberType: string | null = null;
	for (const point of label) {
		const direction = bidiOf(point);
		if (rtl) {
			if (!RTL_ALLOWED.has(direction)) throw new IdnaError("Invalid direction in a right-to-left label");
			if (RTL_VALID_ENDING.has(direction)) validEnding = true;
			else if (direction !== "NSM") validEnding = false;
			if (RTL_NUMERIC.has(direction)) {
				if (!numberType) numberType = direction;
				else if (numberType !== direction) throw new IdnaError("Can not mix numeral types in a right-to-left label");
			}
		} else {
			if (!LTR_ALLOWED.has(direction)) throw new IdnaError("Invalid direction in a left-to-right label");
			if (LTR_VALID_ENDING.has(direction)) validEnding = true;
			else if (direction !== "NSM") validEnding = false;
		}
	}
	if (!validEnding) throw new IdnaError("Label ends with illegal codepoint directionality");
}

function validContextj(label: number[], pos: number): boolean {
	const point = label[pos] as number;
	if (point === 0x200c) {
		if (pos > 0 && isVirama(label[pos - 1] as number)) return true;
		let ok = false;
		for (let i = pos - 1; i >= 0; i--) {
			const type = joiningOf(label[i] as number);
			if (type === "T") continue;
			if (type === "L" || type === "D") ok = true;
			break;
		}
		if (!ok) return false;
		ok = false;
		for (let i = pos + 1; i < label.length; i++) {
			const type = joiningOf(label[i] as number);
			if (type === "T") continue;
			if (type === "R" || type === "D") ok = true;
			break;
		}
		return ok;
	}
	if (point === 0x200d) return pos > 0 && isVirama(label[pos - 1] as number);
	return false;
}

function inScript(point: number, script: string): boolean {
	return loaded().scripts.get(script)?.has(point) ?? false;
}

function validContexto(label: number[], pos: number): boolean {
	const point = label[pos] as number;
	if (point === 0x00b7) return pos > 0 && pos < label.length - 1 && label[pos - 1] === 0x6c && label[pos + 1] === 0x6c;
	if (point === 0x0375) return pos < label.length - 1 && label.length > 1 ? inScript(label[pos + 1] as number, "Greek") : false;
	if (point === 0x05f3 || point === 0x05f4) return pos > 0 ? inScript(label[pos - 1] as number, "Hebrew") : false;
	if (point === 0x30fb) {
		for (const other of label) {
			if (other === 0x30fb) continue;
			if (inScript(other, "Hiragana") || inScript(other, "Katakana") || inScript(other, "Han")) return true;
		}
		return false;
	}
	if (point >= 0x660 && point <= 0x669) return !label.some((other) => other >= 0x6f0 && other <= 0x6f9);
	if (point >= 0x6f0 && point <= 0x6f9) return !label.some((other) => other >= 0x660 && other <= 0x669);
	return false;
}

/** `check_label`: the IDNA 2008 rules for one label. */
function checkLabel(text: string): void {
	const label = points(text);
	if (label.length > MAX_INPUT) throw new IdnaError("Label too long");
	if (label.length === 0) throw new IdnaError("Empty Label");
	if (label.length > MAX_DOMAIN + 1) throw new IdnaError("Label too long");
	if (text.normalize("NFC") !== text) throw new IdnaError("Label must be in Normalization Form C");
	if (label[2] === 0x2d && label[3] === 0x2d) throw new IdnaError("Label has disallowed hyphens in 3rd and 4th position");
	if (text.startsWith("-") || text.endsWith("-")) throw new IdnaError("Label must not start or end with a hyphen");
	const { pvalid, contextj, contexto, marks } = loaded();
	if (marks.has(label[0] as number)) throw new IdnaError("Label begins with an illegal combining character");
	label.forEach((point, pos) => {
		if (pvalid.has(point)) return;
		if (contextj.has(point)) {
			if (!validContextj(label, pos)) throw new IdnaError(`Joiner ${unot(point)} not allowed at position ${pos + 1}`);
		} else if (contexto.has(point)) {
			if (!validContexto(label, pos)) throw new IdnaError(`Codepoint ${unot(point)} not allowed at position ${pos + 1}`);
		} else {
			throw new IdnaError(`Codepoint ${unot(point)} at position ${pos + 1} not allowed`);
		}
	});
	checkBidi(label);
}

// Punycode encoding (RFC 3492), as Python's codec writes it.

const DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";

function adapt(delta: number, first: boolean, numchars: number): number {
	let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
	d += Math.floor(d / numchars);
	let divisions = 0;
	while (d > 455) {
		d = Math.floor(d / 35);
		divisions += 36;
	}
	return divisions + Math.floor((36 * d) / (d + 38));
}

/** `text.encode("punycode")`. */
export function punycodeEncode(text: string): string {
	const input = points(text);
	const basic = input.filter((point) => point < 0x80);
	let output = String.fromCharCode(...basic);
	const extended = [...new Set(input.filter((point) => point >= 0x80))].sort((a, b) => a - b);
	// insertion_unsort
	const deltas: number[] = [];
	let oldchar = 0x80;
	let oldindex = -1;
	for (const char of extended) {
		let index = -1;
		let pos = -1;
		const curlen = input.filter((point) => point < char).length;
		let delta = (curlen + 1) * (char - oldchar);
		for (;;) {
			// selective_find(str, char, index, pos)
			let found = false;
			for (;;) {
				pos += 1;
				if (pos === input.length) {
					index = -1;
					pos = -1;
					break;
				}
				const c = input[pos] as number;
				if (c === char) {
					index += 1;
					found = true;
					break;
				}
				if (c < char) index += 1;
			}
			if (!found) break;
			delta += index - oldindex;
			deltas.push(delta - 1);
			oldindex = index;
			delta = 0;
		}
		oldchar = char;
	}
	// generate_integers
	let bias = 72;
	let generated = "";
	deltas.forEach((delta, points) => {
		let n = delta;
		for (let j = 0; ; j++) {
			const t = Math.min(26, Math.max(1, 36 * (j + 1) - bias));
			if (n < t) {
				generated += DIGITS[n];
				break;
			}
			generated += DIGITS[t + ((n - t) % (36 - t))];
			n = Math.floor((n - t) / (36 - t));
		}
		bias = adapt(delta, points === 0, basic.length + points + 1);
	});
	if (basic.length) output += "-";
	return output + generated;
}

/** `ulabel(ascii)` for an ASCII label: an A-label decoded and checked to be canonical, else checked as is. */
function checkAscii(label: string): void {
	if (label.length > MAX_INPUT) throw new IdnaError("Label too long");
	const lowered = label.toLowerCase();
	if (!lowered.startsWith(PREFIX)) {
		checkLabel(lowered);
		return;
	}
	const rest = lowered.slice(PREFIX.length);
	if (!rest) throw new IdnaError("Malformed A-label, no Punycode eligible content found");
	if (rest.endsWith("-")) throw new IdnaError("A-label must not end with a hyphen");
	let decoded: string;
	try {
		decoded = punycodeDecode(Uint8Array.from(rest, (char) => char.charCodeAt(0)), "strict");
	} catch (error) {
		if (!(error instanceof PunycodeError)) throw error;
		throw new IdnaError("Invalid A-label");
	}
	if (punycodeEncode(decoded) !== rest) throw new IdnaError("A-label is not the canonical Punycode encoding of its U-label");
	checkLabel(decoded);
}

/** `alabel(label)`. */
function alabel(label: string): string {
	if (points(label).length > MAX_INPUT) throw new IdnaError("Label too long");
	if (isAscii(label)) {
		checkAscii(label);
		if (label.length > 63) throw new IdnaError("Label too long");
		return label;
	}
	checkLabel(label);
	const encoded = PREFIX + punycodeEncode(label);
	if (encoded.length > 63) throw new IdnaError("Label too long");
	return encoded;
}

/** `idna.encode(text, uts46=True).decode("ascii")`. */
export function idnaEncode(text: string): string {
	if (points(text).length > MAX_INPUT) throw new IdnaError("Domain too long");
	const mapped = uts46Remap(text);
	if (points(mapped).length > MAX_DOMAIN + 1) throw new IdnaError("Domain too long");
	const labels = mapped.split(/[.。．｡]/);
	if (labels.length === 1 && labels[0] === "") throw new IdnaError("Empty domain");
	let trailingDot = false;
	if (labels[labels.length - 1] === "") {
		labels.pop();
		trailingDot = true;
	}
	const result = labels.map((label) => {
		const encoded = alabel(label);
		if (!encoded) throw new IdnaError("Empty label");
		return encoded;
	});
	if (trailingDot) result.push("");
	const domain = result.join(".");
	if (domain.length > MAX_DOMAIN + (trailingDot ? 1 : 0)) throw new IdnaError("Domain too long");
	return domain;
}
