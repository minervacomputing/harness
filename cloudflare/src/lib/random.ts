// Random ids and tokens. Call these inside handlers only: a Worker may not generate random values at
// module scope (deploy error 10021).

import { base64url, hex } from "./bytes.ts";

export function randomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

/** Python's `secrets.token_urlsafe(n)`: n random bytes in URL-safe base64 without padding (32 bytes: 43 characters). */
export function tokenUrlsafe(bytes = 32): string {
	return base64url(randomBytes(bytes), { pad: false });
}

/** Python's `secrets.token_hex(n)`: 2n lowercase hex characters. */
export function tokenHex(bytes = 32): string {
	return hex(randomBytes(bytes));
}

export const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const DIGITS = "0123456789";

/** `length` characters drawn uniformly from `alphabet` (Django's `get_random_string`), without modulo bias. */
export function randomString(length: number, alphabet = ALPHANUMERIC): string {
	if (alphabet.length < 2 || alphabet.length > 256) throw new RangeError("An alphabet has 2 to 256 characters.");
	const limit = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < length) {
		for (const byte of randomBytes(length - out.length + 8)) {
			if (byte < limit) out += alphabet[byte % alphabet.length];
			if (out.length === length) break;
		}
	}
	return out;
}

let lastMs = -1;
let counter = 0;

/**
 * A UUIDv7 (RFC 9562), lowercase and hyphenated, as today's primary keys are. Like Python 3.14's
 * `uuid.uuid7()`, ids made in the same millisecond carry a 42-bit counter that keeps them in order, which
 * matters in Workers, where the clock stands still while a request computes.
 */
export function uuid7(now = Date.now()): string {
	const random = randomBytes(10);
	if (now > lastMs) {
		lastMs = now;
		// A fresh counter starts at a random value with its top bit clear, leaving room to count up.
		counter = (((random[0] as number) & 0x01) * 2 ** 40) + ((random[1] as number) * 2 ** 32) + new DataView(random.buffer).getUint32(2);
	} else {
		counter += 1;
		if (counter >= 2 ** 42) {
			lastMs += 1;
			counter = 0;
		}
	}
	const ms = Math.max(now, lastMs);
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, Math.floor(ms / 2 ** 32));
	view.setUint32(2, ms % 2 ** 32);
	const high = Math.floor(counter / 2 ** 30); // 12 bits
	const low = counter % 2 ** 30; // 30 bits
	view.setUint16(6, 0x7000 | high);
	view.setUint32(8, 0x80000000 | low);
	bytes.set(random.subarray(6, 10), 12);
	const text = hex(bytes);
	return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a string is a UUID as the API writes them: lowercase hex, hyphenated. */
export function isUuid(text: string): boolean {
	return UUID.test(text);
}
