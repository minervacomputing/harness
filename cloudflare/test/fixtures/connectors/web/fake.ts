// What a Worker's fetch reaches, for the Web connector's tests (the network and Brave Search): public DNS and web servers behind Cloudflare's own checks, as the storage spike measured them
// (plan: Spike results). The platform parses the address as WHATWG URL does (2130706433, 0x7f.1 and
// [::ffff:127.0.0.1] are IP literals to it), refuses every IP literal that is not Cloudflare's with "error
// code: 1003", localtest.me and *.localhost with 1102, a name whose address is private with 1002 (looked up
// on every request, so a name that changes its answer is refused once it does), and a name public DNS lacks
// with 530 and 1016; each refusal is a 403 (530) from `server: cloudflare` with a plain-text body, or, to a
// request with an Accept header (the Web connector's has one), Cloudflare's HTML error page headed `Error NNNN`
// (measured on the account 2026-10-12; the page here keeps only its shape). Redirects
// are followed with the same checks unless the request says `redirect: "manual"`, and gzip and br bodies are
// decoded (Content-Encoding kept) unless it says `encodeResponseBody: "manual"`. Names under nip.io and
// sslip.io resolve to the address they spell, as those services do. Addresses are made up.

import { brotliDecompressSync, gunzipSync } from "node:zlib";

export const PUBLIC = "93.184.215.14";
export const BRAVE_HOST = "api.search.brave.com";

export interface Served {
	status?: number;
	headers?: { [name: string]: string };
	/** As sent; a stream for bodies that arrive slowly or never end. */
	body?: Uint8Array | string | ReadableStream<Uint8Array>;
}

export interface SentRequest {
	url: string;
	host: string;
	target: string;
	method: string;
	headers: Headers;
	redirect: string | undefined;
	encodeResponseBody: string | undefined;
}

type Answer = string[] | (() => string[]);

/** The four bytes of a dotted IPv4 address, or null. */
function ipv4(text: string): number[] | null {
	const parts = text.split(".");
	if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
	return parts.map(Number);
}

/** The eight groups of an IPv6 address (a dotted IPv4 tail allowed, a zone dropped), or null. */
function ipv6(text: string): number[] | null {
	let rest = text.split("%")[0] as string;
	const tail: number[] = [];
	const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(rest);
	if (dotted) {
		const bytes = ipv4(dotted[1] as string);
		if (bytes === null) return null;
		tail.push(((bytes[0] as number) << 8) | (bytes[1] as number), ((bytes[2] as number) << 8) | (bytes[3] as number));
		rest = rest.slice(0, dotted.index);
		// "::1.2.3.4" leaves ":", which was "::".
		if (rest.endsWith(":")) rest = `${rest}:`;
	}
	const halves = rest.split("::");
	if (halves.length > 2) return null;
	const groups = (half: string) => (half ? half.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN)) : []);
	const head = groups(halves[0] as string);
	const back = halves.length === 2 ? groups(halves[1] as string) : [];
	const fill = 8 - tail.length - head.length - back.length;
	if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
	const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...back, ...tail];
	return all.length === 8 && all.every((group) => Number.isInteger(group)) ? all : null;
}

function privateV4([a, b]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && (b as number) >= 64 && (b as number) < 128) ||
		(a === 169 && b === 254) ||
		(a === 172 && (b as number) >= 16 && (b as number) < 32) ||
		(a === 192 && b === 168) ||
		(a as number) >= 224
	);
}

/** Whether the platform would refuse to connect to this address (private, loopback, link-local, CGNAT, ULA, multicast, or one embedding such an IPv4 address). */
export function privateAddress(text: string): boolean {
	const v4 = ipv4(text);
	if (v4 !== null) return privateV4(v4);
	const v6 = ipv6(text);
	if (v6 === null) return true;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = v6 as [number, number, number, number, number, number, number, number];
	const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
	if (v6.every((group) => group === 0) || (v6.slice(0, 7).every((group) => group === 0) && g7 === 1)) return true;
	if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00 || (g0 & 0xff00) === 0xff00) return true;
	// IPv4-mapped, IPv4-compatible and NAT64 addresses reach the IPv4 address they hold.
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return privateV4(embedded);
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return privateV4(embedded);
	if (g0 === 0x2002) return privateV4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
	return false;
}

/** Cloudflare's own addresses, which fetch may reach by IP literal (measured with 1.1.1.1 and 2606:4700:4700::1111). */
function cloudflareAddress(host: string): boolean {
	return host === "1.1.1.1" || host === "1.0.0.1" || host.startsWith("[2606:4700:");
}

/** The address a nip.io or sslip.io name spells: 127.0.0.1.nip.io, 127-0-0-1.nip.io, 7f000001.nip.io. */
function spelled(host: string): string | null {
	const match = /^(?:.*?[.-])?(\d+[.-]\d+[.-]\d+[.-]\d+|[0-9a-f]{8})\.(?:nip\.io|sslip\.io)$/.exec(host);
	if (match === null) return null;
	const spelling = match[1] as string;
	if (/^[0-9a-f]{8}$/.test(spelling)) return [0, 2, 4, 6].map((at) => Number.parseInt(spelling.slice(at, at + 2), 16)).join(".");
	return spelling.replaceAll("-", ".");
}

/** The platform's error page for a refusal, in the shape the account served (about 6.5 KB, the code in its heading). */
export function refusalPage(code: number, host: string): string {
	const filler = `<p class="cf-text">${"Cloudflare's explanation of the error, and what a visitor and the site's owner can do. ".repeat(60)}</p>`;
	return `<!DOCTYPE html>
<html class="no-js" lang="en-US"><head><title>DNS points to local or disallowed IP | ${host} | Cloudflare</title></head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="p-0">
<header class="mx-auto pt-10 lg:pt-6 lg:px-8 w-240 lg:w-full mb-15 antialiased">
  <h1 class="inline-block md:block mr-2 md:mb-2 font-light text-60 md:text-3xl text-black-dark leading-tight">
    <span data-translate="error">Error</span>
    <span>${code}</span>
  </h1>
</header>${filler}</div></div></body></html>`;
}

function refusal(code: number, sent: SentRequest, status = 403): Response {
	if (sent.headers.get("accept")) {
		return new Response(refusalPage(code, sent.host), { status, headers: { server: "cloudflare", "content-type": "text/html; charset=UTF-8" } });
	}
	return new Response(`error code: ${code}`, { status, headers: { server: "cloudflare", "content-type": "text/plain; charset=UTF-8" } });
}

function bytesOf(body: Uint8Array | string): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** A body in pieces of 64 KiB, as a network delivers it. */
function streamed(body: Uint8Array): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= body.length) {
				controller.close();
				return;
			}
			controller.enqueue(body.slice(at, at + 65536));
			at += 65536;
		},
	});
}

const BRAVE_ANSWER = {
	query: { more_results_available: true },
	web: {
		results: [
			{ title: "<strong>Python</strong> docs", url: "https://docs.python.org/3/", description: "The &amp; official <strong>docs</strong>", age: "2 days ago" },
			{ title: "Local", url: "http://localhost/admin", description: "skipped" },
		],
	},
};

export class FakeWeb {
	/** Public DNS: a host's addresses, or a function answering each lookup. */
	readonly dns = new Map<string, Answer>();
	readonly pages = new Map<string, Served | (() => Served | Promise<Served>)>();
	/** Names looked up, in order. */
	readonly resolved: string[] = [];
	/** Every request handed to fetch, before the platform's checks. */
	readonly sent: SentRequest[] = [];
	/** Requests that reached a web server. */
	readonly requests: SentRequest[] = [];
	/** Brave Search: the requests it got, and the status it answers with. */
	readonly brave = { requests: [] as SentRequest[], status: 200 };

	site(host: string, ...addresses: string[]): void {
		this.dns.set(host, addresses.length ? addresses : [PUBLIC]);
	}

	page(host: string, target: string, served: Served | (() => Served | Promise<Served>)): void {
		this.pages.set(`${host} ${target}`, served);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const options = (init ?? {}) as RequestInit & { encodeResponseBody?: string };
		const signal = options.signal ?? null;
		const request = (url: URL): SentRequest => ({
			url: url.href,
			host: url.hostname,
			target: url.pathname + url.search,
			method: options.method ?? "GET",
			headers: new Headers(options.headers),
			redirect: options.redirect,
			encodeResponseBody: options.encodeResponseBody,
		});
		let url = new URL(String(input));
		this.sent.push(request(url));
		for (let hop = 0; ; hop++) {
			if (signal?.aborted) throw signal.reason;
			const response = await this.#exchange(url, request(url), signal);
			const location = response.headers.get("location");
			if (options.redirect === "manual" || !location || ![301, 302, 303, 307, 308].includes(response.status) || hop >= 20) {
				return options.encodeResponseBody === "manual" ? response : this.#decoded(response);
			}
			url = new URL(location, url);
		}
	};

	/** One request through the platform's checks to a server. */
	async #exchange(url: URL, sent: SentRequest, signal: AbortSignal | null): Promise<Response> {
		const host = url.hostname;
		if (host === BRAVE_HOST) return this.#brave(sent);
		const literal = ipv4(host) !== null || host.startsWith("[");
		if (literal) return cloudflareAddress(host) ? new Response(null, { status: 404 }) : refusal(1003, sent);
		if (host === "localhost") return refusal(1003, sent);
		if (host.endsWith(".localhost") || host === "localtest.me" || host.endsWith(".localtest.me")) return refusal(1102, sent);
		this.resolved.push(host);
		const answer = spelled(host) !== null ? [spelled(host) as string] : this.dns.get(host);
		const addresses = typeof answer === "function" ? answer() : answer;
		if (addresses === undefined || addresses.length === 0) return refusal(1016, sent, 530);
		// The platform connects to one address; refused when that one is private.
		if (privateAddress(addresses[0] as string)) return refusal(1002, sent);
		this.requests.push(sent);
		const page = this.pages.get(`${host} ${url.pathname + url.search}`);
		if (page === undefined) return new Response(null, { status: 404 });
		const served = typeof page === "function" ? await abortable(Promise.resolve(page()), signal) : page;
		const body = served.body === undefined ? null : served.body instanceof ReadableStream ? served.body : streamed(bytesOf(served.body));
		return new Response(body, { status: served.status ?? 200, headers: served.headers ?? {} });
	}

	#brave(sent: SentRequest): Response {
		this.brave.requests.push(sent);
		const json = this.brave.status === 200 ? BRAVE_ANSWER : { error: "no" };
		return new Response(JSON.stringify(json), { status: this.brave.status, headers: { "content-type": "application/json" } });
	}

	/** The runtime's default: gzip and br decoded before the Worker sees them. */
	async #decoded(response: Response): Promise<Response> {
		const encoding = response.headers.get("content-encoding");
		if (encoding !== "gzip" && encoding !== "br") return response;
		const raw = new Uint8Array(await response.arrayBuffer());
		const body = encoding === "gzip" ? gunzipSync(raw) : brotliDecompressSync(raw);
		return new Response(body, { status: response.status, headers: response.headers });
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
	if (signal === null) return promise;
	return new Promise((resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		promise.then(resolve, reject);
	});
}

/** A body that sends one piece and then nothing more, ever (a server that stalls). */
export function stalled(first: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(first));
		},
	});
}

/** A body that sends a byte every `everyMs`, forever (a server that trickles under any per-read limit). */
export function trickle(everyMs: number): ReadableStream<Uint8Array> {
	let timer: ReturnType<typeof setInterval> | undefined;
	return new ReadableStream({
		start(controller) {
			timer = setInterval(() => controller.enqueue(new Uint8Array([0x61])), everyMs);
		},
		cancel() {
			clearInterval(timer);
		},
	});
}
