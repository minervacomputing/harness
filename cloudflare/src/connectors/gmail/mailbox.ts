// What Gmail's operations share: consent, ids, labels and where messages sit.
//
// A message is not a resource users choose. It is authorized as `message:<id>` inside every grantable label
// it carries, and inside those labels' parents, so a grant on any of them covers it and a deny on any of them
// hides it (see connector.ts).

import { z } from "zod";
import { type Binding, OperationError, denied } from "../../gateway/connector.ts";
import { ProviderServerError } from "../../gateway/http.ts";
import type { Resource } from "../../gateway/policy.ts";
import { type Format, type GmailClient, ID, type Label, type Message } from "./client.ts";

export const LABEL = "label";
export const RECIPIENT = "recipient";

const SCOPE = "https://www.googleapis.com/auth/";
export const READONLY_SCOPE = `${SCOPE}gmail.readonly`;
export const SEND_SCOPE = `${SCOPE}gmail.send`;
export const COMPOSE_SCOPE = `${SCOPE}gmail.compose`;
export const MODIFY_SCOPE = `${SCOPE}gmail.modify`;
export const FULL_SCOPE = "https://mail.google.com/";

export const READ_CONSENT = [[READONLY_SCOPE], [MODIFY_SCOPE], [FULL_SCOPE]];
export const SEND_CONSENT = [[SEND_SCOPE], [COMPOSE_SCOPE], [MODIFY_SCOPE], [FULL_SCOPE]];
/** A reply reads the original and the account's addresses, then sends. */
export const REPLY_CONSENT = [[READONLY_SCOPE, SEND_SCOPE], [READONLY_SCOPE, COMPOSE_SCOPE], [MODIFY_SCOPE], [FULL_SCOPE]];
export const DRAFT_CONSENT = [[COMPOSE_SCOPE], [MODIFY_SCOPE], [FULL_SCOPE]];
export const REPLY_DRAFT_CONSENT = [[READONLY_SCOPE, COMPOSE_SCOPE], [MODIFY_SCOPE], [FULL_SCOPE]];

/** System labels users can choose, with the names shown for them. */
export const SYSTEM_LABELS: ReadonlyMap<string, string> = new Map([
	["INBOX", "Inbox"],
	["SENT", "Sent"],
	["DRAFT", "Drafts"],
	["SPAM", "Spam"],
	["TRASH", "Trash"],
	["CATEGORY_PERSONAL", "Category: Primary"],
	["CATEGORY_SOCIAL", "Category: Social"],
	["CATEGORY_PROMOTIONS", "Category: Promotions"],
	["CATEGORY_UPDATES", "Category: Updates"],
	["CATEGORY_FORUMS", "Category: Forums"],
]);
/**
 * Marks that say nothing about where a message belongs, and that Gmail sets by itself (IMPORTANT): never
 * used to authorize a message.
 */
const MARKS: ReadonlySet<string> = new Set(["UNREAD", "STARRED", "IMPORTANT"]);
/** Chats are not mail; messages carrying this label are refused. */
const CHAT = "CHAT";
export const SPAM_TRASH: ReadonlySet<string> = new Set(["SPAM", "TRASH"]);
const MESSAGE_PREFIX = "message:";
/** The executor's limit on a resource's ancestors. */
const MAX_WITHIN = 64;
/** Errors about the connection, not about the object a call names; they say nothing about that object. */
const CONNECTION_ERRORS: ReadonlySet<string> = new Set(["CONNECTION_UNAUTHORIZED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNSUPPORTED_ACCOUNT"]);

/**
 * An error that says nothing about the message or thread a call names, so it is reported as it is: one about the
 * connection, or Gmail failing (a 5xx). A 403 stays a refusal, since Google does not document that none is ever about
 * the object named.
 */
export function connectionError(error: unknown): boolean {
	return error instanceof ProviderServerError || (error instanceof OperationError && CONNECTION_ERRORS.has(error.code));
}

export function moved(): OperationError {
	return new OperationError("MAIL_MOVED", "This message or label changed while Minerva was using it. Try again.");
}

function unsupportedMessage(): OperationError {
	return new OperationError("UNSUPPORTED_MESSAGE", "Minerva does not read chats or mail with this many labels.");
}

/** A message or thread id from list_messages. */
export function messageIdInput() {
	return z.string().trim().min(1).max(64).refine((value) => ID.test(value), { message: "must be an id from list_messages" });
}

export function sameResource(a: Resource, b: Resource): boolean {
	return (
		a.connectionId === b.connectionId &&
		a.kind === b.kind &&
		a.id === b.id &&
		a.partial === b.partial &&
		a.within.length === b.within.length &&
		a.within.every((id, i) => id === b.within[i])
	);
}

/** The mailbox's labels as one `labels.list` response gave them. */
export class Labels {
	readonly grantable = new Map<string, Label>();
	private readonly userNames = new Map<string, string>();

	constructor(labels: readonly Label[]) {
		for (const label of labels) {
			if (!ID.test(label.id)) continue;
			if (label.type === "user" || SYSTEM_LABELS.has(label.id)) this.grantable.set(label.id, label);
			if (label.type === "user") {
				const folded = label.name.toLowerCase();
				if (!this.userNames.has(folded)) this.userNames.set(folded, label.id);
			}
		}
	}

	static async fetch(client: GmailClient): Promise<Labels> {
		return new Labels(await client.labels());
	}

	private label(labelId: string): Label {
		const label = this.grantable.get(labelId);
		if (label === undefined) throw new Error(`Label ${labelId} is not grantable.`);
		return label;
	}

	name(labelId: string): string {
		const label = this.label(labelId);
		return label.type === "user" ? label.name : (SYSTEM_LABELS.get(labelId) as string);
	}

	/**
	 * A user label's parents, nearest first, each with the number of name segments it covers: Gmail nests
	 * labels by name, so `Work/Projects` sits under the user label named `Work` when there is one. Names are
	 * compared without case, as Gmail does.
	 */
	private parents(labelId: string): [number, string][] {
		const label = this.label(labelId);
		if (label.type !== "user") return [];
		const parts = label.name.split("/");
		const found: [number, string][] = [];
		for (let end = parts.length - 1; end > 0; end--) {
			const parent = this.userNames.get(parts.slice(0, end).join("/").toLowerCase());
			if (parent !== undefined && parent !== labelId && !found.some(([, p]) => p === parent)) found.push([end, parent]);
		}
		return found;
	}

	ancestors(labelId: string): string[] {
		return this.parents(labelId).map(([, parent]) => parent);
	}

	/**
	 * The label's name below its nearest parent (`Projects` for `Work/Projects`), so that a label's name does
	 * not name a parent the agent may not read.
	 */
	shortName(labelId: string): string {
		const parents = this.parents(labelId);
		if (!parents.length) return this.name(labelId);
		return this.label(labelId)
			.name.split("/")
			.slice((parents[0] as [number, string])[0])
			.join("/");
	}

	/** A label a call names, as the resource authorized; one Minerva does not offer is refused like a label without a grant. */
	resource(binding: Binding, labelId: string): Resource {
		if (!this.grantable.has(labelId)) throw denied();
		return binding.resource(LABEL, labelId, this.ancestors(labelId));
	}

	/**
	 * Where a message sits: inside each grantable label it carries and their parents. A label Minerva does not
	 * know makes the chain partial, so any deny on a label hides the message.
	 */
	message(binding: Binding, message: Message): Resource {
		if (message.labelIds.includes(CHAT)) throw unsupportedMessage();
		const within: string[] = [];
		let partial = false;
		for (const labelId of message.labelIds) {
			if (MARKS.has(labelId)) continue;
			if (!this.grantable.has(labelId)) {
				partial = true;
				continue;
			}
			for (const item of [labelId, ...this.ancestors(labelId)]) if (!within.includes(item)) within.push(item);
		}
		if (within.length > MAX_WITHIN) throw unsupportedMessage();
		return binding.resource(LABEL, MESSAGE_PREFIX + message.id, within, partial);
	}
}

export interface Fetch {
	format: Format;
	headers?: readonly string[];
}

function fetchMessage(client: GmailClient, messageId: string, fetch: Fetch): Promise<Message> {
	return fetch.headers === undefined ? client.message(messageId, fetch.format) : client.message(messageId, fetch.format, fetch.headers);
}

/**
 * A message and where it sits, before authorization. A message Minerva cannot read or place is refused like
 * one without a grant.
 */
export async function locate(binding: Binding, messageId: string, fetch: Fetch): Promise<[Message, Resource]> {
	const client = binding.client as GmailClient;
	let message: Message;
	try {
		message = await fetchMessage(client, messageId, fetch);
	} catch (error) {
		if (connectionError(error)) throw error;
		if (error instanceof OperationError) throw denied();
		throw error;
	}
	if (message.id !== messageId) throw denied();
	// Labels after the message, so that where they sit is never older than the labels it carries.
	const labels = await Labels.fetch(client);
	try {
		return [message, labels.message(binding, message)];
	} catch (error) {
		if (error instanceof OperationError) throw denied();
		throw error;
	}
}

/** The message again, refused if its labels, or where they sit, changed since it was authorized. */
export async function confirm(binding: Binding, resource: Resource, messageId: string, fetch: Fetch): Promise<Message> {
	const client = binding.client as GmailClient;
	let message: Message;
	try {
		message = await fetchMessage(client, messageId, fetch);
	} catch (error) {
		if (connectionError(error) || (error instanceof OperationError && error.code === "RESPONSE_TOO_LARGE")) throw error;
		if (error instanceof OperationError) throw moved();
		throw error;
	}
	if (message.id !== messageId) throw moved();
	const labels = await Labels.fetch(client);
	let fresh: Resource;
	try {
		fresh = labels.message(binding, message);
	} catch (error) {
		if (error instanceof OperationError) throw moved();
		throw error;
	}
	if (!sameResource(fresh, resource)) throw moved();
	return message;
}
