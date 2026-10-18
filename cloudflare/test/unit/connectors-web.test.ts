// The Web connector against test/fixtures/connectors/web/fake.ts, which stands for what a Worker's fetch
// reaches (Cloudflare's checks in front of public DNS and web servers, as measured): the declaration and its
// pinned fingerprints, inputs, site names and patterns, the fetcher (requests, redirects, bodies, bounded
// decompression, charsets), page text, search, runs through the executor, and finding sites to allow. Then
// adversarial cases for what the fetcher may reach: IP literals in every spelling, names that resolve to
// private addresses or change their answer, redirects to private addresses, and decompression bombs.

import { crc32, gzipSync, deflateRawSync, deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { SEARCH, webConnector } from "../../src/connectors/web/connector.ts";
import { ACCEPT, Body, Fetcher, LIMITS, MAX_BODY, Moved, Page, USER_AGENT, decode } from "../../src/connectors/web/fetch.ts";
import { Inflater } from "../../src/connectors/web/inflate.ts";
import { plain } from "../../src/connectors/web/search.ts";
import { OperationError, binding, offered, termsOf } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { CallIo, NotSent, settingsIo } from "../../src/gateway/http.ts";
import { Registry, inputSchema, validate } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { htmlToText } from "../../src/lib/markdown.ts";
import { ancestors, canonicalHost, choices, name, parseUrl, registrable, validId } from "../../src/lib/sites.ts";
import type { ConnectionId } from "../../src/shared/rpc.ts";
import { FakeWeb, PUBLIC, type Served, privateAddress, refusalPage, stalled, trickle } from "../fixtures/connectors/web/fake.ts";
import { catalogEntry } from "./catalog-support.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

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
	if (!(outcome instanceof Page)) throw new Error(`${url} moved to ${outcome.target.href}`);
	return outcome;
}

function items(outcome: Ok): { [key: string]: Json }[] {
	return outcome.result.items;
}

/** A run with the user's Web connection, holding `grants` ([kind, id, actions]); with the operator's Brave key unless `braveKey` says otherwise. */
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

/** A grant of the workspace ceiling on the Web connection. */
function ceiling(kind: string, resourceId: string, effect: GrantRow["effect"], actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: WEB, kind, resourceId, resourceName: "", actions, effect };
}

describe("the declaration", () => {
	test("the registry accepts it, and its fingerprints are pinned", () => {
		expect(() => validate([webConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(webConnector().operations.map((op) => [op.name, registry.contract("web", op.name)]));
		console.log("web fingerprints", fingerprints);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({ search: "ef64b3e7dc22667f", read_page: "e6da9103cf2f456b" });
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("web");
		const served = await connectorRegistry();
		for (const op of served.get("web").operations) expect(served.contract("web", op.name)).toBe(registry.contract("web", op.name));
	});

	test("two kinds, builtin auth, and search offered only with a key", async () => {
		const withoutKey = webConnector({ braveKey: () => null });
		const withKey = webConnector({ braveKey: () => "k" });
		expect((await catalogEntry(withoutKey)).kinds.map((kind) => [kind.id, kind.actions, kind.wildcard, kind.hierarchical, kind.listed])).toEqual([
			["account", ["search"], false, false, true],
			["site", ["read"], true, true, false],
		]);
		expect(withoutKey.actions).toEqual([
			{ id: "search", label: "Search the web" },
			{ id: "read", label: "Read pages" },
		]);
		expect(withoutKey.auth).toEqual({ type: "builtin" });
		expect([withoutKey.browsable ?? [], withoutKey.manageLink]).toEqual([[], undefined]);
		expect(withoutKey.operations.map((op) => [op.name, op.needs, termsOf(op).outputAction, termsOf(op).paginated, offered(withoutKey, op)])).toEqual([
			["search", [["account", "search"]], "search", true, false],
			["read_page", [["site", "read"]], "read", false, true],
		]);
		expect(withKey.operations.map((op) => offered(withKey, op))).toEqual([true, true]);
		for (const op of withoutKey.operations) expect(JSON.stringify(inputSchema(op)), op.name).not.toContain('"title"');
	});
});

describe("inputs", () => {
	async function accepted(op: (typeof SEARCH) | undefined, args: Json): Promise<unknown> {
		const result = await validateInput(op?.input as never, args);
		return result.ok ? result.data : `refused: ${result.message}`;
	}
	const readPage = webConnector().operations.find((op) => op.name === "read_page") as typeof SEARCH;

	test("search: a single line of text, trimmed; bounded limits; a country code; a freshness", async () => {
		expect(await accepted(SEARCH, { query: "  python  " })).toEqual({ query: "python", limit: 10, country: null, freshness: null, cursor: null });
		expect(await accepted(SEARCH, { query: "café 😀", limit: 20, country: " DE ", freshness: "year", cursor: " 2 " })).toEqual({
			query: "café 😀",
			limit: 20,
			country: "DE",
			freshness: "year",
			cursor: "2",
		});
		expect(await accepted(SEARCH, { query: ` ${"x".repeat(400)} ` })).toMatchObject({ query: "x".repeat(400) });
		for (const args of [
			{},
			{ query: "" },
			{ query: "   " },
			{ query: "a\tb" },
			{ query: "a\nb" },
			{ query: "x".repeat(401) },
			{ query: 5 },
			{ query: "q", limit: 0 },
			{ query: "q", limit: 21 },
			{ query: "q", limit: "5" },
			{ query: "q", limit: null },
			{ query: "q", country: "ch" },
			{ query: "q", country: "CHE" },
			{ query: "q", country: "İT" },
			{ query: "q", country: "" },
			{ query: "q", freshness: "hour" },
			{ query: "q", freshness: "Day" },
			{ query: "q", cursor: "c".repeat(301) },
			{ query: "q", page: 2 },
			[],
			"q",
		] as Json[]) {
			expect(await accepted(SEARCH, args), JSON.stringify(args)).toMatch(/^refused: Invalid arguments\./);
		}
	});

	test("read_page: an address of at most 2000 characters, a window into the text", async () => {
		expect(await accepted(readPage, { url: "  https://example.com/  " })).toEqual({ url: "https://example.com/", max_chars: 20_000, offset: 0 });
		expect(await accepted(readPage, { url: "u".repeat(2000), max_chars: 100_000, offset: 10_000_000 })).toMatchObject({ max_chars: 100_000, offset: 10_000_000 });
		for (const args of [
			{},
			{ url: "" },
			{ url: "   " },
			{ url: "u".repeat(2001) },
			{ url: 1 },
			{ url: "https://example.com/", max_chars: 499 },
			{ url: "https://example.com/", max_chars: 100_001 },
			{ url: "https://example.com/", max_chars: "600" },
			{ url: "https://example.com/", offset: -1 },
			{ url: "https://example.com/", offset: 10_000_001 },
			{ url: "https://example.com/", offset: null },
			{ url: "https://example.com/", extra: 1 },
		] as Json[]) {
			expect(await accepted(readPage, args), JSON.stringify(args)).toMatch(/^refused: Invalid arguments\./);
		}
	});

	test("search cursors name the pages Minerva hands out, 1 to 9, in ASCII digits", async () => {
		const prepared = async (cursor: string | null) => {
			try {
				await SEARCH.prepare(binding(WEB, null as never), { query: "q", limit: 10, country: null, freshness: null, cursor } as never);
				return "ok";
			} catch (error) {
				if (error instanceof OperationError) return `${error.code}: ${error.message}`;
				throw error;
			}
		};
		for (const cursor of [null, "", "1", "9", "01", "09"]) expect(await prepared(cursor), String(cursor)).toBe("ok");
		for (const cursor of ["0", "10", "1".repeat(40), "x", "-1", "+1", "1.0", " 1", "٣", "𝟙", "１", "²", "①"]) {
			expect(await prepared(cursor), cursor).toBe("INVALID_ARGUMENTS: Invalid arguments. cursor: unknown page");
		}
	});
});

describe("site names", () => {
	test("hosts are canonical public names", () => {
		expect(canonicalHost("Docs.Python.ORG")).toBe("docs.python.org");
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
			"docs.python.org.",
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

	test("site ids: a canonical host, or a pattern of a domain within a registrable domain, public and private suffixes alike", () => {
		for (const valid of ["python.org", "*.a.docs.python.org", "ada.github.io", "*.ada.github.io", "xn--bcher-kva.ch", "*.xn--bcher-kva.ch", "*.city.kobe.jp", "shop.example.co.uk", "*.example.co.uk"]) {
			expect(validId(valid), valid).toBe(true);
		}
		for (const invalid of ["*.kobe.jp", "*.", "**.python.org", "10.0.0.1", "bücher.ch", "site.example", "*.site.example", "python.org.", " python.org", ""]) {
			expect(validId(invalid), invalid).toBe(false);
		}
		// Names are shown for any id, valid or not.
		expect([name("*.city.kobe.jp"), name("*.*.python.org"), name("*."), name("*")]).toEqual([
			"city.kobe.jp, including subdomains",
			"*.python.org, including subdomains",
			", including subdomains",
			"*",
		]);
		expect(ancestors("x.y.city.kobe.jp")).toEqual(["*.x.y.city.kobe.jp", "*.y.city.kobe.jp", "*.city.kobe.jp"]);
		expect(choices("city.kobe.jp")).toEqual(["city.kobe.jp", "*.city.kobe.jp"]);
		expect(ancestors("a.b.c.d.e.f.example.com")).toHaveLength(7);
		// A name under a special-use suffix has no patterns and no registrable domain.
		expect([ancestors("a.site.example"), choices("a.site.example"), registrable("a.site.example")]).toEqual([[], ["a.site.example"], null]);
		expect([registrable("a.docs.python.org"), registrable("ada.github.io"), registrable("shop.example.co.uk"), registrable("city.kobe.jp")]).toEqual([
			"python.org",
			"ada.github.io",
			"example.co.uk",
			"city.kobe.jp",
		]);
	});

	test("addresses are parsed into what is requested", () => {
		const url = parseUrl("HTTPS://Docs.Python.org/3/library/os.html?q=a%20b#frag");
		expect([url.scheme, url.host, url.href]).toEqual(["https", "docs.python.org", "https://docs.python.org/3/library/os.html?q=a%20b"]);
		expect(parseUrl("http://example.com").href).toBe("http://example.com/");
		expect(parseUrl("https://example.com:443/x").href).toBe("https://example.com/x");
		expect(parseUrl("/next", url).href).toBe("https://docs.python.org/next");
		expect(parseUrl("//other.org/y", url).href).toBe("https://other.org/y");
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
			"https:example.com/",
			"https://example.com./",
			`https://${"a".repeat(2000)}.com/`,
		]) {
			expect(code(() => parseUrl(refused)), refused).toBe("INVALID_URL");
		}
	});

	test("only public addresses are opened: the platform refuses the rest, and the fetcher says so", async () => {
		// A Worker cannot pin the address it connects to, so the platform refuses private ones (the fake
		// models it) and the fetcher reports it.
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
		expect([got.form, got.text, got.url.href]).toEqual(["html", "<p>Hello</p>", "https://example.com/a?b=1"]);
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
		// The platform decides by the address it connects to (the fake: the first), so a private address is
		// never reached, but the public one of a name with both may be.
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
		expect([got.url.href, got.text]).toEqual(["https://example.com/new", "moved"]);
		const away = await fetcher(web).get(parseUrl("https://example.com/away"));
		expect(away instanceof Moved && away.target.href).toBe("https://evil.example.org/x");
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

	test("each hop requests the serialization whose host was authorized, and shows it, also after a redirect", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/b?q=%27x%27", { status: 302, headers: { location: "/c/%2e%2e/d?r='y'" } });
		web.page("example.com", "/d?r=%27y%27", { status: 200, headers: { "content-type": "text/plain" }, body: "here" });
		const got = await page(web, "https://example.com/a/../b?q='x'");
		expect([got.url.href, got.text]).toEqual(["https://example.com/d?r=%27y%27", "here"]);
		expect(web.requests.map((request) => request.url)).toEqual(["https://example.com/b?q=%27x%27", "https://example.com/d?r=%27y%27"]);
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
	test("search snippets lose their markup and references", () => {
		for (const [text, expected] of [
			["The &amp; official <strong>docs</strong>", "The & official docs"],
			["  a\n\tb c\u3000d  ", "a b c d"],
			["<b>unclosed", "unclosed"],
			["a < b > c", "a c"],
			["&lt;script&gt;", "<script>"],
			["&#x1F600; &notin; &notit; &amp", "😀 ∉ ¬it; &"],
			["", ""],
		]) {
			expect(plain(text as string), text).toBe(expected);
		}
	});

	test("bodies are read by their media type and charset: a byte order mark, the header, an HTML <meta>, else UTF-8", () => {
		const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
		const read = (body: string, contentType: string) => {
			try {
				return decode(bytes(body), contentType);
			} catch (error) {
				if (error instanceof OperationError) return error.code;
				throw error;
			}
		};
		const zurich = "Z\u00fcrich";
		const utf8 = "Z\u00c3\u00bcrich";
		for (const [body, contentType, expected] of [
			["<p>Hello</p>", "TEXT/HTML ; Charset=\"latin-1\"", ["text/html", "html", "<p>Hello</p>"]],
			[zurich, "text/plain; charset=latin-1", ["text/plain", "text", "Zürich"]],
			[zurich, "text/plain; charset = koi8-r", ["text/plain", "text", "ZЭrich"]],
			[zurich, "text/csv;charset=cp1252", ["text/csv", "text", "Zürich"]],
			// The charset parameter's name is ASCII: a long s does not spell it.
			[zurich, "text/markdown; char\u017fet=latin-1", ["text/markdown", "text", "Z\ufffdrich"]],
			// A charset the runtime lacks, or one that is not text, is read as UTF-8.
			[utf8, "text/plain; charset=bogus", ["text/plain", "text", "Zürich"]],
			[utf8, "text/plain; charset=rot13", ["text/plain", "text", "Zürich"]],
			[`<meta charset='iso-8859-1'><p>${zurich}</p>`, "text/html", ["text/html", "html", "<meta charset='iso-8859-1'><p>Zürich</p>"]],
			[`<META CHARSET = "windows-1252"><p>\u0080</p>`, "text/html", ["text/html", "html", '<META CHARSET = "windows-1252"><p>€</p>']],
			// The header wins over a <meta>, which only HTML is read for.
			[`<meta charset='iso-8859-1'>${utf8}`, "text/html; charset=utf-8", ["text/html", "html", "<meta charset='iso-8859-1'>Zürich"]],
			[`<meta charset='iso-8859-1'>${zurich}`, "text/plain", ["text/plain", "text", "<meta charset='iso-8859-1'>Z\ufffdrich"]],
			// A byte order mark wins over both, and is dropped.
			["\u00ef\u00bb\u00bfbom", "text/plain; charset=latin-1", ["text/plain", "text", "bom"]],
			["\u00ff\u00feu\u0000t\u0000f\u0000", "text/html; charset=latin-1", ["text/html", "html", "utf"]],
			["\u00fe\u00ff\u0000a", "application/json", ["application/json", "text", "a"]],
			["{}", "application/ld+json", ["application/ld+json", "text", "{}"]],
			["<svg/>", "image/svg+xml", ["image/svg+xml", "text", "<svg/>"]],
			["%PDF", "application/pdf", "UNSUPPORTED_CONTENT"],
			// Without a media type: HTML by its start, text unless it holds a NUL byte.
			["  \n<!DOCTYPE html><p>x</p>", "", ["", "html", "  \n<!DOCTYPE html><p>x</p>"]],
			["<HTML><p>x</p>", "  ", ["", "html", "<HTML><p>x</p>"]],
			["plain words", "", ["", "text", "plain words"]],
			["\u0000u\u0000t\u0000f", "", "UNSUPPORTED_CONTENT"],
			["\u00ff\u00feu\u0000", "", "UNSUPPORTED_CONTENT"],
		] as [string, string, unknown][]) {
			expect(read(body, contentType), `${JSON.stringify(body)} as ${contentType}`).toEqual(expected);
		}
	});

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

	test("active and embedded content stays out however the markup is written", () => {
		const base = "https://example.com/";
		for (const page of [
			"<SCRIPT>steal()</script>ok",
			"<script/>steal()</script>ok",
			"<style>p{}</style >ok",
			"<noembed><b>steal()</b></noembed>ok",
			"<svg><text>steal()</text></svg>ok",
			"<svg/>ok",
			"<!-- steal() -->ok<![CDATA[steal()]]>",
			"<template><p>steal()</p></template>ok",
		]) {
			expect(htmlToText(page, base)[0], page).toBe("ok");
		}
		expect(htmlToText("ok<script>steal()</script", base)[0]).toBe("ok");
		expect(htmlToText("ok<script>steal()</script steal()", base)[0]).toBe("ok");
		for (const href of ["&#x6a;avascript:steal()", "java&#9;script:steal()", " data:text/html,x", "//evil.example.org:99999/"]) {
			expect(htmlToText(`<a href="${href}">label</a>`, base)[0], href).toBe("label");
		}
		expect(htmlToText('<img src="https://evil.example.org/x.png"><image src="https://evil.example.org/y.png">', base)[0]).toBe("");
		// Without a base address (Gmail), only absolute links are kept.
		expect(htmlToText('<a href="/rel">a</a> <a href="https://example.com/x">b</a>')[0]).toBe("a [b](https://example.com/x)");
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

	test("an empty key is set: search is offered, then unavailable", async () => {
		const web = new FakeWeb();
		const run = await start(web, [["account", WEB, ["search"]]], { braveKey: "" });
		expect(run.tools).toEqual(["web_search"]);
		expect(await run.error("web_search", { query: "python" })).toEqual({ code: "SEARCH_UNAVAILABLE", message: "Web search is not set up on this Minerva instance." });
		expect(web.brave.requests).toEqual([]);
	});
});

describe("settings", () => {
	test("sites are found by address and named per domain", async () => {
		const web = new FakeWeb();
		const connector = webConnector({ braveKey: () => "test-key" });
		const site = (await catalogEntry(connector)).kinds.find((kind) => kind.id === "site");
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
		// A grant check (checkGrantEdit) names what is allowed with describe and refuses what it cannot name.
		const refused = ["*.org", "*.github.io", "localhost", "10.0.0.1", "Python.org", "*.*.python.org"];
		expect(await connector.describe?.(client, "site", ["*.python.org", ...refused])).toEqual({ "*.python.org": "python.org, including subdomains" });
		expect(web.sent).toEqual([]);
	});
});

describe("bodies", () => {
	const PAGE = new TextEncoder().encode(`<p>${"hello world ".repeat(20)}</p>`);
	const gzip = new Uint8Array(gzipSync(PAGE));
	const zlib = new Uint8Array(deflateSync(PAGE));
	const raw = new Uint8Array(deflateRawSync(PAGE));

	/** The body read from these chunks, as the fetcher reads it, or the error's code and message. */
	function read(encoding: string | null, ...chunks: Uint8Array[]): Uint8Array | string {
		try {
			const body = new Body(encoding);
			for (const chunk of chunks) body.feed(chunk);
			return body.bytes();
		} catch (error) {
			if (error instanceof OperationError) return `${error.code}: ${error.message}`;
			throw error;
		}
	}

	function changed(bytes: Uint8Array, at: number, value: number): Uint8Array {
		const copy = bytes.slice();
		copy[at < 0 ? copy.length + at : at] = value;
		return copy;
	}

	/** The bytes with one bit of the byte at `at` (from the end when negative) flipped. */
	function flipped(bytes: Uint8Array, at: number): Uint8Array {
		const copy = bytes.slice();
		const index = at < 0 ? copy.length + at : at;
		copy[index] = (copy[index] as number) ^ 1;
		return copy;
	}

	const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
	const text = (value: string) => new TextEncoder().encode(value);
	const DAMAGED = "UNSUPPORTED_CONTENT: This site sent a damaged page.";
	const ENCODING = "UNSUPPORTED_CONTENT: This site sent its page in an encoding Minerva cannot read.";
	const TOO_LARGE = `PAGE_TOO_LARGE: This page is larger than Minerva reads (${MAX_BODY} bytes).`;

	test("gzip and deflate read the same however the body is split", () => {
		// A gzip header with every optional field: FEXTRA, FNAME, FCOMMENT and its CRC (FHCRC).
		const fields = concat(Uint8Array.of(0x1f, 0x8b, 8, 0x1e, 0, 0, 0, 0, 0, 0xff, 2, 0, 0x78, 0x79), text("page.html\0c\0"));
		const headerCrc = crc32(fields) & 0xffff;
		const full = concat(fields, Uint8Array.of(headerCrc & 0xff, headerCrc >> 8), gzip.subarray(10));
		const wrongCrc = flipped(full, fields.length);
		for (const [encoding, body] of [
			["gzip", gzip],
			["gzip", full],
			["deflate", zlib],
		] as const) {
			for (let at = 0; at <= body.length; at++) expect(read(encoding, body.subarray(0, at), body.subarray(at)), `${encoding} at ${at}`).toEqual(PAGE);
		}
		for (let at = 0; at <= wrongCrc.length; at++) expect(read("gzip", wrongCrc.subarray(0, at), wrongCrc.subarray(at)), `wrong header CRC at ${at}`).toBe(DAMAGED);
		// Raw DEFLATE is recognised when zlib fails on the first chunk, so a first chunk of one byte is too little.
		for (let at = 2; at <= raw.length; at++) expect(read("deflate", raw.subarray(0, at), raw.subarray(at)), `raw at ${at}`).toEqual(PAGE);
		expect(read("deflate", raw.subarray(0, 1), raw.subarray(1))).toBe(DAMAGED);
	});

	test("one Content-Encoding is read, in any case, beside identity; others and stacks are refused", () => {
		for (const encoding of ["x-gzip", "GZIP", " gzip ", "gzip, identity", "identity, gzip"]) expect(read(encoding, gzip), encoding).toEqual(PAGE);
		for (const encoding of ["identity", "", null]) expect(read(encoding, PAGE), String(encoding)).toEqual(PAGE);
		for (const encoding of ["gzip, gzip", "gzip, br", "br", "compress", "zstd"]) expect(read(encoding, gzip), encoding).toBe(ENCODING);
	});

	test("damaged streams are refused; one cut short gives what was decoded; what follows the end is ignored", () => {
		const header = gzip.subarray(0, 10);
		const deflated = gzip.subarray(10, -8);
		const trailer = gzip.subarray(-8);
		// FEXTRA, FNAME and FCOMMENT, and the same with a wrong header CRC (FHCRC).
		const named = concat(changed(header, 3, 0x1c), Uint8Array.of(2, 0, 0x78, 0x79), text("page.html\0c\0"), deflated, trailer);
		const crc = concat(changed(header, 3, 0x1e), Uint8Array.of(2, 0, 0x78, 0x79), text("page.html\0c\0"), Uint8Array.of(0, 0), deflated, trailer);
		for (const [label, encoding, body, expected] of [
			["gzip with names", "gzip", named, PAGE],
			["gzip, wrong header CRC", "gzip", crc, DAMAGED],
			["gzip, wrong CRC-32", "gzip", flipped(gzip, -8), DAMAGED],
			["gzip, wrong length", "gzip", flipped(gzip, -4), DAMAGED],
			["gzip, reserved flags", "gzip", changed(gzip, 3, 0xe0), DAMAGED],
			["gzip, wrong magic", "gzip", changed(gzip, 1, 0x8c), DAMAGED],
			["gzip, wrong method", "gzip", changed(gzip, 2, 7), DAMAGED],
			["zlib sent as gzip", "gzip", zlib, DAMAGED],
			["text sent as gzip", "gzip", PAGE, DAMAGED],
			["gzip without its length", "gzip", gzip.subarray(0, -4), PAGE],
			["gzip header only", "gzip", gzip.subarray(0, 5), new Uint8Array()],
			["empty gzip", "gzip", new Uint8Array(), new Uint8Array()],
			["gzip, then a second member", "gzip", concat(gzip, gzipSync(text("second"))), PAGE],
			["gzip, then garbage", "gzip", concat(gzip, text("trailing garbage")), PAGE],
			["zlib, wrong Adler-32", "deflate", flipped(zlib, -1), DAMAGED],
			["zlib, wrong header", "deflate", concat(Uint8Array.of(0x78, 0xbb), raw), DAMAGED],
			["text sent as deflate", "deflate", PAGE, DAMAGED],
			["gzip sent as deflate", "deflate", gzip, DAMAGED],
			["zlib without its Adler-32", "deflate", zlib.subarray(0, -4), PAGE],
			["zlib header byte only", "deflate", zlib.subarray(0, 1), new Uint8Array()],
			["zlib, then garbage", "deflate", concat(zlib, text("trailing")), PAGE],
			["raw DEFLATE, then garbage", "deflate", concat(raw, text("trailing")), PAGE],
		] as [string, string, Uint8Array, Uint8Array | string][]) {
			expect(read(encoding, body), label).toEqual(expected);
		}
		const cut = read("gzip", gzip.subarray(0, 20)) as Uint8Array;
		expect(cut.length).toBeGreaterThan(0);
		expect(cut).toEqual(PAGE.subarray(0, cut.length));
		expect(read("gzip", new Uint8Array(), new Uint8Array())).toEqual(new Uint8Array());
	});

	test("a page may reach the cap exactly in every wrapper, in any pieces; one byte more is too large", () => {
		const exact = new Uint8Array(MAX_BODY);
		const over = new Uint8Array(MAX_BODY + 1);
		const pieces = (body: Uint8Array) => Array.from({ length: Math.ceil(body.length / 997) }, (_, i) => body.subarray(i * 997, (i + 1) * 997));
		for (const [encoding, compress] of [
			["gzip", gzipSync],
			["deflate", deflateSync],
			["deflate", deflateRawSync],
		] as const) {
			const fits = compress(exact);
			const tooBig = compress(over);
			expect((read(encoding, fits) as Uint8Array).length, compress.name).toBe(MAX_BODY);
			expect((read(encoding, ...pieces(fits)) as Uint8Array).length, compress.name).toBe(MAX_BODY);
			expect(read(encoding, tooBig), compress.name).toBe(TOO_LARGE);
			expect(read(encoding, ...pieces(tooBig)), compress.name).toBe(TOO_LARGE);
		}
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
			// that body reads as damaged.
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
		// The room is a hard limit: a page that fills it exactly still ends (zlib reads the trailer without
		// room to write), one byte more is left over and too large.
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
		// br is not read: the runtime would decode it before any cap.
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
		web.page("example.com", "/long", { status: 403, headers: { server: "cloudflare" }, body: `error code: 1003${" ".repeat(20_000)}` });
		web.page("example.com", "/other", { status: 403, headers: { server: "cloudflare" }, body: "error code: 1020" });
		web.page("example.com", "/limits", { status: 503, headers: { server: "cloudflare" }, body: "error code: 1102" });
		// The error page: only from `server: cloudflare`, as HTML, within what is read, with a code that means a private site.
		const page = (code: number) => refusalPage(code, "example.com");
		web.page("example.com", "/page-origin", { status: 403, headers: { "content-type": "text/html" }, body: page(1002) });
		web.page("example.com", "/page-as-text", { status: 403, headers: { server: "cloudflare", "content-type": "text/plain" }, body: page(1002) });
		web.page("example.com", "/page-long", { status: 403, headers: { server: "cloudflare", "content-type": "text/html" }, body: `${page(1002)}${" ".repeat(20_000)}` });
		web.page("example.com", "/page-other", { status: 403, headers: { server: "cloudflare", "content-type": "text/html" }, body: page(1020) });
		// An origin whose error body never comes is an error response, not a slow site.
		web.page("example.com", "/stalled", { status: 403, headers: { server: "cloudflare" }, body: stalled("error code: ") });
		for (const [target, status] of [
			["/origin-403", 403],
			["/long", 403],
			["/other", 403],
			["/limits", 503],
			["/page-origin", 403],
			["/page-as-text", 403],
			["/page-long", 403],
			["/page-other", 403],
			["/stalled", 403],
		] as const) {
			expect(await raised(fetcher(web).get(parseUrl(`https://example.com${target}`))), target).toMatchObject({
				code: "PAGE_ERROR",
				message: `The site answered with HTTP ${status}.`,
			});
		}
	});

	test("the platform's refusal is read in both its forms: the error page a request with an Accept header gets, and the text", async () => {
		const web = new FakeWeb();
		web.site("example.com");
		web.page("example.com", "/page", { status: 403, headers: { server: "cloudflare", "content-type": "text/html; charset=UTF-8" }, body: refusalPage(1002, "example.com") });
		web.page("example.com", "/text", { status: 403, headers: { server: "cloudflare", "content-type": "text/plain; charset=UTF-8" }, body: "error code: 1003" });
		for (const target of ["/page", "/text"]) {
			expect(await raised(fetcher(web).get(parseUrl(`https://example.com${target}`))), target).toMatchObject({
				code: "SITE_NOT_PUBLIC",
				message: "This site's name points to a private network, which Minerva does not open.",
			});
		}
		// The private names themselves get the page, since the connector's request has an Accept header.
		web.dns.set("private.example.com", ["10.0.0.7"]);
		expect(await acode(fetcher(web).get(parseUrl("https://private.example.com/")))).toBe("SITE_NOT_PUBLIC");
		expect(web.requests).toEqual([expect.objectContaining({ target: "/page" }), expect.objectContaining({ target: "/text" })]);
	});

	test("a refusal body that never comes ends with the fetch's total time, as the error response it is", async () => {
		// The response came in time, so the answer is PAGE_ERROR, not SITE_TIMEOUT.
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
		// Redirects and error pages leave their bodies unread: each is released, or it would hold one of the
		// invocation's six connections and a later fetch would wait for it.
		const left = (status: number, headers: Record<string, string> = {}): Served => ({
			status,
			headers: { "content-type": "text/html", ...headers },
			body: new ReadableStream({ pull: () => {}, cancel: () => void cancelled++ }),
		});
		web.page("example.com", "/here", () => left(301, { location: "/br" }));
		web.page("example.com", "/away", () => left(302, { location: "https://elsewhere.example.org/" }));
		web.page("example.com", "/missing", () => left(404));
		web.page("example.com", "/forbidden", () => left(403));
		web.page("example.com", "/partial", () => left(206));
		cancelled = 0;
		expect(await acode(fetcher(web).get(parseUrl("https://example.com/here")))).toBe("UNSUPPORTED_CONTENT");
		expect(await fetcher(web).get(parseUrl("https://example.com/away"))).toBeInstanceOf(Moved);
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/missing")))).toMatchObject({ code: "PAGE_ERROR", message: "The site answered with HTTP 404." });
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/forbidden")))).toMatchObject({ code: "PAGE_ERROR", message: "The site answered with HTTP 403." });
		expect(await raised(fetcher(web).get(parseUrl("https://example.com/partial")))).toMatchObject({ code: "PAGE_ERROR", message: "The site answered with HTTP 206, which has no page." });
		// The redirect's and the page it led to (br, unread), then one for each of the others.
		expect(cancelled).toBe(6);
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
