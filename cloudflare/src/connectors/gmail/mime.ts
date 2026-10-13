// Reading and writing mail as Gmail carries it: MIME parts,
// headers and raw RFC 5322 messages.
//
// Reading takes the text of a message from its MIME tree: plain text where a part offers it, otherwise HTML
// converted to text with the Web connector's converter (which drops images and keeps only absolute http(s)
// links, so text shown to the model cannot load anything). Attachments, and messages attached to this one
// (`message/rfc822`, read as a whole subtree), are named, never read. Gmail can keep a large body part apart
// from the message (`attachmentId`); such a body is reported as unavailable rather than empty.
//
// Address headers are parsed strictly: a header that appears twice, or holds anything that is not a plain
// address Minerva accepts (see lib/addresses.ts), is not guessed at.
//
// Python's email package is ported where mime.py uses it (email/): encoded words and charsets for header
// text, Content-Type parameters, the address-list parser with its defects, and the SMTP policy's header
// folding and quoted-printable bodies for the messages Minerva sends.

import { OperationError } from "../../gateway/connector.ts";
import { sliceText } from "../../lib/text.ts";
import * as addresses from "../../lib/addresses.ts";
import type { Part } from "./client.ts";
import { b64decodeUrlsafeStrict } from "./email/base64.ts";
import { decodeWords } from "postal-mime";
import { decodeCharset } from "../../lib/charset.ts";
import { BinasciiError, IndexError, PyTypeError, ValueError } from "./email/errors.ts";
import { ContentHeaders } from "./email/legacy.ts";
import { type RawMessage, rawMessage } from "./email/message.ts";
import { DOT_ATOM_ENDS, type TokenList, encodedInAddrSpec, getAddressList, hasAny, quoteString } from "./email/parser.ts";
import { htmlToText } from "../../lib/markdown.ts";

export const MAX_DEPTH = 10;
export const MAX_PARTS = 200;
export const MAX_ATTACHMENTS = 20;
export const MAX_HEADER = 2000;
export const MAX_FILENAME = 200;
export const MAX_REFERENCES = 20;
/**
 * A Message-ID or a reference to one: angle brackets around two runs of printable ASCII, without spaces or
 * angle brackets, joined by one @.
 */
export const MESSAGE_ID = /^<[!-;=?A-~]{1,200}@[!-;=?A-~]{1,200}>$/;

export interface Attachment {
	filename: string | null;
	mime_type: string | null;
	size: number | null;
}

export class Content {
	text = "";
	/** A body part Gmail keeps apart from the message, or could not be decoded: the text is incomplete. */
	unavailable = false;
	attachments: Attachment[] = [];
	parts = 0;
}

/** What `str.isprintable()` refuses: categories Other and Separator, except the ASCII space. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const SPACES = /\s+/g;

/** A header's value for display: encoded words decoded, on one line, cut to a bounded length. */
export function headerText(value: string | null): string | null {
	if (value === null) return null;
	let shown = "";
	for (const char of decodeWords(value)) shown += char !== " " && UNPRINTABLE.test(char) ? " " : char;
	return sliceText(shown.replace(SPACES, " ").trim(), 0, MAX_HEADER);
}

function header(part: Part, name: string): string | null {
	const folded = name.toLowerCase();
	return part.headers.find((h) => h.name.toLowerCase() === folded)?.value ?? null;
}

/** The part's Content-Type and Content-Disposition, as the standard library's Message reads them. */
export function contentType(part: Part): ContentHeaders {
	const headers: [string, string][] = [];
	for (const name of ["Content-Type", "Content-Disposition"]) {
		const value = header(part, name);
		if (value !== null) headers.push([name, value]);
	}
	return new ContentHeaders(headers);
}

/** The part's body as text, or null when Gmail keeps it apart or it cannot be decoded. */
function decodeBody(part: Part): string | null {
	const body = part.body;
	if (body === null || body.attachmentId) return null;
	if (body.data === null) return !body.size ? "" : null;
	let data: Uint8Array;
	try {
		data = b64decodeUrlsafeStrict(body.data + "=".repeat((4 - (body.data.length % 4)) % 4));
	} catch (error) {
		if (error instanceof BinasciiError || error instanceof ValueError) return null;
		throw error;
	}
	// The sender names the charset: one the runtime lacks is read as UTF-8.
	return decodeCharset(data, contentType(part).getContentCharset() || "utf-8") ?? (decodeCharset(data, "utf-8") as string);
}

function isAttachment(part: Part): boolean {
	return Boolean(part.filename) || contentType(part).getContentDisposition() === "attachment";
}

function addAttachment(content: Content, part: Part): void {
	if (content.attachments.length >= MAX_ATTACHMENTS) return;
	content.attachments.push({
		filename: part.filename ? sliceText(headerText(part.filename) as string, 0, MAX_FILENAME) : null,
		mime_type: sliceText(part.mimeType.toLowerCase(), 0, 100) || null,
		size: part.body ? part.body.size : null,
	});
}

function render(content: Content, part: Part, depth: number): string | null {
	content.parts += 1;
	if (content.parts > MAX_PARTS || depth > MAX_DEPTH) {
		content.unavailable = true;
		return null;
	}
	const mimeType = part.mimeType.toLowerCase();
	// An attachment is never read, whatever it holds, including a multipart one.
	if (mimeType === "message/rfc822" || isAttachment(part)) {
		addAttachment(content, part);
		return null;
	}
	if (mimeType === "multipart/alternative") {
		// Plain text where the sender offered it; otherwise the richest alternative, which comes last.
		const ordered = [...part.parts].reverse().sort((a, b) => Number(a.mimeType.toLowerCase() !== "text/plain") - Number(b.mimeType.toLowerCase() !== "text/plain"));
		for (const child of ordered) {
			const text = render(content, child, depth + 1);
			if (text !== null) return text;
		}
		return null;
	}
	if (mimeType === "multipart/related" && part.parts.length) {
		// The document is the root part (`start`, or else the first); the rest are resources it uses.
		const start = contentType(part).getParam("start");
		const root = part.parts.find((child) => start && header(child, "Content-ID") === start) ?? null;
		return render(content, root ?? (part.parts[0] as Part), depth + 1);
	}
	if (mimeType.startsWith("multipart/")) {
		const texts: string[] = [];
		for (const child of part.parts) {
			const text = render(content, child, depth + 1);
			if (text) texts.push(text);
		}
		return texts.length ? texts.join("\n\n") : null;
	}
	if (mimeType !== "text/plain" && mimeType !== "text/html") {
		if (["image/", "audio/", "video/", "application/"].some((prefix) => mimeType.startsWith(prefix))) addAttachment(content, part);
		return null;
	}
	let text = decodeBody(part);
	if (text === null) {
		content.unavailable = true;
		return null;
	}
	// No base address: relative links, which mean nothing outside the sender's mail client, are dropped.
	if (mimeType === "text/html") [text] = htmlToText(text);
	return text.replaceAll("\r\n", "\n").trim();
}

export function content(payload: Part | null): Content {
	const found = new Content();
	if (payload !== null) found.text = render(found, payload, 0) || "";
	return found;
}

/** An address of email.headerregistry: its addr_spec, quoted where its local part needs it. */
function addrSpec(username: string, domain: string): string {
	const lp = hasAny(username, DOT_ATOM_ENDS) ? quoteString(username) : username;
	if (domain) return `${lp}@${domain}`;
	if (!lp) return "<>";
	return lp;
}

/**
 * `default.header_factory("reply-to", value)`: its defect count, its addresses' addr_specs, and their parts
 * (display name, user name, domain; the tests compare them with the standard library's), and whether an
 * encoded word stands inside an address (which Python decodes into it, and `mailboxes` refuses).
 */
export function addressHeader(value: string): { defects: number; specs: string[]; parts: [string, string, string][]; encodedAddress: boolean } {
	const list = getAddressList(value);
	const specs: string[] = [];
	const found: [string, string, string][] = [];
	for (const address of list.addresses) {
		void address.displayName;
		for (const mailbox of address.allMailboxes as (TokenList & { displayName: string | null; localPart: string | null; domain: string | null })[]) {
			const parts = [mailbox.displayName || "", mailbox.localPart || "", mailbox.domain || ""];
			if (parts.some((part) => part.includes("\r") || part.includes("\n"))) throw new ValueError("invalid arguments; address parts cannot contain CR or LF");
			specs.push(addrSpec(parts[1] as string, parts[2] as string));
			found.push(parts as [string, string, string]);
		}
	}
	return { defects: list.allDefects.length, specs, parts: found, encodedAddress: encodedInAddrSpec(list) };
}

/**
 * The canonical addresses in one address header, or null when it appears more than once, the standard
 * library's parser finds any defect in it, an encoded word stands inside an address, an address is not one
 * Minerva accepts, or it names no address.
 */
export function mailboxes(values: readonly string[]): string[] | null {
	if (values.length !== 1) return null;
	let parsed: { defects: number; specs: string[]; encodedAddress: boolean };
	try {
		parsed = addressHeader(values[0] as string);
	} catch (error) {
		if (error instanceof ValueError || error instanceof IndexError || error instanceof PyTypeError) return null;
		throw error;
	}
	// A header with a defect, or with an encoded word inside an address (RFC 2047 forbids it, and Python decoded
	// it into the address, which a different decoder could spell differently), is not guessed at.
	if (parsed.defects || parsed.encodedAddress) return null;
	const found: string[] = [];
	for (const spec of parsed.specs) {
		let address: string;
		try {
			address = addresses.parse(spec);
		} catch (error) {
			if (error instanceof OperationError) return null;
			throw error;
		}
		if (!found.includes(address)) found.push(address);
	}
	return found.length ? found : null;
}

export function messageId(value: string | null): string | null {
	const stripped = value ? value.trim() : null;
	return stripped && MESSAGE_ID.test(stripped) ? stripped : null;
}

/**
 * In-Reply-To and References for a reply: the original's Message-ID, after the last well-formed ids its
 * References header names. Null when the original has no single well-formed Message-ID.
 */
export function threading(messageIds: readonly string[], references: readonly string[]): [string, string] | null {
	if (messageIds.length !== 1) return null;
	const original = messageId(messageIds[0] as string);
	if (original === null) return null;
	// A References header that appears twice is left out rather than guessed at.
	const named = references.length === 1 ? (references[0] as string).split(/\s+/).filter(Boolean) : [];
	const chain = named.filter((ref) => MESSAGE_ID.test(ref) && ref !== original);
	return [original, [...chain.slice(-(MAX_REFERENCES - 1)), original].join(" ")];
}

export function replySubject(subject: string | null): string {
	const text = headerText(subject) || "";
	if (sliceText(text, 0, 3).toLowerCase() === "re:") return sliceText(text, 0, 900);
	return sliceText(`Re: ${text}`, 0, 900);
}

/**
 * A plain text message as Gmail takes it (base64url). It has no From: Gmail sends from the account's default
 * address. Bcc stays in the message Gmail is given; Gmail leaves it out of what it delivers.
 */
export function raw(message: RawMessage): string {
	return rawMessage(message);
}
