// Intercom. Resources are inboxes; agents read and search
// conversations, add internal notes and reply to customers.
//
// A connection is one teammate (admin) in one Intercom workspace, and writes are sent as that teammate. The
// kind is flat: an inbox is a team, keyed by its id, plus "none" for conversations no team is assigned to
// (unassigned ones and ones assigned only to a teammate). A conversation is in the inbox of the team it is
// assigned to, which assignment rules and teammates change all the time, so every call reads the conversation
// by id and authorizes on the inbox that read shows; conversations the account cannot see are refused like
// ungranted ones. Search names one inbox and reads each result again, since the search index can lag behind
// reassignments. Tickets are not included.
//
// Text is HTML: reading and writing it is in `html`. Links to Intercom are hidden with their labels, and parts
// that are not messages (assignments, tags, state changes) are left out, since they name other teams. Written
// text is plain, without formatting, mentions or links to Intercom.
//
// Intercom's OAuth has no scopes: permissions are set on the app in Intercom's Developer Hub (Read
// conversations, Write conversations, Read admins), and a missing one is Intercom's refusal. Tokens do not
// expire; removing the app from the workspace revokes them.
//
// This module assembles the connector. The operations are in `reads` and `writes`; what they share (inboxes,
// conversation names, where conversations are) is in `inboxes`.

import type { Connector, DiscoveryItem, DiscoveryPage } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ID, IntercomClient } from "./client.ts";
import { INBOX, NO_TEAM, NO_TEAM_NAME } from "./inboxes.ts";
import { GET_CONVERSATION, LIST_INBOXES, SEARCH_CONVERSATIONS, short } from "./reads.ts";
import { ADD_NOTE, REPLY } from "./writes.ts";

async function inboxes(client: IntercomClient): Promise<DiscoveryItem[]> {
	const teams = (await client.teams()).map((team): DiscoveryItem => ({ id: team.id, name: short(team.name) || `Team ${team.id}` }));
	return [...teams, { id: NO_TEAM, name: NO_TEAM_NAME }];
}

export const intercom: Connector<IntercomClient> = {
	slug: "intercom",
	name: "Intercom",
	kinds: [
		{
			id: INBOX,
			label: "Inbox",
			actions: ["read", "note", "reply"],
			wildcard: true,
			note:
				'A team\'s inbox holds the conversations assigned to that team; "No team" holds unassigned ' +
				"conversations and those assigned only to a teammate. Conversations move between inboxes when " +
				"they are reassigned, and one reassigned at the moment an agent writes can receive the write. " +
				"Tickets are not included.",
		},
	],
	actions: [
		{ id: "read", label: "Read conversations" },
		{ id: "note", label: "Add internal notes", requires: "read" },
		{ id: "reply", label: "Reply to customers", requires: "read" },
	],
	auth: {
		type: "oauth2",
		app: "intercom",
		authorizeUrl: "https://app.intercom.com/oauth",
		tokenUrl: "https://api.intercom.io/auth/eagle/token",
		scopes: [],
		pkce: false,
	},
	operations: [LIST_INBOXES, SEARCH_CONVERSATIONS, GET_CONVERSATION, ADD_NOTE, REPLY],

	client(secret, io) {
		return new IntercomClient(io, secret);
	},

	async account(client) {
		const me = await client.me();
		if (me.app === null || !me.app.id_code) throw client.unexpected();
		const person = me.name && me.email ? `${me.name} (${me.email})` : me.name || me.email || "Intercom";
		const label = me.app.name ? `${person} · ${me.app.name}` : person;
		return { id: `${me.app.id_code}:${me.id}`, label };
	},

	async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
		if (cursor !== null) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
		const folded = query ? query.toLowerCase() : null;
		const items = await inboxes(client);
		return { items: items.filter((item) => folded === null || item.name.toLowerCase().includes(folded)) };
	},

	async describe(client, _kind, ids) {
		const wanted = new Set(ids.filter((id) => id === NO_TEAM || ID.test(id)));
		if (wanted.size === 0) return {};
		const described: { [id: string]: string } = {};
		for (const item of await inboxes(client)) if (wanted.has(item.id)) described[item.id] = item.name;
		return described;
	},
};
