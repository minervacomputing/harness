// Outlook's read operations: folders, message lists and
// single messages.

import { z } from "zod";
import { type Binding, type Prepared, type ProviderOutput, type ScopedRecord, defineOperation } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { singleLine, sliceText, TextError } from "../../lib/text.ts";
import { ID } from "../microsoft/index.ts";
import { after, objectCheck } from "../microsoft/inputs.ts";
import { formatUtc, parseInstant } from "../../lib/dates.ts";
import { FULL_FIELDS, type Folder, type GraphClient, type Message, type Recipient, ordinary } from "./client.ts";
import { FOLDER, READ_CONSENT, Tree, confirmMessage, folderRef, locate, messageId } from "./mailbox.ts";

export const MAX_ATTACHMENTS = 20;
/**
 * Before any mail: the lower bound that lets a filter on time precede `isRead` (Graph requires properties in
 * $orderby to come first in $filter).
 */
export const EPOCH = "1900-01-01T00:00:00Z";

function clientOf(binding: Binding): GraphClient {
	return binding.client as GraphClient;
}

/** Search words for Graph's $search: one line, without the quotes and backslashes its syntax uses. Null is no search. */
function searchText(value: string | null): string | null {
	if (value === null) return null;
	singleLine(value);
	if (value.includes('"') || value.includes("\\")) throw new TextError("must not contain double quotes or backslashes");
	return value;
}

/** A date or date-time in UTC, as Graph compares it. Times without an offset are UTC. */
export function moment(value: string): string {
	const instant = parseInstant(value);
	if (instant === null) throw new TextError("must be an ISO 8601 time such as 2026-10-01T09:00:00Z");
	return formatUtc(instant);
}

const Moment = () => after(z.string().trim().min(1).max(40).describe("An ISO 8601 time."), moment);
const Cursor = () => z.string().trim().max(1000);

function person(recipient: Recipient | null): Json {
	if (recipient === null || recipient.emailAddress === null) return null;
	return { name: recipient.emailAddress.name, address: recipient.emailAddress.address };
}

function people(recipients: readonly Recipient[]): Json[] {
	return recipients.map(person).filter((found) => found !== null);
}

function summary(message: Message): { [key: string]: Json } {
	return {
		id: message.id,
		conversation_id: message.conversationId,
		folder_id: message.parentFolderId,
		subject: message.subject,
		from: person(message.from),
		to: people(message.toRecipients),
		cc: people(message.ccRecipients),
		received: message.receivedDateTime,
		sent: message.sentDateTime,
		is_read: message.isRead,
		is_draft: message.isDraft,
		has_attachments: message.hasAttachments,
		importance: message.importance,
		preview: message.bodyPreview,
		categories: message.categories,
	};
}

function folderData(folder: Folder, parentId: string | null): { [key: string]: Json } {
	return {
		id: folder.id,
		name: folder.displayName,
		parent_id: parentId,
		unread: folder.unreadItemCount,
		total: folder.totalItemCount,
	};
}

export const ListFolders = z
	.strictObject({
		parent: folderRef().nullable().default(null).describe("List this folder's subfolders; leave out for the top-level folders."),
		limit: z.int().min(1).max(100).default(50),
		cursor: Cursor().nullable().default(null),
	});

export const LIST_FOLDERS = defineOperation<z.output<typeof ListFolders>>({
	name: "list_folders",
	title: "List mail folders",
	description:
		"List mail folders you may read: the top-level folders, or the subfolders of parent. To get " +
		"the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListFolders,
	needs: [[FOLDER, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const tree = new Tree(client);
		if (data.parent === null) {
			return {
				requirements: [{ enumerate: FOLDER, action: "read" }],
				async execute(): Promise<ProviderOutput> {
					const root = await tree.root();
					const [folders, cursor] = await client.folders(null, data.limit, data.cursor);
					const records: ScopedRecord[] = folders
						.filter((folder) => folder.parentFolderId === root && ID.test(folder.id) && ordinary(folder))
						.map((folder) => ({ resource: binding.resource(FOLDER, folder.id), data: folderData(folder, null) }));
					return { records, nextCursor: cursor };
				},
			};
		}
		const [resource] = await tree.resolve(binding, data.parent);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const folder = await tree.confirm(resource);
				const [folders, cursor] = await client.folders(folder.id, data.limit, data.cursor);
				const within = [folder.id, ...resource.within];
				const records: ScopedRecord[] = folders
					// A folder that does not name this one as its parent is not placed by this listing.
					.filter((child) => child.parentFolderId === folder.id && ID.test(child.id) && !within.includes(child.id) && ordinary(child))
					.map((child) => ({ resource: binding.resource(FOLDER, child.id, within), data: folderData(child, folder.id) }));
				return { records, nextCursor: cursor };
			},
		};
	},
});

export const ListMessages = z
	.strictObject({
		folder: folderRef(),
		limit: z.int().min(1).max(50).default(20),
		unread_only: z.boolean().default(false),
		after: Moment().nullable().default(null).describe("Only mail received at or after this time."),
		before: Moment().nullable().default(null).describe("Only mail received before this time."),
		query: after(
			z.string().trim().min(1).max(200)
				.nullable()
				.describe(
					"Words to search for in this folder's mail. Results are ordered by Outlook; cannot " + "be combined with unread_only, after or before.",
				),
			searchText,
		).default(null),
		cursor: Cursor().nullable().default(null),
	})
	.check(
		objectCheck((data: { query: string | null; unread_only: boolean; after: string | null; before: string | null }) => {
			if (data.query !== null && (data.unread_only || data.after || data.before)) {
				throw new TextError("query cannot be combined with unread_only, after or before");
			}
		}),
	);

type ListMessagesData = z.output<typeof ListMessages>;

/** Graph's $filter for the time and unread limits, or null without any. */
export function messageFilter(data: Pick<ListMessagesData, "unread_only" | "after" | "before">): string | null {
	if (!(data.unread_only || data.after || data.before)) return null;
	const parts = [`receivedDateTime ge ${data.after || EPOCH}`];
	if (data.before) parts.push(`receivedDateTime lt ${data.before}`);
	if (data.unread_only) parts.push("isRead eq false");
	return parts.join(" and ");
}

export const LIST_MESSAGES = defineOperation<ListMessagesData>({
	name: "list_messages",
	title: "List messages",
	description:
		"List the messages in one folder, newest first, with a short preview of each. Filter by " +
		"unread_only and received time, or search with query. To get the next page, repeat the " +
		"call with identical arguments plus the returned next_cursor.",
	input: ListMessages,
	needs: [[FOLDER, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const tree = new Tree(client);
		const [resource] = await tree.resolve(binding, data.folder);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const folder = await tree.confirm(resource);
				const [messages, cursor] = await client.messages(folder.id, {
					limit: data.limit,
					cursor: data.cursor,
					filter: messageFilter(data),
					search: data.query,
				});
				const records: ScopedRecord[] = messages
					// Mail that lives in another folder (as in a search folder) is not this folder's to show.
					.filter((message) => message.parentFolderId === folder.id && ID.test(message.id))
					.map((message) => ({ resource, data: summary(message) }));
				return { records, nextCursor: cursor };
			},
		};
	},
});

export const ReadMessage = z
	.strictObject({
		message: messageId(),
		max_chars: z.int().min(500).max(50_000).default(20_000),
		// Where to start in the body, to continue a long message.
		offset: z.int().min(0).max(10_000_000).default(0),
	});

export const READ_MESSAGE = defineOperation<z.output<typeof ReadMessage>>({
	name: "read_message",
	title: "Read a message",
	description:
		"Read one message as plain text, with its recipients and the names of its attachments " +
		"(attachments themselves cannot be read). Long bodies are cut at max_chars; continue with " +
		"offset set to the returned next_offset. Reading does not mark the message as read.",
	input: ReadMessage,
	needs: [[FOLDER, "read"]],
	consent: READ_CONSENT,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const tree = new Tree(client);
		const [, resource] = await locate(binding as Binding<GraphClient>, tree, data.message, "id,parentFolderId");
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const message = await confirmMessage(binding as Binding<GraphClient>, tree, resource, data.message, FULL_FIELDS, true);
				const attachments = message.hasAttachments ? await client.attachments(message.id, MAX_ATTACHMENTS) : [];
				const text = message.body ? message.body.content : "";
				const total = text.length;
				const end = data.offset + data.max_chars;
				const record: { [key: string]: Json } = {
					...summary(message),
					reply_to: people(message.replyTo),
					bcc: people(message.bccRecipients),
					body: sliceText(text, data.offset, end),
					offset: data.offset,
					total_chars: total,
					next_offset: end < total ? end : null,
					attachments: attachments.map((a) => ({ name: a.name, content_type: a.contentType, size: a.size, inline: a.isInline })),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
