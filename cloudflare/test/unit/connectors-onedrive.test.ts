// The OneDrive and SharePoint connector against an in-memory Microsoft Graph and file host behind an injected
// `fetch`, and runs through the executor; its Office readers, download hosts, file kinds and tool inputs. Graph's
// paging, error classification and consent are tested with the shared base in connectors-microsoft.test.ts.

import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { DriveItem, downloadAllowed } from "../../src/connectors/onedrive/client.ts";
import { LIMITS, onedriveConnector, readable, searchCursor } from "../../src/connectors/onedrive/connector.ts";
import { MAX_COLUMNS, MAX_ENTRIES, MAX_EXPANDED, MAX_SHARED_STRINGS, MAX_SHARED_TEXT, MAX_SLIDES, extract } from "../../src/connectors/onedrive/office.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { type Received, received } from "../fixtures/connectors/microsoft/fake.ts";
import { ceilingRow, startRun, validated } from "./connector-runs.ts";
import { jsonResponse } from "./executor-fakes.ts";

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
 * Microsoft Graph's OneDrive and SharePoint API, and a file host.
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
	test("account discovery and names", async () => {
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
		// A name Graph leaves empty still names an item that exists.
		graph.mine("plan").name = "";
		expect(await connector.describe(client, "item", [`${ME}:plan`])).toEqual({ [`${ME}:plan`]: "" });
	});
});

describe("grants and the ancestry of items", () => {
	test("a grant on a folder covers everything inside it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [`${ME}:docs`]: ["read"] });
		const listed = await items(run, "onedrive_list_folder", { folder_id: `${ME}:docs` });
		expect(listed.map((item) => item.id)).toEqual([`${ME}:projects`, `${ME}:report`, `${ME}:deck`, `${ME}:sheet`]);
		expect(listed[0]?.parent_id).toBe(`${ME}:docs`);
		expect(listed[0]?.type).toBe("folder");
		const read = await items(run, "onedrive_read_file", { file_id: `${ME}:plan` });
		expect(read[0]?.text).toBe("The plan.");
		// Text files are UTF-8: a byte order mark is dropped, and bytes that are not UTF-8 are replaced.
		graph.contents.set("plan", Uint8Array.of(...text("a"), 0xff, ...text("b")));
		expect((await items(run, "onedrive_read_file", { file_id: `${ME}:plan` }))[0]?.text).toBe("a�b");
		for (const folder of ["root", `${ME}:private`, `${ME}:missing`, `${OTHER}:ghost`]) {
			expect(await run.code("onedrive_list_folder", { folder_id: folder })).toBe("POLICY_DENIED");
		}
		expect(await run.code("onedrive_get_file", { file_id: `${ME}:diary` })).toBe("POLICY_DENIED");
		expect(graph.requests.filter((request) => request.path.endsWith("/private/children"))).toEqual([]);
		expect(await items(run, "onedrive_list_libraries", {})).toEqual([]);
	});

	test("libraries and root under a wildcard with a deny below", async () => {
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

	test("a library grant covers the library only", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [`${TEAM}:root-team`]: ["read"] });
		expect(await ids(run, "onedrive_list_libraries", {})).toEqual([`${TEAM}:root-team`]);
		const read = await items(run, "onedrive_read_file", { file_id: `${TEAM}:handbook` });
		expect(read[0]?.text).toBe("# Handbook");
		expect(await run.code("onedrive_get_file", { file_id: `${ME}:docs` })).toBe("POLICY_DENIED");
	});

	test("items shared from elsewhere sit in folders Minerva cannot see", async () => {
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

	test("children named elsewhere are dropped and pages follow", async () => {
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

	test("cycles and lookup limits leave ancestry partial", async () => {
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
		test(`an item moved while the call runs is refused: ${tool}`, async () => {
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
	test("search reads each hit again and filters it", async () => {
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

	test("personal accounts search their drive and ids are lower case", async () => {
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
	test("reading Office files", async () => {
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

	test("downloads send no token and only go to Microsoft", async () => {
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

	test("downloads go only over HTTPS to Microsoft's file hosts, written as the URL parser reads them", () => {
		const allowed = [
		"https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1",
		"https://contoso-my.sharepoint.com/personal/x/download",
		"https://public.am.files.1drv.com/y4m",
		"https://my.microsoftpersonalcontent.com/x",
		"https://CONTOSO.SharePoint.COM/x",
		"HTTPS://contoso.sharepoint.com/x",
		"https://contoso.sharepoint.com:443/x",
		"https://contoso.sharepoint.com:/x",
		"https://a..sharepoint.com/x",
		"https://contoso.sharepoint.com",
		"https://contoso.sharepoint.com?x=1",
		"https://contoso.sharepoint.com#x",
		"https://@contoso.sharepoint.com/x",
		"https://contoso.sharepoint.com#@evil.example/x",
		"https://contoso.sharepoint.com?@evil.example/x",
		"https://evil.example;.sharepoint.com/x",
		"https://x.sharepoint.com/\u00e9",
		"https://x.sharepoint.com/%zz",
		"https://x.sharepoint.com/%",
		"https://x.sharepoint.com/\ud83d\ude00",
		"https://x.sharepoint.com:443/\u00e9",
		"https://127.0.0.1.sharepoint.com/x",
		"https://1.sharepoint.com/x",
		"https://x.1drv.com/x",
		"https://x.y.1drv.com/x",
		"https://x.microsoftpersonalcontent.com/x",
		"https://xn--e1afmkfd.sharepoint.com/x",
		"https://x.sharepoint.com/..%2f..%2f",
		"https://x.sharepoint.com/%2e%2e/",
		"https://x.sharepoint.com/;x",
		"https://x.sharepoint.com/\"",
		"https://x.sharepoint.com/<>",
		"https://x.sharepoint.com/{}",
		"https://x.sharepoint.com/|",
		"https://x.sharepoint.com/^",
		"https://x.sharepoint.com/`",
		"https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sharepoint.com/x",
		"https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sharepoint.com/x",
		`https://${"a".repeat(300)}.sharepoint.com/x`,
		"https://-x.sharepoint.com/x",
		"https://x-.sharepoint.com/x",
		"https://x_y.sharepoint.com/x",
		"https://x,y.sharepoint.com/x",
		"https://x!y.sharepoint.com/x",
		"https://x$y.sharepoint.com/x",
		"https://x&y.sharepoint.com/x",
		"https://x'y.sharepoint.com/x",
		"https://x(y).sharepoint.com/x",
		"https://x*y.sharepoint.com/x",
		"https://x+y.sharepoint.com/x",
		"https://x=y.sharepoint.com/x",
		"https://x~y.sharepoint.com/x",
		];
		// Lookalikes, credentials, percent escapes and Unicode in the host, odd ports and schemes, controls and
		// whitespace anywhere, and URLs the parser would change are all refused.
		const refused = [
		"http://contoso.sharepoint.com/x",
		"https://sharepoint.com/x",
		"https://evilsharepoint.com/x",
		"https://contoso.sharepoint.com.evil.example/x",
		"https://user@contoso.sharepoint.com/x",
		"https://contoso.sharepoint.com:8443/x",
		"https://contoso.sharepoint.com\\@evil.example/x",
		"https://contoso.sharepoint.com/x y",
		`https://contoso.sharepoint.com/${"x".repeat(8000)}`,
		"file:///etc/passwd",
		`https://contoso.sharepoint.com/${"x".repeat(7970)}`,
		"https://contoso.sharepoint.com:80/x",
		"https://contoso.sharepoint.com./x",
		"https://.sharepoint.com/x",
		"https://user:pw@contoso.sharepoint.com/x",
		"https://:@contoso.sharepoint.com/x",
		"https://evil.example@contoso.sharepoint.com/x",
		"https://contoso.sharepoint.com@evil.example/x",
		"https://contoso.sharepoint.com%40evil.example/x",
		"https://contoso.sharepoint.com%2f@evil.example/x",
		"https://evil.example/.sharepoint.com",
		"https://evil.example/x.sharepoint.com",
		"https://evil.example?.sharepoint.com",
		"https://evil.example#.sharepoint.com",
		"https://evil.example:80@x.sharepoint.com/x",
		"https://x.sharepoint.com:99999/x",
		"https:/contoso.sharepoint.com/x",
		"https:contoso.sharepoint.com/x",
		"https:///contoso.sharepoint.com/x",
		"https:////contoso.sharepoint.com/x",
		"https://\u2024contoso.sharepoint.com/x",
		"https://contoso\u3002sharepoint\u3002com/x",
		"https://contoso\uff0esharepoint\uff0ecom/x",
		"https://contoso.sharepoint.com\u3002/x",
		"https://contoso.\uff53harepoint.com/x",
		"https://contoso.sh\u00e4repoint.com/x",
		"https://x.sharepoint.com\u2215evil.example/x",
		"https://x.sharepoint.com\uff0fevil.example/x",
		"https://x.sharepoint.com\uff1fevil/x",
		"https://x.sharepoint.com\ufe55evil/x",
		"https://x.sharepoint.com%2Fevil.example/x",
		"https://x.sharepoint.com%5Cevil.example/x",
		"https://x.share%70oint.com/x",
		"https://x.sharepoint%2Ecom/x",
		"https://%78.sharepoint.com/x",
		"https://x.sharepoint.com%00.evil/x",
		"https://x.sharepoint.com%0a.evil/x",
		"https://x.sharepoint.com\t/x",
		"https://x.sharepoint.com\n/x",
		"https://x.sharepoint.com\r/x",
		"https://x.sharepoint.com\u0000/x",
		"https://x.sharepoint.com\u007f/x",
		"https://x.sharepoint.com/x\u007f",
		" https://x.sharepoint.com/x",
		"https://x.sharepoint.com/x ",
		"https://caf\u00e9.sharepoint.com/x",
		"https://CAF\u00c9.sharepoint.com/x",
		"https://contoso-\u212a.sharepoint.com/x",
		"https://[::1]/x",
		"https://[::1].sharepoint.com/x",
		"https://127.0.0.1/x",
		"https://0x7f.1/x",
		"https://2130706433/x",
		"https://x.sharepoint.com.attacker.example/x",
		"https://1drv.com/x",
		"https://.1drv.com/x",
		"https://x.1drv.com.evil/x",
		"https://microsoftpersonalcontent.com/x",
		"https://x-microsoftpersonalcontent.com/x",
		"https://x.sharepoint.cn/x",
		"https://x.sharepoint.us/x",
		"https://x.sharepoint.de/x",
		"https://x.sharepoint-df.com/x",
		"ftp://x.sharepoint.com/x",
		"wss://x.sharepoint.com/x",
		"//x.sharepoint.com/x",
		"x.sharepoint.com/x",
		"",
		"https://",
		"https://x",
		"https:",
		"https://x.sharepoint.com:0/x",
		"https://x.sharepoint.com:-1/x",
		"https://x.sharepoint.com:1_0/x",
		"https://x.sharepoint.com:\u0663/x",
		"https://x.sharepoint.com:443:443/x",
		"https://x.sharepoint.com:abc/x",
		"https://xn--.sharepoint.com/x",
		"https://xn--a.sharepoint.com/x",
		"https://x.sharepoint.com/\\x",
		"https://x y.sharepoint.com/x",
		"https://x<y.sharepoint.com/x",
		"https://x>y.sharepoint.com/x",
		"https://x[y.sharepoint.com/x",
		"https://x]y.sharepoint.com/x",
		"https://x^y.sharepoint.com/x",
		"https://x|y.sharepoint.com/x",
		];
		expect(allowed.filter((url) => !downloadAllowed(url))).toEqual([]);
		expect(refused.filter((url) => downloadAllowed(url))).toEqual([]);
	});
});
describe("creating files", () => {
	test("creating needs the grant and write consent", async () => {
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
		// A lone surrogate is refused before the size check could encode it as U+FFFD; nothing is uploaded.
		const lone = await run.error("onedrive_create_file", { ...args, content: "a\ud800b" });
		expect(lone.message).toBe("Invalid arguments. content: Invalid string: lone surrogate");
		expect(graph.uploads).toHaveLength(2);
	});

	const names = ["a/b.txt", "a:b", "what?", "trailing.", "CON", "con.txt", "Lpt1.md", "desktop.ini", "~$lock.docx", "x_vti_y", "a\nb"];
	for (const name of names) {
		test(`file names OneDrive refuses are refused first: ${JSON.stringify(name)}`, async () => {
			const graph = new FakeGraph();
			const run = await start(graph, { [`${ME}:docs`]: ["read", "create"] }, { scopes: WRITE_SCOPES });
			expect(await run.code("onedrive_create_file", { folder_id: `${ME}:docs`, name, content: "x" })).toBe("INVALID_ARGUMENTS");
			expect(graph.uploads).toEqual([]);
		});
	}
});

describe("Office files", () => {
	const unreadable = async (call: () => Promise<unknown>) => {
		try {
			await call();
		} catch (error) {
			if (error instanceof OperationError) return error.code;
			throw error;
		}
		return null;
	};

	test("Office files that declare a doctype are refused", async () => {
		const bomb =
			'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
			`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>`;
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": bomb });
		expect(await unreadable(() => extract("docx", data, 1000))).toBe("UNSUPPORTED_FILE");
	});

	test("office text is cut to a prefix, never splitting an emoji", async () => {
		const runs = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>ab😀</w:t></w:r><w:r><w:t>Z</w:t></w:r></w:p></w:body></w:document>`;
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": runs });
		const cuts = [];
		for (const limit of [2, 3, 4, 5]) cuts.push(await extract("docx", data, limit));
		expect(cuts).toEqual(["ab", "ab", "ab😀", "ab😀Z"]);
	});

	test("Office archives are bounded", async () => {
		const padding = " ".repeat(MAX_EXPANDED + 1);
		const expanding = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]),
			"word/document.xml": `<w:document xmlns:w="${W}">${padding}</w:document>`,
		});
		expect(expanding.length).toBeLessThan(1024 * 1024);
		expect(await unreadable(() => extract("docx", expanding, 1000))).toBe("FILE_TOO_LARGE");

		const crowded = zipped(Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, n) => [`part${n}.xml`, ""])));
		expect(await unreadable(() => extract("docx", crowded, 1000))).toBe("UNSUPPORTED_FILE");
		// A real document among too many parts is refused for their number alone.
		const document = { "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": "<d><p><t>crowd</t></p></d>" };
		const filler = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`part${n}.xml`, ""]));
		expect(await extract("docx", zipped({ ...document, ...filler(MAX_ENTRIES - 2) }), 1000)).toBe("crowd\n");
		expect(await unreadable(() => extract("docx", zipped({ ...document, ...filler(MAX_ENTRIES - 1) }), 1000))).toBe("UNSUPPORTED_FILE");

		for (const data of [text("not a zip"), zipped({ "word/document.xml": "<x/>" })]) expect(await unreadable(() => extract("docx", data, 1000))).toBe("UNSUPPORTED_FILE");

		// Reading stops at the limit, however much text the file holds.
		const long = docx(`<w:p><w:r><w:t>${"word ".repeat(100_000)}</w:t></w:r></w:p>`);
		expect(await extract("docx", long, 12)).toBe("word word wo");
	});

	test("Excel rows are cut before they are built", async () => {
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
		expect(await extract("xlsx", data, 1000)).toBe("x".repeat(1000));
		// The time and the heap growth stand for the peak memory.
		expect(performance.now() - started).toBeLessThan(10_000);
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024);

		// A row cut short still ends the text at the limit, so the caller sees it was truncated.
		const short = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": workbook,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row></sheetData></worksheet>`,
		});
		expect(await extract("xlsx", short, 8)).toBe("12345,67");
		expect(await extract("xlsx", short, 100)).toBe("12345,67890\n");
	});
	test("parts are read as UTF-8, or UTF-16 after a byte order mark; a declaration must name the same encoding", async () => {
		const body = "<w:p><w:r><w:t>Zażółć</w:t></w:r></w:p>";
		const xml = (declaration: string) => `${declaration}<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
		const word = (part: Uint8Array) => zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": part });
		const utf16 = (value: string, order: "le" | "be") => {
			const units = Buffer.from(`﻿${value}`, "utf16le");
			if (order === "be") units.swap16();
			return new Uint8Array(units);
		};
		const read = (part: Uint8Array) => extract("docx", word(part), 1000);
		expect(await read(text(xml('<?xml version="1.0" encoding="UTF-8"?>')))).toBe("Zażółć\n");
		expect(await read(text(`﻿${xml('<?xml version="1.0" encoding="utf8"?>')}`))).toBe("Zażółć\n");
		expect(await read(utf16(xml('<?xml version="1.0" encoding="UTF-16"?>'), "le"))).toBe("Zażółć\n");
		expect(await read(utf16(xml(""), "be"))).toBe("Zażółć\n");
		for (const part of [
			text(xml('<?xml version="1.0" encoding="ISO-8859-1"?>')),
			text(xml('<?xml version="1.0" encoding="us-ascii"?>')),
			text(xml('<?xml version="1.0" encoding="no-such-encoding"?>')),
			// A declaration too long for the first piece read is refused, not read past.
			text(xml(`<?xml version="1.0"${" ".repeat(70_000)}encoding="ISO-8859-1"?>`)),
			utf16(xml('<?xml version="1.0" encoding="UTF-8"?>'), "le"),
			new Uint8Array(Buffer.from(xml(""), "utf16le")),
			Uint8Array.from([...text(xml("")).slice(0, -20), 0xff, ...text(xml("")).slice(-20)]),
		]) {
			expect(await unreadable(() => read(part))).toBe("UNSUPPORTED_FILE");
		}
	});

	test("shared strings hold at most MAX_SHARED_TEXT units of text in all, phonetic readings not counted", async () => {
		const sheet = (...strings: string[]) =>
			zipped({
				"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
				"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
				"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "sharedStrings", "sharedStrings.xml"]),
				"xl/sharedStrings.xml": `<sst xmlns="${S}">${strings.map((text) => `<si>${text}</si>`).join("")}</sst>`,
				"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
			});
		const t = (length: number) => `<t>${"x".repeat(length)}</t>`;
		expect(await extract("xlsx", sheet(t(MAX_SHARED_TEXT)), 5)).toBe("xxxxx");
		expect(await unreadable(() => extract("xlsx", sheet(t(MAX_SHARED_TEXT + 1)), 5))).toBe("FILE_TOO_LARGE");
		expect(await unreadable(() => extract("xlsx", sheet(t(MAX_SHARED_TEXT / 2), t(MAX_SHARED_TEXT / 2 + 1)), 5))).toBe("FILE_TOO_LARGE");
		expect(await extract("xlsx", sheet(`<t>a</t><rPh>${t(MAX_SHARED_TEXT)}</rPh>`), 5)).toBe("a\n");
	});

	test("relationship targets resolve against the folder of their part, never above the archive's root", async () => {
		const document = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>found</w:t></w:r></w:p></w:body></w:document>`;
		for (const target of ["word/document.xml", "/word/document.xml", "./word/../word/document.xml", "../word/document.xml", "/../word/document.xml", "///word//document.xml"]) {
			const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", target]), "word/document.xml": document });
			expect(await extract("docx", data, 1000), target).toBe("found\n");
		}
		const deck = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
			"ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": rels(["rId2", "slide", "../shared/slide.xml"]),
			"shared/slide.xml": slide("Shared"),
		});
		expect(await extract("pptx", deck, 1000)).toBe("Slide 1\nShared\n");
	});
});

describe("bounds on zip bombs and entity expansion", () => {
	const nested = (levels: number) => {
		// A zip inside a zip is not opened: the reader only reads XML parts named by relationships.
		let data: Uint8Array = docx("<w:p><w:r><w:t>inner</w:t></w:r></w:p>");
		for (let n = 0; n < levels; n++) data = zipped({ "inner.zip": data });
		return data;
	};

	test("a zip inside a zip is not a Word file", async () => {
		await expect(extract("docx", nested(3), 1000)).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
	});

	test("an entity declared in a DOCTYPE is never expanded: the file is refused before any text is read", async () => {
		const entities = Array.from({ length: 9 }, (_, n) => `<!ENTITY e${n + 1} "${`&e${n};`.repeat(10)}">`).join("");
		const laughs = `<!DOCTYPE d [<!ENTITY e0 "lol">${entities}]>`;
		const started = performance.now();
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `${laughs}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&e9;</w:t></w:r></w:p></w:body></w:document>` });
		await expect(extract("docx", data, 1000)).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("a DOCTYPE the size of the whole budget is refused in bounded time", async () => {
		const started = performance.now();
		const subset = `<!ENTITY a "${"a".repeat(1000)}">`.repeat(Math.floor(MAX_EXPANDED / 1030));
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `<!DOCTYPE d [${subset}]><d/>` });
		const code = await (async () => {
			try {
				await extract("docx", data, 1000);
			} catch (error) {
				return (error as OperationError).code;
			}
			return null;
		})();
		expect(["UNSUPPORTED_FILE", "FILE_TOO_LARGE"]).toContain(code);
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	test("deep nesting is read in about linear time", async () => {
		// Before: saxes walked every open element to resolve each prefix; 100,000 levels took about 30 seconds.
		const depth = 100_000;
		const plain = docx(`<w:p><w:r>${"<w:x>".repeat(depth)}<w:t>deep</w:t>${"</w:x>".repeat(depth)}</w:r></w:p><w:p><w:r><w:t>after</w:t></w:r></w:p>`);
		const started = performance.now();
		expect(await extract("docx", plain, 1000)).toBe("deep\nafter\n");
		const declared = Array.from({ length: depth / 2 }, (_, i) => `<w:x xmlns:p${i}="urn:example:${i}">`).join("");
		expect(await extract("docx", docx(`<w:p><w:r>${declared}<w:t>deep</w:t>${"</w:x>".repeat(depth / 2)}</w:r></w:p>`), 1000)).toBe("deep\n");
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("prefixes resolve as saxes resolves them when bindings are shadowed and restored", async () => {
		const body =
			'<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p xmlns:w="urn:example:other"><w:r><w:t>hidden</w:t></w:r></w:p>' +
			`<w:p><w:r><w:t>two</w:t></w:r><x:r xmlns:x="${W}"><x:t>three</x:t></x:r></w:p><d xmlns="${W}"><p><r><t>four</t></r></p></d>`;
		expect(await extract("docx", docx(body), 1000)).toBe("one\nhidden\ntwothree\nfour\n");
	});

	test("an unterminated DOCTYPE past the budget is refused as too large", async () => {
		const data = zipped({ "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": `<!DOCTYPE d [${" ".repeat(MAX_EXPANDED + 1)}` });
		await expect(extract("docx", data, 1000)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
	});

	test("the expansion budget is shared by all the parts of a file", async () => {
		const half = " ".repeat(MAX_EXPANDED / 2 + 1024);
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets>${half}</workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row><c><v>1</v></c></row></sheetData>${half}</worksheet>`,
		});
		await expect(extract("xlsx", data, 1000)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
	});

	test("more than a thousand slides: the first thousand are read", async () => {
		const count = MAX_SLIDES + 5;
		const parts: { [name: string]: string } = {
			"_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
			"ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${Array.from({ length: count }, (_, n) => `<p:sldId id="${n + 256}" r:id="r${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": rels(...Array.from({ length: count }, (_, n): [string, string, string] => [`r${n}`, "slide", `slides/s${n}.xml`])),
		};
		for (let n = 0; n < count; n++) parts[`ppt/slides/s${n}.xml`] = slide(`text ${n}`);
		const result = await extract("pptx", zipped(parts), 10_000_000);
		expect(result.includes(`Slide ${MAX_SLIDES}\n`)).toBe(true);
		expect(result.includes(`Slide ${MAX_SLIDES + 1}\n`)).toBe(false);
	});

	test("more shared strings than the table holds are refused", async () => {
		const strings = "<si/>".repeat(MAX_SHARED_STRINGS + 1);
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "sharedStrings", "sharedStrings.xml"]),
			"xl/sharedStrings.xml": `<sst xmlns="${S}">${strings}</sst>`,
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>`,
		});
		await expect(extract("xlsx", data, 1000)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
	});

	test("a row has at most MAX_COLUMNS cells", async () => {
		const cells = Array.from({ length: MAX_COLUMNS + 50 }, (_, n) => `<c><v>${n}</v></c>`).join("");
		const data = zipped({
			"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
			"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
			"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row>${cells}</row></sheetData></worksheet>`,
		});
		const row = (await extract("xlsx", data, 1_000_000)).trimEnd();
		expect(row.split(",")).toHaveLength(MAX_COLUMNS);
	});
});

describe("file kinds, cursors and tool inputs", () => {
	test("a file is read as text, an Office format, or refused, by its type and then its extension", () => {
		const kind = (mime: string | null, name: string) => {
			try {
				return readable(DriveItem.parse({ id: "x", name, file: mime === null ? {} : { mimeType: mime } }));
			} catch (error) {
				if (error instanceof OperationError) return error.code;
				throw error;
			}
		};
		const BINARY = "application/octet-stream";
		const cases: [string | null, string, string][] = [
			["text/plain", "a.txt", "text"],
			["TEXT/PLAIN", "a", "text"],
			[" text/plain ", "a", "text"],
			[" text/plain", "a", "text"],
			["\ttext/plain\n", "a", "text"],
			["text/plain; charset=utf-8", "a", "text"],
			["text/plain;", "a", "text"],
			["text/", "a", "text"],
			["application/json", "a", "text"],
			["Application/JSON; x=y", "a", "text"],
			["application/xml", "a", "text"],
			["application/x-sh", "a", "text"],
			[DOCX, "a.bin", "docx"],
			[DOCX, "a.xlsx", "docx"],
			[PPTX, "a.txt", "pptx"],
			[XLSX.toUpperCase(), "a", "xlsx"],
			[`${XLSX}; charset=x`, "a", "xlsx"],
			["", "a.pptx", "pptx"],
			[null, "a.txt", "text"],
			[BINARY, "a.md", "text"],
			[BINARY, "a.Markdown", "text"],
			[BINARY, "x.HTM", "text"],
			[BINARY, "x...txt", "text"],
			[BINARY, "a.docx.txt", "text"],
			[BINARY, "a.txt.docx", "docx"],
			[BINARY, "a..docx", "docx"],
			[BINARY, "a.DOCX", "docx"],
			[BINARY, "a.xlsx", "xlsx"],
			["text", "a", "UNSUPPORTED_FILE"],
			[";text/plain", "a", "UNSUPPORTED_FILE"],
			["x;text/plain", "a", "UNSUPPORTED_FILE"],
			["İmage/png", "a", "UNSUPPORTED_FILE"],
			["application/pdf", "a.pdf", "UNSUPPORTED_FILE"],
			["application/vnd.openxmlformats-officedocument.spreadsheetml.template", "a", "UNSUPPORTED_FILE"],
			[null, "a", "UNSUPPORTED_FILE"],
			[BINARY, "a.xls", "UNSUPPORTED_FILE"],
			[BINARY, "a.doc", "UNSUPPORTED_FILE"],
			[BINARY, "x.tar.gz", "UNSUPPORTED_FILE"],
			[BINARY, ".docx", "UNSUPPORTED_FILE"],
			[BINARY, ".txt", "UNSUPPORTED_FILE"],
			[BINARY, "a.docx.", "UNSUPPORTED_FILE"],
			[BINARY, "a.docx ", "UNSUPPORTED_FILE"],
			[BINARY, "a. docx", "UNSUPPORTED_FILE"],
			[BINARY, "a.pptẋ", "UNSUPPORTED_FILE"],
			[BINARY, "a.Keys", "UNSUPPORTED_FILE"],
			[BINARY, "", "UNSUPPORTED_FILE"],
			[BINARY, "...", "UNSUPPORTED_FILE"],
		];
		expect(cases.map(([mime, name]) => [mime, name, kind(mime, name)])).toEqual(cases);
	});

	test("a search cursor is a JSON object holding only its page", () => {
		const page = (cursor: string) => {
			try {
				return searchCursor(cursor);
			} catch (error) {
				if (error instanceof OperationError) return error.code;
				throw error;
			}
		};
		const accepted: [string, string][] = [
			['{"page": "skip:3"}', "skip:3"],
			['{"page":"token:abc=="}', "token:abc=="],
			['{"page": ""}', ""],
			[' {"page": "a"} ', "a"],
			['{"page": "a", "page": "b"}', "b"],
			['{"\\u0070age": "a"}', "a"],
			[`{"page": "${"a".repeat(2000)}"}`, "a".repeat(2000)],
		];
		for (const [cursor, value] of accepted) expect(page(cursor), cursor).toBe(value);
		for (const cursor of [
			'{"page": 1}',
			'{"page": null}',
			'{"page": ["a"]}',
			"{}",
			'{"page": "a", "x": 1}',
			'{"__proto__": "a"}',
			'["page"]',
			'"page"',
			"null",
			"page",
			"",
			'{"page": "a"',
			'{"page": "a"}x',
			'{"page": "a",}',
			"{'page': 'a'}",
			'{"page": NaN}',
			'﻿{"page": "a"}',
			"[".repeat(100_000),
		]) {
			expect(page(cursor), cursor.slice(0, 40)).toBe("INVALID_CURSOR");
		}
	});

	const accepted: [string, Json, Json][] = [
		["list_libraries", {}, {}],
		["list_folder", { folder_id: " root " }, { folder_id: "root", limit: 50, cursor: null }],
		["list_folder", { folder_id: `${ME}:a.b-c_d=e!f`, limit: 100, cursor: " skip:3 " }, { folder_id: `${ME}:a.b-c_d=e!f`, limit: 100, cursor: "skip:3" }],
		["list_folder", { folder_id: `${ME}:${"a".repeat(200)}`, cursor: "x".repeat(1000) }, { folder_id: `${ME}:${"a".repeat(200)}`, limit: 50, cursor: "x".repeat(1000) }],
		["search_files", { text: " KQL \"quoted\" AND (x OR y) " }, { text: 'KQL "quoted" AND (x OR y)', limit: 10, cursor: null }],
		["search_files", { text: "a b", limit: 25, cursor: "skip:10" }, { text: "a b", limit: 25, cursor: "skip:10" }],
		["get_file", { file_id: "root" }, { file_id: "root" }],
		["read_file", { file_id: `${ME}:plan` }, { file_id: `${ME}:plan`, max_chars: 20000 }],
		["read_file", { file_id: `${ME}:plan`, max_chars: 100000 }, { file_id: `${ME}:plan`, max_chars: 100000 }],
		["create_file", { folder_id: `${ME}:docs`, name: " Idea #1.md ", content: " Zażółć\nline two\r\n" }, { folder_id: `${ME}:docs`, name: "Idea #1.md", content: "Zażółć\nline two" }],
		...["con .txt", "conx", "com10", "forms.txt", "Desktop.ini.txt", "a~$b", ".a", "K", "conİ", "COM¹", "ＣＯＮ", "é.txt", "\u{1f600}.txt"].map(
			(name): [string, Json, Json] => ["create_file", { folder_id: `${ME}:docs`, name, content: "" }, { folder_id: `${ME}:docs`, name, content: "" }],
		),
		...["x".repeat(1024 * 1024), "é".repeat(512 * 1024), "\u{1f600}".repeat(256 * 1024)].map(
			(content): [string, Json, Json] => ["create_file", { folder_id: `${ME}:docs`, name: "a.txt", content }, { folder_id: `${ME}:docs`, name: "a.txt", content }],
		),
	];
	for (const [tool, args, data] of accepted) {
		test(`${tool} accepts ${JSON.stringify(args).slice(0, 100)}`, async () => {
			expect(await validated(onedriveConnector(), tool, args)).toEqual({ ok: data });
		});
	}

	test("tool inputs refuse odd ids, limits, text, and the file names OneDrive and SharePoint refuse", async () => {
		const FILE = { folder_id: `${ME}:docs`, name: "a.txt", content: "x" };
		const refused: [string, Json, string][] = [
			["list_libraries", { x: 1 }, "x"],
			["list_libraries", [], "input"],
			...["ROOT", `${ME}:`, ":docs", `${ME}:a:b`, `${ME}:a b`, "b.me:docs", `${ME}:é`, `${ME}:٣`, `${ME}:${"a".repeat(201)}`, `${"a".repeat(201)}:docs`, "x".repeat(421)].map(
				(folder_id): [string, Json, string] => ["list_folder", { folder_id }, "folder_id"],
			),
			["list_folder", {}, "folder_id"],
			["list_folder", { folder_id: 5 }, "folder_id"],
			["list_folder", { folder_id: "root", limit: 0 }, "limit"],
			["list_folder", { folder_id: "root", limit: 101 }, "limit"],
			["list_folder", { folder_id: "root", limit: "5" }, "limit"],
			["list_folder", { folder_id: "root", limit: true }, "limit"],
			["list_folder", { folder_id: "root", cursor: "x".repeat(1001) }, "cursor"],
			["list_folder", { folder_id: "root", extra: 1 }, "extra"],
			...["", "  ", "a\nb", "a\tb", "a\u0000b", "x".repeat(201)].map((value): [string, Json, string] => ["search_files", { text: value }, "text"]),
			["search_files", { text: "plan", limit: 26 }, "limit"],
			["search_files", { text: null }, "text"],
			["get_file", { file_id: "b!me" }, "file_id"],
			["get_file", { file_id: "" }, "file_id"],
			["read_file", { file_id: `${ME}:plan`, max_chars: 0 }, "max_chars"],
			["read_file", { file_id: `${ME}:plan`, max_chars: 100001 }, "max_chars"],
			["read_file", { file_id: `${ME}:plan`, max_chars: 9.5 }, "max_chars"],
			["read_file", { file_id: `${ME}:plan`, max_chars: null }, "max_chars"],
			...[
				"a/b.txt", "a:b", "what?", 'a"b', "a*b", "a<b", "a>b", "a|b", "a\\b",
				"a\nb", "a\tb", "a\rb", "a\u0000b", "", " ", " ",
				"trailing.", "a..", ".", "..", "...", "CON", "con", "CON.", "con.txt", "Lpt1.md", "com0", "COM9.log", "lpt0", "LPT9", "Aux.tar.gz", "nul.", "prn",
				".lock", ".LOCK", "Forms", "desktop.ini", "desktop.INI", "~$", "~$a", "~$lock.docx", "_vti_", "_VTI_bin", "a_vTi_b", "x_vti_y", "x".repeat(256),
			].map((name): [string, Json, string] => ["create_file", { ...FILE, name }, "name"]),
			["create_file", { ...FILE, content: "x".repeat(1024 * 1024 + 1) }, "content"],
			["create_file", { ...FILE, content: "é".repeat(512 * 1024 + 1) }, "content: must be at most 1048576 bytes as UTF-8"],
			["create_file", { ...FILE, content: "\u{1f600}".repeat(256 * 1024 + 1) }, "content"],
			["create_file", { ...FILE, content: 5 }, "content"],
			["create_file", { folder_id: `${ME}:docs`, name: "a.txt" }, "content"],
		];
		const wrong = [];
		for (const [tool, args, named] of refused) {
			const result = await validated(onedriveConnector(), tool, args);
			if (!("refused" in result) || !result.refused.includes(named)) wrong.push([tool, JSON.stringify(args).slice(0, 80), result]);
		}
		expect(wrong).toEqual([]);
	});
});
