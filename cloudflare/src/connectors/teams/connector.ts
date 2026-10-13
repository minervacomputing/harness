// Microsoft Teams. Resources are teams and their channels;
// agents read channel messages, post and reply.
//
// Only work and school accounts have Teams in Graph: a personal Microsoft account is refused when connecting.
// Chats (one-to-one and group) and meetings are not reached.
//
// Teams and channels are one hierarchical kind. A team's id is its GUID, in lower case; a channel's id is
// Graph's (`19:…@thread.tacv2`), with its team as ancestor. What is allowed on a team covers every channel in
// it, private channels the account is a member of and channels created later included. A channel belongs to a
// team only if Graph lists it among the channels that team hosts: each call lists them first and refuses a
// channel that is not there, so a channel cannot be named under a team it is not in. Messages Graph returns
// for another team or channel than the one asked for are dropped.
//
// Reading text hides channels and teams other messages could show (html.ts). Writing posts as the signed-in
// user, shown literally, without mentions and without links to Teams. Every write first lists the channel
// again, and refuses shared channels, which can include people of other organizations. A standard or private
// channel can have guests from outside the organization too: refusing shared channels limits the kind of
// channel, not who reads it. Importance is never set, so a post never notifies as urgent.
//
// Reading messages needs ChannelMessage.Read.All, which a tenant administrator must consent to; listing teams
// and channels and posting do not.

import { z } from "zod";
import type { Binding, Connector, DiscoveryItem, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { truncate } from "../../lib/text.ts";
import { casefold } from "../../lib/casefold.ts";
import { DIGIT_CLASS, decimalValue } from "../../lib/digits.ts";
import { accountLabel, consent, consentAll, oauth } from "../microsoft/index.ts";
import { after, pythonPattern, valueError } from "../microsoft/inputs.ts";
import { mapLimited } from "../microsoft/limit.ts";
import { type Channel, type Message, type Team, TeamsClient } from "./client.ts";
import * as html from "./html.ts";
import { extend } from "../../lib/arrays.ts";

export const CHANNEL = "channel";
export const READ_CONSENT = consent("ChannelMessage.Read.All");
export const POST_CONSENT = consent("ChannelMessage.Send");
/** Replying first reads the message replied to. */
export const REPLY_CONSENT = consentAll("ChannelMessage.Send", "ChannelMessage.Read.All");

export const MAX_TEXT = 4_000;
export const MAX_READ_TEXT = 4_000;
export const MAX_SUBJECT = 500;
export const MAX_TEAMS = 100;
/** `DISCOVERY_PAGE` is mutable so that tests can lower it. */
export const LIMITS = { discoveryPage: 10 };
export const DISCOVERY_SCAN = 25;
export const CONCURRENCY = 8;
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN"]);
const WRITABLE: ReadonlySet<string | null> = new Set(["standard", "private"]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANNEL_ID = /^19:[A-Za-z0-9._=+-]{1,200}@thread\.[a-z0-9]{1,20}$/;
/** Python's `\d` is any decimal digit (Unicode 16, as the pinned table in lib/digits.ts has it). */
const MESSAGE_ID = new RegExp(`^${DIGIT_CLASS}{1,20}$`, "u");
const OFFSET = new RegExp(`^${DIGIT_CLASS}{1,4}$`, "u");

function checkTeamId(value: string): string {
	const folded = value.toLowerCase();
	if (!GUID.test(folded)) throw valueError("must be a team id (a GUID) from list_teams or list_channels");
	return folded;
}

function checkChannelId(value: string): string {
	if (!CHANNEL_ID.test(value)) throw valueError('must be a channel id such as "19:…@thread.tacv2", from list_channels');
	return value;
}

const TeamId = () => after(z.string().trim().min(36).max(36).describe("A team's id."), checkTeamId);
const ChannelId = () => after(z.string().trim().min(1).max(240).describe("A channel's id."), checkChannelId);
const MessageId = () => z.string().trim().regex(pythonPattern("^\\d{1,20}$", MESSAGE_ID));
const Cursor = () => z.string().trim().max(1000);
const WrittenText = () =>
	after(z.string().trim().min(1).max(MAX_TEXT).describe("Plain text, shown literally: no formatting, mentions or links to Teams."), html.checkWritten);

function unseen(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

function teamKey(teamId: string | null): string | null {
	const folded = (teamId || "").toLowerCase();
	return GUID.test(folded) ? folded : null;
}

function clientOf(binding: Binding): TeamsClient {
	return binding.client as TeamsClient;
}

/** `_joined`: the teams the account is in, by id, with ids in lower case. */
async function joined(client: TeamsClient): Promise<Team[]> {
	const teams = new Map<string, Team>();
	for (const team of await client.joinedTeams()) {
		const key = teamKey(team.id);
		if (key !== null) teams.set(key, { ...team, id: key });
	}
	return [...teams.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `_channels`: the channels a team hosts that the account can see, or null for a team it cannot see. */
async function channelsOf(client: TeamsClient, teamId: string): Promise<Channel[] | null> {
	let channels: Channel[];
	try {
		channels = await client.channels(teamId);
	} catch (error) {
		if (unseen(error)) return null;
		throw error;
	}
	return channels.filter((channel) => CHANNEL_ID.test(channel.id));
}

/**
 * `_resolve`: the channel a call names, in its team. A channel the team does not host is refused like a
 * channel without a grant.
 */
async function resolve(binding: Binding, teamId: string, channelId: string): Promise<Resource> {
	const channels = await channelsOf(clientOf(binding), teamId);
	const channel = (channels ?? []).find((c) => c.id === channelId);
	if (channel === undefined) throw denied();
	return binding.resource(CHANNEL, channel.id, [teamId]);
}

/** Refuses a write unless the team still hosts the channel and the channel is not shared. The last step before the write. */
async function confirmForWriting(binding: Binding, resource: Resource): Promise<void> {
	const channels = await channelsOf(clientOf(binding), resource.within[0] as string);
	const channel = (channels ?? []).find((c) => c.id === resource.id);
	if (channel === undefined) throw new OperationError("CHANNEL_MOVED", "This channel changed in Teams while Minerva was using it, or access was lost.");
	if (!WRITABLE.has(channel.membership_type)) {
		throw new OperationError(
			"EXTERNAL_CHANNEL",
			"Minerva posts only to standard and private channels, not to shared channels, which can include people of other organizations.",
		);
	}
}

/** `_in`: whether Graph says the message is in this channel. */
function isIn(message: Message, resource: Resource): boolean {
	const identity = message.channel_identity;
	return identity !== null && teamKey(identity.team_id) === resource.within[0] && identity.channel_id === resource.id && MESSAGE_ID.test(message.id);
}

function plain(value: string | null): string | null {
	const [shown] = truncate(value ? html.redact(value) : null, MAX_SUBJECT);
	return shown || null;
}

function channelData(teamId: string, channel: Channel): { [key: string]: Json } {
	return {
		id: channel.id,
		team_id: teamId,
		name: channel.display_name,
		description: plain(channel.description),
		membership: channel.membership_type,
		link: channel.web_url,
	};
}

function teamData(team: Team): { [key: string]: Json } {
	return { id: team.id, type: "team", name: team.display_name, description: plain(team.description), archived: team.is_archived };
}

function messageData(message: Message, resource: Resource): { [key: string]: Json } {
	const deleted = message.deleted_date_time !== null;
	const sender = message.sender;
	const author = sender ? (sender.user ?? sender.application) : null;
	const record: { [key: string]: Json } = {
		id: message.id,
		team_id: resource.within[0] as string,
		channel_id: resource.id,
		reply_to_id: message.reply_to_id,
		created_time: message.created_date_time,
		edited_time: message.last_edited_date_time,
		deleted,
		author: author ? author.display_name : null,
		author_id: author ? author.id : null,
		importance: message.importance,
		link: message.web_url,
	};
	if (deleted) return { ...record, subject: null, text: "", text_truncated: false, reactions: [], files: [] };
	const body = message.body;
	const [text, truncated] = truncate(html.read(body ? body.content : null, body ? body.content_type : null, message.mentions), MAX_READ_TEXT);
	const counts = new Map<string, number>();
	for (const reaction of message.reactions) {
		if (reaction.reaction_type) counts.set(reaction.reaction_type, (counts.get(reaction.reaction_type) ?? 0) + 1);
	}
	const files = message.attachments.filter((a) => a.content_type === "reference");
	Object.assign(record, {
		subject: plain(message.subject),
		text,
		text_truncated: truncated,
		reactions: [...counts].map(([type, count]) => ({ type, count })),
		files: files.map((a) => ({ name: a.name })),
	});
	// Cards, quoted and forwarded messages can carry what other channels say; Minerva leaves them out.
	if (message.attachments.length > files.length) record.attachments_not_shown = message.attachments.length - files.length;
	return record;
}

/** `_messages`: user messages Graph places in this channel; system events (members added, renames) left out. */
function messageRecords(messages: readonly Message[], resource: Resource): ScopedRecord[] {
	return messages.filter((m) => m.message_type === "message" && isIn(m, resource)).map((m) => ({ resource, data: messageData(m, resource) }));
}

function notAThread(): OperationError {
	return new OperationError("INVALID_ARGUMENTS", "message_id must be the first message of a thread in this channel.");
}

/** `_root`: the message that starts a thread in this channel, or INVALID_ARGUMENTS. */
async function threadRoot(binding: Binding, resource: Resource, messageId: string): Promise<Message> {
	let message: Message;
	try {
		message = await clientOf(binding).message(resource.within[0] as string, resource.id, messageId);
	} catch (error) {
		if (unseen(error)) throw notAThread();
		throw error;
	}
	if (message.id !== messageId || message.reply_to_id !== null || !isIn(message, resource)) throw notAThread();
	return message;
}

export const ListTeams = z.strictObject({}).meta({ title: "ListTeams" });

const LIST_TEAMS = defineOperation<z.output<typeof ListTeams>>({
	name: "list_teams",
	title: "List teams",
	description: "List the Microsoft Teams teams you may read as a whole. Channels you may read in other teams are listed by list_channels.",
	input: ListTeams,
	needs: [[CHANNEL, "read"]],
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: CHANNEL, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const teams = await joined(clientOf(binding));
				return { records: teams.map((team) => ({ resource: binding.resource(CHANNEL, team.id), data: teamData(team) })) };
			},
		};
	},
});

export const ListChannels = z
	.strictObject({ team_id: TeamId().nullable().default(null).describe("A team's id; without one, all teams.") })
	.meta({ title: "ListChannels" });

const LIST_CHANNELS = defineOperation<z.output<typeof ListChannels>>({
	name: "list_channels",
	title: "List channels",
	description: "List the channels you may read, in one team or in all the teams the account is in.",
	input: ListChannels,
	needs: [[CHANNEL, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: CHANNEL, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				let incomplete = false;
				let teamIds: string[];
				if (data.team_id !== null) {
					teamIds = [data.team_id];
				} else {
					teamIds = (await joined(client)).map((team) => team.id);
					incomplete = teamIds.length > MAX_TEAMS;
					teamIds = teamIds.slice(0, MAX_TEAMS);
				}
				const found = await mapLimited(teamIds, CONCURRENCY, async (teamId) => (await channelsOf(client, teamId)) ?? []);
				const records = teamIds.flatMap((teamId, index) =>
					(found[index] ?? []).map((channel) => ({ resource: binding.resource(CHANNEL, channel.id, [teamId]), data: channelData(teamId, channel) })),
				);
				return { records, incomplete };
			},
		};
	},
});

export const READ_NOTE =
	"Mentions of channels and teams, links to Teams and quotes appear without their content; " +
	"cards and forwarded messages are left out, and files appear by name only.";

export const ReadChannel = z
	.strictObject({
		team_id: TeamId(),
		channel_id: ChannelId(),
		limit: z.int().min(1).max(50).default(20),
		cursor: Cursor().nullable().default(null),
	})
	.meta({ title: "ReadChannel" });

const READ_CHANNEL = defineOperation<z.output<typeof ReadChannel>>({
	name: "read_channel",
	title: "Read a channel",
	description:
		"Read the messages that start threads in a channel. Replies are not included; read_thread reads " +
		"them. To get the next page, repeat the call with identical arguments plus the returned " +
		`next_cursor. ${READ_NOTE}`,
	input: ReadChannel,
	needs: [[CHANNEL, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.team_id, data.channel_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const [messages, cursor] = await clientOf(binding).messages(data.team_id, data.channel_id, data.limit, data.cursor);
				return { records: messageRecords(messages, resource), nextCursor: cursor };
			},
		};
	},
});

export const ReadThread = z
	.strictObject({
		team_id: TeamId(),
		channel_id: ChannelId(),
		message_id: MessageId().describe("The id of the message that starts the thread."),
		limit: z.int().min(1).max(50).default(20),
		cursor: Cursor().nullable().default(null),
	})
	.meta({ title: "ReadThread" });

const READ_THREAD = defineOperation<z.output<typeof ReadThread>>({
	name: "read_thread",
	title: "Read a thread",
	description:
		"Read a thread in a channel: its first message (on the first page), then its replies. To get the " +
		`next page, repeat the call with identical arguments plus the returned next_cursor. ${READ_NOTE}`,
	input: ReadThread,
	needs: [[CHANNEL, "read"]],
	consent: READ_CONSENT,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.team_id, data.channel_id);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				let records: ScopedRecord[] = [];
				if (data.cursor === null) records = messageRecords([await threadRoot(binding, resource, data.message_id)], resource);
				let replies: Message[];
				let cursor: string | null;
				try {
					[replies, cursor] = await client.replies(data.team_id, data.channel_id, data.message_id, data.limit, data.cursor);
				} catch (error) {
					if (unseen(error)) throw notAThread();
					throw error;
				}
				records = [...records, ...messageRecords(replies.filter((r) => r.reply_to_id === data.message_id), resource)];
				return { records, nextCursor: cursor };
			},
		};
	},
});

export const WRITE_NOTE =
	"Text is shown literally: it cannot format, mention anyone, or link to Teams. Everyone in the channel " +
	"sees it, posted as the signed-in user. Shared channels are refused.";

function posted(binding: Binding, resource: Resource, message: Message, replyTo: string | null): { [key: string]: Json } {
	if (!isIn(message, resource) || message.reply_to_id !== replyTo) throw clientOf(binding).unexpected();
	return {
		written: true,
		id: message.id,
		team_id: resource.within[0] as string,
		channel_id: resource.id,
		reply_to_id: replyTo,
		created_time: message.created_date_time,
		link: message.web_url,
	};
}

export const PostMessage = z.strictObject({ team_id: TeamId(), channel_id: ChannelId(), text: WrittenText() }).meta({ title: "PostMessage" });

const POST_MESSAGE = defineOperation<z.output<typeof PostMessage>>({
	name: "post_message",
	title: "Post to a channel",
	description: `Start a new thread in a channel where you have post permission. ${WRITE_NOTE}`,
	input: PostMessage,
	needs: [[CHANNEL, "post"]],
	consent: POST_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.team_id, data.channel_id);
		return {
			requirements: [{ need: resource, action: "post" }],
			async execute(): Promise<ProviderOutput> {
				await confirmForWriting(binding, resource);
				const message = await clientOf(binding).post(data.team_id, data.channel_id, html.written(data.text), null);
				return { records: [{ resource, data: posted(binding, resource, message, null) }] };
			},
		};
	},
});

export const Reply = z
	.strictObject({
		team_id: TeamId(),
		channel_id: ChannelId(),
		message_id: MessageId().describe("The id of the message that starts the thread."),
		text: WrittenText(),
	})
	.meta({ title: "Reply" });

const REPLY = defineOperation<z.output<typeof Reply>>({
	name: "reply",
	title: "Reply in a thread",
	description: `Reply in a thread of a channel where you have reply permission. ${WRITE_NOTE}`,
	input: Reply,
	needs: [[CHANNEL, "reply"]],
	consent: REPLY_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.team_id, data.channel_id);
		return {
			requirements: [{ need: resource, action: "reply" }],
			async execute(): Promise<ProviderOutput> {
				const root = await threadRoot(binding, resource, data.message_id);
				if (root.message_type !== "message" || root.deleted_date_time !== null) throw notAThread();
				// Last before the write, so the channel is checked as close to it as Graph allows.
				await confirmForWriting(binding, resource);
				const message = await clientOf(binding).post(data.team_id, data.channel_id, html.written(data.text), data.message_id);
				return { records: [{ resource, data: posted(binding, resource, message, data.message_id) }] };
			},
		};
	},
});

function offsetOf(cursor: string | null): number {
	if (cursor === null) return 0;
	if (!OFFSET.test(cursor)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return decimalValue(cursor);
}

async function teamItems(client: TeamsClient, teams: readonly Team[]): Promise<[Team, Channel[]][]> {
	const found = await mapLimited(teams, CONCURRENCY, async (team) => (await channelsOf(client, team.id)) ?? []);
	return teams.map((team, index) => [team, found[index] ?? []]);
}

function teamName(team: Team): string {
	const name = team.display_name || team.id;
	return team.is_archived ? `${name} (archived)` : name;
}

export function teamsConnector(options: { baseUrl?: string } = {}): Connector<TeamsClient> {
	return {
		slug: "teams",
		name: "Microsoft Teams",
		kinds: [
			{
				id: CHANNEL,
				label: "Channel",
				actions: ["read", "reply", "post"],
				wildcard: true,
				hierarchical: true,
				note:
					"Access to a team covers all its channels, including private channels the account is in " +
					"and channels added later. Agents post as you. Posting to shared channels is refused.",
			},
		],
		actions: [
			{ id: "read", label: "Read messages" },
			{ id: "reply", label: "Reply in threads", requires: "read" },
			{ id: "post", label: "Start threads", requires: "read" },
		],
		// Listing teams and channels is enough to connect; reading and writing messages are asked for once the
		// user allows them.
		auth: oauth("Team.ReadBasic.All", "Channel.ReadBasic.All"),
		operations: [LIST_TEAMS, LIST_CHANNELS, READ_CHANNEL, READ_THREAD, POST_MESSAGE, REPLY],

		client(secret, io) {
			return new TeamsClient(secret, io, options.baseUrl);
		},

		async account(client) {
			const user = await client.me();
			if (!GUID.test(user.id.toLowerCase())) throw new OperationError("UNSUPPORTED_ACCOUNT", "Microsoft Teams works with work and school accounts only.");
			return { id: user.id, label: accountLabel(user, "Microsoft Teams") };
		},

		/** Whole teams per page, each followed by its channels, so a page never splits a team. */
		async discover(client, _kind, { query, cursor }) {
			const teams = await joined(client);
			const start = offsetOf(cursor);
			const folded = query ? casefold(query) : null;
			const items: DiscoveryItem[] = [];
			let end = start;
			while (end < teams.length && end - start < (folded ? DISCOVERY_SCAN : LIMITS.discoveryPage)) {
				const chunk = teams.slice(end, end + LIMITS.discoveryPage);
				end += chunk.length;
				for (const [team, channels] of await teamItems(client, chunk)) {
					const name = teamName(team);
					const found: DiscoveryItem[] = [{ id: team.id, name }, ...channels.map((c) => ({ id: c.id, name: `${name} / ${c.display_name || c.id}` }))];
					extend(items, found.filter((item) => folded === null || casefold(item.name).includes(folded)));
				}
				if (!folded || items.length) break;
			}
			return { items, nextCursor: end < teams.length ? String(end) : null };
		},

		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			if (![...wanted].some((id) => GUID.test(id) || CHANNEL_ID.test(id))) return {};
			const teams = (await joined(client)).slice(0, MAX_TEAMS);
			const names: { [id: string]: string } = {};
			const name = (id: string, value: string) => Object.defineProperty(names, id, { value, enumerable: true, writable: true, configurable: true });
			for (const team of teams) if (wanted.has(team.id)) name(team.id, teamName(team));
			if ([...wanted].some((id) => CHANNEL_ID.test(id))) {
				for (const [team, channels] of await teamItems(client, teams)) {
					for (const channel of channels) if (wanted.has(channel.id)) name(channel.id, `${teamName(team)} / ${channel.display_name || channel.id}`);
				}
			}
			return names;
		},
	};
}
