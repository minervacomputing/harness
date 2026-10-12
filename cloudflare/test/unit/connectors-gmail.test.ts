// backend/tests/test_gmail.py, case by case: MIME parsing and building, the client's page tokens and errors,
// connecting, and the connector against an in-memory Gmail API behind an injected `fetch`, through the
// executor. The standard library's behaviour behind them (encoded words, folding, address parsing, codecs) is
// compared with today's Python in connectors-gmail-vectors.test.ts. Where Python patches nothing here, nothing
// is patched; the OAuth reconnect flow itself belongs to the Worker's OAuth code, and the connector's part
// of it (scopes asked for, consent) is tested here.

import { describe, expect, test } from "vitest";
import { Part, classify, pageToken } from "../../src/connectors/gmail/client.ts";
import { gmailConnector } from "../../src/connectors/gmail/connector.ts";
import { COMPOSE_SCOPE, FULL_SCOPE, MODIFY_SCOPE, READONLY_SCOPE, SEND_SCOPE } from "../../src/connectors/gmail/mailbox.ts";
import * as mime from "../../src/connectors/gmail/mime.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { OperationError, consentGiven } from "../../src/gateway/connector.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { CONNECTION, ceilingRow, jsonResponse, operation, requestOf, settingsClient, startRun } from "../fixtures/connectors/google/runs.ts";

type JsonObject = { [key: string]: Json };

const SECRET = "SECRET merger";
const ME = "me@example.org";
const ALIAS = "alias@example.org";
const [WORK, PROJECTS, PRIVATE] = ["Label_1", "Label_2", "Label_3"] as const;
const [GRACE, LIST, HIDDEN, ARCHIVED, MINE, DRAFT, CHAT, UNKNOWN, FROM_ALIAS] = [
	"18f0000000000001",
	"18f0000000000002",
	"18f0000000000003",
	"18f0000000000004",
	"18f0000000000005",
	"18f0000000000006",
	"18f0000000000007",
	"18f0000000000008",
	"18f0000000000009",
] as const;
const THREAD = "18f00000000000a1";

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

function textPart(text: string, mimeType = "text/plain", charset = "utf-8"): JsonObject {
	return {
		mimeType,
		headers: [{ name: "Content-Type", value: `${mimeType}; charset=${charset}` }],
		body: { size: Array.from(text).length, data: b64(text) },
	};
}

/** The text part with its bytes in another charset (`_text(text, charset=...)`). */
function textPartIn(bytes: Buffer, mimeType: string, charset: string): JsonObject {
	return { mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset=${charset}` }], body: { size: bytes.length, data: bytes.toString("base64url") } };
}

interface MessageFields {
	thread?: string;
	headers?: { [name: string]: string | null };
	payload?: JsonObject;
	internal_date?: string;
}

function message(id: string, labels: string[], sender: string, fields: MessageFields = {}): JsonObject {
	const headers: { [name: string]: string | null } = {
		From: sender,
		To: ME,
		Subject: `About ${id}`,
		Date: "Wed, 30 Sep 2026 10:00:00 +0000",
		"Message-ID": `<${id}@mail.example.com>`,
		...(fields.headers ?? {}),
	};
	const payload = fields.payload ?? textPart("Hello there");
	return {
		id,
		threadId: fields.thread ?? `t${id}`,
		labelIds: labels,
		snippet: "Hello &amp; welcome",
		internalDate: fields.internal_date ?? "1790000000000",
		payload: {
			...payload,
			headers: [...Object.entries(headers).filter(([, value]) => value !== null).map(([name, value]) => ({ name, value })), ...(payload.headers as Json[])],
		},
	};
}

function label(id: string, name: string, type = "user"): JsonObject {
	return { id, name, type };
}

type Hook = (method: string, path: string, params: URLSearchParams) => Response | null;

/** The Gmail API v1 for one mailbox, and Google's userinfo endpoint (test_gmail.py `FakeGmail`). */
class FakeGmail {
	labels: JsonObject[];
	messages: { [id: string]: JsonObject };
	user: JsonObject = { sub: "1234567890", email: ME, name: "Me" };
	sendAs = [ME, ALIAS];
	requests: { method: string; url: URL }[] = [];
	writes: [string, JsonObject][] = [];
	hook: Hook | null = null;

	constructor() {
		const system = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "CHAT", "CATEGORY_PERSONAL", "CATEGORY_UPDATES"];
		this.labels = [...system.map((id) => label(id, id, "system")), label(WORK, "Work"), label(PROJECTS, "work/Projects"), label(PRIVATE, "Private")];
		this.messages = {
			[GRACE]: message(GRACE, ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], "Grace <Grace@Example.com>", { thread: THREAD }),
			[LIST]: message(LIST, [PROJECTS], "ada@partner.org", { headers: { "Reply-To": "Ada's list <list@partner.org>", Subject: "Re: plans" } }),
			[HIDDEN]: message(HIDDEN, ["INBOX", PRIVATE], "ada@partner.org", { thread: THREAD, headers: { Subject: SECRET }, internal_date: "1790000001000" }),
			[ARCHIVED]: message(ARCHIVED, [], "grace@example.com"),
			[MINE]: message(MINE, ["SENT"], ME, { headers: { To: "grace@example.com" } }),
			[DRAFT]: message(DRAFT, ["DRAFT"], ME),
			[CHAT]: message(CHAT, ["CHAT"], "grace@example.com"),
			[UNKNOWN]: message(UNKNOWN, ["INBOX", "Label_99"], "grace@example.com"),
			[FROM_ALIAS]: message(FROM_ALIAS, ["INBOX"], `Me <${ALIAS.toUpperCase()}>`),
		};
	}

	headersOf(id: string): JsonObject[] {
		return (this.messages[id] as JsonObject & { payload: { headers: JsonObject[] } }).payload.headers;
	}

	private notFound(): Response {
		return jsonResponse(404, { error: { code: 404, message: SECRET, errors: [{ reason: "notFound" }] } });
	}

	private view(item: JsonObject, params: URLSearchParams): JsonObject {
		const form = params.get("format") ?? "full";
		const payload = item.payload as JsonObject & { headers: { name: string }[] };
		if (form === "minimal") {
			const { payload: _, ...rest } = item;
			return rest;
		}
		if (form === "metadata") {
			const wanted = new Set(params.getAll("metadataHeaders").map((name) => name.toLowerCase()));
			return { ...item, payload: { mimeType: payload.mimeType ?? null, headers: payload.headers.filter((h) => wanted.has(h.name.toLowerCase())) } as JsonObject };
		}
		return item;
	}

	private list(params: URLSearchParams): JsonObject {
		const wanted = params.get("labelIds");
		const spamTrash = params.get("includeSpamTrash") === "true";
		const found = Object.values(this.messages)
			.filter((m) => (wanted === null || (m.labelIds as string[]).includes(wanted)) && (spamTrash || !(m.labelIds as string[]).some((id) => id === "SPAM" || id === "TRASH")))
			.map((m): JsonObject => ({ id: m.id ?? null, threadId: m.threadId ?? null }));
		const size = Number(params.get("maxResults"));
		const start = Number((params.get("pageToken") ?? "p0").replace(/^p/, ""));
		const body: JsonObject = { messages: found.slice(start, start + size) };
		if (start + size < found.length) body.nextPageToken = `p${start + size}`;
		return body;
	}

	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		this.requests.push({ method: request.method, url });
		if (url.host === "openidconnect.googleapis.com") return jsonResponse(200, this.user);
		const path = url.pathname.replace("/gmail/v1/users/me", "");
		const params = url.searchParams;
		if (this.hook !== null) {
			const response = this.hook(request.method, path, params);
			if (response !== null) return response;
		}
		if (request.method === "POST") {
			const body = parseJson(await request.text()) as JsonObject;
			this.writes.push([path, body]);
			if (path === "/messages/send") return jsonResponse(200, { id: "18f00000000000f1", threadId: body.threadId ?? "tn" });
			if (path === "/drafts") {
				const thread = (body.message as JsonObject).threadId ?? "tn";
				return jsonResponse(200, { id: "r-1", message: { id: "18f00000000000f2", threadId: thread } });
			}
			throw new Error(path);
		}
		const parts = path.replace(/^\/|\/$/g, "").split("/");
		if (parts.length === 1 && parts[0] === "labels") return jsonResponse(200, { labels: this.labels });
		if (parts.length === 1 && parts[0] === "messages") return jsonResponse(200, this.list(params));
		if (parts.length === 2 && parts[0] === "messages") {
			const found = Object.hasOwn(this.messages, parts[1] as string) ? this.messages[parts[1] as string] : undefined;
			return found ? jsonResponse(200, this.view(found, params)) : this.notFound();
		}
		if (parts.length === 2 && parts[0] === "threads") {
			const inThread = Object.values(this.messages).filter((m) => m.threadId === parts[1]);
			if (!inThread.length) return this.notFound();
			return jsonResponse(200, { id: parts[1], messages: inThread });
		}
		if (path === "/profile") return jsonResponse(200, { emailAddress: ME, messagesTotal: 9 });
		if (path === "/settings/sendAs") return jsonResponse(200, { sendAs: this.sendAs.map((a) => ({ sendAsEmail: a })) });
		throw new Error(path);
	}

	readonly fetch: typeof fetch = async (input, init) => this.handle(requestOf(input, init as RequestInit));

	paths(): string[] {
		return this.requests.map((r) => r.url.pathname.replace("/gmail/v1/users/me", ""));
	}

	/** The `/messages` listing requests. */
	listings(): URL[] {
		return this.requests.filter((r) => r.url.pathname.endsWith("/messages")).map((r) => r.url);
	}

	/** A write: its path, its body, and the raw message it carried, parsed. */
	sent(index = -1): [string, JsonObject, ParsedMail] {
		const [path, body] = this.writes.at(index) as [string, JsonObject];
		const raw = ((body.message as JsonObject | undefined) ?? body).raw as string;
		return [path, body, parseMail(raw)];
	}

	client() {
		return settingsClient(gmailConnector(), this.fetch);
	}
}

interface ParsedMail {
	/** `message[name]`: the first header of that name, unfolded and decoded; null when absent. */
	get(name: string): string | null;
	/** `message.get_content()` of a quoted-printable UTF-8 text part. */
	content(): string;
	contentType: string;
	transferEncoding: string | null;
}

/** An independent reading of a raw message: unfolded headers, encoded words decoded, the quoted-printable body. */
function parseMail(raw: string): ParsedMail {
	const text = Buffer.from(raw, "base64url").toString("latin1");
	const at = text.indexOf("\r\n\r\n");
	const head = text.slice(0, at);
	const body = text.slice(at + 4);
	const headers: [string, string][] = [];
	for (const line of head.split("\r\n")) {
		if (/^[ \t]/.test(line)) {
			const last = headers[headers.length - 1] as [string, string];
			last[1] += line;
		} else {
			const colon = line.indexOf(":");
			headers.push([line.slice(0, colon), line.slice(colon + 1).replace(/^ /, "")]);
		}
	}
	const get = (name: string): string | null => {
		const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
		return found ? (mime.headerText(found[1]) as string) : null;
	};
	return {
		get,
		contentType: get("Content-Type") as string,
		transferEncoding: get("Content-Transfer-Encoding"),
		content() {
			const bytes: number[] = [];
			const joined = body.replace(/=\r\n/g, "");
			for (let i = 0; i < joined.length; i++) {
				if (joined[i] === "=" && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
					bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
					i += 2;
				} else bytes.push(joined.charCodeAt(i));
			}
			return Buffer.from(bytes).toString("utf8");
		},
	};
}

const SCOPES = ["openid", "email", READONLY_SCOPE, SEND_SCOPE, COMPOSE_SCOPE];

function start(gmail: FakeGmail, grants: { [key: string]: string[] }, options: { scopes?: string[]; ceiling?: ReturnType<typeof ceilingRow>[] } = {}) {
	return startRun(gmailConnector(), gmail.fetch, { scopes: options.scopes ?? SCOPES, grants, ceiling: options.ceiling ?? [] });
}

function items(outcome: { result: { items: JsonObject[] } }): JsonObject[] {
	return outcome.result.items;
}

function ids(outcome: { result: { items: JsonObject[] } }): Json[] {
	return items(outcome).map((item) => item.id as Json);
}

const label_ = (resource: string, actions: string[] = ["read"]) => ({ [`label:${resource}`]: actions });
const recipient = (resource: string, actions: string[] = ["send"]) => ({ [`recipient:${resource}`]: actions });
const DRAFTS = { "account:connection": ["draft"] };

function part(mimeType: string, parts: JsonObject[] = [], fields: JsonObject = {}): Part {
	return Part.parse({ mimeType, headers: [], parts, ...fields });
}

describe("MIME", () => {
	test("test_plain_text_is_preferred_and_html_is_flattened", () => {
		const alternative = part("multipart/alternative", [textPart("Plain\r\nversion"), textPart("<p>Rich <b>version</b></p>", "text/html")]);
		expect(mime.content(alternative).text).toBe("Plain\nversion");
		const html = textPart('<p>Hi <a href="https://example.com/x">there</a> <a href="/rel">rel</a></p><img src="https://tracker.example/p.gif"><script>alert(1)</script>', "text/html");
		const found = mime.content(part("multipart/alternative", [html])).text;
		expect(found).toContain("Hi");
		expect(found).toContain("https://example.com/x");
		for (const absent of ["/rel", "tracker", "alert"]) expect(found).not.toContain(absent);
		const latin = textPartIn(Buffer.from("Grüße", "latin1"), "text/plain", "iso-8859-1");
		expect(mime.content(Part.parse(latin)).text).toBe("Grüße");
		const unknown = { ...textPart("Hello"), headers: [{ name: "Content-Type", value: "text/plain; charset=x-nope" }] };
		expect(mime.content(Part.parse(unknown)).text).toBe("Hello");
		const strict = { ...textPart("Hello"), headers: [{ name: "Content-Type", value: "text/plain; charset=idna" }] };
		expect(mime.content(Part.parse(strict)).text).toBe("Hello");
	});

	test("test_attachments_are_named_never_read", () => {
		const attached = {
			mimeType: "application/pdf",
			filename: "Plän\r\n.pdf",
			headers: [{ name: "Content-Disposition", value: 'attachment; filename="plan.pdf"' }],
			body: { size: 10, attachmentId: "ANGjdJ" },
		};
		const forwarded = { mimeType: "message/rfc822", headers: [], body: { size: 20 }, parts: [textPart(SECRET)] };
		const textAttachment = { ...textPart(SECRET), filename: "notes.txt" };
		const found = mime.content(part("multipart/mixed", [textPart("See attached"), attached, forwarded, textAttachment]));
		expect(found.text).toBe("See attached");
		expect(found.unavailable).toBe(false);
		expect(found.text).not.toContain(SECRET);
		expect(found.attachments).toEqual([
			{ filename: "Plän .pdf", mime_type: "application/pdf", size: 10 },
			{ filename: null, mime_type: "message/rfc822", size: 20 },
			{ filename: "notes.txt", mime_type: "text/plain", size: SECRET.length },
		]);
	});

	test("test_attached_multiparts_and_related_resources_are_not_read", () => {
		const attached = { mimeType: "multipart/mixed", headers: [{ name: "Content-Disposition", value: "attachment" }], parts: [textPart(SECRET)] };
		const found = mime.content(part("multipart/mixed", [textPart("Body"), attached]));
		expect(found.text).toBe("Body");
		expect(found.attachments).toEqual([{ filename: null, mime_type: "multipart/mixed", size: null }]);
		const resource = { ...textPart(SECRET), headers: [{ name: "Content-ID", value: "<res@x>" }] };
		const root = { ...textPart("<p>Root</p>", "text/html"), headers: [{ name: "Content-ID", value: "<root@x>" }] };
		const started = { name: "Content-Type", value: 'multipart/related; start="<root@x>"' };
		expect(mime.content(part("multipart/related", [resource, root], { headers: [started] })).text).toBe("Root");
		expect(mime.content(part("multipart/related", [root, resource])).text).toBe("Root");
	});

	test("test_bodies_gmail_keeps_apart_or_cannot_decode_are_unavailable", () => {
		const apart = { mimeType: "text/plain", body: { size: 900_000, attachmentId: "A1" } };
		let found = mime.content(part("multipart/mixed", [textPart("Start"), apart]));
		expect(found.text).toBe("Start");
		expect(found.unavailable).toBe(true);
		const broken = Part.parse({ mimeType: "text/plain", body: { size: 4, data: "!!!!" } });
		expect(mime.content(broken).unavailable).toBe(true);
		const empty = Part.parse({ mimeType: "text/plain", body: { size: 0 } });
		found = mime.content(empty);
		expect(found.text).toBe("");
		expect(found.unavailable).toBe(false);
		let nested: JsonObject = textPart("deep");
		for (let i = 0; i < 12; i++) nested = { mimeType: "multipart/mixed", headers: [], parts: [nested] };
		found = mime.content(Part.parse(nested));
		expect(found.text).toBe("");
		expect(found.unavailable).toBe(true);
		const many = part("multipart/mixed", Array.from({ length: 250 }, () => textPart("x")));
		expect(mime.content(many).unavailable).toBe(true);
	});

	const reading: [string[], string[] | null][] = [
		[["Grace <Grace@Example.com>"], ["grace@example.com"]],
		[["a@example.com, B <b@example.com>, a@example.com"], ["a@example.com", "b@example.com"]],
		[['"a@b.com" <evil@x.com>'], ["evil@x.com"]],
		[["=?utf-8?q?Gr=C3=A4ce?= <grace@example.com>"], ["grace@example.com"]],
		[["Team: a@example.com, b@example.com;"], ["a@example.com", "b@example.com"]],
		[[], null],
		[["a@example.com", "b@example.com"], null],
		[["a@b.com <c@d.com>"], null],
		[["Grace <grace@example.com"], null],
		[["undisclosed-recipients:;"], null],
		[["grace@localhost"], null],
		[["grace"], null],
		[["a@example.com, bad"], null],
		[["<>"], null],
	];
	for (const [values, expected] of reading) {
		test(`test_reply_addresses_are_read_strictly ${JSON.stringify(values)}`, () => {
			expect(mime.mailboxes(values)).toEqual(expected);
		});
	}

	test("test_replies_thread_by_well_formed_ids", () => {
		const references = ["<a@x> junk <b@x> <orig@x>"];
		expect(mime.threading(["<orig@x>"], references)).toEqual(["<orig@x>", "<a@x> <b@x> <orig@x>"]);
		expect(mime.threading([" <orig@x> "], [])).toEqual(["<orig@x>", "<orig@x>"]);
		const long = [Array.from({ length: 30 }, (_, n) => `<r${n}@x>`).join(" ")];
		const chain = (mime.threading(["<orig@x>"], long) as [string, string])[1].split(" ");
		expect(chain).toEqual([...Array.from({ length: 19 }, (_, n) => `<r${n + 11}@x>`), "<orig@x>"]);
		expect(mime.threading(["<orig@x>"], [...references, ...references])).toEqual(["<orig@x>", "<orig@x>"]);
		expect(mime.threading(["<orig@x>"], ["<a> <b@x>"])).toEqual(["<orig@x>", "<b@x> <orig@x>"]);
		for (const bad of [[], ["<a@x>", "<b@x>"], ["orig@x"], ["<a b@x>"], ["<a@x>\r\nBcc: e@x"], ["<orig>"], ["<a@b@x>"]]) {
			expect(mime.threading(bad, references)).toBeNull();
		}
		expect(mime.replySubject("Plans")).toBe("Re: Plans");
		expect(mime.replySubject("RE: Plans")).toBe("RE: Plans");
		expect(mime.replySubject(null)).toBe("Re: ");
		expect(mime.replySubject("a\r\nBcc: e@x")).toBe("Re: a Bcc: e@x");
	});

	test("test_raw_messages_have_no_sender_and_keep_bcc", () => {
		const raw = mime.raw({
			to: ["grace@example.com"],
			bcc: ["ada@partner.org"],
			subject: "Grüße",
			body: "Line one\nLíne two",
			inReplyTo: ["<orig@x>", "<a@x> <orig@x>"],
		});
		const parsed = parseMail(raw);
		expect(parsed.get("From")).toBeNull();
		expect([parsed.get("To"), parsed.get("Bcc"), parsed.get("Subject")]).toEqual(["grace@example.com", "ada@partner.org", "Grüße"]);
		expect([parsed.get("In-Reply-To"), parsed.get("References")]).toEqual(["<orig@x>", "<a@x> <orig@x>"]);
		expect(parsed.contentType.startsWith("text/plain")).toBe(true);
		expect(parsed.transferEncoding).toBe("quoted-printable");
		expect(parsed.content()).toBe("Line one\r\nLíne two\r\n");
	});
});

describe("the client", () => {
	test("test_page_tokens_and_errors", () => {
		expect(pageToken(null)).toBeNull();
		expect(pageToken("CAEQAA-_x")).toBe("CAEQAA-_x");
		for (const token of ["a b", "a/b", "", "a".repeat(201), 42]) {
			expect(() => pageToken(token)).toThrow(OperationError);
			try {
				pageToken(token);
			} catch (error) {
				expect((error as OperationError).code).toBe("PROVIDER_LIMIT");
			}
		}
		const precondition = JSON.stringify({ error: { code: 400, message: SECRET, errors: [{ reason: "failedPrecondition" }] } });
		expect(classify("Gmail", new Response(precondition, { status: 400 }), precondition)?.code).toBe("UNSUPPORTED_ACCOUNT");
		const other = JSON.stringify({ error: { errors: [{ reason: "invalid" }] } });
		expect(classify("Gmail", new Response(other, { status: 400 }), other)).toBeNull();
		expect(classify("Gmail", new Response("<html>", { status: 400 }), "<html>")).toBeNull();
	});
});

describe("connecting", () => {
	test("test_account_discovery_and_names", async () => {
		const gmail = new FakeGmail();
		const connector = gmailConnector();
		const account = await connector.account(gmail.client());
		expect([account.id, account.label]).toEqual(["1234567890", ME]);
		let found = await connector.discover(gmail.client(), "label", { query: null, cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([
			["INBOX", "Inbox"],
			["SENT", "Sent"],
			["DRAFT", "Drafts"],
			["SPAM", "Spam"],
			["TRASH", "Trash"],
			["CATEGORY_PERSONAL", "Category: Primary"],
			["CATEGORY_UPDATES", "Category: Updates"],
			[WORK, "Work"],
			[PROJECTS, "work/Projects"],
			[PRIVATE, "Private"],
		]);
		found = await connector.discover(gmail.client(), "label", { query: "PROJ", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([PROJECTS]);
		found = await connector.discover(gmail.client(), "recipient", { query: "Ada@Partner.org", cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([
			["ada@partner.org", "ada@partner.org"],
			["*@partner.org", "Everyone at partner.org"],
		]);
		let names = await connector.describe(gmail.client(), "label", [PROJECTS, "INBOX", "UNREAD", "CHAT", "Label_99", "inbox", "*"]);
		expect(names).toEqual({ [PROJECTS]: "work/Projects", INBOX: "Inbox" });
		names = await connector.describe(gmail.client(), "recipient", ["*@partner.org", "Ada@x.com"]);
		expect(names).toEqual({ "*@partner.org": "Everyone at partner.org" });
	});

	test("recipients are searched, never listed; a search that is not an address says so", async () => {
		const gmail = new FakeGmail();
		const connector = gmailConnector();
		expect(connector.kinds.find((kind) => kind.id === "recipient")?.listed).toBe(false);
		expect((await connector.discover(gmail.client(), "recipient", { query: null, cursor: null })).items).toEqual([]);
		expect((await connector.discover(gmail.client(), "recipient", { query: "", cursor: null })).items).toEqual([]);
		await expect(connector.discover(gmail.client(), "recipient", { query: "a@b@c", cursor: null })).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
		expect(gmail.requests).toEqual([]);
	});

	test("an account without a name or address is called Gmail", async () => {
		const gmail = new FakeGmail();
		gmail.user = { sub: "9" };
		expect(await gmailConnector().account(gmail.client())).toEqual({ id: "9", label: "Gmail" });
		gmail.user = { sub: "9", name: "Me" };
		expect(await gmailConnector().account(gmail.client())).toEqual({ id: "9", label: "Me" });
	});

	test("test_gmail_scopes_follow_the_allowed_actions", () => {
		const connector = gmailConnector();
		const base = ["openid", "email", READONLY_SCOPE];
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(base);
		expect(requestedScopes(connector, new Set(["read", "send"]))).toEqual([...base, SEND_SCOPE]);
		expect(requestedScopes(connector, new Set(["draft"]))).toEqual([...base, COMPOSE_SCOPE]);
		expect(requestedScopes(connector, new Set(["read", "send", "draft"]))).toEqual([...base, COMPOSE_SCOPE, SEND_SCOPE]);
		const needed = (granted: string[] | null, actions: string[]) => consentNeeded(connector, granted, new Set(actions));
		const granted = ["openid", "email", READONLY_SCOPE];
		const all = ["read", "send", "draft"];
		expect(needed(granted, all)).toEqual(["send", "draft"]);
		expect(needed([...granted, SEND_SCOPE], all)).toEqual(["draft"]);
		// Compose also sends; modify and full access cover everything.
		expect(needed([...granted, COMPOSE_SCOPE], all)).toEqual([]);
		expect(needed([MODIFY_SCOPE], all)).toEqual([]);
		expect(needed(["https://mail.google.com/"], all)).toEqual([]);
		expect(needed([SEND_SCOPE], ["read"])).toEqual(["read"]);
		// Unknown scopes (the provider did not say what it granted) need nothing: Google will refuse instead.
		expect(needed(null, all)).toEqual([]);
	});

	test("Google's authorization is asked for offline access, consent and earlier grants, with read access first", () => {
		const connector = gmailConnector();
		expect(connector.auth).toEqual({
			type: "oauth2",
			app: "google",
			authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			scopes: ["openid", "email", READONLY_SCOPE],
			authorizeParams: [
				["access_type", "offline"],
				["prompt", "consent"],
				["include_granted_scopes", "true"],
			],
			loginHint: true,
		});
	});

	test("which Google scope sets cover which operation", () => {
		const connector = gmailConnector();
		const covers = (name: string, granted: string[]) => consentGiven(operation(connector, name).consent, granted);
		for (const name of ["list_labels", "list_messages", "read_message", "read_thread"]) {
			expect(covers(name, [READONLY_SCOPE])).toBe(true);
			expect(covers(name, [SEND_SCOPE, COMPOSE_SCOPE])).toBe(false);
			expect(covers(name, [MODIFY_SCOPE])).toBe(true);
			expect(covers(name, [FULL_SCOPE])).toBe(true);
		}
		expect(covers("send_message", [SEND_SCOPE])).toBe(true);
		expect(covers("send_message", [COMPOSE_SCOPE])).toBe(true);
		expect(covers("send_message", [READONLY_SCOPE])).toBe(false);
		// A reply reads the original and the account's addresses, then sends.
		expect(covers("reply", [SEND_SCOPE])).toBe(false);
		expect(covers("reply", [READONLY_SCOPE, SEND_SCOPE])).toBe(true);
		expect(covers("reply", [READONLY_SCOPE, COMPOSE_SCOPE])).toBe(true);
		expect(covers("reply", [MODIFY_SCOPE])).toBe(true);
		expect(covers("create_draft", [COMPOSE_SCOPE])).toBe(true);
		expect(covers("create_draft", [SEND_SCOPE])).toBe(false);
		expect(covers("create_reply_draft", [READONLY_SCOPE, COMPOSE_SCOPE])).toBe(true);
		expect(covers("create_reply_draft", [COMPOSE_SCOPE])).toBe(false);
		expect(covers("create_reply_draft", [FULL_SCOPE])).toBe(true);
	});
});

describe("reading", () => {
	test("test_labels_nest_by_name_and_only_readable_ones_are_listed", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, label_("*"));
		const listed = Object.fromEntries(items(await run.ok("gmail_list_labels", {})).map((item) => [item.id as string, item]));
		expect(new Set(Object.keys(listed))).toEqual(new Set(["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "CATEGORY_PERSONAL", "CATEGORY_UPDATES", WORK, PROJECTS, PRIVATE]));
		// Below its parent, so that a label never names a parent the agent may not read.
		expect(listed[PROJECTS]).toEqual({ id: PROJECTS, name: "Projects", type: "user", parent_id: WORK });
		expect(listed.INBOX).toEqual({ id: "INBOX", name: "Inbox", type: "system", parent_id: null });

		run = await start(gmail, label_(WORK));
		expect(ids(await run.ok("gmail_list_labels", {}))).toEqual([WORK, PROJECTS]);
		// A grant on a parent covers the mail under its children.
		expect(ids(await run.ok("gmail_list_messages", { label: PROJECTS }))).toEqual([LIST]);
		for (const name of ["INBOX", "inbox", PRIVATE, "UNREAD", "CHAT", "Label_99", "Work"]) {
			expect(await run.code("gmail_list_messages", { label: name }), name).toBe("POLICY_DENIED");
		}
		for (const name of ["../x", "a b", "Work/Projects"]) {
			expect(await run.code("gmail_list_messages", { label: name }), name).toBe("INVALID_ARGUMENTS");
		}
	});

	test("test_a_message_is_read_through_any_label_and_hidden_by_any_deny", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, label_("INBOX"));
		expect(ids(await run.ok("gmail_list_messages", { label: "INBOX" }))).toEqual([GRACE, HIDDEN, UNKNOWN, FROM_ALIAS]);
		const [read] = items(await run.ok("gmail_read_message", { message: GRACE }));
		expect(read?.from).toBe("Grace <Grace@Example.com>");
		expect(read?.body).toBe("Hello there");
		expect(read?.snippet).toBe("Hello & welcome");
		expect(read?.unread).toBe(true);
		expect(read?.label_ids).toEqual(["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);

		run = await start(gmail, label_("INBOX"), { ceiling: [ceilingRow(CONNECTION, "label", PRIVATE, "deny")] });
		// Hidden by the deny on Private; a message with a label Minerva does not know hides behind any deny.
		expect(ids(await run.ok("gmail_list_messages", { label: "INBOX" }))).toEqual([GRACE, FROM_ALIAS]);
		for (const hidden of [HIDDEN, UNKNOWN]) expect(await run.code("gmail_read_message", { message: hidden })).toBe("POLICY_DENIED");
		const found = items(await run.ok("gmail_read_thread", { thread: THREAD }));
		expect(found.map((item) => item.id)).toEqual([GRACE]);
		expect(JSON.stringify(found)).not.toContain(SECRET);
	});

	test("test_archived_mail_needs_every_label_and_chats_are_refused", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, { ...label_("INBOX"), ...label_(PROJECTS) });
		for (const id of [ARCHIVED, MINE, CHAT, "18f00000000000ff"]) expect(await run.code("gmail_read_message", { message: id }), id).toBe("POLICY_DENIED");
		for (const id of ["../labels", "a b", "x".repeat(65)]) expect(await run.code("gmail_read_message", { message: id }), id).toBe("INVALID_ARGUMENTS");
		// Nothing but labels was asked for the refused messages.
		expect(gmail.requests.some((r) => r.url.searchParams.get("format") === "full")).toBe(false);

		run = await start(gmail, label_("*"));
		const [read] = items(await run.ok("gmail_read_message", { message: ARCHIVED }));
		expect(read?.id).toBe(ARCHIVED);
		expect(await run.code("gmail_read_message", { message: CHAT })).toBe("POLICY_DENIED");
		expect(ids(await run.ok("gmail_list_messages", {}))).not.toContain(CHAT);
	});

	test("test_spam_and_trash_are_listed_only_on_their_own", async () => {
		const gmail = new FakeGmail();
		gmail.messages[GRACE] = { ...(gmail.messages[GRACE] as JsonObject), labelIds: ["SPAM"] };
		const run = await start(gmail, label_("*"));
		expect(ids(await run.ok("gmail_list_messages", { query: "from:grace" }))).not.toContain(GRACE);
		expect(ids(await run.ok("gmail_list_messages", { label: "spam" }))).toEqual([GRACE]);
		const [listed, spam] = gmail.listings() as [URL, URL];
		expect([spam.searchParams.get("includeSpamTrash"), spam.searchParams.get("labelIds")]).toEqual(["true", "SPAM"]);
		expect(listed.searchParams.get("q")).toBe("from:grace");
		expect(listed.searchParams.has("labelIds")).toBe(false);
		expect(await run.code("gmail_list_messages", { query: "a\nb" })).toBe("INVALID_ARGUMENTS");
	});

	test("test_message_lists_page_with_run_bound_cursors", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, label_("INBOX"));
		const first = await run.ok("gmail_list_messages", { label: "INBOX", limit: 3 });
		expect(ids(first)).toEqual([GRACE, HIDDEN, UNKNOWN]);
		const cursor = first.result.next_cursor as string;
		expect(cursor).not.toBe("p3");
		const second = await run.ok("gmail_list_messages", { label: "INBOX", limit: 3, cursor });
		expect(ids(second)).toEqual([FROM_ALIAS]);
		expect("next_cursor" in second.result).toBe(false);
		expect(gmail.listings().map((url) => url.searchParams.get("pageToken"))).toEqual([null, "p3"]);
		expect(await run.code("gmail_list_messages", { label: "INBOX", limit: 2, cursor })).toBe("INVALID_CURSOR");
	});

	test("test_a_label_renamed_after_authorization_is_refused", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, label_(WORK));
		let calls = 0;
		gmail.hook = (_method, path) => {
			if (path === "/labels") {
				calls++;
				if (calls === 2) (gmail.labels.at(-2) as JsonObject).name = "Elsewhere/Projects";
			}
			return null;
		};
		expect(await run.code("gmail_list_messages", { label: PROJECTS })).toBe("MAIL_MOVED");
	});

	test("test_a_label_renamed_while_mail_is_fetched_is_seen", async () => {
		// Labels are fetched after the mail they place, so a rename during the fetch is never missed.
		const gmail = new FakeGmail();
		const run = await start(gmail, label_(WORK));
		gmail.hook = (_method, path, params) => {
			if ((path.startsWith("/messages/") || path.startsWith("/threads/")) && params.get("format") !== "minimal") (gmail.labels.at(-2) as JsonObject).name = "Elsewhere/Projects";
			return null;
		};
		expect(await run.code("gmail_read_message", { message: LIST })).toBe("MAIL_MOVED");
		(gmail.labels.at(-2) as JsonObject).name = "work/Projects";
		expect(ids(await run.ok("gmail_read_thread", { thread: `t${LIST}` }))).toEqual([]);
	});

	test("test_a_message_relabelled_after_authorization_is_refused", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, label_("INBOX"));
		gmail.hook = (_method, _path, params) => {
			if (params.get("format") === "full") gmail.messages[GRACE] = { ...(gmail.messages[GRACE] as JsonObject), labelIds: ["INBOX", PRIVATE] };
			return null;
		};
		expect(await run.code("gmail_read_message", { message: GRACE })).toBe("MAIL_MOVED");
	});

	test("test_messages_with_too_many_labels_are_refused", async () => {
		const gmail = new FakeGmail();
		const many = Array.from({ length: 66 }, (_, n) => `Label_${n + 100}`);
		gmail.labels.push(...many.map((id) => label(id, `Many ${id}`)));
		gmail.messages[GRACE] = { ...(gmail.messages[GRACE] as JsonObject), labelIds: many };
		const run = await start(gmail, label_("*"));
		expect(await run.code("gmail_read_message", { message: GRACE })).toBe("POLICY_DENIED");
		expect(ids(await run.ok("gmail_list_messages", {}))).not.toContain(GRACE);
	});

	test("test_long_messages_are_read_in_slices", async () => {
		const gmail = new FakeGmail();
		const body = Array.from({ length: 400 }, (_, n) => `${String(n).padStart(4, "0")} `).join("");
		const grace = gmail.messages[GRACE] as JsonObject & { payload: { headers: Json[] } };
		gmail.messages[GRACE] = { ...grace, payload: { ...textPart(body), headers: grace.payload.headers } };
		const run = await start(gmail, label_("INBOX"));
		const trimmed = body.trim();
		const [first] = items(await run.ok("gmail_read_message", { message: GRACE, max_chars: 1000 }));
		expect(first?.body).toBe(trimmed.slice(0, 1000));
		expect(first?.next_offset).toBe(1000);
		expect(first?.total_chars).toBe(trimmed.length);
		const [second] = items(await run.ok("gmail_read_message", { message: GRACE, max_chars: 1000, offset: 1000 }));
		expect(second?.body).toBe(trimmed.slice(1000, 2000));
		const [item] = items(await run.ok("gmail_read_thread", { thread: THREAD, max_chars_per_message: 200 }));
		expect(item?.id).toBe(GRACE);
		expect(item?.body_truncated).toBe(true);
		expect((item?.body as string).length).toBe(200);
	});

	test("test_threads_that_do_not_exist_read_as_empty", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, label_("*"));
		expect(items(await run.ok("gmail_read_thread", { thread: "18f00000000000ee" }))).toEqual([]);
		const found = items(await run.ok("gmail_read_thread", { thread: THREAD }));
		expect(found.map((item) => item.id)).toEqual([GRACE, HIDDEN]);
	});

	test("test_an_account_without_gmail_is_named", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, label_("*"));
		const precondition = { error: { code: 400, message: SECRET, errors: [{ reason: "failedPrecondition" }] } };
		gmail.hook = () => jsonResponse(400, precondition);
		expect(await run.code("gmail_list_labels", {})).toBe("UNSUPPORTED_ACCOUNT");
		expect(await run.code("gmail_read_message", { message: GRACE })).toBe("UNSUPPORTED_ACCOUNT");
	});
});

describe("sending", () => {
	test("test_sending_needs_every_recipient", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, { ...recipient("*@example.com"), ...recipient("ada@partner.org") });
		const args = { to: ["Grace@Example.com"], cc: ["ada@partner.org"], bcc: ["bob@example.com"], subject: "Plans", body: "Hi Grace\n\tthanks" };
		const [sent] = items(await run.ok("gmail_send_message", args));
		expect(sent).toEqual({ sent: true, id: "18f00000000000f1", thread_id: "tn", to: ["grace@example.com"], cc: ["ada@partner.org"], bcc: ["bob@example.com"], subject: "Plans" });
		const [path, body, raw] = gmail.sent();
		expect(path).toBe("/messages/send");
		expect("threadId" in body).toBe(false);
		expect([raw.get("To"), raw.get("Cc"), raw.get("Bcc"), raw.get("From")]).toEqual(["grace@example.com", "ada@partner.org", "bob@example.com", null]);
		expect(raw.content()).toBe("Hi Grace\r\n\tthanks\r\n");

		const send = { to: ["grace@example.com"], subject: "x", body: "x" };
		for (const change of [{ bcc: ["bob@partner.org"] }, { cc: ["grace@mail.example.com"] }, { to: ["grace@example.com.evil.org"] }] as JsonObject[]) {
			expect(await run.code("gmail_send_message", { ...send, ...change }), JSON.stringify(change)).toBe("POLICY_DENIED");
		}
		const invalid: JsonObject[] = [
			{ cc: ["Grace@example.com"] },
			{ to: [] },
			{ to: ["Grace <grace@example.com>"] },
			{ to: Array.from({ length: 6 }, (_, n) => `p${n}@example.com`), cc: Array.from({ length: 5 }, (_, n) => `q${n}@example.com`) },
			{ subject: "a\r\nBcc: x@evil.org" },
			{ body: "bell\x07" },
			{ from: "ceo@example.com" },
		];
		for (const change of invalid) expect(await run.code("gmail_send_message", { ...send, ...change }), JSON.stringify(change)).toBe("INVALID_ARGUMENTS");
		expect(gmail.writes.length).toBe(1);

		run = await start(gmail, recipient("*@example.com"), { scopes: ["openid", "email", READONLY_SCOPE] });
		// Without Google's consent to sending, the tool is not offered.
		expect(await run.code("gmail_send_message", send)).toBe("UNKNOWN_OPERATION");
		expect(gmail.writes.length).toBe(1);
	});

	test("test_replies_go_to_exactly_the_authorized_addresses_in_the_thread", async () => {
		const gmail = new FakeGmail();
		gmail.headersOf(GRACE).push({ name: "References", value: "<first@mail.example.com>" });
		let run = await start(gmail, { ...label_("INBOX"), ...recipient("grace@example.com") });
		const [replied] = items(await run.ok("gmail_reply", { message: GRACE, body: "Thanks" }));
		expect(replied).toEqual({ replied: true, id: "18f00000000000f1", thread_id: THREAD, to: ["grace@example.com"] });
		let [path, body, raw] = gmail.sent();
		expect(path).toBe("/messages/send");
		expect(body.threadId).toBe(THREAD);
		expect([raw.get("To"), raw.get("Cc"), raw.get("Bcc")]).toEqual(["grace@example.com", null, null]);
		expect(raw.get("Subject")).toBe(`Re: About ${GRACE}`);
		expect(raw.get("In-Reply-To")).toBe(`<${GRACE}@mail.example.com>`);
		expect(raw.get("References")).toBe(`<first@mail.example.com> <${GRACE}@mail.example.com>`);
		// The reply was read with only the headers it needs.
		const formats = new Set(gmail.requests.filter((r) => r.url.pathname.endsWith(GRACE)).map((r) => r.url.searchParams.get("format")));
		expect(formats).toEqual(new Set(["metadata"]));

		// Replies go to Reply-To, not the sender.
		run = await start(gmail, { ...label_(WORK), ...recipient("ada@partner.org") });
		expect(await run.code("gmail_reply", { message: LIST, body: "x" })).toBe("POLICY_DENIED");
		run = await start(gmail, { ...label_(WORK), ...recipient("*@partner.org") });
		const [again] = items(await run.ok("gmail_reply", { message: LIST, body: "x" }));
		expect(again?.to).toEqual(["list@partner.org"]);
		expect(gmail.sent()[2].get("Subject")).toBe("Re: plans");

		// Read on the original and Send on each address are both needed.
		run = await start(gmail, { ...label_("INBOX"), ...recipient("*@partner.org") });
		expect(await run.code("gmail_reply", { message: LIST, body: "x" })).toBe("POLICY_DENIED");
		run = await start(gmail, label_(WORK));
		expect(await run.code("gmail_reply", { message: LIST, body: "x" })).toBe("UNKNOWN_OPERATION");
		expect(gmail.writes.length).toBe(2);
		void [path, raw];
	});

	test("test_no_replies_to_own_mail_drafts_or_unreadable_headers", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, { ...label_("*"), ...recipient("*@example.org"), ...recipient("grace@example.com") });
		for (const id of [MINE, DRAFT, FROM_ALIAS]) expect(await run.code("gmail_reply", { message: id, body: "x" }), id).toBe("UNSUPPORTED_MESSAGE");
		// Sent by the account on someone's behalf.
		gmail.headersOf(ARCHIVED).push({ name: "Sender", value: ME });
		expect(await run.code("gmail_reply", { message: ARCHIVED, body: "x" })).toBe("UNSUPPORTED_MESSAGE");

		// A From that appears twice is never guessed at; only a grant on every recipient gets that far.
		gmail.headersOf(UNKNOWN).push({ name: "From", value: "grace@example.com" });
		expect(await run.code("gmail_reply", { message: UNKNOWN, body: "x" })).toBe("POLICY_DENIED");
		run = await start(gmail, { ...label_("*"), ...recipient("*") });
		expect(await run.code("gmail_reply", { message: UNKNOWN, body: "x" })).toBe("UNSUPPORTED_RECIPIENT");
		expect(gmail.writes).toEqual([]);
	});

	test("test_a_reply_address_changed_after_authorization_is_refused", async () => {
		const gmail = new FakeGmail();
		const run = await start(gmail, { ...label_("INBOX"), ...recipient("*@example.com") });
		let fetched = 0;
		gmail.hook = (_method, path) => {
			if (path === `/messages/${GRACE}`) {
				fetched++;
				if (fetched === 2) gmail.headersOf(GRACE).push({ name: "Reply-To", value: "x@example.com" });
			}
			return null;
		};
		expect(await run.code("gmail_reply", { message: GRACE, body: "x" })).toBe("MESSAGE_CHANGED");
		expect(gmail.writes).toEqual([]);
	});

	test("test_drafts_need_only_the_account", async () => {
		const gmail = new FakeGmail();
		let run = await start(gmail, DRAFTS);
		const args = { to: ["anyone@elsewhere.net"], bcc: ["ada@partner.org"], subject: "Plans", body: "Draft" };
		const [drafted] = items(await run.ok("gmail_create_draft", args));
		expect(drafted?.draft_id).toBe("r-1");
		expect(drafted?.to).toEqual(["anyone@elsewhere.net"]);
		let [path, body, raw] = gmail.sent();
		expect(path).toBe("/drafts");
		expect("threadId" in (body.message as JsonObject)).toBe(false);
		expect([raw.get("To"), raw.get("Bcc")]).toEqual(["anyone@elsewhere.net", "ada@partner.org"]);
		expect(await run.code("gmail_send_message", args)).toBe("UNKNOWN_OPERATION");
		// A reply draft also reads the original.
		run = await start(gmail, { ...DRAFTS, ...label_(WORK) });
		expect(await run.code("gmail_create_reply_draft", { message: GRACE, body: "x" })).toBe("POLICY_DENIED");

		run = await start(gmail, { ...DRAFTS, ...label_("INBOX") });
		const [reply] = items(await run.ok("gmail_create_reply_draft", { message: GRACE, body: "Sure" }));
		expect(reply).toEqual({ draft_id: "r-1", id: "18f00000000000f2", thread_id: THREAD, in_reply_to: GRACE, to: ["grace@example.com"] });
		[path, body, raw] = gmail.sent();
		expect(path).toBe("/drafts");
		expect((body.message as JsonObject).threadId).toBe(THREAD);
		expect(raw.get("To")).toBe("grace@example.com");
		expect(raw.get("In-Reply-To")).toBe(`<${GRACE}@mail.example.com>`);
		expect(await run.code("gmail_create_reply_draft", { message: MINE, body: "x" })).toBe("POLICY_DENIED");
		run = await start(gmail, { ...DRAFTS, ...label_("SENT") });
		expect(await run.code("gmail_create_reply_draft", { message: MINE, body: "x" })).toBe("UNSUPPORTED_MESSAGE");

		run = await start(gmail, DRAFTS, { scopes: ["openid", "email", READONLY_SCOPE, SEND_SCOPE] });
		expect(await run.code("gmail_create_draft", { ...args, body: "y" })).toBe("UNKNOWN_OPERATION");
		expect(gmail.writes.length).toBe(2);
	});
});

describe("the declarations", () => {
	const connector = gmailConnector();

	test("the registry accepts them, and their fingerprints are pinned", async () => {
		expect(() => validate([connector])).not.toThrow();
		const registry = await Registry.create([connector]);
		const fingerprints = Object.fromEntries(connector.operations.map((op) => [`gmail.${op.name}`, registry.contract("gmail", op.name)]));
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		// Bump `revision` when the meaning changed in a way the declaration does not show.
		expect(fingerprints).toEqual({
			"gmail.list_labels": "8f39a8a73094e193",
			"gmail.list_messages": "a110c98a78ead863",
			"gmail.read_message": "e5b5e3c58f918c7e",
			"gmail.read_thread": "7965c0208bf36524",
			"gmail.send_message": "bae6bfdfa8a83438",
			"gmail.reply": "650303d2a9f4f7c2",
			"gmail.create_draft": "e465af395ebed5ef",
			"gmail.create_reply_draft": "e3ac2e0064e8582b",
		});
	});

	test("the Worker's registry serves it, with the contracts the connector declares", async () => {
		expect(CONNECTORS.map((c) => c.slug)).toContain("gmail");
		const served = await connectorRegistry();
		const own = await Registry.create([connector]);
		for (const op of served.get("gmail").operations) expect(served.contract("gmail", op.name)).toBe(own.contract("gmail", op.name));
	});

	test("kinds, actions and the operations each action allows", () => {
		expect(connector.kinds.map((kind) => [kind.id, kind.actions, kind.wildcard ?? false, kind.hierarchical ?? false, kind.listed ?? true])).toEqual([
			["label", ["read"], true, true, true],
			["recipient", ["send"], true, true, false],
			["account", ["draft"], false, false, true],
		]);
		expect(connector.actions).toEqual([
			{ id: "read", label: "Read mail" },
			{ id: "send", label: "Send mail" },
			{ id: "draft", label: "Create drafts" },
		]);
		expect(connector.operations.map((op) => [op.name, op.needs, op.outputAction ?? "read", op.mutates ?? false, op.paginated ?? false])).toEqual([
			["list_labels", [["label", "read"]], "read", false, false],
			["list_messages", [["label", "read"]], "read", false, true],
			["read_message", [["label", "read"]], "read", false, false],
			["read_thread", [["label", "read"]], "read", false, false],
			["send_message", [["recipient", "send"]], "send", true, false],
			["reply", [["label", "read"], ["recipient", "send"]], "read", true, false],
			["create_draft", [["account", "draft"]], "draft", true, false],
			["create_reply_draft", [["label", "read"], ["account", "draft"]], "draft", true, false],
		]);
	});
});
