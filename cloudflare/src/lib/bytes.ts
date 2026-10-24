// Bytes: UTF-8, hex and base64.

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does. */
export function utf8(text: string): Uint8Array {
	return encoder.encode(text);
}

/**
 * UTF-8 bytes of a string that refuses lone surrogates, for what is hashed or signed: TextEncoder would
 * write U+FFFD, so two different strings would give the same bytes.
 */
export function utf8Strict(text: string): Uint8Array {
	if (!text.isWellFormed()) throw new TypeError("The text holds a lone surrogate, which UTF-8 cannot encode.");
	return encoder.encode(text);
}

/** Text from UTF-8 with invalid sequences replaced by U+FFFD. A byte order mark is kept. */
export function fromUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

/**
 * A text file's characters, one byte order mark dropped: UTF-16 after its byte order mark, UTF-8 when the bytes are
 * valid UTF-8, else windows-1252, which reads every byte and is what Windows writes for Western languages (Excel's
 * "CSV (Comma delimited)", for one).
 */
export function decodeText(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return new TextDecoder("windows-1252").decode(bytes);
	}
}

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Standard base64 with `=` padding. */
export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** URL-safe base64 (`-` and `_`), with `=` padding or without. */
export function base64url(bytes: Uint8Array, { pad = true }: { pad?: boolean } = {}): string {
	const text = base64(bytes).replaceAll("+", "-").replaceAll("/", "_");
	return pad ? text : text.replace(/=+$/, "");
}

/** Decodes standard or URL-safe base64, with or without padding. Throws on anything else. */
export function fromBase64(text: string): Uint8Array {
	const normal = text.replaceAll("-", "+").replaceAll("_", "/");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normal)) throw new TypeError("Not base64.");
	const bare = normal.replace(/=+$/, "");
	if (bare.length % 4 === 1) throw new TypeError("Not base64.");
	const binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	return concatAll(parts);
}

/** `concat` over an array of parts, which may be too many to spread into a call (a body read in tiny chunks). */
export function concatAll(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
