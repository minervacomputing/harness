// Intercom's read operations: inboxes, conversation search and single conversations.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, truncate } from "../../lib/text.ts";
import { type Attachment, type Author, type Conversation, type IntercomClient, type Part, idNumber } from "./client.ts";
import { epochMicros, parseInstant } from "../../lib/dates.ts";
import * as html from "./html.ts";
import {
	ConversationId,
	INBOX,
	InboxName,
	NO_TEAM,
	NO_TEAM_NAME,
	clientOf,
	inboxOf,
	inboxResource,
	iso,
	resolveConversation,
	resolveInbox,
	unplaced,
} from "./inboxes.ts";
import { RE_WORD_CHAR } from "./python.ts";

export const MAX_SEARCH_WORDS = 5;
export const CONCURRENCY = 5;
export const MAX_PREVIEW = 300;
export const MAX_MESSAGE = 4_000;
export const MAX_MESSAGES = 50;
export const MAX_SHORT = 500;
export const MAX_ATTACHMENTS = 20;

const WORD = new RegExp(`${RE_WORD_CHAR}+`, "gu");
// Parts that carry a message. Others (assignments, state changes, tags, events) say who did what, which can
// name teams and teammates elsewhere; they are left out.
const MESSAGE_PARTS: ReadonlySet<string> = new Set(["comment", "note", "quick_reply", "close"]);
// Authors shown by name. A team as author names another inbox; it is shown without a name.
const AUTHORS: ReadonlySet<string> = new Set(["admin", "user", "lead", "contact", "bot"]);
const CONTACTS: ReadonlySet<string> = new Set(["user", "lead", "contact"]);

export const NOT_ISO = "must be an ISO 8601 date or time such as 2026-10-01T09:00:00Z";
export const NOT_IN_RANGE = "must be a time between the years 2000 and 2100";

/** `Cursor | None = None`: a page token, at most 1000 characters. */
const Cursor = () => z.string().trim().max(1000).nullable().default(null);

/** Text shown to agents, links to Intercom hidden, at most `limit` characters; null for none. */
export function short(value: string | null | undefined, limit: number = MAX_SHORT): string | null {
	const [shown] = truncate(value ? html.redact(value) : null, limit);
	return shown || null;
}

function author(found: Author | null): JsonObject | null {
	if (found === null || found.type === null) return null;
	if (!AUTHORS.has(found.type)) return { type: "other", name: null, email: null };
	return { type: found.type, name: short(found.name), email: short(found.email) };
}

function attachments(found: Attachment[]): string[] {
	return found.slice(0, MAX_ATTACHMENTS).map((attachment) => short(attachment.name) || "attachment");
}

function contact(conversation: Conversation): JsonObject | null {
	const found = conversation.source?.author ?? null;
	if (found === null || found.type === null || !CONTACTS.has(found.type)) return null;
	return { name: short(found.name), email: short(found.email) };
}

function header(conversation: Conversation): JsonObject {
	const source = conversation.source;
	return {
		id: conversation.id,
		inbox: inboxOf(conversation),
		title: short(conversation.title),
		subject: source !== null && !source.redacted ? short(html.read(source.subject)) : null,
		state: conversation.state,
		priority: conversation.priority,
		created: iso(conversation.created_at),
		updated: iso(conversation.updated_at),
		waiting_since: iso(conversation.waiting_since),
		contact: contact(conversation),
	};
}

// list_inboxes

// Each input is titled with the name of its Pydantic model, which validation errors name.
const ListInboxes = z.strictObject({}).meta({ title: "ListInboxes" });

export const LIST_INBOXES = defineOperation<z.output<typeof ListInboxes>>({
	name: "list_inboxes",
	title: "List inboxes",
	description:
		'List the Intercom team inboxes you may read. "none" holds conversations no team is assigned to: unassigned ones and ones assigned only to a teammate.',
	input: ListInboxes,
	needs: [[INBOX, "read"]],
	async prepare(binding: Binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: INBOX, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const records: ScopedRecord[] = (await clientOf(binding).teams()).map((team) => ({
					resource: inboxResource(binding, team.id),
					data: { id: team.id, name: short(team.name), teammates: team.admin_ids.length },
				}));
				records.push({ resource: inboxResource(binding, NO_TEAM), data: { id: NO_TEAM, name: NO_TEAM_NAME, teammates: null } });
				return { records };
			},
		};
	},
});

// search_conversations

/** Up to five words of the search text. */
export function words(text: string): string[] {
	const found = (text.match(WORD) ?? []).slice(0, MAX_SEARCH_WORDS);
	if (found.length === 0) throw new OperationError("INVALID_ARGUMENTS", "text must contain letters or digits.");
	return found;
}

const FIRST = epochMicros({ year: 2000, month: 1, day: 1 });
const AFTER_LAST = epochMicros({ year: 2101, month: 1, day: 1 });

/** Why an `updated_after` is refused, or null. */
export function sinceProblem(value: string): string | null {
	const micros = parseInstant(value);
	if (micros === null) return NOT_ISO;
	if (micros < FIRST || micros >= AFTER_LAST) return NOT_IN_RANGE;
	return null;
}

/** The Unix time in seconds of an `updated_after` that passed `sinceProblem`; a time without an offset is UTC. */
export function sinceTimestamp(value: string): number {
	const micros = parseInstant(value);
	if (micros === null) throw new RangeError("Not an ISO 8601 time.");
	return Number(micros / 1_000_000n);
}

const SearchText = () =>
	z.string().trim().min(1).max(200)
		.refine(isSingleLine, SINGLE_LINE)
		.describe(`Up to ${MAX_SEARCH_WORDS} words, all of which the conversation's first message contains.`);

const Since = () =>
	z.string().trim().min(1).max(40)
		.refine((value) => sinceProblem(value) !== NOT_ISO, NOT_ISO)
		.refine((value) => sinceProblem(value) !== NOT_IN_RANGE, NOT_IN_RANGE)
		.describe("Only conversations updated at or after this ISO 8601 time; times without a zone are UTC.");

const SearchConversations = z.strictObject({
	inbox: InboxName(),
	state: z.enum(["open", "closed", "snoozed"]).nullable().default(null),
	text: SearchText().nullable().default(null),
	updated_after: Since().nullable().default(null),
	limit: z.int().min(1).max(20).default(10),
	cursor: Cursor(),
}).meta({ title: "SearchConversations" });
type SearchConversations = z.output<typeof SearchConversations>;

function firstText(conversation: Conversation): string | null {
	const source = conversation.source;
	return source !== null && !source.redacted ? html.read(source.body) : null;
}

/**
 * Whether every searched word is in the first message as shown. Intercom searches the raw body, which
 * includes the hidden labels of links to Intercom; a match there alone would reveal them.
 */
function showsWords(text: string | null, searched: string[]): boolean {
	const folded = (text ?? "").toLowerCase();
	return searched.every((word) => folded.includes(word.toLowerCase()));
}

/** The search, built from fields: one inbox, ANDed with the other filters. */
export function query(data: SearchConversations): Json {
	const team = data.inbox === NO_TEAM ? 0 : idNumber(data.inbox);
	const filters: Json[] = [{ field: "team_assignee_id", operator: "=", value: team }];
	if (data.state !== null) filters.push({ field: "state", operator: "=", value: data.state });
	if (data.updated_after !== null) filters.push({ field: "updated_at", operator: ">", value: sinceTimestamp(data.updated_after) });
	if (data.text !== null) for (const word of words(data.text)) filters.push({ field: "source.body", operator: "~", value: word });
	return { operator: "AND", value: filters };
}

/**
 * The conversations read again, in order, at most CONCURRENCY at once; ones that cannot be placed in an inbox
 * are left out. A failure fails the search, and no read starts after it.
 */
async function fresh(client: IntercomClient, ids: string[]): Promise<Conversation[]> {
	const found: (Conversation | null)[] = new Array(ids.length).fill(null);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (next < ids.length && !failed) {
			const index = next++;
			try {
				found[index] = await client.conversation(ids[index] as string);
			} catch (error) {
				if (unplaced(error)) continue;
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
	return found.filter((conversation): conversation is Conversation => conversation !== null);
}

export const SEARCH_CONVERSATIONS = defineOperation<SearchConversations>({
	name: "search_conversations",
	title: "Search conversations",
	description:
		"Find conversations in one Intercom inbox by state, update time and words in the first message. Results are not sorted, and a page can hold fewer than limit even when more follow. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: SearchConversations,
	needs: [[INBOX, "read"]],
	paginated: true,
	async prepare(binding: Binding, data: SearchConversations): Promise<Prepared> {
		const resource = await resolveInbox(binding, data.inbox);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				let ids: string[];
				let nextCursor: string | null;
				try {
					[ids, nextCursor] = await client.search(query(data), data.limit, data.cursor);
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED" && data.cursor !== null) {
						throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
					}
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED") {
						throw new OperationError("INVALID_ARGUMENTS", "Intercom could not run this search.");
					}
					throw error;
				}
				// Search reads an index that can lag behind reassignments: each conversation is read again, and shown
				// under the inbox it is in now. What the index returned beside the id is not used.
				const searched = data.text !== null ? words(data.text) : [];
				const records: ScopedRecord[] = [];
				for (const conversation of await fresh(client, [...new Set(ids)])) {
					const preview = firstText(conversation);
					if (!showsWords(preview, searched)) continue;
					const record = header(conversation);
					[record.preview, record.preview_truncated] = truncate(preview || null, MAX_PREVIEW);
					records.push({ resource: inboxResource(binding, inboxOf(conversation)), data: record });
				}
				return { records, nextCursor };
			},
		};
	},
});

// get_conversation

function message(
	messageId: string | null,
	kind: string,
	by: Author | null,
	created: number | null,
	body: string | null,
	files: Attachment[],
	redacted: boolean,
): JsonObject {
	const [text, truncated] = redacted ? [null, false] : truncate(html.read(body) || null, MAX_MESSAGE);
	return {
		id: messageId,
		type: kind,
		author: author(by),
		created: iso(created),
		text: redacted ? "[redacted]" : text,
		text_truncated: truncated,
		attachments: redacted ? [] : attachments(files),
	};
}

/** The first message, then the newest parts that carry a message, oldest first, and whether there are more. */
export function messages(conversation: Conversation, limit: number = MAX_MESSAGES): [JsonObject[], boolean] {
	const out: JsonObject[] = [];
	const source = conversation.source;
	if (source !== null) {
		out.push(message(source.id, "first", source.author, conversation.created_at, source.body, source.attachments, source.redacted));
	}
	const found = conversation.conversation_parts;
	const parts: Part[] = found !== null ? found.conversation_parts : [];
	// A closing part without words says only who closed the conversation.
	const shown = parts
		.filter((part) => part.part_type !== null && MESSAGE_PARTS.has(part.part_type))
		.filter((part) => part.part_type !== "close" || part.body || part.attachments.length > 0);
	const more = shown.length > limit || (found !== null && found.total_count > parts.length);
	for (const part of shown.slice(-limit)) {
		out.push(message(part.id, part.part_type || "comment", part.author, part.created_at, part.body, part.attachments, part.redacted));
	}
	return [out, more];
}

const GetConversation = z.strictObject({ conversation: ConversationId() }).meta({ title: "GetConversation" });
type GetConversation = z.output<typeof GetConversation>;

export const GET_CONVERSATION = defineOperation<GetConversation>({
	name: "get_conversation",
	title: "Read a conversation",
	description: `Read one Intercom conversation: its first message, then up to ${MAX_MESSAGES} of the latest replies and internal notes, oldest first. Assignments and other events are left out, links to Intercom appear without their text, and attachments by name only.`,
	input: GetConversation,
	needs: [[INBOX, "read"]],
	async prepare(binding: Binding, data: GetConversation): Promise<Prepared> {
		// One read decides both where the conversation is and what is shown.
		const [resource, conversation] = await resolveConversation(binding, data.conversation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const record = header(conversation);
				[record.messages, record.more_messages] = messages(conversation);
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
