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
// Run with `pnpm test:faults` after `pnpm run deploy:test`.

import { describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);

interface Got {
	page?: { text: string; href: string; status: number; form: string; start: string };
	moved?: { text: string; href: string; host: string };
	error?: { code: string; message: string };
}

async function get(url: string): Promise<Got> {
	const reply = await fetchDeployed(`${worker.origin}/api/faults/web/get`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify({ url }),
		timeoutMs: 60_000,
	});
	if (reply.status !== 200) throw new Error(`web/get ${url}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as Got;
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
			expect(got.moved, JSON.stringify(got)).toEqual({ text: target, href: target, host: new URL(target).hostname });
			expect((await get(target)).error, target).toEqual(NOT_PUBLIC);
		}
	});

	test("a redirect to an IP literal or a special-use name is refused before anything is sent", async () => {
		for (const target of ["https://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "https://[::ffff:127.0.0.1]/", "https://127.1/", "https://localhost/", "https://metadata.google.internal/"]) {
			const got = await get(redirect(target));
			expect(got.error, `${target}: ${JSON.stringify(got)}`).toEqual({ code: "PAGE_ERROR", message: "The site redirected to an address Minerva does not open." });
		}
	});
});
