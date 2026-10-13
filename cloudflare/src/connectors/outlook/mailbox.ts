// What Outlook's operations share: Graph consent, folder
// and message ids, and where folders sit.

import { z } from "zod";
import type { Binding } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import { after } from "../microsoft/inputs.ts";
import { ID, consent } from "../microsoft/index.ts";
import { type Folder, type GraphClient, type Message, ordinary } from "./client.ts";
import { TextError } from "../../lib/text.ts";

export const FOLDER = "folder";
export const RECIPIENT = "recipient";
export const READ_CONSENT = consent("Mail.Read", "Mail.ReadWrite");
export const SEND_CONSENT = consent("Mail.Send");

export const ROOT = "msgfolderroot";
export const WELL_KNOWN = ["inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail"];
/** Mutable for tests only (Python's module constants, which tests patch). */
export const LIMITS = { maxDepth: 16, maxLookups: 60 };
/** Errors about the connection, not about the object a call names; they say nothing about that object. */
export const CONNECTION_ERRORS: ReadonlySet<string> = new Set(["CONNECTION_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_ACCOUNT"]);

export function connectionError(error: unknown): boolean {
	return error instanceof OperationError && CONNECTION_ERRORS.has(error.code);
}

function moved(): OperationError {
	return new OperationError("MAIL_MOVED", "This folder or message moved while Minerva was using it. Try again.");
}

export function folderRef() {
	return after(z.string().trim().min(1).max(512), (value: string) => {
		if (WELL_KNOWN.includes(value.toLowerCase())) return value.toLowerCase();
		if (ID.test(value)) return value;
		throw new TextError(`must be a folder id, or one of: ${WELL_KNOWN.join(", ")}`);
	}).describe(`A folder id from list_folders, or a well-known folder: ${WELL_KNOWN.join(", ")}.`);
}

export function messageId() {
	return after(z.string().trim().min(10).max(512), (value: string) => {
		if (!ID.test(value)) throw new TextError("must be a message id from list_messages");
		return value;
	});
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Where folders sit, resolved for one call. Parent lookups are cached and limited. */
export class Tree {
	readonly client: GraphClient;
	root_: string | null = null;
	readonly #folders = new Map<string, Folder | null>();
	#lookups = 0;

	constructor(client: GraphClient) {
		this.client = client;
	}

	/** The id of the top of the mailbox's folders (Graph's msgfolderroot). */
	async root(): Promise<string> {
		if (this.root_ === null) {
			const root = await this.client.folder(ROOT);
			if (!ID.test(root.id)) throw this.client.unexpected();
			this.root_ = root.id;
		}
		return this.root_;
	}

	/** Null when the folder cannot be read, or the call looked up too many. */
	async #parent(folderId: string): Promise<Folder | null> {
		if (this.#folders.has(folderId)) return this.#folders.get(folderId) ?? null;
		if (this.#lookups >= LIMITS.maxLookups) return null;
		this.#lookups++;
		let parent: Folder | null;
		try {
			parent = await this.client.folder(folderId);
		} catch (error) {
			if (!(error instanceof OperationError) || connectionError(error)) throw error;
			parent = null;
		}
		if (parent !== null && parent.id !== folderId) parent = null;
		this.#folders.set(folderId, parent);
		return parent;
	}

	/**
	 * The folder's ancestors below the root, nearest first. Null for a folder outside the tree under the
	 * root (the root itself, search folders, system folders), or one whose chain cannot be followed
	 * completely: such folders are never resources.
	 */
	async place(folder: Folder): Promise<string[] | null> {
		const root = await this.root();
		if (folder.id === root || !ID.test(folder.id)) return null;
		const within: string[] = [];
		let current = folder;
		for (;;) {
			if (!ordinary(current)) return null;
			const parentId = current.parent_folder_id;
			if (parentId === root) return within;
			if (!parentId || !ID.test(parentId) || parentId === folder.id || within.includes(parentId) || within.length >= LIMITS.maxDepth) return null;
			const parent = await this.#parent(parentId);
			if (parent === null) return null;
			within.push(parentId);
			current = parent;
		}
	}

	/** The folder's name with its parents' names, as far as they were looked up. */
	path(folder: Folder, within: readonly string[]): string {
		const names = [...within]
			.reverse()
			.map((id) => this.#folders.get(id) ?? null)
			.filter((found): found is Folder => found !== null)
			.map((found) => found.display_name);
		return [...names, folder.display_name].join("/");
	}

	/**
	 * The folder a call names, as the resource that is authorized. Anything that keeps Minerva from placing
	 * it is refused like a folder without a grant, so the refusal says nothing about it.
	 */
	async resolve(binding: Binding, name: string): Promise<[Resource, Folder]> {
		let folder: Folder;
		let within: string[] | null;
		try {
			folder = await this.client.folder(name);
			within = await this.place(folder);
		} catch (error) {
			if (!(error instanceof OperationError) || connectionError(error)) throw error;
			throw denied();
		}
		if (within === null || (!WELL_KNOWN.includes(name) && folder.id !== name)) throw denied();
		this.#folders.set(folder.id, folder);
		return [binding.resource(FOLDER, folder.id, within), folder];
	}

	/** The folder again, from Graph, refused if it moved since `resource` was authorized. */
	async confirm(resource: Resource): Promise<Folder> {
		const fresh = new Tree(this.client);
		fresh.root_ = this.root_;
		let folder: Folder;
		let within: string[] | null;
		try {
			folder = await this.client.folder(resource.id);
			within = await fresh.place(folder);
		} catch (error) {
			if (!(error instanceof OperationError) || connectionError(error)) throw error;
			throw moved();
		}
		if (folder.id !== resource.id || within === null || !sameList(within, resource.within)) throw moved();
		return folder;
	}
}

/**
 * A message and the folder it lives in, before authorization. A message Minerva cannot read or place is
 * refused like one in a folder without a grant.
 */
export async function locate(binding: Binding<GraphClient>, tree: Tree, id: string, fields: string): Promise<[Message, Resource]> {
	let message: Message;
	try {
		message = await binding.client.message(id, fields);
	} catch (error) {
		if (!(error instanceof OperationError) || connectionError(error)) throw error;
		throw denied();
	}
	if (message.id !== id || !message.parent_folder_id || !ID.test(message.parent_folder_id)) throw denied();
	const [resource] = await tree.resolve(binding, message.parent_folder_id);
	return [message, resource];
}

/** The message again, with its folder, refused if either moved since the folder was authorized. */
export async function confirmMessage(binding: Binding<GraphClient>, tree: Tree, resource: Resource, id: string, fields: string, textBody = false): Promise<Message> {
	await tree.confirm(resource);
	let message: Message;
	try {
		message = await binding.client.message(id, fields, textBody);
	} catch (error) {
		if (!(error instanceof OperationError) || connectionError(error)) throw error;
		throw moved();
	}
	if (message.id !== id || message.parent_folder_id !== resource.id) throw moved();
	return message;
}
