// Intercom's write operations: internal notes and replies to customers.
//
// Both are sent as the connected teammate. Each write reads its conversation again just before sending, and
// refuses one that moved to another inbox (`CONVERSATION_MOVED`). That cannot stop a reassignment that lands
// between that read and the write: Intercom's reply endpoint takes no condition on where a conversation is, and
// assignment rules reassign conversations on their own. The record names the inbox the conversation is in after
// the write.

import { z } from "zod";
import { type Binding, type Prepared, type ProviderOutput, defineOperation } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { PLAIN_TEXT, isPlainText } from "../../lib/text.ts";
import type { Conversation } from "./client.ts";
import * as html from "./html.ts";
import { ConversationId, INBOX, clientOf, confirmConversation, inboxOf, inboxResource, iso, resolveConversation } from "./inboxes.ts";

export const MAX_TEXT = 10_000;

/** Plain text that does not address Intercom; the first check that fails is the one reported. */
const WrittenText = () =>
	z.string().trim().min(1).max(MAX_TEXT)
		.refine(isPlainText, PLAIN_TEXT)
		.refine((text) => !html.toIntercom(text), html.NOT_INTERCOM)
		.describe("Plain text, shown literally: no formatting, mentions or links to Intercom.");

export const RACE_NOTE = "If the conversation is reassigned to another team at the moment of writing, the write can land there.";

const AddNote = z.strictObject({ conversation: ConversationId(), text: WrittenText() });
const Reply = z.strictObject({ conversation: ConversationId(), text: WrittenText() });
type Write = z.output<typeof AddNote>;

function partIds(conversation: Conversation): Set<string> {
	const found = conversation.conversation_parts;
	return new Set(found !== null ? found.conversation_parts.map((part) => part.id) : []);
}

/**
 * The id and time of the part just written: the one part of this type by this teammate that the read before
 * the write did not have. Null when Intercom's answer shows none, or several (the teammate wrote elsewhere at
 * the same moment).
 */
function written(conversation: Conversation, before: Set<string>, adminId: string, partType: string): [string | null, string | null] {
	const found = conversation.conversation_parts;
	const fresh = (found !== null ? found.conversation_parts : []).filter(
		(part) =>
			!before.has(part.id) && part.part_type === partType && part.author !== null && part.author.type === "admin" && part.author.id === adminId,
	);
	const [part] = fresh;
	return fresh.length === 1 && part !== undefined ? [part.id, iso(part.created_at)] : [null, null];
}

function prepareWrite(messageType: "note" | "comment", action: string) {
	return async (binding: Binding, data: Write): Promise<Prepared> => {
		const client = clientOf(binding);
		const [resource] = await resolveConversation(binding, data.conversation);
		const adminId = (await client.me()).id;
		return {
			requirements: [{ need: resource, action }],
			async execute(): Promise<ProviderOutput> {
				const before = partIds(await confirmConversation(binding, resource, data.conversation));
				const body: { [key: string]: Json } = {
					message_type: messageType,
					type: "admin",
					admin_id: adminId,
					body: html.written(data.text),
				};
				const conversation = await client.reply(data.conversation, body);
				const [partId, created] = written(conversation, before, adminId, messageType);
				const record = {
					written: true,
					conversation_id: conversation.id,
					inbox: inboxOf(conversation),
					part_id: partId,
					created,
				};
				// Automation can reassign a conversation at once: the record names the inbox it is in now.
				return { records: [{ resource: inboxResource(binding, inboxOf(conversation)), data: record }] };
			},
		};
	};
}

export const ADD_NOTE = defineOperation<Write>({
	name: "add_note",
	title: "Add an internal note",
	description: `Add an internal note to an Intercom conversation in an inbox where you have note permission. Notes are seen by teammates only, posted as the connected teammate. ${RACE_NOTE}`,
	input: AddNote,
	needs: [[INBOX, "note"]],
	prepare: prepareWrite("note", "note"),
	mutates: true,
});

export const REPLY = defineOperation<Write>({
	name: "reply",
	title: "Reply to the customer",
	description: `Reply to the customer in an Intercom conversation in an inbox where you have reply permission. The customer receives it by email or in the Messenger, sent as the connected teammate; replying can reopen the conversation. ${RACE_NOTE}`,
	input: Reply,
	needs: [[INBOX, "reply"]],
	prepare: prepareWrite("comment", "reply"),
	mutates: true,
});
