// Python 3.14's `urllib.parse` as the connectors use it: `urlsplit` with every check that makes it raise
// ValueError (brackets, IPv6 and IPvFuture hosts, characters that NFKC turns into delimiters), the result's
// `hostname` and `port`, `urljoin` (3.14's, which keeps an empty query or fragment apart from a missing
// one) and `quote`, ported line by line. Moved here from connectors/sentry/address.ts for the Web connector
// (lib/sites.ts `parseUrl`, lib/markdown.ts links), which needs all of it.
//
// NFKC comes from the runtime's Unicode tables, Python's from its own (Unicode 16); a character assigned
// since then could normalize differently. The connectors that read a link's query or host (slack, microsoft,
// notion, atlassian, github, sentry, web) all use this port; `urlsplitStrict` raises ValueError with Python's
// messages, `urlsplit` gives null instead.

import { isIpAddress } from "./ipaddress.ts";
import { pythonLower } from "./lower.ts";
import { ValueError } from "./pyerrors.ts";
import { pythonRepr, unquote } from "./text.ts";

/** `urlsplit(url)`'s five parts. */
export interface SplitResult {
	scheme: string;
	netloc: string;
	path: string;
	query: string;
	fragment: string;
}

/** `_urlsplit`'s parts: null where the URL has no such part (an empty query is "", a missing one null). */
interface Parts {
	scheme: string | null;
	netloc: string | null;
	path: string;
	query: string | null;
	fragment: string | null;
}

const SCHEME_CHARS = /^[A-Za-z0-9+.-]*$/;
/** `_WHATWG_C0_CONTROL_OR_SPACE`, stripped from the start. */
const LEADING_C0_OR_SPACE = /^[\x00-\x20]+/;
/** `_UNSAFE_URL_BYTES_TO_REMOVE`, removed everywhere. */
const UNSAFE = /[\t\r\n]/g;
const USES_RELATIVE: ReadonlySet<string> = new Set([
	"",
	"ftp",
	"http",
	"gopher",
	"nntp",
	"imap",
	"wais",
	"file",
	"https",
	"shttp",
	"mms",
	"prospero",
	"rtsp",
	"rtsps",
	"rtspu",
	"sftp",
	"svn",
	"svn+ssh",
	"ws",
	"wss",
]);
const USES_NETLOC: ReadonlySet<string> = new Set([
	"",
	"ftp",
	"http",
	"gopher",
	"nntp",
	"telnet",
	"imap",
	"wais",
	"file",
	"mms",
	"https",
	"shttp",
	"snews",
	"prospero",
	"rtsp",
	"rtsps",
	"rtspu",
	"rsync",
	"svn",
	"svn+ssh",
	"sftp",
	"nfs",
	"git",
	"git+ssh",
	"ws",
	"wss",
	"itms-services",
]);

/** `text.partition(separator)`. */
export function partition(text: string, separator: string): [string, string, string] {
	const at = text.indexOf(separator);
	return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

/** `text.rpartition(separator)`. */
export function rpartition(text: string, separator: string): [string, string, string] {
	const at = text.lastIndexOf(separator);
	return at < 0 ? ["", "", text] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function isAscii(text: string): boolean {
	return /^[\x00-\x7f]*$/.test(text);
}

/** `_check_bracketed_host`: an IPvFuture literal or an IPv6 address (`ipaddress.ip_address`, scope ids included), never IPv4. */
function checkBracketedHost(hostname: string): void {
	if (hostname.startsWith("v") || hostname.startsWith("V")) {
		if (!/^[vV][a-fA-F0-9]+\.[^\n]+$/.test(hostname)) throw new ValueError("IPvFuture address is invalid");
		return;
	}
	const kind = isIpAddress(hostname);
	if (kind === null) throw new ValueError(`${pythonRepr(hostname)} does not appear to be an IPv4 or IPv6 address`);
	if (kind === "v4") throw new ValueError("An IPv4 address cannot be in brackets");
}

/** `_check_bracketed_netloc`. */
function checkBracketedNetloc(netloc: string): void {
	const hostAndPort = rpartition(netloc, "@")[2];
	const [before, open, bracketed] = partition(hostAndPort, "[");
	let hostname: string;
	if (open) {
		// No data is allowed before a bracket, nor after it but before the port delimiter.
		if (before) throw new ValueError("Invalid IPv6 URL");
		const [inside, , port] = partition(bracketed, "]");
		if (port && !port.startsWith(":")) throw new ValueError("Invalid IPv6 URL");
		hostname = inside;
	} else {
		hostname = partition(hostAndPort, ":")[0];
	}
	checkBracketedHost(hostname);
}

/** `_checknetloc`: characters such as U+2100 that NFKC turns into a delimiter. */
function checkNetloc(netloc: string | null): void {
	if (!netloc || isAscii(netloc)) return;
	const bare = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
	const normalized = bare.normalize("NFKC");
	if (bare === normalized) return;
	if ([..."/?#@:"].some((char) => normalized.includes(char))) {
		throw new ValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
	}
}

/** `_urlsplit(url, None)`; ValueError, with Python's message, where it raises. */
function splitParts(input: string): Parts {
	let url = input.replace(LEADING_C0_OR_SPACE, "").replace(UNSAFE, "");
	let scheme: string | null = null;
	let netloc: string | null = null;
	let query: string | null = null;
	let fragment: string | null = null;
	const colon = url.indexOf(":");
	if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
		scheme = url.slice(0, colon).toLowerCase();
		url = url.slice(colon + 1);
	}
	if (url.startsWith("//")) {
		// `_splitnetloc(url, 2)`: up to the first "/", "?" or "#".
		const ends = ["/", "?", "#"].map((char) => url.indexOf(char, 2)).filter((at) => at >= 0);
		const end = ends.length ? Math.min(...ends) : url.length;
		netloc = url.slice(2, end);
		url = url.slice(end);
		const open = netloc.includes("[");
		const close = netloc.includes("]");
		if (open !== close) throw new ValueError("Invalid IPv6 URL");
		if (open && close) checkBracketedNetloc(netloc);
	}
	if (url.includes("#")) [url, , fragment] = partition(url, "#");
	if (url.includes("?")) [url, , query] = partition(url, "?");
	checkNetloc(netloc);
	return { scheme, netloc, path: url, query, fragment };
}

function result(parts: Parts): SplitResult {
	return { scheme: parts.scheme ?? "", netloc: parts.netloc ?? "", path: parts.path, query: parts.query ?? "", fragment: parts.fragment ?? "" };
}

/** `urllib.parse.urlsplit(url)`, or null where it raises ValueError. */
export function urlsplit(input: string): SplitResult | null {
	try {
		return result(splitParts(input));
	} catch (error) {
		if (error instanceof ValueError) return null;
		throw error;
	}
}

/** `urllib.parse.urlsplit(url)`; ValueError, with Python's message, where it raises. */
export function urlsplitStrict(input: string): SplitResult {
	return result(splitParts(input));
}

/** `parse_qs(query)`: "&"-separated pairs, "+" as a space, percent-decoded, pairs without a value dropped. */
export function parseQs(query: string): Map<string, string[]> {
	const parsed = new Map<string, string[]>();
	for (const pair of query.split("&")) {
		if (!pair) continue;
		const at = pair.indexOf("=");
		if (at < 0) continue;
		const rawValue = pair.slice(at + 1);
		if (!rawValue) continue;
		const name = unquote(pair.slice(0, at).replaceAll("+", " "));
		const value = unquote(rawValue.replaceAll("+", " "));
		const values = parsed.get(name);
		if (values === undefined) parsed.set(name, [value]);
		else values.push(value);
	}
	return parsed;
}

/** The result's `_hostinfo`: the host and the port as written, the port null when empty. */
export function hostinfo(netloc: string): [hostname: string, port: string | null] {
	const info = rpartition(netloc, "@")[2];
	const [, open, bracketed] = partition(info, "[");
	let hostname: string;
	let port: string;
	if (open) {
		const [inside, , rest] = partition(bracketed, "]");
		hostname = inside;
		port = partition(rest, ":")[2];
	} else {
		[hostname, , port] = partition(info, ":");
	}
	return [hostname, port || null];
}

/** The result's `hostname`: lowercased except for an IPv6 zone, null when empty. */
export function hostnameOf(netloc: string): string | null {
	const hostname = hostinfo(netloc)[0];
	if (!hostname) return null;
	const [host, percent, zone] = partition(hostname, "%");
	return pythonLower(host) + percent + zone;
}

/** The result's `port`: null when none is written; ValueError unless it is ASCII digits for 0 to 65535. */
export function portOf(netloc: string): number | null {
	const port = hostinfo(netloc)[1];
	if (port === null) return null;
	if (!/^[0-9]+$/.test(port)) throw new ValueError(`Port could not be cast to integer value as '${port}'`);
	const value = Number(port);
	if (value > 65535) throw new ValueError("Port out of range 0-65535");
	return value;
}

/** `_urlunsplit`, with null for a missing part. */
function unsplit(scheme: string | null, netloc: string | null, path: string, query: string | null, fragment: string | null): string {
	let url = path;
	if (netloc !== null) {
		if (url && !url.startsWith("/")) url = `/${url}`;
		url = `//${netloc}${url}`;
	} else if (url.startsWith("//")) {
		url = `//${url}`;
	}
	if (scheme) url = `${scheme}:${url}`;
	if (query !== null) url = `${url}?${query}`;
	if (fragment !== null) url = `${url}#${fragment}`;
	return url;
}

/** `urllib.parse.urljoin(base, url)`; ValueError where splitting either raises. */
export function urljoin(base: string, url: string): string {
	if (!base) return url;
	if (!url) return base;
	const b = splitParts(base);
	const u = splitParts(url);
	const scheme = u.scheme ?? b.scheme;
	if (scheme !== b.scheme || (scheme && !USES_RELATIVE.has(scheme))) return url;
	let netloc = u.netloc;
	if (!scheme || USES_NETLOC.has(scheme)) {
		if (netloc) return unsplit(scheme, netloc, u.path, u.query, u.fragment);
		netloc = b.netloc;
	}
	if (!u.path) {
		let query = u.query;
		let fragment = u.fragment;
		if (query === null) {
			query = b.query;
			if (fragment === null) fragment = b.fragment;
		}
		return unsplit(scheme, netloc, b.path, query, fragment);
	}
	const baseParts = b.path.split("/");
	// The last item is not a directory, so it does not count in resolving the relative path.
	if (baseParts[baseParts.length - 1] !== "") baseParts.pop();
	let segments: string[];
	if (u.path.startsWith("/")) {
		segments = u.path.split("/");
	} else {
		const all = [...baseParts, ...u.path.split("/")];
		// Empty elements in the middle would make redundant slashes.
		segments = all.length > 1 ? [all[0] as string, ...all.slice(1, -1).filter(Boolean), all[all.length - 1] as string] : all;
	}
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment === "..") resolved.pop();
		else if (segment !== ".") resolved.push(segment);
	}
	const last = segments[segments.length - 1];
	// A path ending in a relative directory keeps its trailing "/".
	if (last === "." || last === "..") resolved.push("");
	return unsplit(scheme, netloc, resolved.join("/") || "/", u.query, u.fragment);
}

const ALWAYS_SAFE = /[A-Za-z0-9_.~-]/;

/** `urllib.parse.quote(text, safe)`: UTF-8, every byte not always safe and not in `safe` as %XX. */
export function quote(text: string, safe = "/"): string {
	const kept = new Set([...safe].filter((char) => char.charCodeAt(0) < 128));
	let out = "";
	for (const byte of new TextEncoder().encode(text)) {
		const char = String.fromCharCode(byte);
		out += byte < 128 && (ALWAYS_SAFE.test(char) || kept.has(char)) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/**
 * `urllib.parse.quote(value, safe="")`, the way connectors write a path segment: everything but ASCII letters,
 * digits and `_.-~` percent-encoded as UTF-8. A lone surrogate throws (URIError), as Python's UTF-8 encoding
 * raises UnicodeEncodeError; `quote` above replaces it instead.
 */
export function quoteSegment(value: string): string {
	// encodeURIComponent also leaves !'()* alone.
	return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
