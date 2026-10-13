import { expect, test } from "vitest";
import { ALPHANUMERIC, DIGITS, isUuid, randomString, tokenHex, tokenUrlsafe, uuid7 } from "../../src/lib/random.ts";

test("tokens are URL-safe base64 or hex, of the bytes' lengths", () => {
	expect(tokenUrlsafe()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(tokenUrlsafe(18)).toMatch(/^[A-Za-z0-9_-]{24}$/);
	expect(tokenUrlsafe(64)).toHaveLength(86);
	expect(tokenHex(4)).toMatch(/^[0-9a-f]{8}$/);
});

test("random strings use only their alphabet, with every character reachable", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) for (const char of randomString(32)) seen.add(char);
	expect([...seen].every((char) => ALPHANUMERIC.includes(char))).toBe(true);
	expect(seen.size).toBe(ALPHANUMERIC.length);
	expect(randomString(6, DIGITS)).toMatch(/^[0-9]{6}$/);
});

test("UUIDv7s carry the time, version and variant, and keep their order within a millisecond", () => {
	const now = Date.UTC(2026, 9, 11, 12, 0, 0);
	const ids = Array.from({ length: 1000 }, () => uuid7(now));
	for (const id of ids) {
		expect(isUuid(id)).toBe(true);
		expect(id[14]).toBe("7");
		expect("89ab").toContain(id[19]);
		expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
	}
	expect([...ids].sort()).toEqual(ids);
	expect(new Set(ids).size).toBe(ids.length);
	const later = uuid7(now + 1);
	expect(later > (ids.at(-1) as string)).toBe(true);
});

test("isUuid takes only the API's form", () => {
	expect(isUuid("0199a000-0000-7000-8000-000000000001")).toBe(true);
	expect(isUuid("0199A000-0000-7000-8000-000000000001")).toBe(false);
	expect(isUuid("0199a00000007000800000000000000001")).toBe(false);
});
