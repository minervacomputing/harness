// Fetching web pages, ported from backend/connectors/web/fetch.py: Minerva's fetcher must never become a
// way into private networks.
//
// Today's backend resolves the host on every hop, refuses it unless every address is public, and connects to
// the checked address itself. A Worker's fetch cannot pin a DNS answer, so that guard is now the platform's:
// Cloudflare refuses a Worker's request to a private, loopback, link-local, CGNAT, ULA or metadata address,
// whichever name led there (also after a redirect), and to any IP literal that is not Cloudflare's, with a
// 403 from `server: cloudflare` whose body is "error code: 1003" (1002 for a name that resolves to such an
// address, 1102 for loopback names such as `localhost` and `localtest.me`). That is measured, not
// documented (plan: Spike results), so it is recognised here and reported with today's SITE_NOT_PUBLIC
// message. Everything else is still decided here, before anything is sent: the address is parsed and its
// host checked (lib/sites.ts: no IP literal in any spelling, no special-use name, only names under a known
// public suffix), redirects are followed only within the same host and never from https to http (anything
// else goes back to the caller, which authorizes the new host like any other address), no cookies,
// credentials or proxies are ever used, the body is capped at 3 MB before and after decompression
// (inflate.ts), and the whole fetch has 25 seconds.
//
// The request goes out through the call's io (the executor's fetch), so it is refused once the run ended.
// Differences from today: a name with both public and private addresses was refused, where the platform
// decides by the address it connects to (a private one is never reached); the Host header and TLS name are
// the URL's own (there is no checked address to connect to); the runtime adds `Cf-Worker` and may re-encode
// a few characters the WHATWG URL parser treats differently (`'` in a query, dot segments in a path), always
// on the same host; a header value that is not UTF-8 is read with replacement characters where httpx would
// read every header as Latin-1; an invalid certificate is not told apart from any other failure; and an
// origin that answers 403 from `server: cloudflare` with the platform's exact refusal text is reported as a
// private site rather than as HTTP 403.

import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { NotSent, PhaseTimeout, ProgrammingError, platformRefusal } from "../../gateway/http.ts";
import { decode as decodeBytes, lookup } from "../../lib/codecs.ts";
import { LookupError, PythonError } from "../../lib/pyerrors.ts";
import { type WebURL, parseUrl } from "../../lib/sites.ts";
import { PYTHON_SPACE_CLASS, pythonStrip } from "../../lib/text.ts";
import { Inflater, unsupportedEncoding } from "./inflate.ts";

export const USER_AGENT = "Minerva/0.1 (governed AI agent; reads a page when a user's agent asks)";
export const ACCEPT = "text/html, application/xhtml+xml, text/plain, text/markdown, application/json, application/xml;q=0.9";
export const MAX_BODY = 3 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
/** The whole fetch, and each wait for the response's headers or the next piece of its body (httpx's 10 s). Tests lower them. */
export const LIMITS = { totalMs: 25_000, phaseMs: 10_000 };
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** The platform's codes for a destination it does not open: 1003 an IP literal, 1002 a name for a private address, 1102 a loopback name. */
export const NOT_PUBLIC_CODES: ReadonlySet<number> = new Set([1002, 1003, 1102]);
/** The platform's code when it could not resolve the name (530, measured with a name public DNS lacks). */
export const NAME_NOT_FOUND_CODE = 1016;
/** What is read of an error response to recognise the platform's refusal ("error code: 1003"). */
const REFUSAL_BYTES = 1024;
/** How long that body may take (the platform's refusals came within a millisecond). */
const REFUSAL_MS = 1000;

const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json", "application/xml", "text/xml"]);

export class Page {
	readonly url: WebURL;
	readonly status: number;
	readonly contentType: string;
	readonly form: "html" | "text";
	readonly text: string;

	constructor(url: WebURL, status: number, contentType: string, form: "html" | "text", text: string) {
		this.url = url;
		this.status = status;
		this.contentType = contentType;
		this.form = form;
		this.text = text;
	}
}

/** A redirect to another host (or from https to http), which needs its own authorization. */
export class Moved {
	readonly url: WebURL;
	readonly target: WebURL;

	constructor(url: WebURL, target: WebURL) {
		this.url = url;
		this.target = target;
	}
}

function unreachable(): OperationError {
	return new OperationError("SITE_UNREACHABLE", "This site could not be reached.");
}

function tooLarge(): OperationError {
	return new OperationError("PAGE_TOO_LARGE", `This page is larger than Minerva reads (${MAX_BODY} bytes).`);
}

export function notPublic(): OperationError {
	return new OperationError("SITE_NOT_PUBLIC", "This site's name points to a private network, which Minerva does not open.");
}

/** The whole fetch ran out of time (Python's `asyncio.timeout(TOTAL_SECONDS)`). */
class TotalTimeout extends Error {}

// What a response says about its body.

const CHARSET_PARAM = new RegExp(`charset[${PYTHON_SPACE_CLASS}]*=[${PYTHON_SPACE_CLASS}]*"?([A-Za-z0-9._:-]+)`, "iu");
/** `rb"<meta[^>]+charset\s*=\s*[\"']?([A-Za-z0-9._:-]+)"` with IGNORECASE, over bytes read as Latin-1. */
const META_CHARSET = /<meta[^>]+charset[ \t\n\r\f\v]*=[ \t\n\r\f\v]*["']?([A-Za-z0-9._:-]+)/i;

function latin1(bytes: Uint8Array): string {
	let text = "";
	for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192));
	return text;
}

/** `_media_type`: the media type, lowercased, and the charset it declares. */
function mediaType(value: string): [mime: string, charset: string | null] {
	const semicolon = value.indexOf(";");
	const mime = semicolon < 0 ? value : value.slice(0, semicolon);
	const params = semicolon < 0 ? "" : value.slice(semicolon + 1);
	const match = CHARSET_PARAM.exec(params);
	return [pythonStrip(mime).toLowerCase(), match ? (match[1] as string) : null];
}

/** `bytes.lstrip()`: ASCII whitespace. */
function lstripBytes(bytes: Uint8Array): Uint8Array {
	let at = 0;
	while (at < bytes.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(bytes[at] as number)) at++;
	return bytes.subarray(at);
}

/** `_form`: "html" or "text", or UNSUPPORTED_CONTENT. */
function formOf(mime: string, body: Uint8Array): "html" | "text" {
	if (HTML_TYPES.has(mime)) return "html";
	if (TEXT_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
	if (!mime) {
		const start = latin1(lstripBytes(body.subarray(0, 1024))).replace(/[A-Z]/g, (char) => char.toLowerCase());
		if (start.startsWith("<!doctype html") || start.startsWith("<html")) return "html";
		if (!start.includes("\u0000")) return "text";
	}
	throw new OperationError("UNSUPPORTED_CONTENT", `Minerva cannot read ${mime || "this kind of"} pages yet.`);
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((byte, i) => bytes[i] === byte);
}

/**
 * `_charset`: a byte order mark, else the first known charset the header or an HTML page's `<meta>` names,
 * else UTF-8. `codecs.lookup` finds a binary codec (base64, zlib) too, whose name is then returned and whose
 * decoding raises LookupError, as Python's `bytes.decode` does.
 */
function charset(body: Uint8Array, declared: string | null, form: "html" | "text"): string {
	if (startsWith(body, [0xef, 0xbb, 0xbf])) return "utf-8-sig";
	if (startsWith(body, [0xff, 0xfe]) || startsWith(body, [0xfe, 0xff])) return "utf-16";
	const candidates = [declared];
	if (form === "html") {
		const match = META_CHARSET.exec(latin1(body.subarray(0, 4096)));
		candidates.push(match ? (match[1] as string) : null);
	}
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			lookup(candidate);
			return candidate;
		} catch (error) {
			if (error instanceof LookupError && error.message.includes("is not a text encoding")) return candidate;
			if (error instanceof LookupError) continue;
			throw error;
		}
	}
	return "utf-8";
}

/** fetch.py `decode`: (media type, form, text) of a response body. */
export function decode(body: Uint8Array, contentType: string): [mime: string, form: "html" | "text", text: string] {
	const [mime, declared] = mediaType(contentType);
	const form = formOf(mime, body);
	return [mime, form, decodeBytes(body, charset(body, declared, form), "replace")];
}

// The fetcher.

/** `promise`, or the abort's reason if that comes first; a later rejection of `promise` is not left unhandled. */
function race<T>(promise: Promise<T>, aborted: Promise<never>): Promise<T> {
	promise.catch(() => {});
	return Promise.race([promise, aborted]);
}

/** `_body` over the pieces of a body as they arrive: decompressed, capped before and after (MAX_BODY). */
export class Body {
	readonly #inflater: Inflater;
	/** The page so far, in one buffer that grows as Python's bytearray does: a page in many small pieces costs no more than one. */
	#buffer = new Uint8Array(0);
	#received = 0;
	#size = 0;

	/** `contentEncoding`: the response's Content-Encoding, every value joined (null without one). */
	constructor(contentEncoding: string | null) {
		const encodings = (contentEncoding ?? "")
			.split(",")
			.map((encoding) => pythonStrip(encoding).toLowerCase())
			.filter((encoding) => encoding && encoding !== "identity");
		if (encodings.length > 1) throw unsupportedEncoding();
		this.#inflater = new Inflater(encodings[0] ?? null, tooLarge);
	}

	feed(chunk: Uint8Array): void {
		// httpx yields no empty chunks.
		if (!chunk.length) return;
		this.#received += chunk.length;
		if (this.#received > MAX_BODY) throw tooLarge();
		for (const part of this.#inflater.feed(chunk, MAX_BODY - this.#size + 1)) this.#append(part);
		if (this.#size > MAX_BODY) throw tooLarge();
	}

	/** Never past MAX_BODY + 1: the room each feed is given. */
	#append(part: Uint8Array): void {
		const needed = this.#size + part.length;
		if (needed > this.#buffer.length) {
			const grown = new Uint8Array(Math.max(needed, Math.min(Math.max(this.#buffer.length * 2, 65536), MAX_BODY + 1)));
			grown.set(this.#buffer.subarray(0, this.#size));
			this.#buffer = grown;
		}
		this.#buffer.set(part, this.#size);
		this.#size = needed;
	}

	bytes(): Uint8Array {
		return this.#buffer.slice(0, this.#size);
	}
}

/** One fetch's clock: the total deadline, and the current phase's. */
class Deadline {
	readonly controller = new AbortController();
	readonly aborted: Promise<never>;
	#total: ReturnType<typeof setTimeout>;
	#phase: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		this.aborted = new Promise<never>((_, reject) => {
			this.controller.signal.addEventListener("abort", () => reject(this.controller.signal.reason), { once: true });
		});
		this.aborted.catch(() => {});
		this.#total = setTimeout(() => this.controller.abort(new TotalTimeout()), LIMITS.totalMs);
	}

	/** Starts a wait that must end within the phase limit. */
	arm(): void {
		this.disarm();
		this.#phase = setTimeout(() => this.controller.abort(new PhaseTimeout()), LIMITS.phaseMs);
	}

	disarm(): void {
		if (this.#phase !== null) clearTimeout(this.#phase);
		this.#phase = null;
	}

	end(): void {
		this.disarm();
		clearTimeout(this.#total);
	}
}

export class Fetcher {
	readonly #io: ProviderIo;

	constructor(io: ProviderIo) {
		this.#io = io;
	}

	/** Reads the body in pieces as they arrive, each within the phase limit, until `each` returns false. */
	async #chunks(response: Response, deadline: Deadline, each: (chunk: Uint8Array) => boolean): Promise<void> {
		const reader = response.body?.getReader();
		if (reader === undefined) return;
		try {
			for (;;) {
				deadline.arm();
				const { done, value } = await race(reader.read(), deadline.aborted);
				deadline.disarm();
				if (done || !each(value)) return;
			}
		} finally {
			// Release the rest of a body that was not read to its end.
			reader.cancel().catch(() => {});
		}
	}

	/**
	 * The platform's refusal code of an error response, read from at most a kilobyte of its body. The
	 * platform sends its refusal at once; a body that does not come within REFUSAL_MS, or fails, is an
	 * ordinary error response, as Python reports one without reading it. The wait also ends with the fetch's
	 * total time: Python, which reads no error body, answers within it with the error response.
	 */
	async #refusal(response: Response, deadline: Deadline): Promise<number | null> {
		if (response.headers.get("server")?.toLowerCase() !== "cloudflare") return null;
		const reader = response.body?.getReader();
		if (reader === undefined) return platformRefusal(response, "");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), REFUSAL_MS);
		});
		const read = (async (): Promise<string | null> => {
			const body = new Uint8Array(REFUSAL_BYTES + 1);
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return new TextDecoder().decode(body.subarray(0, size));
				if (size + value.length > REFUSAL_BYTES) return null;
				body.set(value, size);
				size += value.length;
			}
		})();
		try {
			const body = await Promise.race([read, late, deadline.aborted.catch(() => null)]);
			return body === null ? null : platformRefusal(response, body);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			read.catch(() => {});
			reader.cancel().catch(() => {});
		}
	}

	/** `_body`: the body, decompressed, capped before and after. */
	async #body(response: Response, deadline: Deadline): Promise<Uint8Array> {
		const body = new Body(response.headers.get("content-encoding"));
		await this.#chunks(response, deadline, (chunk) => {
			body.feed(chunk);
			return true;
		});
		return body.bytes();
	}

	/** `_hop`: the page at this address, or the Location it redirects to. */
	async #hop(url: WebURL, deadline: Deadline): Promise<Page | string> {
		const headers = {
			"User-Agent": USER_AGENT,
			Accept: ACCEPT,
			"Accept-Encoding": "gzip, deflate",
			"Accept-Language": "en;q=0.9, *;q=0.5",
		};
		let response: Response | null = null;
		try {
			deadline.arm();
			response = await race(
				this.#io.fetch(url.text, {
					method: "GET",
					headers,
					// Never followed by the runtime: each hop is checked here first.
					redirect: "manual",
					// The body as sent: decompressed here, within the cap (inflate.ts).
					encodeResponseBody: "manual",
					signal: deadline.controller.signal,
				} as RequestInit),
				deadline.aborted,
			);
			deadline.disarm();
			const status = response.status;
			const location = response.headers.get("location");
			if (REDIRECT_STATUSES.has(status) && location) {
				response.body?.cancel().catch(() => {});
				return location;
			}
			if (status >= 400) {
				const refusal = status === 403 || status === 530 ? await this.#refusal(response, deadline) : null;
				if (status === 403 && refusal !== null && NOT_PUBLIC_CODES.has(refusal)) throw notPublic();
				if (status === 530 && refusal === NAME_NOT_FOUND_CODE) throw new OperationError("SITE_UNREACHABLE", "This site's name could not be found.");
				response.body?.cancel().catch(() => {});
				throw new OperationError("PAGE_ERROR", `The site answered with HTTP ${status}.`);
			}
			if (status !== 200) {
				response.body?.cancel().catch(() => {});
				throw new OperationError("PAGE_ERROR", `The site answered with HTTP ${status}, which has no page.`);
			}
			const body = await this.#body(response, deadline);
			const [mime, form, text] = decode(body, response.headers.get("content-type") ?? "");
			return new Page(url, status, mime, form, text);
		} catch (error) {
			deadline.disarm();
			// A body left unread holds a connection until it is released (a reader's lock makes this a no-op).
			response?.body?.cancel().catch(() => {});
			if (error instanceof TotalTimeout) throw error;
			// The run no longer admits requests, or a programming error: as they are.
			if (error instanceof NotSent || error instanceof ProgrammingError) throw error;
			// Owned errors, and what Python lets escape `_hop` (a binary codec's LookupError): as they are.
			if (error instanceof OperationError || error instanceof PythonError) throw error;
			// The network failed, or a wait outlasted its phase (httpx's HTTPError).
			throw unreachable();
		}
	}

	/** `get`: the page, or where it moved to another host; redirects on the same host are followed. */
	async get(url: WebURL): Promise<Page | Moved> {
		const deadline = new Deadline();
		try {
			let current = url;
			for (let hop = 0; hop < MAX_REDIRECTS + 1; hop++) {
				const outcome = await this.#hop(current, deadline);
				if (outcome instanceof Page) return outcome;
				let target: WebURL;
				try {
					target = parseUrl(outcome, current);
				} catch (error) {
					if (error instanceof OperationError) throw new OperationError("PAGE_ERROR", "The site redirected to an address Minerva does not open.");
					throw error;
				}
				if (target.host !== current.host || (current.scheme === "https" && target.scheme === "http")) return new Moved(url, target);
				current = target;
			}
		} catch (error) {
			if (error instanceof TotalTimeout) throw new OperationError("SITE_TIMEOUT", "This site took too long to answer.");
			throw error;
		} finally {
			deadline.end();
		}
		throw new OperationError("PAGE_ERROR", "The site redirected too many times.");
	}
}
