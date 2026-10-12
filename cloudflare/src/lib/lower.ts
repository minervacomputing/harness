// Python's `str.lower()`, pinned to Python 3.14's Unicode (16.0.0), which the runtime's may be newer than
// (Node 24 has 17.0): which characters it changes (Slack's channel names, a URL's hostname). Characters cased
// after Unicode 16 are left as Python leaves them. The tests check the table against
// test/fixtures/connectors/slack/vectors.json. (`str.casefold()` is lib/casefold.ts.)
//
// - `pythonLower`: the runtime's `toLowerCase()`, final sigma included, on the characters Python lowercases.
//   Case pairs never change once assigned, so the runtime maps those as Python does. One difference is left:
//   whether a capital sigma ends a word is decided with the runtime's Cased and Case_Ignorable, so a sigma
//   next to a lowercase letter or mark assigned after Unicode 16 can come out as σ where Python writes ς.

import { hexRanges } from "./digits.ts";

/** Ranges of code points `str.lower()` changes: `<first>-<last>`, `/2` for every other one, in hex. */
const LOWERED_RANGES =
	"41-5a,c0-d6,d8-de,100-136/2,139-147/2,14a-178/2,179-17d/2,181-182,184-186/2,187-189/2,18a-18b,18e-191,193-194," +
	"196-198,19c-19d,19f-1a0,1a2-1a6/2,1a7-1a9/2,1ac-1ae/2,1af-1b1/2,1b2-1b3,1b5-1b7/2,1b8,1bc,1c4-1c5,1c7-1c8,1ca-1cb," +
	"1cd-1db/2,1de-1ee/2,1f1-1f2,1f4-1f6/2,1f7-1f8,1fa-232/2,23a-23b,23d-23e,241-243/2,244-246,248-24e/2,370-372/2,376," +
	"37f,386-388/2,389-38a,38c-38e/2,38f-391/2,392-3a1,3a3-3ab,3cf,3d8-3ee/2,3f4,3f7-3f9/2,3fa,3fd-42f,460-480/2," +
	"48a-4c0/2,4c1-4cd/2,4d0-52e/2,531-556,10a0-10c5,10c7,10cd,13a0-13f5,1c89,1c90-1cba,1cbd-1cbf,1e00-1e94/2," +
	"1e9e-1efe/2,1f08-1f0f,1f18-1f1d,1f28-1f2f,1f38-1f3f,1f48-1f4d,1f59-1f5f/2,1f68-1f6f,1f88-1f8f,1f98-1f9f," +
	"1fa8-1faf,1fb8-1fbc,1fc8-1fcc,1fd8-1fdb,1fe8-1fec,1ff8-1ffc,2126,212a-212b,2132,2160-216f,2183,24b6-24cf," +
	"2c00-2c2f,2c60-2c62/2,2c63-2c64,2c67-2c6d/2,2c6e-2c70,2c72,2c75,2c7e-2c80,2c82-2ce2/2,2ceb-2ced/2,2cf2," +
	"a640-a66c/2,a680-a69a/2,a722-a72e/2,a732-a76e/2,a779-a77d/2,a77e-a786/2,a78b-a78d/2,a790-a792/2,a796-a7aa/2," +
	"a7ab-a7ae,a7b0-a7b4,a7b6-a7c4/2,a7c5-a7c7,a7c9-a7cb/2,a7cc,a7d0,a7d6-a7dc/2,a7f5,ff21-ff3a,10400-10427," +
	"104b0-104d3,10570-1057a,1057c-1058a,1058c-10592,10594-10595,10c80-10cb2,10d50-10d65,118a0-118bf,16e40-16e5f," +
	"1e900-1e921";

const LOWERED: ReadonlySet<number> = new Set(
	hexRanges(LOWERED_RANGES).flatMap(([first, last, step]) => Array.from({ length: (last - first) / step + 1 }, (_, i) => first + i * step)),
);

/** Python's `text.lower()`. */
export function pythonLower(text: string): string {
	let out = "";
	let run = "";
	for (const char of text) {
		// A character Python leaves alone, but which the runtime would lowercase, ends a run and stays as it is.
		if (LOWERED.has(char.codePointAt(0) as number) || char.toLowerCase() === char) run += char;
		else {
			out += run.toLowerCase() + char;
			run = "";
		}
	}
	return out + run.toLowerCase();
}

/** The code points `str.lower()` changes, for the tests. */
export function loweredPoints(): number[] {
	return [...LOWERED].sort((a, b) => a - b);
}
