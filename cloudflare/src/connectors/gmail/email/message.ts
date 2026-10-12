// A plain text message as gmail/mime.py `raw` builds it with Python's email package: an EmailMessage
// under the SMTP policy, its To, Cc, Bcc, Subject, In-Reply-To and References set in that order, then
// `set_content(body, charset="utf-8", cte="quoted-printable")`, written by BytesGenerator. Each header is
// parsed and folded as the package does (parser.ts, fold.ts); the three MIME headers set_content adds are
// constants, as is their folding.

import { utf8Strict } from "../../../lib/bytes.ts";
import { urlsafeB64encode } from "./base64.ts";
import { MessageError, ValueError } from "./errors.ts";
import { LINESEP, foldHeader } from "./fold.ts";
import { pySplitlines } from "./legacy.ts";
import { type TokenList, getAddressList, getUnstructured, parseMessageIds } from "./parser.ts";

/** email.errors.HeaderWriteError: a folded header would hold a line break that does not continue it. */
export class HeaderWriteError extends MessageError {}

const MIME_HEADERS = 'Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\nMIME-Version: 1.0\r\n';

const QP_SAFE = new Set<number>([...' !"#$%&\'()*+,-./0123456789:;<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\t\r\n'].map((char) => char.charCodeAt(0)));

function qpQuote(code: number): string {
	return `=${code.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** `quoprimime.body_encode(body, maxlinelen)` with eol "\n", on a Latin-1 text of the body's bytes. */
export function bodyEncode(body: string, maxlinelen: number): string {
	if (maxlinelen < 4) throw new ValueError("maxlinelen must be at least 4");
	if (!body) return body;
	let translated = "";
	for (let i = 0; i < body.length; i++) {
		const code = body.charCodeAt(i);
		translated += QP_SAFE.has(code) ? body[i] : qpQuote(code);
	}
	const softBreak = "=\n";
	const maxlinelen1 = maxlinelen - 1;
	const encoded: string[] = [];
	for (const line of pySplitlines(translated)) {
		let start = 0;
		const laststart = line.length - 1 - maxlinelen;
		while (start <= laststart) {
			const stop = start + maxlinelen1;
			// make sure we don't break up an escape sequence
			if (line[stop - 2] === "=") {
				encoded.push(line.slice(start, stop - 1));
				start = stop - 2;
			} else if (line[stop - 1] === "=") {
				encoded.push(line.slice(start, stop));
				start = stop - 1;
			} else {
				encoded.push(`${line.slice(start, stop)}=`);
				start = stop;
			}
		}
		// handle rest of line, special case if line ends in whitespace
		const last = line[line.length - 1];
		if (line && (last === " " || last === "\t")) {
			const room = start - laststart;
			let q: string;
			if (room >= 3) q = qpQuote(last.charCodeAt(0));
			else if (room === 2) q = last + softBreak;
			else q = softBreak + qpQuote(last.charCodeAt(0));
			encoded.push(line.slice(start, -1) + q);
		} else encoded.push(line.slice(start));
	}
	const final = translated[translated.length - 1];
	if (final === "\r" || final === "\n") encoded.push("");
	return encoded.join("\n");
}

/** `bytes.splitlines()`: \n, \r and \r\n. */
function splitByteLines(bytes: Uint8Array): Uint8Array[] {
	const lines: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte !== 0x0a && byte !== 0x0d) continue;
		lines.push(bytes.subarray(start, i));
		if (byte === 0x0d && bytes[i + 1] === 0x0a) i++;
		start = i + 1;
	}
	if (start < bytes.length) lines.push(bytes.subarray(start));
	return lines;
}

function latin1(bytes: Uint8Array): string {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return text;
}

/** contentmanager `_encode_text` for UTF-8 and quoted-printable: lines joined by \n, then encoded. */
function encodeBody(body: string): string {
	const lines = splitByteLines(utf8Strict(body));
	const parts: string[] = [];
	for (const line of lines) parts.push(latin1(line));
	return bodyEncode(`${parts.join("\n")}\n`, 78);
}

const NEWLINE_WITHOUT_FWSP = /\r\n[^ \t]|\r[^ \n\t]|\n[^ \t]/;

function header(name: string, value: string, parse: (value: string) => TokenList): string {
	// header_store_parse: a value that is more than one line is refused.
	if (pySplitlines(value).length > 1) throw new ValueError("Header values may not contain linefeed or carriage return characters");
	const folded = foldHeader(name, parse(value));
	if (!/^[\u0000-\u007f]*$/.test(folded)) throw new ValueError("'ascii' codec can't encode characters");
	if (!folded.endsWith(LINESEP) || NEWLINE_WITHOUT_FWSP.test(folded.slice(0, -LINESEP.length))) throw new HeaderWriteError(`folded header contains newline: ${folded}`);
	return folded;
}

export interface RawMessage {
	to: readonly string[];
	cc?: readonly string[];
	bcc?: readonly string[];
	subject: string;
	body: string;
	inReplyTo?: readonly [inReplyTo: string, references: string] | null;
}

/** The message's bytes as ASCII text (BytesGenerator under the SMTP policy). */
export function messageText(message: RawMessage): string {
	let out = "";
	if (message.to.length) out += header("To", message.to.join(", "), getAddressList);
	if (message.cc?.length) out += header("Cc", message.cc.join(", "), getAddressList);
	if (message.bcc?.length) out += header("Bcc", message.bcc.join(", "), getAddressList);
	out += header("Subject", message.subject, getUnstructured);
	if (message.inReplyTo) {
		out += header("In-Reply-To", message.inReplyTo[0], parseMessageIds);
		out += header("References", message.inReplyTo[1], parseMessageIds);
	}
	const payload = encodeBody(message.body);
	out += `${MIME_HEADERS}\r\n`;
	// _write_lines: every line break becomes CRLF; the text after the last one is written if not empty.
	const lines = payload.split(/\r\n|\r|\n/);
	for (const line of lines.slice(0, -1)) out += `${line}\r\n`;
	out += lines[lines.length - 1];
	return out;
}

/** gmail/mime.py `raw`: the message as Gmail takes it, base64url. */
export function rawMessage(message: RawMessage): string {
	const text = messageText(message);
	return urlsafeB64encode(Uint8Array.from(text, (char) => char.charCodeAt(0)));
}
