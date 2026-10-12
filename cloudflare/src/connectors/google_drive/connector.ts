// Google Drive, ported from backend/connectors/google_drive/connector.py. Resources are files and folders;
// what is allowed on a folder covers everything inside it.
//
// Each call resolves where the files it touches sit (their chain of parent folders) and hands that to the
// policy with each resource. Ancestry that cannot be resolved completely (a parent the account cannot see,
// a limit reached) is marked partial, and the policy then treats it conservatively. Ancestry is read when
// the call is prepared, and resolved again just before a folder is listed, a file is read, or a file is
// created: a call whose file moved in between is refused. What remains is the moment between that check
// and the provider call itself, which Drive offers no way to close.

import { z } from "zod";
import type { Binding, Connector, DiscoveryItem, DiscoveryPage, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { fromUtf8, utf8 } from "../../lib/bytes.ts";
import { isDict, type Json, type JsonObject, parseJson, visibleJson } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, codePointLength, isSingleLine, sliceCodePoints } from "../../lib/text.ts";
import { digitsOr, jsonInteger } from "../google/digits.ts";
import { oauth } from "../google/index.ts";
import { setOwn } from "../google/model.ts";
import { type DriveFile, FOLDER, GoogleDriveClient, SHORTCUT, isFolder, quoted } from "./client.ts";
import { extend } from "../../lib/arrays.ts";

export const FILE = "file";
export const READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const FULL_SCOPE = "https://www.googleapis.com/auth/drive";
export const READ_CONSENT = [[READ_SCOPE], [FULL_SCOPE]];
// Google's narrower drive.file scope cannot add files to folders Minerva did not create, so creating files
// needs the full scope. What agents may do stays limited by Minerva's permissions.
export const CREATE_CONSENT = [[FULL_SCOPE]];

export const ROOT = "root";
export const MAX_DEPTH = 32;
export const MAX_LOOKUPS = 150;
export const DESCRIBE_CONCURRENCY = 8;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const GOOGLE_DOC = "application/vnd.google-apps.document";
const EXPORTS: ReadonlyMap<string, string> = new Map([
	[GOOGLE_DOC, "text/plain"],
	["application/vnd.google-apps.spreadsheet", "text/csv"],
	["application/vnd.google-apps.presentation", "text/plain"],
]);
const TYPES: ReadonlyMap<string, string> = new Map([
	[FOLDER, "folder"],
	[SHORTCUT, "shortcut"],
	[GOOGLE_DOC, "document"],
	["application/vnd.google-apps.spreadsheet", "spreadsheet"],
	["application/vnd.google-apps.presentation", "presentation"],
]);
const TEXT_TYPES: ReadonlySet<string> = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/yaml",
	"application/x-yaml",
	"application/x-sh",
	"application/sql",
	"application/x-httpd-php",
]);

/** What a deployment fixes and Python's tests patch. */
export interface DriveLimits {
	maxDepth: number;
	maxLookups: number;
	maxExportBytes: number;
	maxTextBytes: number;
}

export interface DriveOptions {
	limits?: Partial<DriveLimits>;
	/** The tree a call resolves files with; tests give one that places files wrongly on purpose. */
	tree?: (client: GoogleDriveClient, limits: DriveLimits) => Tree;
	baseUrl?: string;
	uploadUrl?: string;
}

const FileId = () => strippedStr({ min: 1, max: 200 }).regex(/^[A-Za-z0-9_-]+$/);
const FolderId = () =>
	strippedStr({ min: 1, max: 200 })
		.regex(/^[A-Za-z0-9_-]+$/)
		.describe('A folder id, or "root" for My Drive.');
const Cursor = () => strippedStr({ max: 1000 });
const SingleLine = (limits: { min?: number; max?: number }) => strippedStr(limits).refine(isSingleLine, { message: SINGLE_LINE });

function moved(): OperationError {
	return new OperationError("FILE_MOVED", "This file or folder moved while Minerva was using it. Try again.");
}

/** Where files sit, resolved for one call. Parent lookups are cached and limited. */
export class Tree {
	readonly client: GoogleDriveClient;
	readonly limits: DriveLimits;
	knownRoot: string | null = null;
	readonly #files = new Map<string, DriveFile | null>();
	#lookups = 0;

	constructor(client: GoogleDriveClient, limits: DriveLimits) {
		this.client = client;
		this.limits = limits;
	}

	/** A new tree of the same kind for `confirm`, with no cached files, knowing the root. */
	fresh(): Tree {
		const made = new (this.constructor as new (client: GoogleDriveClient, limits: DriveLimits) => Tree)(this.client, this.limits);
		made.knownRoot = this.knownRoot;
		return made;
	}

	async root(): Promise<string> {
		this.knownRoot ??= await this.client.rootId();
		return this.knownRoot;
	}

	/** A file the call names. Files the account cannot see are refused like files without a grant. */
	async get(fileId: string): Promise<DriveFile> {
		const id = fileId === ROOT ? await this.root() : fileId;
		let file: DriveFile;
		try {
			file = await this.client.file(id);
		} catch (error) {
			if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
			throw error;
		}
		this.#files.set(file.id, file);
		return file;
	}

	/** Null when the account cannot see the folder, or the call looked up too many. */
	async parent(fileId: string): Promise<DriveFile | null> {
		if (this.#files.has(fileId)) return this.#files.get(fileId) ?? null;
		if (this.#lookups >= this.limits.maxLookups) return null;
		this.#lookups += 1;
		let parent: DriveFile | null;
		try {
			parent = await this.client.file(fileId);
		} catch (error) {
			if (!(error instanceof OperationError) || error.code !== "NOT_FOUND") throw error;
			parent = null;
		}
		this.#files.set(fileId, parent);
		return parent;
	}

	/** The file's ancestors, nearest first, and whether the chain is partial. */
	async place(file: DriveFile): Promise<[string[], boolean]> {
		const root = await this.root();
		const within: string[] = [];
		let current = file;
		for (;;) {
			if (current.id === root || (current.drive_id && current.id === current.drive_id)) return [within, false];
			const parents = current.parents ?? [];
			if (parents.length > 1) throw new OperationError("UNSUPPORTED_FILE", "This file is in several folders, which Minerva does not support.");
			// Shared with the account without its folder, or orphaned.
			if (parents.length === 0) return [within, true];
			const parentId = parents[0] as string;
			if (parentId === file.id || within.includes(parentId) || within.length >= this.limits.maxDepth) return [within, true];
			within.push(parentId);
			if (parentId === root || (current.drive_id && parentId === current.drive_id)) return [within, false];
			const parent = await this.parent(parentId);
			if (parent === null || parent.id !== parentId) return [within, true];
			current = parent;
		}
	}

	async resource(binding: Binding, file: DriveFile): Promise<Resource> {
		const [within, partial] = await this.place(file);
		return binding.resource(FILE, file.id, within, partial);
	}

	/** The file again, from Drive, refused if it moved since `resource` was authorized. */
	async confirm(resource: Resource): Promise<DriveFile> {
		const fresh = this.fresh();
		let file: DriveFile;
		try {
			file = await fresh.client.file(resource.id);
		} catch (error) {
			if (error instanceof OperationError && error.code === "NOT_FOUND") throw moved();
			throw error;
		}
		const [within, partial] = await fresh.place(file);
		const same = file.id === resource.id && partial === resource.partial && within.length === resource.within.length && within.every((id, i) => id === resource.within[i]);
		if (!same) throw moved();
		return file;
	}
}

function record(resource: Resource, file: DriveFile, extra: JsonObject = {}): ScopedRecord {
	const size = digitsOr(file.size, null);
	const shortcut = file.shortcut_details;
	return {
		resource,
		data: {
			id: file.id,
			name: file.name,
			type: TYPES.get(file.mime_type) ?? "file",
			mime_type: file.mime_type,
			size: size === null ? null : jsonInteger(size, "Google Drive"),
			modified_time: file.modified_time,
			link: file.web_view_link,
			parent_id: resource.within[0] ?? null,
			shared_drive_id: file.drive_id,
			trashed: file.trashed,
			shortcut_target_id: shortcut ? shortcut.target_id : null,
			...extra,
		},
	};
}

function nextCursor(token: string | null): string | null {
	if (token && codePointLength(token) > 1000) throw new OperationError("PROVIDER_LIMIT", "Google Drive returned a page token that is too long.");
	return token;
}

function isText(mimeType: string): boolean {
	return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
}

async function textOf(client: GoogleDriveClient, file: DriveFile, limits: DriveLimits): Promise<string> {
	if (file.mime_type === SHORTCUT) {
		const target = file.shortcut_details ? file.shortcut_details.target_id : null;
		throw new OperationError("UNSUPPORTED_FILE", `This is a shortcut. Read its target instead: file id ${target ?? "None"}.`);
	}
	if (file.capabilities && file.capabilities.can_download === false) throw new OperationError("PROVIDER_FORBIDDEN", "The owner of this file does not allow downloading it.");
	const exported = EXPORTS.get(file.mime_type);
	let body: Uint8Array;
	if (exported !== undefined) {
		body = await client.export(file.id, exported, limits.maxExportBytes);
	} else if (isText(file.mime_type)) {
		const size = digitsOr(file.size, null);
		if (size !== null && size > BigInt(limits.maxTextBytes)) throw new OperationError("FILE_TOO_LARGE", `Minerva reads text files up to ${limits.maxTextBytes} bytes.`);
		body = await client.content(file.id, limits.maxTextBytes);
	} else {
		throw new OperationError("UNSUPPORTED_FILE", "Minerva can read Google Docs, Sheets, Slides, and text files, not this type of file.");
	}
	return fromUtf8(body);
}

const ListFolder = z.strictObject({
	folder_id: FolderId(),
	limit: z.int().min(1).max(100).default(50),
	cursor: Cursor().nullable().default(null),
});
const SearchFiles = z.strictObject({
	text: SingleLine({ min: 1, max: 200 }),
	limit: z.int().min(1).max(50).default(20),
	cursor: Cursor().nullable().default(null),
});
const GetFile = z.strictObject({ file_id: FileId() });
const ReadFile = z.strictObject({ file_id: FileId(), max_chars: z.int().min(1).max(100_000).default(20_000) });
const CreateFile = z.strictObject({
	folder_id: FolderId(),
	name: SingleLine({ min: 1, max: 200 }),
	content: strippedStr({ max: MAX_UPLOAD_BYTES }).refine((value) => utf8(value).length <= MAX_UPLOAD_BYTES, {
		message: `must be at most ${MAX_UPLOAD_BYTES} bytes as UTF-8`,
	}),
	as_document: z.boolean().default(false).describe("Convert the text into a Google Doc instead of a plain text file."),
});

function sameKeys(value: JsonObject, keys: string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readCursor(cursor: string): Json | null {
	try {
		return parseJson(cursor);
	} catch {
		return null;
	}
}

interface DiscoveryState {
	phase: string;
	page: string | null;
}

function badCursor(): OperationError {
	return new OperationError("INVALID_CURSOR", "This page token is invalid.");
}

function discoveryState(cursor: string): DiscoveryState {
	const state = readCursor(cursor);
	if (
		state === null ||
		!isDict(state) ||
		!sameKeys(state, ["phase", "page"]) ||
		!["drives", "folders", "search"].includes(state.phase as string) ||
		!(typeof state.page === "string" || state.page === null)
	) {
		throw badCursor();
	}
	return { phase: state.phase as string, page: state.page };
}

function discoveryCursor(phase: string, page: string | null): string {
	return visibleJson({ phase, page: nextCursor(page) });
}

/** A browsing cursor, valid only for the parent it was issued for. */
function browseState(cursor: string, parent: string | null): DiscoveryState {
	const state = readCursor(cursor);
	const phases = parent === null ? ["drives", "shared"] : ["folders"];
	if (
		state === null ||
		!isDict(state) ||
		!sameKeys(state, ["phase", "page", "parent"]) ||
		!phases.includes(state.phase as string) ||
		state.parent !== parent ||
		!(typeof state.page === "string" || state.page === null)
	) {
		throw badCursor();
	}
	return { phase: state.phase as string, page: state.page };
}

function browseCursor(phase: string, page: string | null, parent: string | null): string {
	return visibleJson({ phase, page: nextCursor(page), parent });
}

function item(file: DriveFile): DiscoveryItem {
	return { id: file.id, name: isFolder(file) ? `${file.name}/` : file.name };
}

/**
 * Up to `limit` of `tasks` at once, results in order (an asyncio.Semaphore with gather). After the first
 * failure no task is started: gather lets the others finish, but their requests would go unread.
 */
async function gatherLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (next < tasks.length && !failed) {
			const index = next++;
			try {
				results[index] = await (tasks[index] as () => Promise<T>)();
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

/** Google Drive's connector (`GoogleDriveConnector`). */
export function googleDriveConnector(options: DriveOptions = {}): Connector<GoogleDriveClient> {
	const limits: DriveLimits = {
		maxDepth: MAX_DEPTH,
		maxLookups: MAX_LOOKUPS,
		maxExportBytes: MAX_EXPORT_BYTES,
		maxTextBytes: MAX_TEXT_BYTES,
		...options.limits,
	};
	const treeOf = (client: GoogleDriveClient): Tree => (options.tree ? options.tree(client, limits) : new Tree(client, limits));

	const operations = [
		defineOperation<z.output<typeof ListFolder>>({
			name: "list_folder",
			title: "List a folder",
			description:
				'List the files and folders inside one Google Drive folder. Use "root" for My Drive. To get the next page, repeat the call with identical arguments plus the returned next_cursor. Items you may not read are left out.',
			input: ListFolder,
			needs: [[FILE, "read"]],
			consent: READ_CONSENT,
			paginated: true,
			async prepare(binding, data): Promise<Prepared> {
				const tree = treeOf(binding.client as GoogleDriveClient);
				const resource = await tree.resource(binding, await tree.get(data.folder_id));
				return {
					requirements: [{ need: resource, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const folder = await tree.confirm(resource);
						if (!isFolder(folder)) throw new OperationError("UNSUPPORTED_FILE", "This is not a folder.");
						if (folder.capabilities && folder.capabilities.can_list_children === false) {
							throw new OperationError("PROVIDER_FORBIDDEN", "Google Drive does not let this account list this folder.");
						}
						const page = await tree.client.files(`${quoted(folder.id)} in parents and trashed = false`, {
							limit: data.limit,
							pageToken: data.cursor,
							driveId: folder.drive_id,
							orderBy: "folder,name",
						});
						const within = [folder.id, ...resource.within];
						const records = page.files
							// A child that does not name this folder as its only parent is not placed by this listing.
							.filter((child) => child.parents !== null && child.parents.length === 1 && child.parents[0] === folder.id)
							.map((child) => record(binding.resource(FILE, child.id, within, resource.partial), child));
						return { records, nextCursor: nextCursor(page.next_page_token), incomplete: page.incomplete_search };
					},
				};
			},
		}),
		defineOperation<z.output<typeof SearchFiles>>({
			name: "search_files",
			title: "Search files",
			description:
				"Search Google Drive by words: Google matches names that contain words starting with the text, and content that contains its words. Only files you may read are returned. incomplete: true means Google did not search every shared drive.",
			input: SearchFiles,
			needs: [[FILE, "read"]],
			consent: READ_CONSENT,
			paginated: true,
			async prepare(binding, data): Promise<Prepared> {
				const tree = treeOf(binding.client as GoogleDriveClient);
				return {
					requirements: [{ enumerate: FILE, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const text = quoted(data.text);
						const page = await tree.client.files(`(name contains ${text} or fullText contains ${text}) and trashed = false`, {
							limit: data.limit,
							pageToken: data.cursor,
							allDrives: true,
						});
						const records: ScopedRecord[] = [];
						for (const file of page.files) {
							let resource: Resource;
							try {
								resource = await tree.resource(binding, file);
							} catch (error) {
								if (!(error instanceof OperationError) || error.code !== "UNSUPPORTED_FILE") throw error;
								continue;
							}
							records.push(record(resource, file));
						}
						return { records, nextCursor: nextCursor(page.next_page_token), incomplete: page.incomplete_search };
					},
				};
			},
		}),
		defineOperation<z.output<typeof GetFile>>({
			name: "get_file",
			title: "Get file details",
			description: "Read the details of one Google Drive file or folder by id.",
			input: GetFile,
			needs: [[FILE, "read"]],
			consent: READ_CONSENT,
			async prepare(binding, data): Promise<Prepared> {
				const tree = treeOf(binding.client as GoogleDriveClient);
				const file = await tree.get(data.file_id);
				const resource = await tree.resource(binding, file);
				return {
					requirements: [{ need: resource, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						return { records: [record(resource, file)] };
					},
				};
			},
		}),
		defineOperation<z.output<typeof ReadFile>>({
			name: "read_file",
			title: "Read a file",
			description:
				"Read the text of one Google Drive file: Google Docs and Slides as plain text, the first sheet of Google Sheets as CSV, and text files. Other types (PDF, images) are not supported. Long text is cut at max_chars and marked truncated.",
			input: ReadFile,
			needs: [[FILE, "read"]],
			consent: READ_CONSENT,
			async prepare(binding, data): Promise<Prepared> {
				const tree = treeOf(binding.client as GoogleDriveClient);
				const resource = await tree.resource(binding, await tree.get(data.file_id));
				return {
					requirements: [{ need: resource, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const file = await tree.confirm(resource);
						const text = await textOf(tree.client, file, limits);
						const truncated = codePointLength(text) > data.max_chars;
						return { records: [record(resource, file, { text: sliceCodePoints(text, 0, data.max_chars), truncated })] };
					},
				};
			},
		}),
		defineOperation<z.output<typeof CreateFile>>({
			name: "create_file",
			title: "Create a file",
			description:
				'Create one text file, or a Google Doc with as_document, in a folder where you have create permission. Use "root" for My Drive. Everyone who can see the folder can see the file.',
			input: CreateFile,
			needs: [[FILE, "create"]],
			consent: CREATE_CONSENT,
			mutates: true,
			async prepare(binding, data): Promise<Prepared> {
				const tree = treeOf(binding.client as GoogleDriveClient);
				const resource = await tree.resource(binding, await tree.get(data.folder_id));
				return {
					requirements: [{ need: resource, action: "create" }],
					async execute(): Promise<ProviderOutput> {
						const folder = await tree.confirm(resource);
						if (!isFolder(folder)) throw new OperationError("UNSUPPORTED_FILE", "This is not a folder.");
						if (folder.capabilities && folder.capabilities.can_add_children === false) {
							throw new OperationError("PROVIDER_FORBIDDEN", "Google Drive does not let this account add files to this folder.");
						}
						const metadata: JsonObject = { name: data.name, parents: [folder.id] };
						if (data.as_document) metadata.mimeType = GOOGLE_DOC;
						const created = await tree.client.create(metadata, utf8(data.content));
						const within = [folder.id, ...resource.within];
						return { records: [record(binding.resource(FILE, created.id, within, resource.partial), created)] };
					},
				};
			},
		}),
	];

	return {
		slug: "google_drive",
		name: "Google Drive",
		kinds: [{ id: FILE, label: "File", actions: ["read", "create"], wildcard: true, hierarchical: true }],
		actions: [
			{ id: "read", label: "Read files" },
			{ id: "create", label: "Create files", requires: "read" },
		],
		// Reading is enough to connect; the scope for creating files is asked for once the user allows it.
		auth: oauth(READ_SCOPE),
		operations,
		browsable: [FILE],
		client: (secret, io) =>
			new GoogleDriveClient(secret, io, {
				...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
				...(options.uploadUrl === undefined ? {} : { uploadUrl: options.uploadUrl }),
			}),
		async account(client) {
			const user = await client.user();
			return { id: user.sub, label: user.email || user.name || "Google" };
		},
		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			let state = cursor ? discoveryState(cursor) : null;
			if (query || (state && state.phase === "search")) {
				if (!query) throw badCursor();
				const page = await client.files(`name contains ${quoted(query)} and trashed = false`, {
					limit: 100,
					pageToken: state ? state.page : null,
					allDrives: true,
					orderBy: "folder,name",
				});
				return { items: page.files.map(item), nextCursor: page.next_page_token ? discoveryCursor("search", page.next_page_token) : null };
			}
			const items: DiscoveryItem[] = [];
			if (state === null) {
				items.push({ id: await client.rootId(), name: "My Drive" });
				state = { phase: "drives", page: null };
			}
			if (state.phase === "drives") {
				const drives = await client.drives(state.page);
				extend(items, drives.drives.map((d) => ({ id: d.id, name: `${d.name} (shared drive)` })));
				if (drives.next_page_token) return { items, nextCursor: discoveryCursor("drives", drives.next_page_token) };
				return { items, nextCursor: discoveryCursor("folders", null) };
			}
			const page = await client.files(`mimeType = ${quoted(FOLDER)} and trashed = false`, {
				limit: 100,
				pageToken: state.page,
				allDrives: true,
				orderBy: "name",
			});
			extend(items, page.files.map(item));
			return { items, nextCursor: page.next_page_token ? discoveryCursor("folders", page.next_page_token) : null };
		},
		/**
		 * Folders only: My Drive, shared drives and folders shared with the account at the top, then the
		 * folders inside each. Files are found by searching.
		 */
		async children(client, _kind, parent, { cursor }): Promise<DiscoveryPage> {
			let state = cursor ? browseState(cursor, parent) : null;
			if (parent === null) {
				const items: DiscoveryItem[] = [];
				if (state === null) {
					items.push({ id: await client.rootId(), name: "My Drive", expandable: true });
					state = { phase: "drives", page: null };
				}
				if (state.phase === "drives") {
					const drives = await client.drives(state.page);
					extend(items, drives.drives.map((d) => ({ id: d.id, name: `${d.name} (shared drive)`, expandable: true })));
					const [phase, token] = drives.next_page_token ? ["drives", drives.next_page_token] : ["shared", null];
					return { items, nextCursor: browseCursor(phase, token, null) };
				}
				const page = await client.files(`sharedWithMe = true and mimeType = ${quoted(FOLDER)} and trashed = false`, {
					limit: 100,
					pageToken: state.page,
					orderBy: "name",
				});
				extend(items, page.files.map((f) => ({ id: f.id, name: `${f.name}/ (shared with you)`, expandable: true })));
				const token = page.next_page_token;
				return { items, nextCursor: token ? browseCursor("shared", token, null) : null };
			}
			const folder = await client.file(parent);
			if (!isFolder(folder)) throw new OperationError("UNSUPPORTED_FILE", "This is not a folder.");
			if (folder.capabilities && folder.capabilities.can_list_children === false) {
				throw new OperationError("PROVIDER_FORBIDDEN", "Google Drive does not let this account list this folder.");
			}
			const page = await client.files(`${quoted(folder.id)} in parents and mimeType = ${quoted(FOLDER)} and trashed = false`, {
				limit: 100,
				pageToken: state ? state.page : null,
				driveId: folder.drive_id,
				orderBy: "name",
			});
			const token = page.next_page_token;
			return {
				items: page.files.map((f) => ({ id: f.id, name: item(f).name, expandable: true })),
				nextCursor: token ? browseCursor("folders", token, parent) : null,
			};
		},
		async describe(client, _kind, ids) {
			const root = await client.rootId();
			const name = async (fileId: string): Promise<string | null> => {
				if (fileId === root) return "My Drive";
				let file: DriveFile;
				try {
					file = await client.file(fileId);
					if (file.drive_id && file.id === file.drive_id) return `${(await client.drive(file.id)).name} (shared drive)`;
				} catch (error) {
					if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN")) return null;
					throw error;
				}
				return item(file).name;
			};
			const names = await gatherLimited(
				ids.map((id) => () => name(id)),
				DESCRIBE_CONCURRENCY,
			);
			const out: { [id: string]: string } = {};
			ids.forEach((id, index) => {
				const found = names[index];
				if (found !== null && found !== undefined) setOwn(out, id, found);
			});
			return out;
		},
	};
}
