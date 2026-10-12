// Names and what lib/idna.ts makes of them (null: refused), for the unit layer (Node) and the platform layer
// (workerd), since the mapping and Punycode are the runtime's. Hand-picked for the rules lib/idna.ts adds to
// the runtime's UTS #46 and for the raw text it refuses before the runtime sees it; the vectors from Python
// (test/fixtures/connectors/*) cover ordinary names.

export const IDNA_CASES: readonly (readonly [name: string, ascii: string | null, why: string])[] = [
	// Mapping, from the runtime: case, width, ideographic full stops and ignored code points.
	["Example.COM", "example.com", "ASCII is lowercased"],
	["ＥＸＡＭＰＬＥ\u3002com", "example.com", "full width and U+3002 are mapped"],
	["exa\u00admple.com", "example.com", "a soft hyphen is ignored"],
	["münchen.de", "xn--mnchen-3ya.de", "a U-label is encoded"],
	["MÜNCHEN.DE", "xn--mnchen-3ya.de", "upper case is mapped first"],
	["XN--MNCHEN-3YA.de", "xn--mnchen-3ya.de", "an A-label is kept, lowercased"],
	["straße.de", "xn--strae-oqa.de", "ß is kept (non-transitional)"],
	["ς.gr", "xn--3xa.gr", "final sigma is kept"],
	["\ufb01.com", "fi.com", "a ligature maps to letters"],
	["example.com.", "example.com.", "a trailing dot is kept"],
	// RFC 5892's derivation: what UTS #46 allows and IDNA 2008 does not.
	["☃.com", null, "a symbol is not PVALID"],
	["xn--n3h.com", null, "nor as an A-label"],
	["a\u20d0.com", null, "a mark from Combining Diacritical Marks for Symbols"],
	["\u1100.kr", null, "an old Hangul jamo"],
	["\u0640.com", null, "Arabic tatweel (an exception)"],
	["ab\u302ec.com", null, "a Hangul tone mark (an exception)"],
	["\u3007.jp", "xn--w6j.jp", "U+3007 is PVALID (an exception)"],
	// CONTEXTO.
	["col\u00b7legi.cat", "xn--collegi-xma.cat", "a middle dot between two l"],
	["a\u00b7b.com", null, "a middle dot elsewhere"],
	["\u0375α.gr", "xn--wva4j.gr", "a Greek keraia before Greek"],
	["\u0375a.gr", null, "a Greek keraia before Latin"],
	["\u05d0\u05f3.il", "xn--4db4e.il", "a geresh after Hebrew"],
	["a\u05f3.il", null, "a geresh after Latin"],
	["\u30fbカ.jp", "xn--lckxi.jp", "a katakana middle dot with kana"],
	["\u30fba.jp", null, "a katakana middle dot without"],
	["\u05d0\u0661\u06f1.com", null, "Arabic-Indic and extended Arabic-Indic digits mixed"],
	// CONTEXTJ: after a virama (read from the runtime's normalization); the joining-type rule is not kept.
	["क\u094d\u200dष.in", "xn--11b2ezcw70k.in", "a zero width joiner after a virama"],
	["क\u094d\u200cष.in", "xn--11b2ezcs70k.in", "a zero width non-joiner after a virama"],
	["\u0628\u200c\u0628.ir", null, "a zero width non-joiner between joining letters (allowed by the package)"],
	["a\u200db.com", null, "a joiner elsewhere"],
	// The Bidi rule.
	["a\u05d0.com", null, "a left-to-right label with a right-to-left letter"],
	["\u05d0a.com", null, "a right-to-left label with a left-to-right letter"],
	["\u05d01.com", "xn--1-zhc.com", "a right-to-left label may end with a European digit"],
	["1\u05d0.com", null, "but not start with one"],
	["\u05d0\u0661.com", "xn--4db40a.com", "or an Arabic-Indic one"],
	["\u05d0\u05b0.com", "xn--7cb7d.com", "marks are neutral"],
	["\u05d0-\u05d0.com", "xn----zhcb.com", "a hyphen inside"],
	["\u05d0\u02b9.com", null, "a neutral letter (Bidi class ON) counts as left to right here (allowed by the package)"],
	// Hyphens, marks and A-labels.
	["ab--cd.com", null, "hyphens in the third and fourth places"],
	["-ab.com", null, "a hyphen first"],
	["ab-.com", null, "a hyphen last"],
	["\u0301a.com", null, "a combining mark first"],
	["xn--.com", null, "an empty A-label"],
	["xn--a.com", null, "an A-label that does not decode"],
	["xn--zca-.com", null, "an A-label ending with a hyphen"],
	// Lengths.
	[`${"a".repeat(63)}.com`, `${"a".repeat(63)}.com`, "a label of 63"],
	[`${"a".repeat(64)}.com`, null, "a label of 64"],
	[`${`${"a".repeat(63)}.`.repeat(3)}${"a".repeat(61)}`, `${`${"a".repeat(63)}.`.repeat(3)}${"a".repeat(61)}`, "a name of 253"],
	[`${`${"a".repeat(63)}.`.repeat(3)}${"a".repeat(62)}`, null, "a name of 254"],
	["a..b.com", null, "an empty label"],
	// Raw text the runtime would cut short or repair: refused before it sees it.
	["example.com/evil", null, "a path (the runtime's host setter stops at it)"],
	["a@b.com", null, "userinfo"],
	["example.com:80", null, "a port"],
	["ex%61mple.com", null, "a percent-encoded letter"],
	["a%2eb.com", null, "an encoded separator"],
	["a b.com", null, "a space"],
	["a\\b.com", null, "a backslash"],
	["[::1]", null, "an IPv6 literal"],
	["a?b.com", null, "a query"],
	["a#b.com", null, "a fragment"],
	["a_b.com", null, "an underscore"],
	["a\uff0fb.com", null, "a full-width solidus, which maps to /"],
	["\u2100.com", null, "U+2100, which maps to a/c"],
	// Numbers: an IPv4 address to the runtime.
	["127.0.0.1", null, "an IPv4 address"],
	["example.123", null, "a numeric last label"],
	["example.0x1f", null, "a hexadecimal last label"],
	// Unicode 17's additions, refused as before.
	["\u{10940}.com", null, "a Sidetic letter (Unicode 17)"],
	["\u{323b0}.com", null, "a CJK ideograph from Extension J (Unicode 17)"],
];

/** A code point Unicode 17 assigns and one only Unicode 18 does: lib/idna.ts was checked for 17. */
export const UNICODE_17_POINT = "\u{10940}";
export const UNICODE_18_POINT = "\u{10ecb}";

/** Texts and their family as Python's `ipaddress.ip_address` reads them (lib/ipaddress.ts); null: not an address. */
export const IP_CASES: readonly (readonly [text: string, family: "v4" | "v6" | null])[] = [
	["127.0.0.1", "v4"],
	["0.0.0.0", "v4"],
	["255.255.255.255", "v4"],
	["169.254.169.254", "v4"],
	["256.0.0.1", null],
	["127.000.000.001", null],
	["010.0.0.1", null],
	["127.1", null],
	["0x7f.0.0.1", null],
	["0x7f000001", null],
	["2130706433", null],
	["1.2.3.4/32", null],
	[" 1.2.3.4", null],
	["١.2.3.4", null],
	["::", "v6"],
	["::1", "v6"],
	["fe80::1", "v6"],
	["fe80::1%en0", "v6"],
	["fe80::1%a-b.c", "v6"],
	["fe80::1%", null],
	["fe80::1%a%b", null],
	["fe80::1%a/b", null],
	["::ffff:127.0.0.1", "v6"],
	["::ffff:7f00:1", "v6"],
	["::ffff:010.0.0.1", null],
	["::127.0.0.1", "v6"],
	["64:ff9b::7f00:1", "v6"],
	["2002:7f00:1::1", "v6"],
	["1:2:3:4:5:6:7:8", "v6"],
	["1:2:3:4:5:6:7::", "v6"],
	["1:2:3:4:5:6:7:8:9", null],
	["1::2::3", null],
	["12345::", null],
	["::g", null],
	["[::1]", null],
	["::1/128", null],
];

/**
 * Addresses and what lib/sites.ts `parseUrl` makes of them: the text the agent is shown (Python's spelling) and
 * the runtime's serialization of it that is requested (one serialization: its host is the host authorized), or
 * null where it is refused. They differ only in the path and query, never in scheme, host or port.
 */
export const URL_CASES: readonly (readonly [raw: string, text: string | null, href: string | null])[] = [
	["https://example.com", "https://example.com/", "https://example.com/"],
	["HTTPS://Example.COM:443/a?b=1", "https://example.com/a?b=1", "https://example.com/a?b=1"],
	["http://example.com:80/", "http://example.com/", "http://example.com/"],
	["https://münchen.de/ä", "https://xn--mnchen-3ya.de/%C3%A4", "https://xn--mnchen-3ya.de/%C3%A4"],
	["https://example.com./x", "https://example.com/x", "https://example.com/x"],
	["https://example.com:/", "https://example.com/", "https://example.com/"],
	// The runtime removes dot segments (also encoded ones) and encodes a quote in the query, on the same host.
	["https://example.com/a/../b?q='x'", "https://example.com/a/../b?q='x'", "https://example.com/b?q=%27x%27"],
	["https://example.com/a/%2e%2e/b", "https://example.com/a/%2e%2e/b", "https://example.com/b"],
	["https://example.com/a#frag", "https://example.com/a", "https://example.com/a"],
	["https://example.com/@evil.example.org", "https://example.com/@evil.example.org", "https://example.com/@evil.example.org"],
	// Refused before anything is requested.
	["https://user@example.com/", null, null],
	["https://@example.com/", null, null],
	["https://user:pass@example.com/", null, null],
	["https://example.com:8443/", null, null],
	["https://example.com\\@evil.example.org/", null, null],
	["https://example.com%2f@evil.example.org/", null, null],
	["https://ex%61mple.com/", null, null],
	["https://example.com%2eevil.example.org/", null, null],
	["https://evil.example.org／@example.com/", null, null],
	["https://example.com\t/", null, null],
	["https://127.0.0.1/", null, null],
	["https://127.1/", null, null],
	["https://0x7f.0.0.1/", null, null],
	["https://2130706433/", null, null],
	["https://[::1]/", null, null],
	["https://[::ffff:127.0.0.1]/", null, null],
	["https://[::ffff:7f00:1]/", null, null],
	["https://localhost/", null, null],
	["https://metadata.google.internal/", null, null],
	["https://example.123/", null, null],
	["ftp://example.com/", null, null],
	["//example.com/", null, null],
];
