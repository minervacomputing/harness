// The parts of the Gmail connector that Python's standard library decided, against the
// vectors generate.py wrote from today's Python (test/fixtures/connectors/google/gmail.json): input
// validation, base64, which charset labels Python's codecs had, RFC 2047 header decoding, Content-Type
// parameters, MIME bodies and attachments, address headers (the email package's parser and its defects),
// threading, raw RFC 5322 messages built under the SMTP policy (encoded words and line folding), the HTML
// converter, mail addresses and snippets. Every vector is compared exactly, except where a section lists
// the cases whose answer is now different and says why (header text, one body, CJK words, links, domains).

import { isDeepStrictEqual } from "node:util";
import { describe, expect, test } from "vitest";
import * as addresses from "../../src/lib/addresses.ts";
import { Part } from "../../src/connectors/gmail/client.ts";
import { gmailConnector } from "../../src/connectors/gmail/connector.ts";
import { a2bBase64, b64decodeUrlsafeStrict, urlsafeB64encode } from "../../src/connectors/gmail/email/base64.ts";
import { charsetKnown, decodeCharset, decodeCharsetStrictly } from "../../src/lib/charset.ts";
import { BinasciiError, IndexError, LookupError, PyTypeError, UnicodeDecodeError, UnicodeEncodeError, UnicodeError, ValueError } from "../../src/connectors/gmail/email/errors.ts";
import { messageText, rawMessage } from "../../src/connectors/gmail/email/message.ts";
import { htmlToText } from "../../src/lib/markdown.ts";
import * as mime from "../../src/connectors/gmail/mime.ts";
import { registrable } from "../../src/lib/sites.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import type { Json } from "../../src/lib/json.ts";
import { htmlUnescape, sliceText } from "../../src/lib/text.ts";
import { operation, validationOutcomes } from "../fixtures/connectors/google/runs.ts";
import { gmailVectors } from "../fixtures/connectors/google/vectors.ts";

type JsonObject = { [key: string]: Json };
type Error = { error: string };

/** generate.py `raised`: the Python exception classes a port must tell apart, most specific first. */
function raised(error: unknown): string {
	if (error instanceof UnicodeDecodeError) return "UnicodeDecodeError";
	if (error instanceof UnicodeEncodeError) return "UnicodeEncodeError";
	if (error instanceof UnicodeError) return "UnicodeError";
	if (error instanceof LookupError) return "LookupError";
	if (error instanceof ValueError) return "ValueError";
	if (error instanceof IndexError) return "IndexError";
	if (error instanceof PyTypeError) return "TypeError";
	return `other:${error instanceof globalThis.Error ? error.name : typeof error}`;
}

/** Python's `type(error).__name__` for binascii and ValueError, as base64_cases records it. */
function binasciiName(error: unknown): string {
	if (error instanceof BinasciiError) return "Error";
	if (error instanceof ValueError) return "ValueError";
	throw error;
}

function attempt<T>(call: () => T): { ok: T } | Error {
	try {
		return { ok: call() };
	} catch (error) {
		return { error: raised(error) };
	}
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `str.encode("raw-unicode-escape")`: code points below U+0100 as one byte, the rest as `\\uXXXX` or `\\UXXXXXXXX`. */
function rawUnicodeEscape(text: string): Uint8Array {
	const bytes: number[] = [];
	for (const char of text) {
		const point = char.codePointAt(0) as number;
		if (point < 0x100) bytes.push(point);
		else for (const digit of point < 0x10000 ? `\\u${point.toString(16).padStart(4, "0")}` : `\\U${point.toString(16).padStart(8, "0")}`) bytes.push(digit.charCodeAt(0));
	}
	return Uint8Array.from(bytes);
}

const vectors = gmailVectors();

describe("input validation, as Pydantic words it", () => {
	const connector = gmailConnector();
	for (const name of ["list_messages", "send_message", "create_draft", "read_message", "read_thread", "reply"]) {
		test(name, async () => {
			const cases = vectors.inputs[name];
			expect(Object.keys(cases).length).toBeGreaterThan(1);
			const { actual, expected } = await validationOutcomes(operation(connector, name), cases);
			expect(actual).toEqual(expected);
		});
	}
});

describe("base64", () => {
	test("Gmail's body padding and strict decoding, and the encoded-word decoder's lax one, as binascii does", () => {
		expect(vectors.base64.length).toBeGreaterThan(90);
		const actual: unknown[] = [];
		for (const item of vectors.base64 as { text: string; strict: string | Error; lax: string | Error }[]) {
			const padded = item.text + "=".repeat((4 - (item.text.length % 4)) % 4);
			let strict: string | Error;
			try {
				strict = hex(b64decodeUrlsafeStrict(padded));
			} catch (error) {
				strict = { error: binasciiName(error) };
			}
			const pad = item.text.length % 4;
			const laxText = item.text + (pad ? "===".slice(0, 4 - pad) : "");
			let lax: string | Error;
			try {
				lax = hex(a2bBase64(rawUnicodeEscape(laxText), false));
			} catch (error) {
				lax = { error: error instanceof BinasciiError ? "Error" : binasciiName(error) };
			}
			actual.push({ text: item.text, strict, lax });
		}
		expect(actual).toEqual(vectors.base64);
	});

	test("urlsafe encoding", () => {
		expect(urlsafeB64encode(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe("-__-");
		expect(urlsafeB64encode(Uint8Array.of(1))).toBe("AQ==");
	});
});

describe("charset labels", () => {
	const { labels, python } = vectors.charsets as { labels: string[]; python: string[] };
	const pythons = new Set(python);

	test("the Encoding Standard's labels: the strict reading, which decides address headers, takes none that Python's codecs lacked", () => {
		expect(labels.length).toBeGreaterThan(200);
		// The runtime has 67 labels Python did not (iso88591, x-cp1252, koi8-ru, ...): each was a defect in a header.
		const lacked = labels.filter((label) => charsetKnown(label) && !pythons.has(label));
		expect(lacked.length).toBe(67);
		for (const label of lacked) expect(decodeCharsetStrictly(Uint8Array.of(0x41), label), label).toBeNull();
		// The rest read plain ASCII, except the UTF-16 labels, which need whole code units.
		const utf16 = new Set(["unicodefffe", "utf-16be", "csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"]);
		for (const label of labels.filter((label) => charsetKnown(label) && pythons.has(label) && !utf16.has(label))) {
			expect(decodeCharsetStrictly(Uint8Array.of(0x41), label), label).toBe("A");
		}
	});

	test("the labels Python had and the runtime lacks are the ones with no decoder in the standard: HZ and ISO-2022-KR", () => {
		expect(python.filter((label) => !charsetKnown(label)).sort()).toEqual(["csiso2022kr", "hz-gb-2312", "iso-2022-kr"]);
	});

	test("Python's spellings of the standard's labels shown in the lenient reading, and a label the runtime lacks is unknown", () => {
		for (const label of ["latin-1", "latin_1", "iso_8859_1", "utf_8", "euc_jp", "shift_jis", "UTF-8", " utf-8 "]) {
			expect(decodeCharset(Uint8Array.of(0x61), label), label).toBe("a");
		}
		for (const label of ["x-nope", "", "idna", "base64", "hex", "rot13", "utf-7", "utf-32", "hz-gb-2312", "iso-2022-kr", "replacement"]) {
			expect(decodeCharset(Uint8Array.of(0x61), label), label).toBeNull();
		}
	});
});

describe("header text", () => {
	// Encoded words are decoded by postal-mime's `decodeWords`, which is tolerant where Python's decode_header was
	// not. Every vector of the 66 gives Python's answer except these 15, all malformed or unusual words: the
	// text read now, and what Python gave (each asserted to differ, so this table cannot go stale).
	const changed = new Map<string, string>([
		// Not valid base64 for a byte: Python raised HeaderParseError out of header_text, shown as "" here.
		["=?utf-8?b?a?=", ""],
		// Bytes the charset cannot decode are U+FFFD, not the word left as it was; a charset the runtime lacks reads as is.
		["=?utf-8?q?=FF?=", "\ufffd"],
		["=?x-unknown?q?abc?=", "abc"],
		["=?utf-8*en?q?hi?=", "hi"],
		["=?ütf-8?q?x?=", "x"],
		["=?unknown-8bit?q?a=FFb?=", "aÿb"],
		["=?utf-7?q?+AGE-?=", "+AGE-"],
		["=?base64?q?abc?=", "abc"],
		["=?us-ascii?q?=E9?=", "é"],
		["=?utf-8?q?=ED=A0=80?=", "\ufffd\ufffd\ufffd"],
		// Python gave a non-ASCII literal next to a word as \\u escapes (decode_header's raw-unicode-escape), and an
		// 8-bit word as is; the text is whole now.
		["Grüße =?utf-8?q?x?=", "Grüße x"],
		["日本 =?utf-8?q?x?=", "日本 x"],
		["=?utf-8?q?x?=日本", "x日本"],
		["=?utf-8?q?ü?=", "ü"],
		// An empty charset is no word.
		["=??q?x?=", "=??q?x?="],
	]);

	test("encoded words decoded, on one line and cut", () => {
		const cases = vectors.headers as ({ value: string | null } & ({ ok: string | null } | Error))[];
		expect(cases.length).toBe(66);
		const seen = new Set<string>();
		for (const item of cases) {
			const actual = attempt(() => mime.headerText(item.value));
			const answer = item.value === null ? undefined : changed.get(item.value);
			if (answer === undefined) {
				expect(actual, JSON.stringify(item.value)).toEqual("ok" in item ? { ok: item.ok } : { error: item.error });
			} else {
				seen.add(item.value as string);
				expect(actual, JSON.stringify(item.value)).toEqual({ ok: answer });
				expect(actual, `${JSON.stringify(item.value)} differs from Python`).not.toEqual("ok" in item ? { ok: item.ok } : { error: item.error });
			}
		}
		expect([...seen].sort()).toEqual([...changed.keys()].sort());
	});

	test("snippets are unescaped, flattened and cut at 300", () => {
		for (const item of vectors.snippets as { value: string; ok: string }[]) {
			expect(sliceText(mime.headerText(htmlUnescape(item.value)) as string, 0, 300)).toBe(item.ok);
		}
	});
});

describe("Content-Type and Content-Disposition parameters", () => {
	test("charset, disposition and start, as Message reads them", () => {
		const cases = vectors.content_type as ({ headers: { name: string; value: string }[] } & { [key: string]: unknown })[];
		const actual = cases.map((item) => {
			const part = Part.parse({ mimeType: "text/plain", headers: item.headers });
			const headers = mime.contentType(part);
			return {
				headers: item.headers,
				charset: attempt(() => headers.getContentCharset()),
				disposition: attempt(() => headers.getContentDisposition()),
				start: attempt(() => headers.getParam("start")),
			};
		});
		expect(actual).toEqual(cases);
	});
});

describe("bodies and attachments", () => {
	test("the text, whether it is incomplete, and the attachments named, for every part tree", () => {
		const cases = vectors.content as ({ part: JsonObject } & ({ ok: JsonObject } | Error))[];
		expect(cases.length).toBeGreaterThan(40);
		const actual = cases.map((item) => {
			const found = attempt(() => {
				const content = mime.content(Part.parse(item.part));
				return { text: content.text, unavailable: content.unavailable, attachments: content.attachments as unknown as Json };
			});
			return { part: item.part, ...found };
		});
		// One answer differs: a filename of an encoded word directly followed by text, no space between them (not
		// valid RFC 2047), which Python split with a space ("Résumé .txt") and postal-mime keeps whole.
		const spaced = cases.findIndex((item) => item.part.filename === "=?utf-8?q?R=C3=A9sum=C3=A9?=.txt");
		expect(spaced).toBeGreaterThanOrEqual(0);
		const expected = structuredClone(cases) as unknown as { ok: { attachments: { filename: string }[] } }[];
		const renamed = expected[spaced]?.ok.attachments[0];
		expect(renamed?.filename).toBe("Résumé .txt");
		if (renamed) renamed.filename = "Résumé.txt";
		expect(actual).toEqual(expected);
	});
});

describe("address headers", () => {
	const cases = vectors.address_headers as {
		value: string;
		mailboxes: { ok: string[] | null } | Error;
		header: { defects: number; addresses: string[][] } | Error;
	}[];

	test("mailboxes() reads them strictly", () => {
		expect(cases.length).toBeGreaterThanOrEqual(239);
		const actual = cases.map((item) => ({ value: item.value, mailboxes: attempt(() => mime.mailboxes([item.value])) }));
		expect(actual).toEqual(cases.map((item) => ({ value: item.value, mailboxes: item.mailboxes })));
	});

	test("the parser's defects and the parts of each address, as header_factory finds them", () => {
		const actual = cases.map((item) => {
			let header: JsonObject | Error;
			try {
				const parsed = mime.addressHeader(item.value);
				header = {
					defects: parsed.defects,
					addresses: parsed.parts.map(([name, user, domain], i) => [name, user, domain, parsed.specs[i] as string]),
				};
			} catch (error) {
				header = { error: raised(error) };
			}
			return { value: item.value, header };
		});
		const expected = cases.map((item) => ({
			value: item.value,
			header: "error" in item.header ? item.header : { defects: item.header.defects, addresses: item.header.addresses },
		}));
		expect(actual).toEqual(expected);
	});
});

describe("threading", () => {
	test("In-Reply-To and References", () => {
		for (const item of vectors.threading.threading as { ids: string[]; references: string[]; ok: [string, string] | null }[]) {
			expect(mime.threading(item.ids, item.references), JSON.stringify(item)).toEqual(item.ok);
		}
	});

	test("reply subjects", () => {
		for (const item of vectors.threading.subjects as { subject: string | null; ok: string }[]) {
			expect(mime.replySubject(item.subject), JSON.stringify(item)).toBe(item.ok);
		}
	});
});

describe("raw messages under the SMTP policy", () => {
	type RawCase = { call: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; in_reply_to: [string, string] | null } } & ({ ok: string } | Error);

	function check(cases: RawCase[]): void {
		for (const item of cases) {
			const message = {
				to: item.call.to,
				...(item.call.cc ? { cc: item.call.cc } : {}),
				...(item.call.bcc ? { bcc: item.call.bcc } : {}),
				subject: item.call.subject,
				body: item.call.body,
				inReplyTo: item.call.in_reply_to,
			};
			const found = attempt(() => messageText(message));
			expect(found, JSON.stringify(item.call)).toEqual("ok" in item ? { ok: item.ok } : { error: item.error });
			if ("ok" in item) {
				// What goes to Gmail is this text as base64url.
				expect(rawMessage(message)).toBe(urlsafeB64encode(Uint8Array.from(item.ok, (char) => char.charCodeAt(0))));
			}
		}
	}

	test("headers with encoded words and folded lines, a quoted-printable body, byte for byte", () => {
		expect(vectors.raw.length).toBeGreaterThan(20);
		check(vectors.raw);
	});

	test("random subjects, bodies and recipients", () => {
		expect(vectors.raw_random.length).toBeGreaterThanOrEqual(50);
		check(vectors.raw_random);
	});
});

describe("HTML to text", () => {
	test("the converter, with its title, on hand-written and random markup", () => {
		const cases = vectors.html as { html: string; text: string; title: string | null }[];
		expect(cases.length).toBeGreaterThanOrEqual(202);
		// Links are the URL parser's serialization; one it cannot read (an IPvFuture host) is its text alone.
		const serialized = (text: string) =>
			text
				.replace(/\[([^[\]]*)\]\(http:\/\/\[v1\.x\]\/\)/g, "$1")
				.replace(/\]\((https?:[^)]*)\)/gi, (_, href: string) => `](${new URL(href).href.replaceAll("(", "%28").replaceAll(")", "%29")})`);
		expect(htmlToText('<a href="http://[v1.x]/">vfuture</a>')[0]).toBe("vfuture");
		const actual = cases.map((item) => {
			const [text, title] = htmlToText(item.html);
			return { html: item.html, text, title };
		});
		expect(actual).toEqual(cases.map((item) => ({ ...item, text: serialized(item.text) })));
	});
});

describe("mail addresses", () => {
	type Outcome = { ok: unknown } | { code: string; message: string } | Error;
	function py<T>(call: () => T): Outcome {
		try {
			return { ok: call() };
		} catch (error) {
			if (error instanceof OperationError) return { code: error.code, message: error.message };
			return { error: raised(error) };
		}
	}

	// Domains are encoded by the runtime's IDNA, and refused where it would repair them (test/fixtures/hosts.ts).
	// So a case with a Unicode domain or a trailing dot has the same answer or is refused; the rest, the same answer.
	// Refused in workerd by the Bidi rule, which Node's encoder does not apply (test/platform/hosts.test.ts).
	const bidi = ["ada@a\u05d0.com", "ada@\u0661.com"];
	const repairable = (value: string) => !/^[\x00-\x7f]*$/.test(value) || /\.\s*$/.test(value);
	function check(cases: { [value: string]: Outcome }, run: (value: string) => unknown): void {
		const exact = Object.fromEntries(Object.entries(cases).filter(([value]) => !repairable(value)));
		expect(Object.keys(exact).length).toBeGreaterThan(20);
		expect(Object.fromEntries(Object.keys(exact).map((value) => [value, py(() => run(value))]))).toEqual(exact);
		const accepted = Object.entries(cases)
			.filter(([value]) => repairable(value) && !bidi.includes(value))
			.map(([value, outcome]) => [value, outcome, py(() => run(value))] as const)
			.filter(([, outcome, found]) => !isDeepStrictEqual(found, outcome) && !("code" in found && found.code === "INVALID_ADDRESS"));
		expect(accepted).toEqual([]);
	}

	test("parse", () => {
		check(vectors.addresses.parse as { [value: string]: Outcome }, addresses.parse);
	});

	test("valid_id and name", () => {
		const valid = vectors.addresses.valid_id as { [value: string]: boolean };
		expect(Object.fromEntries(Object.keys(valid).map((value) => [value, addresses.validId(value)]))).toEqual(valid);
		const names = vectors.addresses.name as { [value: string]: string };
		expect(Object.fromEntries(Object.keys(names).map((value) => [value, addresses.name(value)]))).toEqual(names);
	});

	test("choices", () => {
		check(vectors.addresses.choices as { [value: string]: Outcome }, addresses.choices);
	});

	test("registrable domains", () => {
		const registrables = vectors.addresses.registrable as { [host: string]: string | null };
		expect(Object.fromEntries(Object.keys(registrables).map((host) => [host, registrable(host)]))).toEqual(registrables);
	});
});

describe("long headers", () => {
	test("decode in about linear time, with Python's answers", () => {
		// Each would take seconds with words dropped by splicing and runs joined by copying.
		const cases: [string, string][] = [
			["=?utf-8?q?a?= ".repeat(20000), "a".repeat(2000)],
			["=?utf-8?q?a?= x ".repeat(10000), "a x ".repeat(500)],
			["=?utf-8?q?a?= =?gb2312?q?b?= ".repeat(10000), "ab".repeat(1000)],
			[`${"x ".repeat(20000)}=?utf-8?q?a?=`, "x ".repeat(1000)],
			[`=?utf-8?b?${"YWFh".repeat(50000)}?=`, "a".repeat(2000)],
		];
		const started = performance.now();
		for (const [value, shown] of cases) expect(mime.headerText(value)).toBe(shown);
		expect(performance.now() - started).toBeLessThan(1500);
	});
});

describe("addresses in CJK encoded words", () => {
	test("recipients are allowed only where every byte is cleanly the charset's, and the name is read by the runtime", () => {
		const cases: [string, string[] | null, string][] = [
			// GB 2312 is EUC-CN: a byte pair outside it (GBK has more) is refused, as Python refused it.
			["=?gb2312?b?gUA=?= <ada@example.com>", null, "\u4e02 <ada@example.com>"],
			["=?gb2312?b?1tDOxA==?= <ada@example.com>", ["ada@example.com"], "中文 <ada@example.com>"],
			["=?big5?b?pKQ=?= <ada@example.com>", ["ada@example.com"], "中 <ada@example.com>"],
			["=?euc-jp?b?pKKkpA==?= <ada@example.com>", ["ada@example.com"], "あい <ada@example.com>"],
			["=?iso-2022-jp?b?GyRCJCIbKEI=?= <ada@example.com>", ["ada@example.com"], "あ <ada@example.com>"],
			["=?shift_jis?b?gqA=?= <ada@example.com>", ["ada@example.com"], "あ <ada@example.com>"],
			["=?koi8-r?b?8NLJ18XU?= <ada@example.com>", ["ada@example.com"], "Привет <ada@example.com>"],
			["=?windows-1252?q?=80?= <ada@example.com>", ["ada@example.com"], "€ <ada@example.com>"],
			// A byte a code page leaves undefined is a defect, as in Python (the runtime reads it as a C1 control).
			["=?windows-1252?q?=81?= <ada@example.com>", null, "<ada@example.com>"],
			["=?us-ascii?q?=E9?= <ada@example.com>", null, "é <ada@example.com>"],
			["=?utf-8?q?=FF?= <ada@example.com>", null, "\ufffd <ada@example.com>"],
			["=?x-unknown?q?abc?= <ada@example.com>", null, "abc <ada@example.com>"],
			["=?unknown-8bit?q?a=FFb?= <ada@example.com>", null, "aÿb <ada@example.com>"],
			// Python's codecs decoded these, so a header with one gave recipients; the runtime has no decoder (HZ,
			// ISO-2022-KR, UTF-7), or the spelling is Python's own (latin-1, the escape codecs), so each is refused now.
			["=?hz-gb-2312?b?fntWUE5Efn0=?= <ada@example.com>", null, "~{VPND~} <ada@example.com>"],
			["=?iso-2022-kr?b?GyQpQw4wIQ8=?= <ada@example.com>", null, "$)C 0! <ada@example.com>"],
			["=?iso-2022-kr?b?G4A=?= <ada@example.com>", null, "\u20ac <ada@example.com>"],
			["=?johab?b?iGE=?= <ada@example.com>", null, "\u02c6a <ada@example.com>"],
			["=?utf-7?q?+AGE-?= <ada@example.com>", null, "+AGE- <ada@example.com>"],
			["=?latin-1?q?=E9?= <ada@example.com>", null, "é <ada@example.com>"],
			["=?unicode-escape?q?caf\\u00e9?= <ada@example.com>", null, "caf\\u00e9 <ada@example.com>"],
			["=?unicode-escape?q?=5Cud800?= <ada@example.com>", null, "\\ud800 <ada@example.com>"],
			["=?raw-unicode-escape?q?=5Cud800x?= <ada@example.com>", null, "\\ud800x <ada@example.com>"],
			["=?unicode_escape?q?=5Cud800?=", null, "\\ud800"],
		];
		for (const [value, found, shown] of cases) {
			expect(mime.mailboxes([value]), value).toEqual(found);
			expect(mime.headerText(value), value).toBe(shown);
		}
	});
});
