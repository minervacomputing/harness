// Mail as Gmail's API carries it: the MIME part tree of a message it returns, the address headers a reply is
// sent by, and the raw RFC 5322 messages Minerva sends.
//
// Reading takes the text of a message from Gmail's part tree: plain text where a part offers it, otherwise HTML
// converted to text by lib/markdown.ts (which drops images and keeps only absolute http(s) links, so text shown to
// the model cannot load anything). Attachments, and messages attached to this one (`message/rfc822`, read as a whole
// subtree), are named, never read. Gmail can keep a large body part apart from the message (`attachmentId`); such a
// body is reported as unavailable rather than empty. Header text is decoded by postal-mime (`decodeWords`, RFC 2047)
// and shown on one line.
//
// Reply addresses decide who mail goes to, so they are read strictly (`mailboxes`), never repaired: a header is
// a comma-separated list of `addr`, `<addr>`, `Name <addr>` or `"Quoted Name" <addr>`, and anything else
// (groups, comments, a missing bracket, text after an address, a header that appears twice) is refused rather
// than guessed at. Tolerant parsers such as postal-mime's `addressParser` read an address out of such headers.
//
// Messages are built from canonical addresses and validated Message-IDs only, so no header value can hold a
// line break: the subject is written as RFC 2047 encoded words unless it is short printable ASCII, and the body
// is UTF-8 in base64.

import { decodeWords } from "postal-mime";
import * as addresses from "../../lib/addresses.ts";
import { base64, base64url, fromBase64, utf8 } from "../../lib/bytes.ts";
import { decodeCharset } from "../../lib/charset.ts";
import { htmlToText } from "../../lib/markdown.ts";
import { sliceText } from "../../lib/text.ts";
import type { Part } from "./client.ts";

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

/** Controls, format and private-use characters, unassigned code points and separators other than the space. */
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

/**
 * A Content-Type or Content-Disposition value: its type, lowercased, and its parameters by lowercased name (the
 * first of each name), quoted values unquoted. Semicolons inside quoted strings do not split it. RFC 2231's
 * sections (`name*0`, `name*1`) are joined, and an extended value (`name*`) loses its `charset'language'` prefix
 * and is percent-decoded byte by byte: the parameters read here (charset, start) are ASCII.
 */
function parameters(value: string | null): { type: string; params: Map<string, string> } {
	const text = value ?? "";
	const pieces: string[] = [];
	let piece = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		if (quoted && char === "\\") {
			piece += char + (text[++i] ?? "");
			continue;
		}
		if (char === '"') quoted = !quoted;
		if (char === ";" && !quoted) {
			pieces.push(piece);
			piece = "";
		} else piece += char;
	}
	pieces.push(piece);
	const params = new Map<string, string>();
	const sections = new Map<string, string[]>();
	for (const item of pieces.slice(1)) {
		const equals = item.indexOf("=");
		const key = equals < 0 ? null : /^([^*\s]+)(?:\*(\d{1,2}))?(\*?)$/.exec(item.slice(0, equals).trim().toLowerCase());
		if (!key) continue;
		const [, name, section, extended] = key as unknown as [string, string, string | undefined, string];
		let param = item.slice(equals + 1).trim();
		if (param.length >= 2 && param.startsWith('"') && param.endsWith('"')) param = param.slice(1, -1).replace(/\\(.)/gs, "$1");
		if (extended) {
			if (section === undefined || section === "0") param = param.replace(/^[^']*'[^']*'/, "");
			param = param.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		}
		if (section === undefined) {
			if (!params.has(name)) params.set(name, param);
		} else {
			const list = sections.get(name) ?? [];
			list[Number(section)] ??= param;
			sections.set(name, list);
		}
	}
	for (const [name, list] of sections) if (!params.has(name)) params.set(name, list.join(""));
	return { type: (pieces[0] as string).trim().toLowerCase(), params };
}

/** A body as Gmail sends it, base64url with or without padding; null for anything else. */
function base64urlBytes(data: string): Uint8Array | null {
	const bare = data.replace(/={1,2}$/, "");
	if (!/^[A-Za-z0-9_-]*$/.test(bare) || bare.length % 4 === 1 || (bare !== data && data.length % 4 !== 0)) return null;
	return fromBase64(bare);
}

/** The part's body as text, or null when Gmail keeps it apart or it is not base64url. */
function decodeBody(part: Part): string | null {
	const body = part.body;
	if (body === null || body.attachmentId) return null;
	if (body.data === null) return !body.size ? "" : null;
	const data = base64urlBytes(body.data);
	if (data === null) return null;
	// The sender names the charset: one the runtime lacks is read as UTF-8.
	const charset = parameters(header(part, "Content-Type")).params.get("charset") || "utf-8";
	return decodeCharset(data, charset) ?? (decodeCharset(data, "utf-8") as string);
}

function isAttachment(part: Part): boolean {
	return Boolean(part.filename) || parameters(header(part, "Content-Disposition")).type === "attachment";
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
		const start = parameters(header(part, "Content-Type")).params.get("start");
		const root = start ? part.parts.find((child) => header(child, "Content-ID")?.trim() === start.trim()) : undefined;
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
	if (mimeType === "text/html") text = htmlToText(text);
	return text.replaceAll("\r\n", "\n").trim();
}

export function content(payload: Part | null): Content {
	const found = new Content();
	if (payload !== null) found.text = render(found, payload, 0) || "";
	return found;
}

/** Longer than any address header Minerva replies to (at most ten addresses). */
const MAX_ADDRESS_HEADER = 4000;
/** Controls (C0 but tab, DEL, C1) and line separators anywhere in an address header: it is refused. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;
/** A word of a display name: no white space, controls, quotes or RFC 5322's specials (but the dot). */
const WORD = String.raw`[^\s\u0000-\u001f\u007f-\u009f()<>\[\]:;@\\,"]+`;
/** An address as written: what addresses.parse then accepts or refuses. No white space, quotes, brackets or specials but "@" and ".". */
const ADDRESS = String.raw`[^\s\u0000-\u001f\u007f-\u009f()<>\[\]:;\\,"]+`;
const NAME = String.raw`(?:"(?:[^"\\]|\\.)*"|${WORD}(?:[ \t]+${WORD})*)`;
/** `addr`, `<addr>`, `Name <addr>` or `"Quoted Name" <addr>`, with optional white space around it. */
const MAILBOX = new RegExp(String.raw`^[ \t]*(?:(${ADDRESS})|(?:${NAME}[ \t]*)?<(${ADDRESS})>)[ \t]*$`);

/** The members of an address list: split at commas outside quoted strings; null for an unclosed quote. */
function members(value: string): string[] | null {
	const found: string[] = [];
	let start = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quoted && char === "\\") i++;
		else if (char === '"') quoted = !quoted;
		else if (char === "," && !quoted) {
			found.push(value.slice(start, i));
			start = i + 1;
		}
	}
	if (quoted) return null;
	found.push(value.slice(start));
	return found;
}

/**
 * The canonical addresses in one address header (From, Sender, Reply-To), duplicates dropped, or null when the
 * header is absent or appears more than once, holds a control character, or is not a list of plain mailboxes
 * whose addresses Minerva accepts (lib/addresses.ts). Display names are never decoded: they cannot change an
 * address. An encoded word inside an address is refused (addresses.parse does not accept "=" or "?" either).
 */
export function mailboxes(values: readonly string[]): string[] | null {
	if (values.length !== 1) return null;
	const value = values[0] as string;
	if (value.length > MAX_ADDRESS_HEADER || CONTROL.test(value)) return null;
	const list = members(value);
	if (list === null) return null;
	const found: string[] = [];
	for (const member of list) {
		const match = MAILBOX.exec(member);
		const written = match ? (match[1] ?? match[2]) : undefined;
		if (written === undefined || written.includes("=?")) return null;
		const result = addresses.checked(written);
		if (!result.ok) return null;
		if (!found.includes(result.address)) found.push(result.address);
	}
	return found;
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

export interface Outgoing {
	to: readonly string[];
	cc?: readonly string[];
	bcc?: readonly string[];
	subject: string;
	body: string;
	/** In-Reply-To and References, as `threading` gives them. */
	inReplyTo?: readonly [inReplyTo: string, references: string] | null;
}

const CRLF = "\r\n";
/** Lines continue with CRLF and a space: a reader joins them back into one header. */
const FOLD = `${CRLF} `;
/** UTF-8 bytes per encoded word: "Subject: " and one word of 68 characters fit in 78. */
const WORD_BYTES = 42;

function addressList(name: string, list: readonly string[]): string {
	for (const address of list) {
		const result = addresses.checked(address);
		if (!result.ok || result.address !== address) throw new TypeError("Mail is composed only for canonical addresses.");
	}
	return `${name}: ${list.join(`,${FOLD}`)}${CRLF}`;
}

/** The subject as it is when it is short printable ASCII, otherwise as UTF-8 encoded words, one per line. */
function subjectHeader(subject: string): string {
	if (/[\u0000-\u001f\u007f]/.test(subject)) throw new TypeError("A subject is one line without control characters.");
	if (/^[ -~]{0,69}$/.test(subject) && !subject.includes("=?")) return `Subject: ${subject}${CRLF}`;
	const words: string[] = [];
	let run = "";
	for (const char of subject) {
		if (run && utf8(run + char).length > WORD_BYTES) {
			words.push(run);
			run = "";
		}
		run += char;
	}
	if (run) words.push(run);
	return `Subject: ${words.map((word) => `=?UTF-8?B?${base64(utf8(word))}?=`).join(FOLD)}${CRLF}`;
}

function threadingHeaders([inReplyTo, references]: readonly [string, string]): string {
	const chain = references.split(" ");
	if (![inReplyTo, ...chain].every((id) => MESSAGE_ID.test(id))) throw new TypeError("Replies are threaded only by well-formed Message-IDs.");
	return `In-Reply-To: ${inReplyTo}${CRLF}References: ${chain.join(FOLD)}${CRLF}`;
}

/**
 * A plain text message as Gmail takes it (base64url). It has no From: Gmail sends from the account's default
 * address. Bcc stays in the message Gmail is given; Gmail leaves it out of what it delivers.
 */
export function raw(message: Outgoing): string {
	let text = addressList("To", message.to);
	if (message.cc?.length) text += addressList("Cc", message.cc);
	if (message.bcc?.length) text += addressList("Bcc", message.bcc);
	text += subjectHeader(message.subject);
	if (message.inReplyTo) text += threadingHeaders(message.inReplyTo);
	text += `MIME-Version: 1.0${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}`;
	const body = base64(utf8(message.body.replace(/\r\n|\r|\n/g, CRLF)));
	for (let i = 0; i < body.length; i += 76) text += body.slice(i, i + 76) + CRLF;
	return base64url(utf8(text));
}
