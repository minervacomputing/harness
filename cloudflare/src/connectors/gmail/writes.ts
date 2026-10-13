// Gmail's write operations: sending mail, replying, and saving
// drafts.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, Requirement } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { ACCOUNT_KIND, OperationError, defineOperation } from "../../gateway/connector.ts";
import type { JsonObject } from "../../lib/json.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine } from "../../lib/text.ts";
import * as addresses from "../../lib/addresses.ts";
import { type GmailClient, type Message, REPLY_HEADERS, headersOf } from "./client.ts";
import {
	DRAFT_CONSENT,
	type Fetch,
	LABEL,
	RECIPIENT,
	REPLY_CONSENT,
	REPLY_DRAFT_CONSENT,
	SEND_CONSENT,
	confirm,
	locate,
	messageIdInput,
} from "./mailbox.ts";
import * as mime from "./mime.ts";

export const MAX_RECIPIENTS = 10;
export const MAX_BODY = 20_000;
/** Enough of the original to reply to it: its labels and the headers that address and thread a reply. */
const REPLY_FETCH: Fetch = { format: "metadata", headers: REPLY_HEADERS };

/** The canonical address (`addresses.checked` as an AfterValidator). */
const Address = () =>
	z.string().trim().min(3).max(addresses.MAX_ADDRESS).transform((value, ctx) => {
		const result = addresses.checked(value);
		if (result.ok) return result.address;
		ctx.addIssue({ code: "custom", message: result.message, input: value });
		return z.NEVER;
	});
const Subject = () => z.string().trim().min(1).max(255).refine(isSingleLine, SINGLE_LINE);
const Body = () => z.string().trim().min(1).max(MAX_BODY).describe("Plain text; sent as it is, not as HTML.").refine(isPlainText, PLAIN_TEXT);

const SEND_NOTE =
	"Mail is sent as plain text from the account's default address and kept in Sent. Gmail accepts it before delivering it; a bounce arrives later as mail.";
const DRAFT_NOTE = "The draft is saved in Drafts for the user to review and send; nothing is sent.";

function recipient(binding: Binding, address: string): Resource {
	if (address === addresses.UNSUPPORTED) {
		// Never named by a grant; only allowing every recipient passes it, and the reply is then refused.
		return binding.resource(RECIPIENT, address, [], true);
	}
	return binding.resource(RECIPIENT, address, addresses.ancestors(address));
}

/** `Recipients`' model validator, once every field passed (zod runs it after a failed one; the executor then drops its issue). */
function distinct(data: { to: string[]; cc: string[]; bcc: string[] }, ctx: z.RefinementCtx): void {
	const everyone = [...data.to, ...data.cc, ...data.bcc];
	if (new Set(everyone).size !== everyone.length) {
		ctx.addIssue({ code: "custom", message: "each address may appear only once", input: data });
		return;
	}
	if (everyone.length > MAX_RECIPIENTS) ctx.addIssue({ code: "custom", message: `a message may go to at most ${MAX_RECIPIENTS} addresses`, input: data });
}

const SendMessage = z
	.strictObject({
		to: z.array(Address()).min(1).max(MAX_RECIPIENTS),
		cc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		bcc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		subject: Subject(),
		body: Body(),
	})
	.superRefine(distinct);

type SendMessageInput = z.output<typeof SendMessage>;

const SEND_MESSAGE = defineOperation<SendMessageInput>({
	name: "send_message",
	title: "Send mail",
	description: `Send a new message. Every address in to, cc and bcc needs send permission. ${SEND_NOTE}`,
	input: SendMessage,
	needs: [[RECIPIENT, "send"]],
	outputAction: "send",
	consent: SEND_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const everyone = [...data.to, ...data.cc, ...data.bcc];
		return {
			requirements: everyone.map((address): Requirement => ({ need: recipient(binding, address), action: "send" })),
			async execute(): Promise<ProviderOutput> {
				const raw = mime.raw({ to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject, body: data.body });
				const sent = await (binding.client as GmailClient).send(raw, null);
				const record: JsonObject = {
					sent: true,
					id: sent.id,
					thread_id: sent.threadId,
					to: data.to,
					cc: data.cc,
					bcc: data.bcc,
					subject: data.subject,
				};
				return { records: [{ resource: recipient(binding, data.to[0] as string), data: record }] };
			},
		};
	},
});

/**
 * Who a reply goes to: the original's Reply-To addresses if it has the header, otherwise its sender (RFC
 * 5322). A header Minerva cannot read strictly makes the whole reply unsupported; it never falls back to
 * another header.
 */
function replyTargets(message: Message): string[] {
	const replyTo = headersOf(message, "Reply-To");
	const targets = mime.mailboxes(replyTo.length ? replyTo : headersOf(message, "From"));
	if (!targets || targets.length > MAX_RECIPIENTS) return [addresses.UNSUPPORTED];
	return targets;
}

function unsupportedRecipients(): OperationError {
	return new OperationError("UNSUPPORTED_RECIPIENT", "Minerva cannot tell who a reply to this message would go to. Use send_message instead.");
}

/**
 * The original, read last before the write and refused if it changed, is the account's own mail, or is a
 * draft (whose recipients can still change).
 */
async function replyable(binding: Binding, resource: Resource, messageId: string, targets: string[]): Promise<Message> {
	const client = binding.client as GmailClient;
	if (targets.length === 1 && targets[0] === addresses.UNSUPPORTED) throw unsupportedRecipients();
	const own = new Set<string>();
	for (const raw of await client.ownAddresses()) {
		try {
			own.add(addresses.parse(raw));
		} catch (error) {
			if (error instanceof OperationError) continue;
			throw error;
		}
	}
	const message = await confirm(binding, resource, messageId, REPLY_FETCH);
	const now = replyTargets(message);
	if (now.length !== targets.length || now.some((address, i) => address !== targets[i])) {
		throw new OperationError("MESSAGE_CHANGED", "Who this message's replies go to changed. Try again.");
	}
	const sender = mime.mailboxes(headersOf(message, "From"));
	const sentBy = mime.mailboxes(headersOf(message, "Sender"));
	const ours = (found: string[]) => found.some((address) => own.has(address));
	if (
		message.labelIds.includes("SENT") ||
		message.labelIds.includes("DRAFT") ||
		sender === null ||
		ours(sender) ||
		(headersOf(message, "Sender").length > 0 && (sentBy === null || ours(sentBy)))
	) {
		throw new OperationError("UNSUPPORTED_MESSAGE", "Minerva does not reply to drafts or to messages sent from this account. Use send_message instead.");
	}
	return message;
}

function replyRaw(message: Message, targets: string[], body: string): string {
	// Only the authorized targets, and no Cc or Bcc: nobody else is copied.
	return mime.raw({
		to: targets,
		subject: mime.replySubject(headersOf(message, "Subject")[0] ?? null),
		body,
		inReplyTo: mime.threading(headersOf(message, "Message-ID"), headersOf(message, "References")),
	});
}

const Reply = z.strictObject({ message: messageIdInput(), body: Body() });
type ReplyInput = z.output<typeof Reply>;

const REPLY = defineOperation<ReplyInput>({
	name: "reply",
	title: "Reply to a message",
	description: `Reply to a message you may read, in its conversation. The reply goes to the addresses the message asks replies to go to, or else to its sender, and each needs send permission; nobody else is copied. ${SEND_NOTE}`,
	input: Reply,
	needs: [
		[LABEL, "read"],
		[RECIPIENT, "send"],
	],
	consent: REPLY_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [original, resource] = await locate(binding, data.message, REPLY_FETCH);
		const targets = replyTargets(original);
		return {
			requirements: [{ need: resource, action: "read" }, ...targets.map((target): Requirement => ({ need: recipient(binding, target), action: "send" }))],
			async execute(): Promise<ProviderOutput> {
				const message = await replyable(binding, resource, data.message, targets);
				const sent = await (binding.client as GmailClient).send(replyRaw(message, targets, data.body), message.threadId);
				const record: JsonObject = { replied: true, id: sent.id, thread_id: sent.threadId, to: targets };
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const CreateDraft = z
	.strictObject({
		to: z.array(Address()).min(1).max(MAX_RECIPIENTS),
		cc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		bcc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		subject: Subject(),
		body: Body(),
	})
	.superRefine(distinct);

type CreateDraftInput = z.output<typeof CreateDraft>;

const CREATE_DRAFT = defineOperation<CreateDraftInput>({
	name: "create_draft",
	title: "Draft a message",
	description: `Save a new message as a draft. Its recipients need no send permission, since the user sends drafts themselves. ${DRAFT_NOTE}`,
	input: CreateDraft,
	needs: [[ACCOUNT_KIND, "draft"]],
	outputAction: "draft",
	consent: DRAFT_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: binding.account(), action: "draft" }],
			async execute(): Promise<ProviderOutput> {
				const raw = mime.raw({ to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject, body: data.body });
				const draft = await (binding.client as GmailClient).createDraft(raw, null);
				const record: JsonObject = {
					draft_id: draft.id,
					id: draft.message.id,
					thread_id: draft.message.threadId,
					to: data.to,
					cc: data.cc,
					bcc: data.bcc,
					subject: data.subject,
				};
				return { records: [{ resource: binding.account(), data: record }] };
			},
		};
	},
});

const CREATE_REPLY_DRAFT = defineOperation<ReplyInput>({
	name: "create_reply_draft",
	title: "Draft a reply",
	description: `Save a reply to a message you may read as a draft in its conversation, addressed as reply would address it. ${DRAFT_NOTE}`,
	input: Reply,
	needs: [
		[LABEL, "read"],
		[ACCOUNT_KIND, "draft"],
	],
	outputAction: "draft",
	consent: REPLY_DRAFT_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [original, resource] = await locate(binding, data.message, REPLY_FETCH);
		const targets = replyTargets(original);
		return {
			requirements: [
				{ need: resource, action: "read" },
				{ need: binding.account(), action: "draft" },
			],
			async execute(): Promise<ProviderOutput> {
				const message = await replyable(binding, resource, data.message, targets);
				const draft = await (binding.client as GmailClient).createDraft(replyRaw(message, targets, data.body), message.threadId);
				const record: JsonObject = {
					draft_id: draft.id,
					id: draft.message.id,
					thread_id: draft.message.threadId,
					in_reply_to: message.id,
					to: targets,
				};
				return { records: [{ resource: binding.account(), data: record }] };
			},
		};
	},
});

export const WRITES = [SEND_MESSAGE, REPLY, CREATE_DRAFT, CREATE_REPLY_DRAFT];
export { SEND_MESSAGE, REPLY, CREATE_DRAFT, CREATE_REPLY_DRAFT };
