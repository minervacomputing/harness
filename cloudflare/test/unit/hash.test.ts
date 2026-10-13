import { expect, test } from "vitest";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "../../src/lib/hash.ts";

test.each([
	["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
	["\u00e9\u{1f600}", "1184d1f608158eea09d297565575892231550c403aaa913008d867a97cfd5c76"],
])("sha256(%j), of the UTF-8 bytes", async (input, hex) => {
	expect(await sha256Hex(input)).toBe(hex);
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
