// The Atlassian base: what counts as an address to Atlassian (hidden when read, refused when written), the
// ADF reader and writer, sites and the JSON answers; the registry with the Jira and Confluence declarations,
// and their OAuth declaration as the catalog shows it.

import { describe, expect, test } from "vitest";
import { confluenceConnector } from "../../src/connectors/confluence/connector.ts";
import { jiraConnector } from "../../src/connectors/jira/connector.ts";
import * as adf from "../../src/connectors/atlassian/adf.ts";
import { Site, oauth } from "../../src/connectors/atlassian/index.ts";
import { ListingModel, PageModel } from "../../src/connectors/confluence/client.ts";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { CommentModel, IssueModel, JiraClient, ProjectModel } from "../../src/connectors/jira/client.ts";
import { offered } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import type { Json } from "../../src/lib/json.ts";
import { isPlainText } from "../../src/lib/text.ts";
import { catalogEntry } from "./catalog-support.ts";

function doc(...content: Json[]): Json {
	return { type: "doc", version: 1, content };
}

function paragraph(...content: Json[]): Json {
	return { type: "paragraph", content };
}

function text(value: string, href?: string): Json {
	return href === undefined ? { type: "text", text: value } : { type: "text", text: value, marks: [{ type: "link", attrs: { href } }] };
}

const SECRET = "SECRET merger";

/** Atlassian addresses in the spellings a browser or Atlassian's renderer would still follow. */
const ATLASSIAN_SPELLINGS = [
	"https://acme.atlassian.net/browse/FIN-1",
	"ACME.ATLASSIAN.NET/x",
	"https%3A%2F%2Facme%2Eatlassian%2Enet/browse/FIN-1",
	"%2561tlassian.net",
	"%252561tlassian.net",
	"acme&period;atlassian&period;net",
	"acme&#46;atlassian&#x2e;net",
	"ａｃｍｅ．ａｔｌａｓｓｉａｎ．ｎｅｔ",
	"acme。atlassian。net",
	"acme\u200b.atlassian.net",
	"acme\\.atlassian\\.net",
	"acme.atlass\u0130an.net",
	"acme.atlass\u0131an.net",
	"acme.atla\u017f\u017fian.net",
	"\ud800atlassian.net",
	"https://atlassian.net",
	"https://atlassian.com.example",
	"x.atlassian.netx",
	"jira.com/x",
	"j\u0131ra.com",
	"atlassian.design",
	"atl.so/x",
	"trello.com/b/x",
	"BITBUCKET.ORG",
	"bitbucket.org.example",
];

/** Text that names no Atlassian address. */
const OTHER_TEXT = [
	"plain words",
	"https://example.com/docs",
	"acme.example.com/x",
	"%25252561tlassian.net",
	"[Atlassian link] stays",
	"/browse/FIN-1",
	"mailto:ada@example.com",
	"emoji 😀 and e\u0301",
];

describe("addresses to Atlassian", () => {
	test("redact hides every word that names Atlassian, in any spelling", () => {
		for (const value of ATLASSIAN_SPELLINGS) expect(adf.redact(`see ${value} now`), value).toBe(`see ${adf.LINK} now`);
		for (const value of OTHER_TEXT) expect(adf.redact(value), value).toBe(value);
		expect(adf.redact("(https://example.com/x) and (acme.atlassian.net)")).toBe(`(https://example.com/x) and ${adf.LINK}`);
		// Browsers drop tabs and newlines inside an address, but they separate words here.
		expect(adf.redact("atl\tas\nsian.net")).toBe("atl\tas\nsian.net");
	});

	test("the connection's sites count as Atlassian, in any case and encoding", () => {
		const hosts = ["acme.example.com", "jira.acme.example"];
		for (const value of ["https://acme.example.com/browse/FIN-1", "ACME.example.COM", "https://JIRA.acme.example/x", "jira%2Eacme%2Eexample/x"]) {
			expect(adf.redact(value, hosts), value).toBe(adf.LINK);
			expect(adf.redact(value), value).toBe(value);
		}
		expect(adf.redact("example.com", hosts)).toBe("example.com");
		// An empty host names nothing.
		expect(adf.redact("plain words", [""])).toBe("plain words");
	});

	test("a link leads to Atlassian when it names it or is relative", () => {
		for (const value of [...ATLASSIAN_SPELLINGS, "/browse/FIN-1", "//evil.example/x", " //evil.example/x", "#fragment", "?q=1", "example.com", ":x", "", " ", "1http://example.com"]) {
			expect(adf.internal(value), JSON.stringify(value)).toBe(true);
		}
		// A scheme is ASCII as a browser reads it; a lookalike letter, an escape or a space in it, or a leading
		// character a browser does not strip, makes the address relative, even where NFKC would make it https.
		for (const value of ["\u0131ttps://example.com", "\u0130ttps://example.com", "http\u017f://example.com", "\uff48\uff54\uff54\uff50\uff53://example.com", "%68ttps://example.com", "h ttps://example.com", "\u3000https://example.com", "\ufeffhttps://example.com"]) {
			expect(adf.internal(value), JSON.stringify(value)).toBe(true);
		}
		for (const value of ["https://example.com/docs", "mailto:ada@example.com", "ftp+x.y-z://example.com", "https:", "\u001chttps://example.com\u001f", " https://example.com ", "ht\ttps://example.com", "javascript:alert(1)"]) {
			expect(adf.internal(value), JSON.stringify(value)).toBe(false);
		}
		expect(adf.internal("https://acme.example.com/x", ["acme.example.com"])).toBe(true);
	});

	test("written text may not name Atlassian or a connection's site", () => {
		for (const value of ATLASSIAN_SPELLINGS) expect(adf.namesNoAtlassian(`see ${value}`), value).toBe(false);
		expect(adf.namesNoAtlassian("atl\tas\nsian.net")).toBe(false);
		for (const value of [...OTHER_TEXT, "/browse/FIN-1", "jira%2Eacme%2Eexample/x"]) expect(adf.namesNoAtlassian(value), value).toBe(true);
		const hosts = ["acme.example.com", "jira.acme.example"];
		for (const value of ["see https://ACME.example.com/x", "jira%2Eacme%2Eexample/x", "jira&#46;acme.example"]) {
			expect(() => adf.checkHosts(value, hosts), value).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENTS", message: adf.SITE_ADDRESS }));
		}
		for (const value of ["example.com", "acme.atlassian.net", "plain words"]) expect(() => adf.checkHosts(value, hosts), value).not.toThrow();
		// Written text is plain: control characters other than tabs and newlines are refused.
		expect(["tabs\tand\r\nnewlines", "\u0007 bell", "a\u000bb", "x\u001cy"].map(isPlainText)).toEqual([true, false, false, false]);
	});
});

describe("ADF", () => {
	test("a date node's day, from milliseconds as a number or digits", () => {
		const days: [Json, string][] = [
			[1759276800000, "2025-10-01"],
			["1759276800000", "2025-10-01"],
			["-86400000", "1969-12-31"],
			[1.999, "1970-01-01"],
			[-1.5, "1969-12-31"],
			[253402300799999, "9999-12-31"],
			[-62135596800000, "0001-01-01"],
		];
		for (const [timestamp, day] of days) expect(adf.date(timestamp), JSON.stringify(timestamp)).toBe(day);
		for (const timestamp of [253402300800000, -62135596800001, 1e20, " 1 ", "+5", "1_000", "١٢", "1e3", "1.5", "0x10", "", null, true, [1], { a: 1 }]) {
			expect(adf.date(timestamp), JSON.stringify(timestamp)).toBe("[date]");
		}
	});

	test("links to Atlassian are hidden in any spelling", () => {
		const nodes = doc(
			paragraph(
				text(SECRET, "https%3A%2F%2Facme%2Eatlassian%2Enet/browse/FIN-1"),
				text(" "),
				text(SECRET, "https://acme.example.com/browse/FIN-1"),
				text(" "),
				text(SECRET, "/browse/FIN-1"),
				text(" "),
				text(SECRET, "//evil.example/x"),
				text(" "),
				// One link split across text nodes is one link.
				text("SECRET ", "https://acme.atlassian.net/x"),
				text("merger", "https://acme.atlassian.net/x"),
				text(" "),
				{ type: "text", text: SECRET, marks: [{ type: "link", attrs: { href: "https://ok.example" } }, { type: "link", attrs: { href: "https://ok.example" } }] },
				text(" "),
				text("plain https://acme.atlassian.net/browse/FIN-1 and acme.example.com/x"),
			),
			{ type: "blockCard", attrs: { url: "https://jira.com/x" } },
			{ type: "blockCard", attrs: { url: "https://example.org/page" } },
			{ type: "extension", attrs: { text: SECRET } },
			{ type: "somethingNew", content: [text(SECRET)] },
		);
		const shown = adf.read(nodes, ["acme.example.com"]);
		expect(shown).not.toContain(SECRET);
		expect(shown).not.toContain("merger");
		expect(shown).toBe(
			"[Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] " +
				"plain [Atlassian link] and [Atlassian link]\n" +
				"[Atlassian link]https://example.org/page[unsupported content][unsupported content]",
		);
	});

	test("structure is read, and reading stops at its limits", () => {
		const nodes = doc(
			{ type: "heading", content: [text("Title")] },
			{ type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("one"))] }] },
			{ type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("done")] }] },
			paragraph(
				{ type: "mention", attrs: { text: "@Grace" } },
				text(" on "),
				{ type: "date", attrs: { timestamp: "1759276800000" } },
				text(" "),
				{ type: "status", attrs: { text: "BLOCKED" } },
				{ type: "hardBreak" },
				{ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
			),
			{ type: "mediaSingle", content: [{ type: "media", attrs: { id: SECRET } }] },
		);
		expect(adf.read(nodes)).toBe("Title\n- one\n- [x] done\n@Grace on 2025-10-01 [BLOCKED]\n😄\n[attachment]");
		let deep: Json = text("bottom");
		for (let level = 0; level < 60; level++) deep = { type: "blockquote", content: [deep] };
		expect(adf.read(doc(deep))).toBe("[more content not shown]");
		expect(adf.read("not a document")).toBe("");
	});

	test("written ADF is literal text", () => {
		expect(adf.written("a\r\nb\n\n\nc")).toEqual(doc(paragraph(text("a"), { type: "hardBreak" }, text("b")), paragraph(text("c"))));
		expect(adf.written("  \n\n a \n \t \n b \r\r c\n")).toEqual(doc(paragraph(text("a ")), paragraph(text(" b ")), paragraph(text(" c"))));
		expect(adf.written("x\n\n\n\ny")).toEqual(doc(paragraph(text("x")), paragraph(text("y"))));
		for (const blank of ["", " ", "\u3000"]) expect(adf.written(blank)).toEqual(doc());
	});

	test("linked text counts toward the limits", () => {
		// The document and its paragraph are two nodes, so link n is node n + 3.
		const links = Array.from({ length: adf.MAX_NODES + 10 }, (_, n) => text(`w${n} `, `https://example.com/${n}`));
		const shown = adf.read(doc(paragraph(...links)));
		expect(shown.endsWith("[more content not shown]")).toBe(true);
		const last = adf.MAX_NODES - 3;
		expect(shown).toContain(`w${last} (https://example.com/${last})`);
		expect(shown).not.toContain(`w${last + 1} `);
		expect(shown).not.toContain(`/${last + 1})`);
		// A link at depth MAX_DEPTH + 1 is cut; one at MAX_DEPTH is shown.
		const nested = (levels: number): Json => {
			let node: Json = paragraph(text("w0 ", "https://example.com/0"));
			for (let level = 0; level < levels; level++) node = { type: "blockquote", content: [node] };
			return doc(node);
		};
		expect(adf.read(nested(adf.MAX_DEPTH - 1))).toBe("[more content not shown]");
		expect(adf.read(nested(adf.MAX_DEPTH - 2))).toBe("w0 (https://example.com/0)");
	});

	test("malformed nodes are skipped or shown as unsupported, never fail", () => {
		const nodes = doc(
			{ type: ["list"] },
			{ type: 5 },
			{ type: null },
			null,
			"a string",
			{ type: "listItem", content: "not a list" },
			{ type: "taskItem", attrs: "not attrs", content: [text("todo")] },
			paragraph({ type: "text", text: null }, { type: "text", text: ["x"] }, { type: "mention", attrs: { text: 5 } }),
			paragraph({ type: "text", text: SECRET, marks: [{ type: "link", attrs: { href: 5 } }] }),
			paragraph({ type: "text", text: SECRET, marks: [{ type: "link", attrs: { href: "https://a.example" } }, { type: "link", attrs: { href: "https://b.example" } }] }),
			{ type: "inlineCard", attrs: { url: null } },
		);
		expect(adf.read(nodes)).toBe(`${adf.UNSUPPORTED.repeat(3)}\n- - [ ] todo\n@[someone]\n${adf.LINK}\n${adf.LINK}\n${adf.LINK}`);
		expect(adf.read("not a document")).toBe("");
	});
});

describe("sites", () => {
	test("a site's host and label", () => {
		const cases: [{ name: string | null; url: string | null }, string | null, string][] = [
			[{ name: "Acme", url: "https://acme.atlassian.net" }, "acme.atlassian.net", "Acme (acme.atlassian.net)"],
			[{ name: "Acme", url: "https://ACME.atlassian.net///" }, "acme.atlassian.net", "Acme (acme.atlassian.net)"],
			[{ name: "acme.atlassian.net", url: "https://acme.atlassian.net" }, "acme.atlassian.net", "acme.atlassian.net"],
			[{ name: null, url: "https://acme.atlassian.net" }, "acme.atlassian.net", "acme.atlassian.net"],
			[{ name: "", url: null }, null, "x"],
			[{ name: "Acme", url: "https://xn--80ak6aa92e.example" }, "xn--80ak6aa92e.example", "Acme (xn--80ak6aa92e.example)"],
		];
		for (const [fields, host, label] of cases) {
			const site = new Site({ id: "x", ...fields, scopes: [] });
			expect([site.host, site.label], JSON.stringify(fields)).toEqual([host, label]);
		}
		// Only a bare https origin with a dotted host is used.
		for (const url of ["http://acme.atlassian.net", "https://acme", "https://acme.atlassian.net/wiki", "https://acme_x.atlassian.net", "https://acme.atlassian.net\n", "https://acme.atlassian.net:8443", ""]) {
			expect(new Site({ id: "x", name: "Acme", url, scopes: [] }).host, url).toBeNull();
		}
	});
});

describe("provider answers", () => {
	test("answers are UTF-8 JSON: a byte order mark is dropped, invalid bytes are an unexpected response", async () => {
		const answering = (bytes: Uint8Array) => new JiraClient("token", settingsIo(async () => new Response(bytes, { headers: { "content-type": "application/json" } })));
		const me = new TextEncoder().encode('{"account_id":"5b10","name":"Ada"}');
		expect(await answering(new Uint8Array([0xef, 0xbb, 0xbf, ...me])).me()).toEqual({ account_id: "5b10", name: "Ada", email: null });
		await expect(answering(new Uint8Array([...me.slice(0, -2), 0xff, 0x22, 0x7d])).me()).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		await expect(answering(new TextEncoder().encode("{broken")).me()).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
	});

	test("are read by their wire names; unknown fields are dropped", () => {
		const listing = ListingModel.parse({ results: [{ id: "1" }], _links: { next: "/wiki/api/v2/pages?cursor=abc", base: "x" }, extra: 1 });
		expect(listing).toEqual({ results: [{ id: "1" }], _links: { next: "/wiki/api/v2/pages?cursor=abc" } });
		const page = PageModel.parse({ id: "7", spaceId: "9", parentId: "3", createdAt: "2026-01-01T00:00:00Z", version: { number: 2 }, body: { atlas_doc_format: { value: "{}" } } });
		expect([page.spaceId, page.parentId, page.version?.number, page.body?.atlas_doc_format?.value]).toEqual(["9", "3", 2, "{}"]);
		const issue = IssueModel.parse({ id: "10", key: "ENG-1", fields: { status: { name: "Done", statusCategory: { key: "done" } }, assignee: { displayName: "Ada" } } });
		expect([issue.fields.status?.statusCategory?.key, issue.fields.assignee?.displayName]).toEqual(["done", "Ada"]);
		expect(ProjectModel.parse({ id: "1", key: "ENG", projectTypeKey: "software" }).projectTypeKey).toBe("software");
	});

	test("a value of another type is refused, not converted", () => {
		expect(ProjectModel.safeParse({ id: "1", key: "ENG", archived: "true" }).success).toBe(false);
		expect(ProjectModel.safeParse({ id: 1, key: "ENG" }).success).toBe(false);
		expect(PageModel.safeParse({ id: "7", version: { number: "2" } }).success).toBe(false);
		expect(CommentModel.safeParse({ id: "5", created: 5 }).success).toBe(false);
		expect(IssueModel.safeParse({ id: "10" }).success).toBe(false);
	});
});

describe("the declarations", () => {
	test("the registry accepts Jira and Confluence, and their fingerprints are printed", async () => {
		const registry = await Registry.create([jiraConnector(), confluenceConnector()]);
		const prints: string[] = [];
		for (const connector of registry.all()) {
			for (const op of connector.operations) {
				const contract = registry.contract(connector.slug, op.name);
				expect(contract).toMatch(/^[0-9a-f]{16}$/);
				prints.push(`${connector.slug}_${op.name} ${contract}`);
			}
		}
		console.log(`Atlassian fingerprints:\n${prints.join("\n")}`);
		expect(prints.map((line) => line.split(" ")[0])).toEqual([
			"jira_list_projects",
			"jira_search_issues",
			"jira_get_issue",
			"jira_add_comment",
			"jira_create_issue",
			"jira_transition_issue",
			"confluence_list_spaces",
			"confluence_search_pages",
			"confluence_get_page",
			"confluence_add_comment",
			"confluence_create_page",
		]);
		// The Worker's own registry serves both, with the same contracts.
		const served = await connectorRegistry();
		expect(CONNECTORS.map((connector) => connector.slug)).toEqual(expect.arrayContaining(["jira", "confluence"]));
		expect(served.contract("jira", "get_issue")).toBe(registry.contract("jira", "get_issue"));
		expect(served.contract("confluence", "create_page")).toBe(registry.contract("confluence", "create_page"));
	});

	test("Atlassian's OAuth: one app per connector, JSON token requests, no PKCE, audience and consent prompt", async () => {
		expect(jiraConnector().auth).toEqual({
			type: "oauth2",
			app: "jira",
			authorizeUrl: "https://auth.atlassian.com/authorize",
			tokenUrl: "https://auth.atlassian.com/oauth/token",
			scopes: ["offline_access", "read:me", "read:jira-work"],
			authorizeParams: [
				["audience", "api.atlassian.com"],
				["prompt", "consent"],
			],
			jsonBody: true,
			pkce: false,
		});
		expect(confluenceConnector().auth).toEqual({
			...oauth("confluence"),
			scopes: ["offline_access", "read:me", "read:space:confluence", "read:page:confluence", "read:comment:confluence", "read:content-details:confluence"],
		});
		for (const connector of [jiraConnector(), confluenceConnector()]) {
			expect(connector.manageLink?.()).toEqual(["Atlassian connected apps", "https://id.atlassian.com/manage-profile/apps"]);
			expect(connector.operations.every((op) => offered(connector, op))).toBe(true);
			expect(connector.browsable).toBeUndefined();
			// The client goes in the JSON body of a token request.
			expect((await catalogEntry(connector)).auth).toMatchObject({ tokenUrl: "https://auth.atlassian.com/oauth/token", clientAuth: "post", tokenBody: "json", pkce: false });
		}
	});
});
