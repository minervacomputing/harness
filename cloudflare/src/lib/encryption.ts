// Encryption at rest (plan: Credentials and refresh): AES-256-GCM through WebCrypto, under keys derived per
// purpose from MINERVA_ENCRYPTION_KEYS. A value is stored as one envelope,
//
//   m2.<key id>.<base64url(nonce ‖ ciphertext ‖ tag)>
//
// `m2` is the format version, separate from the key id; the nonce is 96 random bits from
// `crypto.getRandomValues`, the tag 128 bits; base64url without padding, in its one canonical spelling.
// Anything else (another version, an unknown key, a malformed, truncated or re-spelled envelope) is refused.
//
// Keys. MINERVA_ENCRYPTION_KEYS is an ordered, comma-separated list of `id:secret` entries: the first one
// encrypts and every one decrypts, so a key is rotated by putting a new entry first and dropping the old one
// once nothing is stored under it (the key id is stored beside each envelope, so the rows still under it can
// be found). An id is 1 to 32 letters, digits, `-` or `_`, used once; a secret is at least 32 random bytes
// in URL-safe base64, with or without padding (scripts/secrets.ts generates them). Each purpose gets its own
// AES key from a secret: HKDF-SHA-256 with a fixed salt and `info` = `minerva/m2/<purpose>`.
//
// Associated data. Every envelope is bound to where it is stored: the canonical JSON (lib/canonical.ts) of
// the format version, the key id, the purpose and the row's identity (a credential's workspace and
// connection; an OAuth client's provider, redirect URI and client id). An envelope copied to another row,
// workspace or purpose does not decrypt there. AEAD does not stop an older envelope of the same row from
// being written back. Minerva's own writes never do that, since each write of credentials is a
// compare-and-set on the credential generation it read (plan: Credentials and refresh); someone who can
// write the storage directly can roll a row back, which no key held beside that storage can detect.
//
// Limits. With random 96-bit nonces a derived key is good for at most 2^32 encryptions (NIST SP 800-38D);
// rotating the key is the remedy, long before that.

import { base64url, concat, fromBase64, fromUtf8Strict, utf8 } from "./bytes.ts";
import { canonicalJson } from "./canonical.ts";
import { type Json, parseJson } from "./json.ts";

/** The envelope's format version. */
export const FORMAT = "m2";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const MIN_SECRET_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SALT = utf8("minerva/m2/hkdf-salt");
/** WebCrypto's key, spelled so the Worker's types and Node's (scripts/secrets.ts checks the list) both accept it. */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** What an encrypted value is for and the row it belongs to, which its associated data binds it to. */
export type Binding =
	| { purpose: "credential"; workspaceId: string; connectionId: string }
	| { purpose: "oauth-client"; provider: string; redirectUri: string; clientId: string };
export type Purpose = Binding["purpose"];
const PURPOSES: readonly Purpose[] = ["credential", "oauth-client"];

/** A connection's credentials, in its workspace's Workspace object. */
export function credentialBinding(workspaceId: string, connectionId: string): Binding {
	return { purpose: "credential", workspaceId, connectionId };
}

/** A dynamically registered OAuth client's secret, in D1's `oauth_clients`. */
export function oauthClientBinding(provider: string, redirectUri: string, clientId: string): Binding {
	return { purpose: "oauth-client", provider, redirectUri, clientId };
}

/** A malformed key list, or stored data that cannot be decrypted. Messages never hold a secret. */
export class EncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EncryptionError";
	}
}

export interface Sealed {
	/** The envelope, stored as is. */
	ciphertext: string;
	/** The envelope's key id, stored beside it (a column), so rows under an old key can be found. */
	version: string;
}

const UNREADABLE = "Stored data could not be decrypted.";
const NOT_M2 = `Stored data is not in format ${FORMAT}, the only one this version reads.`;
// Fernet tokens start with the version byte 0x80 and a timestamp's zero high bytes.
const FERNET = /^gAAAAA/;

export class EncryptionKeys {
	/** The key id that encrypts. */
	readonly current: string;
	readonly #keys: ReadonlyMap<string, ReadonlyMap<Purpose, Key>>;

	private constructor(current: string, keys: ReadonlyMap<string, ReadonlyMap<Purpose, Key>>) {
		this.current = current;
		this.#keys = keys;
	}

	/** Parses MINERVA_ENCRYPTION_KEYS and derives its keys. Throws EncryptionError, naming entries by position. */
	static async parse(value: string): Promise<EncryptionKeys> {
		if (value.trim().startsWith("[")) {
			throw new EncryptionError("MINERVA_ENCRYPTION_KEYS is a JSON list, which this version does not read: write its entries comma separated, as id:secret,id:secret.");
		}
		const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
		if (entries.length === 0) throw new EncryptionError("MINERVA_ENCRYPTION_KEYS needs at least one key.");
		const keys = new Map<string, ReadonlyMap<Purpose, Key>>();
		let current: string | null = null;
		for (const [index, entry] of entries.entries()) {
			const split = entry.indexOf(":");
			const id = split < 0 ? "" : entry.slice(0, split);
			const secret = split < 0 ? null : decodeSecret(entry.slice(split + 1));
			if (!KEY_ID.test(id) || secret === null || secret.length < MIN_SECRET_BYTES) {
				throw new EncryptionError(
					`Entry ${index + 1} of MINERVA_ENCRYPTION_KEYS is not 'id:secret': an id of 1 to 32 letters, digits, '-' or '_', and a ` +
						`secret of at least ${MIN_SECRET_BYTES} random bytes in URL-safe base64 (scripts/secrets.ts generates one).`,
				);
			}
			if (keys.has(id)) throw new EncryptionError(`MINERVA_ENCRYPTION_KEYS has the key id '${id}' more than once; each key needs its own id.`);
			keys.set(id, await derive(secret));
			current ??= id;
		}
		return new EncryptionKeys(current as string, keys);
	}

	/** Encrypts `plaintext` for `binding` under the current key. */
	async encryptBytes(binding: Binding, plaintext: Uint8Array): Promise<Sealed> {
		const key = this.#key(this.current, binding.purpose);
		const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const sealed = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: associatedData(this.current, binding), tagLength: TAG_BYTES * 8 },
			key,
			plaintext,
		);
		const ciphertext = `${FORMAT}.${this.current}.${base64url(concat(nonce, new Uint8Array(sealed)), { pad: false })}`;
		return { ciphertext, version: this.current };
	}

	/** Decrypts an envelope stored for `binding`. Throws EncryptionError for anything that is not one of ours, intact, for this row. */
	async decryptBytes(binding: Binding, sealed: Sealed): Promise<Uint8Array> {
		const { keyId, body } = parseEnvelope(sealed.ciphertext);
		// The column beside the envelope names the same key, or the row was tampered with.
		if (sealed.version !== keyId) throw new EncryptionError(UNREADABLE);
		const purposes = this.#keys.get(keyId);
		if (purposes === undefined) throw new EncryptionError(`No decryption key configured for version '${keyId}'.`);
		try {
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: body.subarray(0, NONCE_BYTES), additionalData: associatedData(keyId, binding), tagLength: TAG_BYTES * 8 },
				purposes.get(binding.purpose) as Key,
				body.subarray(NONCE_BYTES),
			);
			return new Uint8Array(plaintext);
		} catch {
			throw new EncryptionError(UNREADABLE);
		}
	}

	/** Encrypts a JSON value as its canonical JSON (lib/canonical.ts). */
	async encrypt(binding: Binding, payload: Json): Promise<Sealed> {
		return this.encryptBytes(binding, utf8(canonicalJson(payload)));
	}

	/** The JSON value inside; invalid UTF-8 or JSON throws. */
	async decrypt(binding: Binding, sealed: Sealed): Promise<Json> {
		return parseJson(fromUtf8Strict(await this.decryptBytes(binding, sealed)));
	}

	#key(id: string, purpose: Purpose): Key {
		return this.#keys.get(id)?.get(purpose) as Key;
	}
}

/** URL-safe base64 in its canonical spelling, padded or not; null for anything else. */
function decodeSecret(text: string): Uint8Array | null {
	const bare = text.endsWith("=") ? text.replace(/={1,2}$/, "") : text;
	if (!BASE64URL.test(bare)) return null;
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(bare);
	} catch {
		return null;
	}
	if (base64url(bytes, { pad: false }) !== bare) return null;
	if (bare !== text && base64url(bytes) !== text) return null;
	return bytes;
}

async function derive(secret: Uint8Array): Promise<ReadonlyMap<Purpose, Key>> {
	const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
	const keys = new Map<Purpose, Key>();
	for (const purpose of PURPOSES) {
		const info = utf8(`minerva/${FORMAT}/${purpose}`);
		keys.set(purpose, await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
	}
	return keys;
}

/** The format version, the key id, the purpose and the row, as canonical JSON. */
function associatedData(keyId: string, binding: Binding): Uint8Array {
	const row =
		binding.purpose === "credential"
			? { workspace: binding.workspaceId, connection: binding.connectionId }
			: { provider: binding.provider, redirect_uri: binding.redirectUri, client_id: binding.clientId };
	for (const field of Object.values(row)) {
		if (typeof field !== "string" || field === "") throw new TypeError(`A ${binding.purpose} binding needs every field of its row.`);
	}
	return utf8(canonicalJson({ format: FORMAT, key: keyId, purpose: binding.purpose, row }, { identity: true }));
}

function parseEnvelope(text: string): { keyId: string; body: Uint8Array } {
	const parts = text.split(".");
	if (parts[0] !== FORMAT) {
		// What instances stored before step 6b: they are not read, so the operator learns what to do.
		// Reconnecting cannot replace it (a reconnect reads the old credentials first): the instance starts afresh.
		if (FERNET.test(text)) throw new EncryptionError(`${NOT_M2} It is a Fernet token from before step 6b, which no version reads any more: reset the instance's data.`);
		throw new EncryptionError(NOT_M2);
	}
	if (parts.length !== 3) throw new EncryptionError(UNREADABLE);
	const [, keyId, encoded] = parts as [string, string, string];
	if (!KEY_ID.test(keyId) || !BASE64URL.test(encoded)) throw new EncryptionError(UNREADABLE);
	let body: Uint8Array;
	try {
		body = fromBase64(encoded);
	} catch {
		throw new EncryptionError(UNREADABLE);
	}
	if (base64url(body, { pad: false }) !== encoded || body.length < NONCE_BYTES + TAG_BYTES) throw new EncryptionError(UNREADABLE);
	return { keyId, body };
}
