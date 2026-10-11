import { expect, test } from "vitest";
import { compareCodePoints, sortByCodePoint } from "../../src/lib/order.ts";
import vectors from "./vectors.ts";

test("sorts as Python's sorted() does", () => {
	expect(sortByCodePoint([...vectors.sorted].reverse())).toEqual(vectors.sorted);
	// The default sort puts the astral character before U+E000, which code point order does not.
	expect([...vectors.sorted].sort()).not.toEqual(vectors.sorted);
});

test("agrees with UTF-8 byte order", () => {
	const encoder = new TextEncoder();
	const strings = ["\u{1f600}", "", "￿", "a", "", "a\u{1f600}", "a￿", "퟿", "\u{10ffff}"];
	const bytes = (s: string) => Array.from(encoder.encode(s));
	const byBytes = [...strings].sort((a, b) => {
		const x = bytes(a);
		const y = bytes(b);
		for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
		return x.length - y.length;
	});
	expect(sortByCodePoint(strings)).toEqual(byBytes);
});

test("lone surrogates count as their code point", () => {
	expect(Math.sign(compareCodePoints("\ud800", ""))).toBe(-1);
	expect(Math.sign(compareCodePoints("😀", "\ud83d"))).toBe(1);
	expect(Math.sign(compareCodePoints("\ud83dx", "😀"))).toBe(-1);
	expect(compareCodePoints("same", "same")).toBe(0);
});

test("sorts by a key", () => {
	expect(sortByCodePoint([{ p: "￿" }, { p: "\u{1f600}" }], (item) => item.p).map((item) => item.p)).toEqual(["￿", "\u{1f600}"]);
});
