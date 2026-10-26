// Opening pages in Minerva's browser: Browser Run's Quick Actions on its Kitesurf engine, sent through the call's
// io, so none starts once the run is revoked (ARCHITECTURE.md: Strict revocation) and a run sends at most
// BROWSER_CALLS (gateway/http.ts `RunBrowser`).
//
// - The page's scripts run: Kitesurf cannot turn them off. A visit can act on the site as any visit would.
// - Only https, and nothing cached (`cacheTTL: 0`): every customer renders through one account, so a cached answer
//   could hand one customer's signed-in page to another's request for the same address.
// - What the page loads must come from its own host (`allowRequestPattern`). That blocks a stylesheet, a script, a
//   frame, XHR, `fetch`, an EventSource or a WebSocket aimed at another host, but not a move: a redirect, a script
//   or a form takes the browser to any host. A page that `finalUrl` or a redirect hop places on another host or on
//   http is withheld as `Moved`, for the model to open with that site's own permission. A move made by the page's
//   own script or form is not in `finalUrl`, so that page comes back as the host's (ARCHITECTURE.md: Connectors).
// - The engine waits 15 s per call, its answer read. `quickAction` takes no signal, so a cancel or the wait only
//   stops the engine waiting: the render goes on at Cloudflare until it ends, and its result is dropped.
// - A screenshot comes back without `meta`, so a page that moved is pictured under the address asked for
//   (ARCHITECTURE.md: Connectors).
// - Every failure after a call was sent says that the page's scripts may have run, since nothing tells how far the
//   browser got.
// - Each call logs one line: the operation, an outcome from a fixed set, the page's status, Browser Run's error code,
//   its browser time and the duration. Never the address or Browser Run's message, which can quote it and any token
//   in it.

import type { ImageContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { type ErrorCode, OperationError, type ProviderClient } from "../../gateway/connector.ts";
import { type BrowserIo, NotSent, ProgrammingError, type ProviderIo } from "../../gateway/http.ts";
import { readBytes } from "../../http/body.ts";
import { base64, utf8 } from "../../lib/bytes.ts";
import { type Json, parseJsonBytes } from "../../lib/json.ts";
import { type WebURL, parseUrl } from "../../lib/sites.ts";
import { IMAGE_MAX_BYTES } from "../../model/provider.ts";

const USER_AGENT = "Minerva/0.1 (governed AI agent; reads a page when a user's agent asks)";
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_SCREENSHOT = (IMAGE_MAX_BYTES / 4) * 3;
export const VIEWPORT = { width: 1280, height: 800 };
export const LIMITS = { waitMs: 15_000 };

const RAN = "Its scripts may have run.";
const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json", "application/xml", "text/xml"]);
const NOT_CONVERTED = 2012;
const JPEG = [0xff, 0xd8, 0xff];
/** The YAML front matter Browser Run's Markdown starts with when the page has a title. */
const FRONT_MATTER = /^---\n(?:[^\n]*\n)*?---(?:\n+|$)/;

export interface Visit {
	url: WebURL;
	withFragment: string;
}

class Page {
	readonly url: WebURL;
	readonly title: string | null;
	readonly contentType: string | null;
	readonly text: string;

	constructor(url: WebURL, title: string | null, contentType: string | null, text: string) {
		this.url = url;
		this.title = title;
		this.contentType = contentType;
		this.text = text;
	}
}

export class Moved {
	readonly target: WebURL;

	constructor(target: WebURL) {
		this.target = target;
	}
}

type Outcome = "ok" | "moved" | "site_status" | "busy" | "timeout" | "too_large" | "unsupported" | "failed" | "capped";

class Ended extends OperationError {
	readonly outcome: Outcome;

	constructor(outcome: Outcome, code: ErrorCode, message: string) {
		super(code, `${message} ${RAN}`);
		this.outcome = outcome;
	}
}

function failed(): Ended {
	return new Ended("failed", "PAGE_ERROR", "Minerva's browser could not open this page.");
}

function tooLarge(): Ended {
	return new Ended("too_large", "PAGE_TOO_LARGE", "This page is larger than Minerva reads.");
}

function sameHost(url: WebURL): string[] {
	const escaped = url.host.replaceAll(".", "\\.");
	return [`^https://${escaped}/`, `^blob:https://${escaped}/`, "^data:"];
}

function browserOptions(url: WebURL): BrowserRunBaseOptions & BrowserRunAlternateBackendOptions {
	return {
		browser: "kitesurf",
		allowRequestPattern: sameHost(url),
		cacheTTL: 0,
		userAgent: USER_AGENT,
		gotoOptions: { waitUntil: "networkidle2", timeout: 8_000 },
		actionTimeout: 3_000,
		bestAttempt: true,
	};
}

function markdownOptions(visit: Visit): BrowserRunMarkdownOptions {
	return { url: visit.withFragment, ...browserOptions(visit.url), rejectResourceTypes: ["image", "media", "font"] };
}

function screenshotOptions(visit: Visit): BrowserRunScreenshotOptions {
	return { url: visit.withFragment, ...browserOptions(visit.url), viewport: VIEWPORT, screenshotOptions: { type: "jpeg", quality: 80 } };
}

const Meta = z.object({
	status: z.int(),
	title: z.string().optional(),
	headers: z.object({ "content-type": z.string().optional() }).optional(),
	finalUrl: z.string().optional(),
	redirectChain: z.array(z.object({ url: z.string() })).optional(),
});

const Markdown = z.object({ success: z.literal(true), result: z.string(), meta: Meta });

const Failure = z.object({ errors: z.array(z.object({ code: z.number().optional() })) });

class CallLog {
	readonly #operation: string;
	readonly #started = Date.now();
	status: number | null = null;
	code: number | null = null;
	browserMs: number | null = null;

	constructor(operation: string) {
		this.#operation = operation;
	}

	write(outcome: Outcome): void {
		const line = { message: "web browser call", operation: this.#operation, outcome, status: this.status, code: this.code, browserMs: this.browserMs, ms: Date.now() - this.#started };
		console.log(JSON.stringify(line));
	}
}

function mediaType(value: string | undefined): string | null {
	const mime = value?.split(";")[0]?.trim().toLowerCase();
	return mime ? mime : null;
}

function isText(mime: string): boolean {
	return TEXT_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml");
}

/**
 * The payload Browser Run puts in a fence for a text file, exactly, after Chrome's JSON viewer for JSON: what lies
 * between the first line that opens the fence the text ends with and that last line. The text as it came without one.
 */
function fenced(text: string): string {
	const body = text.replace(/\n+$/, "");
	const last = body.lastIndexOf("\n");
	const fence = body.slice(last + 1);
	if (last < 0 || !/^`{3,}$/.test(fence)) return text;
	const opening = new RegExp(`(?:^|\\n)${fence}[^\`\\n]*\\n`).exec(body);
	if (opening === null || opening.index + opening[0].length > last + 1) return text;
	return body.slice(opening.index + opening[0].length, last);
}

async function waited<T>(work: Promise<T>, error: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(error()), LIMITS.waitMs);
	});
	try {
		return await Promise.race([work, limit]);
	} finally {
		clearTimeout(timer);
	}
}

function addressOf(raw: string | undefined): WebURL | null {
	if (raw === undefined) return null;
	try {
		return parseUrl(raw);
	} catch (error) {
		if (error instanceof OperationError) return null;
		throw error;
	}
}

function pageOf(visit: Visit, log: CallLog, answer: z.output<typeof Markdown>): Page | Moved {
	const { meta } = answer;
	log.status = meta.status;
	const mime = mediaType(meta.headers?.["content-type"]);
	// A PDF, and a page with no content, come back with neither a type nor text, nor where they ended.
	const empty = mime === null && answer.result === "";
	const final = addressOf(meta.finalUrl);
	if (final === null && !empty) throw failed();
	const away = (url: WebURL) => url.host !== visit.url.host || url.scheme !== "https";
	if (final !== null && away(final)) return new Moved(final);
	for (const hop of meta.redirectChain ?? []) {
		const url = addressOf(hop.url);
		if (url === null) throw failed();
		if (away(url)) return new Moved(url);
	}
	if (meta.status === 526) throw new Ended("site_status", "PAGE_ERROR", "This site's certificate is not valid.");
	if (meta.status >= 400) throw new Ended("site_status", "PAGE_ERROR", `The site answered with HTTP ${meta.status}.`);
	if (meta.status !== 200) throw new Ended("site_status", "PAGE_ERROR", `The site answered with HTTP ${meta.status}, which has no page.`);
	if (final === null || empty) throw new Ended("unsupported", "UNSUPPORTED_CONTENT", "Minerva cannot read this kind of file yet.");
	if (mime !== null && !HTML_TYPES.has(mime) && !isText(mime)) throw new Ended("unsupported", "UNSUPPORTED_CONTENT", `Minerva cannot read ${mime} pages yet.`);
	if (utf8(answer.result).length > MAX_TEXT_BYTES) throw tooLarge();
	const markdown = answer.result.replace(FRONT_MATTER, "");
	return new Page(final, meta.title || null, mime, mime !== null && isText(mime) ? fenced(markdown) : markdown);
}

export class Browser implements ProviderClient {
	readonly #io: ProviderIo;

	constructor(io: ProviderIo) {
		this.#io = io;
	}

	async close(): Promise<void> {}

	async read(visit: Visit): Promise<Page | Moved> {
		const log = new CallLog("read_page");
		const page = await this.#send(log, (browser) => browser.quickAction("markdown", markdownOptions(visit)), MAX_RESPONSE, (body) => {
			const parsed = Markdown.safeParse(parseJsonBytes(body));
			if (!parsed.success) throw failed();
			return pageOf(visit, log, parsed.data);
		});
		log.write(page instanceof Moved ? "moved" : "ok");
		return page;
	}

	async screenshot(visit: Visit): Promise<ImageContent> {
		const log = new CallLog("screenshot_page");
		const image = await this.#send(log, (browser) => browser.quickAction("screenshot", screenshotOptions(visit)), MAX_SCREENSHOT, (body): ImageContent => {
			if (!JPEG.every((byte, at) => body[at] === byte)) throw failed();
			return { type: "image", mimeType: "image/jpeg", data: base64(body) };
		});
		log.write("ok");
		return image;
	}

	async #send<T>(log: CallLog, send: (browser: BrowserIo) => Promise<Response>, limit: number, take: (body: Uint8Array) => T): Promise<T> {
		const browser = this.#io.browser;
		if (browser === null) throw new OperationError("BROWSER_UNAVAILABLE", "Minerva's browser is not available in this build.");
		const answered = (async () => {
			const response = await send(browser);
			const used = Number(response.headers.get("x-browser-ms-used") ?? Number.NaN);
			log.browserMs = Number.isFinite(used) ? used : null;
			const body = await readBytes(response, limit);
			if (body === null) throw tooLarge();
			if (response.status !== 200) throw refusal(log, response.status, body);
			return take(body);
		})();
		try {
			return await waited(answered, () => new Ended("timeout", "SITE_TIMEOUT", "This site took too long to open."));
		} catch (error) {
			if (error instanceof NotSent || error instanceof ProgrammingError) throw error;
			if (error instanceof Ended) {
				log.write(error.outcome);
				throw error;
			}
			if (error instanceof OperationError && error.code === "LIMIT_REACHED") {
				log.write("capped");
				throw error;
			}
			log.write("failed");
			throw failed();
		}
	}
}

function errorCode(body: Uint8Array): number | null {
	try {
		const parsed = Failure.safeParse(parseJsonBytes(body));
		return parsed.success ? (parsed.data.errors[0]?.code ?? null) : null;
	} catch {
		return null;
	}
}

function refusal(log: CallLog, status: number, body: Uint8Array): Ended {
	log.code = errorCode(body);
	if (status === 429 || status === 503) return new Ended("busy", "BROWSER_BUSY", "Minerva's browser is busy. Try again in a minute.");
	if (status === 422 && log.code === NOT_CONVERTED) return new Ended("failed", "PAGE_ERROR", "Minerva's browser could not turn this page into text.");
	return failed();
}

const MARKER = "minerva-probe-ran";
const PROBE_SCRIPT = `document.body.append("${MARKER}");
fetch("https://example.com/")
	.then((response) => response.text())
	.then((text) => (text.includes("Example Domain") ? "read" : "empty"), () => "failed")
	.then((outcome) => document.body.append(" example.com:" + outcome));`;

async function probed(send: () => Promise<Response>): Promise<{ answered: number | null; meta: z.output<typeof Meta> | null; markdown: string; browserMs: boolean; ms: number }> {
	const started = Date.now();
	try {
		const read = (async () => {
			const response = await send();
			return { response, body: await readBytes(response, MAX_RESPONSE) };
		})();
		const { response, body } = await waited(read, () => new Error("Browser Run did not answer in time."));
		const parsed = Markdown.safeParse(body === null ? null : parseJsonBytes(body));
		const answer = parsed.success ? parsed.data : null;
		return { answered: response.status, meta: answer?.meta ?? null, markdown: answer?.result ?? "", browserMs: response.headers.has("x-browser-ms-used"), ms: Date.now() - started };
	} catch {
		return { answered: null, meta: null, markdown: "", browserMs: false, ms: Date.now() - started };
	}
}

/**
 * The boundary checks only the page's own host. The block of other hosts cannot be seen from the page: a no-cors
 * fetch of another host settled under the pattern (measured), and only a host that records what reaches it tells
 * (ARCHITECTURE.md: Spike results).
 */
export async function probeBrowser(binding: BrowserIo | undefined): Promise<Json> {
	if (binding === undefined) return null;
	const options = markdownOptions({ url: parseUrl("https://example.com/"), withFragment: "https://example.com/" });
	const page = await probed(() => binding.quickAction("markdown", options));
	// The script is added once the page has loaded: a fixed wait lets its fetch end.
	const boundary = await probed(() => binding.quickAction("markdown", { ...options, addScriptTag: [{ content: PROBE_SCRIPT }], waitForTimeout: 3_000 }));
	return {
		page: { answered: page.answered, status: page.meta?.status ?? null, chars: page.markdown.length, finalUrl: page.meta?.finalUrl !== undefined, browserMs: page.browserMs, ms: page.ms },
		boundary: {
			answered: boundary.answered,
			ran: boundary.markdown.includes(MARKER),
			sameHost: /example\.com:(read|empty|failed)/.exec(boundary.markdown)?.[1] ?? null,
			ms: boundary.ms,
		},
	};
}
