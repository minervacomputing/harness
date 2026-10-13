// What Intercom's operations share: inboxes, conversation names, and where conversations are.

import { z } from "zod";
import { type Binding, OperationError, denied } from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { type Conversation, ID, type IntercomClient } from "./client.ts";
import { formatUtc } from "../../lib/dates.ts";

export const INBOX = "inbox";
/** The inbox of conversations no team is assigned to: unassigned ones, and ones assigned to a teammate only. */
export const NO_TEAM = "none";
export const NO_TEAM_NAME = "No team";
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN"]);

export const INBOX_NAME = 'must be a team id from list_inboxes, or "none"';
export const CONVERSATION_NAME = "must be a conversation id";

/** `InboxName`: a team inbox's id, or "none". */
export function InboxName() {
	return z.string().trim().min(1).max(20)
		.refine((value) => value === NO_TEAM || ID.test(value), INBOX_NAME)
		.describe('A team inbox\'s id, from list_inboxes, or "none" for conversations with no team.');
}

/** `ConversationId`: a conversation's id. */
export function ConversationId() {
	return z.string().trim().min(1).max(20)
		.refine((value) => ID.test(value), CONVERSATION_NAME)
		.describe("A conversation's id, from search_conversations.");
}

export function clientOf(binding: Binding): IntercomClient {
	return binding.client as IntercomClient;
}

/** Errors by which Intercom hides what the account cannot see. */
export function unseen(error: unknown): error is OperationError {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

/**
 * A read that does not say which inbox the conversation is in. One too large to read cannot be placed, and an
 * error naming its size would say that it exists, so it is treated like one the account cannot see.
 */
export function unplaced(error: unknown): error is OperationError {
	return unseen(error) || (error instanceof OperationError && error.code === "RESPONSE_TOO_LARGE");
}

export function conversationMoved(): OperationError {
	return new OperationError(
		"CONVERSATION_MOVED",
		"This conversation moved to another inbox in Intercom while Minerva was using it, or access was lost. Try again.",
	);
}

export function inboxOf(conversation: Conversation): string {
	const team = conversation.team_assignee_id;
	return !team ? NO_TEAM : String(team);
}

export function inboxResource(binding: Binding, inbox: string): Resource {
	if (inbox !== NO_TEAM && !ID.test(inbox)) throw clientOf(binding).unexpected();
	return binding.resource(INBOX, inbox);
}

/** The inbox a call names. A team the account cannot see is refused like one without a grant. */
export async function resolveInbox(binding: Binding, name: string): Promise<Resource> {
	if (name !== NO_TEAM && !new Set((await clientOf(binding).teams()).map((team) => team.id)).has(name)) throw denied();
	return inboxResource(binding, name);
}

/**
 * The conversation a call names and the inbox it is in now. One the account cannot see is refused like one
 * without a grant.
 */
export async function resolveConversation(binding: Binding, conversationId: string): Promise<[Resource, Conversation]> {
	let conversation: Conversation;
	try {
		conversation = await clientOf(binding).conversation(conversationId);
	} catch (error) {
		if (unplaced(error)) throw denied();
		throw error;
	}
	return [inboxResource(binding, inboxOf(conversation)), conversation];
}

/** The conversation read again, refused unless it is still in the inbox it was authorized in. */
export async function confirmConversation(binding: Binding, resource: Resource, conversationId: string): Promise<Conversation> {
	let conversation: Conversation;
	try {
		conversation = await clientOf(binding).conversation(conversationId);
	} catch (error) {
		if (unseen(error)) throw conversationMoved();
		throw error;
	}
	if (inboxResource(binding, inboxOf(conversation)).id !== resource.id) throw conversationMoved();
	return conversation;
}

/** The last second shown with a four-digit year: 9999-12-31T23:59:59Z. */
const MAX_TIMESTAMP = 253_402_300_799;

/** A time Intercom gives in Unix seconds, as records show it, or null for one that is not a positive whole second. */
export function iso(timestamp: number | null): string | null {
	if (timestamp === null || !Number.isInteger(timestamp) || timestamp <= 0 || timestamp > MAX_TIMESTAMP) return null;
	return formatUtc(BigInt(timestamp) * 1_000_000n);
}
