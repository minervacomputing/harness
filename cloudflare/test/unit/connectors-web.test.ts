// The Web connector against test/fixtures/connectors/web/fake-browser.ts, which answers as Browser Run's Quick Actions
// did when they were measured: the declaration and its pinned fingerprints, inputs, site names and patterns, what is
// sent to the browser and what its answers become, the run's cap, the log line, grants and an organization's list of
// domains, finding sites to allow, and the probe.

import { afterEach, describe, expect, test, vi } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { READ_PAGE, SITE, webConnector } from "../../src/connectors/web/connector.ts";
import { Browser, LIMITS, probeBrowser } from "../../src/connectors/web/render.ts";
import { OperationError, termsOf } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { CallIo, NotSent, ProgrammingError, RunBrowser, settingsIo } from "../../src/gateway/http.ts";
import { Registry, inputSchema, validate } from "../../src/gateway/registry.ts";
import type { ConnectionPolicy } from "../../src/gateway/tenancy.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { ancestors, canonicalHost, choices, name, parseUrl, registrable, validId } from "../../src/lib/sites.ts";
import type { ConnectionId } from "../../src/shared/rpc.ts";
import { type Answer, FakeBrowser, hangs, refused, rendered, sized, stalls } from "../fixtures/connectors/web/fake-browser.ts";
import { catalogEntry } from "./catalog-support.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

const WEB: ConnectionId = "0199a000-0000-7000-8000-0000000000f1";
const registry = await Registry.create([webConnector()]);
const saved = { ...LIMITS };

afterEach(() => {
	Object.assign(LIMITS, saved);
	vi.restoreAllMocks();
});

type Ok = Extract<ToolCallOutcome, { ok: true }>;

const RAN = "Its scripts may have run.";
const MOVED_NOTE = "This page moved to another address. Open redirect_to to follow it; that site needs its own permission.";
const OUTSIDE = { code: "POLICY_DENIED", message: "Your organization does not allow this domain." };

const noFetch: typeof fetch = () => Promise.reject(new Error("The Web connector fetched."));

function code(call: () => unknown): string {
	try {
		call();
	} catch (error) {
		if (error instanceof OperationError) return error.code;
		throw error;
	}
	throw new Error("Nothing was raised.");
}

function items(outcome: Ok): { [key: string]: Json }[] {
	return outcome.result.items;
}

async function record(run: Scenario, args: Json): Promise<{ [key: string]: Json }> {
	const [item, ...rest] = items(await run.ok("web_read_page", args));
	if (item === undefined || rest.length > 0) throw new Error("A read gives one record.");
	return item;
}

function start(browser: FakeBrowser | null, grants: [kind: string, id: string, actions: string[]][], options: { ceiling?: GrantRow[]; policy?: ConnectionPolicy } = {}): Promise<Scenario> {
	return Scenario.start({
		connectors: [webConnector()],
		registry,
		connections: [{ id: WEB, provider: "web", payload: { kind: "builtin" } }],
		user: userGrants(WEB, SITE, {}, grants),
		ceiling: options.ceiling ?? [],
		fetch: noFetch,
		...(browser === null ? {} : { browser: new RunBrowser(browser) }),
		...(options.policy ? { policy: options.policy } : {}),
	});
}

async function opening(answer: Answer): Promise<[Scenario, FakeBrowser]> {
	const browser = new FakeBrowser();
	browser.answer = answer;
	return [await start(browser, [[SITE, "example.com", ["browse"]]]), browser];
}

function ceiling(resourceId: string, effect: GrantRow["effect"], actions: string[] = ["browse"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: WEB, kind: SITE, resourceId, resourceName: "", actions, effect };
}

function listing(domains: string[]): ConnectionPolicy {
	return { revision: 1, connectors: [{ provider: "web", tenants: domains }] };
}

async function logged(run: () => Promise<unknown>): Promise<{ lines: { [key: string]: Json }[]; text: string }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	await run();
	const written = log.mock.calls.map((args) => args.map(String).join(" "));
	log.mockRestore();
	const lines = written.flatMap((line) => {
		if (!line.startsWith("{")) return [];
		const parsed = JSON.parse(line) as { [key: string]: Json };
		return parsed.message === "web browser call" ? [parsed] : [];
	});
	return { lines, text: written.join("\n") };
}

describe("the declaration", () => {
	test("the registry accepts it, and its fingerprints are pinned", () => {
		expect(() => validate([webConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(webConnector().operations.map((op) => [op.name, registry.contract("web", op.name)]));
		console.log("web fingerprints", fingerprints);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		expect(fingerprints).toEqual({ read_page: "8b03d8d96e5a7d64" });
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("web");
		const served = await connectorRegistry();
		for (const op of served.get("web").operations) expect(served.contract("web", op.name)).toBe(registry.contract("web", op.name));
	});

	test("one kind of sites to open in the browser, builtin auth, and a tenant per domain", async () => {
		const connector = webConnector();
		const entry = await catalogEntry(connector);
		expect(entry.kinds.map((kind) => [kind.id, kind.actions, kind.wildcard, kind.hierarchical, kind.listed, kind.note])).toEqual([
			[
				"site",
				["browse"],
				true,
				true,
				false,
				"Search for a domain or paste an address to add it. Open in browser loads pages in Cloudflare's browser and runs their scripts, which can act on the site as a visit would, such as following a sign-in link. Agents can also send information in the addresses they open, to these sites and to wherever they redirect, so allow only sites you trust. A block on a domain wins over access to a wider one.",
			],
		]);
		expect(entry.actions).toEqual([{ id: "browse", label: "Open in browser", requires: null }]);
		expect(entry.tenancy).toEqual({ kind: "resource", label: "domain" });
		expect(entry.operations).toEqual([{ name: "read_page", title: "Read a web page", needs: [{ kind: "site", action: "browse" }], consent: null, mutates: false, offered: true }]);
		expect(connector.auth).toEqual({ type: "builtin" });
		expect([connector.browsable ?? [], connector.manageLink]).toEqual([[], undefined]);
		expect(connector.operations.map((op) => [op.name, termsOf(op).outputAction, termsOf(op).paginated])).toEqual([["read_page", "browse", false]]);
		for (const op of connector.operations) expect(JSON.stringify(inputSchema(op)), op.name).not.toContain('"title"');
	});
});

describe("inputs", () => {
	async function accepted(args: Json): Promise<unknown> {
		const result = await validateInput(READ_PAGE.input as never, args);
		return result.ok ? result.data : `refused: ${result.message}`;
	}

	test("read_page: an address of at most 2000 characters, a window into the text", async () => {
		expect(await accepted({ url: "  https://example.com/  " })).toEqual({ url: "https://example.com/", max_chars: 20_000, offset: 0 });
		expect(await accepted({ url: "u".repeat(2000), max_chars: 100_000, offset: 10_000_000 })).toMatchObject({ max_chars: 100_000, offset: 10_000_000 });
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
			expect(await accepted(args), JSON.stringify(args)).toMatch(/^refused: Invalid arguments\./);
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

	test("a host that is a public suffix itself is an address and an id, with no domain", () => {
		expect([parseUrl("https://co.uk/").host, validId("co.uk"), registrable("co.uk"), registrable("github.io")]).toEqual(["co.uk", true, null, null]);
	});
});

describe("what is sent", () => {
	test("read_page's options, exactly", async () => {
		const [run, browser] = await opening(rendered("# Hello"));
		await run.ok("web_read_page", { url: "https://example.com/a?b=1" });
		expect(browser.calls).toEqual([
			{
				action: "markdown",
				options: {
					url: "https://example.com/a?b=1",
					browser: "kitesurf",
					allowRequestPattern: ["^https://example\\.com/", "^blob:https://example\\.com/", "^data:"],
					rejectResourceTypes: ["image", "media", "font"],
					cacheTTL: 0,
					userAgent: "Minerva/0.1 (governed AI agent; reads a page when a user's agent asks)",
					gotoOptions: { waitUntil: "networkidle2", timeout: 8000 },
					actionTimeout: 3000,
					bestAttempt: true,
				},
			},
		]);
	});

	test("an http address opens as https on its host, with its fragment", async () => {
		const [run, browser] = await opening(rendered("# Inbox"));
		expect((await record(run, { url: "http://Example.com/app#/inbox?x=1" })).url).toBe("https://example.com/app");
		expect(browser.urls()).toEqual(["https://example.com/app#/inbox?x=1"]);
	});

	test("an address Minerva does not open, or a site the user did not allow, sends nothing", async () => {
		const [run, browser] = await opening(rendered("# Hello"));
		for (const url of ["https://127.0.0.1/", "http://localhost/", "https://[::1]/", "https://example.com:8443/", "ftp://example.com/"]) {
			expect(await run.code("web_read_page", { url }), url).toBe("INVALID_URL");
		}
		expect(await run.error("web_read_page", { url: "https://co.uk/" })).toEqual({ code: "INVALID_URL", message: "This address has no domain Minerva can match." });
		for (const url of ["https://example.org/", "https://docs.example.com/", "https://example.com.evil.example.org/"]) {
			expect(await run.code("web_read_page", { url }), url).toBe("POLICY_DENIED");
		}
		expect(browser.calls).toEqual([]);
	});

	test("the page may load only from its own host over https", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Bücher");
		const run = await start(browser, [[SITE, "*.xn--bcher-kva.ch", ["browse"]]]);
		await run.ok("web_read_page", { url: "https://my-shop.xn--bcher-kva.ch/?next=https://evil.example.org/" });
		const patterns = browser.calls[0]?.options.allowRequestPattern ?? [];
		expect(patterns).toEqual(["^https://my-shop\\.xn--bcher-kva\\.ch/", "^blob:https://my-shop\\.xn--bcher-kva\\.ch/", "^data:"]);
		const loads = (url: string) => patterns.some((pattern) => new RegExp(pattern).test(url));
		for (const url of ["https://my-shop.xn--bcher-kva.ch/app.js", "blob:https://my-shop.xn--bcher-kva.ch/3f2a", "data:text/css,p{}"]) expect(loads(url), url).toBe(true);
		for (const url of [
			"http://my-shop.xn--bcher-kva.ch/app.js",
			"https://my-shop.xn--bcher-kva.ch:8443/app.js",
			"https://my-shop.xn--bcher-kva.ch.evil.example.org/",
			"https://my-shopxxn--bcher-kva.ch/",
			"https://xn--bcher-kva.ch/",
			"https://cdn.my-shop.xn--bcher-kva.ch/",
			"https://evil.example.org/?u=https://my-shop.xn--bcher-kva.ch/",
			"blob:https://evil.example.org/3f2a",
			"wss://my-shop.xn--bcher-kva.ch/",
		]) {
			expect(loads(url), url).toBe(false);
		}
	});
});

describe("what the answer becomes", () => {
	test("a page: its Markdown without front matter, its title and type, read in parts that each open it again", async () => {
		const text = `# Hello\n\n${"x".repeat(1200)}`;
		const [run, browser] = await opening(rendered(`---\ntitle: Hello\n---\n\n${text}`, { title: "Hello", headers: { "content-type": "text/html; charset=utf-8" } }));
		expect(await record(run, { url: "https://example.com/", max_chars: 500 })).toEqual({
			url: "https://example.com/",
			title: "Hello",
			content_type: "text/html",
			text: text.slice(0, 500),
			offset: 0,
			total_chars: 1209,
			next_offset: 500,
		});
		expect(await record(run, { url: "https://example.com/", max_chars: 1000, offset: 500 })).toMatchObject({ text: text.slice(500), offset: 500, next_offset: null });
		expect(browser.calls).toHaveLength(2);
	});

	test("a page without a title or a type", async () => {
		const [run] = await opening(rendered("Just text.", { title: "", headers: {} }));
		expect(await record(run, { url: "https://example.com/" })).toMatchObject({ title: null, content_type: null, text: "Just text." });
	});

	test("a text file is the payload Browser Run fences, exactly; a page keeps its fences", async () => {
		const README = "# Title\n\n```js\nrun();\n```\n\nEnd.";
		for (const [type, result, text] of [
			["application/json", 'Pretty-print\n\n```\n{"a": [1, 2]}\n```\n', '{"a": [1, 2]}'],
			["application/ld+json; charset=utf-8", '```json\n{"@type": "Thing"}\n```', '{"@type": "Thing"}'],
			["text/markdown", `\`\`\`\`markdown\n${README}\n\`\`\`\``, README],
			["text/csv", "```\na,b\n1,2\n```", "a,b\n1,2"],
			["text/xml", "```xml\n<a>1</a>\n```\n\n", "<a>1</a>"],
			["text/plain", "Plain words.", "Plain words."],
			["text/plain", "```\nunclosed", "```\nunclosed"],
			["text/html", "Text.\n\n```\ncode\n```", "Text.\n\n```\ncode\n```"],
		] as const) {
			const [run] = await opening(rendered(result, { headers: { "content-type": type } }));
			expect((await record(run, { url: "https://example.com/data" })).text, `${type}: ${result}`).toBe(text);
		}
	});

	test("a page that ended on another host or on http is withheld for the model to open; one on its host is that page", async () => {
		const moved = (finalUrl: string | undefined, redirectChain?: { url: string; status: number }[]) =>
			rendered("# Secret", { finalUrl, ...(redirectChain ? { redirectChain } : {}) });
		for (const [answer, redirectTo] of [
			[moved("https://evil.example.org/?d=1"), "https://evil.example.org/?d=1"],
			[moved("http://example.com/"), "http://example.com/"],
			[moved("https://www.example.com/"), "https://www.example.com/"],
			[
				moved("https://example.com/back", [
					{ url: "https://example.com/", status: 302 },
					{ url: "https://sso.example.net/login?next=x", status: 302 },
				]),
				"https://sso.example.net/login?next=x",
			],
		] as const) {
			const [run] = await opening(answer);
			expect(await record(run, { url: "https://example.com/" }), redirectTo).toEqual({ url: "https://example.com/", redirect_to: redirectTo, note: MOVED_NOTE });
		}
		const [run] = await opening(moved("https://example.com/docs/next", [{ url: "https://example.com/docs", status: 301 }]));
		expect(await record(run, { url: "https://example.com/docs" })).toMatchObject({ url: "https://example.com/docs/next", text: "# Secret" });
	});

	test("a page with no address Minerva opens has failed", async () => {
		for (const answer of [
			rendered("# Hello", { finalUrl: undefined }),
			rendered("", { finalUrl: "about:blank" }),
			rendered("This site can't be reached", { finalUrl: "chrome-error://chromewebdata/" }),
			rendered("# Hello", { redirectChain: [{ url: "about:blank", status: 302 }] }),
		]) {
			const [run] = await opening(answer);
			expect(await run.error("web_read_page", { url: "https://example.com/" })).toEqual({ code: "PAGE_ERROR", message: `Minerva's browser could not open this page. ${RAN}` });
		}
	});

	test("each failure, with its code and message", async () => {
		const failures: [Answer, string, string][] = [
			[rendered("Bad certificate", { status: 526 }), "PAGE_ERROR", "This site's certificate is not valid."],
			[rendered("Not here", { status: 404 }), "PAGE_ERROR", "The site answered with HTTP 404."],
			[rendered("Down", { status: 500 }), "PAGE_ERROR", "The site answered with HTTP 500."],
			[rendered("", { status: 204 }), "PAGE_ERROR", "The site answered with HTTP 204, which has no page."],
			[rendered("Moved", { status: 301 }), "PAGE_ERROR", "The site answered with HTTP 301, which has no page."],
			[rendered("", { headers: { "content-type": "application/pdf" } }), "UNSUPPORTED_CONTENT", "Minerva cannot read application/pdf pages yet."],
			[rendered("", { headers: {}, finalUrl: undefined }), "UNSUPPORTED_CONTENT", "Minerva cannot read this kind of file yet."],
			[rendered("", { headers: {} }), "UNSUPPORTED_CONTENT", "Minerva cannot read this kind of file yet."],
			[rendered("", { status: 404, headers: {}, finalUrl: undefined }), "PAGE_ERROR", "The site answered with HTTP 404."],
			[rendered("", { status: 500, headers: {}, finalUrl: undefined }), "PAGE_ERROR", "The site answered with HTTP 500."],
			[refused(429, [{ code: 1, message: "Rate limit exceeded" }]), "BROWSER_BUSY", "Minerva's browser is busy. Try again in a minute."],
			[refused(503, []), "BROWSER_BUSY", "Minerva's browser is busy. Try again in a minute."],
			[refused(422, [{ code: 2012, message: "Conversion failed" }]), "PAGE_ERROR", "Minerva's browser could not turn this page into text."],
			[refused(422, [{ code: 2001, message: "Invalid" }]), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[refused(400, [{ message: "Bad request" }]), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[refused(500, []), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[() => new Response("<html>Bad gateway</html>", { status: 502 }), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[() => new Response("{not json"), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[() => Response.json({ success: false, errors: [] }), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[() => Response.json({ success: true, result: "# Hello" }), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[() => Promise.reject(new Error("Network connection lost.")), "PAGE_ERROR", "Minerva's browser could not open this page."],
			[sized(8 * 1024 * 1024 + 1), "PAGE_TOO_LARGE", "This page is larger than Minerva reads."],
			[rendered("é".repeat(1.5 * 1024 * 1024 + 1)), "PAGE_TOO_LARGE", "This page is larger than Minerva reads."],
		];
		for (const [answer, failure, message] of failures) {
			const [run] = await opening(answer);
			expect(await run.error("web_read_page", { url: "https://example.com/" }), message).toEqual({ code: failure, message: `${message} ${RAN}` });
		}
		const [run] = await opening(rendered("é".repeat(1.5 * 1024 * 1024)));
		expect((await record(run, { url: "https://example.com/", max_chars: 500 })).total_chars).toBe(1.5 * 1024 * 1024);
	});

	test("the engine stops waiting at its limit, also for a body that stalls", async () => {
		LIMITS.waitMs = 50;
		for (const answer of [hangs, stalls]) {
			const [run, browser] = await opening(answer);
			expect(await run.error("web_read_page", { url: "https://example.com/" })).toEqual({ code: "SITE_TIMEOUT", message: `This site took too long to open. ${RAN}` });
			expect(browser.calls).toHaveLength(1);
		}
	});

	test("without a browser, nothing is sent", async () => {
		const run = await start(null, [[SITE, "example.com", ["browse"]]]);
		expect(run.tools).toEqual(["web_read_page"]);
		expect(await run.error("web_read_page", { url: "https://example.com/" })).toEqual({ code: "BROWSER_UNAVAILABLE", message: "Minerva's browser is not available in this build." });
	});

	test("an io that refuses the call: NotSent and ProgrammingError pass as they are, and nothing is sent", async () => {
		const browser = new FakeBrowser();
		const visit = { url: parseUrl("https://example.com/"), withFragment: "https://example.com/" };
		const revoked = new CallIo({ fetch: noFetch, now: () => 0, admits: () => false, browser: new RunBrowser(browser) });
		await expect(new Browser(revoked).read(visit)).rejects.toBeInstanceOf(NotSent);
		const closed = new CallIo({ fetch: noFetch, now: () => 0, admits: () => true, browser: new RunBrowser(browser) });
		closed.close();
		await expect(new Browser(closed).read(visit)).rejects.toBeInstanceOf(ProgrammingError);
		expect(browser.calls).toEqual([]);
	});
});

describe("the run's cap", () => {
	test("a run sends 100 browser calls, then refuses the next without sending it; another executor starts at 0", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Hello");
		let run = await start(browser, [[SITE, "example.com", ["browse"]]]);
		const { lines } = await logged(async () => {
			for (let i = 0; i < 100; i++) await run.ok("web_read_page", { url: `https://example.com/${i}` });
			expect(await run.error("web_read_page", { url: "https://example.com/" })).toEqual({ code: "LIMIT_REACHED", message: "This run has opened as many pages as it may." });
		});
		expect(browser.calls).toHaveLength(100);
		expect(lines.at(-1)).toMatchObject({ outcome: "capped", status: null, code: null, browserMs: null });
		run = await start(browser, [[SITE, "example.com", ["browse"]]]);
		await run.ok("web_read_page", { url: "https://example.com/" });
		expect(browser.calls).toHaveLength(101);
	});
});

describe("the log line", () => {
	test("one per call, with its outcome, and nothing of the address", async () => {
		const SECRET = "https://example.com/inbox?token=hunter2";
		const leak = { message: `Failed at ${SECRET}`, detail: SECRET, path: SECRET };
		const leaky = [{ ...leak, code: 7 }];
		const cases: [Answer, { [key: string]: Json }][] = [
			[rendered("# Hello"), { outcome: "ok", status: 200, code: null, browserMs: 412 }],
			[rendered("# Hello", { finalUrl: "https://evil.example.org/?token=hunter2" }), { outcome: "moved", status: 200, code: null, browserMs: 412 }],
			[rendered("Not here", { status: 404 }), { outcome: "site_status", status: 404, code: null, browserMs: 412 }],
			[refused(429, leaky), { outcome: "busy", status: null, code: 7, browserMs: 412 }],
			[refused(422, [{ ...leak, code: 2012 }]), { outcome: "failed", status: null, code: 2012, browserMs: 412 }],
			[refused(500, leaky), { outcome: "failed", status: null, code: 7, browserMs: null }],
			[hangs, { outcome: "timeout", status: null, code: null, browserMs: null }],
			[sized(8 * 1024 * 1024 + 1), { outcome: "too_large", status: null, code: null, browserMs: null }],
			[rendered("", { headers: { "content-type": "application/pdf" } }), { outcome: "unsupported", status: 200, code: null, browserMs: 412 }],
			[() => Promise.reject(new Error(`Could not open ${SECRET}`)), { outcome: "failed", status: null, code: null, browserMs: null }],
		];
		LIMITS.waitMs = 50;
		for (const [answer, line] of cases) {
			const [run] = await opening(answer);
			const { lines, text } = await logged(() => run.call("web_read_page", { url: SECRET }));
			expect(lines, String(line.outcome)).toEqual([{ message: "web browser call", operation: "read_page", ...line, ms: expect.any(Number) }]);
			for (const part of ["example.com", "evil.example.org", "inbox", "hunter2"]) expect(text, `${line.outcome}: ${part}`).not.toContain(part);
		}
	});

	test("none for a call that was never sent", async () => {
		const run = await start(null, [[SITE, "example.com", ["browse"]]]);
		expect((await logged(() => run.call("web_read_page", { url: "https://example.com/" }))).lines).toEqual([]);
	});
});

describe("grants", () => {
	test("read alone opens nothing; browse opens the site", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Hello");
		let run = await start(browser, [[SITE, "*", ["read"]]]);
		expect(run.tools).toEqual([]);
		expect(await run.code("web_read_page", { url: "https://example.com/" })).toBe("UNKNOWN_OPERATION");
		run = await start(browser, [[SITE, "example.com", ["read", "browse"]]]);
		expect(run.tools).toEqual(["web_read_page"]);
		expect((await record(run, { url: "https://example.com/" })).text).toBe("# Hello");
		expect(browser.calls).toHaveLength(1);
	});

	test("a domain covers its subdomains and nothing else", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Python");
		const run = await start(browser, [[SITE, "*.python.org", ["browse"]]]);
		for (const url of ["https://python.org/", "https://docs.python.org/3/"]) expect((await record(run, { url })).url, url).toBe(url);
		for (const url of ["https://python.org.evil.example.org/", "https://pypi.org/"]) expect(await run.code("web_read_page", { url }), url).toBe("POLICY_DENIED");
		expect(browser.calls).toHaveLength(2);
	});

	test("a block on a domain wins over access to every site", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Docs");
		const run = await start(browser, [[SITE, "*", ["browse"]]], { ceiling: [ceiling("*.docs.python.org", "deny")] });
		for (const url of ["https://docs.python.org/", "https://a.docs.python.org/"]) expect(await run.code("web_read_page", { url }), url).toBe("POLICY_DENIED");
		expect(browser.calls).toEqual([]);
		await run.ok("web_read_page", { url: "https://python.org/" });
		expect(browser.calls).toHaveLength(1);
	});
});

describe("the organization's list of domains", () => {
	test("a site's tenant is its registrable domain", async () => {
		const connector = webConnector();
		const client = connector.client("", settingsIo(noFetch));
		if (connector.tenancy.kind !== "resource") throw new Error("Web has a tenant per resource.");
		expect(await connector.tenancy.tenants(client, SITE, ["en.wikipedia.org", "*.wikipedia.org", "wikipedia.org", "*.city.kobe.jp", "shop.example.co.uk", "co.uk"])).toEqual({
			"en.wikipedia.org": "wikipedia.org",
			"*.wikipedia.org": "wikipedia.org",
			"wikipedia.org": "wikipedia.org",
			"*.city.kobe.jp": "city.kobe.jp",
			"shop.example.co.uk": "example.co.uk",
		});
	});

	test("under a list, a site of another domain is refused before anything is sent, whatever the grants allow", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Wikipedia");
		const run = await start(browser, [[SITE, "*", ["browse"]]], { policy: listing(["wikipedia.org"]) });
		expect(run.snapshot.tenants).toEqual({ [WEB]: ["wikipedia.org"] });
		for (const url of ["https://en.wikipedia.org/wiki/Owl", "https://wikipedia.org/"]) expect((await record(run, { url })).url, url).toBe(url);
		for (const url of ["https://example.com/", "https://wikipedia.org.evil.example.org/"]) expect(await run.error("web_read_page", { url }), url).toEqual(OUTSIDE);
		expect(browser.urls()).toEqual(["https://en.wikipedia.org/wiki/Owl", "https://wikipedia.org/"]);
	});

	test("a policy that offers Web on any domain limits nothing; one that leaves Web out offers no tool", async () => {
		const browser = new FakeBrowser();
		browser.answer = rendered("# Hello");
		let run = await start(browser, [[SITE, "*", ["browse"]]], { policy: { revision: 1, connectors: [{ provider: "web", tenants: null }] } });
		await run.ok("web_read_page", { url: "https://example.com/" });
		run = await start(browser, [[SITE, "*", ["browse"]]], { policy: { revision: 1, connectors: [] } });
		expect(run.tools).toEqual([]);
		expect(browser.calls).toHaveLength(1);
	});
});

describe("settings", () => {
	test("sites are found by address, named, and placed in their domain", async () => {
		const connector = webConnector();
		const client = connector.client("", settingsIo(noFetch));
		const discover = (query: string | null) => connector.discover(client, SITE, { query, cursor: null });
		expect((await discover(null)).items).toEqual([]);
		expect((await discover("https://Docs.Python.org/3/")).items).toEqual([
			{ id: "docs.python.org", name: "docs.python.org", tenant: "python.org" },
			{ id: "*.docs.python.org", name: "docs.python.org, including subdomains", tenant: "python.org" },
			{ id: "*.python.org", name: "python.org, including subdomains", tenant: "python.org" },
		]);
		expect((await discover(" docs.python.org/3/x ")).items.map((item) => item.id)).toEqual(["docs.python.org", "*.docs.python.org", "*.python.org"]);
		for (const query of ["co.uk", "https://co.uk/", "github.io"]) expect((await discover(query)).items, query).toEqual([]);
		await expect(discover("http://10.0.0.1/")).rejects.toMatchObject({ code: "INVALID_URL" });
		const refusedIds = ["*.org", "*.github.io", "co.uk", "github.io", "localhost", "10.0.0.1", "Python.org", "*.*.python.org"];
		expect(await connector.describe(client, SITE, ["*.python.org", "ada.github.io", ...refusedIds])).toEqual({
			"*.python.org": "python.org, including subdomains",
			"ada.github.io": "ada.github.io",
		});
	});
});

describe("the probe", () => {
	test("two fixed calls through the binding, and null without one", async () => {
		expect(await probeBrowser(undefined)).toBeNull();
		const browser = new FakeBrowser();
		browser.answer = (call) => rendered(call.options.addScriptTag ? "# Example Domain\n\nminerva-probe-ran example.com:read" : "# Example Domain")(call);
		expect(await probeBrowser(browser)).toEqual({
			page: { answered: 200, status: 200, chars: 16, finalUrl: true, browserMs: true, ms: expect.any(Number) },
			boundary: { answered: 200, ran: true, sameHost: "read", ms: expect.any(Number) },
		});
		const [page, boundary] = browser.calls;
		expect(browser.urls()).toEqual(["https://example.com/", "https://example.com/"]);
		const read = {
			url: "https://example.com/",
			browser: "kitesurf",
			allowRequestPattern: ["^https://example\\.com/", "^blob:https://example\\.com/", "^data:"],
			rejectResourceTypes: ["image", "media", "font"],
			cacheTTL: 0,
			userAgent: "Minerva/0.1 (governed AI agent; reads a page when a user's agent asks)",
			gotoOptions: { waitUntil: "networkidle2", timeout: 8000 },
			actionTimeout: 3000,
			bestAttempt: true,
		};
		expect(page?.options).toEqual(read);
		expect(boundary?.options).toEqual({ ...read, addScriptTag: [{ content: expect.any(String) }], waitForTimeout: 3000 });
		const script = boundary?.options.addScriptTag?.[0]?.content ?? "";
		for (const part of ['document.body.append("minerva-probe-ran")', 'fetch("https://example.com/")', 'text.includes("Example Domain")']) expect(script, part).toContain(part);
		expect(script).not.toContain("example.org");
	});

	test("a call that fails, or is not answered within the wait, is reported, not thrown", async () => {
		LIMITS.waitMs = 50;
		for (const answer of [() => Promise.reject(new Error("Network connection lost.")), hangs, stalls]) {
			const browser = new FakeBrowser();
			browser.answer = answer;
			expect(await probeBrowser(browser)).toEqual({
				page: { answered: null, status: null, chars: 0, finalUrl: false, browserMs: false, ms: expect.any(Number) },
				boundary: { answered: null, ran: false, sameHost: null, ms: expect.any(Number) },
			});
			expect(browser.calls).toHaveLength(2);
		}
	});
});
