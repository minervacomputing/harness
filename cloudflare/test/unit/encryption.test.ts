// Encryption at rest (lib/encryption.ts): the m2 envelope, tampering with each of its parts, envelopes moved
// between rows, workspaces and purposes, key rotation, and the key list's rules.

import { describe, expect, test } from "vitest";
import { base64url, fromBase64, utf8 } from "../../src/lib/bytes.ts";
import {
	type Binding,
	EncryptionError,
	EncryptionKeys,
	NONCE_BYTES,
	type Sealed,
	TAG_BYTES,
	credentialBinding,
	oauthClientBinding,
} from "../../src/lib/encryption.ts";

const secret = (seed: number) => base64url(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff), { pad: false });
const K1 = `k1:${secret(1)}`;
const K2 = `k2:${secret(2)}`;
const WORKSPACE = "0199a000-0000-7000-8000-0000000000aa";
const OTHER_WORKSPACE = "0199a000-0000-7000-8000-0000000000bb";
const CONNECTION = "0199a000-0000-7000-8000-000000000c01";
const OTHER_CONNECTION = "0199a000-0000-7000-8000-000000000c02";
const ROW = credentialBinding(WORKSPACE, CONNECTION);
const PAYLOAD = { kind: "oauth2", access_token: "at", refresh_token: "rt", scopes: ["read"] };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url with the lowest unused bit of its last character set: the same bytes, spelled otherwise. */
function respell(text: string): string {
	return `${text.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(text.at(-1) as string) ^ 1]}`;
}

/** The envelope with one byte of its body changed. */
function flipped(sealed: Sealed, at: (length: number) => number): Sealed {
	const [format, id, body] = sealed.ciphertext.split(".") as [string, string, string];
	const bytes = fromBase64(body);
	const index = at(bytes.length);
	bytes[index] = (bytes[index] as number) ^ 0x01;
	return { ...sealed, ciphertext: `${format}.${id}.${base64url(bytes, { pad: false })}` };
}

async function refused(keys: EncryptionKeys, binding: Binding, sealed: Sealed, message = "Stored data could not be decrypted."): Promise<void> {
	const error = await keys.decrypt(binding, sealed).then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(EncryptionError);
	expect((error as Error).message).toBe(message);
}

describe("the m2 envelope", () => {
	test("is the format version, the key id and base64url of nonce, ciphertext and tag", async () => {
		const keys = await EncryptionKeys.parse(K1);
		const sealed = await keys.encrypt(ROW, PAYLOAD);
		expect(sealed.version).toBe("k1");
		expect(sealed.ciphertext).toMatch(/^m2\.k1\.[A-Za-z0-9_-]+$/);
		const plaintext = '{"access_token":"at","kind":"oauth2","refresh_token":"rt","scopes":["read"]}';
		expect(fromBase64(sealed.ciphertext.split(".")[2] as string)).toHaveLength(NONCE_BYTES + utf8(plaintext).length + TAG_BYTES);
		expect(new TextDecoder().decode(await keys.decryptBytes(ROW, sealed))).toBe(plaintext);
		expect(await keys.decrypt(ROW, sealed)).toEqual(PAYLOAD);
	});

	test("an empty plaintext and arbitrary bytes round-trip", async () => {
		const keys = await EncryptionKeys.parse(K1);
		for (const bytes of [new Uint8Array(), Uint8Array.from({ length: 256 }, (_, i) => i)]) {
			expect(await keys.decryptBytes(ROW, await keys.encryptBytes(ROW, bytes))).toEqual(bytes);
		}
	});

	test("a nonce is never repeated, so equal plaintexts give different envelopes", async () => {
		const keys = await EncryptionKeys.parse(K1);
		const count = 5000;
		const nonces = new Set<string>();
		const envelopes = new Set<string>();
		for (let i = 0; i < count; i++) {
			const sealed = await keys.encryptBytes(ROW, utf8("same"));
			envelopes.add(sealed.ciphertext);
			nonces.add(base64url(fromBase64(sealed.ciphertext.split(".")[2] as string).subarray(0, NONCE_BYTES)));
		}
		expect(nonces.size).toBe(count);
		expect(envelopes.size).toBe(count);
	});

	test("tampering with any part is refused", async () => {
		const keys = await EncryptionKeys.parse(`${K1},${K2}`);
		const sealed = await keys.encrypt(ROW, PAYLOAD);
		const [, , body] = sealed.ciphertext.split(".") as [string, string, string];
		// The format version.
		await refused(keys, ROW, { ...sealed, ciphertext: `m3.k1.${body}` }, "Stored data is not in format m2, the only one this version reads.");
		await refused(keys, ROW, { ...sealed, ciphertext: `M2.k1.${body}` }, "Stored data is not in format m2, the only one this version reads.");
		// The key id: another configured key, an unknown one, a malformed one, or the column beside it.
		await refused(keys, ROW, { ciphertext: `m2.k2.${body}`, version: "k2" });
		await refused(keys, ROW, { ciphertext: `m2.k9.${body}`, version: "k9" }, "No decryption key configured for version 'k9'.");
		await refused(keys, ROW, { ciphertext: `m2.k.1.${body}`, version: "k.1" });
		await refused(keys, ROW, { ...sealed, version: "k2" });
		// The nonce, the ciphertext and the tag.
		await refused(keys, ROW, flipped(sealed, () => 0));
		await refused(keys, ROW, flipped(sealed, () => NONCE_BYTES - 1));
		await refused(keys, ROW, flipped(sealed, () => NONCE_BYTES + 3));
		await refused(keys, ROW, flipped(sealed, (length) => length - TAG_BYTES - 1));
		await refused(keys, ROW, flipped(sealed, (length) => length - TAG_BYTES));
		await refused(keys, ROW, flipped(sealed, (length) => length - 1));
		// Truncated, extended, re-spelled or malformed.
		const bytes = fromBase64(body);
		await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${base64url(bytes.subarray(0, bytes.length - 1), { pad: false })}` });
		await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${base64url(bytes.subarray(0, NONCE_BYTES + TAG_BYTES - 1), { pad: false })}` });
		await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${base64url(new Uint8Array([...bytes, 0]), { pad: false })}` });
		await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${base64url(bytes)}` });
		await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${body.replaceAll("-", "+").replaceAll("_", "/")}x` });
		await refused(keys, ROW, { ...sealed, ciphertext: `${sealed.ciphertext}.` });
		await refused(keys, ROW, { ...sealed, ciphertext: "m2.k1." });
		await refused(keys, ROW, { ...sealed, ciphertext: "m2" }, "Stored data could not be decrypted.");
		await refused(keys, ROW, { ...sealed, ciphertext: "" }, "Stored data is not in format m2, the only one this version reads.");
		// A base64 spelling with other unused bits decodes to the same bytes, but only the canonical one is ours.
		if ((body.length * 6) % 8 > 0) {
			expect(fromBase64(respell(body))).toEqual(bytes);
			await refused(keys, ROW, { ...sealed, ciphertext: `m2.k1.${respell(body)}` });
		}
		// Untouched, it still decrypts.
		expect(await keys.decrypt(ROW, sealed)).toEqual(PAYLOAD);
	});

	test("a Fernet token, as instances stored before step 6b, is refused for its format", async () => {
		const keys = await EncryptionKeys.parse(K1);
		const fernet = "gAAAAABo2XoAAAECAwQFBgcICQoLDA0ODwF6U2W0JxkNDb3mT8hCJdm9UJ2vh9b4lYqf3P2oV5cVfV3uYc1j8Aq6Yj1jM3T0rJxvzvR0=";
		await refused(
			keys,
			ROW,
			{ ciphertext: fernet, version: "k1" },
			"Stored data is not in format m2, the only one this version reads. It is a Fernet token from before step 6b, which no version reads any more: reset the instance's data.",
		);
	});

	test("invalid UTF-8 or JSON inside throws", async () => {
		const keys = await EncryptionKeys.parse(K1);
		await expect(keys.decrypt(ROW, await keys.encryptBytes(ROW, new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])))).rejects.toThrow(TypeError);
		await expect(keys.decrypt(ROW, await keys.encryptBytes(ROW, utf8("{")))).rejects.toThrow(SyntaxError);
	});

	test("the plaintext is canonical JSON, which refuses what it cannot write exactly", async () => {
		const keys = await EncryptionKeys.parse(K1);
		await expect(keys.encrypt(ROW, { a: Number.NaN })).rejects.toThrow(TypeError);
		await expect(keys.encrypt(ROW, { a: "\ud800" })).rejects.toThrow(TypeError);
		// Not an identity: a large number is a value like any other.
		expect(await keys.decrypt(ROW, await keys.encrypt(ROW, { expires_at: 1e21 }))).toEqual({ expires_at: 1e21 });
	});
});

describe("associated data binds an envelope to its row and purpose", () => {
	test("an envelope moved to another connection, workspace or purpose does not decrypt", async () => {
		const keys = await EncryptionKeys.parse(K1);
		const sealed = await keys.encrypt(ROW, PAYLOAD);
		await refused(keys, credentialBinding(WORKSPACE, OTHER_CONNECTION), sealed);
		await refused(keys, credentialBinding(OTHER_WORKSPACE, CONNECTION), sealed);
		// The same identifiers under the other purpose: another derived key and other associated data.
		await refused(keys, oauthClientBinding(WORKSPACE, CONNECTION, CONNECTION), sealed);
		// Swapping the workspace and connection ids is another row.
		await refused(keys, credentialBinding(CONNECTION, WORKSPACE), sealed);
		expect(await keys.decrypt(ROW, sealed)).toEqual(PAYLOAD);
	});

	test("an OAuth client's secret is bound to its provider, redirect URI and client id", async () => {
		const keys = await EncryptionKeys.parse(K1);
		const client = oauthClientBinding("todoist", "https://minerva.example/api/connections/todoist/callback", "client-1");
		const sealed = await keys.encrypt(client, { secret: "s" });
		expect(await keys.decrypt(client, sealed)).toEqual({ secret: "s" });
		await refused(keys, oauthClientBinding("linear", "https://minerva.example/api/connections/todoist/callback", "client-1"), sealed);
		await refused(keys, oauthClientBinding("todoist", "https://other.example/api/connections/todoist/callback", "client-1"), sealed);
		await refused(keys, oauthClientBinding("todoist", "https://minerva.example/api/connections/todoist/callback", "client-2"), sealed);
		await refused(keys, credentialBinding("todoist", "client-1"), sealed);
	});

	test("a binding needs every field of its row", async () => {
		const keys = await EncryptionKeys.parse(K1);
		await expect(keys.encrypt(credentialBinding(WORKSPACE, ""), PAYLOAD)).rejects.toThrow(TypeError);
		await expect(keys.encrypt(oauthClientBinding("todoist", "", "client-1"), { secret: "s" })).rejects.toThrow(TypeError);
	});
});

describe("MINERVA_ENCRYPTION_KEYS", () => {
	test("the first key encrypts and every key decrypts, so keys rotate", async () => {
		const old = await EncryptionKeys.parse(K1);
		const before = await old.encrypt(ROW, PAYLOAD);
		const rotated = await EncryptionKeys.parse(` ${K2} , ,${K1}`);
		expect(rotated.current).toBe("k2");
		expect(await rotated.decrypt(ROW, before)).toEqual(PAYLOAD);
		const after = await rotated.encrypt(ROW, PAYLOAD);
		expect(after.version).toBe("k2");
		expect(after.ciphertext.startsWith("m2.k2.")).toBe(true);
		// Once the old key is dropped, what it encrypted is unreadable, and the error names its id only.
		const retired = await EncryptionKeys.parse(K2);
		expect(await retired.decrypt(ROW, after)).toEqual(PAYLOAD);
		await refused(retired, ROW, before, "No decryption key configured for version 'k1'.");
		// The same id with another secret is another key.
		await refused(await EncryptionKeys.parse(`k1:${secret(3)}`), ROW, before);
	});

	test("a key id is given once", async () => {
		await expect(EncryptionKeys.parse(`${K1},k1:${secret(2)}`)).rejects.toThrow("MINERVA_ENCRYPTION_KEYS has the key id 'k1' more than once; each key needs its own id.");
		await expect(EncryptionKeys.parse(`${K1},${K1}`)).rejects.toBeInstanceOf(EncryptionError);
	});

	test("a key generated for Fernet before step 6b (32 bytes, padded) is still a valid secret", async () => {
		const keys = await EncryptionKeys.parse("v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
		expect(keys.current).toBe("v1");
		expect(await keys.decrypt(ROW, await keys.encrypt(ROW, PAYLOAD))).toEqual(PAYLOAD);
	});

	test("malformed lists are refused at startup, without repeating a secret", async () => {
		await expect(EncryptionKeys.parse("")).rejects.toThrow("MINERVA_ENCRYPTION_KEYS needs at least one key.");
		await expect(EncryptionKeys.parse(" , ")).rejects.toThrow("MINERVA_ENCRYPTION_KEYS needs at least one key.");
		const short = base64url(new Uint8Array(31), { pad: false });
		const malformed = [
			"nokey",
			`:${secret(1)}`,
			`k1:`,
			`k.1:${secret(1)}`,
			`k 1:${secret(1)}`,
			`${"k".repeat(33)}:${secret(1)}`,
			`k1:${short}`,
			`k1:${secret(1)}==`,
			`k1:${base64url(Uint8Array.from({ length: 32 }, () => 0xfb), { pad: false }).replaceAll("_", "/").replaceAll("-", "+")}`,
			// The same bytes in a non-canonical spelling (an unused bit set).
			`k1:${respell(secret(1))}`,
			`${K1},k2`,
		];
		for (const value of malformed) {
			const error = await EncryptionKeys.parse(value).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error, value).toBeInstanceOf(EncryptionError);
			expect((error as Error).message, value).toMatch(/^(Entry \d of MINERVA_ENCRYPTION_KEYS is not 'id:secret'|MINERVA_ENCRYPTION_KEYS has)/);
			expect((error as Error).message).not.toContain(secret(1));
		}
		// The JSON list Fernet's key ring also read says how to write it instead.
		await expect(EncryptionKeys.parse(` ["k1:${secret(1)}"]`)).rejects.toThrow(
			"MINERVA_ENCRYPTION_KEYS is a JSON list, which this version does not read: write its entries comma separated, as id:secret,id:secret.",
		);
		// Padded or not, and longer, is fine.
		expect((await EncryptionKeys.parse(`k1:${secret(1)}=`)).current).toBe("k1");
		expect((await EncryptionKeys.parse(`k_1-x:${base64url(new Uint8Array(64).fill(9), { pad: false })}`)).current).toBe("k_1-x");
	});
});
