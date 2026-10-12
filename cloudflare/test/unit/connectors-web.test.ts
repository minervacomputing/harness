// backend/tests/test_web.py, case by case: site names, the fetcher, page text, search, and runs through the
// executor, against test/fixtures/connectors/web/fake.ts, which stands for what a Worker's fetch reaches
// (Cloudflare's checks in front of public DNS and web servers, as measured). Also: the registry accepts the
// declaration, with its fingerprints pinned, and the Worker serves it; the built-in connection and its
// access settings in the Workspace (the API routes that call discover and describe are the Worker's);
// and adversarial cases for what the fetcher may reach: IP literals in every spelling, names that resolve
// to private addresses or change their answer, redirects to private addresses, and decompression bombs.

import { gzipSync, deflateRawSync, deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import type { ConnectionId } from "../../src/contracts/common.ts";
import type { ToolCallOutcome } from "../../src/contracts/executor.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { webConnector } from "../../src/connectors/web/connector.ts";
import { ACCEPT, Body, Fetcher, LIMITS, MAX_BODY, Moved, Page, USER_AGENT } from "../../src/connectors/web/fetch.ts";
import { Inflater } from "../../src/connectors/web/inflate.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { resourceKey } from "../../src/gateway/grants.ts";
import { CallIo, NotSent, settingsIo } from "../../src/gateway/http.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import type { Json } from "../../src/lib/json.ts";
import { htmlToText } from "../../src/lib/markdown.ts";
import { ancestors, canonicalHost, choices, name, parseUrl, validId } from "../../src/lib/sites.ts";
import { FakeWeb, PUBLIC, type Served, privateAddress, stalled, trickle } from "../fixtures/connectors/web/fake.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";
import { ADA, GRACE, accessOf, harness } from "./workspace-support.ts";

const WEB: ConnectionId = "0199a000-0000-7000-8000-0000000000f1";
const registry = await Registry.create([webConnector({ braveKey: () => "test-key" })]);
const saved = { ...LIMITS };

afterEach(() => Object.assign(LIMITS, saved));

type Ok = Extract<ToolCallOutcome, { ok: true }>;

function code(call: () => unknown): string {
	try {
		call();
	} catch (error) {
		if (error instanceof OperationError) return error.code;
		throw error;
	}
	throw new Error("Nothing was raised.");
}

async function raised(promise: Promise<unknown>): Promise<OperationError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error;
		throw error;
	}
	throw new Error("Nothing was raised.");
}

async function acode(promise: Promise<unknown>): Promise<string> {
	return (await raised(promise)).code;
}

function fetcher(web: FakeWeb): Fetcher {
	return new Fetcher(settingsIo(web.fetch));
}

function html(body: string | Uint8Array, headers: { [name: string]: string } = {}): Served {
	return { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

async function page(web: FakeWeb, url: string): Promise<Page> {
	const outcome = await fetcher(web).get(parseUrl(url));
	if (!(outcome instanceof Page)) throw new Error(`${url} moved to ${outcome.target.text}`);
	return outcome;
}

function items(outcome: Ok): { [key: string]: Json }[] {
	return outcome.result.items;
}

/** test_web.py `start`: a run with the user's Web connection, holding `grants` ([kind, id, actions]); with the operator's Brave key unless `braveKey` says otherwise. */
function start(web: FakeWeb, grants: [string, string, string[]][], options: { ceiling?: GrantRow[]; braveKey?: string | null } = {}): Promise<Scenario> {
	const keyed = options.braveKey === undefined;
	const connector = webConnector({ braveKey: () => (keyed ? "test-key" : (options.braveKey ?? null)) });
	return Scenario.start({
		connectors: [connector],
		...(keyed ? { registry } : {}),
		connections: [{ id: WEB, provider: "web", payload: { kind: "builtin" } }],
		user: userGrants(WEB, "site", {}, grants),
		ceiling: options.ceiling ?? [],
		fetch: web.fetch,
	});
}

/** connector_runs.py `ceiling`: a grant of the workspace ceiling on the Web connection. */
function ceiling(kind: string, resourceId: string, effect: GrantRow["effect"], actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: WEB, kind, resourceId, resourceName: "", actions, effect };
}

describe("the declaration", () => {
	test("the registry accepts it, and its fingerprints are pinned", () => {
		expect(() => validate([webConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(webConnector().operations.map((op) => [op.name, registry.contract("web", op.name)]));
		console.log("web fingerprints", fingerprints);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({ search: "68fa7415b50b732a", read_page: "528e37f323c1de9b" });
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("web");
		const served = await connectorRegistry();
		for (const op of served.get("web").operations) expect(served.contract("web", op.name)).toBe(registry.contract("web", op.name));
	});
});

describe("site names", () => {
	test("hosts are canonical public names", () => {
		expect(canonicalHost("Docs.Python.ORG.")).toBe("docs.python.org");
		expect(canonicalHost("bücher.ch")).toBe("xn--bcher-kva.ch");
		for (const refused of [
			"localhost",
			"intranet",
			"printer.local",
			"db.internal",
			"site.example",
			"1.0.0.10.in-addr.arpa",
			"abc.onion",
			"127.0.0.1",
			"[::1]",
			"127.1",
			"0x7f.1",
			"2130706433",
			"-bad-.com",
			"a..com",
			`${"x".repeat(64)}.com`,
			"",
		]) {
			expect(code(() => canonicalHost(refused)), refused).toBe("INVALID_URL");
		}
	});

	test("patterns never span a public suffix", () => {
		expect(ancestors("a.docs.python.org")).toEqual(["*.a.docs.python.org", "*.docs.python.org", "*.python.org"]);
		expect(ancestors("python.org")).toEqual(["*.python.org"]);
		expect(ancestors("ada.github.io")).toEqual(["*.ada.github.io"]);
		expect(ancestors("shop.example.co.uk")).toEqual(["*.shop.example.co.uk", "*.example.co.uk"]);
		expect(choices("docs.python.org")).toEqual(["docs.python.org", "*.docs.python.org", "*.python.org"]);
		for (const valid of ["python.org", "*.python.org", "*.docs.python.org", "*.ada.github.io"]) expect(validId(valid), valid).toBe(true);
		for (const invalid of ["*.org", "*.co.uk", "*.github.io", "*", "Python.org", "*.*.python.org", "localhost", "1.2.3.4"]) {
			expect(validId(invalid), invalid).toBe(false);
		}
		expect(name("*.python.org")).toBe("python.org, including subdomains");
	});

	test("addresses are parsed into what is requested", () => {
		const url = parseUrl("HTTPS://Docs.Python.org/3/library/os.html?q=a%20b#frag");
		expect([url.scheme, url.host, url.target]).toEqual(["https", "docs.python.org", "/3/library/os.html?q=a%20b"]);
		expect(parseUrl("http://example.com").text).toBe("http://example.com/");
		expect(parseUrl("https://example.com:443/x").text).toBe("https://example.com/x");
		expect(parseUrl("/next", url).text).toBe("https://docs.python.org/next");
		expect(parseUrl("//other.org/y", url).text).toBe("https://other.org/y");
		for (const refused of [
			"ftp://example.com/",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"https://user:pw@example.com/",
			"https://example.com@127.0.0.1/",
			"https://example.com:8443/",
			"https://127.0.0.1/",
			"https://[::1]/",
			"http://127.1/",
			"http://localhost/",
			"https://example.com\\@evil.org/",
			"https://exa mple.com/",
			"https://example.com/\n",
			"https:///path",
			`https://${"a".repeat(2000)}.com/`,
		]) {
			expect(code(() => parseUrl(refused)), refused).toBe("INVALID_URL");
		}
	});

	test("only public addresses are opened: the platform refuses the rest, and the fetcher says so", async () => {
		// test_web.py `public_address` decided this before connecting; a Worker cannot pin the address it
		// connects to, so the platform refuses private ones (the fake models it) and the fetcher reports it.
		for (const address of [PUBLIC, "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
			const web = new FakeWeb();
			web.site("example.com", address);
			web.page("example.com", "/", html("<p>ok</p>"));
			expect((await page(web, "https://example.com/")).text, address).toBe("<p>ok</p>");
		}
		for (const address of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"255.255.255.255",
			"::1",
			"fe80::1",
			"fe80::1%en0",
			"fc00::1",
			"::ffff:127.0.0.1",
			"::ffff:169.254.169.254",
			"::127.0.0.1",
			"2002:7f00:0001::1",
			"64:ff9b::a00:1",
			"ff02::1",
		]) {
			expect(privateAddress(address), address).toBe(true);
			const web = new FakeWeb();
			web.site("example.com", address);
			web.page("example.com", "/", html("<p>inside</p>"));
			const error = await raised(fetcher(web).get(parseUrl("https://example.com/")));
			expect([error.code, error.message], address).toEqual(["SITE_NOT_PUBLIC", "This site's name points to a private network, which Minerva does not open."]);
			expect(web.requests, address).toEqual([]);
		}
	});
});

describe("the fetcher", () => {
	test("asks for the site under its own name, with no cookies or credentials, nothing followed or decoded by the runtime", async () => {
		const web = new FakeWeb();
		web.site("example.com", PUBLIC);
		web.page("example.com", "/a?b=1", html("<p>Hello</p>"));
		const got = await page(web, "https://example.com/a?b=1");
		expect([got.form, got.text, got.url.text]).toEqual(["html", "<p>Hello</p>", "https://example.com/a?b=1"]);
		const [request] = web.requests;
		expect(request?.url).toBe("https://example.com/a?b=1");
		expect(request?.method).toBe("GET");
		expect(Object.fromEntries(request?.headers ?? [])).toEqual({
			"user-agent": USER_AGENT,
			accept: ACCEPT,
			"accept-encoding": "gzip, deflate",
			"accept-language": "en;q=0.9, *;q=0.5",
		});
		expect([request?.redirect, request?.encodeResponseBody]).toEqual(["manual", "manual"]);
	});

	test("a site whose address is private is refused", async () => {
		for (const addresses of [["127.0.0.1"], ["10.0.0.5", PUBLIC], ["::ffff:192.168.0.1"]]) {
			const web = new FakeWeb();
			web.site("sneaky.example.com", ...addresses);
			expect(await acode(fetcher(web).get(parseUrl("https://sneaky.example.com/"))), addresses.join()).toBe("SITE_NOT_PUBLIC");
			expect(web.requests).toEqual([]);
		}
		// Deviation: today a name with any private address is refused; the platform decides by the address it
		// connects to (the fake: the first), so a private address is never reached, but the public one may be.
		const web = new FakeWeb();
		web.site("mixed.example.com", PUBLIC, "10.0.0.5");
		web.page("mixed.example.com", "/", html("<p>public</p>"));
		expect((await page(web, "https://mixed.example.com/")).text).toBe("<p>public</p>");
	});

	test("redirects are followed only on the same host", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/old", { status: 301, headers: { location: "/new" } });
		web.page("example.com", "/new", { status: 200, headers: { "content-type": "text/plain" }, body: "moved" });
		web.page("example.com", "/away", { status: 302, headers: { location: "https://evil.example.org/x" } });
		web.page("example.com", "/down", { status: 302, headers: { location: "http://example.com/new" } });
		web.page("example.com", "/inside", { status: 302, headers: { location: "http://10.0.0.1/" } });
		web.page("example.com", "/loop", { status: 302, headers: { location: "/loop" } });
		const got = await page(web, "https://example.com/old");
		expect([got.url.text, got.text]).toEqual(["https://example.com/new", "moved"]);
		const away = await fetcher(web).get(parseUrl("https://example.com/away"));
		expect(away instanceof Moved && away.target.text).toBe("https://evil.example.org/x");
		expect(web.resolved).not.toContain("evil.example.org");
		const down = await fetcher(web).get(parseUrl("https://example.com/down"));
		expect(down instanceof Moved && down.target.scheme).toBe("http");
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/inside")))).toMatchObject({
			code: "PAGE_ERROR",
			message: "The site redirected to an address Minerva does not open.",
		});
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/loop")))).toMatchObject({ code: "PAGE_ERROR", message: "The site redirected too many times." });
		expect(web.requests.filter((request) => request.target === "/loop")).toHaveLength(6);
		expect(web.sent.map((request) => request.host)).not.toContain("10.0.0.1");
	});

	test("bodies are capped before and after decompression", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		const bomb = gzipSync(new Uint8Array(MAX_BODY + 10).fill(0x61));
		expect(bomb.length).toBeLessThan(100_000);
		web.page("example.com", "/bomb", html(bomb, { "content-encoding": "gzip" }));
		web.page("example.com", "/big", html(new Uint8Array(MAX_BODY + 1).fill(0x61)));
		web.page("example.com", "/zipped", html(gzipSync("<p>small</p>"), { "content-encoding": "gzip" }));
		web.page("example.com", "/twice", html("x", { "content-encoding": "gzip, br" }));
		web.page("example.com", "/pdf", { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" });
		web.page("example.com", "/gone", { status: 410 });
		for (const [target, expected] of [
			["/bomb", "PAGE_TOO_LARGE"],
			["/big", "PAGE_TOO_LARGE"],
			["/twice", "UNSUPPORTED_CONTENT"],
			["/pdf", "UNSUPPORTED_CONTENT"],
			["/gone", "PAGE_ERROR"],
		]) {
			expect(await acode(fetcher(web).get(parseUrl(`https://example.com${target}`))), target).toBe(expected);
		}
		expect((await page(web, "https://example.com/zipped")).text).toBe("<p>small</p>");
	});

	test("charsets are honoured", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
		web.page("example.com", "/meta", { status: 200, headers: { "content-type": "text/html" }, body: latin1("<meta charset='iso-8859-1'><p>Zürich</p>") });
		web.page("example.com", "/header", { status: 200, headers: { "content-type": "text/plain; charset=latin-1" }, body: latin1("Zürich") });
		expect((await page(web, "https://example.com/meta")).text).toContain("Zürich");
		expect((await page(web, "https://example.com/header")).text).toBe("Zürich");
	});
});

describe("page text", () => {
	test("pages become readable text without active content", () => {
		const page = `<html><head><title> The  Title </title><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav>
    <h1>Heading</h1><p>Some <b>bold</b> and <a href="/docs (1)">a link</a>.</p>
    <script>steal()</script><iframe src="https://evil.example.org"></iframe>
    <ul><li>one</li><li>two<ol><li>inner</li></ol></li></ul>
    <pre>  indented
    code</pre>
    <img src="https://evil.example.org/leak?d=secret" alt="A cat">
    <a href="javascript:alert(1)">bad</a>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <footer>Footer</footer></body></html>`;
		const [text, title] = htmlToText(page, "https://example.com/page");
		expect(title).toBe("The Title");
		expect(text.startsWith("# Heading")).toBe(true);
		expect(text).toContain("Some **bold** and [a link](https://example.com/docs%20%281%29).");
		expect(text).toContain("- one\n- two\n  1. inner");
		expect(text).toContain("```\n  indented\n    code\n```");
		expect(text).toContain("[image: A cat]");
		expect(text).not.toContain("leak");
		expect(text).toContain("bad");
		expect(text).not.toContain("javascript");
		expect(text).toContain("A | B\n1 | 2");
		for (const dropped of ["steal", "evil.example.org", "Home", "Footer", "p{}"]) expect(text, dropped).not.toContain(dropped);
	});

	test("hostile markup is converted in linear time", () => {
		// A link left open inside a script that never closes.
		expect(htmlToText('<a href="/"><script>', "https://example.com/")).toEqual(["", null]);
		expect(htmlToText('<a href="/">x<script>', "https://example.com/")[0]).toBe("[x](https://example.com/)");
		const n = 50_000;
		for (const page of [
			`${'<a href="/">'.repeat(n)}x${"</a>".repeat(n)}`,
			`${"<svg>".repeat(n)}<math>${"</svg>".repeat(n)}text`,
			`${"<svg><math>".repeat(n)}${"</math>".repeat(n)}${"</svg>".repeat(n)}`,
			`${"<ul><li>".repeat(n)}x`,
		]) {
			const begun = performance.now();
			htmlToText(page, "https://example.com/");
			expect(performance.now() - begun, page.slice(0, 20)).toBeLessThan(3000);
		}
		// Links do not nest.
		expect(htmlToText('<a href="/a">one <a href="/b">two</a></a>', "https://example.com/")[0]).toBe("[one](https://example.com/a)[two](https://example.com/b)");
	});
});

describe("runs through the executor", () => {
	test("a domain grant covers its subdomains and nothing else", async () => {
		const web = new FakeWeb();
		for (const host of ["python.org", "docs.python.org", "evil.example.org"]) {
			web.site(host);
			web.page(host, "/", html(`<title>${host}</title><p>Welcome to ${host}</p>`));
		}
		const run = await start(web, [["site", "*.python.org", ["read"]]]);
		expect(run.tools).toEqual(["web_read_page"]);
		let item: { [key: string]: Json } = {};
		for (const url of ["https://python.org/", "https://docs.python.org/"]) {
			[item = {}] = items(await run.ok("web_read_page", { url }));
			expect([item.url, item.title]).toEqual([url, parseUrl(url).host]);
		}
		expect(item.text).toContain("Welcome to docs.python.org");
		const sent = web.sent.length;
		expect(await run.code("web_read_page", { url: "https://evil.example.org/" })).toBe("POLICY_DENIED");
		expect(await run.code("web_read_page", { url: "http://localhost/" })).toBe("INVALID_URL");
		// Nothing was sent for the refused addresses.
		expect(web.sent).toHaveLength(sent);
	});

	test("a block on a subdomain wins", async () => {
		const web = new FakeWeb();
		web.site("docs.python.org");
		web.page("docs.python.org", "/", html("<p>docs</p>"));
		const run = await start(web, [["site", "*", ["read"]]], { ceiling: [ceiling("site", "*.docs.python.org", "deny")] });
		expect(await run.code("web_read_page", { url: "https://docs.python.org/" })).toBe("POLICY_DENIED");
		expect(await run.code("web_read_page", { url: "https://a.docs.python.org/" })).toBe("POLICY_DENIED");
		expect(web.sent).toEqual([]);
	});

	test("a redirect to another site is returned, not followed", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/", { status: 302, headers: { location: "https://evil.example.org/?d=1" } });
		const run = await start(web, [["site", "example.com", ["read"]]]);
		const [item] = items(await run.ok("web_read_page", { url: "https://example.com/" }));
		expect(item).toEqual({
			url: "https://example.com/",
			redirect_to: "https://evil.example.org/?d=1",
			note: "This page moved to another address. Open redirect_to to follow it; that site needs its own permission.",
		});
		expect(web.resolved).toEqual(["example.com"]);
	});

	test("long pages are read in parts", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/", { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(1200) });
		const run = await start(web, [["site", "example.com", ["read"]]]);
		const [first] = items(await run.ok("web_read_page", { url: "https://example.com/", max_chars: 500 }));
		expect([(first?.text as string).length, first?.total_chars, first?.next_offset]).toEqual([500, 1200, 500]);
		const [last] = items(await run.ok("web_read_page", { url: "https://example.com/", max_chars: 1000, offset: 500 }));
		expect(last?.next_offset).toBeNull();
		expect(last).toMatchObject({ url: "https://example.com/", title: null, content_type: "text/plain", offset: 500, total_chars: 1200 });
	});

	test("searching needs its own permission", async () => {
		const web = new FakeWeb();
		let run = await start(web, [["site", "*", ["read"]]]);
		expect(run.tools).toEqual(["web_read_page"]);
		expect(await run.code("web_search", { query: "python" })).toBe("UNKNOWN_OPERATION");
		expect(web.brave.requests).toEqual([]);
		run = await start(web, [
			["account", WEB, ["search"]],
			["site", "example.com", ["read"]],
		]);
		expect(run.tools).toEqual(["web_search", "web_read_page"]);
		const outcome = await run.ok("web_search", { query: "python docs", limit: 5, country: "CH" });
		expect(items(outcome)).toEqual([
			{ title: "Python docs", url: "https://docs.python.org/3/", site: "docs.python.org", snippet: "The & official docs", age: "2 days ago" },
		]);
		expect(outcome.result.next_cursor).toBeTruthy();
		const [request] = web.brave.requests;
		const params = new URL(request?.url ?? "").searchParams;
		expect([params.get("q"), params.get("count"), params.get("country"), params.get("offset")]).toEqual(["python docs", "5", "CH", "0"]);
		expect([...params.keys()]).toEqual(["q", "count", "offset", "safesearch", "text_decorations", "result_filter", "country"]);
		expect(request?.headers.get("x-subscription-token")).toBe("test-key");
		await run.ok("web_search", { query: "python docs", limit: 5, country: "CH", cursor: outcome.result.next_cursor as string });
		expect(new URL(web.brave.requests[1]?.url ?? "").searchParams.get("offset")).toBe("1");
		// Search results do not open pages: reading one still needs the site.
		expect(await run.code("web_read_page", { url: "https://docs.python.org/3/" })).toBe("POLICY_DENIED");
	});

	test("a refused search key keeps the connection", async () => {
		const web = new FakeWeb();
		web.brave.status = 401;
		const run = await start(web, [["account", WEB, ["search"]]]);
		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			expect(await run.error("web_search", { query: "python" })).toEqual({
				code: "SEARCH_UNAVAILABLE",
				message: "Web search is not available on this Minerva instance right now.",
			});
		} finally {
			console.error = original;
		}
		expect(run.credentials.status(WEB)).toBe("active");
		expect(JSON.stringify(logged)).not.toContain("test-key");
	});

	test("search is not offered without a key", async () => {
		const run = await start(new FakeWeb(), [
			["account", WEB, ["search"]],
			["site", "*", ["read"]],
		], { braveKey: null });
		expect(run.tools).toEqual(["web_read_page"]);
	});

	test("an empty key is set, as Python's empty SecretStr: search is offered, then unavailable", async () => {
		const web = new FakeWeb();
		const run = await start(web, [["account", WEB, ["search"]]], { braveKey: "" });
		expect(run.tools).toEqual(["web_search"]);
		expect(await run.error("web_search", { query: "python" })).toEqual({ code: "SEARCH_UNAVAILABLE", message: "Web search is not set up on this Minerva instance." });
		expect(web.brave.requests).toEqual([]);
	});
});

describe("settings", () => {
	test("the Web is added once per user and has no account to reconnect", async () => {
		const h = await harness({ connectors: [webConnector({ braveKey: () => "test-key" })] });
		const first = await h.core.enableBuiltin(ADA, "web");
		const again = await h.core.enableBuiltin(ADA, "web");
		if (!first.ok || !again.ok) throw new Error("not enabled");
		expect(first.value.id).toBe(again.value.id);
		expect(first.value).toMatchObject({ provider: "web", auth: "builtin", label: "Web" });
		const theirs = await h.core.enableBuiltin(GRACE, "web");
		expect(theirs.ok && theirs.value.id !== first.value.id).toBe(true);
		expect(await h.core.enableBuiltin(ADA, "nope")).toMatchObject({ ok: false, refusal: { status: 404 } });
	});

	test("sites are found by address and allowed per domain", async () => {
		const web = new FakeWeb();
		const connector = webConnector({ braveKey: () => "test-key" });
		const h = await harness({ connectors: [connector] });
		const enabled = await h.core.enableBuiltin(ADA, "web");
		if (!enabled.ok) throw new Error("not enabled");
		const id = enabled.value.id;
		const access = accessOf(await h.core.getAccess(ADA, id));
		const site = access?.kinds.find((kind) => kind.id === "site");
		expect(site?.listed).toBe(false);
		expect(site?.note).toBeTruthy();
		const client = connector.client("", settingsIo(web.fetch));
		expect((await connector.discover?.(client, "site", { query: null, cursor: null }))?.items).toEqual([]);
		const found = await connector.discover?.(client, "site", { query: "https://Docs.Python.org/3/", cursor: null });
		expect(found?.items.map((item) => [item.id, item.name])).toEqual([
			["docs.python.org", "docs.python.org"],
			["*.docs.python.org", "docs.python.org, including subdomains"],
			["*.python.org", "python.org, including subdomains"],
		]);
		expect((await connector.discover?.(client, "site", { query: " docs.python.org/3/x ", cursor: null }))?.items.map((item) => item.id)).toEqual([
			"docs.python.org",
			"*.docs.python.org",
			"*.python.org",
		]);
		expect(await acode(Promise.resolve().then(() => connector.discover?.(client, "site", { query: "http://10.0.0.1/", cursor: null })))).toBe("INVALID_URL");
		// The route names what is allowed with describe and refuses what it cannot name (connections/api.py).
		const refused = ["*.org", "*.github.io", "localhost", "10.0.0.1", "Python.org", "*.*.python.org"];
		expect(await connector.describe?.(client, "site", ["*.python.org", ...refused])).toEqual({ "*.python.org": "python.org, including subdomains" });
		expect(web.sent).toEqual([]);
		const change = (resourceId: string, kind = "site", actions = ["read"]) =>
			h.core.applyGrantChanges(ADA, id, [{ kind, id: resourceId, actions }], kind === "site" ? { [resourceKey(kind, resourceId)]: name(resourceId) } : {});
		expect((await change("*.python.org")).ok).toBe(true);
		expect(await change("*.python.org", "site", ["search"])).toMatchObject({ ok: false, refusal: { status: 422 } });
		expect((await change(id, "account", ["search"])).ok).toBe(true);
		const grants = accessOf(await h.core.getAccess(ADA, id)).grants.map((grant) => [grant.kind, grant.id, grant.actions]);
		expect(grants).toEqual(
			expect.arrayContaining([
				["site", "*.python.org", ["read"]],
				["account", id, ["search"]],
			]),
		);
		expect(grants).toHaveLength(2);
	});
});

describe("what the fetcher may reach (adversarial)", () => {
	test("IP literals in every spelling are refused before anything is sent", async () => {
		const web = new FakeWeb();
		const run = await start(web, [["site", "*", ["read"]]]);
		for (const host of [
			"127.0.0.1",
			"2130706433",
			"017700000001",
			"0x7f000001",
			"0x7f.1",
			"0x7f.0.0.1",
			"0177.0.0.1",
			"127.1",
			"127.0.1",
			"127.000.000.001",
			"0",
			"0.0.0.0",
			"169.254.169.254",
			"[::1]",
			"[::ffff:127.0.0.1]",
			"[::ffff:7f00:1]",
			"[0:0:0:0:0:ffff:127.0.0.1]",
			"[::127.0.0.1]",
			"[64:ff9b::7f00:1]",
			"[2002:7f00:1::1]",
			"[fe80::1%25en0]",
			"[fd00:ec2::254]",
			"１２７.０.０.１",
			"127。0。0。1",
			"127.0.0.1.",
			"[v1.fe80::1]",
		]) {
			for (const url of [`http://${host}/`, `https://${host}:443/latest/meta-data/`]) {
				expect(await run.code("web_read_page", { url }), url).toBe("INVALID_URL");
			}
		}
		expect(web.sent).toEqual([]);
	});

	test("names that point to private addresses are refused by the platform and reported as not public", async () => {
		const web = new FakeWeb();
		const run = await start(web, [["site", "*", ["read"]]]);
		for (const host of ["127.0.0.1.nip.io", "app.10.0.0.1.nip.io", "169-254-169-254.nip.io", "7f000001.nip.io", "192.168.0.1.sslip.io", "localtest.me", "a.localtest.me"]) {
			expect(await run.error("web_read_page", { url: `https://${host}/` }), host).toEqual({
				code: "SITE_NOT_PUBLIC",
				message: "This site's name points to a private network, which Minerva does not open.",
			});
		}
		expect(web.requests).toEqual([]);
		// Names under special-use or unknown suffixes never leave the Worker.
		for (const host of ["metadata.google.internal", "foo.localhost", "printer.local", "router.lan", "intranet"]) {
			expect(await run.code("web_read_page", { url: `https://${host}/` }), host).toBe("INVALID_URL");
		}
		expect(web.sent.map((request) => request.host)).not.toContain("metadata.google.internal");
		// A name public DNS lacks.
		expect(await run.error("web_read_page", { url: "https://nowhere.example.org/" })).toEqual({ code: "SITE_UNREACHABLE", message: "This site's name could not be found." });
	});

	test("a name that changes its answer is refused once it points inside, on any hop", async () => {
		const web = new FakeWeb();
		let lookups = 0;
		web.dns.set("rebind.example.org", () => (lookups++ === 0 ? [PUBLIC] : ["127.0.0.1"]));
		web.page("rebind.example.org", "/", html("<p>public</p>"));
		web.page("rebind.example.org", "/hop", { status: 302, headers: { location: "/" } });
		const run = await start(web, [["site", "rebind.example.org", ["read"]]]);
		expect(items(await run.ok("web_read_page", { url: "https://rebind.example.org/" }))[0]?.text).toBe("public");
		expect(await run.code("web_read_page", { url: "https://rebind.example.org/" })).toBe("SITE_NOT_PUBLIC");
		// Within one fetch: the first hop reaches the public address, the redirect's hop is refused.
		lookups = 0;
		expect(await run.code("web_read_page", { url: "https://rebind.example.org/hop" })).toBe("SITE_NOT_PUBLIC");
		expect(web.requests.map((request) => request.target)).toEqual(["/", "/hop"]);
	});

	test("redirects to private addresses are refused without a request; to another name, returned for authorization", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		const targets = [
			"http://127.0.0.1/",
			"https://[::1]/",
			"http://2130706433/",
			"http://0x7f000001/",
			"http://017700000001/",
			"http://[::ffff:127.0.0.1]/",
			"http://169.254.169.254/latest/meta-data/",
			"http://localhost/",
			"//127.0.0.1/",
			"http://example.com@10.0.0.1/",
			"file:///etc/passwd",
		];
		for (const [index, location] of targets.entries()) web.page("example.com", `/r${index}`, { status: 302, headers: { location } });
		web.page("example.com", "/nip", { status: 302, headers: { location: "http://127.0.0.1.nip.io/admin" } });
		const run = await start(web, [["site", "*", ["read"]]]);
		for (const [index, location] of targets.entries()) {
			expect(await run.error("web_read_page", { url: `https://example.com/r${index}` }), location).toEqual({
				code: "PAGE_ERROR",
				message: "The site redirected to an address Minerva does not open.",
			});
		}
		expect(new Set(web.sent.map((request) => request.host))).toEqual(new Set(["example.com"]));
		const [moved] = items(await run.ok("web_read_page", { url: "https://example.com/nip" }));
		expect(moved?.redirect_to).toBe("http://127.0.0.1.nip.io/admin");
		// Following it is a new read, authorized like any other, and the platform refuses the address.
		expect(await run.code("web_read_page", { url: moved?.redirect_to as string })).toBe("SITE_NOT_PUBLIC");
		expect(web.requests.every((request) => request.host === "example.com" && request.redirect === "manual")).toBe(true);
	});

	test("decompression bombs stop at the cap in every wrapper, however they arrive", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		const huge = new Uint8Array(40 * MAX_BODY);
		const bombs: [string, string, Uint8Array][] = [
			["/gzip", "gzip", gzipSync(huge, { level: 9 })],
			["/x-gzip", "x-gzip", gzipSync(huge, { level: 9 })],
			["/zlib", "deflate", deflateSync(huge, { level: 9 })],
			["/raw", "deflate", deflateRawSync(huge, { level: 9 })],
		];
		for (const [target, encoding, body] of bombs) {
			expect(body.length).toBeLessThan(200_000);
			web.page("example.com", target, html(body, { "content-encoding": encoding }));
			// One byte at a time, the slowest way to feed it.
			web.page("example.com", `${target}/bytes`, () => ({
				status: 200,
				headers: { "content-type": "text/html", "content-encoding": encoding },
				body: new ReadableStream({
					start(controller) {
						for (const byte of body.subarray(0, 20_000)) controller.enqueue(new Uint8Array([byte]));
						controller.close();
					},
				}),
			}));
		}
		// A gzip inside a gzip is decoded once: the inner bomb stays compressed.
		web.page("example.com", "/nested", html(gzipSync(gzipSync(huge)), { "content-encoding": "gzip" }));
		for (const [target] of bombs) {
			expect(await raised(fetcher(web).get(parseUrl(`https://example.com${target}`))), target).toMatchObject({
				code: "PAGE_TOO_LARGE",
				message: `This page is larger than Minerva reads (${MAX_BODY} bytes).`,
			});
			// Raw DEFLATE is told from zlib only when zlib fails on the first chunk, which one byte cannot do:
			// Python reads that body as damaged too.
			expect(await acode(fetcher(web).get(parseUrl(`https://example.com${target}/bytes`))), `${target}/bytes`).toBe(target === "/raw" ? "UNSUPPORTED_CONTENT" : "PAGE_TOO_LARGE");
		}
		const nested = await page(web, "https://example.com/nested");
		expect(nested.text.length).toBeLessThan(200_000);
		// The inflater never produces more than it is given room for, whatever one chunk holds.
		for (const [, encoding, body] of bombs) {
			const inflater = new Inflater(encoding, () => new OperationError("PAGE_TOO_LARGE", "too large"));
			let produced = 0;
			const error = (() => {
				try {
					for (const part of inflater.feed(body, MAX_BODY + 1)) produced += part.length;
				} catch (caught) {
					return caught;
				}
				return null;
			})();
			expect(error).toBeInstanceOf(OperationError);
			expect(produced).toBe(0);
		}
		// The room is a hard limit, as `decompress(data, max_length)`'s: a page that fills it exactly still
		// ends (zlib reads the trailer without room to write), one byte more is left over and too large.
		const tooLarge = () => new OperationError("PAGE_TOO_LARGE", "too large");
		const length = (parts: Uint8Array[]) => parts.reduce((sum, part) => sum + part.length, 0);
		expect(length(new Inflater("gzip", tooLarge).feed(gzipSync(new Uint8Array(1000)), 1000))).toBe(1000);
		expect(code(() => new Inflater("gzip", tooLarge).feed(gzipSync(new Uint8Array(1000)), 999))).toBe("PAGE_TOO_LARGE");
	});

	test("a body sent as is is capped at the limit, which it may reach exactly", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/exact", { status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array(MAX_BODY).fill(0x61) });
		web.page("example.com", "/over", { status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array(MAX_BODY + 1).fill(0x61) });
		web.page("example.com", "/zipped-over", html(gzipSync(new Uint8Array(MAX_BODY + 1)), { "content-encoding": "gzip" }));
		expect((await page(web, "https://example.com/exact")).text).toHaveLength(MAX_BODY);
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/over")))).toBe("PAGE_TOO_LARGE");
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/zipped-over")))).toBe("PAGE_TOO_LARGE");
		// br is not read, as today: the runtime would decode it before any cap.
		web.page("example.com", "/br", html("x", { "content-encoding": "br" }));
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/br")))).toMatchObject({
			code: "UNSUPPORTED_CONTENT",
			message: "This site sent its page in an encoding Minerva cannot read.",
		});
	});

	test("only the platform's own refusal is read as one", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/origin-403", { status: 403, headers: { "content-type": "text/plain" }, body: "error code: 1003" });
		web.page("example.com", "/long", { status: 403, headers: { server: "cloudflare" }, body: `error code: 1003${" ".repeat(2000)}` });
		web.page("example.com", "/other", { status: 403, headers: { server: "cloudflare" }, body: "error code: 1020" });
		web.page("example.com", "/limits", { status: 503, headers: { server: "cloudflare" }, body: "error code: 1102" });
		// An origin whose error body never comes is an error response, not a slow site.
		web.page("example.com", "/stalled", { status: 403, headers: { server: "cloudflare" }, body: stalled("error code: ") });
		for (const [target, status] of [
			["/origin-403", 403],
			["/long", 403],
			["/other", 403],
			["/limits", 503],
			["/stalled", 403],
		] as const) {
			expect(await raised(fetcher(web).get(parseUrl(`https://example.com${target}`))), target).toMatchObject({
				code: "PAGE_ERROR",
				message: `The site answered with HTTP ${status}.`,
			});
		}
	});

	test("a refusal body that never comes ends with the fetch's total time, as the error response it is", async () => {
		// Before: the read waited its own second past the total time. Python reads no error body, so the answer
		// is PAGE_ERROR (the response came in time), not SITE_TIMEOUT.
		Object.assign(LIMITS, { totalMs: 50 });
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/stalled", { status: 403, headers: { server: "cloudflare" }, body: stalled("error code: ") });
		const started = performance.now();
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/stalled")))).toMatchObject({ code: "PAGE_ERROR", message: "The site answered with HTTP 403." });
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("the whole fetch has its time, and every wait its own", async () => {
		Object.assign(LIMITS, { totalMs: 400, phaseMs: 100 });
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/silent", () => new Promise<Served>(() => {}));
		web.page("example.com", "/stalls", { status: 200, headers: { "content-type": "text/plain" }, body: stalled("a") });
		web.page("example.com", "/trickles", () => ({ status: 200, headers: { "content-type": "text/plain" }, body: trickle(20) }));
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/silent")))).toMatchObject({ code: "SITE_UNREACHABLE", message: "This site could not be reached." });
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/stalls")))).toBe("SITE_UNREACHABLE");
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/trickles")))).toMatchObject({ code: "SITE_TIMEOUT", message: "This site took too long to answer." });
	});

	test("a body that is not read is released, and a page in many small pieces is read whole", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		let cancelled = 0;
		const unread = (encoding: string): Served => ({
			status: 200,
			headers: { "content-type": "text/html", "content-encoding": encoding },
			body: new ReadableStream({ pull: () => {}, cancel: () => void cancelled++ }),
		});
		web.page("example.com", "/br", () => unread("br"));
		web.page("example.com", "/stacked", () => unread("gzip, deflate"));
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/br")))).toBe("UNSUPPORTED_CONTENT");
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/stacked")))).toBe("UNSUPPORTED_CONTENT");
		expect(cancelled).toBe(2);
		const body = new Body(null);
		for (let i = 0; i < 200_000; i++) body.feed(new Uint8Array([0x61]));
		expect(body.bytes()).toEqual(new Uint8Array(200_000).fill(0x61));
	});

	test("a run that no longer admits requests sends nothing, and says so as it is", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		const io = new CallIo({ fetch: web.fetch, now: () => performance.now(), admits: () => false });
		await expect(new Fetcher(io).get(parseUrl("https://example.com/"))).rejects.toBeInstanceOf(NotSent);
		expect(web.sent).toEqual([]);
	});
});
