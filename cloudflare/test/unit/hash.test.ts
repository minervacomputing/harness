import { expect, test } from "vitest";
import { hmacSha256Hex, saltedHmacHex, sha256Hex, timingSafeEqual } from "../../src/lib/hash.ts";
import vectors from "./vectors.ts";

test.each(vectors.sha256)("sha256($input)", async ({ input, hex }) => {
	expect(await sha256Hex(input)).toBe(hex);
});

test.each(vectors.salted_hmac)("Django's salted_hmac for $value", async ({ salt, value, secret, sha1, sha256 }) => {
	expect(await saltedHmacHex(salt, value, secret)).toBe(sha1);
	expect(await saltedHmacHex(salt, value, secret, "SHA-256")).toBe(sha256);
});

test("write ids are the first 32 hex of the SHA-1 salted HMAC", async () => {
	const vector = vectors.salted_hmac[0] as (typeof vectors.salted_hmac)[number];
	expect((await saltedHmacHex("minerva.gateway.write", vector.value, vector.secret)).slice(0, 32)).toBe(vector.sha1.slice(0, 32));
});

test("HMAC-SHA256 (RFC 4231 case 2)", async () => {
	expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("a lone surrogate throws, as str.encode() does, instead of hashing as U+FFFD", async () => {
	await expect(sha256Hex("\ud800")).rejects.toThrow(TypeError);
	await expect(hmacSha256Hex("key", "\udc00")).rejects.toThrow(TypeError);
});

test("timing-safe equality", () => {
	expect(timingSafeEqual("\ud800", "\ud801")).toBe(false);
	expect(timingSafeEqual("abc", "abc")).toBe(true);
	expect(timingSafeEqual("abc", "abd")).toBe(false);
	expect(timingSafeEqual("abc", "abcd")).toBe(false);
	expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
});
