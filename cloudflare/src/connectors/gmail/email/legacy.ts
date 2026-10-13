// The email package's older interfaces that gmail/mime.py uses: the compat32 `Message` methods that read a
// part's Content-Type and Content-Disposition parameters (`get_content_charset`, `get_param`,
// `get_content_disposition`), with `_parseparam`'s quirks and RFC 2231 parameters. (A header's text, with its
// encoded words, is decoded by postal-mime: gmail/mime.ts `headerText`.)

import { decodeCharsetStrictly } from "../../../lib/charset.ts";

/** `str.splitlines()`. */
export function pySplitlines(text: string): string[] {
	const lines = text.split(/\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return text === "" ? [] : lines;
}

function bytesOf(text: string): Uint8Array {
	return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

// compat32 Message parameters.

/** str.find(sub, start, end) with Python's slice rules. */
function find(s: string, sub: string, start: number, end?: number): number {
	const slice = s.slice(start, end);
	const at = slice.indexOf(sub);
	if (at < 0) return -1;
	const base = start < 0 ? Math.max(0, s.length + start) : Math.min(start, s.length);
	return base + at;
}

function count(s: string, sub: string, start: number, end: number): number {
	const slice = s.slice(start, end);
	let n = 0;
	for (let at = slice.indexOf(sub); at >= 0; at = slice.indexOf(sub, at + sub.length)) n++;
	return n;
}

/** `email.message._parseparam`, quirks included. */
export function parseParam(value: string): string[] {
	const s = `;${value}`;
	const plist: string[] = [];
	let start = 0;
	while (find(s, ";", start) === start) {
		start += 1;
		let end = find(s, ";", start);
		let ind = start;
		let diff = 0;
		while (end > 0) {
			diff += count(s, '"', ind, end) - count(s, '\\"', ind, end);
			if (diff % 2 === 0) break;
			[end, ind] = [ind, find(s, ";", end + 1)];
		}
		if (end < 0) end = s.length;
		const i = find(s, "=", start, end);
		const f = i === -1 ? s.slice(start, end) : `${s.slice(start, i).trimEnd().toLowerCase()}=${s.slice(i + 1, end).trimStart()}`;
		plist.push(f.trim());
		start = end;
	}
	return plist;
}

/** `email.message._splitparam(param)[0]`. */
function splitParamHead(param: string): string {
	const at = param.indexOf(";");
	return (at < 0 ? param : param.slice(0, at)).trim();
}

/** `email.utils.unquote`. */
export function unquote(text: string): string {
	if (text.length > 1) {
		if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll("\\\\", "\\").replaceAll('\\"', '"');
		if (text.startsWith("<") && text.endsWith(">")) return text.slice(1, -1);
	}
	return text;
}

/** `email.utils.quote`. */
function quote(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** `urllib.parse.unquote(text, encoding="latin-1")`. */
function unquoteLatin1(text: string): string {
	return text.replace(/[\u0000-\u007f]+/g, (run) => run.replace(/%[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16))));
}

/** An RFC 2231 value: (charset, language, value), charset and language null when it could not be split. */
export type Rfc2231 = [charset: string | null, language: string | null, value: string];
type ParamValue = string | Rfc2231;

const CONTINUATION = /^([A-Za-z0-9_]+)\*(([0-9]+)\*?)?$/;

/** `email.utils.decode_params`. */
function decodeParams(params: [string, string][]): [string, ParamValue][] {
	const out: [string, ParamValue][] = [params[0] as [string, string]];
	const rfc2231 = new Map<string, [number | null, string, boolean][]>();
	for (const [name, raw] of params.slice(1)) {
		const encoded = name.endsWith("*");
		const value = unquote(raw);
		const match = CONTINUATION.exec(name);
		if (match) {
			const key = match[1] as string;
			const num = match[3] === undefined ? null : Number.parseInt(match[3], 10);
			if (!rfc2231.has(key)) rfc2231.set(key, []);
			rfc2231.get(key)?.push([num, value, encoded]);
		} else out.push([name, `"${quote(value)}"`]);
	}
	for (const [name, all] of rfc2231) {
		let continuations = all;
		const hasZero = continuations.some((x) => x[0] === 0);
		if (hasZero) continuations = continuations.filter((x) => x[0] !== null);
		else continuations = continuations.map((x) => [x[0] || 0, x[1], x[2]]);
		continuations = [...continuations].sort((a, b) => (a[0] as number) - (b[0] as number));
		let extended = false;
		const parts: string[] = [];
		for (const [, s, encoded] of continuations) {
			if (encoded) {
				parts.push(unquoteLatin1(s));
				extended = true;
			} else parts.push(s);
		}
		const value = quote(parts.join(""));
		if (extended) {
			const split = value.split("'");
			if (split.length <= 2) out.push([name, [null, null, `"${value}"`]]);
			else out.push([name, [split[0] as string, split[1] as string, `"${split.slice(2).join("'")}"`]]);
		} else out.push([name, `"${value}"`]);
	}
	return out;
}

/** A part's Content-Type and Content-Disposition as a compat32 Message holds them (gmail/mime.py `_content_type`). */
export class ContentHeaders {
	private readonly headers: readonly [name: string, value: string][];

	constructor(headers: readonly [name: string, value: string][]) {
		this.headers = headers;
	}

	/** `Message.get(name)`: the first header of that name, sanitized as compat32 fetches it. */
	get(name: string): string | null {
		const lowered = name.toLowerCase();
		for (const [key, value] of this.headers) {
			if (key.toLowerCase() !== lowered) continue;
			// A lone surrogate (Python's escaped byte) reads as U+FFFD.
			return value.toWellFormed();
		}
		return null;
	}

	has(name: string): boolean {
		const lowered = name.toLowerCase();
		return this.headers.some(([key]) => key.toLowerCase() === lowered);
	}

	private paramsPreserve(header: string): [string, ParamValue][] | null {
		const value = this.get(header);
		if (value === null) return null;
		const params: [string, string][] = parseParam(value).map((p) => {
			const at = p.indexOf("=");
			return at < 0 ? [p.trim(), ""] : [p.slice(0, at).trim(), p.slice(at + 1).trim()];
		});
		return decodeParams(params);
	}

	/** `Message.get_param(param, header="content-type")`, unquoted. */
	getParam(param: string, header = "content-type"): ParamValue | null {
		if (!this.has(header)) return null;
		for (const [key, value] of this.paramsPreserve(header) ?? []) {
			if (key.toLowerCase() !== param.toLowerCase()) continue;
			return typeof value === "string" ? unquote(value) : [value[0], value[1], unquote(value[2])];
		}
		return null;
	}

	/** `Message.get_content_charset()`. */
	getContentCharset(): string | null {
		const found = this.getParam("charset");
		if (found === null) return null;
		let charset: string;
		if (typeof found !== "string") {
			// RFC 2231 encoded, so decode it, and it better end up as ascii.
			const pcharset = found[0] || "us-ascii";
			const decoded = /^[\u0000-\u00ff]*$/.test(found[2]) ? decodeCharsetStrictly(bytesOf(found[2]), pcharset) : null;
			charset = decoded ?? found[2];
		} else charset = found;
		if (!/^[\u0000-\u007f]*$/.test(charset)) return null;
		return charset.toLowerCase();
	}

	/** `Message.get_content_disposition()`. */
	getContentDisposition(): string | null {
		const value = this.get("content-disposition");
		if (value === null) return null;
		return splitParamHead(value).toLowerCase();
	}
}

