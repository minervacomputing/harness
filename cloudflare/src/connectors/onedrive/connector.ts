// OneDrive and SharePoint. Resources are files and
// folders in drives: the account's OneDrive, and SharePoint document libraries. What is allowed on a folder
// covers everything inside it, and a library's root folder stands for the whole library.
//
// A resource id joins the drive and item ids Graph uses (`{drive}:{item}`). Every id a call names is looked up
// first, and the resource is built from what Graph answers, so another spelling of an id resolves to the same
// resource. Personal drive ids are hexadecimal and Graph spells them in either case, so they are kept in lower
// case. Only that spelling can be allowed or denied: `describe` leaves out any other.
//
// Each call resolves the chain of parent folders up to the drive's root and hands it to the policy with the
// resource. Ancestry that cannot be resolved completely (a parent the account cannot open, as for an item
// someone shared from their own OneDrive; a parent in another drive; a limit reached) is marked partial, and
// the policy then treats it conservatively. Ancestry is read when the call is prepared, and resolved again
// just before a folder is listed, a file is read, or a file is created: a call whose item moved in between is
// refused. What remains is the moment between that check and the provider call itself, which Graph offers no
// way to close.
//
// An item that points to another drive's item (a shared folder added to a personal OneDrive) is listed with
// its target's id, and is otherwise refused: the target is reached by its own id, in its own drive.
//
// Sites are not resources: their libraries are. Without a search, the libraries offered are those of the
// SharePoint sites the account follows.
//
// Office files are read in the Worker (office.ts), within its limits.

import { z } from "zod";
import {
	type Binding,
	type Connector,
	OperationError,
	type Prepared,
	type ProviderOutput,
	type ScopedRecord,
	defineOperation,
	denied,
} from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { decodeText } from "../../lib/bytes.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { sliceText, TextError } from "../../lib/text.ts";
import { TENANCY, accountLabel, consent, oauth, pageParam } from "../microsoft/index.ts";
import { after, singleLineOf } from "../microsoft/inputs.ts";
import { mapLimited } from "../microsoft/limit.ts";
import { DriveClient, type DriveItem } from "./client.ts";
import { type Kind, extract, isKind } from "./office.ts";

export const ITEM = "item";
export const READ_CONSENT = consent("Files.Read.All", "Files.ReadWrite.All");
export const WRITE_CONSENT = consent("Files.ReadWrite.All");

export const ROOT = "root";
export const CONCURRENCY = 8;
export const MAX_DESCRIBE = 200;
export const MAX_SITES = 25;
export const MAX_SITE_LIBRARIES = 20;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024;
/** Mutable for tests only. */
export const LIMITS = { maxDepth: 32, maxLookups: 150, maxOfficeBytes: 10 * 1024 * 1024 };
const PERSONAL_DRIVE = /^[0-9A-Fa-f]{16}$/;
const DRIVE_PART = "[A-Za-z0-9!_=-]{1,200}";
const ITEM_PART = "[A-Za-z0-9!_.=-]{1,200}";
const DRIVE_FULL = new RegExp(`^${DRIVE_PART}$`);
const ITEM_FULL = new RegExp(`^${ITEM_PART}$`);
const ITEM_ID = new RegExp(`^(${DRIVE_PART}):(${ITEM_PART})$`);
const OFFICE: ReadonlyMap<string, Kind> = new Map([
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
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
]);
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".txt",
	".md",
	".markdown",
	".csv",
	".tsv",
	".json",
	".xml",
	".yaml",
	".yml",
	".html",
	".htm",
	".log",
	".ini",
	".toml",
	".rst",
	".py",
	".js",
	".ts",
	".sql",
	".sh",
]);
/** Characters OneDrive and SharePoint refuse in names, and names they reserve. */
const INVALID_NAME = /["*:<>?/\\|]/;
const DEVICES: ReadonlySet<string> = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 10 }, (_, n) => `com${n}`), ...Array.from({ length: 10 }, (_, n) => `lpt${n}`)]);
const RESERVED_NAMES: ReadonlySet<string> = new Set([".lock", "desktop.ini", "forms"]);

function driveKey(driveId: string): string {
	return PERSONAL_DRIVE.test(driveId) ? driveId.toLowerCase() : driveId;
}

function key(driveId: string, itemId: string): string {
	return `${driveKey(driveId)}:${itemId}`;
}

function split(resourceId: string): [string, string] {
	const match = ITEM_ID.exec(resourceId);
	if (match === null) throw denied();
	return [match[1] as string, match[2] as string];
}

function driveOf(client: DriveClient, item: DriveItem): string {
	const drive = item.parentReference ? item.parentReference.driveId : null;
	if (!drive || !DRIVE_FULL.test(drive) || !ITEM_FULL.test(item.id)) throw client.unexpected();
	return driveKey(drive);
}

/** The id of the item another drive's item this one points to, if it does. */
function target(item: DriveItem): string | null {
	const remote = item.remoteItem;
	const ref = remote ? remote.parentReference : null;
	if (remote === null || ref === null || !remote.id || !ref.driveId) return null;
	const found = key(ref.driveId, remote.id);
	return ITEM_ID.test(found) ? found : null;
}

function moved(): OperationError {
	return new OperationError("FILE_MOVED", "This file or folder moved while Minerva was using it. Try again.");
}

function unseen(error: unknown): boolean {
	return error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN" || error.code === "PROVIDER_REJECTED");
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Where items sit, resolved for one call. Parent lookups are cached and limited. */
class Tree {
	readonly client: DriveClient;
	readonly #items = new Map<string, DriveItem | null>();
	#lookups = 0;

	constructor(client: DriveClient) {
		this.client = client;
	}

	key(item: DriveItem): string {
		return `${driveOf(this.client, item)}:${item.id}`;
	}

	/** An item the call names. Items the account cannot open are refused like items without a grant. */
	async get(itemId: string): Promise<DriveItem> {
		let item: DriveItem;
		try {
			item = itemId === ROOT ? await this.client.myRoot() : await this.client.item(...split(itemId));
		} catch (error) {
			if (unseen(error)) throw denied();
			throw error;
		}
		this.#items.set(this.key(item), item);
		return item;
	}

	/** Null when the account cannot open the folder, or the call looked up too many. */
	async #parent(driveId: string, itemId: string): Promise<DriveItem | null> {
		const found = key(driveId, itemId);
		if (this.#items.has(found)) return this.#items.get(found) ?? null;
		if (this.#lookups >= LIMITS.maxLookups) return null;
		this.#lookups++;
		let parent: DriveItem | null;
		try {
			parent = await this.client.item(driveId, itemId);
		} catch (error) {
			if (!unseen(error)) throw error;
			parent = null;
		}
		this.#items.set(found, parent);
		return parent;
	}

	/** The item's ancestors, nearest first, and whether the chain is partial. */
	async place(item: DriveItem): Promise<[string[], boolean]> {
		const own = this.key(item);
		const drive = driveOf(this.client, item);
		const within: string[] = [];
		let current = item;
		for (;;) {
			if (current.root !== null) return [within, false];
			const ref = current.parentReference;
			if (ref === null || !ref.id || !ref.driveId || driveKey(ref.driveId) !== drive) return [within, true];
			const parentKey = key(drive, ref.id);
			if (parentKey === own || within.includes(parentKey) || within.length >= LIMITS.maxDepth) return [within, true];
			if (!ITEM_ID.test(parentKey)) return [within, true];
			within.push(parentKey);
			const parent = await this.#parent(drive, ref.id);
			if (parent === null || this.key(parent) !== parentKey) return [within, true];
			current = parent;
		}
	}

	async resource(binding: Binding, item: DriveItem): Promise<Resource> {
		const [within, partial] = await this.place(item);
		return binding.resource(ITEM, this.key(item), within, partial);
	}

	/** The item again, from Graph, refused if it moved since `resource` was authorized. */
	async confirm(resource: Resource): Promise<DriveItem> {
		const fresh = new Tree(this.client);
		let item: DriveItem;
		try {
			item = await fresh.client.item(...split(resource.id));
		} catch (error) {
			if (unseen(error)) throw moved();
			throw error;
		}
		const [within, partial] = await fresh.place(item);
		if (fresh.key(item) !== resource.id || !sameList(within, resource.within) || partial !== resource.partial) throw moved();
		return item;
	}
}

function typeOf(item: DriveItem): string {
	if (item.root !== null) return "library";
	if (item.remoteItem !== null) return "shortcut";
	if (item.folder !== null) return "folder";
	if (item.package !== null) return "package";
	return "file";
}

function record(resource: Resource, item: DriveItem, extra: { [key: string]: Json } = {}): ScopedRecord {
	return {
		resource,
		data: {
			id: resource.id,
			name: item.name,
			type: typeOf(item),
			mime_type: item.file ? item.file.mimeType : null,
			size: item.size,
			modified_time: item.lastModifiedDateTime,
			link: item.webUrl,
			parent_id: resource.within.length ? (resource.within[0] as string) : null,
			target_id: target(item),
			...extra,
		},
	};
}

function folderOf(item: DriveItem): DriveItem {
	if (item.remoteItem !== null) throw new OperationError("UNSUPPORTED_FILE", `This points to an item in another drive. Use its id instead: ${target(item)}.`);
	if (item.folder === null && item.root === null) throw new OperationError("UNSUPPORTED_FILE", "This is not a folder.");
	return item;
}

const ID_PATTERN = new RegExp(`^(${ROOT}|${DRIVE_PART}:${ITEM_PART})$`);
const ItemId = () => z.string().trim().max(420).regex(ID_PATTERN).describe("A file's id from a record.");
const FolderId = () => z.string().trim().max(420).regex(ID_PATTERN).describe('A folder\'s or library\'s id from a record, or "root" for your own OneDrive.');
const Cursor = () => z.string().trim().max(1000);

function clientOf(binding: Binding): DriveClient {
	return binding.client as DriveClient;
}

/**
 * The root folders of the account's OneDrive and of the libraries of the SharePoint sites it
 * follows, each with a name, and whether sites were left out.
 */
async function libraries(client: DriveClient): Promise<[[DriveItem, string][], boolean]> {
	const found: [DriveItem, string][] = [];
	const mine = await client.myDrive();
	if (mine !== null) {
		found.push([await client.myRoot(), "OneDrive"]);
		if (mine.driveType === "personal") return [found, false];
	}
	let sites: Awaited<ReturnType<DriveClient["followedSites"]>>[0];
	let more: boolean;
	try {
		[sites, more] = await client.followedSites(MAX_SITES);
	} catch (error) {
		if (!unseen(error)) throw error;
		return [found, true];
	}
	const perSite = await mapLimited(sites, CONCURRENCY, async (site) => {
		try {
			return await client.libraries(site.id, MAX_SITE_LIBRARIES);
		} catch (error) {
			if (!unseen(error)) throw error;
			return [];
		}
	});
	const named = sites.flatMap((site, index) =>
		(perSite[index] ?? []).filter((drive) => drive.driveType === "documentLibrary").map((drive) => [drive, `${site.displayName || site.name || "Site"} / ${drive.name}`] as const),
	);
	const roots = await mapLimited(named, CONCURRENCY, async ([drive]) => {
		try {
			return await client.driveRoot(drive.id);
		} catch (error) {
			if (!unseen(error)) throw error;
			return null;
		}
	});
	const seen = new Set(found.map(([item]) => `${driveOf(client, item)}:${item.id}`));
	roots.forEach((item, index) => {
		if (item === null) return;
		const id = `${driveOf(client, item)}:${item.id}`;
		if (seen.has(id)) return;
		seen.add(id);
		found.push([item, (named[index] as readonly [unknown, string])[1]]);
	});
	return [found, more];
}

export const ListLibraries = z.strictObject({});

const LIST_LIBRARIES = defineOperation<z.output<typeof ListLibraries>>({
	name: "list_libraries",
	title: "List libraries",
	description:
		"List where files live: your own OneDrive, and the document libraries of the SharePoint sites " +
		`you follow (up to ${MAX_SITES} sites). Libraries you may not read are left out; you may still ` +
		"have access to folders inside them, which list_folder and search_files reach. incomplete: true " +
		"means sites were left out: you follow more than were listed, or Microsoft did not let Minerva " +
		"list them. search_files still finds files in them.",
	input: ListLibraries,
	needs: [[ITEM, "read"]],
	// Not Sites.Read.All, which Microsoft leaves out of personal accounts' tokens: a refused lookup of followed
	// sites leaves them out (`libraries`), so reading files never waits on a scope the account cannot be given.
	consent: READ_CONSENT,
	async prepare(binding): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		return {
			requirements: [{ enumerate: ITEM, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const [found, more] = await libraries(tree.client);
				const records = found.map(([item, name]) => record(binding.resource(ITEM, tree.key(item), [], false), item, { name }));
				return { records, incomplete: more };
			},
		};
	},
});

export const ListFolder = z
	.strictObject({
		folder_id: FolderId(),
		limit: z.int().min(1).max(100).default(50),
		cursor: Cursor().nullable().default(null),
	});

const LIST_FOLDER = defineOperation<z.output<typeof ListFolder>>({
	name: "list_folder",
	title: "List a folder",
	description:
		'List the files and folders inside one folder or library. Use "root" for your own OneDrive. ' +
		"An item of type shortcut points to an item in another drive: use its target_id. Items you may " +
		"not read are left out. To get the next page, repeat the call with identical arguments plus the " +
		"returned next_cursor.",
	input: ListFolder,
	needs: [[ITEM, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		const folder = await tree.get(data.folder_id);
		const resource = await tree.resource(binding, folder);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const current = folderOf(await tree.confirm(resource));
				const drive = driveOf(tree.client, current);
				const [children, cursor] = await tree.client.children(drive, current.id, data.limit, data.cursor);
				const within = [resource.id, ...resource.within];
				const records = children
					// A child that does not name this folder as its parent is not placed by this listing.
					.filter(
						(child) =>
							child.parentReference !== null &&
							child.parentReference.id === current.id &&
							driveKey(child.parentReference.driveId || "") === drive &&
							ITEM_ID.test(key(drive, child.id)),
					)
					.map((child) => record(binding.resource(ITEM, key(drive, child.id), within, resource.partial), child));
				return { records, nextCursor: cursor };
			},
		};
	},
});

export const SearchFiles = z
	.strictObject({
		text: singleLineOf(z.string().trim().min(1).max(200)),
		limit: z.int().min(1).max(25).default(10),
		cursor: Cursor().nullable().default(null),
	});

/** The ids of the items a search hits, in Microsoft's order, and the next page's cursor. */
async function search(client: DriveClient, text: string, limit: number, cursor: string | null): Promise<[string[], string | null]> {
	const mine = await client.myDrive();
	let items: DriveItem[];
	let next: string | null;
	if (mine !== null && mine.driveType === "personal") {
		[items, next] = await client.searchPersonal(text, limit, cursor);
	} else {
		let offset = 0;
		if (cursor !== null) {
			const skip = pageParam(cursor).$skip;
			if (skip === undefined) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
			offset = Number(skip);
		}
		let more: boolean;
		[items, more] = await client.searchWork(text, offset, limit);
		next = more ? `skip:${offset + limit}` : null;
	}
	const ids: string[] = [];
	for (const item of items) {
		let found = target(item);
		if (found === null) {
			const drive = item.parentReference ? item.parentReference.driveId : null;
			found = drive ? key(drive, item.id) : null;
		}
		if (found && ITEM_ID.test(found) && !ids.includes(found)) ids.push(found);
	}
	return [ids, next];
}

const SEARCH_FILES = defineOperation<z.output<typeof SearchFiles>>({
	name: "search_files",
	title: "Search files",
	description:
		"Search files and folders by words in their names and content: for work and school accounts " +
		"across OneDrive, SharePoint and what was shared with you (Microsoft Search, which accepts KQL); " +
		"for personal accounts in your OneDrive and what was shared with you. Only items you may read " +
		"are returned, so a page may have fewer results than limit. To get the next page, repeat the " +
		"call with identical arguments plus the returned next_cursor.",
	input: SearchFiles,
	needs: [[ITEM, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		return {
			requirements: [{ enumerate: ITEM, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const [ids, next] = await search(tree.client, data.text, data.limit, data.cursor);
				const records: ScopedRecord[] = [];
				for (const itemId of ids) {
					// Each hit is read again by id: what the search said about it is not relied on.
					let item: DriveItem;
					try {
						item = await tree.get(itemId);
					} catch (error) {
						if (!(error instanceof OperationError) || error.code !== "POLICY_DENIED") throw error;
						continue;
					}
					records.push(record(await tree.resource(binding, item), item));
				}
				return { records, nextCursor: next };
			},
		};
	},
});

export const GetFile = z.strictObject({ file_id: ItemId() });

const GET_FILE = defineOperation<z.output<typeof GetFile>>({
	name: "get_file",
	title: "Get file details",
	description: "Read the details of one file, folder or library by id.",
	input: GetFile,
	needs: [[ITEM, "read"]],
	consent: READ_CONSENT,
	async prepare(binding, data): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		const item = await tree.get(data.file_id);
		const resource = await tree.resource(binding, item);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				return { records: [record(resource, item)] };
			},
		};
	},
});

export const ReadFile = z
	.strictObject({
		file_id: ItemId(),
		max_chars: z.int().min(1).max(100_000).default(20_000),
	});

/** A file name's extension in lower case, with its dot: none for a name that only starts with a dot. */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** How a file is read, "text" or the Office format whose text is extracted. */
export function readable(item: DriveItem): Kind | "text" {
	if (item.remoteItem !== null) throw new OperationError("UNSUPPORTED_FILE", `This points to an item in another drive. Use its id instead: ${target(item)}.`);
	if (item.file === null) throw new OperationError("UNSUPPORTED_FILE", "This is not a file.");
	const mime = ((item.file.mimeType || "").split(";")[0] as string).trim().toLowerCase();
	const extension = extensionOf(item.name);
	const office = OFFICE.get(mime);
	if (office !== undefined) return office;
	const bare = extension.startsWith(".") ? extension.slice(1) : extension;
	if (isKind(bare)) return bare;
	if (mime.startsWith("text/") || TEXT_TYPES.has(mime) || TEXT_EXTENSIONS.has(extension)) return "text";
	throw new OperationError("UNSUPPORTED_FILE", "Minerva can read Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and text files, not this type of file.");
}

/** The file's text, at most `limit` characters for Office files. */
async function textOf(client: DriveClient, item: DriveItem, limit: number): Promise<string> {
	const kind = readable(item);
	const sizeLimit = kind === "text" ? MAX_TEXT_BYTES : LIMITS.maxOfficeBytes;
	if (item.size !== null && item.size > sizeLimit) throw new OperationError("FILE_TOO_LARGE", `Minerva reads files of this type up to ${sizeLimit} bytes.`);
	const body = await client.content(driveOf(client, item), item.id, sizeLimit);
	if (kind === "text") return decodeText(body);
	return extract(kind, body, limit);
}

const READ_FILE = defineOperation<z.output<typeof ReadFile>>({
	name: "read_file",
	title: "Read a file",
	description:
		"Read the text of one file: Word documents and PowerPoint slides as plain text, the first sheet " +
		"of an Excel workbook as CSV (stored values; dates as numbers), and text files. Other types (PDF, " +
		"images, legacy .doc/.xls) are not supported. Long text is cut at max_chars and marked truncated.",
	input: ReadFile,
	needs: [[ITEM, "read"]],
	consent: READ_CONSENT,
	async prepare(binding, data): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		const item = await tree.get(data.file_id);
		const resource = await tree.resource(binding, item);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const current = await tree.confirm(resource);
				const text = await textOf(tree.client, current, data.max_chars + 1);
				const truncated = text.length > data.max_chars;
				return { records: [record(resource, current, { text: sliceText(text, 0, data.max_chars), truncated })] };
			},
		};
	},
});

function uploadSize(value: string): string {
	if (new TextEncoder().encode(value).length > MAX_UPLOAD_BYTES) throw new TextError(`must be at most ${MAX_UPLOAD_BYTES} bytes as UTF-8`);
	return value;
}

/** Refuses the names OneDrive and SharePoint refuse. */
function fileName(value: string): string {
	if (INVALID_NAME.test(value)) throw new TextError('must not contain any of " * : < > ? / \\ |');
	const lowered = value.toLowerCase();
	if (value.endsWith(".") || DEVICES.has(lowered.split(".")[0] as string) || RESERVED_NAMES.has(lowered)) {
		throw new TextError("is a name OneDrive and SharePoint do not allow");
	}
	if (value.startsWith("~$") || lowered.includes("_vti_")) throw new TextError("is a name OneDrive and SharePoint do not allow");
	return value;
}

export const CreateFile = z
	.strictObject({
		folder_id: FolderId(),
		name: after(singleLineOf(z.string().trim().min(1).max(200).describe("The new file's name, with its extension.")), fileName),
		content: after(z.string().max(MAX_UPLOAD_BYTES), uploadSize),
	});

const CREATE_FILE = defineOperation<z.output<typeof CreateFile>>({
	name: "create_file",
	title: "Create a file",
	description:
		'Create one text file in a folder or library where you have create permission. Use "root" for ' +
		"your own OneDrive. An existing file is never replaced: if the name is taken, the call fails. " +
		"Everyone who can open the folder can open the file.",
	input: CreateFile,
	needs: [[ITEM, "create"]],
	consent: WRITE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const tree = new Tree(clientOf(binding));
		const folder = await tree.get(data.folder_id);
		const resource = await tree.resource(binding, folder);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const current = folderOf(await tree.confirm(resource));
				const drive = driveOf(tree.client, current);
				const created = await tree.client.upload(drive, current.id, data.name, new TextEncoder().encode(data.content));
				const found = key(drive, created.id);
				if (!ITEM_ID.test(found)) throw tree.client.unexpected();
				const ref = created.parentReference;
				const placed = ref !== null && ref.id === current.id && driveKey(ref.driveId || drive) === drive;
				// The record names where Graph says it put the file; anywhere else is not placed by this call.
				const [within, partial] = placed ? [[resource.id, ...resource.within], resource.partial] : [[], true];
				return { records: [record(binding.resource(ITEM, found, within, partial), created)] };
			},
		};
	},
});

const SearchCursor = z.strictObject({ page: z.string() });

/** The page a discovery cursor holds. */
export function searchCursor(cursor: string): string {
	let parsed: unknown = null;
	try {
		parsed = parseJson(cursor);
	} catch {
		// Not JSON: refused below.
	}
	const found = SearchCursor.safeParse(parsed);
	if (!found.success) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return found.data.page;
}

async function describe(client: DriveClient, ids: readonly string[]): Promise<{ [id: string]: string }> {
	const mine = await client.myDrive();
	const wanted = ids.slice(0, MAX_DESCRIBE);
	const names = await mapLimited(wanted, CONCURRENCY, async (itemId): Promise<string | null> => {
		if (!ITEM_ID.test(itemId)) return null;
		let drive: Awaited<ReturnType<DriveClient["drive"]>>;
		try {
			const item = await client.item(...split(itemId));
			// Only the id as calls spell it can be allowed: a grant under another spelling of it would never match.
			if (`${driveOf(client, item)}:${item.id}` !== itemId) return null;
			if (item.root === null) return item.folder !== null ? `${item.name}/` : item.name;
			drive = await client.drive(driveOf(client, item));
		} catch (error) {
			if (unseen(error)) return null;
			throw error;
		}
		if (mine !== null && driveKey(drive.id) === driveKey(mine.id)) return "OneDrive";
		return `${drive.name} (library)`;
	});
	return Object.fromEntries(
		wanted.flatMap((id, index) => {
			const name = names[index];
			return typeof name === "string" ? [[id, name]] : [];
		}),
	);
}

export function onedriveConnector(options: { baseUrl?: string } = {}): Connector<DriveClient> {
	return {
		slug: "onedrive",
		name: "OneDrive and SharePoint",
		kinds: [
			{
				id: ITEM,
				label: "File",
				actions: ["read", "create"],
				wildcard: true,
				hierarchical: true,
				note:
					"Microsoft lets Minerva open every file the account can open, in OneDrive and SharePoint; " +
					"Minerva limits agents to the files, folders and libraries allowed here. Access to a " +
					"folder covers everything inside it, and access to a library covers the whole library.",
			},
		],
		actions: [
			{ id: "read", label: "Read files" },
			{ id: "create", label: "Create files", requires: "read" },
		],
		// Reading is enough to connect; writing is asked for once the user allows an agent to create files.
		// Sites.Read.All lists the SharePoint sites a work account follows, and their libraries; Microsoft does not grant
		// it to personal accounts, which have none.
		auth: oauth("Files.Read.All", "Sites.Read.All"),
		tenancy: TENANCY,
		operations: [LIST_LIBRARIES, LIST_FOLDER, SEARCH_FILES, GET_FILE, READ_FILE, CREATE_FILE],

		client(secret, io) {
			return new DriveClient(secret, io, options.baseUrl);
		},

		async account(client) {
			const user = await client.me();
			return { id: user.id, label: accountLabel(user, "OneDrive"), tenants: await client.tenants(user) };
		},

		async discover(client, _kind, { query, cursor }) {
			if (!query) {
				if (cursor) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
				const [found] = await libraries(client);
				return { items: found.map(([item, name]) => ({ id: `${driveOf(client, item)}:${item.id}`, name })) };
			}
			const page = cursor ? searchCursor(cursor) : null;
			const [ids, next] = await search(client, query, 25, page);
			const names = await describe(client, ids);
			return {
				items: ids.filter((id) => Object.hasOwn(names, id)).map((id) => ({ id, name: names[id] as string })),
				nextCursor: next ? JSON.stringify({ page: next }) : null,
			};
		},

		async describe(client, _kind, ids) {
			return describe(client, ids);
		},
	};
}
