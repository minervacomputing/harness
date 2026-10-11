import { describe, expect, test } from "vitest";
import { fromHex, fromUtf8 } from "../../src/lib/bytes.ts";
import { CredentialKeyError, InvalidToken, KeyRing, fernetDecrypt, fernetEncrypt, fernetKey, generateFernetKey } from "../../src/lib/fernet.ts";
import vectors from "./vectors.ts";

const { fernet } = vectors;

describe("Fernet is byte-compatible with Python's cryptography", () => {
	test.each(fernet.fixed)("encrypting $plaintext with a fixed time and iv gives Python's token", async (vector) => {
		const key = await fernetKey(vector.key);
		const token = await fernetEncrypt(key, fromHex(vector.plaintext), { time: vector.time, iv: fromHex(vector.iv) });
		expect(token).toBe(vector.token);
		expect(await fernetDecrypt(key, token)).toEqual(fromHex(vector.plaintext));
	});

	test.each(fernet.random)("decrypts Python's token for $plaintext", async (vector) => {
		const key = await fernetKey(vector.key);
		expect(await fernetDecrypt(key, vector.token)).toEqual(fromHex(vector.plaintext));
		expect(await fernetDecrypt(key, new TextEncoder().encode(vector.token))).toEqual(fromHex(vector.plaintext));
	});

	test("accepts a token without its padding", async () => {
		const vector = fernet.random[1] as (typeof fernet.random)[number];
		const key = await fernetKey(vector.key);
		expect(vector.token.endsWith("=")).toBe(true);
		expect(await fernetDecrypt(key, vector.token.replace(/=+$/, ""))).toEqual(fromHex(vector.plaintext));
	});

	test.each(fernet.invalid)("refuses what Python refuses: %j", async (token) => {
		const key = await fernetKey(fernet.random[0]?.key as string);
		await expect(fernetDecrypt(key, token)).rejects.toBeInstanceOf(InvalidToken);
	});

	test("refuses another key's token", async () => {
		await expect(fernetDecrypt(await fernetKey(fernet.other_key), fernet.other_key_token)).rejects.toBeInstanceOf(InvalidToken);
	});

	test("keys are 32 URL-safe base64 bytes", async () => {
		await expect(fernetKey("short")).rejects.toThrow("Fernet key must be 32 url-safe base64-encoded bytes.");
		const generated = generateFernetKey();
		expect(generated).toMatch(/^[A-Za-z0-9_-]{43}=$/);
		await fernetKey(generated);
	});
});

describe("the key ring of MINERVA_ENCRYPTION_KEYS", () => {
	const [v1, v2] = [fernet.fixed[0]?.key as string, fernet.other_key];

	test("the first entry encrypts and every entry decrypts", async () => {
		const old = await KeyRing.parse(`v1:${v1}`);
		const sealed = await old.encrypt({ kind: "api_key", key: "k" });
		expect(sealed.version).toBe("v1");
		const rotated = await KeyRing.parse(` v2:${v2} , ,v1:${v1}`);
		expect(rotated.current).toBe("v2");
		expect(await rotated.decrypt(sealed)).toEqual({ kind: "api_key", key: "k" });
		expect((await rotated.encrypt({ kind: "builtin" })).version).toBe("v2");
	});

	test("the plaintext is Python's json.dumps", async () => {
		const ring = await KeyRing.parse(`v1:${v1}`);
		const sealed = await ring.encrypt({ kind: "oauth2", access_token: "at", refresh_token: null, scopes: ["read"] });
		const plaintext = fromUtf8(await ring.decryptBytes(sealed));
		expect(plaintext).toBe('{"kind": "oauth2", "access_token": "at", "refresh_token": null, "scopes": ["read"]}');
	});

	test("decrypts the credentials Python encrypted", async () => {
		const ring = await KeyRing.parse(`v1:${v1}`);
		const vector = fernet.random[3] as (typeof fernet.random)[number];
		expect(await ring.decrypt({ ciphertext: vector.token, version: "v1" })).toEqual(JSON.parse(fromUtf8(fromHex(vector.plaintext))));
	});

	test("invalid UTF-8 inside a token throws, as Python's json.loads does", async () => {
		const ring = await KeyRing.parse(`v1:${v1}`);
		const sealed = await ring.encryptBytes(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
		await expect(ring.decrypt(sealed)).rejects.toThrow(TypeError);
	});

	test("a later entry of the same version replaces the key, as Python's dict does", async () => {
		const ring = await KeyRing.parse(`v1:${v1},v1:${v2}`);
		const sealed = await ring.encrypt({ a: 1 });
		const second = await KeyRing.parse(`v1:${v2}`);
		expect(await second.decrypt(sealed)).toEqual({ a: 1 });
	});

	test("errors carry today's messages", async () => {
		const ring = await KeyRing.parse(`v1:${v1}`);
		await expect(KeyRing.parse("nokey")).rejects.toThrow("MINERVA_ENCRYPTION_KEYS entries must look like 'v1:<fernet key>'.");
		await expect(KeyRing.parse(":abc")).rejects.toBeInstanceOf(CredentialKeyError);
		await expect(ring.decrypt({ ciphertext: "x", version: "v9" })).rejects.toThrow("No decryption key configured for version 'v9'.");
		await expect(ring.decrypt({ ciphertext: "x", version: "v1" })).rejects.toThrow("Stored data could not be decrypted.");
	});
});
