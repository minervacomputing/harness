// Python's "punycode" codec (RFC 3492) as it decodes bytes, shared by gmail's codecs and the IDNA package port
// (idna.ts), which reads A-labels with it.

import { OverflowError } from "./pyerrors.ts";

/** The codec's failure: `unsupported` for an error handler the codec refuses (a UnicodeError), else a UnicodeDecodeError. */
export class PunycodeError extends Error {
	readonly unsupported: boolean;
	constructor(unsupported: boolean, message: string) {
		super(message);
		this.name = unsupported ? "UnicodeError" : "UnicodeDecodeError";
		this.unsupported = unsupported;
	}
}

/** `bytes.decode("punycode", errors)`; errors other than strict and replace are refused as Python refuses them. */
export function punycodeDecode(bytes: Uint8Array, errors: "strict" | "replace" | "surrogateescape"): string {
	if (errors !== "strict" && errors !== "replace") throw new PunycodeError(true, `Unsupported error handling: ${errors}`);
	const pos = bytes.lastIndexOf(0x2d);
	let base: number[];
	let extended: Uint8Array;
	if (pos === -1) {
		base = [];
		extended = bytes;
	} else {
		const head = bytes.subarray(0, pos);
		base = [];
		for (let i = 0; i < head.length; i++) {
			const byte = head[i] as number;
			if (byte < 0x80) base.push(byte);
			else if (errors === "strict") throw new PunycodeError(false, "'ascii' codec can't decode byte");
			else base.push(0xfffd);
		}
		extended = bytes.subarray(pos + 1);
	}
	const upper = Uint8Array.from(extended, (byte) => (byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte));
	// Python computes with unbounded integers and inserts into a string: a crafted delta is millions of digits
	// long and every insertion copies the text. Here the digits of a long delta are combined as a product tree
	// of BigInts, `adapt` divides once, and the insertions are recorded and placed at the end (placeInsertions),
	// so a body of a few megabytes decodes in about linear time with Python's answer.
	const offset = pos + 1;
	const points: number[] = base;
	const positions: number[] = Array.from(base, (_, i) => i);
	let char = 0x80;
	let index = -1;
	let bias = 72;
	let extpos = 0;
	while (extpos < upper.length) {
		// decode_generalized_number: where the number ends depends on the digits and the bias only.
		const digits: number[] = [];
		const thresholds: number[] = [];
		let p = extpos;
		let complete = false;
		while (true) {
			if (p >= upper.length) {
				if (errors === "strict") throw new PunycodeError(false, "incomplete punycode string");
				p += 1;
				break;
			}
			const c = upper[p] as number;
			p += 1;
			let digit: number;
			if (c >= 0x41 && c <= 0x5a) digit = c - 0x41;
			else if (c >= 0x30 && c <= 0x39) digit = c - 22;
			else if (errors === "strict") throw new PunycodeError(false, `Invalid extended code point '${c}'`);
			else break;
			const t = threshold(digits.length, bias);
			digits.push(digit);
			thresholds.push(t);
			if (digit < t) {
				complete = true;
				break;
			}
		}
		if (!complete) break;
		const delta = generalizedNumber(digits, thresholds);
		const count = points.length;
		if (typeof delta === "number") {
			index += delta + 1;
			char += Math.floor(index / (count + 1));
		} else {
			const big = BigInt(index) + delta + 1n;
			const raised = BigInt(char) + big / BigInt(count + 1);
			if (raised > 0x10ffffn) {
				if (errors === "strict") throw invalidCharacter(raised, BigInt(offset) + big);
				char = 0x110000;
			} else {
				char = Number(raised);
			}
			index = Number(big % BigInt(count + 1));
		}
		if (char > 0x10ffff) {
			if (errors === "strict") throw invalidCharacter(BigInt(char), BigInt(offset + index));
			char = 0x3f;
		}
		index %= count + 1;
		points.push(char);
		positions.push(index);
		bias = adapt(delta, extpos === 0, count + 1);
		extpos = p;
	}
	return placeInsertions(points, positions);
}

const T_MAX = 26;

/** `T(j, bias)`: the threshold of a number's j-th digit. */
function threshold(j: number, bias: number): number {
	return Math.min(T_MAX, Math.max(1, 36 * (j + 1) - bias));
}

/**
 * The value of a generalized variable-length integer: the sum of each digit times the product of
 * `36 - t` over the digits before it. Up to ten digits the value is below 35^10, exact as a number;
 * longer ones are combined pairwise (value and weight of each half) so the multiplications are few and large.
 */
function generalizedNumber(digits: readonly number[], thresholds: readonly number[]): number | bigint {
	if (digits.length <= 10) {
		let result = 0;
		let w = 1;
		for (let j = 0; j < digits.length; j++) {
			result += (digits[j] as number) * w;
			w *= 36 - (thresholds[j] as number);
		}
		return result;
	}
	const combine = (from: number, to: number): [bigint, bigint] => {
		if (to - from <= 16) {
			let value = 0n;
			let weight = 1n;
			for (let j = from; j < to; j++) {
				value += BigInt(digits[j] as number) * weight;
				weight *= BigInt(36 - (thresholds[j] as number));
			}
			return [value, weight];
		}
		const middle = (from + to) >>> 1;
		const [low, lowWeight] = combine(from, middle);
		const [high, highWeight] = combine(middle, to);
		return [low + lowWeight * high, lowWeight * highWeight];
	};
	return combine(0, digits.length)[0];
}

const SSIZE_MAX = 2n ** 63n - 1n;

/**
 * Python's "Invalid character" error, or the OverflowError Python raises instead when the error's end
 * position (the offset of the extended part plus `pos`) does not fit a C ssize_t.
 */
function invalidCharacter(char: bigint, end: bigint): Error {
	if (end > SSIZE_MAX) return new OverflowError("Python int too large to convert to C ssize_t");
	return new PunycodeError(false, `Invalid character U+${char.toString(16)}`);
}

/** `adapt(delta, first, numchars)`; a large delta is divided by the right power of 35 at once. */
function adapt(delta: number | bigint, first: boolean, numchars: number): number {
	if (typeof delta === "number") {
		let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
		d += Math.floor(d / numchars);
		let divisions = 0;
		while (d > 455) {
			d = Math.floor(d / 35);
			divisions += 36;
		}
		return divisions + Math.floor((36 * d) / (d + 38));
	}
	let d = first ? delta / 700n : delta / 2n;
	d += d / BigInt(numchars);
	// floor(floor(d / 35) / 35) = floor(d / 35^2): skip a safe underestimate of the divisions, then step.
	const bits = d.toString(16).length * 4;
	const skip = Math.max(0, Math.floor((bits - 12) / Math.log2(35)) - 1);
	let divisions = 36 * skip;
	if (skip > 0) d /= 35n ** BigInt(skip);
	while (d > 455n) {
		d /= 35n;
		divisions += 36;
	}
	const small = Number(d);
	return divisions + Math.floor((36 * small) / (small + 38));
}

/**
 * The text Python builds by inserting each point at its position in turn (`base[:pos] + chr(char) +
 * base[pos:]`), in O(n log n): taken from the last insertion back, each point lands on the free slot
 * whose rank is its position, found in a Fenwick tree of the free slots.
 */
function placeInsertions(points: readonly number[], positions: readonly number[]): string {
	const n = points.length;
	const tree = new Int32Array(n + 1);
	for (let i = 1; i <= n; i++) {
		tree[i] = (tree[i] as number) + 1;
		const parent = i + (i & -i);
		if (parent <= n) tree[parent] = (tree[parent] as number) + (tree[i] as number);
	}
	let top = 1;
	while (top * 2 <= n) top *= 2;
	const slots = new Int32Array(n);
	for (let i = n - 1; i >= 0; i--) {
		// The (positions[i] + 1)-th free slot.
		let rank = (positions[i] as number) + 1;
		let at = 0;
		for (let step = top; step > 0; step >>= 1) {
			const next = at + step;
			if (next <= n && (tree[next] as number) < rank) {
				at = next;
				rank -= tree[next] as number;
			}
		}
		slots[at] = points[i] as number;
		for (let k = at + 1; k <= n; k += k & -k) tree[k] = (tree[k] as number) - 1;
	}
	let text = "";
	for (let i = 0; i < n; i += 4096) text += String.fromCodePoint(...slots.subarray(i, i + 4096));
	return text;
}
