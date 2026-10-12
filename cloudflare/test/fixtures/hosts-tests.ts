// The cases of test/fixtures/hosts.ts as tests, for test/unit/hosts.test.ts (Node) and
// test/platform/hosts.test.ts (workerd, whose URL parser and Unicode data production uses).

import { describe, expect, test } from "vitest";
import { OperationError } from "../../src/gateway/connector.ts";
import { IdnaError, idnaEncode } from "../../src/lib/idna.ts";
import { isIpAddress } from "../../src/lib/ipaddress.ts";
import { ValueError } from "../../src/lib/pyerrors.ts";
import { parseUrl } from "../../src/lib/sites.ts";
import { IDNA_CASES, IP_CASES, UNICODE_17_POINT, UNICODE_18_POINT, URL_CASES } from "./hosts.ts";

function encoded(name: string): string | null {
	try {
		return idnaEncode(name);
	} catch (error) {
		if (error instanceof IdnaError) return null;
		throw error;
	}
}

function parsed(raw: string): readonly [string | null, string | null] {
	try {
		const url = parseUrl(raw);
		return [url.text, url.href];
	} catch (error) {
		// ValueError where Python's urlsplit raises it (a netloc that NFKC makes into another), a generic failure.
		if (error instanceof OperationError || error instanceof ValueError) return [null, null];
		throw error;
	}
}

/** Domain names in ASCII (lib/idna.ts), IP addresses as Python reads them (lib/ipaddress.ts), web addresses as shown and requested (lib/sites.ts). */
export function hostTests(): void {
	describe("domain names in ASCII", () => {
		test(`${IDNA_CASES.length} names: the runtime's mapping, IDNA 2008's rules, and raw text refused before the runtime sees it`, () => {
			const expected = Object.fromEntries(IDNA_CASES.map(([name, ascii]) => [name, ascii]));
			expect(Object.fromEntries(IDNA_CASES.map(([name]) => [name, encoded(name)]))).toEqual(expected);
		});

		test("the runtime's Unicode is 17, the version lib/idna.ts was checked for (review it, and its UNICODE_17 and RIGHT_TO_LEFT, when this fails)", () => {
			expect(/\p{Assigned}/u.test(UNICODE_17_POINT)).toBe(true);
			expect(/\p{Assigned}/u.test(UNICODE_18_POINT)).toBe(false);
		});
	});

	describe("IP addresses", () => {
		test(`${IP_CASES.length} texts: only Python's spellings are addresses`, () => {
			const expected = Object.fromEntries(IP_CASES.map(([text, family]) => [text, family]));
			expect(Object.fromEntries(IP_CASES.map(([text]) => [text, isIpAddress(text)]))).toEqual(expected);
		});
	});

	describe("web addresses", () => {
		test(`${URL_CASES.length} addresses: shown in Python's spelling, requested as the runtime serializes it, on the host authorized`, () => {
			const expected = Object.fromEntries(URL_CASES.map(([raw, text, href]) => [raw, [text, href]]));
			expect(Object.fromEntries(URL_CASES.map(([raw]) => [raw, parsed(raw)]))).toEqual(expected);
			for (const [raw, , href] of URL_CASES) if (href !== null) expect(new URL(href).hostname, raw).toBe(parseUrl(raw).host);
		});
	});
}
