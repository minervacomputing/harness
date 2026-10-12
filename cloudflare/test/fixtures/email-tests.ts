// What the Gmail connector's mail code leaves to the runtime's TextDecoder (lib/charset.ts) and to postal-mime
// (its RFC 2047 decoder, `decodeWords`), and what it keeps strict, as tests for test/unit/email.test.ts (Node)
// and test/platform/email.test.ts (workerd, whose TextDecoder and encodings production uses).
//
// The security cases are explicit here: a tolerant reader (postal-mime's `addressParser` and `parse`) must
// never decide who a reply or message goes to, and a header value must never end a header line.

import PostalMime, { addressParser } from "postal-mime";
import { describe, expect, test } from "vitest";
import { Part } from "../../src/connectors/gmail/client.ts";
import * as mime from "../../src/connectors/gmail/mime.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import * as addresses from "../../src/lib/addresses.ts";
import { charsetKnown, decodeCharset, decodeCharsetStrictly } from "../../src/lib/charset.ts";
import { ValueError } from "../../src/lib/pyerrors.ts";

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.replaceAll(" ", "").match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function base64url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64(data: Uint8Array): string {
	return btoa(String.fromCharCode(...data));
}

function fromBase64url(text: string): Uint8Array {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** [label, bytes, the text]: charsets the tests of the connector use, CJK included, as the runtime reads them. */
const CHARSETS: [string, string, string][] = [
	["utf-8", "c3a9 e697a5", "é日"],
	["UTF-8", "c3a9", "é"],
	[" utf-8 ", "c3a9", "é"],
	// A byte order mark is not text.
	["utf-8", "efbbbf 61", "a"],
	// The Latin-1 labels, and US-ASCII's, are windows-1252 to the Encoding Standard (and to browsers).
	["iso-8859-1", "e9", "é"],
	["iso-8859-1", "80", "€"],
	["latin1", "e9", "é"],
	["us-ascii", "e9", "é"],
	["windows-1252", "80", "€"],
	// Python's spellings, which the standard lacks, are read as the standard's.
	["latin-1", "e9", "é"],
	["iso_8859_1", "e9", "é"],
	["iso-8859-2", "b1", "ą"],
	["iso-8859-7", "e1", "α"],
	["iso-8859-15", "a4", "€"],
	["windows-1250", "b9", "ą"],
	["windows-1251", "cff0e8e2e5f2", "Привет"],
	["windows-1255", "e0", "א"],
	["koi8-r", "f0d2c9d7c5d4", "Привет"],
	["tis-620", "a1", "ก"],
	["macintosh", "8a", "ä"],
	["gb2312", "d6d0 cec4", "中文"],
	["gbk", "b0a1", "啊"],
	["gb18030", "d6d0 cec4", "中文"],
	["big5", "a4a4 a4e5", "中文"],
	["shift_jis", "82a0 82a2", "あい"],
	["sjis", "82a0", "あ"],
	["windows-31j", "82a0", "あ"],
	["euc-jp", "a4a2 a4a4", "あい"],
	["iso-2022-jp", "1b2442 2422 2424 1b2842", "あい"],
	["euc-kr", "b0a1", "가"],
	["utf-16le", "6100 e900", "aé"],
	["utf-16be", "0061 00e9", "aé"],
	["utf-16", "6100", "a"],
];

/** Labels with no decoder in the runtime: HZ, ISO-2022-KR/-CN, UTF-7 and UTF-32 are not in the Encoding Standard, nor are Python's binary codecs. */
const NO_DECODER = ["hz-gb-2312", "iso-2022-kr", "iso-2022-cn", "utf-7", "utf-32", "replacement", "x-nope", "idna", "punycode", "base64", "hex", "rot13", "unicode-escape", "raw-unicode-escape", ""];

/** Header values a tolerant parser reads an address out of, and the strict one refuses. */
const RECOVERABLE = [
	"Grace <grace@example.com",
	"a@b.com <c@d.com>",
	"a@example.com, bad",
	"evil@x.com, <grace@example.com",
	"grace@example.com; evil@x.com",
	"Grace <grace@example.com>, <>",
	'"Grace <evil@x.com>" grace@example.com',
	"<grace@example.com> <evil@x.com>",
	"Grace <grace@example.com> junk",
	"grace@example.com evil@x.com",
	"grace@example.com@evil.org",
	"grace@@example.com",
	"grace@example.com\r\nBcc: evil@x.com",
	"Grace\r\n <grace@example.com>",
];

/** The strict reading's answer for what the tolerant one also reads. */
const ORDINARY: [string, string[]][] = [
	["Grace <Grace@Example.com>", ["grace@example.com"]],
	['"a@b.com" <evil@x.com>', ["evil@x.com"]],
	["=?utf-8?q?Gr=C3=A4ce?= <grace@example.com>", ["grace@example.com"]],
	["Team: a@example.com, b@example.com;", ["a@example.com", "b@example.com"]],
	["grace@example.com (evil@x.com)", ["grace@example.com"]],
];

function mailPart(mimeType: string, text: string, charset = "utf-8", headers: { name: string; value: string }[] = []) {
	return {
		mimeType,
		headers: [{ name: "Content-Type", value: `${mimeType}; charset=${charset}` }, ...headers],
		body: { size: text.length, data: base64url(new TextEncoder().encode(text)) },
	};
}

function multipart(mimeType: string, parts: object[], headers: { name: string; value: string }[] = []) {
	return Part.parse({ mimeType, headers, parts });
}

export function emailTests(): void {
	describe("charsets", () => {
		test(`${CHARSETS.length} charsets, CJK included, are read by the runtime as the Encoding Standard says`, () => {
			const actual = CHARSETS.map(([label, hex]) => decodeCharset(bytes(hex), label));
			expect(actual).toEqual(CHARSETS.map(([, , text]) => text));
		});

		test("undecodable bytes are replaced by U+FFFD, never thrown", () => {
			expect(decodeCharset(Uint8Array.of(0xff, 0x61), "utf-8")).toBe("�a");
			expect(decodeCharset(Uint8Array.of(0xe3, 0x81), "utf-8")).toBe("�");
			expect(decodeCharset(Uint8Array.of(0x81), "shift_jis")).toBe("�");
			expect(decodeCharset(Uint8Array.of(0x61), "utf-16le")).toBe("�");
		});

		test("a label the runtime lacks is unknown, so a body in it is read as UTF-8", () => {
			for (const label of NO_DECODER) {
				expect(charsetKnown(label), label).toBe(false);
				expect(decodeCharset(Uint8Array.of(0x61), label), label).toBeNull();
			}
			const body = (charset: string) => Part.parse(mailPart("text/plain", "Grüße", charset));
			for (const label of ["x-nope", "hz-gb-2312", "utf-7", "idna", "base64", "hex", ""]) expect(mime.content(body(label)).text, label).toBe("Grüße");
			// ... while a label it has reads the bytes as that charset (windows-1252 for the Latin-1 labels).
			expect(mime.content(body("iso-8859-1")).text).toBe(new TextDecoder("windows-1252").decode(new TextEncoder().encode("Grüße")));
		});

		test("the strict reading, for the display name of a recipient, decodes only clean bytes", () => {
			const clean: [string, string, string][] = [
				["utf-8", "c3a9", "é"],
				["windows-1252", "80", "€"],
				["iso-8859-1", "e9", "é"],
				["koi8-r", "f0d2c9d7c5d4", "Привет"],
				["gb2312", "d6d0 cec4", "中文"],
				["big5", "a4a4", "中"],
				["shift_jis", "82a0", "あ"],
				["euc-jp", "a4a2", "あ"],
				["iso-2022-jp", "1b2442 2422 1b2842", "あ"],
				["euc-kr", "b0a1", "가"],
				["utf-16le", "6100", "a"],
				["gb18030", "81308b38", "Ā"],
				["iso-8859-11", "a0", "\u00a0"],
				["windows-1255", "e0", "א"],
			];
			expect(clean.map(([label, hex]) => decodeCharsetStrictly(bytes(hex), label))).toEqual(clean.map(([, , text]) => text));
			// Empty is text, whatever the label (the parser never decodes it).
			expect(decodeCharsetStrictly(new Uint8Array(), "x-nope")).toBe("");
		});

		test("the strict reading refuses bytes the charset does not cleanly hold, and labels Python's registry lacked", () => {
			const refused: [string, string][] = [
				// Not valid in the charset.
				["utf-8", "ff"],
				["utf-8", "e381"],
				["utf-8", "eda080"],
				["shift_jis", "82"],
				["big5", "a4"],
				["euc-kr", "b0"],
				["utf-16le", "61"],
				// A byte beyond 7 bits is not US-ASCII, whatever windows-1252 would make of it.
				["us-ascii", "e9"],
				["ascii", "e9"],
				["ansi_x3.4-1968", "80"],
				// GBK has pairs GB 2312 lacks.
				["gb2312", "8140"],
				["gb2312", "81 40"],
				["chinese", "a1a0"],
				["gb2312", "d6"],
				// A byte a code page leaves undefined reads as a C1 control: it was a defect.
				["windows-1252", "81"],
				["iso-8859-1", "9d"],
				["windows-1251", "98"],
				["windows-1253", "aa"],
				["windows-1254", "8f"],
				// Bytes Python's code page left undefined, which the standard gives a character (U+05BA, U+00A0).
				["windows-1255", "ca"],
				["cp1255", "ca"],
				["tis-620", "a0"],
				// GBK has no lone 0x80 (the standard's euro sign) and no four-byte sequences in Python.
				["gbk", "80"],
				["gb18030", "80"],
				["gbk", "81308b38"],
				["gbk", "61 81"],
				// No decoder in the runtime (Python decoded these).
				["hz-gb-2312", "7e7b 5650 4e44 7e7d"],
				["iso-2022-kr", "1b242943 0e 3021"],
				["utf-7", "2b414745 2d"],
				["utf-32", "61000000"],
				["johab", "8861"],
				["unicode-escape", "61"],
				["x-nope", "61"],
				// Labels the Encoding Standard has and Python's registry lacked.
				["iso88591", "61"],
				["x-cp1252", "61"],
				["koi8-ru", "61"],
				["mac", "61"],
				["unicode-1-1-utf-8", "61"],
				["x-user-defined", "61"],
				["cn-big5", "61"],
				["visual", "61"],
			];
			expect(refused.map(([label, hex]) => [label, hex, decodeCharsetStrictly(bytes(hex), label)])).toEqual(refused.map(([label, hex]) => [label, hex, null]));
		});

		test("a label's case and surrounding space do not change the strict reading", () => {
			expect(decodeCharsetStrictly(bytes("c3a9"), " UTF-8\t")).toBe("é");
			expect(decodeCharsetStrictly(bytes("e9"), "US-ASCII")).toBeNull();
			expect(decodeCharsetStrictly(bytes("8140"), "GB2312")).toBeNull();
			expect(decodeCharsetStrictly(bytes("61"), "X-CP1252")).toBeNull();
		});

		test("a byte order mark: dropped from shown text, kept as text by the strict reading", () => {
			expect(decodeCharset(bytes("efbbbf 61"), "utf-8")).toBe("a");
			expect(decodeCharsetStrictly(bytes("efbbbf 61"), "utf-8")).toBe("\ufeffa");
			expect(decodeCharset(bytes("fffe 6100"), "utf-16le")).toBe("a");
			expect(decodeCharsetStrictly(bytes("fffe 6100"), "utf-16le")).toBe("\ufeffa");
			// A byte order mark at the start of a local part must not vanish and leave a valid address.
			expect(mime.mailboxes(["=?utf-8?q?=EF=BB=BFada?= @example.com"])).toBeNull();
			expect(mime.mailboxes(["=?utf-8?q?=EF=BB=BFAda?= <ada@example.com>"])).toEqual(["ada@example.com"]);
		});

		test('the label "utf-16" reads a byte order mark for the byte order, as Python does, in both readings', () => {
			for (const hex of ["feff 0048 0069", "fffe 4800 6900", "4800 6900"]) {
				expect(decodeCharset(bytes(hex), "utf-16"), hex).toBe("Hi");
				expect(decodeCharsetStrictly(bytes(hex), "utf-16"), hex).toBe("Hi");
				expect(decodeCharsetStrictly(bytes(hex), "UTF-16 "), hex).toBe("Hi");
			}
			// Only the first mark is the byte order; a second is text (U+FEFF, or U+FFFE, which is not a character).
			expect(decodeCharset(bytes("fffe fffe 6100"), "utf-16")).toBe("\ufeffa");
			expect(decodeCharsetStrictly(bytes("fffe fffe 6100"), "utf-16")).toBe("\ufeffa");
			// ... and Python's other spelling of the label reads the mark too.
			expect(decodeCharset(bytes("feff 0048 0069"), "utf_16")).toBe("Hi");
			expect(decodeCharsetStrictly(bytes("feff 0048 00"), "utf-16")).toBeNull();
			expect(decodeCharsetStrictly(bytes("feff"), "utf-16")).toBe("");
			const body = Part.parse({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-16" }], body: { size: 6, data: base64url(bytes("feff 0048 0069")) } });
			expect(mime.content(body).text).toBe("Hi");
			expect(mime.mailboxes(["=?utf-16?b?/v8ASABp?= <ada@example.com>"])).toEqual(["ada@example.com"]);
		});

		test("a label is trimmed and matched in linear time, and one longer than any label is none", () => {
			expect(decodeCharset(bytes("c3a9"), "\t\n\f\r utf-8 \r\n")).toBe("é");
			expect(decodeCharset(bytes("c3a9"), `${" ".repeat(100_000)}utf-8${" ".repeat(100_000)}`)).toBe("é");
			const started = performance.now();
			for (const label of [`x${" ".repeat(200_000)}x`, `${" ".repeat(200_000)}x`, `x${"\t".repeat(200_000)}`, "x".repeat(5_000_000), `${"utf-8".padEnd(80, "-")}`]) {
				expect(decodeCharset(bytes("61"), label)).toBeNull();
				expect(decodeCharsetStrictly(bytes("61"), label)).toBeNull();
				expect(charsetKnown(label)).toBe(false);
			}
			// Through a Content-Type: a charset parameter the size of a header is read as UTF-8.
			const long = Part.parse({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: `text/plain; charset="x${" ".repeat(60_000)}x"` }], body: { size: 1, data: "YQ" } });
			expect(mime.content(long).text).toBe("a");
			expect(performance.now() - started).toBeLessThan(1500);
		});

		test("an encoded word in a charset the strict reading refuses is a defect, so the address header is refused", () => {
			const refused = [
				"=?gb2312?b?gUA=?= <ada@example.com>",
				"=?hz-gb-2312?b?fntWUE5Efn0=?= <ada@example.com>",
				"=?iso-2022-kr?b?GyQpQw4wIQ8=?= <ada@example.com>",
				"=?utf-7?q?+AGE-?= <ada@example.com>",
				"=?us-ascii?q?=E9?= <ada@example.com>",
				"=?windows-1252?q?=81?= <ada@example.com>",
				"=?x-unknown?q?abc?= <ada@example.com>",
				"=?iso88591?q?abc?= <ada@example.com>",
				"=?utf-8?q?=FF?= <ada@example.com>",
			];
			for (const value of refused) {
				expect(mime.addressHeader(value).defects, value).toBeGreaterThan(0);
				expect(mime.mailboxes([value]), value).toBeNull();
			}
			const accepted = ["=?gb2312?b?1tDOxA==?= <ada@example.com>", "=?iso-8859-1?q?caf=E9?= <ada@example.com>", "=?utf-8?q??= <ada@example.com>", "=?x-nope?q??= <ada@example.com>"];
			for (const value of accepted) expect(mime.mailboxes([value]), value).toEqual(["ada@example.com"]);
		});

		test("header text decodes encoded words in several charsets", () => {
			const text = mime.headerText("=?utf-8?q?Gr=C3=BC=C3=9Fe?= =?iso-8859-1?q?caf=E9?= =?gb2312?b?1tDOxA==?= =?koi8-r?b?8NLJ18XU?= =?shift_jis?b?gqCCog==?= =?big5?b?pKSk5Q==?=");
			// Encoded words separated by white space only are joined, as RFC 2047 says.
			expect(text).toBe("Grüßecafé中文Приветあい中文");
		});
	});

	describe("header injection", () => {
		const base = { to: ["grace@example.com"], subject: "Plans", body: "Hi", inReplyTo: null };

		test("a line break, or any character Python's splitlines breaks on, in a header value is refused", () => {
			const breaks = ["\r\n", "\n", "\r", "\u000b", "\u000c", "\u001c", "\u001d", "\u001e", "\u0085", " ", " "];
			for (const lineBreak of breaks) {
				const value = `x${lineBreak}Bcc: evil@example.net`;
				const label = JSON.stringify(value);
				expect(() => mime.raw({ ...base, subject: value }), `subject ${label}`).toThrow(ValueError);
				expect(() => mime.raw({ ...base, to: [`grace@example.com${lineBreak}Bcc: evil@example.net`] }), `to ${label}`).toThrow(ValueError);
				expect(() => mime.raw({ ...base, cc: [`grace@example.com${lineBreak}Bcc: evil@example.net`] }), `cc ${label}`).toThrow(ValueError);
				expect(() => mime.raw({ ...base, bcc: [`grace@example.com${lineBreak}Bcc: evil@example.net`] }), `bcc ${label}`).toThrow(ValueError);
				expect(() => mime.raw({ ...base, inReplyTo: [`<a@x>${lineBreak}Bcc: evil@example.net`, "<a@x>"] }), `in-reply-to ${label}`).toThrow(ValueError);
			}
		});

		test("recipient addresses with a line break or NUL are not addresses, so they never reach the composer", () => {
			for (const tail of ["\r\nBcc: evil@example.net", "\nBcc: evil@example.net", "\u0000Bcc: evil@example.net", " Bcc: evil@example.net"]) {
				expect(() => addresses.parse(`grace@example.com${tail}`), JSON.stringify(tail)).toThrow(OperationError);
			}
		});

		test("a message read back by postal-mime has exactly the headers composed, and the recipients given", async () => {
			const subject = `${"Grüße aus Zürich, ".repeat(8)}日本語`;
			const raw = mime.raw({
				to: ["grace@example.com", "ada@example.org"],
				cc: ["x@example.com"],
				subject,
				body: "Line one\nLíne two",
				inReplyTo: ["<orig@x>", "<a@x> <orig@x>"],
			});
			const parsed = await PostalMime.parse(fromBase64url(raw));
			expect(parsed.headers.map((header) => header.key)).toEqual(["to", "cc", "subject", "in-reply-to", "references", "content-type", "content-transfer-encoding", "mime-version"]);
			expect(parsed.subject).toBe(subject);
			expect(parsed.to?.map((address) => address.address)).toEqual(["grace@example.com", "ada@example.org"]);
			expect(parsed.cc?.map((address) => address.address)).toEqual(["x@example.com"]);
			expect(parsed.bcc).toBeUndefined();
			expect(parsed.from).toBeUndefined();
			expect([parsed.inReplyTo, parsed.references]).toEqual(["<orig@x>", "<a@x> <orig@x>"]);
			expect(parsed.text).toBe("Line one\nLíne two\n");
		});

		test("a subject of the original's, flattened to one line, adds no header when read back", async () => {
			const original = "Hi\r\nBcc: evil@example.net\r\n\r\nInjected body";
			const subject = mime.replySubject(original);
			expect(subject).toBe("Re: Hi Bcc: evil@example.net Injected body");
			const parsed = await PostalMime.parse(fromBase64url(mime.raw({ ...base, subject })));
			expect(parsed.headers.map((header) => header.key)).toEqual(["to", "subject", "content-type", "content-transfer-encoding", "mime-version"]);
			expect(parsed.bcc).toBeUndefined();
			expect(parsed.subject).toBe(subject);
			expect(parsed.text).toBe("Hi\n");
			// Header text for display is one line however the header was built.
			expect(mime.headerText("a\r\nBcc: x y\u0085z\tw")).toBe("a Bcc: x y z w");
		});

		test("a body that looks like headers stays a body", async () => {
			const parsed = await PostalMime.parse(fromBase64url(mime.raw({ ...base, body: "Bcc: evil@example.net\n\nTo: evil@example.net\r\nSubject: x" })));
			expect(parsed.bcc).toBeUndefined();
			expect(parsed.to?.map((address) => address.address)).toEqual(["grace@example.com"]);
			expect(parsed.subject).toBe("Plans");
			expect(parsed.text).toBe("Bcc: evil@example.net\n\nTo: evil@example.net\nSubject: x\n");
		});

		test("an encoded word is not decoded into a line break in the header text the model reads", () => {
			expect(mime.headerText("=?utf-8?q?a=0D=0ABcc:_evil=40example.net?=")).toBe("a Bcc: evil@example.net");
			expect(mime.headerText("=?utf-8?b?YQ0KQmNjOiBldmls?=")).toBe("a Bcc: evil");
		});
	});

	describe("conflicting and damaged Reply-To and From", () => {
		test("a header that appears twice is refused, whether or not the values agree", () => {
			expect(mime.mailboxes(["evil@example.net", "grace@example.com"])).toBeNull();
			expect(mime.mailboxes(["grace@example.com", "grace@example.com"])).toBeNull();
			expect(mime.mailboxes([])).toBeNull();
			expect(mime.mailboxes(["grace@example.com"])).toEqual(["grace@example.com"]);
		});

		test("postal-mime merges two Reply-To headers into one list of recipients; the strict reading refuses the pair", async () => {
			const raw = ["From: Grace <grace@example.com>", "Reply-To: evil@example.net", "Reply-To: grace@example.com", "To: me@example.org", "Subject: x", "", "body", ""].join("\r\n");
			const parsed = await PostalMime.parse(raw);
			expect(parsed.replyTo?.map((address) => address.address)).toEqual(["evil@example.net", "grace@example.com"]);
			const values = parsed.headers.filter((header) => header.key === "reply-to").map((header) => header.value);
			expect(values).toEqual(["evil@example.net", "grace@example.com"]);
			expect(mime.mailboxes(values)).toBeNull();
		});

		test("a Reply-To and a From that disagree are not merged: the connector asks only Reply-To, and refuses it when it is damaged", () => {
			expect(mime.mailboxes(["Evil <evil@example.net>"])).toEqual(["evil@example.net"]);
			expect(mime.mailboxes(["Evil <evil@example.net"])).toBeNull();
		});
	});

	describe("encoded words inside an address", () => {
		test("are refused, though Python decoded them into the address", () => {
			const inside = [
				"ada@=?utf-8?q?example.com?=",
				"ada@=?utf-8?q?=EF=BB=BFexample.com?=",
				"ada@=?gb2312?q?=A2=A1.example?=",
				"=?utf-8?q?ada?=@example.com",
				"<=?utf-8?q?ada?=@example.com>",
				"Ada <ada@=?utf-8?q?example.com?=>",
				"ada@=?utf-16?b?/v8AZQB4AGEAbQBwAGwAZQAuAGMAbwBt?=",
			];
			for (const value of inside) {
				expect(mime.addressHeader(value).encodedAddress, value).toBe(true);
				expect(mime.mailboxes([value]), value).toBeNull();
			}
			// ... while one in a display name, where RFC 2047 allows it, is an ordinary header.
			for (const value of ["=?utf-8?q?Ada?= <ada@example.com>", "Ada =?utf-8?q?L=C3=B6velace?= <ada@example.com>", "ada@example.com (=?utf-8?q?Ada?=)"]) {
				expect(mime.addressHeader(value).encodedAddress, value).toBe(false);
				expect(mime.mailboxes([value]), value).toEqual(["ada@example.com"]);
			}
		});

		test("the address a header names is the address it is authorized and sent for, whatever the display name decodes to", () => {
			for (const charset of ["gb2312", "gbk", "big5", "shift_jis", "euc-jp", "euc-kr", "iso-2022-jp", "koi8-r", "windows-1252", "utf-8"]) {
				const value = `=?${charset}?q?=A2=A1?= <ada@example.com>`;
				expect(mime.mailboxes([value]) ?? ["ada@example.com"], value).toEqual(["ada@example.com"]);
			}
		});
	});

	describe("recipient recovery is refused", () => {
		test(`${RECOVERABLE.length} damaged headers: postal-mime reads an address from each, the strict reading none`, () => {
			for (const value of RECOVERABLE) {
				const tolerant = addressParser(value).flatMap((entry) => [entry.address ?? "", ...(entry.group?.map((member) => member.address) ?? [])]);
				expect(tolerant.some((address) => address.includes("@")), `postal-mime reads an address from ${JSON.stringify(value)}`).toBe(true);
				expect(mime.mailboxes([value]), JSON.stringify(value)).toBeNull();
				expect(mime.mailboxes([value, value]), JSON.stringify(value)).toBeNull();
			}
		});

		test("ordinary headers read the same under both parsers", () => {
			for (const [value, expected] of ORDINARY) {
				expect(mime.mailboxes([value]), value).toEqual(expected);
				const tolerant = addressParser(value).flatMap((entry) => (entry.group ? entry.group.map((member) => member.address) : [entry.address]));
				expect(tolerant.map((address) => (address ?? "").toLowerCase()), value).toEqual(expected);
			}
		});

		test("an address Minerva does not accept is refused whatever the header looks like", () => {
			for (const value of ["grace@localhost", "grace", "<>", "undisclosed-recipients:;", "Grace <grace@example.com>, bad", "grace@example.com, Ada <ada@example.org> (x"]) {
				expect(mime.mailboxes([value]), value).toBeNull();
			}
		});
	});

	describe("multipart selection", () => {
		const text = (value: string) => mailPart("text/plain", value);
		const html = (value: string) => mailPart("text/html", value);

		test("plain text is preferred in an alternative, wherever it is; otherwise the last, richest part", () => {
			expect(mime.content(multipart("multipart/alternative", [text("Plain"), html("<p>Rich</p>")])).text).toBe("Plain");
			expect(mime.content(multipart("multipart/alternative", [html("<p>Rich</p>"), text("Plain")])).text).toBe("Plain");
			expect(mime.content(multipart("multipart/alternative", [html("<p>First</p>"), html("<p>Last</p>")])).text).toBe("Last");
		});

		test("what is attached, or attached as a message, is named and never read", () => {
			const secret = "SECRET merger";
			const named = { ...text(secret), filename: "notes.txt" };
			const inline = { ...text(secret), headers: [{ name: "Content-Disposition", value: 'attachment; filename="a.txt"' }] };
			const forwarded = { mimeType: "message/rfc822", headers: [], body: { size: 20 }, parts: [text(secret)] };
			const found = mime.content(multipart("multipart/mixed", [text("Body"), named, inline, forwarded]));
			expect(found.text).toBe("Body");
			expect(JSON.stringify(found)).not.toContain(secret);
			expect(found.attachments.map((attachment) => attachment.mime_type)).toEqual(["text/plain", "text/plain", "message/rfc822"]);
		});

		test("a related message shows its root, the start part or else the first, never a resource", () => {
			const resource = { ...text("SECRET resource"), headers: [{ name: "Content-ID", value: "<res@x>" }] };
			const root = { ...html("<p>Root</p>"), headers: [{ name: "Content-ID", value: "<root@x>" }] };
			const start = [{ name: "Content-Type", value: 'multipart/related; start="<root@x>"' }];
			expect(mime.content(multipart("multipart/related", [resource, root], start)).text).toBe("Root");
			expect(mime.content(multipart("multipart/related", [root, resource])).text).toBe("Root");
		});

		test("postal-mime reads a raw message more widely than the connector does: its text, html and attachments", async () => {
			const raw = [
				"Content-Type: multipart/mixed; boundary=outer",
				"",
				"--outer",
				"Content-Type: multipart/alternative; boundary=inner",
				"",
				"--inner",
				"Content-Type: text/plain",
				"",
				"Plain",
				"--inner",
				"Content-Type: text/html",
				"",
				"<p>Rich</p>",
				"--inner--",
				"--outer",
				"Content-Type: text/plain",
				'Content-Disposition: attachment; filename="notes.txt"',
				"",
				"SECRET merger",
				"--outer--",
				"",
			].join("\r\n");
			const parsed = await PostalMime.parse(raw);
			expect([parsed.text?.trim(), parsed.html?.trim()]).toEqual(["Plain", "<p>Rich</p>"]);
			expect(parsed.attachments.map((attachment) => attachment.filename)).toEqual(["notes.txt"]);
		});
	});

	describe("size limits", () => {
		test("parts, depth and attachments are bounded, and a body Gmail keeps apart is unavailable", () => {
			const text = mailPart("text/plain", "x");
			const many = mime.content(multipart("multipart/mixed", Array.from({ length: 250 }, () => text)));
			expect(many.unavailable).toBe(true);
			expect(many.parts).toBeGreaterThan(mime.MAX_PARTS);
			let nested: object = text;
			for (let i = 0; i < mime.MAX_DEPTH + 2; i++) nested = { mimeType: "multipart/mixed", headers: [], parts: [nested] };
			expect(mime.content(Part.parse(nested)).unavailable).toBe(true);
			const attachments = mime.content(multipart("multipart/mixed", Array.from({ length: 40 }, (_, n) => ({ mimeType: "application/pdf", filename: `f${n}.pdf`, headers: [], body: { size: n } }))));
			expect(attachments.attachments).toHaveLength(mime.MAX_ATTACHMENTS);
			const apart = mime.content(Part.parse({ mimeType: "text/plain", body: { size: 900_000, attachmentId: "A1" } }));
			expect([apart.text, apart.unavailable]).toEqual(["", true]);
		});

		test("header text is cut at 2000 characters, a filename at 200, on a code point", () => {
			expect(Array.from(mime.headerText("ä".repeat(3000)) as string)).toHaveLength(mime.MAX_HEADER);
			expect(Array.from(mime.headerText("😀".repeat(2500)) as string)).toHaveLength(mime.MAX_HEADER);
			expect(mime.headerText(`=?utf-8?b?${base64(new TextEncoder().encode("😀".repeat(2500)))}?=`)).toBe("😀".repeat(mime.MAX_HEADER));
			const found = mime.content(Part.parse({ mimeType: "application/pdf", filename: "😀".repeat(500), headers: [], body: { size: 1 } }));
			expect(Array.from(found.attachments[0]?.filename as string)).toHaveLength(mime.MAX_FILENAME);
		});

		test("long and adversarial headers are decoded in about linear time", () => {
			const cases = [
				"=?utf-8?q?a?= ".repeat(40_000),
				"=?utf-8?q?a?= x ".repeat(20_000),
				"=?utf-8?q?a?= =?gb2312?q?b?= ".repeat(20_000),
				`${"x ".repeat(40_000)}=?utf-8?q?a?=`,
				`=?utf-8?b?${"YWFh".repeat(100_000)}?=`,
				"=?".repeat(100_000),
				"=?utf-8?q?".repeat(50_000),
				`=?utf-8?q?${"=".repeat(200_000)}?=`,
				`${"=?utf-8?q?a?=".repeat(30_000)}=?`,
			];
			const started = performance.now();
			for (const value of cases) expect(mime.headerText(value)?.length).toBeLessThanOrEqual(mime.MAX_HEADER);
			expect(performance.now() - started).toBeLessThan(5000);
		});

		test("a large body is decoded in each charset in bounded time", () => {
			const started = performance.now();
			const size = 4_000_000;
			const data = new Uint8Array(size).fill(0x61);
			for (const charset of ["utf-8", "iso-8859-1", "windows-1252", "koi8-r", "shift_jis", "euc-jp", "big5", "gb2312", "euc-kr", "utf-16le", "x-nope"]) {
				const found = decodeCharset(data, charset);
				if (charset === "x-nope") expect(found).toBeNull();
				else expect(found?.length, charset).toBe(charset === "utf-16le" ? size / 2 : size);
			}
			expect(performance.now() - started).toBeLessThan(5000);
			// The strict reading, which looks at the text again, stays linear on a large word.
			const big = new Uint8Array(1_000_000).fill(0x61);
			const strictStarted = performance.now();
			for (const charset of ["utf-8", "gb2312", "windows-1252", "us-ascii", "euc-kr"]) expect(decodeCharsetStrictly(big, charset)?.length, charset).toBe(big.length);
			expect(performance.now() - strictStarted).toBeLessThan(5000);
		});

		test("many distinct unknown labels stay unknown, and a known one is still read after them", () => {
			for (let n = 0; n < 500; n++) expect(decodeCharset(Uint8Array.of(0x61), `x-label-${n}`)).toBeNull();
			for (let n = 0; n < 500; n++) expect(decodeCharsetStrictly(Uint8Array.of(0x61), `x-label-${n}`)).toBeNull();
			expect(decodeCharset(Uint8Array.of(0x61), "utf-8")).toBe("a");
		});
	});
}
