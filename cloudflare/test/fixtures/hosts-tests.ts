// The cases of test/fixtures/hosts.ts as tests, for test/unit/hosts.test.ts (Node) and
// test/platform/hosts.test.ts (workerd, whose URL parser and IDNA production uses).

import { describe, expect, test } from "vitest";
import { OperationError } from "../../src/gateway/connector.ts";
import { MAX_URL, canonicalHost, parseUrl } from "../../src/lib/sites.ts";
import { HOST_CASES, REDIRECT_CASES, URL_CASES } from "./hosts.ts";

function refusedAsNull<T>(run: () => T): T | null {
	try {
		return run();
	} catch (error) {
		if (error instanceof OperationError && error.code === "INVALID_URL") return null;
		throw error;
	}
}

/** The message parseUrl refuses an address with. */
function message(raw: string): string | null {
	try {
		parseUrl(raw);
		return null;
	} catch (error) {
		if (error instanceof OperationError) return error.message;
		throw error;
	}
}

/** Host names (`canonicalHost`) and web addresses (`parseUrl`), alone and as redirects. */
export function hostTests(): void {
	describe("host names", () => {
		test(`${HOST_CASES.length} names: canonical, or refused where the runtime would repair what was written`, () => {
			const expected = Object.fromEntries(HOST_CASES.map(([raw, host, why]) => [`${raw} (${why})`, host]));
			expect(Object.fromEntries(HOST_CASES.map(([raw, , why]) => [`${raw} (${why})`, refusedAsNull(() => canonicalHost(raw))]))).toEqual(expected);
		});

		test("names under .example are accepted only where reserved names are", () => {
			expect(canonicalHost("Mail.Example", true)).toBe("mail.example");
			expect(refusedAsNull(() => canonicalHost("mail.example"))).toBeNull();
			expect(refusedAsNull(() => canonicalHost("localhost", true))).toBeNull();
		});

		test("an IP address is refused as one", () => {
			for (const raw of ["127.1", "0x7f.0.0.1", "[::ffff:127.0.0.1]", "2130706433"]) {
				expect(() => canonicalHost(raw), raw).toThrow("Use the site's domain name, not an IP address.");
			}
		});
	});

	describe("web addresses", () => {
		test(`${URL_CASES.length} addresses: requested as the runtime serializes them, on the host authorized`, () => {
			const expected = Object.fromEntries(URL_CASES.map(([raw, href]) => [raw, href]));
			expect(Object.fromEntries(URL_CASES.map(([raw]) => [raw, refusedAsNull(() => parseUrl(raw).href)]))).toEqual(expected);
			for (const [raw, href] of URL_CASES) if (href !== null) expect(new URL(href).hostname, raw).toBe(parseUrl(raw).host);
		});

		test(`${REDIRECT_CASES.length} redirects: each Location checked as a new address`, () => {
			const expected = Object.fromEntries(REDIRECT_CASES.map(([location, base, href]) => [`${location} from ${base}`, href]));
			const found = Object.fromEntries(REDIRECT_CASES.map(([location, base]) => [`${location} from ${base}`, refusedAsNull(() => parseUrl(location, parseUrl(base)).href)]));
			expect(found).toEqual(expected);
		});

		test("each refusal says why", () => {
			expect(message("https://user@example.com/")).toBe("Web addresses with a user name or password are not allowed.");
			expect(message("https://example.com:8443/")).toBe("Only web addresses on the standard ports can be opened.");
			expect(message("https://example.com:44a/")).toBe("This web address has an invalid port.");
			expect(message("ftp://example.com/")).toBe("Only http and https web addresses can be opened.");
			expect(message("https://[::1]/")).toBe("Use the site's domain name, not an IP address.");
			expect(message("https://example.com /")).toBe("This web address contains characters that are not allowed.");
		});

		test(`addresses of up to ${MAX_URL} characters`, () => {
			const at = (length: number) => `https://example.com/${"a".repeat(length - "https://example.com/".length)}`;
			expect(parseUrl(at(MAX_URL)).href).toBe(at(MAX_URL));
			expect(message(at(MAX_URL + 1))).toBe("This web address contains characters that are not allowed.");
		});
	});
}
