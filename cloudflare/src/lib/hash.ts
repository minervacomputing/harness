// Hashes and HMACs over WebCrypto, with Django's salted HMAC for values today's Python derives that way.

import { hex, utf8Strict } from "./bytes.ts";

type Data = string | Uint8Array;
export type HashName = "SHA-1" | "SHA-256";

/** Strings are hashed as UTF-8 and, as Python's `str.encode()`, a lone surrogate throws rather than become U+FFFD. */
function bytesOf(data: Data): Uint8Array {
	return typeof data === "string" ? utf8Strict(data) : data;
}

export async function digest(name: HashName, data: Data): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest(name, bytesOf(data)));
}

/** Lowercase hex SHA-256, as Python's `hashlib.sha256(text.encode()).hexdigest()`. */
export async function sha256Hex(data: Data): Promise<string> {
	return hex(await digest("SHA-256", data));
}

export async function hmac(name: HashName, key: Data, message: Data): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash: name }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, bytesOf(message)));
}

export async function hmacSha256Hex(key: Data, message: Data): Promise<string> {
	return hex(await hmac("SHA-256", key, message));
}

/**
 * Django's `salted_hmac(salt, value, secret, algorithm=...)`: HMAC of `value` keyed by
 * `hash(salt + secret)`. Today's write ids are `salted_hmac("minerva.gateway.write", f"{run}:{key}")
 * .hexdigest()[:32]` with SHA-1, Django's default (runs-gateway-models spec 5.3).
 */
export async function saltedHmacHex(salt: string, value: Data, secret: string, name: HashName = "SHA-1"): Promise<string> {
	const key = await digest(name, salt + secret);
	return hex(await hmac(name, key, value));
}

/**
 * Whether two values are equal, in time that depends only on their lengths: two strings by UTF-16 code
 * unit, two byte arrays by byte. A length difference returns at once: lengths are not secret here (tokens
 * have fixed sizes).
 */
export function timingSafeEqual(a: string, b: string): boolean;
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
export function timingSafeEqual(a: Data, b: Data): boolean {
	if (typeof a === "string" || typeof b === "string") {
		if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
		let difference = 0;
		for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
		return difference === 0;
	}
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= (a[i] as number) ^ (b[i] as number);
	return difference === 0;
}
