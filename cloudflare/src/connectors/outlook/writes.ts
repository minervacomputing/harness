// Outlook's write operations: sending mail and replying to
// it.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import type { User } from "../microsoft/index.ts";
import { after, objectCheck, plainTextOf, singleLineOf } from "../microsoft/inputs.ts";
import * as addresses from "../../lib/addresses.ts";
import { type GraphClient, type Message, REPLY_FIELDS, type Recipient } from "./client.ts";
import { FOLDER, RECIPIENT, SEND_CONSENT, Tree, confirmMessage, locate, messageId } from "./mailbox.ts";
import { TextError } from "../../lib/text.ts";

export const MAX_RECIPIENTS = 10;
export const MAX_BODY = 20_000;

/** `addresses.checked` as a field validator. */
function checkedAddress(raw: string): string {
	const checked = addresses.checked(raw);
	if (!checked.ok) throw new TextError(checked.message);
	return checked.address;
}

const Address = () => after(z.string().trim().min(3).max(addresses.MAX_ADDRESS), checkedAddress);
const Body = () => plainTextOf(z.string().trim().min(1).max(MAX_BODY).describe("Plain text; sent as it is, not as HTML."));

export const WRITE_NOTE =
	"Mail is sent as plain text from the connected account and saved to Sent Items. Outlook accepts it " +
	"before delivering it; a bounce arrives later as mail.";

function clientOf(binding: Binding): GraphClient {
	return binding.client as GraphClient;
}

function recipientResource(binding: Binding, address: string): Resource {
	if (address === addresses.UNSUPPORTED) {
		// Never named by a grant; only allowing every recipient passes it, and the reply is then refused.
		return binding.resource(RECIPIENT, address, [], true);
	}
	return binding.resource(RECIPIENT, address, addresses.ancestors(address));
}

function graphRecipients(values: readonly string[]): Json[] {
	return values.map((value) => ({ emailAddress: { address: value } }));
}

export const SendMessage = z
	.strictObject({
		to: z.array(Address()).min(1).max(MAX_RECIPIENTS),
		cc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		bcc: z.array(Address()).max(MAX_RECIPIENTS).default([]),
		subject: singleLineOf(z.string().trim().min(1).max(255)),
		body: Body(),
	})
	.check(
		objectCheck((data: { to: string[]; cc: string[]; bcc: string[] }) => {
			const everyone = [...data.to, ...data.cc, ...data.bcc];
			if (new Set(everyone).size !== everyone.length) throw new TextError("each address may appear only once");
			if (everyone.length > MAX_RECIPIENTS) throw new TextError(`a message may go to at most ${MAX_RECIPIENTS} addresses`);
		}),
	);

export const SEND_MESSAGE = defineOperation<z.output<typeof SendMessage>>({
	name: "send_message",
	title: "Send mail",
	description: `Send a new message. Every address in to, cc and bcc needs send permission. ${WRITE_NOTE}`,
	input: SendMessage,
	needs: [[RECIPIENT, "send"]],
	outputAction: "send",
	consent: SEND_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const everyone = [...data.to, ...data.cc, ...data.bcc];
		return {
			requirements: everyone.map((address) => ({ need: recipientResource(binding, address), action: "send" })),
			async execute(): Promise<ProviderOutput> {
				// Only these fields: never a sender, reply-to address, headers or attachments.
				await clientOf(binding).send({
					subject: data.subject,
					body: { contentType: "Text", content: data.body },
					toRecipients: graphRecipients(data.to),
					ccRecipients: graphRecipients(data.cc),
					bccRecipients: graphRecipients(data.bcc),
				});
				const record = { sent: true, to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject };
				return { records: [{ resource: recipientResource(binding, data.to[0] as string), data: record }] };
			},
		};
	},
});

function rawAddress(recipient: Recipient | null): string | null {
	return recipient !== null && recipient.emailAddress !== null ? recipient.emailAddress.address : null;
}

function parsedOrNull(raw: string | null): string | null {
	try {
		return addresses.parse(raw || "");
	} catch (error) {
		if (error instanceof OperationError) return null;
		throw error;
	}
}

/**
 * The addresses Graph sends a reply to, the original's reply-to addresses if it has any,
 * otherwise its sender (RFC 5322). One Minerva cannot name as an address makes the whole reply unsupported.
 */
export function replyTargets(message: Message): string[] {
	const sources = message.replyTo.length ? message.replyTo : message.from !== null ? [message.from] : [];
	const targets: string[] = [];
	for (const source of sources) {
		const address = parsedOrNull(rawAddress(source));
		if (address === null) return [addresses.UNSUPPORTED];
		if (!targets.includes(address)) targets.push(address);
	}
	if (!targets.length || targets.length > MAX_RECIPIENTS) return [addresses.UNSUPPORTED];
	return targets;
}

/**
 * The account's mail and sign-in names, and its aliases (Exchange lists them as `SMTP:` or
 * `smtp:` proxy addresses, beside other kinds such as `X500:`).
 */
export function ownAddresses(user: User): Set<string> {
	const aliases = user.proxyAddresses.filter((raw) => raw.slice(0, 5).toLowerCase() === "smtp:").map((raw) => raw.slice(5));
	const own = new Set<string>();
	for (const raw of [user.mail, user.userPrincipalName, ...aliases]) {
		const address = parsedOrNull(raw);
		if (address !== null) own.add(address);
	}
	return own;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

export const Reply = z.strictObject({ message: messageId(), body: Body() });

export const REPLY = defineOperation<z.output<typeof Reply>>({
	name: "reply",
	title: "Reply to a message",
	description:
		"Reply to a message you may read. The reply goes to the addresses the message asks replies " +
		"to go to, or else to its sender, and each needs send permission; nobody else is copied. " +
		WRITE_NOTE,
	input: Reply,
	needs: [
		[FOLDER, "read"],
		[RECIPIENT, "send"],
	],
	consent: SEND_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const tree = new Tree(client);
		const [original, resource] = await locate(binding as Binding<GraphClient>, tree, data.message, REPLY_FIELDS);
		const targets = replyTargets(original);
		return {
			requirements: [{ need: resource, action: "read" }, ...targets.map((target) => ({ need: recipientResource(binding, target), action: "send" }))],
			async execute(): Promise<ProviderOutput> {
				if (sameList(targets, [addresses.UNSUPPORTED])) {
					throw new OperationError("UNSUPPORTED_RECIPIENT", "Minerva cannot tell who a reply to this message would go to. Use send_message instead.");
				}
				const own = ownAddresses(await client.identities());
				const sentItems = (await client.folder("sentitems")).id;
				// The last reads before the write: the message and its folder, as they are now.
				const message = await confirmMessage(binding as Binding<GraphClient>, tree, resource, data.message, REPLY_FIELDS);
				if (message.isDraft !== false) {
					// A draft's recipients and reply-to addresses can still change; a sent message's cannot.
					throw new OperationError("UNSUPPORTED_MESSAGE", "Minerva does not reply to drafts.");
				}
				if (!sameList(replyTargets(message), targets)) throw new OperationError("MESSAGE_CHANGED", "Who this message's replies go to changed. Try again.");
				const sender = parsedOrNull(rawAddress(message.from));
				const delegate = parsedOrNull(rawAddress(message.sender));
				if (sender === null || own.has(sender) || (delegate !== null && own.has(delegate)) || message.parentFolderId === sentItems) {
					throw new OperationError("UNSUPPORTED_MESSAGE", "Minerva does not reply to messages sent from this account. Use send_message instead.");
				}
				// The recipients are named, and Cc and Bcc emptied, so the reply goes to exactly the addresses that
				// were authorized, whether Graph would otherwise add to them or work them out itself.
				await client.reply(message.id, {
					toRecipients: graphRecipients(targets),
					ccRecipients: [],
					bccRecipients: [],
					body: { contentType: "Text", content: data.body },
				});
				return { records: [{ resource, data: { replied: true, message: message.id, to: targets } }] };
			},
		};
	},
});
