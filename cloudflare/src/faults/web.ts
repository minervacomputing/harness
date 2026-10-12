// `web/get` for the account test of the Web connector's egress (test/account/web-egress.test.ts): an address
// parsed and fetched as `read_page` does (lib/sites.ts `parseUrl`, connectors/web/fetch.ts `Fetcher.get`),
// with the Worker's own fetch, so that what the platform refuses (private, loopback, link-local, CGNAT and
// metadata destinations, through any name and after any redirect) is measured on the account rather than
// assumed. Grants are not involved: a site another host redirects to comes back as `moved`, which the
// connector would authorize as a new address; the test asks for it again.

import { OperationError } from "../gateway/connector.ts";
import { Fetcher, Moved, REQUEST_HEADERS } from "../connectors/web/fetch.ts";
import { parseUrl } from "../lib/sites.ts";

/** What `Fetcher.get` made of `url`: the page (its first 500 characters), where it moved, or the owned error. */
export async function webGet(url: string): Promise<unknown> {
	const io = { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init), currentWrite: () => null, now: () => performance.now() };
	try {
		const parsed = parseUrl(url);
		const got = await new Fetcher(io).get(parsed);
		if (got instanceof Moved) return { moved: { text: got.target.text, href: got.target.href, host: got.target.host } };
		return { page: { text: got.url.text, href: got.url.href, status: got.status, form: got.form, start: got.text.slice(0, 500) } };
	} catch (error) {
		if (error instanceof OperationError) return { error: { code: error.code, message: error.message } };
		throw error;
	}
}

/**
 * `web/get-many`: `webGet` for each address in one invocation, concurrently (`together`) or one after another,
 * with how long each took and the whole. A Worker invocation has at most six connections open at once
 * (the platform queues the rest), and a body left unread holds its connection: so a run of more fetches
 * than that, among them redirects and error pages whose bodies the fetcher drops, finishes only if it
 * releases every one.
 */
export async function webGetMany(urls: string[], together: boolean): Promise<unknown> {
	const one = async (url: string) => {
		const started = Date.now();
		const got = await webGet(url);
		return { url, ms: Date.now() - started, got };
	};
	const started = Date.now();
	const results = [];
	if (together) results.push(...(await Promise.all(urls.map(one))));
	else for (const url of urls) results.push(await one(url));
	return { ms: Date.now() - started, results };
}

/**
 * `web/raw`: the request `read_page` sends (the same headers, redirects not followed, the body as sent), and
 * what came back before any decoding: the status, server, Content-Type and Content-Encoding, the body's
 * length and first bytes in hex, and an unencoded error page's text. It shows which encodings reach the
 * connector's own bounded decoder (connectors/web/inflate.ts) and what the platform's refusals look like.
 */
export async function webRaw(url: string, accept: string | null = null): Promise<unknown> {
	const response = await fetch(url, {
		method: "GET",
		// `accept` replaces the Accept header (empty: none), to see how the platform's refusal depends on it.
		headers: { ...REQUEST_HEADERS, ...(accept === null ? {} : { Accept: accept }) },
		redirect: "manual",
		encodeResponseBody: "manual",
	} as RequestInit);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const hex = [...bytes.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const encoding = response.headers.get("content-encoding");
	// An error page's text (the platform's refusals among them), when it is not encoded.
	const text = response.status >= 400 && encoding === null ? new TextDecoder().decode(bytes.subarray(0, 16_384)) : null;
	return { status: response.status, server: response.headers.get("server"), type: response.headers.get("content-type"), encoding, length: bytes.length, head: hex, text };
}
