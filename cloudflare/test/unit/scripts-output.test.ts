// A long result cut as pi cuts it (src/scripts/output.ts): the head and sizes that cross from the guest
// give exactly what pi-durable's own `boundOutput` gives for the whole text, compared with pi's code.

import { describe, expect, test } from "vitest";
// pi-durable's bound of a tool result's text (harness/output.ts), which the package does not export.
import { boundOutput } from "../../node_modules/@earendil-works/pi-durable/dist/harness/output.js";
import { bound, headUnits, OutputRecord, piece, plus, sizeOf } from "../../src/scripts/output.ts";

const encoder = new TextEncoder();

/** What pi's `finalResult` makes of the whole text items: unchanged within the bound, else one item and the note. */
function pi(texts: string[], maxBytes: number): { texts: string[]; note?: string } {
	const bounded = boundOutput(texts.join(""), { maxBytes, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" }) as {
		text: string;
		droppedBytes: number;
		droppedLines: number;
	};
	if (bounded.droppedBytes === 0) return { texts };
	return { texts: [bounded.text], note: `Output truncated to its beginning: ${bounded.droppedLines} lines, ${bounded.droppedBytes} bytes dropped` };
}

function ours(texts: string[], maxBytes: number, units: number): { texts: string[]; note?: string } {
	// The first is a note, which crosses whole; the others print items, then a value.
	const record = new OutputRecord(units);
	for (const text of texts.slice(1, -1)) {
		const crossed = piece(text, units);
		record.add(crossed.text, crossed.rest);
	}
	const last = texts.at(-1) as string;
	const result = bound([{ text: texts[0] as string }, ...record.pieces(), piece(last, units)], maxBytes);
	return { texts: result.texts, ...(result.diagnostic ? { note: result.diagnostic.message } : {}) };
}

/** A deterministic generator (seed 7, as the policy tests use). */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

const ALPHABET = ["a", "b", "\n", "é", "€", "😀", "\ud800", "\udc00", " ", "\n\n"];

describe("sizes", () => {
	test("sizeOf counts TextEncoder's bytes, a lone surrogate as U+FFFD's three", () => {
		const next = random(7);
		for (let i = 0; i < 500; i++) {
			const text = Array.from({ length: Math.floor(next() * 40) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
			const bytes = encoder.encode(text);
			expect(sizeOf(text)).toEqual({ bytes: bytes.length, newlines: bytes.filter((byte) => byte === 10).length, last: bytes.at(-1) === 10 });
		}
	});

	test("heads never split a surrogate pair; sizes add up", () => {
		expect(headUnits("a😀", 2)).toBe("a");
		expect(headUnits("a😀", 3)).toBe("a😀");
		expect(headUnits("abc", 0)).toBe("");
		expect(plus(sizeOf("a\n"), sizeOf(""))).toEqual(sizeOf("a\n"));
		expect(plus(sizeOf("a\n"), sizeOf("b"))).toEqual(sizeOf("a\nb"));
	});
});

describe("the bound, against pi's", () => {
	test("under the bound nothing changes, empty items included", () => {
		expect(ours(["note", "", "a\n", "value"], 100, 104)).toEqual({ texts: ["note", "", "a\n", "value"] });
		expect(pi(["note", "", "a\n", "value"], 100)).toEqual({ texts: ["note", "", "a\n", "value"] });
	});

	test("random outputs and values, cut or not, give pi's text and pi's counts", () => {
		const next = random(7);
		for (let i = 0; i < 2000; i++) {
			const maxBytes = 20 + Math.floor(next() * 80);
			const count = 2 + Math.floor(next() * 6);
			const texts = Array.from({ length: count }, () =>
				Array.from({ length: Math.floor(next() * (next() < 0.2 ? 200 : 30)) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join(""),
			);
			// Lone surrogates at item boundaries join into a pair in pi's text (output.ts); keep them inside items.
			const joinsAPair = texts.some((text, index) => index > 0 && /[\ud800-\udbff]$/.test(texts[index - 1] as string) && /^[\udc00-\udfff]/.test(text));
			if (joinsAPair) continue;
			expect(ours(texts, maxBytes, maxBytes + 4), JSON.stringify({ texts, maxBytes })).toEqual(pi(texts, maxBytes));
		}
	});

	test("pieces that all crossed whole, lone surrogates joining across them included, give pi's text and counts", () => {
		const next = random(11);
		for (let i = 0; i < 2000; i++) {
			const maxBytes = 20 + Math.floor(next() * 80);
			const texts = Array.from({ length: 2 + Math.floor(next() * 6) }, () =>
				Array.from({ length: Math.floor(next() * 40) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join(""),
			);
			expect(ours(texts, maxBytes, 1_000_000), JSON.stringify({ texts, maxBytes })).toEqual(pi(texts, maxBytes));
		}
	});

	test("a surrogate pair printed in two halves at the bound is not a cut (opencode's case)", () => {
		const limit = 1024 * 1024;
		const texts = ["", "a".repeat(limit - 4), "\ud83d", "\ude00"];
		expect(ours(texts, limit, limit + 4)).toEqual(pi(texts, limit));
		expect(ours(texts, limit, limit + 4).note).toBeUndefined();
	});

	test("a first line longer than the bound is cut on a character boundary, as pi does", () => {
		const texts = ["", `${"é".repeat(80)}\nrest`, ""];
		expect(ours(texts, 101, 105)).toEqual(pi(texts, 101));
		expect(ours(texts, 101, 105).texts[0]).toBe("é".repeat(50));
	});

	test("the whole of a 1 MiB result", () => {
		const big = `${"line\n".repeat(300_000)}tail`;
		const texts = ["Script failed: x", big, "after", "value\n"];
		expect(ours(texts, 1024 * 1024, 1024 * 1024 + 4)).toEqual(pi(texts, 1024 * 1024));
	});
});

describe("what the host keeps", () => {
	test("whole items while they are short, then only sizes", () => {
		const record = new OutputRecord(10);
		record.add("abc");
		record.add("defgh");
		record.add("ijklmnop");
		record.add("q\n");
		expect(record.items).toEqual(["abc", "defgh", "ijklmnop"]);
		expect(record.pieces()).toEqual([{ text: "abc" }, { text: "defgh" }, { text: "ijklmnop" }, { text: "", rest: sizeOf("q\n") }]);
		expect(record.total).toEqual(sizeOf("abcdefghijklmnopq\n"));
	});

	test("an item past its head keeps the head; what came with it only as a size", () => {
		const record = new OutputRecord(4);
		record.add("abcdefg", sizeOf("hij"));
		record.add("x");
		expect(record.pieces()).toEqual([{ text: "abcd" }, { text: "", rest: sizeOf("efghijx") }]);
	});
});
