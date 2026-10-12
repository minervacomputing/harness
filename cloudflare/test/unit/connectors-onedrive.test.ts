// backend/tests/test_onedrive.py, case by case: the OneDrive and SharePoint connector against an in-memory
// Microsoft Graph and file host behind an injected `fetch`, and runs through the executor. Zip, Office, address
// and input comparisons with today's Python are in connectors-onedrive-vectors.test.ts; Graph's paging, error
// classification and consent are tested with the shared base in connectors-microsoft.test.ts.

import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { downloadAllowed } from "../../src/connectors/onedrive/client.ts";
import { LIMITS, onedriveConnector } from "../../src/connectors/onedrive/connector.ts";
import { MAX_COLUMNS, MAX_ENTRIES, MAX_EXPANDED, MAX_SHARED_STRINGS, MAX_SLIDES, extract } from "../../src/connectors/onedrive/office.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { ceilingRow, jsonResponse, received, startRun, type Received } from "../fixtures/connectors/microsoft/runs.ts";

type JsonObject = { [key: string]: Json };

const USER_ID = "00000000-0000-0000-0000-00000000b0b0";
const [ME, TEAM, OTHER] = ["b!me", "b!team", "b!other"] as const;
const PERSONAL = "ABCDEF0123456789";
const SITE = "contoso.sharepoint.com,1111,2222";
const READ_SCOPES = ["Files.Read.All", "Sites.Read.All", "User.Read", "openid", "profile"];
const WRITE_SCOPES = ["Files.ReadWrite.All", "Sites.Read.All", "User.Read", "openid", "profile"];

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function zipped(parts: { [name: string]: string | Uint8Array }): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(parts).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data])), { level: 9 });
}

function rels(...relationships: [string, string, string][]): string;
function rels(external: string, ...relationships: [string, string, string][]): string;
function rels(...items: unknown[]): string {
	const external = typeof items[0] === "string" ? (items.shift() as string) : null;
	const entries = (items as [string, string, string][]).map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("");
	const link = external ? `<Relationship Id="ext" Type="${R}/hyperlink" Target="${external}" TargetMode="External"/>` : "";
	return `<Relationships xmlns="${PACKAGE}">${entries}${link}</Relationships>`;
}

function docx(body: string): Uint8Array {
	return zipped({
		"_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]),
		"word/document.xml": `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
	});
}

function slide(text: string): string {
	return `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

function pptx(): Uint8Array {
	return zipped({
		"_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
		"ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
		"ppt/_rels/presentation.xml.rels": rels(["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]),
		"ppt/slides/slide1.xml": slide("Title"),
		"ppt/slides/slide2.xml": slide("Agenda"),
	});
}

function xlsx(): Uint8Array {
	return zipped({
		"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
		"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": rels("https://example.com/x", ["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"], ["rId3", "sharedStrings", "sharedStrings.xml"]),
		"xl/sharedStrings.xml": `<sst xmlns="${S}"><si><t>Name</t></si><si><r><t>Ad</t></r><r><t>a</t></r><rPh><t>reading</t></rPh></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml":
			`<worksheet xmlns="${S}"><sheetData>` +
			'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>a,b</t></is></c></row>' +
			'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>40+2</f><v>42</v></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>',
	});
}

function itemOf(id: string, name: string, drive: string, parent: string | null, extra: JsonObject = {}): JsonObject {
	const reference: JsonObject = { driveId: drive };
	if (parent !== null) reference.id = parent;
	return { id, name, parentReference: reference, webUrl: `https://x/${id}`, ...extra };
}

const folderOf = (id: string, name: string, drive: string, parent: string | null) => itemOf(id, name, drive, parent, { folder: { childCount: 0 } });
const fileOf = (id: string, name: string, drive: string, parent: string, mime = "text/plain") => itemOf(id, name, drive, parent, { file: { mimeType: mime }, size: 10 });

type Hook = (request: Received) => Response | null;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Microsoft Graph's OneDrive and SharePoint API, and a file host (test_onedrive.py `FakeGraph`).
 *
 * My OneDrive: Docs/ (Projects/ (plan.txt), report.docx, deck.pptx, sheet.xlsx), Private/ (diary.txt) and a link
 * to a folder another user shared. That user's folder (Shared/ with notes.txt) sits in a folder the account
 * cannot open. The SharePoint site "Sales" the account follows has the library "Documents" (Wiki/ with
 * handbook.md). With `personal`, my OneDrive is a personal account's, with a hexadecimal id.
 */
class FakeGraph {
	readonly me: string;
	readonly drives: { [id: string]: JsonObject };
	readonly items = new Map<string, JsonObject>();
	readonly forbidden = new Set([`${OTHER}\u0000ghost`]);
	readonly contents = new Map<string, Uint8Array>();
	downloadHost = "contoso.sharepoint.com";
	pageSize: number | null = null;
	requests: Received[] = [];
	uploads: Received[] = [];
	searches: JsonObject[] = [];
	hook: Hook | null = null;
	/** Items that `children` lists in addition to the folder's own. */
	strays: JsonObject[] = [];

	readonly personal: boolean;

	constructor(personal = false) {
		this.personal = personal;
		const me = personal ? PERSONAL : ME;
		this.me = me;
		this.drives = {
			[me]: { id: me, name: "OneDrive", driveType: personal ? "personal" : "business" },
			[TEAM]: { id: TEAM, name: "Documents", driveType: "documentLibrary" },
			[OTHER]: { id: OTHER, name: "OneDrive", driveType: "business" },
		};
		const items = [
			itemOf("root-me", "root", me, null, { root: {}, folder: { childCount: 3 } }),
			folderOf("docs", "Docs", me, "root-me"),
			folderOf("projects", "Projects", me, "docs"),
			fileOf("plan", "plan.txt", me, "projects"),
			fileOf("report", "report.docx", me, "docs", DOCX),
			fileOf("deck", "deck.pptx", me, "docs", PPTX),
			fileOf("sheet", "sheet.xlsx", me, "docs", XLSX),
			folderOf("private", "Private", me, "root-me"),
			fileOf("diary", "diary.txt", me, "private"),
			itemOf("link", "Shared", me, "root-me", { remoteItem: { id: "shared", parentReference: { driveId: OTHER } } }),
			itemOf("root-team", "root", TEAM, null, { root: {}, folder: { childCount: 1 } }),
			folderOf("wiki", "Wiki", TEAM, "root-team"),
			fileOf("handbook", "handbook.md", TEAM, "wiki", "application/octet-stream"),
			folderOf("shared", "Shared", OTHER, "ghost"),
			fileOf("notes", "notes.txt", OTHER, "shared"),
		];
		for (const item of items) this.put(item);
		const contents: [string, Uint8Array][] = [
			["plan", Uint8Array.of(0xef, 0xbb, 0xbf, ...text("The plan."))],
			["report", docx("<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>")],
			["deck", pptx()],
			["sheet", xlsx()],
			["diary", text("Dear diary.")],
			["handbook", text("# Handbook")],
			["notes", text("Shared notes.")],
		];
		for (const [id, content] of contents) this.contents.set(id, content);
	}

	static key(drive: string, id: string): string {
		return `${drive.toLowerCase()}\u0000${id}`;
	}

	put(item: JsonObject): void {
		this.items.set(FakeGraph.key(((item.parentReference as JsonObject).driveId as string), item.id as string), item);
	}

	find(drive: string, id: string): JsonObject | undefined {
		return this.items.get(FakeGraph.key(drive, id));
	}

	/** The item with this id in my drive (the fake's items are keyed by lower-case drive id). */
	mine(id: string): JsonObject {
		return this.find(this.me, id) as JsonObject;
	}

	static error(status: number, code: string): Response {
		return jsonResponse(status, { error: { code, message: "Secret item name" } });
	}

	#view(item: JsonObject, params: { [name: string]: string }): JsonObject {
		const shown = { ...item };
		if ((params.$select ?? "").includes("@microsoft.graph.downloadUrl") && "file" in item) {
			shown["@microsoft.graph.downloadUrl"] = `https://${this.downloadHost}/download/${item.id}?tempauth=t`;
		}
		return shown;
	}

	children(drive: string, folder: string): JsonObject[] {
		const own = [...this.items.entries()].filter(([key, item]) => key.startsWith(`${drive.toLowerCase()}\u0000`) && (item.parentReference as JsonObject).id === folder).map(([, item]) => item);
		return [...own, ...this.strays];
	}

	#page(path: string, items: JsonObject[], params: { [name: string]: string }): Response {
		const top = this.pageSize ?? Number(params.$top ?? 10);
		const start = Number(params.$skiptoken ?? 0);
		const body: JsonObject = { value: items.slice(start, start + top) };
		if (start + top < items.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0${path}?$top=${top}&$skiptoken=${start + top}`;
		return jsonResponse(200, body);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = await received(input, init);
		this.requests.push(request);
		const hooked = this.hook?.(request) ?? null;
		if (hooked !== null) return hooked;
		if (request.host === this.downloadHost) {
			const id = request.path.slice(request.path.lastIndexOf("/") + 1);
			return new Response(this.contents.get(id) as Uint8Array, { status: 200 });
		}
		if (request.host !== "graph.microsoft.com") throw new Error(request.url.href);
		const path = request.path;
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (request.method === "POST") {
			if (parts.join("/") !== "search/query") throw new Error(path);
			return this.#search(JSON.parse(request.body) as JsonObject);
		}
		if (request.method === "PUT") return this.#upload(request, parts);
		const params = request.params;
		const [a, b, c, d] = parts;
		if (a === "me" && parts.length === 1) return jsonResponse(200, { id: USER_ID, mail: "me@contoso.com", displayName: "Me" });
		if (a === "me" && b === "drive" && parts.length === 2) return jsonResponse(200, this.drives[this.me] as JsonObject);
		if (a === "me" && b === "drive" && c === "root" && parts.length === 3) return jsonResponse(200, this.#view(this.mine("root-me"), params));
		if (a === "me" && b === "drive" && c?.startsWith("search(q='") && parts.length === 3) {
			const query = c.slice("search(q='".length, -"')".length).replaceAll("''", "'");
			const found = [...this.items.values()].filter((item) => (item.name as string).toLowerCase().includes(query.toLowerCase()));
			return this.#page(path, found, params);
		}
		if (a === "me" && b === "followedSites" && parts.length === 2) {
			if (this.personal) throw new Error("followedSites on a personal account");
			return jsonResponse(200, { value: [{ id: SITE, displayName: "Sales", name: "sales" }] });
		}
		if (a === "sites" && c === "drives" && b === SITE && parts.length === 3) {
			return jsonResponse(200, { value: [this.drives[TEAM] as JsonObject, { id: "b!lists", name: "Lists", driveType: "other" }] });
		}
		if (a === "drives" && parts.length === 2) {
			const found = this.drives[this.personal ? (b as string).toUpperCase() : (b as string)];
			if (found !== undefined) return jsonResponse(200, found);
		}
		if (a === "drives" && c === "root" && parts.length === 3) {
			return jsonResponse(200, this.find(b as string, `root-${(b as string).replace(/^b!/, "")}`) as JsonObject);
		}
		if (a === "drives" && c === "items" && parts.length === 4) {
			if (this.forbidden.has(FakeGraph.key(b as string, d as string))) return FakeGraph.error(403, "accessDenied");
			const found = this.find(b as string, d as string);
			return found ? jsonResponse(200, this.#view(found, params)) : FakeGraph.error(404, "itemNotFound");
		}
		if (a === "drives" && c === "items" && parts[4] === "children" && parts.length === 5 && this.find(b as string, d as string)) {
			return this.#page(path, this.children(b as string, d as string), params);
		}
		return FakeGraph.error(404, "itemNotFound");
	};

	#search(body: JsonObject): Response {
		this.searches.push(body);
		const [request] = body.requests as JsonObject[] as [JsonObject];
		const query = ((request.query as JsonObject).queryString as string).toLowerCase();
		const found = [...this.items.values()].filter((item) => (item.name as string).toLowerCase().includes(query) && !("root" in item));
		const [start, size] = [request.from as number, request.size as number];
		// As documented: a driveItem hit's resource has no id, and hitId is the item's id.
		const hits = found.map((item) => ({
			hitId: item.id,
			resource: { "@odata.type": "#microsoft.graph.driveItem", ...Object.fromEntries(Object.entries(item).filter(([name]) => name !== "id")) },
		}));
		const container = { hits: hits.slice(start, start + size), total: hits.length, moreResultsAvailable: start + size < hits.length };
		return jsonResponse(200, { value: [{ searchTerms: [query], hitsContainers: [container] }] });
	}

	#upload(request: Received, parts: string[]): Response {
		this.uploads.push(request);
		const [a, drive, b, folderPart, namePart, last] = parts as [string, string, string, string, string, string];
		if (a !== "drives" || b !== "items" || last !== "content" || !folderPart.endsWith(":") || !namePart.endsWith(":") || parts.length !== 6) throw new Error(parts.join("/"));
		const folder = folderPart.slice(0, -1);
		const name = namePart.slice(0, -1);
		if (this.children(drive, folder).some((child) => (child.name as string).toLowerCase() === name.toLowerCase())) return FakeGraph.error(409, "nameAlreadyExists");
		const created = fileOf(`new${this.uploads.length}`, name, (this.drives[this.me] as JsonObject).id as string, folder);
		this.put({ ...created, parentReference: { ...(created.parentReference as JsonObject), driveId: drive } });
		this.contents.set(created.id as string, request.bytes);
		return jsonResponse(201, created);
	}

	itemFetches(id: string): Received[] {
		return this.requests.filter((request) => request.path.endsWith(`/items/${id}`));
	}

	client() {
		return onedriveConnector().client("token", settingsIo(this.fetch));
	}
}

type Grants = { [id: string]: string[] };

function start(graph: FakeGraph, grants: Grants, options: { scopes?: string[]; ceiling?: ReturnType<typeof ceilingRow>[] } = {}) {
	return startRun(onedriveConnector(), graph.fetch, {
		scopes: options.scopes ?? READ_SCOPES,
		grants: Object.fromEntries(Object.entries(grants).map(([id, actions]) => [`item:${id}`, actions])),
		ceiling: options.ceiling ?? [],
	});
}

type Run = Awaited<ReturnType<typeof start>>;
type Item = { [key: string]: Json };

async function items(run: Run, tool: string, args: Json): Promise<Item[]> {
	return (await run.ok(tool, args)).result.items as Item[];
}

async function ids(run: Run, tool: string, args: Json): Promise<string[]> {
	return (await items(run, tool, args)).map((item) => item.id as string);
}

describe("account, discovery and names", () => {
	test("test_account_discovery_and_names", async () => {
		const graph = new FakeGraph();
		const connector = onedriveConnector();
		const client = graph.client();
		const account = await connector.account(client);
		expect([account.id, account.label]).toEqual([USER_ID, "me@contoso.com"]);
		const page = await connector.discover(client, "item", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[`${ME}:root-me`, "OneDrive"],
			[`${TEAM}:root-team`, "Sales / Documents"],
		]);
		const found = await connector.discover(client, "item", { query: "plan", cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([[`${ME}:plan`, "plan.txt"]]);
		await expect(connector.discover(client, "item", { query: "plan", cursor: '{"page": "elsewhere"}' })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		const names = await connector.describe(client, "item", [`${ME}:root-me`, `${TEAM}:root-team`, `${ME}:docs`, `${ME}:plan`, `${ME}:gone`, `${OTHER}:ghost`, "x"]);
		expect(names).toEqual({
			[`${ME}:root-me`]: "OneDrive",
			[`${TEAM}:root-team`]: "Documents (library)",
			[`${ME}:docs`]: "Docs/",
			[`${ME}:plan`]: "plan.txt",
		});
	});
});

describe("grants and the ancestry of items", () => {
	test("test_a_grant_on_a_folder_covers_everything_inside_it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [`${ME}:docs`]: ["read"] });
		const listed = await items(run, "onedrive_list_folder", { folder_id: `${ME}:docs` });
		expect(listed.map((item) => item.id)).toEqual([`${ME}:projects`, `${ME}:report`, `${ME}:deck`, `${ME}:sheet`]);
		expect(listed[0]?.parent_id).toBe(`${ME}:docs`);
		expect(listed[0]?.type).toBe("folder");
		const read = await items(run, "onedrive_read_file", { file_id: `${ME}:plan` });
		expect(read[0]?.text).toBe("The plan.");
		for (const folder of ["root", `${ME}:private`, `${ME}:missing`, `${OTHER}:ghost`]) {
			expect(await run.code("onedrive_list_folder", { folder_id: folder })).toBe("POLICY_DENIED");
		}
		expect(await run.code("onedrive_get_file", { file_id: `${ME}:diary` })).toBe("POLICY_DENIED");
		expect(graph.requests.filter((request) => request.path.endsWith("/private/children"))).toEqual([]);
		expect(await items(run, "onedrive_list_libraries", {})).toEqual([]);
	});

	test("test_libraries_and_root_under_a_wildcard_with_a_deny_below", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] }, { ceiling: [ceilingRow("item", `${ME}:projects`, "deny")] });
		const libraries = await items(run, "onedrive_list_libraries", {});
		expect(libraries.map((item) => [item.id, item.name, item.type])).toEqual([
			[`${ME}:root-me`, "OneDrive", "library"],
			[`${TEAM}:root-team`, "Sales / Documents", "library"],
		]);
		const root = await items(run, "onedrive_list_folder", { folder_id: "root" });
		expect(root.map((item) => item.id)).toEqual([`${ME}:docs`, `${ME}:private`, `${ME}:link`]);
		const link = root.filter((item) => item.type === "shortcut");
		expect(link).toHaveLength(1);
		expect(link[0]?.target_id).toBe(`${OTHER}:shared`);
		expect(await ids(run, "onedrive_list_folder", { folder_id: `${ME}:docs` })).toEqual([`${ME}:report`, `${ME}:deck`, `${ME}:sheet`]);
		expect(await run.code("onedrive_read_file", { file_id: `${ME}:plan` })).toBe("POLICY_DENIED");
		expect(await ids(run, "onedrive_list_folder", { folder_id: `${TEAM}:root-team` })).toEqual([`${TEAM}:wiki`]);
		const caught = await run.error("onedrive_list_folder", { folder_id: `${ME}:link` });
		expect([caught.code, caught.message.includes(`${OTHER}:shared`)]).toEqual(["UNSUPPORTED_FILE", true]);
	});

	test("test_a_library_grant_covers_the_library_only", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [`${TEAM}:root-team`]: ["read"] });
		expect(await ids(run, "onedrive_list_libraries", {})).toEqual([`${TEAM}:root-team`]);
		const read = await items(run, "onedrive_read_file", { file_id: `${TEAM}:handbook` });
		expect(read[0]?.text).toBe("# Handbook");
		expect(await run.code("onedrive_get_file", { file_id: `${ME}:docs` })).toBe("POLICY_DENIED");
	});

	test("test_items_shared_from_elsewhere_sit_in_folders_minerva_cannot_see", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, { [`${OTHER}:shared`]: ["read"] });
		const read = await items(run, "onedrive_read_file", { file_id: `${OTHER}:notes` });
		expect(read[0]?.text).toBe("Shared notes.");
		expect(read[0]?.parent_id).toBe(`${OTHER}:shared`);
		// Above the shared folder Graph refuses to look, so it might sit inside any denied folder.
		for (const grants of [{ [`${OTHER}:shared`]: ["read"] }, { "*": ["read"] }]) {
			run = await start(graph, grants, { ceiling: [ceilingRow("item", `${ME}:private`, "deny")] });
			expect(await run.code("onedrive_read_file", { file_id: `${OTHER}:notes` })).toBe("POLICY_DENIED");
		}
	});

	test("test_children_named_elsewhere_are_dropped_and_pages_follow", async () => {
		const graph = new FakeGraph();
		const stray = fileOf("stray", "stray.txt", ME, "private");
		graph.put(stray);
		graph.strays = [stray];
		graph.pageSize = 2;
		const run = await start(graph, { "*": ["read"] });
		const first = await run.ok("onedrive_list_folder", { folder_id: `${ME}:docs`, limit: 2 });
		expect((first.result.items as Item[]).map((item) => item.id)).toEqual([`${ME}:projects`, `${ME}:report`]);
		const second = await run.ok("onedrive_list_folder", { folder_id: `${ME}:docs`, limit: 2, cursor: first.result.next_cursor as Json });
		expect((second.result.items as Item[]).map((item) => item.id)).toEqual([`${ME}:deck`, `${ME}:sheet`]);
		const third = await run.ok("onedrive_list_folder", { folder_id: `${ME}:docs`, limit: 2, cursor: second.result.next_cursor as Json });
		expect(third.result.items).toEqual([]);
		expect(third.result.next_cursor ?? null).toBeNull();
		expect(graph.requests.at(-1)?.params.$skiptoken).toBe("4");
	});

	test("test_cycles_and_lookup_limits_leave_ancestry_partial", async () => {
		const graph = new FakeGraph();
		graph.put(folderOf("loop_a", "A", ME, "loop_b"));
		graph.put(folderOf("loop_b", "B", ME, "loop_a"));
		graph.put(fileOf("looped", "looped.txt", ME, "loop_a"));
		graph.contents.set("looped", text("looped"));
		// With no lookups, plan's folders are never resolved and the grant on Docs cannot be shown to cover it.
		const lookups = LIMITS.maxLookups;
		try {
			LIMITS.maxLookups = 0;
			let run = await start(graph, { [`${ME}:docs`]: ["read"] });
			expect(await run.code("onedrive_get_file", { file_id: `${ME}:plan` })).toBe("POLICY_DENIED");
			expect(await ids(run, "onedrive_get_file", { file_id: `${ME}:projects` })).toEqual([`${ME}:projects`]);
		} finally {
			LIMITS.maxLookups = lookups;
		}
		let run = await start(graph, { "*": ["read"] });
		expect(await ids(run, "onedrive_get_file", { file_id: `${ME}:looped` })).toEqual([`${ME}:looped`]);
		run = await start(graph, { "*": ["read"] }, { ceiling: [ceilingRow("item", `${ME}:elsewhere`, "deny")] });
		expect(await run.code("onedrive_get_file", { file_id: `${ME}:looped` })).toBe("POLICY_DENIED");
	});

	const moved: [string, Json][] = [
		["onedrive_read_file", { file_id: `${ME}:plan` }],
		["onedrive_list_folder", { folder_id: `${ME}:projects` }],
		["onedrive_create_file", { folder_id: `${ME}:projects`, name: "x.txt", content: "a" }],
	];
	for (const [tool, args] of moved) {
		test(`test_an_item_moved_while_the_call_runs_is_refused: ${tool}`, async () => {
			const graph = new FakeGraph();
			const run = await start(graph, { "*": ["read", "create"] }, { scopes: WRITE_SCOPES, ceiling: [ceilingRow("item", `${ME}:private`, "deny", ["read", "create"])] });
			const target = (((args as JsonObject).file_id ?? (args as JsonObject).folder_id) as string).split(":")[1] as string;
			graph.hook = (request) => {
				if (request.path.endsWith(`/items/${target}`) && graph.itemFetches(target).length === 2) {
					(graph.mine(target).parentReference as JsonObject).id = "private";
				}
				return null;
			};
			expect(await run.code(tool, args)).toBe("FILE_MOVED");
			expect(graph.requests.filter((request) => request.host !== "graph.microsoft.com" || request.path.endsWith("/children"))).toEqual([]);
			expect(graph.uploads).toEqual([]);
		});
	}
});

describe("search", () => {
	test("test_search_reads_each_hit_again_and_filters_it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [`${ME}:docs`]: ["read"] });
		let outcome = await run.ok("onedrive_search_files", { text: "t", limit: 3 });
		expect((outcome.result.items as Item[]).map((item) => item.id)).toEqual([`${ME}:projects`, `${ME}:plan`, `${ME}:report`]);
		expect(((graph.searches.at(-1)?.requests as JsonObject[])[0] as JsonObject).from).toBe(0);
		outcome = await run.ok("onedrive_search_files", { text: "t", limit: 3, cursor: outcome.result.next_cursor as Json });
		// The third hit of this page, Private, is left out.
		expect((outcome.result.items as Item[]).map((item) => item.id)).toEqual([`${ME}:deck`, `${ME}:sheet`]);
		expect(((graph.searches.at(-1)?.requests as JsonObject[])[0] as JsonObject).from).toBe(3);
		// What the search said about a hit is not trusted: it is read again by id.
		expect(graph.itemFetches("private").length).toBeGreaterThan(0);
	});

	test("test_personal_accounts_search_their_drive_and_ids_are_lower_case", async () => {
		const graph = new FakeGraph(true);
		const mine = PERSONAL.toLowerCase();
		const run = await start(graph, { [`${mine}:docs`]: ["read"] });
		let outcome = await run.ok("onedrive_search_files", { text: "it's plan" });
		expect(outcome.result.items).toEqual([]);
		expect(graph.requests[1]?.rawPath.startsWith("/v1.0/me/drive/search(q='it%27%27s%20plan')")).toBe(true);
		outcome = await run.ok("onedrive_search_files", { text: "plan" });
		expect((outcome.result.items as Item[]).map((item) => item.id)).toEqual([`${mine}:plan`]);
		// Another spelling of the drive id names the same file.
		outcome = await run.ok("onedrive_get_file", { file_id: `${PERSONAL}:plan` });
		expect((outcome.result.items as Item[]).map((item) => item.id)).toEqual([`${mine}:plan`]);
		expect(graph.searches).toEqual([]);
		expect(graph.requests.filter((request) => request.path.includes("followedSites"))).toEqual([]);
		// Only the spelling calls use can be allowed: a deny saved under another would never apply.
		const names = await onedriveConnector().describe(graph.client(), "item", [`${PERSONAL}:docs`, `${mine}:docs`]);
		expect(names).toEqual({ [`${mine}:docs`]: "Docs/" });
	});
});

describe("reading files", () => {
	test("test_reading_office_files", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] });
		const texts: { [name: string]: Json } = {};
		for (const name of ["report", "deck", "sheet"]) texts[name] = ((await items(run, "onedrive_read_file", { file_id: `${ME}:${name}` }))[0] as Item).text as Json;
		expect(texts).toEqual({
			report: "Hello\tworld\n",
			deck: "Slide 1\nAgenda\n\nSlide 2\nTitle\n",
			sheet: 'Name,,"a,b"\nAda,42,TRUE\n',
		});
		const cut = (await items(run, "onedrive_read_file", { file_id: `${ME}:deck`, max_chars: 9 }))[0] as Item;
		expect([cut.text, cut.truncated]).toEqual(["Slide 1\nA", true]);
	});

	test("test_downloads_send_no_token_and_only_go_to_microsoft", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] });
		await run.ok("onedrive_read_file", { file_id: `${ME}:plan` });
		const download = graph.requests.at(-1) as Received;
		expect(download.host).toBe("contoso.sharepoint.com");
		expect(download.headers.get("authorization")).toBeNull();
		for (const request of graph.requests.filter((request) => request.host !== download.host)) expect(request.headers.get("authorization")).toBe("Bearer token");

		graph.downloadHost = "contoso.sharepoint.com.evil.example";
		const count = graph.requests.length;
		expect(await run.code("onedrive_read_file", { file_id: `${ME}:plan` })).toBe("PROVIDER_FAILED");
		expect(graph.requests.slice(count).every((request) => request.host === "graph.microsoft.com")).toBe(true);

		graph.downloadHost = "contoso.sharepoint.com";
		for (const id of ["docs", "link"]) expect(await run.code("onedrive_read_file", { file_id: `${ME}:${id}` })).toBe("UNSUPPORTED_FILE");
		const plan = graph.mine("plan");
		(plan.file as JsonObject).mimeType = "application/pdf";
		plan.name = "plan.pdf";
		expect(await run.code("onedrive_read_file", { file_id: `${ME}:plan` })).toBe("UNSUPPORTED_FILE");
		const limit = LIMITS.maxOfficeBytes;
		try {
			LIMITS.maxOfficeBytes = 100;
			expect(await run.code("onedrive_read_file", { file_id: `${ME}:report` })).toBe("FILE_TOO_LARGE");
		} finally {
			LIMITS.maxOfficeBytes = limit;
		}
	});

	const hosts: [string, boolean][] = [
		["https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1", true],
		["https://contoso-my.sharepoint.com/personal/x/download", true],
		["https://public.am.files.1drv.com/y4m", true],
		["https://my.microsoftpersonalcontent.com/x", true],
		["http://contoso.sharepoint.com/x", false],
		["https://sharepoint.com/x", false],
		["https://evilsharepoint.com/x", false],
		["https://contoso.sharepoint.com.evil.example/x", false],
		["https://user@contoso.sharepoint.com/x", false],
		["https://contoso.sharepoint.com:8443/x", false],
		["https://contoso.sharepoint.com\\@evil.example/x", false],
		["https://contoso.sharepoint.com/x y", false],
		[`https://contoso.sharepoint.com/${"x".repeat(8000)}`, false],
		["file:///etc/passwd", false],
	];
	for (const [url, allowed] of hosts) {
		test(`test_download_hosts: ${url.slice(0, 60)}`, () => {
			expect(downloadAllowed(url)).toBe(allowed);
		});
	}
});

describe("creating files", () => {
	test("test_creating_needs_the_grant_and_write_consent", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, { [`${ME}:docs`]: ["read", "create"] });
		expect(run.tools).not.toContain("onedrive_create_file");
		expect(run.tools).toContain("onedrive_read_file");

		run = await start(graph, { [`${ME}:docs`]: ["read", "create"] }, { scopes: WRITE_SCOPES });
		const args = { folder_id: `${ME}:projects`, name: "Idea #1.md", content: "Zażółć\nline two" };
		const created = await items(run, "onedrive_create_file", args);
		expect(created).toHaveLength(1);
		expect([created[0]?.id, created[0]?.parent_id, created[0]?.type]).toEqual([`${ME}:new1`, `${ME}:projects`, "file"]);
		expect(graph.uploads).toHaveLength(1);
		const upload = graph.uploads[0] as Received;
		expect(upload.rawPath.startsWith("/v1.0/drives/b%21me/items/projects:/Idea%20%231.md:/content")).toBe(true);
		expect(upload.params["@microsoft.graph.conflictBehavior"]).toBe("fail");
		expect(upload.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(new TextDecoder().decode(graph.contents.get("new1"))).toBe("Zażółć\nline two");

		const taken = await run.error("onedrive_create_file", { ...args, name: "PLAN.txt" });
		expect([taken.code, taken.message.includes("already exists")]).toEqual(["PROVIDER_REJECTED", true]);
		expect(taken.message).not.toContain("Secret");
		for (const folder of [`${ME}:private`, "root"]) expect(await run.code("onedrive_create_file", { ...args, folder_id: folder })).toBe("POLICY_DENIED");
		expect(await run.code("onedrive_create_file", { ...args, folder_id: `${ME}:plan` })).toBe("UNSUPPORTED_FILE");
		expect(graph.uploads).toHaveLength(2);
		// A lone surrogate is refused as pydantic-core refuses it (string_unicode), before the size check could
		// encode it with U+FFFD; nothing is uploaded.
		const lone = await run.error("onedrive_create_file", { ...args, content: "a\ud800b" });
		expect(lone.message).toContain("content: Input should be a valid string, unable to parse raw data as a unicode string");
		expect(graph.uploads).toHaveLength(2);
	});

	const names = ["a/b.txt", "a:b", "what?", "trailing.", "CON", "con.txt", "Lpt1.md", "desktop.ini", "~$lock.docx", "x_vti_y", "a\nb"];
	for (const name of names) {
		test(`test_file_names_onedrive_refuses_are_refused_first: ${JSON.stringify(name)}`, async () => {
			const graph = new FakeGraph();
			const run = await start(graph, { [`${ME}:docs`]: ["read", "create"] }, { scopes: WRITE_SCOPES });
			expect(await run.code("onedrive_create_file", { folder_id: `${ME}:docs`, name, content: "x" })).toBe("INVALID_ARGUMENTS");
			expect(graph.uploads).toEqual([]);
		});
	}
});

describe("Office files", () => {
	const unreadable = (call: () => unknown) => {
		try {
			call();
		} catch (error) {
			if (error instanceof OperationError) return error.code;
			throw error;
		}
		return null;
	};

	test("test_office_files_that_declare_a_doctype_are_refused", () => {
		const bomb =
			'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
			`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>`;
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": bomb });
		expect(unreadable(() => extract("docx", data, 1000))).toBe("UNSUPPORTED_FILE");
	});

	test("test_office_archives_are_bounded", () => {
		const padding = " ".repeat(MAX_EXPANDED + 1);
		const expanding = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]),
			"word/document.xml": `<w:document xmlns:w="${W}">${padding}</w:document>`,
		});
		expect(expanding.length).toBeLessThan(1024 * 1024);
		expect(unreadable(() => extract("docx", expanding, 1000))).toBe("FILE_TOO_LARGE");

		const crowded = zipped(Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, n) => [`part${n}.xml`, ""])));
		expect(unreadable(() => extract("docx", crowded, 1000))).toBe("UNSUPPORTED_FILE");
		// A real document among too many parts is refused for their number alone.
		const document = { "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": "<d><p><t>crowd</t></p></d>" };
		const filler = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`part${n}.xml`, ""]));
		expect(extract("docx", zipped({ ...document, ...filler(MAX_ENTRIES - 2) }), 1000)).toBe("crowd\n");
		expect(unreadable(() => extract("docx", zipped({ ...document, ...filler(MAX_ENTRIES - 1) }), 1000))).toBe("UNSUPPORTED_FILE");

		for (const data of [text("not a zip"), zipped({ "word/document.xml": "<x/>" })]) expect(unreadable(() => extract("docx", data, 1000))).toBe("UNSUPPORTED_FILE");

		// Reading stops at the limit, however much text the file holds.
		const long = docx(`<w:p><w:r><w:t>${"word ".repeat(100_000)}</w:t></w:r></w:p>`);
		expect(extract("docx", long, 12)).toBe("word word wo");
	});

	test("test_excel_rows_are_cut_before_they_are_built", () => {
		// One long shared string in every cell of a row would make a row hundreds of megabytes long.
		const long = "x".repeat(3 * 1024 * 1024);
		const cells = '<c t="s"><v>0</v></c>'.repeat(200);
		const workbook = `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`;
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": workbook,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "sharedStrings", "sharedStrings.xml"]),
			"xl/sharedStrings.xml": `<sst xmlns="${S}"><si><t>${long}</t></si></sst>`,
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1">${cells}</row><row r="2">${cells}</row></sheetData></worksheet>`,
		});
		const before = process.memoryUsage().heapUsed;
		const started = performance.now();
		expect(extract("xlsx", data, 1000)).toBe("x".repeat(1000));
		// Python bounds the peak at 64 MiB; here the time and the heap growth stand for it.
		expect(performance.now() - started).toBeLessThan(10_000);
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024);

		// A row cut short still ends the text at the limit, so the caller sees it was truncated.
		const short = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": workbook,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row></sheetData></worksheet>`,
		});
		expect(extract("xlsx", short, 8)).toBe("12345,67");
		expect(extract("xlsx", short, 100)).toBe("12345,67890\n");
	});
});

describe("bounds the Python tests leave to the library (zip bombs and entity expansion)", () => {
	const nested = (levels: number) => {
		// A zip inside a zip is not opened: the reader only reads XML parts named by relationships.
		let data: Uint8Array = docx("<w:p><w:r><w:t>inner</w:t></w:r></w:p>");
		for (let n = 0; n < levels; n++) data = zipped({ "inner.zip": data });
		return data;
	};

	test("a zip inside a zip is not a Word file", () => {
		expect(() => extract("docx", nested(3), 1000)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_FILE" }));
	});

	test("an entity declared in a DOCTYPE is never expanded: the file is refused before any text is read", () => {
		const entities = Array.from({ length: 9 }, (_, n) => `<!ENTITY e${n + 1} "${`&e${n};`.repeat(10)}">`).join("");
		const laughs = `<!DOCTYPE d [<!ENTITY e0 "lol">${entities}]>`;
		const started = performance.now();
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `${laughs}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&e9;</w:t></w:r></w:p></w:body></w:document>` });
		expect(() => extract("docx", data, 1000)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_FILE" }));
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("a DOCTYPE the size of the whole budget is refused in bounded time", () => {
		const started = performance.now();
		const subset = `<!ENTITY a "${"a".repeat(1000)}">`.repeat(Math.floor(MAX_EXPANDED / 1030));
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `<!DOCTYPE d [${subset}]><d/>` });
		const code = (() => {
			try {
				extract("docx", data, 1000);
			} catch (error) {
				return (error as OperationError).code;
			}
			return null;
		})();
		expect(["UNSUPPORTED_FILE", "FILE_TOO_LARGE"]).toContain(code);
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	test("deep nesting is read in about linear time, with Python's text", () => {
		// Before: saxes walked every open element to resolve each prefix; 100,000 levels took about 30 seconds.
		const depth = 100_000;
		const plain = docx(`<w:p><w:r>${"<w:x>".repeat(depth)}<w:t>deep</w:t>${"</w:x>".repeat(depth)}</w:r></w:p><w:p><w:r><w:t>after</w:t></w:r></w:p>`);
		const started = performance.now();
		expect(extract("docx", plain, 1000)).toBe("deep\nafter\n");
		const declared = Array.from({ length: depth / 2 }, (_, i) => `<w:x xmlns:p${i}="urn:example:${i}">`).join("");
		expect(extract("docx", docx(`<w:p><w:r>${declared}<w:t>deep</w:t>${"</w:x>".repeat(depth / 2)}</w:r></w:p>`), 1000)).toBe("deep\n");
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("prefixes resolve as saxes resolves them when bindings are shadowed and restored", () => {
		const body =
			'<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p xmlns:w="urn:example:other"><w:r><w:t>hidden</w:t></w:r></w:p>' +
			`<w:p><w:r><w:t>two</w:t></w:r><x:r xmlns:x="${W}"><x:t>three</x:t></x:r></w:p><d xmlns="${W}"><p><r><t>four</t></r></p></d>`;
		expect(extract("docx", docx(body), 1000)).toBe("one\nhidden\ntwothree\nfour\n");
	});

	test("an unterminated DOCTYPE past the budget is refused as too large", () => {
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `<!DOCTYPE d [${" ".repeat(MAX_EXPANDED + 1)}` });
		expect(() => extract("docx", data, 1000)).toThrow(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
	});

	test("the expansion budget is shared by all the parts of a file", () => {
		const half = " ".repeat(MAX_EXPANDED / 2 + 1024);
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets>${half}</workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row><c><v>1</v></c></row></sheetData>${half}</worksheet>`,
		});
		expect(() => extract("xlsx", data, 1000)).toThrow(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
	});

	test("more than a thousand slides: the first thousand are read", () => {
		const count = MAX_SLIDES + 5;
		const parts: { [name: string]: string } = {
			"_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
			"ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${Array.from({ length: count }, (_, n) => `<p:sldId id="${n + 256}" r:id="r${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": rels(...Array.from({ length: count }, (_, n): [string, string, string] => [`r${n}`, "slide", `slides/s${n}.xml`])),
		};
		for (let n = 0; n < count; n++) parts[`ppt/slides/s${n}.xml`] = slide(`text ${n}`);
		const result = extract("pptx", zipped(parts), 10_000_000);
		expect(result.includes(`Slide ${MAX_SLIDES}\n`)).toBe(true);
		expect(result.includes(`Slide ${MAX_SLIDES + 1}\n`)).toBe(false);
	});

	test("more shared strings than the table holds are refused", () => {
		const strings = "<si/>".repeat(MAX_SHARED_STRINGS + 1);
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "sharedStrings", "sharedStrings.xml"]),
			"xl/sharedStrings.xml": `<sst xmlns="${S}">${strings}</sst>`,
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>`,
		});
		expect(() => extract("xlsx", data, 1000)).toThrow(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
	});

	test("a row has at most MAX_COLUMNS cells", () => {
		const cells = Array.from({ length: MAX_COLUMNS + 50 }, (_, n) => `<c><v>${n}</v></c>`).join("");
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row>${cells}</row></sheetData></worksheet>`,
		});
		const row = extract("xlsx", data, 1_000_000).trimEnd();
		expect(row.split(",")).toHaveLength(MAX_COLUMNS);
	});
});
