// Base64 as CPython's binascii reads it (`a2b_base64`), for Gmail's base64url bodies (gmail/mime.py
// `_decode`: `b64decode(data + padding, altchars=b"-_", validate=True)`) and for "b" encoded words
// (email.base64mime.decode, lax: characters outside the alphabet are skipped).

import { base64 } from "../../../lib/bytes.ts";
import { BinasciiError, ValueError } from "./errors.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;
const PAD = 0x3d;

/** `binascii.a2b_base64(data, strict_mode=strict)`. */
export function a2bBase64(data: Uint8Array, strict: boolean): Uint8Array {
	const out: number[] = [];
	if (strict && data.length > 0 && data[0] === PAD) throw new BinasciiError("Leading padding not allowed");
	let quad = 0;
	let left = 0;
	let pads = 0;
	let paddingStarted = false;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i] as number;
		if (byte === PAD) {
			paddingStarted = true;
			if (strict && quad === 0) throw new BinasciiError("Excess padding not allowed");
			if (quad >= 2 && quad + ++pads >= 4 && strict) {
				// A full pad sequence ends the data; strict mode refuses anything after it. Lax mode of Python 3.14
				// does not stop here: it skips every "=" and goes on reading (found by comparing with 3.14.8's binascii).
				if (i + 1 < data.length) throw new BinasciiError("Excess data after padding");
				return Uint8Array.from(out);
			}
			continue;
		}
		const value = VALUES[byte] as number;
		if (value < 0) {
			if (strict) throw new BinasciiError("Only base64 data is allowed");
			continue;
		}
		if (strict && paddingStarted) throw new BinasciiError("Discontinuous padding not allowed");
		pads = 0;
		switch (quad) {
			case 0:
				quad = 1;
				left = value;
				break;
			case 1:
				quad = 2;
				out.push(((left << 2) | (value >> 4)) & 0xff);
				left = value & 0x0f;
				break;
			case 2:
				quad = 3;
				out.push(((left << 4) | (value >> 2)) & 0xff);
				left = value & 0x03;
				break;
			default:
				quad = 0;
				out.push(((left << 6) | value) & 0xff);
				left = 0;
		}
	}
	// A quad completed by padding is complete: in lax mode that is only known here (strict mode returned above).
	if (quad !== 0 && !(quad >= 2 && quad + pads >= 4)) {
		if (quad === 1) throw new BinasciiError("Invalid base64-encoded string: number of data characters cannot be 1 more than a multiple of 4");
		throw new BinasciiError("Incorrect padding");
	}
	return Uint8Array.from(out);
}

/** `base64.b64decode(text, altchars=b"-_", validate=True)`: ValueError for a non-ASCII text. */
export function b64decodeUrlsafeStrict(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit > 0x7f) throw new ValueError("string argument should contain only ASCII characters");
		bytes[i] = unit === 0x2d ? 0x2b : unit === 0x5f ? 0x2f : unit;
	}
	return a2bBase64(bytes, true);
}

/** `base64.urlsafe_b64encode(data).decode()`, padded. */
export function urlsafeB64encode(data: Uint8Array): string {
	return base64(data).replaceAll("+", "-").replaceAll("/", "_");
}

export { base64 as b64encode };
