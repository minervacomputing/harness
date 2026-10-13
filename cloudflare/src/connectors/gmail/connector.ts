// Gmail, through the Gmail API. Mail is read per label,
// sent per recipient, and drafted per account.
//
// Minerva connects through the operator's Google app, shared with Google Calendar and Drive (see
// ../google/index.ts). The base scope is `gmail.readonly`; sending asks for `gmail.send`, and drafts for
// `gmail.compose`. Google's read scope covers the whole mailbox, so the label limits are Minerva's.
//
// Labels are one hierarchical kind keyed by label id: the user's labels, and the system labels that say where
// mail is (Inbox, Sent, Drafts, Spam, Trash and the five inbox categories). Gmail nests labels by name, so a
// grant on `Work` covers `Work/Projects` (see mailbox.ts). Marks that say nothing about where mail is (unread,
// starred, important) are never used to authorize it, and chats are refused.
//
// A message can carry several labels. It is authorized as its own resource inside every label it carries and
// their parents: any of them allowed lets an agent read it, and any of them denied hides it. A message without
// such a label (archived mail) is covered only by allowing every label, and a label Minerva does not know makes
// it partial, so that any deny on a label hides it. Labels can change at any time; every call works out where
// its message sits before authorization, and again from fresh labels just before reading or replying, and
// refuses a message that moved in between (`MAIL_MOVED`). A label's name is shown only for labels the agent
// may read: messages carry label ids.
//
// Listings and threads hold mail from many labels, so they are filtered per message, after Gmail has searched
// the whole mailbox. An agent therefore learns whether mail it may not read matches a search (a page with
// hidden results, or a cursor after one), and with Gmail's search language can test what such mail says, as
// with Notion and GitHub search; it never sees the mail itself. Label names are given below their parent, so a
// label never names a parent the agent may not read.
//
// Sending is allowed per recipient address, or per domain, as for Outlook (lib/addresses.ts). Every address a
// message goes to, To, Cc and Bcc, is a need. A reply goes to the original's Reply-To addresses, or else to its
// sender, and needs Read on the original and Send on each; Minerva names them itself, copies nobody else, and
// refuses replies when a header cannot be read strictly (it never falls back from Reply-To to From), when the
// addresses changed since authorization, to drafts, and to the account's own mail (labelled Sent, or from or
// sent by the account's address or any address it sends as). Replies are threaded with In-Reply-To and
// References when the original's Message-ID is well formed.
//
// Drafts are an account-level action: a draft waits in Drafts until the user sends it, so its recipients need
// no send permission. A reply draft also needs Read on the original and is addressed as a reply would be.
//
// Mail is sent as plain text, from the account's default address, and kept in Sent. Not supported: reading
// attachments, forwarding, reply-all, labelling, archiving, deleting or sending drafts.
//
// The operations are in reads.ts and writes.ts; what they share (consent, ids, labels and where messages sit)
// is in mailbox.ts, and MIME handling is in mime.ts.

import type { Connector } from "../../contracts/connectors.ts";
import { ACCOUNT_KIND } from "../../gateway/connector.ts";
import { oauth } from "../google/index.ts";
import { setOwn } from "../google/model.ts";
import * as addresses from "../../lib/addresses.ts";
import { GmailClient } from "./client.ts";
import { LABEL, Labels, READONLY_SCOPE, RECIPIENT } from "./mailbox.ts";
import { READS } from "./reads.ts";
import { WRITES } from "./writes.ts";

export interface GmailOptions {
	/** The API's base URL, for tests. */
	baseUrl?: string;
}

/** Gmail's connector (`GmailConnector`). */
export function gmailConnector(options: GmailOptions = {}): Connector<GmailClient> {
	return {
		slug: "gmail",
		name: "Gmail",
		kinds: [
			{
				id: LABEL,
				label: "Label",
				actions: ["read"],
				wildcard: true,
				hierarchical: true,
				note: "Google lets Minerva read the whole mailbox; Minerva limits agents to mail with the labels allowed here. A message with several labels can be read if one of them is allowed, and is hidden if one of them is denied. Access to a label covers the labels nested under it. Archived mail without labels is covered only by allowing every label.",
			},
			{
				id: RECIPIENT,
				label: "Recipient",
				actions: ["send"],
				wildcard: true,
				hierarchical: true,
				listed: false,
				note: "Paste an address or a domain to add it. Everyone at a domain means every address there, which for a provider such as gmail.com is everyone with an account. Mail to an address can still reach others through mailing lists, aliases and forwarding.",
			},
			{
				id: ACCOUNT_KIND,
				label: "Drafts",
				actions: ["draft"],
				note: "Drafts wait in Gmail until you send them, to any recipient, so drafting needs no recipients.",
			},
		],
		actions: [
			{ id: "read", label: "Read mail" },
			{ id: "send", label: "Send mail" },
			{ id: "draft", label: "Create drafts" },
		],
		// Reading is enough to connect; sending and drafting are asked for once the user allows them.
		auth: oauth(READONLY_SCOPE),
		operations: [...READS, ...WRITES],
		client: (secret, io) => new GmailClient(secret, io, options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		async account(client) {
			// The OpenID subject is stable; the email address can change.
			const user = await client.user();
			return { id: user.sub, label: user.email || user.name || "Gmail" };
		},
		async discover(client, kind, { query }) {
			if (kind === RECIPIENT) {
				if (!query) return { items: [] };
				return { items: addresses.choices(query).map((item) => ({ id: item, name: addresses.name(item) })) };
			}
			const labels = await Labels.fetch(client);
			const folded = query ? query.toLowerCase() : null;
			const items = [...labels.grantable.keys()].map((labelId) => ({ id: labelId, name: labels.name(labelId) }));
			return { items: items.filter((item) => !folded || item.name.toLowerCase().includes(folded)) };
		},
		async describe(client, kind, ids) {
			const names: { [id: string]: string } = {};
			if (kind === RECIPIENT) {
				for (const id of ids) if (addresses.validId(id)) setOwn(names, id, addresses.name(id));
				return names;
			}
			const labels = await Labels.fetch(client);
			for (const id of ids) if (labels.grantable.has(id)) setOwn(names, id, labels.name(id));
			return names;
		},
	};
}
