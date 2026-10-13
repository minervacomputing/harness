// The Web connector's egress on the account (plan: Spike results; connectors/web/fetch.ts): the test Worker
// minerva-cf-test fetches addresses as `read_page` does (its driver's `web/get`, src/faults/web.ts), with
// the Worker's own fetch. What keeps a fetch out of private networks is the platform, which refuses a
// Worker's request to a private, loopback, link-local, CGNAT, ULA or metadata address whichever name led
// there; lib/sites.ts only refuses IP literals and special-use names before anything is sent. These are
// public names that resolve to such addresses, in IPv4, IPv6 and IPv4-mapped IPv6, directly and after a
// redirect from another host, so a change in the platform's behaviour shows here rather than in production.
//
// The names come from public wildcard DNS services, and the redirects from a public redirector: nip.io
// (`<IPv4>.nip.io`), sslip.io (`<IPv6 with - for :>.sslip.io`), localtest.me (127.0.0.1) and httpbin.org
// (`/redirect-to`). When one of them is down, its cases fail with SITE_UNREACHABLE rather than pass.
//
// Also what only the account can show of the connector's fetch (plan: Step 6; driver `web/raw`,
// `web/get-many`): the encodings that reach it (the platform asks the site for `gzip, br` in place of the
// connector's `gzip, deflate`, hands gzip on as sent for the connector's own bounded decoder, and decodes br
// and deflate itself), the platform's refusal (its HTML error page, since the connector's request has an
// Accept header), and more fetches than an invocation's six open connections finishing, queued, with the bodies of
// redirects and error pages released.
//
// httpbin.org echoes the request's headers, the Worker's host (Cf-Worker) among them, so those pages are never
// printed. Run with `pnpm test:faults` after `pnpm run deploy:test`.

import { describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);

interface Got {
	page?: { href: string; status: number; form: string; start: string };
	moved?: { href: string; host: string };
	error?: { code: string; message: string };
}

async function driver<T>(op: string, body: unknown): Promise<T> {
	const reply = await fetchDeployed(`${worker.origin}/api/faults/${op}`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 120_000,
	});
	if (reply.status !== 200) throw new Error(`${op} ${JSON.stringify(body).slice(0, 200)}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as T;
}

const get = (url: string) => driver<Got>("web/get", { url });

interface Raw {
	status: number;
	server: string | null;
	type: string | null;
	encoding: string | null;
	/** An unencoded error page's text. */
	text: string | null;
	length: number;
	/** The body's first eight bytes, in hex. */
	head: string;
}

interface Many {
	ms: number;
	results: { url: string; ms: number; got: Got }[];
}

const NOT_PUBLIC = { code: "SITE_NOT_PUBLIC", message: "This site's name points to a private network, which Minerva does not open." };

/** Names for the addresses the platform is documented to refuse (fetch.ts). */
const PRIVATE = [
	"https://127.0.0.1.nip.io/",
	"http://127.0.0.1.nip.io/",
	"https://10-0-0-1.nip.io/",
	"https://192.168.0.1.nip.io/",
	"https://172.16.0.1.nip.io/",
	"https://100.64.0.1.nip.io/",
	"https://169.254.169.254.nip.io/latest/meta-data/",
	"https://localtest.me/",
	"https://0--1.sslip.io/",
	"https://fd00--1.sslip.io/",
	"https://fe80--1.sslip.io/",
	"https://0--ffff-7f00-1.sslip.io/",
	"https://0--ffff-a9fe-a9fe.sslip.io/",
	"https://0--ffff-a00-1.sslip.io/",
];

/** The unspecified address and translation prefixes (NAT64, 6to4) around 127.0.0.1: not in the measured list, never a page. */
const OTHER = ["https://0.0.0.0.nip.io/", "https://0--0.sslip.io/", "https://64-ff9b--7f00-1.sslip.io/", "https://2002-7f00-1--1.sslip.io/"];

const redirect = (to: string) => `https://httpbin.org/redirect-to?url=${encodeURIComponent(to)}&status_code=302`;

describe("the Web connector's egress", () => {
	test("a public site is read (the control: the Worker reaches the internet)", async () => {
		const got = await get("https://example.com/");
		expect(got.page?.status, JSON.stringify(got)).toBe(200);
		expect(got.page?.href).toBe("https://example.com/");
	});

	test.each(PRIVATE)("%s is refused as a private site", async (url) => {
		const got = await get(url);
		expect(got.page, JSON.stringify(got)).toBeUndefined();
		expect(got.error, JSON.stringify(got)).toEqual(NOT_PUBLIC);
	});

	test.each(OTHER)("%s is never read", async (url) => {
		const got = await get(url);
		expect(got.page, JSON.stringify(got)).toBeUndefined();
		expect(got.error, JSON.stringify(got)).toBeDefined();
	});

	test("a redirect to a private name comes back as moved, and the new address is refused", async () => {
		for (const target of ["https://127.0.0.1.nip.io/", "http://169.254.169.254.nip.io/latest/meta-data/", "https://0--ffff-7f00-1.sslip.io/"]) {
			const got = await get(redirect(target));
			expect(got.moved, JSON.stringify(got)).toEqual({ href: target, host: new URL(target).hostname });
			expect((await get(target)).error, target).toEqual(NOT_PUBLIC);
		}
	});

	test("a redirect to an IP literal or a special-use name is refused before anything is sent", async () => {
		for (const target of ["https://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "https://[::ffff:127.0.0.1]/", "https://127.1/", "https://localhost/", "https://metadata.google.internal/"]) {
			const got = await get(redirect(target));
			expect(got.error, `${target}: ${JSON.stringify(got)}`).toEqual({ code: "PAGE_ERROR", message: "The site redirected to an address Minerva does not open." });
		}
	});

	test("the platform asks the site for gzip and br, whatever the connector asks for", async () => {
		// The echo also names the Worker's host (Cf-Worker), which stays out of the output: only this header is read.
		const got = await get("https://httpbin.org/headers");
		expect(got.page?.status, got.error?.code).toBe(200);
		expect(/"Accept-Encoding": "([^"]*)"/.exec(got.page?.start ?? "")?.[1]).toBe("gzip, br");
	});

	test("gzip reaches the connector as sent and is decoded there; br and deflate arrive decoded by the platform", async () => {
		// httpbin.org answers these in their encoding whatever was asked for.
		for (const [encoding, arrives, magic, marker] of [
			["gzip", "gzip", /^1f8b/, '"gzipped": true'],
			["deflate", null, /^7b/, '"deflated": true'],
			["brotli", null, /^7b/, '"brotli": true'],
		] as const) {
			const raw = await driver<Raw>("web/raw", { url: `https://httpbin.org/${encoding}` });
			expect(raw, encoding).toMatchObject({ status: 200, encoding: arrives });
			expect(raw.head, encoding).toMatch(magic);
			const got = await get(`https://httpbin.org/${encoding}`);
			expect(got.page?.status, `${encoding}: ${got.error?.code}`).toBe(200);
			expect(got.page?.start.includes(marker), encoding).toBe(true);
		}
	});

	test("a site behind Cloudflare that prefers brotli answers in an encoding the connector reads", async () => {
		for (const url of ["https://developers.cloudflare.com/", "https://www.cloudflare.com/"]) {
			const raw = await driver<Raw>("web/raw", { url });
			expect(raw.status, url).toBe(200);
			expect([null, "gzip"], `${url}: ${raw.encoding}`).toContain(raw.encoding);
			const got = await get(url);
			expect(got.page?.status, `${url}: ${got.error?.code}`).toBe(200);
		}
	});

	test("the platform's refusal is its error page to a request with an Accept header, and its text without one", async () => {
		const page = await driver<Raw>("web/raw", { url: "https://127.0.0.1.nip.io/" });
		expect(page).toMatchObject({ status: 403, server: "cloudflare", encoding: null });
		expect(page.type).toMatch(/^text\/html/);
		expect(/<span data-translate="error">Error<\/span>\s*<span>(\d{4})<\/span>/.exec(page.text ?? "")?.[1]).toBe("1002");
		const json = await driver<Raw>("web/raw", { url: "https://127.0.0.1.nip.io/", accept: "application/json" });
		expect(json.type).toMatch(/^text\/html/);
		const text = await driver<Raw>("web/raw", { url: "https://127.0.0.1.nip.io/", accept: "" });
		expect(text).toMatchObject({ status: 403, server: "cloudflare" });
		expect(text.text?.trim()).toBe("error code: 1002");
	});

	test("more fetches at once than the six connections an invocation has all finish, queued", async () => {
		// Twelve answers that each take two seconds: six at a time, so about two rounds.
		const urls = Array.from({ length: 12 }, (_, at) => `https://httpbin.org/delay/2?n=${at}`);
		const many = await driver<Many>("web/get-many", { urls, together: true });
		// Every fetch got the site's answer: the page, or now and then httpbin.org's gateway error (5xx), never
		// a wait that ran out. Most are pages.
		for (const item of many.results) {
			const answered = item.got.page?.status === 200 || (item.got.error?.code === "PAGE_ERROR" && /HTTP 5\d\d\./.test(item.got.error.message));
			expect(answered, `${item.url}: ${item.got.error?.code} ${item.got.error?.message}`).toBe(true);
		}
		expect(many.results.filter((item) => item.got.page?.status === 200).length).toBeGreaterThanOrEqual(9);
		console.log(`web/get-many, 12 × 2 s at once: ${many.ms} ms in all; each ${many.results.map((item) => item.ms).join(", ")} ms`);
		expect(many.ms).toBeLessThan(25_000);
	});

	test("redirects and error pages release their connections: more of them than six, then a page, in one invocation", async () => {
		// Each leaves a body the fetcher does not read; one it held would keep a connection, and the seventh would
		// wait for one until the fetch's 25 s ran out.
		// Large sites rather than httpbin.org, whose gateway fails now and then: their 404 pages, and a redirect to
		// another host.
		const urls = [
			...Array.from({ length: 4 }, (_, at) => `https://github.com/minerva-egress-check/missing-${at}`),
			...Array.from({ length: 4 }, (_, at) => `https://developers.cloudflare.com/minerva-egress-check-missing-${at}/`),
			...Array.from({ length: 4 }, (_, at) => `https://www.github.com/?n=${at}`),
			"https://example.com/",
		];
		const many = await driver<Many>("web/get-many", { urls, together: false });
		const last = many.results.at(-1);
		expect(last?.got.page?.status, last?.got.error?.code).toBe(200);
		for (const item of many.results.slice(0, 8)) expect(item.got.error, item.url).toEqual({ code: "PAGE_ERROR", message: "The site answered with HTTP 404." });
		for (const item of many.results.slice(8, 12)) expect(item.got.moved?.host, `${item.url}: ${item.got.error?.code}`).toBe("github.com");
		console.log(`web/get-many, 12 dropped bodies then a page, one after another: ${many.ms} ms in all; slowest ${Math.max(...many.results.map((item) => item.ms))} ms`);
		for (const item of many.results) expect(item.ms, item.url).toBeLessThan(10_000);
	});
});
