// Bytes, hex and base64, with Python's conventions where they are stored or compared.

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does. */
export function utf8(text: string): Uint8Array {
	return encoder.encode(text);
}

/** UTF-8 bytes of a string that refuses lone surrogates, as Python's `str.encode()` does. */
export function utf8Strict(text: string): Uint8Array {
	if (!text.isWellFormed()) throw new TypeError("The text holds a lone surrogate, which UTF-8 cannot encode.");
	return encoder.encode(text);
}

/** Text from UTF-8 with invalid sequences replaced by U+FFFD, like Python's `errors="replace"`. A byte order mark is kept. */
export function fromUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

/** Text from UTF-8 that refuses invalid sequences, as Python's `bytes.decode()` does. A byte order mark is kept. */
export function fromUtf8Strict(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function fromHex(text: string): Uint8Array {
	if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new TypeError("Not hex.");
	const bytes = new Uint8Array(text.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/** Standard base64 with `=` padding. */
export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** URL-safe base64 (`-` and `_`), with `=` padding as Python's `urlsafe_b64encode` writes it, or without. */
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
