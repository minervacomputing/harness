import { createHash, createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { hmacSha256Hex, saltedHmacHex, sha256Hex, timingSafeEqual } from "../../src/lib/hash.ts";

test.each([
	["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
	["\u00e9\u{1f600}", "1184d1f608158eea09d297565575892231550c403aaa913008d867a97cfd5c76"],
])("sha256(%j), of the UTF-8 bytes", async (input, hex) => {
	expect(await sha256Hex(input)).toBe(hex);
});

test("a salted HMAC is the HMAC of the value keyed by the hash of salt and secret", async () => {
	for (const [salt, value, secret] of [
		["minerva.gateway.write", "0199a000-0000-7000-8000-000000000000:eeee", "test-secret-not-a-real-key"],
		["s\u00e9", "v\u{1f600}", "k\u00e9y"],
	] as const) {
		for (const [name, node] of [["SHA-1", "sha1"], ["SHA-256", "sha256"]] as const) {
			const key = createHash(node).update(salt + secret, "utf8").digest();
			expect(await saltedHmacHex(salt, value, secret, name)).toBe(createHmac(node, key).update(value, "utf8").digest("hex"));
		}
	}
	expect(await saltedHmacHex("a", "b", "c")).toBe(await saltedHmacHex("a", "b", "c", "SHA-1"));
});

test("HMAC-SHA256 (RFC 4231 case 2)", async () => {
	expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("a lone surrogate throws instead of hashing as U+FFFD", async () => {
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
