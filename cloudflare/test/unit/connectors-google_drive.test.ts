// backend/tests/test_google_drive.py, case by case: the connector against an in-memory Drive API behind an
// injected `fetch`, and runs through the executor. Where Python patches a module constant or Tree.place,
// the connector is built with that limit or a tree of its own.

import { describe, expect, test } from "vitest";
import { FOLDER, type GoogleDriveClient, SHORTCUT, quoted } from "../../src/connectors/google_drive/client.ts";
import { type DriveOptions, FULL_SCOPE, GOOGLE_DOC, READ_SCOPE, Tree, googleDriveConnector } from "../../src/connectors/google_drive/connector.ts";
import type { DriveFile } from "../../src/connectors/google_drive/client.ts";
import { fromUtf8 } from "../../src/lib/bytes.ts";
import type { Json } from "../../src/lib/json.ts";
import { parseJson } from "../../src/lib/json.ts";
import { CONNECTION, ceilingRow, jsonResponse, operation, requestOf, settingsClient, startRun, validationOutcomes } from "../fixtures/connectors/google/runs.ts";
import { type InputCase, vectors } from "../fixtures/connectors/google/vectors.ts";

const ROOT = "root0";
const BASE_SCOPES = ["openid", "email", READ_SCOPE];
const WRITE_SCOPES = [...BASE_SCOPES, FULL_SCOPE];
const DOC = "application/vnd.google-apps.document";

type JsonObject = { [key: string]: Json };

function file(id: string, name: string, mime: string, parents?: string[] | null, content?: string, extra: JsonObject = {}): JsonObject {
	const data: JsonObject = { id, name, mimeType: mime, ...extra };
	if (parents !== undefined && parents !== null) data.parents = parents;
	if (content !== undefined) data.size = String(new TextEncoder().encode(content).length);
	return data;
}

/**
 * Google Drive API v3 and the OpenID userinfo endpoint (test_google_drive.py `FakeDrive`).
 *
 * My Drive: docs/ (drafts/ (essay), notes.txt, shortcut to essay, multi), photo.png, private/ (diary).
 * Shared with the account without its folder: shared, and the folder club/. In a folder it cannot see:
 * orphan. Shared drive "Team": plan, minutes/.
 */
class FakeDrive {
	files: { [id: string]: JsonObject } = Object.fromEntries(
		[
			file(ROOT, "My Drive", FOLDER),
			file("docs", "Docs", FOLDER, [ROOT]),
			file("drafts", "Drafts", FOLDER, ["docs"]),
			file("essay", "Essay", DOC, ["drafts"]),
			file("notes", "notes.txt", "text/plain", ["docs"], "hello notes"),
			file("short", "Essay shortcut", SHORTCUT, ["docs"], undefined, { shortcutDetails: { targetId: "essay" } }),
			file("multi", "Twice", DOC, ["docs", "private"]),
			file("photo", "photo.png", "image/png", [ROOT], "PNG"),
			file("private", "Private", FOLDER, [ROOT]),
			file("diary", "Diary", DOC, ["private"]),
			file("shared", "Shared essay", DOC),
			file("orphan", "Orphan essay", DOC, ["ghost"]),
			file("team", "Drive", FOLDER, undefined, undefined, { driveId: "team" }),
			file("plan", "Plan", DOC, ["team"], undefined, { driveId: "team" }),
			file("minutes", "Minutes", FOLDER, ["team"], undefined, { driveId: "team" }),
			file("club", "Club", FOLDER, undefined, undefined, { sharedWithMe: true }),
		].map((f) => [f.id as string, f]),
	);
	contents: { [id: string]: string } = {
		essay: "An essay about essays.",
		notes: "hello notes",
		multi: "essay twice",
		diary: "Dear diary, essay.",
		shared: "A shared essay.",
		orphan: "An orphan essay.",
		plan: "The essay plan.",
	};
	drives = [{ id: "team", name: "Team" }];
	uploads: [URL, string][] = [];
	requests: URL[] = [];
	error: [number, Json] | null = null;
	hook: ((url: URL) => void) | null = null;
	handler: (request: Request) => Promise<Response> = (request) => this.handle(request);

	#query(q: string): JsonObject[] {
		const literal = String.raw`'((?:[^'\\]|\\.)*)'`;
		const text = (value: string) => value.replace(/\\(.)/g, "$1");
		const files = Object.values(this.files).filter((f) => f.id !== ROOT && f.id !== "team");
		const parentsOf = (f: JsonObject) => (f.parents as string[] | undefined) ?? [];
		let m: RegExpExecArray | null;
		if ((m = new RegExp(`^${literal} in parents and trashed = false$`).exec(q))) return files.filter((f) => parentsOf(f).includes(text(m?.[1] as string)));
		if ((m = new RegExp(`^${literal} in parents and mimeType = ${literal} and trashed = false$`).exec(q))) {
			const [parent, mime] = [text(m[1] as string), text(m[2] as string)];
			return files.filter((f) => parentsOf(f).includes(parent) && f.mimeType === mime);
		}
		if ((m = new RegExp(`^sharedWithMe = true and mimeType = ${literal} and trashed = false$`).exec(q))) {
			const mime = text(m[1] as string);
			return files.filter((f) => f.sharedWithMe && f.mimeType === mime);
		}
		if ((m = new RegExp(String.raw`^\(name contains ${literal} or fullText contains ${literal}\) and trashed = false$`).exec(q))) {
			const needle = text(m[1] as string).toLowerCase();
			return files.filter((f) => (f.name as string).toLowerCase().includes(needle) || (this.contents[f.id as string] ?? "").toLowerCase().includes(needle));
		}
		if ((m = new RegExp(`^mimeType = ${literal} and trashed = false$`).exec(q))) {
			const mime = text(m[1] as string);
			return files.filter((f) => f.mimeType === mime);
		}
		if ((m = new RegExp(`^name contains ${literal} and trashed = false$`).exec(q))) {
			const needle = text(m[1] as string).toLowerCase();
			return files.filter((f) => (f.name as string).toLowerCase().includes(needle));
		}
		throw new Error(`unexpected query ${q}`);
	}

	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		this.requests.push(url);
		this.hook?.(url);
		if (this.error) return jsonResponse(this.error[0], this.error[1]);
		if (url.host === "openidconnect.googleapis.com") return jsonResponse(200, { sub: "108", email: "ada@example.com" });
		const params = url.searchParams;
		const parts = url.pathname.split("/").slice(1);
		const path = parts.join("/");
		if (path === "upload/drive/v3/files") {
			const body = await request.text();
			this.uploads.push([url, body]);
			const boundary = (/boundary=(.+)$/.exec(request.headers.get("content-type") ?? "") as RegExpExecArray)[1] as string;
			const [, metadataPart, mediaPart] = body.split(`--${boundary}`) as [string, string, string];
			const metadata = parseJson(metadataPart.split("\r\n\r\n")[1]?.replace(/\r\n$/, "") as string) as JsonObject;
			const created = file(`new${this.uploads.length}`, metadata.name as string, (metadata.mimeType as string | undefined) ?? "text/plain");
			created.parents = metadata.parents as Json;
			this.files[created.id as string] = created;
			this.contents[created.id as string] = (mediaPart.split("\r\n\r\n").slice(1).join("\r\n\r\n") as string).replace(/\r\n$/, "");
			return jsonResponse(200, created);
		}
		if (path === "drive/v3/files") {
			const found = this.#query(params.get("q") as string);
			const start = Number((params.get("pageToken") ?? "p-0").replace(/^p-/, ""));
			const end = start + Number(params.get("pageSize"));
			const page: JsonObject = { files: found.slice(start, end), incompleteSearch: params.get("corpora") === "allDrives" };
			if (end < found.length) page.nextPageToken = `p-${end}`;
			return jsonResponse(200, page);
		}
		if (path === "drive/v3/files/root") return jsonResponse(200, { id: ROOT });
		if (parts.length === 4 && path.startsWith("drive/v3/files/") && Object.hasOwn(this.files, parts[3] as string)) {
			const id = parts[3] as string;
			if (params.get("alt") === "media") return new Response(this.contents[id] ?? "", { status: 200 });
			return jsonResponse(200, this.files[id]);
		}
		if (parts.length === 5 && parts[4] === "export" && Object.hasOwn(this.files, parts[3] as string)) return new Response(this.contents[parts[3] as string] ?? "", { status: 200 });
		if (path === "drive/v3/drives") return jsonResponse(200, { drives: this.drives });
		if (parts.length === 4 && path.startsWith("drive/v3/drives/")) return jsonResponse(200, this.drives.find((d) => d.id === parts[3]));
		return jsonResponse(404, { error: { code: 404, message: "File not found" } });
	}

	readonly fetch: typeof fetch = async (input, init) => this.handler(requestOf(input, init as RequestInit));

	client(): GoogleDriveClient {
		return settingsClient(googleDriveConnector(), this.fetch);
	}
}

function grants(files: { [id: string]: string[] }): { [key: string]: string[] } {
	return Object.fromEntries(Object.entries(files).map(([id, actions]) => [`file:${id}`, actions]));
}

function start(google: FakeDrive, scopes: string[], files: { [id: string]: string[] }, ceiling: ReturnType<typeof ceilingRow>[] = [], options: DriveOptions = {}, ceilingRestricted = false) {
	return startRun(googleDriveConnector(options), google.fetch, { scopes, grants: grants(files), ceiling, ceilingRestricted });
}

function ids(result: { items: { [key: string]: Json }[] }): Json[] {
	return result.items.map((item) => item.id as Json);
}

describe("the connector outside a run", () => {
	test("test_query_literals_are_escaped", () => {
		expect(quoted("it's")).toBe(String.raw`'it\'s'`);
		expect(quoted("a\\' or name contains '")).toBe(String.raw`'a\\\' or name contains \''`);
		for (const [text, expected] of Object.entries(vectors().drive.quoted as { [text: string]: string })) expect(quoted(text)).toBe(expected);
	});

	test("test_discovery_offers_my_drive_shared_drives_then_folders", async () => {
		const google = new FakeDrive();
		const connector = googleDriveConnector();
		const client = google.client();
		const first = await connector.discover(client, "file", { query: null, cursor: null });
		expect(first.items.map((i) => [i.id, i.name])).toEqual([
			[ROOT, "My Drive"],
			["team", "Team (shared drive)"],
		]);
		const second = await connector.discover(client, "file", { query: null, cursor: first.nextCursor ?? null });
		expect(second.items.map((i) => i.name)).toEqual(["Docs/", "Drafts/", "Private/", "Minutes/", "Club/"]);
		expect(second.nextCursor).toBeNull();
		const found = await connector.discover(client, "file", { query: "essay", cursor: null });
		expect(new Set(found.items.map((i) => i.id))).toEqual(new Set(["essay", "short", "shared", "orphan"]));
		for (const cursor of ['{"phase": "elsewhere"}', '{"phase": [], "page": null}', '{"phase": "folders"}', "[]"]) {
			await expect(connector.discover(client, "file", { query: null, cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		}
		expect(await connector.describe(client, "file", [ROOT, "team", "drafts", "gone"])).toEqual({ [ROOT]: "My Drive", team: "Team (shared drive)", drafts: "Drafts/" });
		// The cursor is Python's json.dumps.
		expect(first.nextCursor).toBe('{"phase": "folders", "page": null}');
	});

	test("test_browsing_lists_top_level_folders_then_what_is_inside", async () => {
		const google = new FakeDrive();
		const connector = googleDriveConnector();
		const client = google.client();
		const children = connector.children as NonNullable<typeof connector.children>;
		const first = await children(client, "file", null, { cursor: null });
		expect(first.items.map((i) => [i.id, i.name, i.expandable])).toEqual([
			[ROOT, "My Drive", true],
			["team", "Team (shared drive)", true],
		]);
		const second = await children(client, "file", null, { cursor: first.nextCursor ?? null });
		expect(second.items.map((i) => [i.id, i.name])).toEqual([["club", "Club/ (shared with you)"]]);
		expect(second.nextCursor).toBeNull();
		expect((await children(client, "file", ROOT, { cursor: null })).items.map((i) => i.name)).toEqual(["Docs/", "Private/"]);
		expect((await children(client, "file", "docs", { cursor: null })).items.map((i) => i.name)).toEqual(["Drafts/"]);
		const team = await children(client, "file", "team", { cursor: null });
		expect(team.items.map((i) => i.name)).toEqual(["Minutes/"]);
		const listing = google.requests.at(-1)?.searchParams as URLSearchParams;
		expect([listing.get("corpora"), listing.get("driveId")]).toEqual(["drive", "team"]);
		await expect(children(client, "file", "essay", { cursor: null })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
		// A cursor is only valid for the parent it was issued for.
		const issued = JSON.stringify({ phase: "folders", page: "p-1", parent: "docs" });
		for (const [parent, cursor] of [
			[ROOT, issued],
			[null, issued],
			["docs", first.nextCursor ?? null],
		] as [string | null, string][]) {
			await expect(children(client, "file", parent, { cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		}
	});

	test("test_the_settings_page_browses_drive_folders (the connector's part)", async () => {
		const google = new FakeDrive();
		const connector = googleDriveConnector();
		expect(connector.browsable).toEqual(["file"]);
		const client = google.client();
		const top = await (connector.children as NonNullable<typeof connector.children>)(client, "file", null, { cursor: null });
		expect(top.items.map((i) => [i.name, i.expandable])).toEqual([
			["My Drive", true],
			["Team (shared drive)", true],
		]);
		// Searching stays flat, and lists files too.
		const found = await connector.discover(client, "file", { query: "essay", cursor: null });
		expect(new Set(found.items.map((i) => i.id))).toEqual(new Set(["essay", "short", "shared", "orphan"]));
		expect(found.items.some((i) => i.expandable)).toBe(false);
	});

	test("the account is the OpenID subject", async () => {
		const google = new FakeDrive();
		expect(await googleDriveConnector().account(google.client())).toEqual({ id: "108", label: "ada@example.com" });
	});
});

describe("input validation, as Pydantic words it", () => {
	const connector = googleDriveConnector();
	const large: { [label: string]: string } = { "a*1048577": "a".repeat(1024 * 1024 + 1), "ż*524289": "ż".repeat(512 * 1024 + 1), "ż*524288": "ż".repeat(512 * 1024) };
	test("create_file", async () => {
		const cases = Object.fromEntries(
			Object.entries(vectors().drive.create_file as { [key: string]: { input: JsonObject } }).map(([key, item]) => [
				key,
				{ ...item, input: { ...item.input, content: large[item.input.content as string] ?? item.input.content } },
			]),
		);
		const { actual, expected } = await validationOutcomes(operation(connector, "create_file"), cases as { [key: string]: InputCase });
		const shown = (actual as { ok?: JsonObject }[]).map((item) => {
			if (!item.ok) return item;
			const label = Object.entries(large).find(([, value]) => value === item.ok?.content)?.[0];
			return label === undefined ? item : { ...item, ok: { ...item.ok, content: label } };
		});
		expect(shown).toEqual(expected);
	});
	for (const name of ["list_folder", "search_files", "read_file"]) {
		test(name, async () => {
			const { actual, expected } = await validationOutcomes(operation(connector, name), vectors().drive[name]);
			expect(actual).toEqual(expected);
		});
	}
});

describe("runs through the executor", () => {
	test("test_a_grant_on_a_folder_covers_everything_inside_it", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { docs: ["read"] });
		let outcome = await run.ok("google_drive_list_folder", { folder_id: "docs" });
		// "Twice" is also in Private, so this listing cannot place it.
		expect(ids(outcome.result)).toEqual(["drafts", "notes", "short"]);
		expect(outcome.result.items[1]?.parent_id).toBe("docs");
		outcome = await run.ok("google_drive_list_folder", { folder_id: "drafts" });
		expect(ids(outcome.result)).toEqual(["essay"]);
		outcome = await run.ok("google_drive_read_file", { file_id: "essay" });
		expect(outcome.result.items[0]?.text).toBe("An essay about essays.");
		for (const denied of [{ folder_id: "root" }, { folder_id: "private" }, { folder_id: "missing" }]) {
			expect(await run.code("google_drive_list_folder", denied)).toBe("POLICY_DENIED");
		}
		expect(google.requests.filter((r) => (r.searchParams.get("q") ?? "").startsWith(quoted("private")))).toEqual([]);
	});

	test("test_root_names_my_drive_and_a_deny_on_a_subfolder_hides_it", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { "*": ["read"] }, [ceilingRow(CONNECTION, "file", "drafts", "deny")]);
		expect(ids((await run.ok("google_drive_list_folder", { folder_id: "root" })).result)).toEqual(["docs", "photo", "private"]);
		expect(ids((await run.ok("google_drive_list_folder", { folder_id: "docs" })).result)).toEqual(["notes", "short"]);
		expect(await run.code("google_drive_read_file", { file_id: "essay" })).toBe("POLICY_DENIED");
		// The shared drive is listed within that drive only.
		await run.ok("google_drive_list_folder", { folder_id: "team" });
		const params = google.requests.at(-1)?.searchParams as URLSearchParams;
		expect([params.get("corpora"), params.get("driveId"), params.get("supportsAllDrives")]).toEqual(["drive", "team", "true"]);
	});

	test("test_search_results_are_filtered_by_where_they_sit", async () => {
		const google = new FakeDrive();
		let run = await start(google, BASE_SCOPES, { "*": ["read"] });
		let outcome = await run.ok("google_drive_search_files", { text: "essay" });
		// Files whose folders cannot be seen are readable under a wildcard; the file in two folders never is.
		expect(new Set(ids(outcome.result))).toEqual(new Set(["essay", "short", "diary", "shared", "orphan", "plan"]));
		expect(outcome.result.incomplete).toBe(true);
		expect(google.requests.filter((r) => r.pathname.endsWith("/files")).map((r) => r.searchParams.get("corpora"))).toEqual(["allDrives"]);

		run = await start(google, BASE_SCOPES, { "*": ["read"] }, [ceilingRow(CONNECTION, "file", "private", "deny")]);
		outcome = await run.ok("google_drive_search_files", { text: "essay" });
		// With an exact deny somewhere, files with unknown folders might be inside it, so they are left out.
		expect(new Set(ids(outcome.result))).toEqual(new Set(["essay", "short", "plan"]));

		run = await start(google, BASE_SCOPES, { docs: ["read"] });
		outcome = await run.ok("google_drive_search_files", { text: "it's" });
		expect(outcome.result.items).toEqual([]);
		expect(google.requests.at(-1)?.searchParams.get("q")).toBe(String.raw`(name contains 'it\'s' or fullText contains 'it\'s') and trashed = false`);
	});

	test("test_too_many_folder_lookups_leave_ancestry_partial", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { docs: ["read"] }, [], { limits: { maxLookups: 0 } });
		const outcome = await run.ok("google_drive_search_files", { text: "essay" });
		// "short" is directly in docs, which needs no lookup; essay's folder "drafts" is never looked up.
		expect(ids(outcome.result)).toEqual(["short"]);
	});

	test("test_nested_grants_on_two_layers_offer_the_tools", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { drafts: ["read"] }, [ceilingRow(CONNECTION, "file", "docs", "allow")], {}, true);
		expect(run.tools).toContain("google_drive_search_files");
		expect(ids((await run.ok("google_drive_list_folder", { folder_id: "drafts" })).result)).toEqual(["essay"]);
		expect(await run.code("google_drive_list_folder", { folder_id: "docs" })).toBe("POLICY_DENIED");
	});

	test("test_reading_files", async () => {
		const google = new FakeDrive();
		let run = await start(google, BASE_SCOPES, { "*": ["read"] });
		const notes = await run.ok("google_drive_read_file", { file_id: "notes", max_chars: 5 });
		expect([notes.result.items[0]?.text, notes.result.items[0]?.truncated]).toEqual(["hello", true]);
		expect(google.requests.at(-1)?.searchParams.get("alt")).toBe("media");
		const essay = await run.ok("google_drive_read_file", { file_id: "essay" });
		expect(essay.result.items[0]?.truncated).toBe(false);
		expect(google.requests.at(-1)?.pathname.endsWith("/files/essay/export")).toBe(true);
		expect(google.requests.at(-1)?.searchParams.get("mimeType")).toBe("text/plain");
		for (const [fileId, message] of [
			["photo", "not this type"],
			["short", "file id essay"],
		] as const) {
			const error = await run.error("google_drive_read_file", { file_id: fileId });
			expect(error.code).toBe("UNSUPPORTED_FILE");
			expect(error.message).toContain(message);
		}
		(google.files.essay as JsonObject).capabilities = { canDownload: false };
		expect(await run.code("google_drive_read_file", { file_id: "essay" })).toBe("PROVIDER_FORBIDDEN");
		// Sizes are enforced while streaming, whatever the metadata says.
		run = await start(google, BASE_SCOPES, { "*": ["read"] }, [], { limits: { maxExportBytes: 8 } });
		expect(await run.code("google_drive_read_file", { file_id: "diary" })).toBe("FILE_TOO_LARGE");
	});

	test("test_creating_needs_the_grant_and_full_drive_consent", async () => {
		const google = new FakeDrive();
		let run = await start(google, BASE_SCOPES, { docs: ["read", "create"] });
		expect(run.tools).not.toContain("google_drive_create_file");
		expect(run.tools).toContain("google_drive_read_file");

		run = await start(google, WRITE_SCOPES, { docs: ["read", "create"] });
		const args = { folder_id: "drafts", name: "Idea", content: "Zażółć\nline two", as_document: true };
		const outcome = await run.ok("google_drive_create_file", args);
		const [created] = outcome.result.items;
		expect([created?.id, created?.parent_id, created?.type]).toEqual(["new1", "drafts", "document"]);
		const [[upload, body]] = google.uploads as [[URL, string]];
		expect(upload.searchParams.get("uploadType")).toBe("multipart");
		expect(upload.searchParams.get("ignoreDefaultVisibility")).toBe("true");
		expect(upload.searchParams.get("supportsAllDrives")).toBe("true");
		expect(google.files.new1?.mimeType).toBe(GOOGLE_DOC);
		expect(google.contents.new1).toBe("Zażółć\nline two");
		// The metadata part is Python's json.dumps, non-ASCII escaped.
		expect(body).toContain('{"name": "Idea", "parents": ["drafts"], "mimeType": "application/vnd.google-apps.document"}');

		expect(await run.code("google_drive_create_file", { ...args, folder_id: "private" })).toBe("POLICY_DENIED");
		expect(await run.code("google_drive_create_file", { ...args, folder_id: "notes" })).toBe("UNSUPPORTED_FILE");
		expect(google.uploads.length).toBe(1);
	});

	const invalid = [
		{ folder_id: "docs", name: "x", content: "a".repeat(1024 * 1024 + 1) },
		{ folder_id: "docs", name: "x", content: "ż".repeat(512 * 1024 + 1) },
		{ folder_id: "docs", name: "bad\nname", content: "a" },
		{ folder_id: "../docs", name: "x", content: "a" },
		{ folder_id: "docs", name: "", content: "a" },
	];
	invalid.forEach((args, index) => {
		test(`test_create_arguments_are_validated[${index}]`, async () => {
			const google = new FakeDrive();
			const run = await start(google, WRITE_SCOPES, { docs: ["read", "create"] });
			expect(await run.code("google_drive_create_file", args)).toBe("INVALID_ARGUMENTS");
			expect(google.requests).toEqual([]);
		});
	});

	test("test_a_disabled_drive_api_is_reported", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { "*": ["read"] });
		google.error = [403, { error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }];
		expect(await run.code("google_drive_get_file", { file_id: "essay" })).toBe("PROVIDER_NOT_CONFIGURED");
	});

	test("test_malformed_ancestry_is_a_connector_error", async () => {
		const google = new FakeDrive();
		class WildcardAncestor extends Tree {
			override async place(): Promise<[string[], boolean]> {
				return [["*"], false];
			}
		}
		let run = await start(google, BASE_SCOPES, { "*": ["read"] }, [], { tree: (client, limits) => new WildcardAncestor(client, limits) });
		expect(await run.code("google_drive_get_file", { file_id: "essay" })).toBe("CONNECTOR_ERROR");
		// Records with malformed ancestry are dropped.
		expect((await run.ok("google_drive_search_files", { text: "essay" })).result.items).toEqual([]);

		class SelfAncestor extends Tree {
			override async place(found: DriveFile): Promise<[string[], boolean]> {
				return [[found.id], false];
			}
		}
		run = await start(google, BASE_SCOPES, { "*": ["read"] }, [], { tree: (client, limits) => new SelfAncestor(client, limits) });
		expect((await run.ok("google_drive_search_files", { text: "essay" })).result.items).toEqual([]);
	});

	const moves: [string, JsonObject][] = [
		["google_drive_read_file", { file_id: "essay" }],
		["google_drive_list_folder", { folder_id: "drafts" }],
		["google_drive_create_file", { folder_id: "drafts", name: "x", content: "a" }],
	];
	for (const [tool, args] of moves) {
		test(`test_a_file_moved_while_the_call_runs_is_refused: ${tool}`, async () => {
			const google = new FakeDrive();
			const run = await start(google, WRITE_SCOPES, { "*": ["read", "create"] }, [ceilingRow(CONNECTION, "file", "private", "deny", ["read", "create"])]);
			const moved = (args.file_id ?? args.folder_id) as string;
			// Moves the file into Private just before Drive answers the second request for it.
			let fetches = 0;
			google.hook = (url) => {
				if (url.pathname.endsWith(`/files/${moved}`) && !url.searchParams.has("alt")) {
					fetches += 1;
					if (fetches === 2) (google.files[moved] as JsonObject).parents = ["private"];
				}
			};
			expect(await run.code(tool, args)).toBe("FILE_MOVED");
			expect(google.requests.filter((r) => r.searchParams.has("alt") || r.pathname.endsWith("/export") || r.pathname.endsWith("/files"))).toEqual([]);
			expect(google.uploads).toEqual([]);
		});
	}

	test("test_cycles_and_deep_trees_are_partial", async () => {
		const google = new FakeDrive();
		google.files.loop_a = file("loop_a", "A", FOLDER, ["loop_b"]);
		google.files.loop_b = file("loop_b", "B", FOLDER, ["loop_a"]);
		google.files.looped = file("looped", "Looped essay", "text/plain", ["loop_a"], "essay");
		google.contents.looped = "essay";
		let run = await start(google, BASE_SCOPES, { "*": ["read"] });
		expect(ids((await run.ok("google_drive_search_files", { text: "looped" })).result)).toContain("looped");
		run = await start(google, BASE_SCOPES, { "*": ["read"] }, [ceilingRow(CONNECTION, "file", "elsewhere", "deny")]);
		// The loop never reaches My Drive, so any exact deny might be above it.
		expect(ids((await run.ok("google_drive_search_files", { text: "looped" })).result)).toEqual([]);
		expect(await run.code("google_drive_read_file", { file_id: "looped" })).toBe("POLICY_DENIED");

		run = await start(google, BASE_SCOPES, { "*": ["read"] }, [ceilingRow(CONNECTION, "file", "elsewhere", "deny")], { limits: { maxDepth: 1 } });
		// essay sits two folders below My Drive.
		expect(ids((await run.ok("google_drive_search_files", { text: "An essay about" })).result)).toEqual([]);
	});

	for (const [mime, exported] of [
		["application/vnd.google-apps.spreadsheet", "text/csv"],
		["application/vnd.google-apps.presentation", "text/plain"],
	]) {
		test(`test_sheets_and_slides_are_exported_as_text: ${mime}`, async () => {
			const google = new FakeDrive();
			(google.files.essay as JsonObject).mimeType = mime as string;
			const run = await start(google, BASE_SCOPES, { "*": ["read"] });
			const outcome = await run.ok("google_drive_read_file", { file_id: "essay" });
			expect(outcome.result.items[0]?.text).toBe("An essay about essays.");
			expect(google.requests.at(-1)?.searchParams.get("mimeType")).toBe(exported);
		});
	}

	test("test_a_failed_download_is_reported_without_reading_it_all", async () => {
		const google = new FakeDrive();
		const run = await start(google, BASE_SCOPES, { "*": ["read"] });
		const original = google.handler;
		google.handler = async (request) => {
			if (new URL(request.url).pathname.endsWith("/export")) {
				return jsonResponse(403, { error: { code: 403, errors: [{ reason: "exportSizeLimitExceeded" }] } }, { "x-extra": "y" });
			}
			return original(request);
		};
		expect(await run.code("google_drive_read_file", { file_id: "essay" })).toBe("FILE_TOO_LARGE");
	});

	test("an upload's multipart body names its boundary and carries the text as sent", async () => {
		const google = new FakeDrive();
		const run = await start(google, WRITE_SCOPES, { docs: ["read", "create"] });
		await run.ok("google_drive_create_file", { folder_id: "docs", name: "plain", content: "one\r\ntwo" });
		const [[, body]] = google.uploads as [[URL, string]];
		const boundary = /^--(minerva-[0-9a-f]{32})\r\n/.exec(body)?.[1] as string;
		expect(body).toBe(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name": "plain", "parents": ["docs"]}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\none\r\ntwo\r\n--${boundary}--`,
		);
		expect(fromUtf8(new TextEncoder().encode(google.contents.new1))).toBe("one\r\ntwo");
	});
});
