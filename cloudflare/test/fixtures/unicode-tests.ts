// Python 3.14's text rules as the runtime's Unicode tables give them (src/lib/unicode.ts), checked for every
// code point against test/fixtures/unicode/unicode.json, which test/fixtures/unicode/generate.py writes from
// Python 3.14.8 (Unicode 16.0.0). test/unit/unicode.test.ts runs them in Node and test/platform/unicode.test.ts
// in workerd, whose Unicode data production uses.

import { describe, expect, test } from "vitest";
import { casefold } from "../../src/lib/casefold.ts";
import { DIGIT_CLASS, decimalRanges } from "../../src/lib/digits.ts";
import { pythonLower } from "../../src/lib/lower.ts";
import { WHITE_SPACE } from "../../src/lib/schema.ts";
import { PYTHON_WHITESPACE, WORD_CLASS, pythonRepr } from "../../src/lib/text.ts";
import { UNICODE_17, hexRanges, isUnicode17, pythonProperty } from "../../src/lib/unicode.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import oracle from "./unicode/unicode.json" with { type: "json" };

/** Every code point but the surrogates. */
function* everyPoint(): Generator<number> {
	for (let point = 0; point <= 0x10ffff; point++) if (point < 0xd800 || point > 0xdfff) yield point;
}

function pointsOf(table: string): Set<number> {
	const points = new Set<number>();
	for (const [first, last] of hexRanges(table)) for (let point = first; point <= last; point++) points.add(point);
	return points;
}

/** The code points that satisfy `test`, as the runs `[first, last]`. */
function runsOf(test: (point: number) => boolean): [number, number][] {
	const runs: [number, number][] = [];
	for (const point of everyPoint()) {
		const last = runs[runs.length - 1];
		if (!test(point)) continue;
		if (last !== undefined && last[1] === point - 1) last[1] = point;
		else runs.push([point, point]);
	}
	return runs;
}

/** The code points on which `test` and a set of Python's differ, in hex. */
function differences(test: (point: number) => boolean, python: ReadonlySet<number>): string[] {
	const wrong: string[] = [];
	for (const point of everyPoint()) if (test(point) !== python.has(point)) wrong.push(point.toString(16));
	return wrong;
}

function fromHexes(text: string): string {
	return String.fromCodePoint(...text.split(" ").map((part) => Number.parseInt(part, 16)));
}

const ASSIGNED = /\p{Assigned}/u;

export function unicodeTests(): void {
	describe("the runtime's Unicode is Python 3.14's plus Unicode 17", () => {
		test("the oracle is Python 3.14's Unicode 16.0.0", () => {
			expect(oracle.unicode).toBe("16.0.0");
			expect(oracle.python.startsWith("3.14.")).toBe(true);
		});

		// If this fails after a runtime upgrade, the runtime has moved on to Unicode 18. Its new code points are
		// then in neither Python 3.14's table nor UNICODE_17: decide with the user whether Minerva follows Python
		// (3.15 has Unicode 17), then extend UNICODE_17 and review lib/idna.ts (RIGHT_TO_LEFT) too.
		test("UNICODE_17 is exactly what the runtime assigns and Python 3.14 does not", () => {
			const unassigned = pointsOf(oracle.unassigned);
			expect(runsOf((point) => unassigned.has(point) && ASSIGNED.test(String.fromCodePoint(point)))).toEqual(UNICODE_17.map(([first, last]) => [first, last]));
			expect(UNICODE_17.reduce((sum, [first, last]) => sum + last - first + 1, 0)).toBe(4803);
			expect(isUnicode17(0x10940)).toBe(true);
			expect(isUnicode17(0x10940 - 1)).toBe(false);
			expect(isUnicode17(0x33479)).toBe(true);
			expect(isUnicode17(0x3347a)).toBe(false);
			// Nothing Python 3.14 assigned is missing from the runtime.
			expect(differences((point) => !ASSIGNED.test(String.fromCodePoint(point)), unassigned).filter((point) => !isUnicode17(Number.parseInt(point, 16)))).toEqual([]);
		});

		test("casefold() folds every code point as Python 3.14's str.casefold()", () => {
			const wrong: string[] = [];
			for (const point of everyPoint()) {
				const char = String.fromCodePoint(point);
				const folded = (oracle.casefold as { [point: string]: string })[point.toString(16)];
				if (casefold(char) !== (folded === undefined ? char : fromHexes(folded))) wrong.push(point.toString(16));
			}
			expect(wrong).toEqual([]);
		});

		test("pythonLower() lowercases every code point as Python 3.14's str.lower()", () => {
			const wrong: string[] = [];
			for (const point of everyPoint()) {
				const char = String.fromCodePoint(point);
				const lowered = (oracle.lower as { [point: string]: string })[point.toString(16)];
				if (pythonLower(char) !== (lowered === undefined ? char : fromHexes(lowered))) wrong.push(point.toString(16));
			}
			expect(wrong).toEqual([]);
		});

		test("pythonLower() lowercases a capital sigma beside every code point as Python 3.14's lower() does", async () => {
			// The final-sigma rule reads the letters and marks around a sigma, and those are where Unicode 17 differs.
			for (const [template, digest] of Object.entries(oracle.sigma_sha256)) {
				const lines: string[] = [];
				for (const point of everyPoint()) {
					const lowered = pythonLower(template.replace("{}", () => String.fromCodePoint(point)));
					lines.push(`${point.toString(16)} ${[...lowered].map((char) => (char.codePointAt(0) as number).toString(16)).join(" ")}`);
				}
				expect(await sha256Hex(lines.join("\n")), template).toBe(digest);
			}
		}, 120_000);

		test("pythonRepr() writes every code point as Python 3.14's repr()", async () => {
			const lines: string[] = [];
			for (const point of everyPoint()) lines.push(`${point.toString(16)} ${pythonRepr(String.fromCodePoint(point))}`);
			expect(await sha256Hex(lines.join("\n"))).toBe(oracle.repr_sha256);
		});

		test("\\w in a str pattern is the letters and numbers of the runtime without Unicode 17", () => {
			const word = pointsOf(oracle.word);
			const python = new RegExp(`^${pythonProperty("\\p{L}\\p{N}_")}$`, "u");
			expect(differences((point) => python.test(String.fromCodePoint(point)), word)).toEqual([]);
			// The patterns written with WORD_CLASS follow the runtime: they differ from Python on Unicode 17 alone.
			const runtime = new RegExp(`^[${WORD_CLASS}]$`, "u");
			const extra = differences((point) => runtime.test(String.fromCodePoint(point)), word);
			expect(extra.length).toBeGreaterThan(4000);
			expect(extra.filter((point) => !isUnicode17(Number.parseInt(point, 16)))).toEqual([]);
		});

		test("\\d in a str pattern is the runtime's Nd without Unicode 17, and DIGIT_CLASS is that", () => {
			const digits = pointsOf(oracle.digit);
			const table = new RegExp(`^${DIGIT_CLASS}$`, "u");
			expect(differences((point) => table.test(String.fromCodePoint(point)), digits)).toEqual([]);
			const runtime = /^\p{Nd}$/u;
			const extra = differences((point) => runtime.test(String.fromCodePoint(point)), digits);
			expect(extra).toEqual(["11de0", "11de1", "11de2", "11de3", "11de4", "11de5", "11de6", "11de7", "11de8", "11de9"]);
			expect(decimalRanges().every(([first, last]) => (last - first + 1) % 10 === 0)).toBe(true);
		});

		test("the white space of Pydantic's strip is the runtime's White_Space, and Python's adds U+001C to U+001F", () => {
			const runtime = /^\p{White_Space}$/u;
			expect(runsOf((point) => runtime.test(String.fromCodePoint(point))).flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i))).toEqual([...WHITE_SPACE]);
			expect([...PYTHON_WHITESPACE]).toEqual([...new Set([...WHITE_SPACE, 0x1c, 0x1d, 0x1e, 0x1f])].sort((a, b) => a - b));
		});
	});

	describe("full case folding", () => {
		// Searches and the matching of a named write target (Linear's states and labels, Jira's issue types and
		// statuses) compare folded text; a name that folds alike twice is ambiguous and refused by the caller.
		test.each([
			["Straße", "STRASSE"],
			["straße", "STRASSE"],
			["\u1e9e", "ss"],
			["ß", "SS"],
			["ΟΔΟΣ", "οδοσ"],
			["ΟΔΟΣ", "οδος"],
			["ΣΑΣ", "σας"],
			["ς", "Σ"],
			["\u017f", "S"],
			["\u212a", "k"],
			["\ufb01", "FI"],
			["\u0149", "\u02bcN"],
			["\u01f0", "J\u030c"],
			["\u0130", "i\u0307"],
			["\u0390", "\u1fd3"],
			["\u13a0", "\uab70"],
			["\u13f8", "\u13f0"],
		])("%j and %j fold alike", (a, b) => {
			expect(casefold(a)).toBe(casefold(b));
		});

		// Folding is case alone: no normalization of any kind, so look-alikes and other spellings stay apart.
		test.each([
			["\u0131", "i"],
			["\u0130", "i"],
			["\uff21", "a"],
			["\u2460", "1"],
			["\u00e9", "e\u0301"],
			["ß", "s"],
		])("%j and %j stay apart", (a, b) => {
			expect(casefold(a)).not.toBe(casefold(b));
		});

		test("what Python 3.14 does not know stays as it is: Unicode 17's capitals, and a lone surrogate", () => {
			for (const char of ["꟎", "꟒", "꟔", "\u{16ea0}", "\u{16eb8}"]) {
				expect(casefold(char)).toBe(char);
				expect(pythonLower(char)).toBe(char);
			}
			expect(casefold("\ud800A\udfffB")).toBe("\ud800a\udfffb");
			expect(casefold("\u{10400}")).toBe("\u{10428}");
		});

		test("a sigma is final in lowercase() and not in casefold(), and Unicode 17 does not change which", () => {
			expect(pythonLower("ΟΔΟΣ Σ ΑΣ.")).toBe("οδος σ ας.");
			expect(casefold("ΟΔΟΣ Σ ΑΣ.")).toBe("οδοσ σ ασ.");
			// Python 3.14 sees U+A7CF as unassigned: the sigma before it ends the word, as before a space.
			expect(pythonLower("ΑΣ꟏")).toBe("ας꟏");
			expect(pythonLower("꟏Σ")).toBe("꟏σ");
		});

		test("a letter that Unicode 17 made plain, U+0295, still makes a sigma next to it final or not as in Python 3.14", () => {
			expect(pythonLower("ʕΣ")).toBe("ʕς");
			expect(pythonLower("AΣʕ")).toBe("aσʕ");
			expect(pythonLower("ʕ\u0301Σ")).toBe("ʕ\u0301ς");
			expect(pythonLower("ʕΣʕ")).toBe("ʕσʕ");
			expect(pythonLower("ʕ꟏Σ")).toBe("ʕ꟏σ");
			expect(pythonLower("ʕʕ")).toBe("ʕʕ");
		});
	});
}
