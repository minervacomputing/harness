// backend/tests/test_notion.py, case by case: the Notion connector against an in-memory Notion API behind
// an injected `fetch` (FakeNotion, as the Python test serves it through httpx.MockTransport), and runs
// through the executor (executor-fakes.ts `Scenario`, which is connector_runs.py's claimed run). Then what
// the port adds: the declaration as the registry takes it, with its fingerprints, and a few cases the
// Python test leaves to the code (paging, size limits, data source choice).

import { afterEach, describe, expect, test } from "vitest";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { MAX_MARKDOWN_BYTES, NOTION_VERSION } from "../../src/connectors/notion/client.ts";
import { notionConnector } from "../../src/connectors/notion/connector.ts";
import { SYNCED_HIDDEN, planEdits, redact, writtenRefusal } from "../../src/connectors/notion/markdown.ts";
import { canonical, objectId } from "../../src/connectors/notion/pages.ts";
import { checkFilter, readable, writable } from "../../src/connectors/notion/properties.ts";
import { OperationError, offered, termsOf } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry, fingerprint } from "../../src/gateway/registry.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { tokenBody, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { Scenario, jsonResponse, userGrants } from "./executor-fakes.ts";

const NAMES = [
	"workspace",
	"home",
	"private",
	"projects",
	"source",
	"row1",
	"row2",
	"column_list",
	"column",
	"in_column",
	"orphan",
	"ghost",
	"linked",
	"synced",
	"stray",
] as const;
type Name = (typeof NAMES)[number];

/** Python's `str(UUID(int=n))`. */
function uuid(n: number): string {
	const h = n.toString(16).padStart(32, "0");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ID = Object.fromEntries(NAMES.map((name, i) => [name, uuid(i + 1)])) as { [name in Name]: string };
const NAME = new Map<string, string>(NAMES.map((name) => [ID[name], name]));
const BOT = uuid(999);
const NOTION = "0199a000-0000-7000-8000-0000000000e1";
const PAGE = "page";

function url(name: Name): string {
	return `https://www.notion.so/${name}-${ID[name].replaceAll("-", "")}`;
}

function text(value: string): JsonObject[] {
	return [{ type: "text", plain_text: value, text: { content: value } }];
}

function titleProperty(value: string): JsonObject {
	return { id: "title", type: "title", title: text(value) };
}

function page(name: Name, parent: JsonObject, title: string, properties: JsonObject = {}): JsonObject {
	return {
		object: "page",
		id: ID[name],
		parent,
		url: url(name),
		in_trash: false,
		created_time: "2026-09-01T00:00:00.000Z",
		last_edited_time: "2026-09-02T00:00:00.000Z",
		properties: { [Object.keys(properties).length ? "Name" : "title"]: titleProperty(title), ...properties },
	};
}

function inPage(name: Name): JsonObject {
	return { type: "page_id", page_id: ID[name] };
}

const IN_SOURCE: JsonObject = { type: "data_source_id", data_source_id: ID.source, database_id: ID.projects };
const SCHEMA: JsonObject = {
	Name: { id: "title", type: "title", title: {} },
	Status: { id: "st", type: "status", status: { options: [{ name: "Todo" }, { name: "Done" }] } },
	Tags: { id: "tg", type: "multi_select", multi_select: { options: [{ name: "a" }, { name: "b" }] } },
	Due: { id: "du", type: "date", date: {} },
	Budget: { id: "bu", type: "formula", formula: { expression: "secret" } },
	Owner: { id: "pp", type: "people", people: {} },
	Related: { id: "rl", type: "relation", relation: {} },
};

function row(name: Name, title: string, status: string): JsonObject {
	return page(name, IN_SOURCE, title, {
		Status: { id: "st", type: "status", status: { name: status } },
		Budget: { id: "bu", type: "formula", formula: { type: "number", number: 1000 } },
		Owner: { id: "pp", type: "people", people: [{ id: "u1", name: "Grace" }] },
	});
}

interface Sent {
	method: string;
	path: string;
	body: string;
}

type Handle = (request: Sent) => Response;

/**
 * The Notion API (test_notion.py `FakeNotion`). Workspace: Home (Private, Projects database with rows row1
 * and row2, a column holding in_column, a linked view of Projects, and a page showing synced content).
 * Shared without its parent: orphan.
 */
class FakeNotion {
	pages: { [id: string]: JsonObject };
	databases: { [id: string]: JsonObject };
	sources: { [id: string]: JsonObject };
	blocks: { [id: string]: JsonObject };
	markdown: { [id: string]: string };
	comments: JsonObject[];
	readonly requests: Sent[] = [];
	readonly writes: [method: string, path: string, body: Json][] = [];
	/** Requests without the pinned Notion-Version or the bearer token (the Python fake asserts both). */
	readonly problems: string[] = [];
	hook: ((request: Sent) => void) | null = null;
	created = 0;

	constructor() {
		const homeMarkdown = [
			"# Home",
			"Intro line",
			`<page url="${url("private")}">Private plans</page>`,
			`<database url="${url("projects")}">Projects</database>`,
			"Repeated",
			"middle",
			"Repeated",
			"End",
		].join("\n");
		this.pages = {
			[ID.home]: page("home", { type: "workspace", workspace: true }, "Home"),
			[ID.private]: page("private", inPage("home"), "Private plans"),
			[ID.row1]: row("row1", "Launch", "Todo"),
			[ID.row2]: row("row2", "Secret launch", "Done"),
			[ID.in_column]: page("in_column", { type: "block_id", block_id: ID.column }, "In column"),
			[ID.orphan]: page("orphan", inPage("ghost"), "Orphan"),
			[ID.synced]: page("synced", inPage("home"), "Synced"),
		};
		this.databases = {
			[ID.projects]: {
				object: "database",
				id: ID.projects,
				parent: inPage("home"),
				title: text("Projects"),
				url: url("projects"),
				data_sources: [{ id: ID.source, name: "Projects" }],
			},
			[ID.linked]: {
				object: "database",
				id: ID.linked,
				parent: inPage("home"),
				title: text("Linked projects"),
				url: url("linked"),
				data_sources: [{ id: ID.source, name: "Projects" }],
			},
		};
		this.sources = {
			[ID.source]: {
				object: "data_source",
				id: ID.source,
				parent: { type: "database_id", database_id: ID.projects },
				title: text("Projects"),
				properties: SCHEMA,
			},
		};
		this.blocks = {
			[ID.column]: { object: "block", id: ID.column, parent: { type: "block_id", block_id: ID.column_list } },
			[ID.column_list]: { object: "block", id: ID.column_list, parent: inPage("home") },
		};
		this.markdown = {
			[ID.home]: homeMarkdown,
			[ID.private]: "Top secret",
			[ID.row1]: "Row body",
			[ID.row2]: "Secret row body",
			[ID.in_column]: "Column text",
			[ID.orphan]: "Orphan text",
			[ID.synced]: `Before\n<synced_block_reference url="${url("private")}">\nTop secret\n</synced_block_reference>\nAfter`,
		};
		this.comments = [
			{ id: "c1", discussion_id: "d1", parent: inPage("home"), rich_text: text("Nice"), created_by: { id: "u1" } },
			{ id: "c2", discussion_id: "d2", parent: { type: "block_id", block_id: ID.column }, rich_text: text("On a block") },
		];
	}

	#error(status: number, code: string): Response {
		return jsonResponse(status, { object: "error", status, code, message: "x" });
	}

	#search(body: JsonObject): JsonObject[] {
		const query = String(body.query ?? "").toLowerCase();
		const titleOf = (item: JsonObject) => {
			const properties = item.properties as { [name: string]: JsonObject };
			const title = (properties.Name ?? properties.title) as JsonObject;
			return ((title.title as JsonObject[])[0] as JsonObject).plain_text as string;
		};
		const found = Object.values(this.pages).filter((item) => titleOf(item).toLowerCase().includes(query));
		const sources = Object.values(this.sources).filter((source) => (((source.title as JsonObject[])[0] as JsonObject).plain_text as string).toLowerCase().includes(query));
		return [...found, ...sources];
	}

	#paged(items: JsonObject[], body: JsonObject): Response {
		const start = Number(String(body.start_cursor || "c0").replace(/^c/, ""));
		const end = start + (body.page_size as number);
		const more = end < items.length;
		return jsonResponse(200, { results: items.slice(start, end), has_more: more, next_cursor: more ? `c${end}` : null });
	}

	#create(body: JsonObject): Response {
		this.created += 1;
		const properties = body.properties as { [name: string]: JsonObject };
		for (const value of Object.values(properties)) {
			for (const item of (value.title as JsonObject[] | undefined) ?? []) item.plain_text = (item.text as JsonObject).content as string;
		}
		const id = uuid(500 + this.created);
		let parent = body.parent as JsonObject;
		if ("data_source_id" in parent) {
			const source = this.sources[parent.data_source_id as string] as JsonObject;
			parent = { ...parent, type: "data_source_id", database_id: (source.parent as JsonObject).database_id as string };
		} else {
			parent = { type: "page_id", ...parent };
		}
		const created: JsonObject = {
			object: "page",
			id,
			parent,
			url: `https://www.notion.so/${id.replaceAll("-", "")}`,
			properties: Object.fromEntries(
				Object.entries(properties).map(([name, value]) => [name, { type: Object.keys(value).find((key) => key !== "id") as string, ...value }]),
			),
		};
		this.pages[id] = created;
		this.markdown[id] = (body.markdown as string | undefined) ?? "";
		return jsonResponse(200, created);
	}

	#updateMarkdown(pageId: string, body: JsonObject): Response {
		let markdown = this.markdown[pageId] as string;
		if (body.type === "insert_content") markdown += `\n${(body.insert_content as JsonObject).content as string}`;
		else {
			for (const update of (body.update_content as JsonObject).content_updates as JsonObject[]) {
				const old = update.old_str as string;
				if (markdown.split(old).length - 1 !== 1) return this.#error(400, "validation_error");
				markdown = markdown.split(old).join(update.new_str as string);
			}
		}
		this.markdown[pageId] = markdown;
		return jsonResponse(200, { object: "page_markdown", id: pageId, markdown });
	}

	/** The fake's routes (test_notion.py `FakeNotion.handler`); replaced by a test to refuse one request. */
	handle: Handle = (request) => {
		const body = request.body ? (parseJson(request.body) as JsonObject) : {};
		const parts = request.path.split("/").slice(2);
		const [first, id, rest] = parts;
		const method = request.method;
		const one = parts.length === 2;
		const has = (table: { [id: string]: unknown }, key: string | undefined) => key !== undefined && Object.hasOwn(table, key);
		if (method === "GET" && first === "users" && id === "me" && one) {
			return jsonResponse(200, { object: "user", id: BOT, type: "bot", bot: { workspace_id: ID.workspace, workspace_name: "Acme" } });
		}
		if (method === "GET" && first === "pages" && one) {
			if (has(this.databases, id)) return this.#error(400, "validation_error");
			if (has(this.pages, id)) return jsonResponse(200, this.pages[id as string]);
			return this.#error(404, "object_not_found");
		}
		if (method === "GET" && first === "pages" && rest === "markdown" && parts.length === 3 && has(this.markdown, id)) {
			return jsonResponse(200, { object: "page_markdown", id, markdown: this.markdown[id as string] });
		}
		if (method === "PATCH" && first === "pages" && rest === "markdown" && parts.length === 3 && has(this.markdown, id)) return this.#updateMarkdown(id as string, body);
		if (method === "PATCH" && first === "pages" && one && has(this.pages, id)) {
			const target = this.pages[id as string] as JsonObject;
			const properties = target.properties as { [name: string]: JsonObject };
			for (const [name, value] of Object.entries(body.properties as { [name: string]: JsonObject })) properties[name] = { ...(properties[name] ?? {}), ...value };
			return jsonResponse(200, target);
		}
		if (method === "POST" && first === "pages" && parts.length === 1) return this.#create(body);
		if (method === "GET" && first === "databases" && one) {
			if (has(this.pages, id)) return this.#error(400, "validation_error");
			if (has(this.databases, id)) return jsonResponse(200, this.databases[id as string]);
			return this.#error(404, "object_not_found");
		}
		if (method === "GET" && first === "data_sources" && one && has(this.sources, id)) return jsonResponse(200, this.sources[id as string]);
		if (method === "POST" && first === "data_sources" && rest === "query" && parts.length === 3 && has(this.sources, id)) {
			// Everything with a data source parent, so the connector must pick out its own rows.
			const rows = Object.values(this.pages).filter((item) => "data_source_id" in (item.parent as JsonObject));
			return this.#paged(rows, body);
		}
		if (method === "GET" && first === "blocks" && one && has(this.blocks, id)) return jsonResponse(200, this.blocks[id as string]);
		if (method === "POST" && first === "search" && parts.length === 1) return this.#paged(this.#search(body), body);
		if (method === "GET" && first === "comments" && parts.length === 1) return jsonResponse(200, { results: this.comments, has_more: false });
		if (method === "POST" && first === "comments" && parts.length === 1) {
			return jsonResponse(200, { id: "c9", discussion_id: "d9", parent: { type: "page_id", ...(body.parent as JsonObject) }, rich_text: text(body.markdown as string) });
		}
		return this.#error(404, "object_not_found");
	};

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const sent: Sent = { method: request.method, path: new URL(request.url).pathname, body: await request.text() };
		this.requests.push(sent);
		this.hook?.(sent);
		if (request.headers.get("Notion-Version") !== NOTION_VERSION) this.problems.push(`${sent.method} ${sent.path} without Notion-Version`);
		if (request.headers.get("Authorization") !== "Bearer token") this.problems.push(`${sent.method} ${sent.path} without the token`);
		if ((sent.method === "PATCH" || sent.method === "POST") && !sent.path.endsWith("/search") && !sent.path.endsWith("/query")) {
			this.writes.push([sent.method, sent.path, parseJson(sent.body)]);
		}
		return this.handle(sent);
	};

	client() {
		return notionConnector().client("token", settingsIo(this.fetch));
	}
}

const fakes: FakeNotion[] = [];

function fakeNotion(): FakeNotion {
	const notion = new FakeNotion();
	fakes.push(notion);
	return notion;
}

afterEach(() => {
	for (const notion of fakes.splice(0)) expect(notion.problems).toEqual([]);
});

function grantsOn(grants: { [name: string]: string[] }): { [id: string]: string[] } {
	return Object.fromEntries(Object.entries(grants).map(([name, actions]) => [ID[name as Name] ?? name, actions]));
}

function deny(name: Name, actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: NOTION, kind: PAGE, resourceId: ID[name], resourceName: "", actions: [...actions].sort(), effect: "deny" };
}

/** Starts a run for an agent with the user's Notion connection, holding `grants` (test_notion.py `start`). */
function start(notion: FakeNotion, grants: { [name: string]: string[] }, options: { ceiling?: GrantRow[]; maxLookups?: number } = {}): Promise<Scenario> {
	return Scenario.start({
		connectors: [notionConnector(options.maxLookups === undefined ? {} : { maxLookups: options.maxLookups })],
		connections: [{ id: NOTION, provider: "notion", payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: [] } }],
		user: userGrants(NOTION, PAGE, grantsOn(grants)),
		ceiling: options.ceiling ?? [],
		fetch: notion.fetch,
	});
}

function names(outcome: { result: { items: { [key: string]: Json }[] } }): string[] {
	return outcome.result.items.map((item) => NAME.get(item.id as string) ?? (item.id as string));
}

function refused(run: () => unknown): OperationError {
	try {
		run();
	} catch (error) {
		if (error instanceof OperationError) return error;
		throw error;
	}
	throw new Error("not refused");
}

describe("ids and links", () => {
	test("ids are canonical and links are parsed", () => {
		const plain = "0000000000000000000000000000000a";
		expect(canonical(plain)).toBe("00000000-0000-0000-0000-00000000000a");
		expect(canonical(plain.toUpperCase())).toBe(canonical(plain));
		expect(canonical("nope")).toBeNull();
		for (const value of [plain, `https://www.notion.so/acme/Plan-${plain}`, `https://notion.so/Plan-${plain}?pvs=4`, `https://acme.notion.site/${plain}`]) {
			expect(objectId(value)).toBe(canonical(plain));
		}
		for (const value of [`https://evil.example/${plain}`, `http://www.notion.so/${plain}`, "https://www.notion.so/x"]) expect(objectId(value)).toBeNull();
	});
});

describe("page text", () => {
	test("markdown hides other pages", () => {
		const notion = new FakeNotion();
		const shown = redact(notion.markdown[ID.home] as string);
		expect(shown).not.toContain("Private plans");
		expect(shown).not.toContain("Projects");
		// Notion addresses carry the page's title; they are shortened to its id.
		expect(shown).toContain(`<page url="https://www.notion.so/${ID.private.replaceAll("-", "")}"></page>`);
		expect(redact(`[x](https://acme.notion.site/Secret-deal-${"a".repeat(32)}?pvs=4)`)).toBe(`[x](https://www.notion.so/${"a".repeat(32)})`);
		const synced = redact(notion.markdown[ID.synced] as string);
		expect(synced).not.toContain("Top secret");
		expect(synced).toContain(SYNCED_HIDDEN);
		expect(redact("<synced_block_reference url='x'>\nleft open")).toBe(`<synced_block_reference>${SYNCED_HIDDEN}</synced_block_reference>`);
		expect(redact('a <mention-page url="u">Secret</mention-page> b')).toBe('a <mention-page url="u"></mention-page> b');
	});

	test("redaction fails closed", () => {
		const longTitle = "x".repeat(5000);
		expect(redact(`<page url="u">${longTitle}</page> after`)).toBe('<page url="u"></page> after');
		expect(redact('<mention-page url="u" title="Secret">\nSecret\n</mention-page>')).toBe('<mention-page url="u"></mention-page>');
		// A tag left open hides the rest of the page.
		expect(redact("a <page>Secret\nmore")).toBe("a <page></page>");
		// Any whitespace or control character ends a titled tag's name.
		for (const separator of ["\u0085", "\u001f", "\ufeff", "\u00a0"]) {
			expect(redact(`<page${separator}url="u">Secret</page> after`), JSON.stringify(separator)).toBe('<page url="u"></page> after');
		}
		// Synced content may contain its own closing tag as text.
		const synced = "Mine\n<synced_block_reference url='x'>\n```xml\n</synced_block_reference>\n```\nSecret acquisition plan\n</synced_block_reference>\nAfter";
		const shown = redact(synced);
		expect(shown).not.toContain("Secret");
		expect(shown.startsWith("Mine\n")).toBe(true);
		expect(shown.endsWith("\nAfter")).toBe(true);
	});

	test.each([
		"![x](https://evil.example/p.png)",
		'<page url="https://www.notion.so/x">Moved</page>',
		"<DATABASE>x</DATABASE>",
		'<synced_block_reference url="https://www.notion.so/x"></synced_block_reference>',
		'<mention-user url="user://1"/>',
		'<video src="https://evil.example/v.mp4"></video>',
		'<callout icon="x" src="https://evil.example/">hi</callout>',
		'<mention-page url="https://evil.example/x">t</mention-page>',
		"<embed>x</embed>",
	])("written text may only add words: %j", (value) => {
		expect(writtenRefusal(value)).not.toBeNull();
	});

	test("written text allows plain markdown and Notion mentions", () => {
		for (const value of [
			"# Title\n- [link](https://example.com)\n<callout>Note</callout>",
			'<mention-page url="https://www.notion.so/x-0000000000000000000000000000000a"/>',
			"a < b and c > d",
		]) {
			expect(writtenRefusal(value)).toBeNull();
		}
	});

	test("edits are anchored to whole visible lines", () => {
		const markdown = new FakeNotion().markdown[ID.home] as string;
		expect(planEdits(markdown, [["Intro", "Opening"]])).toEqual([{ old_str: "\nIntro line\n", new_str: "\nOpening line\n" }]);
		// "Repeated" is twice in the page: an edit there widens until its lines are unique.
		expect(refused(() => planEdits(markdown, [["Repeated", "x"]])).code).toBe("EDIT_NOT_APPLIED");
		const [widened] = planEdits(markdown, [["Repeated\nEnd", "Done\nEnd"]]);
		expect(widened).toEqual({ old_str: "\nRepeated\nEnd", new_str: "\nDone\nEnd" });
		// Titles the agent was not shown never match, and lines linking to child pages are not edited.
		for (const old of ["Private plans", "Projects</database>", "</page>"]) expect(refused(() => planEdits(markdown, [[old, "x"]])).code).toBe("EDIT_NOT_APPLIED");
		// Edits apply in order.
		const [, second] = planEdits(markdown, [
			["Intro", "Opening"],
			["Opening", "Start"],
		]);
		expect(second?.old_str).toBe("\nOpening line\n");
	});

	test.each([
		// Joining the agent's text with the page's into an image.
		["Start\nX[caption](https://evil.example/p.png)\nEnd", "X", "!"],
		// A tag the page shows as text, completed on the next line.
		["Start\nA\nsrc=https://evil.example/p.png>\nEnd", "A", "<img"],
		// Removing a code fence turns what it shows as code into markup.
		['Start\n```xml\n<img src="https://evil.example/p.png">\n```\nEnd', "```xml", "Code:"],
		// Unpairing backticks.
		["Start\nsee `a\nb` here\nEnd", "see `a", "see a"],
		// Lines that already hold content Minerva does not write.
		["Start\nText ![i](https://example.com/i.png)\nEnd", "Text", "Words"],
	])("edits cannot make markup from page text: %j", (markdown, old, replacement) => {
		expect(refused(() => planEdits(markdown, [[old, replacement]])).code).toBe("EDIT_NOT_APPLIED");
	});

	test("edits may write inline code and keep fences", () => {
		const markdown = "Start\n```py\nx = 1\n```\nEnd";
		expect(planEdits(markdown, [["x = 1", "x = 2"]])[0]?.new_str).toBe("\nx = 2\n");
		expect(planEdits(markdown, [["End", "Use `x` here"]])[0]?.new_str).toBe("\nUse `x` here");
	});
});

describe("properties", () => {
	test("property values are checked against the schema", () => {
		const converted = writable(SCHEMA, { Name: "x", Status: "Done", Tags: ["a"], Due: "2026-10-01" });
		expect(converted.Status).toEqual({ status: { name: "Done" } });
		expect(converted.Due).toEqual({ date: { start: "2026-10-01" } });
		for (const values of [{ Status: "Shipped" }, { Tags: ["a", "a"] }, { Due: "tomorrow" }, { Owner: ["u1"] }, { Related: [] }, { Budget: 1 }, { Missing: 1 }, { Name: 3 }] as JsonObject[]) {
			expect(refused(() => writable(SCHEMA, values)).code, JSON.stringify(values)).toBe("INVALID_ARGUMENTS");
		}
		// Notion reads property keys as names or ids, so a name that is another property's id is refused.
		const tricky = { ...SCHEMA, bu: { id: "zz", type: "number", number: {} } };
		expect(refused(() => writable(tricky, { bu: 1 }))).toBeInstanceOf(OperationError);
	});

	test("malformed properties are skipped and truncation is shown", () => {
		// The Python case also has a key that is not a string (1), which JSON cannot carry.
		expect(readable({ X: { type: [] }, Y: [] })).toEqual({});
		expect(writable({ Name: { id: [], type: "title" } }, { Name: "x" })).toEqual({ Name: { title: [{ type: "text", text: { content: "x" } }] } });
		expect(readable({ Related: { type: "relation", relation: [{ id: "a" }], has_more: true } })).toEqual({ Related: { items: ["a"], more: true } });
		// A row's editor may not be allowed to read its database, which lists the options.
		expect(refused(() => writable(SCHEMA, { Status: "Shipped" })).message).not.toContain("Todo");
	});

	test("filters use only readable properties", () => {
		checkFilter(SCHEMA, { and: [{ property: "Status", status: { equals: "Done" } }, { property: "tg" }] });
		checkFilter(SCHEMA, [{ timestamp: "created_time", direction: "descending" }]);
		for (const value of [
			{ property: "Budget", formula: { number: { greater_than: 10 } } },
			{ or: [{ property: "bu" }] },
			{ property: "Missing" },
			[{ property: "Budget", direction: "ascending" }],
		] as Json[]) {
			expect(refused(() => checkFilter(SCHEMA, value))).toBeInstanceOf(OperationError);
		}
		let nested: JsonObject = { property: "Status" };
		for (let i = 0; i < 10; i++) nested = { and: [nested] };
		expect(refused(() => checkFilter(SCHEMA, nested))).toBeInstanceOf(OperationError);
	});
});

describe("connecting", () => {
	test("account, discovery and names", async () => {
		const notion = fakeNotion();
		const connector = notionConnector();
		const client = notion.client();
		expect(await connector.account(client)).toEqual({ id: ID.workspace, label: "Acme" });
		let found = await connector.discover(client, PAGE, { query: "launch", cursor: null });
		expect(found.items.map((item) => [NAME.get(item.id), item.name])).toEqual([
			["row1", "Launch"],
			["row2", "Secret launch"],
		]);
		found = await connector.discover(client, PAGE, { query: "projects", cursor: null });
		expect(found.items.map((item) => [NAME.get(item.id), item.name])).toEqual([["projects", "Projects (database)"]]);
		await expect(connector.discover(client, PAGE, { query: null, cursor: "../x" })).rejects.toMatchObject({ code: "INVALID_CURSOR", message: "This page token is invalid." });
		expect(await connector.describe(client, PAGE, [ID.home, ID.projects, ID.ghost, "*"])).toEqual({ [ID.home]: "Home", [ID.projects]: "Projects (database)" });
	});

	test("token requests use Basic auth and JSON", async () => {
		// The code exchange's request (oauth.py `exchange_code` through `_token_request`), for the operator's
		// client: Basic client authentication, a JSON body, and no code_verifier since Notion has no PKCE.
		const auth = notionConnector().auth;
		if (auth.type !== "oauth2") throw new Error("Notion connects through OAuth");
		expect(auth.tokenUrl).toBe("https://api.notion.com/v1/oauth/token");
		expect(auth.pkce).toBe(false);
		const init = tokenRequest(auth, { clientId: "id", clientSecret: "secret", redirectUri: "https://x/cb" }, [
			["code", "c"],
			["redirect_uri", "https://x/cb"],
			["grant_type", "authorization_code"],
		]);
		const headers = new Headers(init.headers);
		expect(parseJson(init.body as string)).toEqual({ code: "c", redirect_uri: "https://x/cb", grant_type: "authorization_code" });
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("authorization")).toBe(`Basic ${btoa("id:secret")}`);
		expect(init.redirect).toBe("manual");
		// Notion's answer: the tokens are kept, its own fields (bot_id) ignored, and it names no scopes.
		const body = tokenBody(JSON.stringify({ access_token: "a", refresh_token: "r", bot_id: "b" }));
		expect(body).not.toBeNull();
		expect(tokenPayload(body as JsonObject, 0)).toEqual({ kind: "oauth2", access_token: "a", refresh_token: "r", scopes: null });
	});

	test("the authorization asks for no scope and no PKCE", () => {
		// What authorization_url builds its query from: owner=user first, then the protocol's parameters;
		// no scope (none are declared) and no code challenge (pkce false). The URL itself is the web API's.
		const auth = notionConnector().auth;
		expect(auth).toEqual({
			type: "oauth2",
			app: "notion",
			authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
			tokenUrl: "https://api.notion.com/v1/oauth/token",
			scopes: [],
			authorizeParams: [["owner", "user"]],
			clientAuth: "basic",
			jsonBody: true,
			pkce: false,
		});
	});
});

describe("runs", () => {
	test("a grant on a page covers what is inside it", async () => {
		const notion = fakeNotion();
		let run = await start(notion, { home: ["read"] });
		for (const name of ["home", "private", "row1", "in_column"] as const) expect(names(await run.ok("notion_get_page", { page_id: ID[name] }))).toEqual([name]);
		const column = await run.ok("notion_get_page", { page_id: ID.in_column });
		expect(column.result.items[0]?.parent_id).toBe(ID.home);
		// A link works as well as an id.
		const outcome = await run.ok("notion_read_page", { page_id: url("private") });
		expect(outcome.result.items[0]?.text).toBe("Top secret");
		// The orphan's parent cannot be seen; a missing page looks like one without a grant.
		for (const pageId of [ID.orphan, ID.ghost]) expect(await run.code("notion_get_page", { page_id: pageId })).toBe("POLICY_DENIED");

		run = await start(notion, { private: ["read"] });
		expect(await run.code("notion_read_page", { page_id: ID.home })).toBe("POLICY_DENIED");
		expect(notion.requests.filter((request) => request.path.endsWith(`${ID.home}/markdown`))).toEqual([]);
	});

	test("reading hides titles and synced content", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read"] });
		const [home] = (await run.ok("notion_read_page", { page_id: ID.home })).result.items;
		expect(home?.text).not.toContain("Private plans");
		expect(home?.text).toContain("Intro line");
		expect([home?.title, home?.truncated]).toEqual(["Home", false]);
		const [synced] = (await run.ok("notion_read_page", { page_id: ID.synced })).result.items;
		expect(synced?.text).not.toContain("Top secret");
		const [part] = (await run.ok("notion_read_page", { page_id: ID.home, offset: 2, max_chars: 4 })).result.items;
		expect([part?.text, part?.truncated]).toEqual(["Home", true]);
		expect(await run.code("notion_read_page", { page_id: ID.projects })).toBe("NOT_FOUND");
	});

	test("search is filtered by where pages sit", async () => {
		const notion = fakeNotion();
		let run = await start(notion, { projects: ["read"] });
		expect(new Set(names(await run.ok("notion_search", { text: "launch" })))).toEqual(new Set(["row1", "row2"]));
		expect(names(await run.ok("notion_search", { text: "home" }))).toEqual([]);

		run = await start(notion, { "*": ["read"] }, { ceiling: [deny("row2")] });
		const found = names(await run.ok("notion_search", { text: "" }));
		// The orphan might sit under the denied row, so it is left out too.
		expect(found).not.toContain("row2");
		expect(found).not.toContain("orphan");
		for (const name of ["home", "private", "row1", "in_column", "synced", "projects"]) expect(found).toContain(name);
	});

	test("too many lookups leave ancestry partial", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read"] }, { maxLookups: 0 });
		// Private sits directly in Home, which needs no lookup; in_column needs its blocks looked up.
		const found = names(await run.ok("notion_search", { text: "" }));
		expect(found).toContain("private");
		expect(found).not.toContain("in_column");
	});

	test("databases show only readable properties", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { projects: ["read"] });
		const [database] = (await run.ok("notion_get_database", { database_id: ID.projects })).result.items;
		const [source] = database?.data_sources as JsonObject[];
		const properties = source?.properties as { [name: string]: JsonObject };
		expect(properties.Status?.options).toEqual(["Todo", "Done"]);
		expect(properties.Budget).toEqual({ type: "formula", hidden: true });
		const rows = await run.ok("notion_query_database", { database_id: ID.projects });
		expect(names(rows)).toEqual(["row1", "row2"]);
		expect(rows.result.items[0]?.properties).toEqual({ Name: "Launch", Status: "Todo", Owner: ["Grace"] });
		expect(parseJson(notion.requests.at(-1)?.body as string)).toEqual({ page_size: 25, result_type: "page" });
		const filtered = { property: "Status", status: { equals: "Done" } };
		await run.ok("notion_query_database", { database_id: ID.projects, filter: filtered });
		expect((parseJson(notion.requests.at(-1)?.body as string) as JsonObject).filter).toEqual(filtered);

		const before = notion.requests.length;
		const hidden = { property: "Budget", formula: { number: { greater_than: 10 } } };
		expect(await run.code("notion_query_database", { database_id: ID.projects, filter: hidden })).toBe("INVALID_ARGUMENTS");
		expect(notion.requests.slice(before).filter((request) => request.path.endsWith("/query"))).toEqual([]);
		expect(await run.code("notion_get_page", { page_id: ID.home })).toBe("POLICY_DENIED");
	});

	test("a deny on a row hides it and stray rows are dropped", async () => {
		const notion = fakeNotion();
		const other = { type: "data_source_id", data_source_id: ID.ghost, database_id: ID.ghost };
		notion.pages[ID.stray] = page("stray", other, "Stray");
		// A row of this data source that Notion places in another database: the source was moved.
		notion.pages[ID.orphan] = page("orphan", { ...IN_SOURCE, database_id: ID.ghost }, "Moved");
		const run = await start(notion, { projects: ["read"] }, { ceiling: [deny("row2")] });
		expect(names(await run.ok("notion_query_database", { database_id: ID.projects }))).toEqual(["row1"]);
	});

	test("filters cannot probe titles of mentioned pages", async () => {
		const notion = fakeNotion();
		const mention = { type: "mention", plain_text: "Private plans", mention: { type: "page", page: { id: ID.private } } };
		((notion.pages[ID.row1]?.properties as JsonObject).Name as JsonObject).title = [mention];
		const run = await start(notion, { projects: ["read"] });
		expect(names(await run.ok("notion_query_database", { database_id: ID.projects }))).toEqual(["row1", "row2"]);
		const byName = { property: "Name", title: { contains: "Private" } };
		expect(names(await run.ok("notion_query_database", { database_id: ID.projects, filter: byName }))).toEqual(["row2"]);
		expect(names(await run.ok("notion_query_database", { database_id: ID.projects, sorts: [{ property: "Name" }] }))).toEqual(["row2"]);
	});

	test("linked databases are not queried", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { linked: ["read"] });
		const [database] = (await run.ok("notion_get_database", { database_id: ID.linked })).result.items;
		expect(database?.data_sources).toEqual([{ id: ID.source, linked_from_elsewhere: true }]);
		expect(await run.code("notion_query_database", { database_id: ID.linked })).toBe("UNSUPPORTED_DATABASE");
		expect(notion.requests.filter((request) => request.path.endsWith("/query"))).toEqual([]);
	});

	test("comments on the page itself", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "comment"] });
		const outcome = await run.ok("notion_list_comments", { page_id: ID.home });
		expect(outcome.result.items.map((comment) => comment.text)).toEqual(["Nice"]);
		const added = await run.ok("notion_add_comment", { page_id: ID.private, text: "Looks good" });
		expect(added.result.items[0]?.text).toBe("Looks good");
		expect(notion.writes.at(-1)).toEqual(["POST", "/v1/comments", { parent: { page_id: ID.private }, markdown: "Looks good" }]);
	});

	test("creating pages and rows", async () => {
		const notion = fakeNotion();
		let run = await start(notion, { home: ["read"] });
		expect(run.tools).not.toContain("notion_create_page");

		run = await start(notion, { home: ["read", "create"] });
		const outcome = await run.ok("notion_create_page", { parent_page_id: ID.home, title: "Notes", markdown: "Hello" });
		const [created] = outcome.result.items;
		expect([created?.title, created?.parent_id]).toEqual(["Notes", ID.home]);
		expect(notion.writes.at(-1)?.[2]).toEqual({
			parent: { page_id: ID.home },
			properties: { title: { title: [{ type: "text", text: { content: "Notes" } }] } },
			markdown: "Hello",
		});
		const created_row = await run.ok("notion_create_database_row", { database_id: ID.projects, properties: { Name: "Ship", Status: "Done", Tags: ["b"] } });
		expect(created_row.result.items[0]?.parent_id).toBe(ID.projects);
		const body = notion.writes.at(-1)?.[2] as JsonObject;
		expect(body.parent).toEqual({ data_source_id: ID.source });
		expect((body.properties as JsonObject).Tags).toEqual({ multi_select: [{ name: "b" }] });

		const writes = notion.writes.length;
		for (const args of [
			{ database_id: ID.projects, properties: { Owner: ["u1"] } },
			{ database_id: ID.projects, properties: { Status: "New option" } },
			{ database_id: ID.projects, properties: { Name: "x" }, markdown: "![a](https://e.x/p)" },
		] as JsonObject[]) {
			expect(await run.code("notion_create_database_row", args)).toBe("INVALID_ARGUMENTS");
		}
		for (const args of [
			{ parent_page_id: ID.private, title: "x", markdown: `<page url="${url("home")}">Home</page>` },
			{ parent_page_id: ID.private, title: "bad\ntitle" },
			{ parent_page_id: "not an id", title: "x" },
			{ parent_page_id: `https://evil.example/${ID.home.replaceAll("-", "")}`, title: "x" },
		] as JsonObject[]) {
			expect(await run.code("notion_create_page", args)).toBe("INVALID_ARGUMENTS");
		}
		expect(notion.writes.length).toBe(writes);

		run = await start(notion, { private: ["read", "create"] });
		expect(await run.code("notion_create_page", { parent_page_id: ID.home, title: "x" })).toBe("POLICY_DENIED");
	});

	test("updating properties", async () => {
		const notion = fakeNotion();
		let run = await start(notion, { projects: ["read", "edit"] });
		const outcome = await run.ok("notion_update_page_properties", { page_id: ID.row1, properties: { Status: "Done" } });
		expect((outcome.result.items[0]?.properties as JsonObject).Status).toBe("Done");
		expect(notion.writes.at(-1)).toEqual(["PATCH", `/v1/pages/${ID.row1}`, { properties: { Status: { status: { name: "Done" } } } }]);
		expect(await run.code("notion_update_page_properties", { page_id: ID.row1, properties: { Budget: 5 } })).toBe("INVALID_ARGUMENTS");

		run = await start(notion, { home: ["read", "edit"] });
		await run.ok("notion_update_page_properties", { page_id: ID.private, properties: { title: "Plans" } });
		expect(await run.code("notion_update_page_properties", { page_id: ID.private, properties: { Status: "Done" } })).toBe("INVALID_ARGUMENTS");
	});

	test("editing page text", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "edit"] });
		await run.ok("notion_edit_page", { page_id: ID.home, edits: [{ old: "Intro", new: "Opening" }] });
		const [method, path, body] = notion.writes.at(-1) as [string, string, Json];
		expect([method, path]).toEqual(["PATCH", `/v1/pages/${ID.home}/markdown`]);
		expect(body).toEqual({
			type: "update_content",
			update_content: { content_updates: [{ old_str: "\nIntro line\n", new_str: "\nOpening line\n" }], allow_deleting_content: false },
		});
		expect(notion.markdown[ID.home]).toContain("Private plans");
		await run.ok("notion_append_to_page", { page_id: ID.home, markdown: "- [ ] follow up" });
		expect(notion.writes.at(-1)?.[2]).toEqual({ type: "insert_content", insert_content: { content: "- [ ] follow up", position: { type: "end" } } });

		const writes = notion.writes.length;
		for (const edits of [[{ old: "Private plans", new: "x" }], [{ old: "Repeated", new: "x" }]]) {
			expect(await run.code("notion_edit_page", { page_id: ID.home, edits })).toBe("EDIT_NOT_APPLIED");
		}
		expect(await run.code("notion_edit_page", { page_id: ID.synced, edits: [{ old: "Before", new: "x" }] })).toBe("UNSUPPORTED_PAGE");
		expect(notion.writes.length).toBe(writes);
	});

	test("an edit Notion refuses is reported", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "edit"] });
		notion.hook = (request) => {
			if (request.method === "PATCH") notion.markdown[ID.home] = (notion.markdown[ID.home] as string).replace("Intro line", "Changed");
		};
		expect(await run.code("notion_edit_page", { page_id: ID.home, edits: [{ old: "Intro", new: "x" }] })).toBe("EDIT_NOT_APPLIED");
		// Refused, so not applied: the same edit may be tried again.
		expect(run.writes()).toEqual([]);
	});

	/** Moves the page into `parent` just before Notion answers the second request for it. */
	function moveOnSecondFetch(notion: FakeNotion, name: Name, parent: Name): void {
		let fetches = 0;
		notion.hook = (request) => {
			if (request.method === "GET" && (request.path.endsWith(`/pages/${ID[name]}`) || request.path.endsWith(`/databases/${ID[name]}`))) {
				fetches += 1;
				if (fetches === 2) {
					const target = (notion.pages[ID[name]] ?? notion.databases[ID[name]]) as JsonObject;
					target.parent = inPage(parent);
				}
			}
		};
	}

	test.each([
		["notion_read_page", { page_id: ID.row1 }, "row1"],
		["notion_edit_page", { page_id: ID.row1, edits: [{ old: "Row", new: "x" }] }, "row1"],
		["notion_create_page", { parent_page_id: ID.in_column, title: "x" }, "in_column"],
		["notion_query_database", { database_id: ID.projects }, "projects"],
	] as const)("a page moved while the call runs is refused: %s", async (tool, args, moved) => {
		const notion = fakeNotion();
		const run = await start(notion, { "*": ["read", "create", "edit"] }, { ceiling: [deny("private", ["read", "create", "edit"])] });
		moveOnSecondFetch(notion, moved, "private");
		expect(await run.code(tool, args as unknown as Json)).toBe("PAGE_MOVED");
		expect(notion.requests.filter((request) => request.path.endsWith("/markdown") || request.path.endsWith("/query"))).toEqual([]);
		expect(notion.writes).toEqual([]);
	});

	test("cycles are partial", async () => {
		const notion = fakeNotion();
		(notion.blocks[ID.column] as JsonObject).parent = { type: "block_id", block_id: ID.column };
		const run = await start(notion, { "*": ["read"] }, { ceiling: [deny("private")] });
		expect(await run.code("notion_get_page", { page_id: ID.in_column })).toBe("POLICY_DENIED");
		expect(names(await run.ok("notion_get_page", { page_id: ID.row1 }))).toEqual(["row1"]);
	});

	test("a missing capability is explained", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "comment"] });
		const original = notion.handle;
		notion.handle = (request) => {
			if (request.method === "POST" && request.path.endsWith("/comments")) return jsonResponse(403, { object: "error", status: 403, code: "restricted_resource" });
			return original(request);
		};
		const error = await run.error("notion_add_comment", { page_id: ID.home, text: "hi" });
		expect(error.code).toBe("PROVIDER_FORBIDDEN");
		expect(error.message).toContain("capabilities");
		// A 403 is a refusal: nothing was applied, and nothing pauses the run's writes.
		expect(run.paused()).toBe(false);
	});
});

describe("beyond test_notion.py", () => {
	test("the registry takes the declarations; their fingerprints", async () => {
		const connector = notionConnector();
		const registry = await Registry.create([connector]);
		const printed: string[] = [];
		for (const op of connector.operations) {
			const contract = registry.contract("notion", op.name);
			expect(contract).toMatch(/^[0-9a-f]{16}$/);
			// The same declaration, built again, means the same.
			expect(await fingerprint(notionConnector(), op)).toBe(contract);
			printed.push(`notion_${op.name} ${contract}`);
		}
		console.log(`Notion fingerprints:\n${printed.join("\n")}`);
		expect(connector.operations.map((op) => [op.name, termsOf(op).mutates, termsOf(op).paginated, op.needs])).toEqual([
			["search", false, true, [[PAGE, "read"]]],
			["get_page", false, false, [[PAGE, "read"]]],
			["read_page", false, false, [[PAGE, "read"]]],
			["get_database", false, false, [[PAGE, "read"]]],
			["query_database", false, true, [[PAGE, "read"]]],
			["list_comments", false, true, [[PAGE, "read"]]],
			["create_page", true, false, [[PAGE, "create"]]],
			["create_database_row", true, false, [[PAGE, "create"]]],
			["update_page_properties", true, false, [[PAGE, "edit"]]],
			["edit_page", true, false, [[PAGE, "edit"]]],
			["append_to_page", true, false, [[PAGE, "edit"]]],
			["add_comment", true, false, [[PAGE, "comment"]]],
		]);
		for (const op of connector.operations) {
			expect(termsOf(op)).toMatchObject({ outputAction: "read", consent: null, revision: 1 });
			expect(offered(connector, op)).toBe(true);
		}
		expect(connector.kinds).toEqual([
			{
				id: PAGE,
				label: "Page or database",
				actions: ["read", "comment", "create", "edit"],
				wildcard: true,
				hierarchical: true,
				note: "What is allowed on a page or database also covers the pages inside it. Notion decides which pages Minerva can reach at all: they are chosen when connecting Notion, and connecting again changes them. Where Notion does not show where a page sits, blocking an action anywhere in this connection also blocks it there.",
			},
		]);
		expect(connector.actions).toEqual([
			{ id: "read", label: "Read pages" },
			{ id: "comment", label: "Comment on pages", requires: "read" },
			{ id: "create", label: "Create pages", requires: "read" },
			{ id: "edit", label: "Edit pages", requires: "read" },
		]);
		expect([connector.browsable, connector.manageLink, connector.offered]).toEqual([undefined, undefined, undefined]);
	});

	test("the Worker's registry serves Notion", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("notion");
		expect((await connectorRegistry()).get("notion").name).toBe("Notion");
	});

	test("every request carries the pinned version and the token", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "edit", "comment", "create"] });
		await run.ok("notion_search", {});
		await run.ok("notion_read_page", { page_id: ID.in_column });
		await run.ok("notion_list_comments", { page_id: ID.home });
		expect(notion.requests.length).toBeGreaterThan(5);
		// The afterEach hook checks the headers of each.
	});

	test("search pages through run-bound page tokens bound to the query", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read"] });
		const first = await run.ok("notion_search", { limit: 2 });
		expect(names(first)).toEqual(["home", "private"]);
		const token = first.result.next_cursor as string;
		expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
		const searches = () => notion.requests.filter((request) => request.path === "/v1/search").map((request) => parseJson(request.body));
		expect(searches()).toEqual([{ page_size: 2 }]);
		const second = await run.ok("notion_search", { limit: 2, cursor: token });
		expect(names(second)).toEqual(["row1", "row2"]);
		// Notion's own cursor went to Notion; the model only ever saw the token.
		expect(searches()).toEqual([{ page_size: 2 }, { page_size: 2, start_cursor: "c2" }]);
		expect(await run.code("notion_search", { limit: 3, cursor: token })).toBe("INVALID_CURSOR");
	});

	test("a page larger than Minerva reads is refused, and a truncated one is not edited", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "edit"] });
		notion.markdown[ID.private] = "x".repeat(MAX_MARKDOWN_BYTES);
		expect(await run.error("notion_read_page", { page_id: ID.private })).toEqual({ code: "PAGE_TOO_LARGE", message: "This page is larger than Minerva reads." });
		const original = notion.handle;
		notion.handle = (request) => {
			if (request.method === "GET" && request.path.endsWith(`${ID.private}/markdown`)) return jsonResponse(200, { object: "page_markdown", id: ID.private, markdown: "Short", truncated: true });
			return original(request);
		};
		const [read] = (await run.ok("notion_read_page", { page_id: ID.private })).result.items;
		expect([read?.text, read?.truncated, read?.total_chars]).toEqual(["Short", true, 5]);
		expect(await run.error("notion_edit_page", { page_id: ID.private, edits: [{ old: "Short", new: "x" }] })).toEqual({
			code: "PAGE_TOO_LARGE",
			message: "This page is too long for Minerva to edit.",
		});
		expect(notion.writes).toEqual([]);
	});

	test("read_page counts UTF-16 units and never cuts a character in half", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read"] });
		notion.markdown[ID.private] = "😀😀😀ab";
		const [read] = (await run.ok("notion_read_page", { page_id: ID.private, offset: 1, max_chars: 2 })).result.items;
		// Offset 1 and end 3 fall inside the first and second emoji: the window moves back to whole characters.
		expect([read?.text, read?.total_chars, read?.truncated]).toEqual(["😀", 8, true]);
	});

	test("a database with several data sources needs data_source_id", async () => {
		const notion = fakeNotion();
		const other = uuid(600);
		notion.sources[other] = { object: "data_source", id: other, parent: { type: "database_id", database_id: ID.projects }, title: text("Archive"), properties: {} };
		(notion.databases[ID.projects] as JsonObject).data_sources = [
			{ id: ID.source, name: "Projects" },
			{ id: other, name: "Archive" },
		];
		const run = await start(notion, { projects: ["read"] });
		expect(await run.error("notion_query_database", { database_id: ID.projects })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: `This database has several data sources; pass data_source_id: ${ID.source}, ${other}.`,
		});
		expect(await run.error("notion_query_database", { database_id: ID.projects, data_source_id: uuid(601) })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "This database has no data source with that id.",
		});
		expect(names(await run.ok("notion_query_database", { database_id: ID.projects, data_source_id: ID.source.replaceAll("-", "") }))).toEqual(["row1", "row2"]);
		const [database] = (await run.ok("notion_get_database", { database_id: ID.projects })).result.items;
		expect((database?.data_sources as JsonObject[]).map((source) => source.name)).toEqual(["Projects", "Archive"]);
	});

	test("a write's arguments are normalized before its key", async () => {
		const notion = fakeNotion();
		const run = await start(notion, { home: ["read", "create"] });
		const first = await run.ok("notion_create_page", { parent_page_id: url("home"), title: " Notes " });
		// The same page by id, with the title as validation strips it: the same write, answered from the ledger.
		const again = await run.ok("notion_create_page", { parent_page_id: ID.home.toUpperCase(), title: "Notes" });
		expect(again.repeat).toBe(true);
		expect(again.result).toEqual(first.result);
		expect(notion.writes.length).toBe(1);
		// Read and create on a page: the reads and the two creating tools, nothing that edits or comments.
		expect(run.tools).toEqual([
			"notion_search",
			"notion_get_page",
			"notion_read_page",
			"notion_get_database",
			"notion_query_database",
			"notion_list_comments",
			"notion_create_page",
			"notion_create_database_row",
		]);
	});

	test("a connection whose workspace Notion does not name is refused", async () => {
		const notion = fakeNotion();
		notion.handle = () => jsonResponse(200, { object: "user", id: BOT, type: "bot", bot: { workspace_name: "Acme" } });
		await expect(notionConnector().account(notion.client())).rejects.toMatchObject({ code: "PROVIDER_FAILED", message: "Notion did not say which workspace was connected." });
		notion.handle = () => jsonResponse(200, { object: "user", id: BOT, type: "bot", bot: { workspace_id: ID.workspace.replaceAll("-", "").toUpperCase(), workspace_name: null } });
		// The id as Notion's own canonical form; a workspace without a name is "Notion".
		expect(await notionConnector().account(notion.client())).toEqual({ id: ID.workspace, label: "Notion" });
	});

	test("discovery pages with Notion's cursor, which is checked both ways", async () => {
		const notion = fakeNotion();
		const original = notion.handle;
		let next: Json = "abc_=-1";
		notion.handle = (request) => {
			if (request.path !== "/v1/search") return original(request);
			return jsonResponse(200, { results: [notion.pages[ID.home] as JsonObject, { object: "page", id: "x" }, { object: "block" }], has_more: true, next_cursor: next });
		};
		const connector = notionConnector();
		const found = await connector.discover(notion.client(), PAGE, { query: "", cursor: "abc" });
		expect(found).toEqual({ items: [{ id: ID.home, name: "Home" }], nextCursor: "abc_=-1" });
		// Without a query, none is sent; the cursor the browser holds is passed on.
		expect(parseJson(notion.requests.at(-1)?.body as string)).toEqual({ page_size: 100, start_cursor: "abc" });
		next = "x".repeat(301);
		await expect(connector.discover(notion.client(), PAGE, { query: null, cursor: null })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
	});

	test("names of objects Notion refuses are left out; other failures are not hidden", async () => {
		const notion = fakeNotion();
		const original = notion.handle;
		notion.handle = (request) => (request.path === `/v1/pages/${ID.private}` ? jsonResponse(403, { object: "error", status: 403, code: "restricted_resource" }) : original(request));
		const connector = notionConnector();
		expect(await connector.describe(notion.client(), PAGE, [ID.private, ID.home, ID.home.replaceAll("-", "")])).toEqual({ [ID.home]: "Home" });
		notion.handle = (request) => (request.path === `/v1/pages/${ID.private}` ? jsonResponse(500, {}) : original(request));
		await expect(connector.describe(notion.client(), PAGE, [ID.private])).rejects.toMatchObject({ code: "PROVIDER_FAILED", message: "Notion could not complete this request." });
	});

	test("a number too large for a double is no number", () => {
		// parseJson reads "1e400" as an infinity.
		const huge = parseJson('{"Score": 1e400}') as JsonObject;
		const numbers: JsonObject = { Score: { id: "sc", type: "number", number: {} } };
		expect(refused(() => writable(numbers, huge))).toMatchObject({ code: "INVALID_ARGUMENTS", message: '"Score" takes a number, or null.' });
	});
});
