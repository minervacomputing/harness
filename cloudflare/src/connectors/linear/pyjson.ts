// Python's `json.loads` of a response's bytes, as httpx's `response.json()` calls it, for `judge` and
// `classify` (client.ts), which decide from a body whether a write was applied and which error a failure
// is. Read more strictly, a body Python reads would be "not JSON" here, and a refused status would then
// count a write that may have run as not applied.
//
// What Python does beyond UTF-8 JSON: it detects UTF-16 and UTF-32 by a byte order mark or by where the
// zero bytes are (`json.detect_encoding`), decodes with "surrogatepass" (an encoded surrogate reads as a
// lone surrogate), and reads NaN, Infinity and -Infinity as floats. The constants are read as null here:
// `judge` and `classify` only ask whether a value is an object, a list, a string or `true`, which a float
// is not either, and `str()` of a message holding one cannot say "not found" either way.

import { type Json, parseJson } from "../../lib/json.ts";

export type Encoding = "utf-8" | "utf-8-sig" | "utf-16" | "utf-16-le" | "utf-16-be" | "utf-32" | "utf-32-le" | "utf-32-be";

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** `json.detect_encoding`. */
export function detectEncoding(bytes: Uint8Array): Encoding {
	if (startsWith(bytes, 0x00, 0x00, 0xfe, 0xff) || startsWith(bytes, 0xff, 0xfe, 0x00, 0x00)) return "utf-32";
	if (startsWith(bytes, 0xfe, 0xff) || startsWith(bytes, 0xff, 0xfe)) return "utf-16";
	if (startsWith(bytes, 0xef, 0xbb, 0xbf)) return "utf-8-sig";
	const [b0, b1, b2, b3] = bytes;
	if (bytes.length >= 4) {
		if (!b0) return b1 ? "utf-16-be" : "utf-32-be";
		if (!b1) return b2 || b3 ? "utf-16-le" : "utf-32-le";
	} else if (bytes.length === 2) {
		if (!b0) return "utf-16-be";
		if (!b1) return "utf-16-le";
	}
	return "utf-8";
}

/** UTF-16 code units as a string, a chunk at a time. */
function fromUnits(units: number[]): string {
	let text = "";
	for (let start = 0; start < units.length; start += 8192) text += String.fromCharCode(...units.slice(start, start + 8192));
	return text;
}

function pushPoint(units: number[], point: number): void {
	if (point < 0x10000) units.push(point);
	else units.push(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
}

function continuation(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/**
 * UTF-8 as Python decodes it with "surrogatepass": strict (no overlong forms, nothing above U+10FFFF, no
 * truncated sequence), except that ED A0..BF 80..BF decode to the surrogate they encode.
 */
function utf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		// Only a body with an encoded surrogate, or one Python refuses too, gets here.
	}
	const units: number[] = [];
	for (let at = 0; at < bytes.length; ) {
		const b0 = bytes[at] as number;
		const [b1, b2, b3] = [bytes[at + 1], bytes[at + 2], bytes[at + 3]];
		if (b0 < 0x80) {
			units.push(b0);
			at += 1;
		} else if (b0 >= 0xc2 && b0 <= 0xdf && continuation(b1)) {
			units.push(((b0 & 0x1f) << 6) | ((b1 as number) & 0x3f));
			at += 2;
		} else if (b0 >= 0xe0 && b0 <= 0xef && continuation(b1) && continuation(b2) && (b0 !== 0xe0 || (b1 as number) >= 0xa0)) {
			units.push(((b0 & 0x0f) << 12) | (((b1 as number) & 0x3f) << 6) | ((b2 as number) & 0x3f));
			at += 3;
		} else if (
			b0 >= 0xf0 &&
			b0 <= 0xf4 &&
			continuation(b1) &&
			continuation(b2) &&
			continuation(b3) &&
			(b0 !== 0xf0 || (b1 as number) >= 0x90) &&
			(b0 !== 0xf4 || (b1 as number) <= 0x8f)
		) {
			pushPoint(units, ((b0 & 0x07) << 18) | (((b1 as number) & 0x3f) << 12) | (((b2 as number) & 0x3f) << 6) | ((b3 as number) & 0x3f));
			at += 4;
		} else return null;
	}
	return fromUnits(units);
}

/** UTF-16 code units, lone surrogates kept; an odd byte left over is truncated data. */
function utf16(bytes: Uint8Array, little: boolean): string | null {
	if (bytes.length % 2) return null;
	const units: number[] = [];
	for (let at = 0; at < bytes.length; at += 2) units.push(little ? (bytes[at] as number) | ((bytes[at + 1] as number) << 8) : ((bytes[at] as number) << 8) | (bytes[at + 1] as number));
	return fromUnits(units);
}

/** UTF-32 code points, surrogates kept; one above U+10FFFF, or bytes left over, is an error. */
function utf32(bytes: Uint8Array, little: boolean): string | null {
	if (bytes.length % 4) return null;
	const units: number[] = [];
	for (let at = 0; at < bytes.length; at += 4) {
		const [a, b, c, d] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]] as [number, number, number, number];
		const point = little ? a + b * 0x100 + c * 0x10000 + d * 0x1000000 : d + c * 0x100 + b * 0x10000 + a * 0x1000000;
		if (point > 0x10ffff) return null;
		pushPoint(units, point);
	}
	return fromUnits(units);
}

/** `bytes.decode(encoding, "surrogatepass")`, or null where it raises. */
export function decodeAs(bytes: Uint8Array, encoding: Encoding): string | null {
	switch (encoding) {
		case "utf-8":
			return utf8(bytes);
		case "utf-8-sig":
			return utf8(startsWith(bytes, 0xef, 0xbb, 0xbf) ? bytes.subarray(3) : bytes);
		case "utf-16":
			// Read with its byte order mark, which `detect_encoding` saw.
			return utf16(bytes.subarray(2), bytes[0] === 0xff);
		case "utf-16-le":
			return utf16(bytes, true);
		case "utf-16-be":
			return utf16(bytes, false);
		case "utf-32":
			return utf32(bytes.subarray(4), bytes[0] === 0xff);
		case "utf-32-le":
			return utf32(bytes, true);
		case "utf-32-be":
			return utf32(bytes, false);
	}
}

const CONSTANTS = ["-Infinity", "Infinity", "NaN"] as const;

/** NaN, Infinity and -Infinity outside strings written as null. Text that is not JSON stays not JSON. */
export function constantsAsNull(text: string): string {
	if (!text.includes("NaN") && !text.includes("Infinity")) return text;
	let out = "";
	let from = 0;
	let inString = false;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (inString) {
			if (char === "\\") at++;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		const constant = CONSTANTS.find((word) => text.startsWith(word, at));
		if (constant === undefined) continue;
		out += `${text.slice(from, at)}null`;
		at += constant.length - 1;
		from = at + 1;
	}
	return out + text.slice(from);
}

/** `json.loads(body)` of a response's bytes, with its float constants as null (above), or undefined where it raises. */
export function pythonLoads(bytes: Uint8Array): Json | undefined {
	const text = decodeAs(bytes, detectEncoding(bytes));
	if (text === null) return undefined;
	try {
		return parseJson(constantsAsNull(text));
	} catch {
		return undefined;
	}
}
