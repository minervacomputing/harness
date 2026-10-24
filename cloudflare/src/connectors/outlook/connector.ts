// Outlook mail through Microsoft Graph. Folders are read
// per folder; mail is sent per recipient.
//
// Minerva connects through the Entra app the Microsoft connectors share (connectors/microsoft). The base
// scopes are `offline_access User.Read Mail.Read`; sending asks for `Mail.Send`.
//
// Microsoft's read permission covers the whole mailbox, so the folder limits are Minerva's. Folders are one
// hierarchical kind keyed by immutable folder ids (client.ts), and a grant on a folder covers its
// subfolders. Each call resolves where a folder sits (its chain of parent folders up to the top of the
// mailbox's folders, `msgfolderroot`) before authorization, and again just before it reads or replies: a
// call whose folder moved in between is refused (`MAIL_MOVED`). Folders outside that tree (Exchange's
// system folders) are refused, and so are search folders, which collect mail from other folders and can sit
// anywhere, and hidden folders, wherever they sit and for everything below them; listings leave them out. A
// message is authorized on the folder it lives in, and a listing leaves out any message that does not live
// in the folder listed.
//
// Sending is allowed per recipient address, or per domain: recipients are a second hierarchical kind
// (addresses.ts). Every address a message goes to, To, Cc and Bcc, is a need. A reply goes to the addresses
// the original asks replies to go to (`replyTo`), or else to its sender, as Graph would choose, and needs
// Read on the original's folder and Send on each of them. Minerva names those addresses itself in the reply,
// with empty Cc and Bcc, and refuses replies when an address cannot be parsed, when the addresses changed
// since authorization, to drafts, and to the account's own messages (sent from any of its addresses, its
// mail, sign-in name or SMTP proxy addresses, as sender or as the on-behalf-of sender, or kept in Sent
// Items), whose recipients Graph would work out differently.
//
// Mail is sent as plain text, from the connected account, and saved to Sent Items. Not supported: drafts,
// attachments, forwarding, reply-all, moving, deleting or flagging mail, and shared mailboxes.
//
// This module assembles the connector. The operations are in reads.ts and writes.ts; what they share (Graph
// consent, folder and message ids, where folders sit) is in mailbox.ts.

import { type Connector, type DiscoveryItem, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { ID, TENANCY, accountLabel, oauth } from "../microsoft/index.ts";
import { mapLimited } from "../microsoft/limit.ts";
import * as addresses from "../../lib/addresses.ts";
import { type Folder, GraphClient, ordinary } from "./client.ts";
import { FOLDER, RECIPIENT, ROOT, Tree, connectionError } from "./mailbox.ts";
import { LIST_FOLDERS, LIST_MESSAGES, READ_MESSAGE } from "./reads.ts";
import { REPLY, SEND_MESSAGE } from "./writes.ts";

// Graph allows four concurrent requests per app and mailbox, and Outlook Calendar and a running turn share both.
export const DESCRIBE_CONCURRENCY = 2;
export const MAX_DISCOVER = 500;
export const MAX_DISCOVER_REQUESTS = 60;

/** Folders under the root with their paths, breadth first, as many as a few requests find. */
async function allFolders(client: GraphClient): Promise<[string, string][]> {
	const root = (await client.folder(ROOT)).id;
	const found: [string, string][] = [];
	const queue: [string | null, string][] = [[null, ""]];
	let requests = 0;
	while (queue.length && requests < MAX_DISCOVER_REQUESTS && found.length < MAX_DISCOVER) {
		const [parent, prefix] = queue.shift() as [string | null, string];
		let cursor: string | null = null;
		while (requests < MAX_DISCOVER_REQUESTS) {
			requests++;
			let folders: Folder[];
			[folders, cursor] = await client.folders(parent, 100, cursor);
			for (const folder of folders) {
				if (folder.parentFolderId !== (parent || root) || !ID.test(folder.id) || !ordinary(folder)) continue;
				const path = prefix + folder.displayName;
				found.push([folder.id, path]);
				// A count of 0 or none adds nothing.
				if (folder.childFolderCount) queue.push([folder.id, `${path}/`]);
			}
			if (cursor === null) break;
		}
	}
	return found.slice(0, MAX_DISCOVER);
}

export function outlookConnector(): Connector<GraphClient> {
	return {
		slug: "outlook",
		name: "Outlook",
		kinds: [
			{
				id: FOLDER,
				label: "Folder",
				actions: ["read"],
				wildcard: true,
				hierarchical: true,
				note: "Microsoft lets Minerva read the whole mailbox; Minerva limits agents to the folders allowed here. Access to a folder covers its subfolders.",
			},
			{
				id: RECIPIENT,
				label: "Recipient",
				actions: ["send"],
				wildcard: true,
				hierarchical: true,
				listed: false,
				note:
					"Paste an address or a domain to add it. Everyone at a domain means every address there, " +
					"which for a provider such as gmail.com is everyone with an account. Mail to an address can " +
					"still reach others through distribution lists, aliases and forwarding.",
			},
		],
		actions: [
			{ id: "read", label: "Read mail" },
			{ id: "send", label: "Send mail" },
		],
		// Reading is enough to connect; sending is asked for once the user allows it.
		auth: oauth("Mail.Read"),
		tenancy: TENANCY,
		operations: [LIST_FOLDERS, LIST_MESSAGES, READ_MESSAGE, SEND_MESSAGE, REPLY],

		client(secret, io) {
			return new GraphClient(secret, io);
		},

		async account(client) {
			const user = await client.me();
			return { id: user.id, label: accountLabel(user, "Outlook"), tenants: await client.tenants(user) };
		},

		async discover(client, kind, { query }): Promise<DiscoveryPage> {
			if (kind === RECIPIENT) {
				if (!query) return { items: [] };
				return { items: addresses.choices(query).map((item) => ({ id: item, name: addresses.name(item) })) };
			}
			const found = await allFolders(client);
			const folded = query ? query.toLowerCase() : null;
			const items: DiscoveryItem[] = found.filter(([, path]) => !folded || path.toLowerCase().includes(folded)).map(([id, path]) => ({ id, name: path }));
			return { items };
		},

		async describe(client, kind, ids) {
			if (kind === RECIPIENT) {
				return Object.fromEntries(ids.filter((id) => addresses.validId(id)).map((id) => [id, addresses.name(id)]));
			}
			const tree = new Tree(client);
			await tree.root();
			const wanted = ids.filter((id) => ID.test(id));
			const found = await mapLimited(wanted, DESCRIBE_CONCURRENCY, async (folderId): Promise<string | null> => {
				let folder: Folder;
				let within: string[] | null;
				try {
					folder = await client.folder(folderId);
					within = await tree.place(folder);
				} catch (error) {
					if (!(error instanceof OperationError) || connectionError(error)) throw error;
					return null;
				}
				if (within === null || folder.id !== folderId) return null;
				return tree.path(folder, within);
			});
			return Object.fromEntries(
				wanted.flatMap((id, index) => {
					const name = found[index];
					return typeof name === "string" ? [[id, name]] : [];
				}),
			);
		},
	};
}
