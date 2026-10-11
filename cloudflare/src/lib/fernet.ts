// Fernet (spec version 0x80), byte-compatible with Python's `cryptography.fernet`, and the versioned
// key ring of backend/connections/crypto.py (connectors-permissions spec 10). Tokens are URL-safe base64
// with `=` padding, as Python writes them; tokens without padding are accepted too. As in Python's
// `decrypt(token)` without a ttl, the timestamp is neither checked nor used.

import { base64url, concat, fromBase64, fromUtf8, fromUtf8Strict, utf8 } from "./bytes.ts";
import { type Json, parseJson, pythonDumps } from "./json.ts";

const VERSION = 0x80;
const HEADER = 1 + 8 + 16; // version, timestamp, iv
const MAC = 32;

export class InvalidToken extends Error {
	constructor() {
		super("The Fernet token is invalid.");
		this.name = "InvalidToken";
	}
}

export interface FernetKey {
	readonly signing: CryptoKey;
	readonly encryption: CryptoKey;
}

/** A key as `Fernet.generate_key()` writes it: 32 bytes in URL-safe base64. */
export async function fernetKey(text: string): Promise<FernetKey> {
	let raw: Uint8Array;
	try {
		raw = fromBase64(text);
	} catch {
		raw = new Uint8Array();
	}
	if (raw.length !== 32) throw new TypeError("Fernet key must be 32 url-safe base64-encoded bytes.");
	const [signing, encryption] = await Promise.all([
		crypto.subtle.importKey("raw", raw.slice(0, 16), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
		crypto.subtle.importKey("raw", raw.slice(16), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]),
	]);
	return { signing, encryption };
}

/** 32 random bytes in URL-safe base64, as `Fernet.generate_key()`. */
export function generateFernetKey(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface EncryptOptions {
	/** Seconds since the epoch; now by default. Fixed only in tests. */
	time?: number;
	/** 16 bytes; random by default. Fixed only in tests. */
	iv?: Uint8Array;
}

export async function fernetEncrypt(key: FernetKey, plaintext: Uint8Array, options: EncryptOptions = {}): Promise<string> {
	const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(16));
	if (iv.length !== 16) throw new TypeError("A Fernet iv has 16 bytes.");
	const time = options.time ?? Math.floor(Date.now() / 1000);
	const timestamp = new Uint8Array(8);
	new DataView(timestamp.buffer).setBigUint64(0, BigInt(time));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key.encryption, plaintext));
	const body = concat(new Uint8Array([VERSION]), timestamp, iv, ciphertext);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key.signing, body));
	return base64url(concat(body, mac));
}

export async function fernetDecrypt(key: FernetKey, token: string | Uint8Array): Promise<Uint8Array> {
	let data: Uint8Array;
	try {
		data = fromBase64(typeof token === "string" ? token : fromUtf8(token));
	} catch {
		throw new InvalidToken();
	}
	if (data.length < HEADER + 16 + MAC || data[0] !== VERSION || (data.length - HEADER - MAC) % 16 !== 0) {
		throw new InvalidToken();
	}
	const body = data.subarray(0, data.length - MAC);
	const valid = await crypto.subtle.verify("HMAC", key.signing, data.subarray(data.length - MAC), body);
	if (!valid) throw new InvalidToken();
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-CBC", iv: data.subarray(9, HEADER) },
			key.encryption,
			data.subarray(HEADER, data.length - MAC),
		);
		return new Uint8Array(plaintext);
	} catch {
		throw new InvalidToken();
	}
}

/** Raised for a missing key version, an unreadable token or a malformed key list; the messages are today's. */
export class CredentialKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialKeyError";
	}
}

export interface Sealed {
	/** The Fernet token, stored as is (today's `credentials_ciphertext` bytes are its ASCII). */
	ciphertext: string;
	/** The key version that encrypted it, stored alongside (today's `credentials_key_version`, ≤32 chars). */
	version: string;
}

/**
 * `MINERVA_ENCRYPTION_KEYS`: `version:key` entries separated by commas (or a JSON list), trimmed, empty
 * ones dropped, at least one. The first entry's version encrypts and every version decrypts; a later
 * entry with the same version replaces the earlier key, as Python's dict does.
 */
export class KeyRing {
	/** The version that encrypts. */
	readonly current: string;
	private readonly keys: ReadonlyMap<string, FernetKey>;

	private constructor(current: string, keys: ReadonlyMap<string, FernetKey>) {
		this.current = current;
		this.keys = keys;
	}

	static async parse(value: string): Promise<KeyRing> {
		const entries = value.startsWith("[")
			? (parseJson(value) as string[])
			: value.split(",").map((entry) => entry.trim()).filter(Boolean);
		if (entries.length === 0) throw new CredentialKeyError("MINERVA_ENCRYPTION_KEYS needs at least one key.");
		const keys = new Map<string, FernetKey>();
		const order: string[] = [];
		for (const entry of entries) {
			const split = entry.indexOf(":");
			const version = split < 0 ? entry : entry.slice(0, split);
			const key = split < 0 ? "" : entry.slice(split + 1);
			if (!version || !key) {
				throw new CredentialKeyError("MINERVA_ENCRYPTION_KEYS entries must look like 'v1:<fernet key>'.");
			}
			keys.set(version, await fernetKey(key));
			order.push(version);
		}
		return new KeyRing(order[0] as string, keys);
	}

	async encryptBytes(plaintext: Uint8Array): Promise<Sealed> {
		return { ciphertext: await fernetEncrypt(this.keys.get(this.current) as FernetKey, plaintext), version: this.current };
	}

	async decryptBytes(sealed: Sealed): Promise<Uint8Array> {
		const key = this.keys.get(sealed.version);
		if (!key) throw new CredentialKeyError(`No decryption key configured for version '${sealed.version}'.`);
		try {
			return await fernetDecrypt(key, sealed.ciphertext);
		} catch (error) {
			if (error instanceof InvalidToken) throw new CredentialKeyError("Stored data could not be decrypted.");
			throw error;
		}
	}

	/** `encrypt(payload)`: the JSON as Python's `json.dumps` writes it, encrypted. */
	async encrypt(payload: Json): Promise<Sealed> {
		return this.encryptBytes(utf8(pythonDumps(payload)));
	}

	/** `decrypt(ciphertext, version)`: the JSON inside; invalid UTF-8 throws, as Python's `json.loads` does. */
	async decrypt(sealed: Sealed): Promise<Json> {
		return parseJson(fromUtf8Strict(await this.decryptBytes(sealed)));
	}
}
