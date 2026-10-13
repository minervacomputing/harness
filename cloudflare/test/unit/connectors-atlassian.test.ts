// The Atlassian base (backend/connectors/atlassian/): Python's string semantics the connectors rely on,
// the ADF reader and writer, and sites, against vectors from today's Python
// (test/fixtures/connectors/atlassian/generate.py), with the ADF cases of backend/tests/test_jira.py; the
// registry with the Jira and Confluence declarations; their OAuth declaration and refresh refusal.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { confluenceConnector } from "../../src/connectors/confluence/connector.ts";
import { jiraConnector } from "../../src/connectors/jira/connector.ts";
import * as adf from "../../src/connectors/atlassian/adf.ts";
import { Site, oauth } from "../../src/connectors/atlassian/index.ts";
import { ListingModel, PageModel } from "../../src/connectors/confluence/client.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { CommentModel, IssueModel, ProjectModel } from "../../src/connectors/jira/client.ts";
import { OperationError, offered } from "../../src/gateway/connector.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";
import { TextError } from "../../src/lib/text.ts";
import { changedOnPurpose } from "./changed.ts";
import { planRefresh } from "../../src/workspace/credentials.ts";

type Outcome = { value?: Json; error?: string; message?: string };

interface Vectors {
	unicode: { ignorecase: { [letter: string]: number[] } };
	adf: {
		hosts: string[][];
		read: { document: Json; results: ({ hosts: string[] } & Outcome)[] }[];
		redact: { text: string; results: Outcome[] }[];
		internal: { text: string; results: Outcome[] }[];
		check_hosts: { text: string; results: Outcome[] }[];
		check_written: ({ text: string } & Outcome)[];
		written: ({ text: string } & Outcome)[];
	};
	sites: { site: { id: string; name: string | null; url: string | null }; host: string | null; label: string }[];
}

const VECTORS = parseJson(readFileSync(new URL("../fixtures/connectors/atlassian/vectors.json", import.meta.url).pathname, "utf8")) as unknown as Vectors;

/** What a helper does, in the vectors' words. */
function outcome(run: () => Json | undefined | void): Outcome {
	try {
		const value = run();
		return { value: value === undefined ? null : value };
	} catch (error) {
		if (error instanceof OperationError) return { error: error.code, message: error.message };
		if (error instanceof TextError) return { error: "ValueError", message: error.message };
		if (error instanceof TypeError) return { error: "TypeError" };
		throw error;
	}
}

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

describe("patterns and parsing", () => {
	const unicode = VECTORS.unicode;

	test("re.IGNORECASE matches i with İ and ı, s with ſ and k with the Kelvin sign, as the patterns do", () => {
		expect(unicode.ignorecase.i).toEqual([0x130, 0x131]);
		expect(unicode.ignorecase.s).toEqual([0x17f]);
		expect(unicode.ignorecase.k).toEqual([0x212a]);
		const others = Object.entries(unicode.ignorecase).filter(([letter, found]) => !"isk".includes(letter) && found.length > 0);
		expect(others).toEqual([]);
	});

	test("an ADF date's timestamp, a number or digits in milliseconds", () => {
		expect([adf.date(1759276800000), adf.date("1759276800000"), adf.date(" -86400000 ")]).toEqual(["2025-10-01", "2025-10-01", "1969-12-31"]);
		for (const timestamp of ["١٢", "1_000", "1e3", "", null, true, 1e20]) expect(adf.date(timestamp), JSON.stringify(timestamp)).toBe("[date]");
	});

});

describe("ADF, against Python's adf.py", () => {
	test("read: hand-written and random documents", () => {
		for (const { document, results } of VECTORS.adf.read) {
			for (const { hosts, ...expected } of results) expect(outcome(() => adf.read(document, hosts)), JSON.stringify(document).slice(0, 200)).toEqual(expected);
		}
	});

	test("redact, internal and check_hosts, for every set of hosts", () => {
		const hosts = VECTORS.adf.hosts;
		const kept = (cases: { text: string; results: Outcome[] }[]) => cases.filter(({ text }) => !changedOnPurpose(text));
		for (const { text: value, results } of kept(VECTORS.adf.redact)) results.forEach((expected, index) => expect(outcome(() => adf.redact(value, hosts[index])), value).toEqual(expected));
		for (const { text: value, results } of kept(VECTORS.adf.internal)) results.forEach((expected, index) => expect(outcome(() => adf.internal(value, hosts[index])), value).toEqual(expected));
		for (const { text: value, results } of kept(VECTORS.adf.check_hosts)) {
			results.forEach((expected, index) => expect(outcome(() => adf.checkHosts(value, hosts[index] as string[])), value).toEqual(expected));
		}
	});

	test("check_written and written", () => {
		for (const { text: value, ...expected } of VECTORS.adf.check_written) expect(outcome(() => adf.checkWritten(value)), value).toEqual(expected);
		for (const { text: value, ...expected } of VECTORS.adf.written) expect(outcome(() => adf.written(value)), value).toEqual(expected);
	});

	// test_jira.py, the ADF cases.

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
		expect(adf.checkWritten("see https://example.com")).toBe("see https://example.com");
		for (const value of ["x trello.com/b", "atl.so/x", "BITBUCKET.ORG"]) expect(() => adf.checkWritten(value)).toThrow(TextError);
	});

	test("linked text counts toward the limits", () => {
		// Python's test lowers MAX_NODES to 10 and MAX_DEPTH to 1; here the limits are reached as they are. The
		// document and its paragraph are two nodes, so link n is node n + 3.
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

	test("a node whose type cannot be hashed fails as Python's does", () => {
		expect(() => adf.read(doc({ type: ["list"] }))).toThrow(TypeError);
		expect(adf.read(doc({ type: 5 }, { type: null }, { type: true }))).toBe("[unsupported content][unsupported content][unsupported content]");
	});
});

describe("sites", () => {
	test("hosts and labels, as Python's Site", () => {
		for (const { site, host, label } of VECTORS.sites) {
			const found = new Site({ ...site, scopes: [] });
			expect([found.host, found.label], JSON.stringify(site)).toEqual([host, label]);
		}
	});
});

describe("provider answers", () => {
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

	test("Atlassian's OAuth: one app per connector, JSON token requests, no PKCE, audience and consent prompt", () => {
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
		}
	});

	test("an expired Atlassian refresh token needs reconnecting: 403 with invalid_grant", async () => {
		const sent: { url: string; init: RequestInit }[] = [];
		const answer = (status: number, body: Json) => async (url: RequestInfo | URL, init?: RequestInit) => {
			sent.push({ url: String(url), init: init ?? {} });
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		};
		const deps = (fetch: typeof globalThis.fetch) => ({
			clients: { configured: () => ({ clientId: "id", clientSecret: "secret" }), stored: async () => null },
			siteUrl: "https://minerva.example",
			fetch,
			now: () => Date.UTC(2026, 9, 12),
			log: () => {},
		});
		const tokens = { kind: "oauth2", access_token: "old", refresh_token: "r1", scopes: ["offline_access", "read:me", "read:jira-work"], expires_at: 0 };
		const plan = await planRefresh(jiraConnector(), tokens, deps(answer(403, { error: "invalid_grant", error_description: "Unknown token." })), "c1");
		if (plan.kind !== "send") throw new Error("A refresh was expected");
		expect(await plan.send()).toEqual({ kind: "invalid" });
		expect(sent[0]?.url).toBe("https://auth.atlassian.com/oauth/token");
		expect(sent[0]?.init.body).toBe('{"client_id":"id","client_secret":"secret","grant_type":"refresh_token","refresh_token":"r1"}');
		// Another 403 leaves the connection as it is.
		const other = await planRefresh(jiraConnector(), tokens, deps(answer(403, { error: "forbidden" })), "c1");
		if (other.kind !== "send") throw new Error("A refresh was expected");
		expect(await other.send()).toMatchObject({ kind: "unavailable", message: "Jira could not refresh the connection." });
	});
});
