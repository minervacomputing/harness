// The Gmail connector's mail code where it meets the runtime and postal-mime: charsets, the strict reading of
// reply addresses, composed messages read back by postal-mime, part selection and size limits.
// test/unit/email.test.ts runs these tests in Node, test/platform/email.test.ts in workerd, whose TextDecoder
// and libraries production uses.
//
// The security cases are explicit here: a tolerant reader (postal-mime's `addressParser`) must never decide who
// a reply goes to, and a header value must never end a header line.

import PostalMime, { addressParser } from "postal-mime";
import { describe, expect, test } from "vitest";
import { Part } from "../../src/connectors/gmail/client.ts";
import * as mime from "../../src/connectors/gmail/mime.ts";
import { fromBase64 } from "../../src/lib/bytes.ts";
import { charsetKnown, decodeCharset } from "../../src/lib/charset.ts";

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

/** [label, bytes, the text]: charsets mail uses, CJK included, as the runtime reads them. */
const CHARSETS: [string, string, string][] = [
	["utf-8", "c3a9 e697a5", "é日"],
	[" UTF-8 ", "c3a9", "é"],
	// A byte order mark is not text.
	["utf-8", "efbbbf 61", "a"],
	// The Latin-1 labels, and US-ASCII's, are windows-1252 to the Encoding Standard (and to browsers).
	["iso-8859-1", "80", "€"],
	["us-ascii", "e9", "é"],
	["latin-1", "e9", "é"],
	["iso-8859-2", "b1", "ą"],
	["windows-1251", "cff0e8e2e5f2", "Привет"],
	["koi8-r", "f0d2c9d7c5d4", "Привет"],
	["gb2312", "d6d0 cec4", "中文"],
	["gb18030", "d6d0 cec4", "中文"],
	["big5", "a4a4 a4e5", "中文"],
	["shift_jis", "82a0 82a2", "あい"],
	["euc-jp", "a4a2 a4a4", "あい"],
	["iso-2022-jp", "1b2442 2422 2424 1b2842", "あい"],
	["euc-kr", "b0a1", "가"],
	["utf-16le", "6100 e900", "aé"],
	["utf-16be", "0061 00e9", "aé"],
];

/** Labels with no decoder in the runtime. */
const NO_DECODER = ["hz-gb-2312", "iso-2022-kr", "utf-7", "utf-32", "replacement", "x-nope", "base64", ""];

/** Plain mailboxes Minerva replies to, and the canonical addresses read from them. */
const ACCEPTED: [string, string[]][] = [
	["grace@example.com", ["grace@example.com"]],
	["  <grace@example.com> ", ["grace@example.com"]],
	["Grace <Grace@Example.com>", ["grace@example.com"]],
	["Grace M. Hopper<grace@example.com>", ["grace@example.com"]],
	['"Hopper, Grace" <grace@example.com>', ["grace@example.com"]],
	['"Say \\"hi\\"" <grace@example.com>', ["grace@example.com"]],
	['"a@b.com" <evil@x.com>', ["evil@x.com"]],
	["Grüße <grace@example.com>", ["grace@example.com"]],
	["=?utf-8?q?Gr=C3=A4ce?= <grace@example.com>", ["grace@example.com"]],
	// A display name is never decoded, so what it decodes to cannot name another address.
	["=?utf-8?q?=3Cevil=40x.com=3E?= <grace@example.com>", ["grace@example.com"]],
	["=?gb2312?b?gUA=?= <ada@example.com>", ["ada@example.com"]],
	["a@example.com, B <b@example.com>,a@example.com", ["a@example.com", "b@example.com"]],
];

/** Header values a tolerant parser reads an address out of, and the strict reading refuses. */
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
	"Team: a@example.com, b@example.com;",
	"grace@example.com (evil@x.com)",
	"Grace (Hopper) <grace@example.com>",
	'"Grace <grace@example.com>',
	"grace@example.com,",
	"a@example.com,,b@example.com",
];

/** Headers that hold no address Minerva accepts, or hold one where only a decoder could put it. */
const REFUSED = [
	"",
	"grace",
	"<>",
	"grace@localhost",
	"undisclosed-recipients:;",
	"ada@=?utf-8?q?example.com?=",
	"=?utf-8?q?ada?=@example.com",
	"Ada <=?utf-8?q?ada?=@example.com>",
	"ada ﻿@example.com",
	"ada@example.com , ﻿bob@example.com",
	"Ada\u0000 <ada@example.com>",
	"Ada\u0085 <ada@example.com>",
	"Ada  <ada@example.com>",
	'"Ada " <ada@example.com>',
	"a@example.com\n",
	`Ada <${"a".repeat(5000)}@example.com>`,
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

/** The ASCII text of a composed message. */
function rawText(raw: string): string {
	return new TextDecoder().decode(fromBase64(raw));
}

export function emailTests(): void {
	describe("charsets", () => {
		test(`${CHARSETS.length} charsets, CJK included, are read by the runtime as the Encoding Standard says`, () => {
			expect(CHARSETS.map(([label, hex]) => decodeCharset(bytes(hex), label))).toEqual(CHARSETS.map(([, , text]) => text));
		});

		test("undecodable bytes are replaced by U+FFFD, never thrown", () => {
			expect(decodeCharset(Uint8Array.of(0xff, 0x61), "utf-8")).toBe("�a");
			expect(decodeCharset(Uint8Array.of(0x81), "shift_jis")).toBe("�");
			expect(decodeCharset(Uint8Array.of(0x61), "utf-16le")).toBe("�");
		});

		test("a label the runtime lacks is unknown, so a body in it is read as UTF-8", () => {
			for (const label of NO_DECODER) {
				expect(charsetKnown(label), label).toBe(false);
				expect(decodeCharset(Uint8Array.of(0x61), label), label).toBeNull();
			}
			const body = (charset: string) => Part.parse(mailPart("text/plain", "Grüße", charset));
			for (const label of ["x-nope", "utf-7", ""]) expect(mime.content(body(label)).text, label).toBe("Grüße");
			expect(mime.content(body("iso-8859-1")).text).toBe(new TextDecoder("windows-1252").decode(new TextEncoder().encode("Grüße")));
		});

		test('the label "utf-16" reads a byte order mark for the byte order', () => {
			for (const hex of ["feff 0048 0069", "fffe 4800 6900", "4800 6900"]) expect(decodeCharset(bytes(hex), "utf-16"), hex).toBe("Hi");
			const body = Part.parse({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-16" }], body: { size: 6, data: base64url(bytes("feff 0048 0069")) } });
			expect(mime.content(body).text).toBe("Hi");
		});

		test("a label is trimmed and matched in linear time, and one longer than any label is none", () => {
			expect(decodeCharset(bytes("c3a9"), `${" ".repeat(100_000)}utf-8${" ".repeat(100_000)}`)).toBe("é");
			const started = performance.now();
			for (const label of [`x${" ".repeat(200_000)}x`, "x".repeat(5_000_000), "utf-8".padEnd(80, "-")]) {
				expect(decodeCharset(bytes("61"), label)).toBeNull();
				expect(charsetKnown(label)).toBe(false);
			}
			const long = Part.parse({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: `text/plain; charset="x${" ".repeat(60_000)}x"` }], body: { size: 1, data: "YQ" } });
			expect(mime.content(long).text).toBe("a");
			expect(performance.now() - started).toBeLessThan(1500);
		});

		test("header text decodes encoded words in several charsets", () => {
			const text = mime.headerText("=?utf-8?q?Gr=C3=BC=C3=9Fe?= =?iso-8859-1?q?caf=E9?= =?gb2312?b?1tDOxA==?= =?koi8-r?b?8NLJ18XU?= =?shift_jis?b?gqCCog==?=");
			// Encoded words separated by white space only are joined, as RFC 2047 says.
			expect(text).toBe("Grüßecafé中文Приветあい");
		});
	});

	describe("reply addresses", () => {
		test("plain mailboxes are read as canonical addresses, duplicates dropped", () => {
			for (const [value, expected] of ACCEPTED) expect(mime.mailboxes([value]), value).toEqual(expected);
		});

		test(`${RECOVERABLE.length} damaged headers: postal-mime reads an address from each, the strict reading none`, () => {
			for (const value of RECOVERABLE) {
				const tolerant = addressParser(value).flatMap((entry) => [entry.address ?? "", ...(entry.group?.map((member) => member.address) ?? [])]);
				expect(tolerant.some((address) => address.includes("@")), `postal-mime reads an address from ${JSON.stringify(value)}`).toBe(true);
				expect(mime.mailboxes([value]), JSON.stringify(value)).toBeNull();
			}
		});

		test("headers without an address Minerva accepts, with an encoded word or control inside, or too long, are refused", () => {
			for (const value of REFUSED) expect(mime.mailboxes([value]), JSON.stringify(value)).toBeNull();
		});

		test("a header that appears twice, or not at all, is refused, whether or not the values agree", () => {
			expect(mime.mailboxes(["evil@example.net", "grace@example.com"])).toBeNull();
			expect(mime.mailboxes(["grace@example.com", "grace@example.com"])).toBeNull();
			expect(mime.mailboxes([])).toBeNull();
		});

		test("postal-mime merges two Reply-To headers into one list; the strict reading refuses the pair", async () => {
			const raw = ["From: Grace <grace@example.com>", "Reply-To: evil@example.net", "Reply-To: grace@example.com", "To: me@example.org", "Subject: x", "", "body", ""].join("\r\n");
			const parsed = await PostalMime.parse(raw);
			expect(parsed.replyTo?.map((address) => address.address)).toEqual(["evil@example.net", "grace@example.com"]);
			const values = parsed.headers.filter((header) => header.key === "reply-to").map((header) => header.value);
			expect(mime.mailboxes(values)).toBeNull();
		});
	});

	describe("composed messages", () => {
		const base = { to: ["grace@example.com"], subject: "Plans", body: "Hi", inReplyTo: null };

		test("read back by postal-mime: exactly the headers composed, the recipients given, the subject and body", async () => {
			const subject = `${"Grüße aus Zürich, ".repeat(8)}日本語😀`;
			const raw = mime.raw({
				to: ["grace@example.com", "ada@example.org"],
				cc: ["x@example.com"],
				bcc: ["y@example.com"],
				subject,
				body: "Line one\nLíne two\r\n",
				inReplyTo: ["<orig@x>", "<a@x> <orig@x>"],
			});
			const parsed = await PostalMime.parse(fromBase64(raw));
			expect(parsed.headers.map((header) => header.key)).toEqual(["to", "cc", "bcc", "subject", "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding"]);
			expect(parsed.subject).toBe(subject);
			expect(parsed.to?.map((address) => address.address)).toEqual(["grace@example.com", "ada@example.org"]);
			expect(parsed.cc?.map((address) => address.address)).toEqual(["x@example.com"]);
			expect(parsed.bcc?.map((address) => address.address)).toEqual(["y@example.com"]);
			expect(parsed.from).toBeUndefined();
			expect([parsed.inReplyTo, parsed.references]).toEqual(["<orig@x>", "<a@x> <orig@x>"]);
			expect(parsed.text?.replaceAll("\r\n", "\n")).toBe("Line one\nLíne two\n");
			// ASCII, in lines of at most 78 characters, each ended by CRLF.
			const text = rawText(raw);
			expect(text).toMatch(/^[\x20-\x7e\r\n]*$/);
			expect(text.split("\r\n").every((line) => line.length <= 78 && !line.includes("\n") && !line.includes("\r"))).toBe(true);
		});

		test("a short ASCII subject is written as it is; anything else as encoded words", () => {
			expect(rawText(mime.raw(base))).toContain("\r\nSubject: Plans\r\n");
			for (const subject of ["Grüße", "=?utf-8?q?x?=", "x".repeat(70)]) expect(rawText(mime.raw({ ...base, subject })), subject).toContain("Subject: =?UTF-8?B?");
		});

		test("a line break or other control in a header value is refused; one the reader would break on is encoded", async () => {
			for (const lineBreak of ["\r\n", "\n", "\r", "\u0000", "\u000b", "\u001c", "\t"]) {
				const label = JSON.stringify(lineBreak);
				expect(() => mime.raw({ ...base, subject: `x${lineBreak}Bcc: evil@example.net` }), `subject ${label}`).toThrow(TypeError);
				for (const field of ["to", "cc", "bcc"]) {
					expect(() => mime.raw({ ...base, [field]: [`grace@example.com${lineBreak}Bcc: evil@example.net`] }), `${field} ${label}`).toThrow(TypeError);
				}
				expect(() => mime.raw({ ...base, inReplyTo: [`<a@x>${lineBreak}Bcc: evil@example.net`, "<a@x>"] }), `in-reply-to ${label}`).toThrow(TypeError);
				expect(() => mime.raw({ ...base, inReplyTo: ["<a@x>", `<a@x>${lineBreak}Bcc: evil@example.net`] }), `references ${label}`).toThrow(TypeError);
			}
			for (const subject of ["x\u0085Bcc: evil@example.net", "x Bcc: evil@example.net"]) {
				const parsed = await PostalMime.parse(fromBase64(mime.raw({ ...base, subject })));
				expect(parsed.headers.map((header) => header.key)).toEqual(["to", "subject", "mime-version", "content-type", "content-transfer-encoding"]);
				expect(parsed.subject).toBe(subject);
			}
		});

		test("only canonical addresses are composed", () => {
			for (const address of ["Grace@example.com", "Grace <grace@example.com>", "*@example.com", " grace@example.com", "grace@localhost", "unsupported"]) {
				expect(() => mime.raw({ ...base, to: [address] }), address).toThrow(TypeError);
			}
		});

		test("a subject of the original's, flattened to one line, adds no header when read back", async () => {
			const subject = mime.replySubject("Hi\r\nBcc: evil@example.net\r\n\r\nInjected body");
			expect(subject).toBe("Re: Hi Bcc: evil@example.net Injected body");
			const parsed = await PostalMime.parse(fromBase64(mime.raw({ ...base, subject })));
			expect(parsed.bcc).toBeUndefined();
			expect(parsed.subject).toBe(subject);
			expect(parsed.text).toBe("Hi");
			expect(mime.headerText("a\r\nBcc: x y\u0085z\tw")).toBe("a Bcc: x y z w");
		});

		test("a body that looks like headers stays a body", async () => {
			const parsed = await PostalMime.parse(fromBase64(mime.raw({ ...base, body: "Bcc: evil@example.net\n\nTo: evil@example.net\r\nSubject: x" })));
			expect(parsed.bcc).toBeUndefined();
			expect(parsed.to?.map((address) => address.address)).toEqual(["grace@example.com"]);
			expect(parsed.subject).toBe("Plans");
			expect(parsed.text?.replaceAll("\r\n", "\n")).toBe("Bcc: evil@example.net\n\nTo: evil@example.net\nSubject: x");
		});

		test("a long References header is folded and read back whole", async () => {
			const chain = Array.from({ length: mime.MAX_REFERENCES }, (_, n) => `<${"r".repeat(60)}${n}@mail.example.com>`).join(" ");
			const parsed = await PostalMime.parse(fromBase64(mime.raw({ ...base, inReplyTo: [`<${"r".repeat(60)}19@mail.example.com>`, chain] })));
			expect(parsed.references?.split(/\s+/)).toEqual(chain.split(" "));
		});

		test("an encoded word is not decoded into a line break in the header text the model reads", () => {
			expect(mime.headerText("=?utf-8?q?a=0D=0ABcc:_evil=40example.net?=")).toBe("a Bcc: evil@example.net");
			expect(mime.headerText("=?utf-8?b?YQ0KQmNjOiBldmls?=")).toBe("a Bcc: evil");
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
			const inline = { ...text(secret), headers: [{ name: "Content-Disposition", value: 'ATTACHMENT; filename="a;b.txt"' }] };
			const forwarded = { mimeType: "message/rfc822", headers: [], body: { size: 20 }, parts: [text(secret)] };
			const found = mime.content(multipart("multipart/mixed", [text("Body"), named, inline, forwarded]));
			expect(found.text).toBe("Body");
			expect(JSON.stringify(found)).not.toContain(secret);
			expect(found.attachments.map((attachment) => attachment.mime_type)).toEqual(["text/plain", "text/plain", "message/rfc822"]);
		});

		test("a related message shows its root, the start part or else the first, never a resource", () => {
			const resource = { ...text("SECRET resource"), headers: [{ name: "Content-ID", value: "<res@x>" }] };
			const root = { ...html("<p>Root</p>"), headers: [{ name: "Content-ID", value: "<root;1@x>" }] };
			const start = [{ name: "Content-Type", value: 'multipart/related; type="text/html"; START="<root;1@x>"' }];
			expect(mime.content(multipart("multipart/related", [resource, root], start)).text).toBe("Root");
			expect(mime.content(multipart("multipart/related", [root, resource])).text).toBe("Root");
			const sections = [{ name: "Content-Type", value: 'multipart/related; start*0="<root;"; start*1="1@x>"' }];
			expect(mime.content(multipart("multipart/related", [resource, root], sections)).text).toBe("Root");
		});

		test("the charset parameter is found among others, quoted or not, in any case, in RFC 2231 sections", () => {
			const latin = base64url(bytes("e9"));
			for (const value of [
				'text/plain; format=flowed; CHARSET="ISO-8859-1"',
				"text/plain;charset=iso-8859-1",
				'text/plain; name="a;charset=utf-8"; charset=iso-8859-1',
				"text/plain; charset*0=iso-; charset*1=8859-1",
				"text/plain; charset*=''iso-8859-1",
				"text/plain; charset*0*=us-ascii'en'iso%2D; charset*1=8859-1",
			]) {
				expect(mime.content(Part.parse({ mimeType: "text/plain", headers: [{ name: "Content-Type", value }], body: { size: 1, data: latin } })).text, value).toBe("é");
			}
		});
	});

	describe("size limits", () => {
		test("parts, depth and attachments are bounded; a body Gmail keeps apart, or not base64url, is unavailable", () => {
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
			for (const data of ["YWI=", "YWI", "YQ", "YWJj"]) expect(mime.content(Part.parse({ mimeType: "text/plain", body: { size: 1, data } })).unavailable, data).toBe(false);
			for (const data of ["!!!!", "YQ=a", "Y", "YQ===", "YQ=", "YWI==", "YWJj=", "YW+i", "YW/i"]) expect(mime.content(Part.parse({ mimeType: "text/plain", body: { size: 1, data } })).unavailable, data).toBe(true);
		});

		test("header text is cut at 2000 UTF-16 units, a filename at 200, never inside a character", () => {
			expect(mime.headerText("ä".repeat(3000))).toHaveLength(mime.MAX_HEADER);
			expect(mime.headerText(`a${"😀".repeat(2500)}`)).toBe(`a${"😀".repeat(mime.MAX_HEADER / 2 - 1)}`);
			expect(mime.headerText(`=?utf-8?b?${base64(new TextEncoder().encode("😀".repeat(2500)))}?=`)).toBe("😀".repeat(mime.MAX_HEADER / 2));
			const found = mime.content(Part.parse({ mimeType: "application/pdf", filename: "😀".repeat(500), headers: [], body: { size: 1 } }));
			expect(found.attachments[0]?.filename).toBe("😀".repeat(mime.MAX_FILENAME / 2));
		});

		test("long and adversarial headers are read in about linear time", () => {
			const cases = [
				"=?utf-8?q?a?= ".repeat(40_000),
				"=?utf-8?q?a?= =?gb2312?q?b?= ".repeat(20_000),
				`=?utf-8?b?${"YWFh".repeat(100_000)}?=`,
				"=?".repeat(100_000),
				`=?utf-8?q?${"=".repeat(200_000)}?=`,
			];
			const started = performance.now();
			for (const value of cases) expect(mime.headerText(value)?.length).toBeLessThanOrEqual(mime.MAX_HEADER);
			for (const value of ["a ".repeat(1900), `"${"\\a".repeat(1900)}`, `${"a ".repeat(1900)}<`, ",".repeat(3999)]) expect(mime.mailboxes([value])).toBeNull();
			expect(performance.now() - started).toBeLessThan(5000);
		});

		test("a large body is decoded in each charset in bounded time", () => {
			const started = performance.now();
			const size = 4_000_000;
			const data = new Uint8Array(size).fill(0x61);
			for (const charset of ["utf-8", "windows-1252", "shift_jis", "big5", "gb2312", "euc-kr", "utf-16le", "x-nope"]) {
				const found = decodeCharset(data, charset);
				if (charset === "x-nope") expect(found).toBeNull();
				else expect(found?.length, charset).toBe(charset === "utf-16le" ? size / 2 : size);
			}
			expect(performance.now() - started).toBeLessThan(5000);
		});
	});
}
