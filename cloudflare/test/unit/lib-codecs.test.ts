// The codecs of src/lib/codecs.ts and src/lib/punycode.ts against what today's Python decodes
// (test/fixtures/codecs/vectors.json, from generate.py beside it), and bounds on the work a hostile body can
// cause: each bounded case would hang or throw before its fix.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canEncode, decode, type Errors } from "../../src/lib/codecs.ts";
import { readVectors } from "../fixtures/connectors/read-vectors.ts";

type Answer = { ok: string } | { error: string };
type Case = { name: string; data: string } & { [errors in Errors]?: Answer };

const vectors = readVectors(new URL("../fixtures/codecs/vectors.json", import.meta.url).pathname) as unknown as { [group: string]: Case[] };

function bytesOf(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function decoded(data: Uint8Array, name: string, errors: Errors): Answer {
	try {
		return { ok: decode(data, name, errors) };
	} catch (error) {
		return { error: (error as Error).name };
	}
}

/** Each case's answers under the handlers its record names, beside Python's. */
function check(group: string, floor: number): void {
	const cases = vectors[group] as Case[];
	expect(cases.length).toBeGreaterThanOrEqual(floor);
	const actual = cases.map((item) => {
		const answers: { [errors: string]: Answer } = {};
		for (const errors of ["strict", "replace", "surrogateescape"] as const) {
			if (item[errors]) answers[errors] = decoded(bytesOf(item.data), item.name, errors);
		}
		return { name: item.name, data: item.data, ...answers };
	});
	expect(actual).toEqual(cases);
}

/** Runs `work` and fails when it takes longer than `budget` milliseconds. */
function within<T>(budget: number, work: () => T): T {
	const started = performance.now();
	const result = work();
	expect(performance.now() - started).toBeLessThan(budget);
	return result;
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("punycode", () => {
	test("Python's answers", () => check("punycode", 300));

	test("a delta of a million digits ends, with Python's answer", () => {
		// Before: the number overflowed to Infinity and `adapt` divided it forever.
		const body = ascii(`${"9".repeat(1_000_000)}b`);
		expect(within(3000, () => decode(body, "punycode", "replace"))).toBe("?");
		expect(within(3000, () => decoded(body, "punycode", "strict"))).toEqual({ error: "OverflowError" });
		expect(decode(ascii(`${"9".repeat(400)}a`), "punycode", "replace")).toBe("?");
	});

	test("six hundred thousand insertions at the front take about linear time", () => {
		// Each delta puts the next character first, so inserting into an array moved the whole text each time.
		const count = 600_000;
		let body = "";
		let bias = 72;
		for (let i = 0; i < count; i++) {
			let q = i;
			for (let j = 0; ; j++) {
				const t = Math.min(26, Math.max(1, 36 * (j + 1) - bias));
				const digit = q < t ? q : t + ((q - t) % (36 - t));
				body += digit < 26 ? String.fromCharCode(0x61 + digit) : String.fromCharCode(0x30 + digit - 26);
				if (q < t) break;
				q = Math.floor((q - t) / (36 - t));
			}
			let d = i === 0 ? Math.floor(i / 700) : Math.floor(i / 2);
			d += Math.floor(d / (i + 1));
			let divisions = 0;
			while (d > 455) {
				d = Math.floor(d / 35);
				divisions += 36;
			}
			bias = divisions + Math.floor((36 * d) / (d + 38));
		}
		const text = within(3000, () => decode(ascii(body), "punycode", "strict"));
		// The i-th insertion is U+0080 + i, each put first: the text runs backwards from the last.
		let expected = "";
		for (let point = 0x80 + count - 1; point >= 0x80; point--) expected += String.fromCodePoint(point);
		expect(text === expected).toBe(true);
	});
});

describe("UTF-8", () => {
	test("a long run of multibyte characters decodes", () => {
		// Before: only ASCII flushed the run spread into String.fromCodePoint, which overflowed the stack.
		const body = new TextEncoder().encode("é".repeat(150_000) + "\u{1f600}".repeat(150_000));
		for (const name of ["utf-8", "utf-8-sig"]) {
			expect(within(2000, () => decode(body, name, "strict")) === "é".repeat(150_000) + "\u{1f600}".repeat(150_000)).toBe(true);
		}
	});
});

describe("escape codecs", () => {
	test("unicode_escape and raw_unicode_escape as Python decodes them", () => check("escapes", 600));
});

describe("CJK codecs decoded from Python's tables", () => {
	test("gb2312, hz, iso2022_kr and johab as Python decodes them", () => check("cjk", 600));

	test("every two-byte input, with each error handler", () => {
		const digests = (vectors as unknown as { digests: { name: string; prefix: string; sha256: string }[] }).digests;
		expect(digests.length).toBe(6);
		for (const { name, prefix, sha256 } of digests) {
			const hashed = createHash("sha256");
			const head = bytesOf(prefix);
			const data = new Uint8Array(head.length + 2);
			data.set(head);
			for (let pair = 0; pair < 0x10000; pair++) {
				data[head.length] = pair >> 8;
				data[head.length + 1] = pair & 0xff;
				for (const errors of ["strict", "replace", "surrogateescape"] as const) {
					const result = decoded(data, name, errors);
					const text = "ok" in result ? result.ok : `!${result.error}`;
					const units = new Uint16Array(text.length + 1);
					for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
					hashed.update(new Uint8Array(units.buffer));
				}
			}
			expect(hashed.digest("hex"), `${name} after ${prefix}`).toBe(sha256);
		}
	});

	test("which characters each encodes, the escape codecs included", () => {
		const digests = (vectors as unknown as { encodable: { name: string; sha256: string }[] }).encodable;
		expect(digests.length).toBe(6);
		const samples = [...Array.from({ length: 0x10000 }, (_, point) => point), 0x10000, 0x1f600, 0x20000, 0x10ffff];
		for (const { name, sha256 } of digests) {
			const marks = Uint8Array.from(samples, (point) => (canEncode(String.fromCodePoint(point), name) ? 1 : 0));
			expect(createHash("sha256").update(marks).digest("hex"), name).toBe(sha256);
		}
		// What ISO-2022-KR decodes but cannot encode: an escape followed by a byte above 0x7f.
		const passed = decode(Uint8Array.of(0x1b, 0x80), "iso2022_kr");
		expect(passed).toBe("\x1b\x80");
		expect(canEncode(passed, "iso2022_kr")).toBe(false);
	});
});
