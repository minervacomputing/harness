// Outlook's read operations, ported from backend/connectors/outlook/reads.py: folders, message lists and
// single messages.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import { defineOperation } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { codePointLength, singleLine, sliceCodePoints } from "../../lib/text.ts";
import { ID } from "../microsoft/index.ts";
import { after, modelValidator, valueError } from "../microsoft/inputs.ts";
import { ValueError } from "../../lib/pyerrors.ts";
import { asUtc, datetimeFromIsoFormat, toUtc, utcStamp } from "../../lib/isoformat.ts";
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

/** `_search_text`. Called with None too (the validator is on `str | None`), where Python raises a TypeError. */
function searchText(value: string | null): string | null {
	if (value === null) throw new TypeError("'NoneType' object is not iterable");
	singleLine(value);
	if (value.includes('"') || value.includes("\\")) throw valueError("must not contain double quotes or backslashes");
	return value;
}

/** `_moment`: an ISO 8601 time, in UTC, as Graph compares it. Times without a zone are UTC. */
export function moment(value: string): string {
	let parsed: ReturnType<typeof datetimeFromIsoFormat>;
	try {
		parsed = datetimeFromIsoFormat(value);
	} catch (error) {
		if (error instanceof ValueError) throw valueError("must be an ISO 8601 time such as 2026-10-01T09:00:00Z");
		throw error;
	}
	if (parsed.offset === null) parsed = asUtc(parsed);
	// An OverflowError (a time that leaves the years 1 to 9999 in UTC) propagates, as it does today.
	return utcStamp(toUtc(parsed));
}

const Moment = () => after(strippedStr({ min: 1, max: 40 }).describe("An ISO 8601 time."), moment);
const Cursor = () => strippedStr({ max: 1000 });

function person(recipient: Recipient | null): Json {
	if (recipient === null || recipient.email_address === null) return null;
	return { name: recipient.email_address.name, address: recipient.email_address.address };
}

function people(recipients: readonly Recipient[]): Json[] {
	return recipients.map(person).filter((found) => found !== null);
}

function summary(message: Message): { [key: string]: Json } {
	return {
		id: message.id,
		conversation_id: message.conversation_id,
		folder_id: message.parent_folder_id,
		subject: message.subject,
		from: person(message.from_),
		to: people(message.to_recipients),
		cc: people(message.cc_recipients),
		received: message.received_date_time,
		sent: message.sent_date_time,
		is_read: message.is_read,
		is_draft: message.is_draft,
		has_attachments: message.has_attachments,
		importance: message.importance,
		preview: message.body_preview,
		categories: message.categories,
	};
}

function folderData(folder: Folder, parentId: string | null): { [key: string]: Json } {
	return {
		id: folder.id,
		name: folder.display_name,
		parent_id: parentId,
		unread: folder.unread_item_count,
		total: folder.total_item_count,
	};
}

export const ListFolders = z
	.strictObject({
		parent: folderRef().nullable().default(null).describe("List this folder's subfolders; leave out for the top-level folders."),
		limit: z.int().min(1).max(100).default(50),
		cursor: Cursor().nullable().default(null),
	})
	.meta({ title: "ListFolders" });

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
						.filter((folder) => folder.parent_folder_id === root && ID.test(folder.id) && ordinary(folder))
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
					.filter((child) => child.parent_folder_id === folder.id && ID.test(child.id) && !within.includes(child.id) && ordinary(child))
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
			strippedStr({ min: 1, max: 200 })
				.nullable()
				.describe(
					"Words to search for in this folder's mail. Results are ordered by Outlook; cannot " + "be combined with unread_only, after or before.",
				),
			searchText,
		).default(null),
		cursor: Cursor().nullable().default(null),
	})
	.check(
		modelValidator((data: { query: string | null; unread_only: boolean; after: string | null; before: string | null }) => {
			if (data.query !== null && (data.unread_only || data.after || data.before)) {
				throw valueError("query cannot be combined with unread_only, after or before");
			}
		}),
	)
	.meta({ title: "ListMessages" });

type ListMessagesData = z.output<typeof ListMessages>;

/** `_filter`: Graph's $filter for the time and unread limits, or null without any. */
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
					.filter((message) => message.parent_folder_id === folder.id && ID.test(message.id))
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
	})
	.meta({ title: "ReadMessage" });

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
				const attachments = message.has_attachments ? await client.attachments(message.id, MAX_ATTACHMENTS) : [];
				const text = message.body ? message.body.content : "";
				// Python slices and counts code points.
				const total = codePointLength(text);
				const end = data.offset + data.max_chars;
				const record: { [key: string]: Json } = {
					...summary(message),
					reply_to: people(message.reply_to),
					bcc: people(message.bcc_recipients),
					body: sliceCodePoints(text, data.offset, end),
					offset: data.offset,
					total_chars: total,
					next_offset: end < total ? end : null,
					attachments: attachments.map((a) => ({ name: a.name, content_type: a.content_type, size: a.size, inline: a.is_inline })),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
