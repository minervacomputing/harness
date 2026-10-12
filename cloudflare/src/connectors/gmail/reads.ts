// Gmail's read operations, ported from backend/connectors/gmail/reads.py: labels, message lists, messages
// and threads.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, htmlUnescape, isSingleLine, sliceCodePoints } from "../../lib/text.ts";
import { digitsOr } from "../google/digits.ts";
import { type GmailClient, ID, type Message, type MessageRef, headersOf } from "./client.ts";
import { CONNECTION_ERRORS, LABEL, Labels, READ_CONSENT, SPAM_TRASH, SYSTEM_LABELS, confirm, locate, messageIdInput, moved, sameResource } from "./mailbox.ts";
import * as mime from "./mime.ts";

export const FETCH_CONCURRENCY = 5;
export const MAX_THREAD_MESSAGES = 25;
const MAX_SNIPPET = 300;

/** An error the call reports as it is: about the connection or the run, saying nothing of the object it names. */
export function passesThrough(error: unknown): boolean {
	return error instanceof OperationError && (CONNECTION_ERRORS.has(error.code) || error.code === "RUN_ENDED");
}

/** `_label_ref`: a system label in any case, else a label id. */
function labelRef(value: string, ctx: z.RefinementCtx): string {
	const upper = value.toUpperCase();
	if (SYSTEM_LABELS.has(upper)) return upper;
	if (!ID.test(value)) {
		ctx.addIssue({ code: "custom", message: "must be a label id from list_labels", input: value });
		return z.NEVER;
	}
	return value;
}

/** The run's own page token; the executor swaps it for Gmail's before the call is prepared. */
const Cursor = () => strippedStr({ max: 1000 });

function first(message: Message, name: string): string | null {
	return mime.headerText(headersOf(message, name)[0] ?? null);
}

function summary(message: Message): JsonObject {
	return {
		id: message.id,
		thread_id: message.thread_id,
		label_ids: message.label_ids.filter((label) => ID.test(label)),
		from: first(message, "From"),
		to: first(message, "To"),
		cc: first(message, "Cc"),
		subject: first(message, "Subject"),
		date: first(message, "Date"),
		// Gmail escapes the snippet as HTML.
		snippet: message.snippet ? sliceCodePoints(mime.headerText(htmlUnescape(message.snippet)) as string, 0, MAX_SNIPPET) : null,
		unread: message.label_ids.includes("UNREAD"),
	};
}

/** The message's data scoped to where it sits; null for a message Minerva does not place (a chat). */
function record(binding: Binding, labels: Labels, message: Message, data: JsonObject): ScopedRecord | null {
	try {
		return { resource: labels.message(binding, message), data };
	} catch (error) {
		if (error instanceof OperationError) return null;
		throw error;
	}
}

const ListLabels = z.strictObject({});

const LIST_LABELS = defineOperation<z.output<typeof ListLabels>>({
	name: "list_labels",
	title: "List labels",
	description:
		"List the labels you may read: Gmail's system labels (Inbox, Sent, Drafts, Spam, Trash and the inbox categories) and the user's own labels. A label's name is given below its parent_id.",
	input: ListLabels,
	needs: [[LABEL, "read"]],
	consent: READ_CONSENT,
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: LABEL, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const labels = await Labels.fetch(binding.client as GmailClient);
				const records: ScopedRecord[] = [];
				for (const [labelId, label] of labels.grantable) {
					const within = labels.ancestors(labelId);
					records.push({
						resource: binding.resource(LABEL, labelId, within),
						data: { id: labelId, name: labels.shortName(labelId), type: label.type === "user" ? "user" : "system", parent_id: within[0] ?? null },
					});
				}
				return { records };
			},
		};
	},
});

const ListMessages = z.strictObject({
	label: strippedStr({ min: 1, max: 64 })
		.describe(`A label id from list_labels, or a system label: ${[...SYSTEM_LABELS.keys()].join(", ")}.`)
		.transform(labelRef)
		.nullable()
		.default(null)
		.describe("Only mail with this label; leave out to search all mail."),
	query: strippedStr({ min: 1, max: 200 })
		.nullable()
		.superRefine((value, ctx) => {
			// AfterValidator(single_line) on `str | None`: Python iterates None and raises TypeError, which no
			// validation error words; the call fails as any other bug does.
			if (value === null) throw new TypeError("'NoneType' object is not iterable");
			if (!isSingleLine(value)) ctx.addIssue({ code: "custom", message: SINGLE_LINE, input: value });
		})
		.default(null)
		.describe('Gmail search, as in its search box, such as "from:ada@example.com is:unread".'),
	limit: z.int().min(1).max(25).default(10),
	cursor: Cursor().nullable().default(null),
});

/** Up to `limit` of `tasks` at once, results in order (an asyncio.Semaphore with gather). */
async function gatherLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await (tasks[index] as () => Promise<T>)();
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

async function summaries(client: GmailClient, refs: readonly MessageRef[]): Promise<Message[]> {
	const fetch = async (messageId: string): Promise<Message | null> => {
		let message: Message;
		try {
			message = await client.message(messageId, "metadata");
		} catch (error) {
			if (passesThrough(error)) throw error;
			// Deleted since it was listed.
			if (error instanceof OperationError) return null;
			throw error;
		}
		return message.id === messageId ? message : null;
	};
	const found = await gatherLimited(
		refs.filter((ref) => ID.test(ref.id)).map((ref) => () => fetch(ref.id)),
		FETCH_CONCURRENCY,
	);
	return found.filter((message): message is Message => message !== null);
}

const LIST_MESSAGES = defineOperation<z.output<typeof ListMessages>>({
	name: "list_messages",
	title: "List messages",
	description:
		"List messages, newest first, with their senders, subjects and a short snippet: those with one label, those matching a Gmail search, or both. Only mail you may read is shown; spam and trash only when that label is asked for. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListMessages,
	needs: [[LABEL, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as GmailClient;
		let authorized: Resource | null = null;
		if (data.label !== null) authorized = (await Labels.fetch(client)).resource(binding, data.label);
		const execute = async (): Promise<ProviderOutput> => {
			const [refs, cursor] = await client.messages({
				labelId: data.label,
				query: data.query,
				limit: data.limit,
				cursor: data.cursor,
				// Gmail leaves spam and trash out of every list but their own.
				spamTrash: data.label !== null && SPAM_TRASH.has(data.label),
			});
			const messages = await summaries(client, refs);
			// Labels after the messages, so that where they sit is never older than the labels they carry.
			const labels = await Labels.fetch(client);
			if (authorized !== null && (!labels.grantable.has(authorized.id) || !sameResource(labels.resource(binding, authorized.id), authorized))) throw moved();
			const records = messages.map((message) => record(binding, labels, message, summary(message)));
			return { records: records.filter((item): item is ScopedRecord => item !== null), nextCursor: cursor };
		};
		if (authorized === null) return { requirements: [{ enumerate: LABEL, action: "read" }], execute };
		return { requirements: [{ need: authorized, action: "read" }], execute };
	},
});

/** Code point positions in a long text, found without copying it into an array. */
function codePointIndex(text: string, count: number): number {
	let index = 0;
	for (let seen = 0; seen < count && index < text.length; seen++) {
		const unit = text.charCodeAt(index);
		index += unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff ? 2 : 1;
	}
	return index;
}

function codePoints(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; count++) {
		const unit = text.charCodeAt(index);
		index += unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff ? 2 : 1;
	}
	return count;
}

function full(message: Message, maxChars: number, offset = 0): JsonObject {
	const found = mime.content(message.payload);
	const end = offset + maxChars;
	const total = codePoints(found.text);
	return {
		...summary(message),
		bcc: first(message, "Bcc"),
		reply_to: first(message, "Reply-To"),
		body: found.text.slice(codePointIndex(found.text, offset), codePointIndex(found.text, end)),
		offset,
		total_chars: total,
		next_offset: end < total ? end : null,
		body_incomplete: found.unavailable,
		attachments: found.attachments as unknown as Json,
	};
}

const ReadMessage = z.strictObject({
	message: messageIdInput(),
	max_chars: z.int().min(500).max(50_000).default(20_000),
	// Where to start in the body, to continue a long message.
	offset: z.int().min(0).max(10_000_000).default(0),
});

const READ_MESSAGE = defineOperation<z.output<typeof ReadMessage>>({
	name: "read_message",
	title: "Read a message",
	description:
		"Read one message as plain text, with its headers and the names of its attachments (attachments themselves cannot be read). Long bodies are cut at max_chars; continue with offset set to the returned next_offset. Reading does not mark the message as read.",
	input: ReadMessage,
	needs: [[LABEL, "read"]],
	consent: READ_CONSENT,
	async prepare(binding, data): Promise<Prepared> {
		const [, resource] = await locate(binding, data.message, { format: "minimal" });
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const message = await confirm(binding, resource, data.message, { format: "full" });
				return { records: [{ resource, data: full(message, data.max_chars, data.offset) }] };
			},
		};
	},
});

const ReadThread = z.strictObject({
	thread: messageIdInput().describe("A thread_id from list_messages or read_message."),
	max_chars_per_message: z.int().min(200).max(20_000).default(5_000),
});

const READ_THREAD = defineOperation<z.output<typeof ReadThread>>({
	name: "read_thread",
	title: "Read a conversation",
	description: `Read the messages you may read in one conversation, oldest first, each as plain text cut at max_chars_per_message. Only the conversation's last ${MAX_THREAD_MESSAGES} messages are considered, readable or not; use list_messages and read_message for older ones, and for the rest of a long message.`,
	input: ReadThread,
	needs: [[LABEL, "read"]],
	consent: READ_CONSENT,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: LABEL, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as GmailClient;
				let thread: Awaited<ReturnType<GmailClient["thread"]>>;
				try {
					thread = await client.thread(data.thread);
				} catch (error) {
					if (passesThrough(error) || (error instanceof OperationError && error.code === "RESPONSE_TOO_LARGE")) throw error;
					// A thread that does not exist reads like one with no message you may read.
					if (error instanceof OperationError) return { records: [] };
					throw error;
				}
				if (thread.id !== data.thread) throw client.unexpected();
				const labels = await Labels.fetch(client);
				const keyed = thread.messages
					.filter((m) => m.thread_id === thread.id && ID.test(m.id))
					.map((m) => ({ message: m, key: digitsOr(m.internal_date ?? "", 0n) as bigint }));
				keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
				const messages = keyed.map((item) => item.message);
				const records: ScopedRecord[] = [];
				for (const message of messages.slice(-MAX_THREAD_MESSAGES)) {
					const data_ = full(message, data.max_chars_per_message);
					const truncated = data_.next_offset !== null;
					delete data_.next_offset;
					delete data_.offset;
					delete data_.total_chars;
					data_.body_truncated = truncated;
					const found = record(binding, labels, message, data_);
					if (found !== null) records.push(found);
				}
				return { records, incomplete: messages.length > MAX_THREAD_MESSAGES };
			},
		};
	},
});

export const READS = [LIST_LABELS, LIST_MESSAGES, READ_MESSAGE, READ_THREAD];
export { LIST_LABELS, LIST_MESSAGES, READ_MESSAGE, READ_THREAD };
