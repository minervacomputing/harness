// Python 3.14's text rules on the runtime's Unicode (test/fixtures/unicode-tests.ts) in Node, where the unit
// layer runs; test/platform/unicode.test.ts runs the same tests in workerd. The last tests read the source.

import { describe, expect, test } from "vitest";
import { sourceCode } from "../fixtures/source.ts";
import { unicodeTests } from "../fixtures/unicode-tests.ts";

unicodeTests();

describe("no compatibility normalization decides who or what something is", () => {
	// NFKC folds look-alikes (fullwidth letters, ligatures, "①") into other characters. It is used to refuse and to
	// redact, never to match: `decoded` finds an address hidden in an encoded link, and `checkNetloc` refuses a
	// host that NFKC would turn into a delimiter. Identities, grants, names and searches are compared as typed.
	test("NFKC and NFKD appear in two places only", () => {
		const users = sourceCode().filter(({ code }) => /["'`]NFK[CD]["'`]/.test(code)).map(({ path }) => path);
		expect(users.sort()).toEqual(["lib/text.ts", "lib/urlsplit.ts"]);
	});

	// Whatever its argument: a form held in a variable normalizes as well, and the default is NFC.
	test("normalize() has a short list of users", () => {
		const users = sourceCode().filter(({ code }) => /\.normalize\s*\(/.test(code)).map(({ path }) => path);
		// NFC for file names and manifest paths, NFD in IDNA's rules, NFKC above; nothing else normalizes.
		expect(users.sort()).toEqual(["files/manifest.ts", "files/names.ts", "lib/idna.ts", "lib/text.ts", "lib/urlsplit.ts"]);
	});
});
