// What a script's result shows the model when it is long (harness 5.5, 7.4). `run_script` declares
// results of up to 1 MiB with no line limit and the head kept, so pi keeps the first 1 MiB of the result's
// text (its text items joined with "") and notes what it dropped: "Output truncated to its beginning: <L>
// lines, <B> bytes dropped" (pi-durable 1.1.0 harness/output.ts `boundOutput`, harness/tool.ts
// `boundContent` and `truncated`).
//
// Today the host held the whole output, up to 16 Mi characters, and let pi cut it. Here the conversation
// holds only the head of a long output or value and the size of the rest (scripts/limits.ts HEAD_CHARS),
// so a script cannot fill its memory, and cuts the result itself, exactly as pi would cut the whole text,
// with pi's own note: the head it keeps is longer than 1 MiB, which is all the cut reads, and the sizes of
// the rest give the counts. A result under the bound is passed through untouched for pi, as today.
// (A lone surrogate ending one piece and another starting the next are one character in the joined text;
// that is counted where both pieces crossed whole. Across a measured rest it cannot be, and only there could
// the counts, or whether the result is cut at all, differ from pi's.)

import type { ScriptText, TextSize } from "../contracts/scripts.ts";
import { HEAD_CHARS } from "./limits.ts";

export type { ScriptText, TextSize };

export const EMPTY: TextSize = Object.freeze({ bytes: 0, newlines: 0, last: false });

/** The size of a text as UTF-8, as pi counts it: TextEncoder's bytes (a lone surrogate is U+FFFD's three). */
export function sizeOf(text: string): TextSize {
	let bytes = 0;
	let newlines = 0;
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if (unit < 0x80) {
			bytes += 1;
			if (unit === 0x0a) newlines++;
		} else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length) {
			const next = text.charCodeAt(at + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				at++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return { bytes, newlines, last: text.length > 0 && text.charCodeAt(text.length - 1) === 0x0a };
}

export function plus(a: TextSize, b: TextSize): TextSize {
	return { bytes: a.bytes + b.bytes, newlines: a.newlines + b.newlines, last: b.bytes > 0 ? b.last : a.last };
}

/** pi's `lineCount`: newlines, and one more for a last line without one. */
function lines(size: TextSize): number {
	return size.bytes === 0 ? 0 : size.newlines + (size.last ? 0 : 1);
}

/** The head of `text` of at most `units` UTF-16 units, never ending inside a surrogate pair. */
export function headUnits(text: string, units: number): string {
	if (text.length <= units) return text;
	let end = Math.max(0, units);
	const before = text.charCodeAt(end - 1);
	if (end > 0 && before >= 0xd800 && before <= 0xdbff) end--;
	return text.slice(0, end);
}

/** A text cut to what crosses: `HEAD_CHARS` units, the rest only measured. */
export function piece(text: string, units = HEAD_CHARS): ScriptText {
	const head = headUnits(text, units);
	return head.length === text.length ? { text } : { text: head, rest: sizeOf(text.slice(head.length)) };
}

/**
 * Printed output as the host keeps it: whole items while they form the output's beginning and are short,
 * then only the size of everything after, so it never holds much more than the bound needs.
 */
export class OutputRecord {
	readonly #units: number;
	/** The beginning of the output, item by item. */
	readonly items: string[] = [];
	/** Everything after `items`, measured only. */
	#tail: TextSize = EMPTY;
	#total: TextSize = EMPTY;
	#kept = 0;
	#open = true;

	/** `units`: how much text of an item it keeps (HEAD_CHARS; less in the tests). */
	constructor(units = HEAD_CHARS) {
		this.#units = units;
	}

	/** Adds one printed item (`rest`: the size of what of it did not cross). */
	add(text: string, rest?: TextSize): void {
		const own = piece(text, this.#units);
		const restSize = own.rest ? plus(own.rest, rest ?? EMPTY) : (rest ?? EMPTY);
		const headSize = sizeOf(own.text);
		this.#total = plus(this.#total, plus(headSize, restSize));
		if (!this.#open) {
			this.#tail = plus(this.#tail, plus(headSize, restSize));
			return;
		}
		this.items.push(own.text);
		this.#kept += headSize.bytes;
		this.#tail = plus(this.#tail, restSize);
		// Past HEAD_CHARS' worth of bytes the beginning is long enough for the bound; a cut item ends it.
		if (restSize.bytes > 0 || this.#kept > this.#units) this.#open = false;
	}

	get total(): TextSize {
		return this.#total;
	}

	/** The items, then the measured rest. */
	pieces(): ScriptText[] {
		const pieces: ScriptText[] = this.items.map((text) => ({ text }));
		if (this.#tail.bytes > 0) pieces.push({ text: "", rest: this.#tail });
		return pieces;
	}
}

export interface Bounded {
	texts: string[];
	/** pi's truncation note, when the result was cut. */
	diagnostic?: { severity: "warn"; code: "truncated"; message: string };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** pi's `characterEnd`: the last character boundary at or before `index`. */
function characterEnd(bytes: Uint8Array, index: number): number {
	let end = index;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return end;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The size of the pieces joined, as pi measures the joined text: a lone high surrogate ending one whole
 * piece and a lone low one starting the next whole piece are one character there, four bytes rather than
 * six. Across a piece that did not cross whole the joined text is not known, and the sizes are added.
 */
export function joinedSize(pieces: readonly ScriptText[]): TextSize {
	let total = EMPTY;
	// The last unit of the joined text so far, while it is known.
	let before: number | null = null;
	for (const each of pieces) {
		total = plus(total, plus(sizeOf(each.text), each.rest ?? EMPTY));
		if (each.text !== "" && before !== null && isHigh(before) && isLow(each.text.charCodeAt(0))) total = { ...total, bytes: total.bytes - 2 };
		if (each.rest && each.rest.bytes > 0) before = null;
		else if (each.text !== "") before = each.text.charCodeAt(each.text.length - 1);
	}
	return total;
}

/**
 * The result's text items as pi would leave them (`boundContent` with the head kept and no line limit):
 * unchanged within `maxBytes`, else one item, the whole lines of the first `maxBytes` (or a cut of a first
 * line longer than that), and the note.
 */
export function bound(pieces: readonly ScriptText[], maxBytes: number): Bounded {
	const total = joinedSize(pieces);
	if (total.bytes <= maxBytes) return { texts: pieces.map((each) => each.text).filter((text, index) => text !== "" || !pieces[index]?.rest) };
	// The joined text's beginning: every piece up to the first that did not cross whole.
	let prefix = "";
	for (const each of pieces) {
		prefix += each.text;
		if (each.rest && each.rest.bytes > 0) break;
	}
	const bytes = encoder.encode(prefix);
	let end = bytes.length;
	if (end > maxBytes) {
		const newline = bytes.lastIndexOf(0x0a, maxBytes - 1);
		end = newline === -1 ? characterEnd(bytes, maxBytes) : newline + 1;
	}
	let newlines = 0;
	for (let at = 0; at < end; at++) if (bytes[at] === 0x0a) newlines++;
	const keptLines = lines({ bytes: end, newlines, last: end > 0 && bytes[end - 1] === 0x0a });
	return {
		texts: [decoder.decode(bytes.subarray(0, end))],
		diagnostic: { severity: "warn", code: "truncated", message: `Output truncated to its beginning: ${lines(total) - keptLines} lines, ${total.bytes - end} bytes dropped` },
	};
}
