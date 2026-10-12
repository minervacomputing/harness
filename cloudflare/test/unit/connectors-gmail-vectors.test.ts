// The parts of the Gmail connector that Python's standard library and the idna package decide, against the
// vectors generate.py wrote from today's Python (test/fixtures/connectors/google/gmail.json): input
// validation, base64, codecs, RFC 2047 header decoding, Content-Type parameters, MIME bodies and
// attachments, address headers (the email package's parser and its defects), threading, raw RFC 5322
// messages built under the SMTP policy (encoded words and line folding), the HTML converter, mail
// addresses, IDNA and snippets. Every vector is compared exactly.

import { describe, expect, test } from "vitest";
import * as addresses from "../../src/lib/addresses.ts";
import { Part } from "../../src/connectors/gmail/client.ts";
import { gmailConnector } from "../../src/connectors/gmail/connector.ts";
import { a2bBase64, b64decodeUrlsafeStrict, urlsafeB64encode } from "../../src/connectors/gmail/email/base64.ts";
import { canEncode, decode, rawUnicodeEscape } from "../../src/lib/codecs.ts";
import { BinasciiError, IndexError, LookupError, PyTypeError, UnicodeDecodeError, UnicodeEncodeError, UnicodeError, ValueError } from "../../src/connectors/gmail/email/errors.ts";
import { messageText, rawMessage } from "../../src/connectors/gmail/email/message.ts";
import { htmlToText } from "../../src/lib/markdown.ts";
import { idnaEncode } from "../../src/lib/idna.ts";
import * as mime from "../../src/connectors/gmail/mime.ts";
import { canonicalHost, registrable } from "../../src/lib/sites.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import type { Json } from "../../src/lib/json.ts";
import { htmlUnescape, sliceCodePoints } from "../../src/lib/text.ts";
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

function bytesOf(text: string): Uint8Array {
	return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
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

describe("codecs", () => {
	test("decoding with the three error handlers, for every codec name the vectors name", () => {
		type Answer = { ok: string } | { error: string };
		const handlers = ["strict", "replace", "surrogateescape"] as const;
		const cases = vectors.codecs.decode as ({ name: string; data: string } & { [errors in (typeof handlers)[number]]: Answer })[];
		expect(cases.length).toBeGreaterThan(700);
		const actual = cases.map((item) => {
			const answers: { [errors: string]: Answer } = {};
			for (const errors of handlers) {
				try {
					answers[errors] = { ok: decode(bytesOf(item.data), item.name, errors) };
				} catch (error) {
					answers[errors] = { error: raised(error) };
				}
			}
			return { name: item.name, data: item.data, ...answers };
		});
		expect(actual).toEqual(cases);
	});

	test("what can be encoded", () => {
		for (const item of vectors.codecs.encode as ({ name: string; text: string } & ({ ok: string } | Error))[]) {
			if (item.name === "raw-unicode-escape") {
				expect("ok" in item ? hex(rawUnicodeEscape(item.text)) : null, `${item.name} ${item.text}`).toBe("ok" in item ? item.ok : null);
			} else {
				expect(canEncode(item.text, item.name), `${item.name} ${item.text}`).toBe("ok" in item);
			}
		}
	});
});

describe("header text", () => {
	test("encoded words decoded, on one line and cut", () => {
		const cases = vectors.headers as ({ value: string | null } & ({ ok: string | null } | Error))[];
		const actual = cases.map((item) => ({ value: item.value, ...attempt(() => mime.headerText(item.value)) }));
		expect(actual).toEqual(cases);
	});

	test("random encoded-word headers: charsets, encodings, malformed payloads, whitespace and line breaks", () => {
		const cases = vectors.headers_random as ({ value: string } & ({ ok: string | null } | Error))[];
		expect(cases.length).toBeGreaterThanOrEqual(80);
		const actual = cases.map((item) => ({ value: item.value, ...attempt(() => mime.headerText(item.value)) }));
		expect(actual).toEqual(cases);
	});

	test("snippets are unescaped, flattened and cut at 300", () => {
		for (const item of vectors.snippets as { value: string; ok: string }[]) {
			expect(sliceCodePoints(mime.headerText(htmlUnescape(item.value)) as string, 0, 300)).toBe(item.ok);
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
		expect(actual).toEqual(cases);
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
		const actual = cases.map((item) => {
			const [text, title] = htmlToText(item.html);
			return { html: item.html, text, title };
		});
		expect(actual).toEqual(cases);
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

	test("parse", () => {
		const cases = vectors.addresses.parse as { [value: string]: Outcome };
		expect(Object.keys(cases).length).toBeGreaterThan(80);
		expect(Object.fromEntries(Object.keys(cases).map((value) => [value, py(() => addresses.parse(value))]))).toEqual(cases);
	});

	test("valid_id and name", () => {
		const valid = vectors.addresses.valid_id as { [value: string]: boolean };
		expect(Object.fromEntries(Object.keys(valid).map((value) => [value, addresses.validId(value)]))).toEqual(valid);
		const names = vectors.addresses.name as { [value: string]: string };
		expect(Object.fromEntries(Object.keys(names).map((value) => [value, addresses.name(value)]))).toEqual(names);
	});

	test("choices", () => {
		const cases = vectors.addresses.choices as { [value: string]: Outcome };
		expect(Object.fromEntries(Object.keys(cases).map((value) => [value, py(() => addresses.choices(value))]))).toEqual(cases);
	});

	test("canonical hosts and registrable domains", () => {
		const hosts = vectors.addresses.canonical_host as { [host: string]: { plain: Outcome; reserved: Outcome } };
		const actual = Object.fromEntries(Object.keys(hosts).map((host) => [host, { plain: py(() => canonicalHost(host)), reserved: py(() => canonicalHost(host, true)) }]));
		expect(actual).toEqual(hosts);
		const registrables = vectors.addresses.registrable as { [host: string]: string | null };
		expect(Object.fromEntries(Object.keys(registrables).map((host) => [host, registrable(host)]))).toEqual(registrables);
	});
});

describe("IDNA", () => {
	test("encoding with UTS #46 mapping, for the domains of the address vectors and more", () => {
		const cases = vectors.idna as ({ value: string } & ({ ok: string } | Error))[];
		expect(cases.length).toBe(110);
		for (const item of cases) {
			let found: { ok: string } | Error;
			try {
				found = { ok: idnaEncode(item.value) };
			} catch (error) {
				// Python names the kind of IDNAError (InvalidCodepoint, IDNABidiError, ...); all are IDNAError subclasses.
				if (!(error instanceof globalThis.Error) || error.name !== "IDNAError") throw error;
				found = { error: "error" };
			}
			expect(found, item.value).toEqual("ok" in item ? { ok: item.ok } : { error: "error" });
		}
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
	test("are refused or read as Python reads them", () => {
		// Python's answers: bytes GB 2312 lacks are a defect (no recipients), HZ, ISO-2022-KR and Johab decode.
		const cases: [string, string[] | null, string][] = [
			["=?gb2312?b?gUA=?= <ada@example.com>", null, "=?gb2312?b?gUA=?= <ada@example.com>"],
			["=?hz-gb-2312?b?fntWUE5Efn0=?= <ada@example.com>", ["ada@example.com"], "中文 <ada@example.com>"],
			["=?gb2312?b?1tDOxA==?= <ada@example.com>", ["ada@example.com"], "中文 <ada@example.com>"],
			["=?iso-2022-kr?b?GyQpQw4wIQ8=?= <ada@example.com>", ["ada@example.com"], "가 <ada@example.com>"],
			["=?johab?b?iGE=?= <ada@example.com>", ["ada@example.com"], "가 <ada@example.com>"],
			["=?unicode-escape?q?caf\\u00e9?= <ada@example.com>", ["ada@example.com"], "café <ada@example.com>"],
			// The escape codecs encode lone surrogates; ISO-2022-KR decodes an escape and a high byte it cannot encode.
			["=?unicode-escape?q?=5Cud800?= <ada@example.com>", null, "<ada@example.com>"],
			["=?raw-unicode-escape?q?=5Cud800x?= <ada@example.com>", null, "x <ada@example.com>"],
			["=?unicode_escape?q?=5Cud800?=", null, ""],
			["=?iso-2022-kr?b?G4A=?= <ada@example.com>", null, "=?iso-2022-kr?b?G4A=?= <ada@example.com>"],
		];
		for (const [value, found, shown] of cases) {
			expect(mime.mailboxes([value]), value).toEqual(found);
			expect(mime.headerText(value), value).toBe(shown);
		}
		expect(decode(new TextEncoder().encode("~{VPND~}"), "hz-gb-2312")).toBe("中文");
	});
});
