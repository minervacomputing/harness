// Slack. Resources are channels; Minerva acts as the
// operator's Slack app, with its bot token.
//
// Only bot tokens (`xoxb-`) are accepted: user tokens and organization-wide installs are refused, and the
// account is the app's bot user in one workspace (`team_id:user_id`). Slack takes comma-separated scopes and
// HTTP Basic client authentication without PKCE (Slack treats PKCE apps as public clients); writes ask for
// `chat:write`.
//
// The app reaches only the channels it has been added to in Slack, so a channel needs both a grant in
// Minerva and the app as a member: two consents, one of them visible to everyone in the channel. Channels
// (public and private, never direct messages) are one flat kind with a wildcard, keyed by Slack's channel
// id. Tools name channels by id or by name; a name is resolved to the channel once, before authorization,
// and a channel the app cannot see (or a name that is missing or ambiguous) is refused like a channel
// without a grant. Reading a channel the app is not in answers `NOT_IN_CHANNEL` only after authorization.
//
// Text agents read hides the names of channels that links in it point to (see mrkdwn.ts), leaves out
// attachments, which can quote messages from other channels, and shows only the metadata of files. Text
// agents write is escaped and sent with `parse=none`, `link_names=false` and unfurling off, so it cannot
// mention anyone or notify a channel, and it may not link to Slack. Replying in a thread and posting to the
// channel are separate actions, with different reach. Every write first confirms the channel again: the same
// id, the app a member, not archived, and not shared with another organization. What stays outside
// Minerva's reach: Slack workflows and other apps that react to messages, and who joins a channel after it
// was granted.

import { z } from "zod";
import {
	type Account,
	type Binding,
	type Connector,
	type DiscoveryItem,
	type DiscoveryPage,
	OperationError,
	type Prepared,
	type ProviderOutput,
	type ScopedRecord,
	defineOperation,
	denied,
} from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import type { JsonObject } from "../../lib/json.ts";
import { PLAIN_TEXT, TextError, isPlainText, truncate } from "../../lib/text.ts";
import { type Channel, type Message, NOT_IN_CHANNEL_MESSAGE, SlackClient, isConversationChannel, shownName } from "./client.ts";
import { NO_SLACK_LINKS, escape, linksToSlack, redact } from "./mrkdwn.ts";
import { formatUtc, parseInstant } from "../../lib/dates.ts";
import { extend } from "../../lib/arrays.ts";

export const CHANNEL = "channel";
export const MAX_TEXT = 4_000;
export const MAX_READ_TEXT = 4_000;
export const MAX_TOPIC = 500;
export const MAX_PEOPLE = 30;
export const MAX_RESOLVE_PAGES = 10;
export const RESOLVE_PAGE = 200;
export const MAX_DESCRIBE = 100;
/** Requests to Slack at once when naming people or channels. */
const CONCURRENCY = 5;
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED", "NOT_IN_CHANNEL", "CHANNEL_ARCHIVED"]);

const CHANNEL_ID = /^[CG][A-Z0-9]{8,20}$/;
/** Slack channel names: lowercase, no spaces or periods, at most 80 characters. */
const CHANNEL_NAME = /^[^\s#<>|@,.&A-Z]{1,80}$/u;
const TS = /^\d{9,10}\.\d{6}$/u;
const USER_ID = /^[UWB][A-Z0-9]{2,20}$/;
const MENTION = /<@([UW][A-Z0-9]{2,20})(?:\|[^<>]*)?>/g;
const CURSOR = /^[A-Za-z0-9=+/_-]{1,500}$/;

export const CHANNEL_NAME_MESSAGE = 'must be a channel name such as "#general", or a channel id such as "C0123ABCDEF"';
export const TS_MESSAGE = 'must be a message ts such as "1727780000.123456"';
export const MOMENT_MESSAGE = "must be an ISO 8601 time such as 2026-10-01T09:00:00Z";

export interface SlackLimits {
	/** Pages of channels read to find one by name (MAX_RESOLVE_PAGES). */
	resolvePages: number;
	/** Channels per page when finding one by name (RESOLVE_PAGE). */
	resolvePage: number;
}

/** A channel id, or `#name`. Throws with the field's message. */
export function channelName(value: string): string {
	if (CHANNEL_ID.test(value)) return value;
	const name = (value.startsWith("#") ? value.slice(1) : value).toLowerCase();
	if (CHANNEL_NAME.test(name)) return `#${name}`;
	throw new TextError(CHANNEL_NAME_MESSAGE);
}

export function isTs(value: string): boolean {
	return TS.test(value);
}

/** A date or date-time as a Slack timestamp, seconds with six digits of microseconds. Times without an offset are UTC. */
export function moment(value: string): string {
	const micros = parseInstant(value);
	if (micros === null) throw new TextError(MOMENT_MESSAGE);
	const sign = micros < 0n ? "-" : "";
	const size = micros < 0n ? -micros : micros;
	return `${sign}${size / 1_000_000n}.${String(size % 1_000_000n).padStart(6, "0")}`;
}

/** A transform that returns a new value, whose TextError is the field's message. */
function after(convert: (value: string) => string) {
	return (value: string, ctx: z.RefinementCtx): string => {
		try {
			return convert(value);
		} catch (error) {
			if (!(error instanceof TextError)) throw error;
			ctx.addIssue({ code: "custom", message: error.message });
			return z.NEVER;
		}
	};
}

const ChannelName = () =>
	z.string().trim().min(1).max(81).describe('A channel name such as "#general", or a channel id.').transform(after(channelName));
const Ts = () => z.string().trim().min(1).max(20).refine(isTs, TS_MESSAGE);

/** Whether `moment` reads the value. */
function isMoment(value: string): boolean {
	try {
		moment(value);
		return true;
	} catch (error) {
		if (error instanceof TextError) return false;
		throw error;
	}
}

/**
 * A time, checked here and turned into a Slack timestamp by `withMoments` on the whole input: zod's JSON
 * Schema leaves out the default of a field that transforms.
 */
const Moment = () => z.string().trim().min(1).max(40).describe("An ISO 8601 time.").refine(isMoment, MOMENT_MESSAGE);

/** `moment` applied to the times of a validated input. */
function withMoments<T extends { after: string | null; before: string | null }>(data: T): T {
	return { ...data, after: data.after === null ? null : moment(data.after), before: data.before === null ? null : moment(data.before) };
}
const Cursor = () => z.string().trim().max(500);
const WrittenText = () =>
	z.string().trim().min(1).max(MAX_TEXT)
		.refine(isPlainText, PLAIN_TEXT)
		.refine((value) => !linksToSlack(value), NO_SLACK_LINKS)
		.describe("Slack mrkdwn (*bold*, _italic_, `code`, lists). Shown literally: no mentions or links with labels.");

function client(binding: Binding): SlackClient {
	return binding.client as SlackClient;
}

function gone(): OperationError {
	return new OperationError("CHANNEL_MOVED", "This channel changed in Slack while Minerva was using it, or the app lost access.");
}

function checkedCursor(cursor: string | null): string | null {
	if (cursor !== null && !CURSOR.test(cursor)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return cursor;
}

function nextCursor(cursor: string | null): string | null {
	if (cursor !== null && !CURSOR.test(cursor)) throw new OperationError("PROVIDER_LIMIT", "Slack returned a page token Minerva cannot use.");
	return cursor;
}

function hidden(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

/** `items` mapped by `fn`, at most CONCURRENCY at once, in order; the first failure fails all and starts nothing more. */
async function gathered<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await fn(items[index] as T);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return results;
}

async function byName(slack: SlackClient, name: string, limits: SlackLimits): Promise<Channel | null> {
	let cursor: string | null = null;
	const found: Channel[] = [];
	for (let page = 0; page < limits.resolvePages; page++) {
		let channels: Channel[];
		[channels, cursor] = await slack.channels({ limit: limits.resolvePage, cursor });
		extend(found, channels.filter((channel) => channel.name === name));
		if (cursor === null) return found.length === 1 ? (found[0] as Channel) : null;
	}
	// Refused whether or not the name was among the channels read, so the refusal says nothing about it.
	throw new OperationError("PROVIDER_LIMIT", "This workspace has more channels than Minerva searches by name. Use the channel id.");
}

/**
 * The channel a call names, as the resource that is authorized. Channels the app cannot see are refused
 * like channels without a grant.
 */
async function resolve(binding: Binding, name: string, limits: SlackLimits): Promise<Resource> {
	let channel: Channel | null;
	try {
		if (name.startsWith("#")) channel = await byName(client(binding), name.slice(1), limits);
		else {
			channel = await client(binding).channel(name);
			if (channel.id !== name) channel = null;
		}
	} catch (error) {
		if (hidden(error)) throw denied();
		throw error;
	}
	if (channel === null || !isConversationChannel(channel) || !CHANNEL_ID.test(channel.id)) throw denied();
	return binding.resource(CHANNEL, channel.id);
}

/**
 * Refuses a post unless the channel is still this one, the app is in it, and it is not archived or shared
 * with another organization. The last step before the write.
 */
async function confirmForWriting(binding: Binding, resource: Resource): Promise<void> {
	let channel: Channel;
	try {
		channel = await client(binding).channel(resource.id);
	} catch (error) {
		if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN")) throw gone();
		throw error;
	}
	if (channel.id !== resource.id || !isConversationChannel(channel)) throw gone();
	if (!channel.is_member) throw new OperationError("NOT_IN_CHANNEL", NOT_IN_CHANNEL_MESSAGE);
	if (channel.is_archived) throw new OperationError("CHANNEL_ARCHIVED", "This channel is archived.");
	if (channel.is_ext_shared || channel.is_pending_ext_shared) {
		throw new OperationError("EXTERNAL_CHANNEL", "Minerva does not post to channels shared with other organizations.");
	}
}

/** A message ts as an ISO time in UTC, or null. The ts is an id: its digits are read exactly, never as a float. */
export function isoTime(ts: string | null): string | null {
	if (ts === null || !TS.test(ts)) return null;
	return formatUtc(BigInt(ts.replace(".", "")));
}

function topicOf(channel: Channel, field: "topic" | "purpose"): string | null {
	const value = channel[field];
	const [shown] = truncate(value ? redact(value.value) : null, MAX_TOPIC);
	return shown || null;
}

function channelData(channel: Channel): JsonObject {
	return {
		id: channel.id,
		name: channel.name,
		private: channel.is_private,
		archived: channel.is_archived,
		shared_with_other_organizations: channel.is_ext_shared || channel.is_pending_ext_shared,
		topic: topicOf(channel, "topic"),
		purpose: topicOf(channel, "purpose"),
		members: channel.num_members,
	};
}

function mentions(text: string): string[] {
	return Array.from(text.matchAll(MENTION), (match) => match[1] as string);
}

/** Names of the authors and of the people mentioned, for at most MAX_PEOPLE people. */
async function people(slack: SlackClient, messages: readonly Message[]): Promise<Map<string, string>> {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.user && USER_ID.test(message.user)) ids.push(message.user);
		extend(ids, mentions(message.text));
	}
	const wanted = [...new Set(ids)].slice(0, MAX_PEOPLE);
	const names = await gathered(wanted, async (userId): Promise<string | null> => {
		let user: Awaited<ReturnType<SlackClient["user"]>>;
		try {
			user = await slack.user(userId);
		} catch (error) {
			if (hidden(error)) return null;
			throw error;
		}
		return user.id === userId ? shownName(user) : null;
	});
	const out = new Map<string, string>();
	wanted.forEach((userId, index) => {
		const shown = names[index];
		if (shown) out.set(userId, shown);
	});
	return out;
}

function messageData(message: Message, names: ReadonlyMap<string, string>): JsonObject {
	const [body, truncated] = truncate(redact(message.text), MAX_READ_TEXT);
	const mentioned: JsonObject = {};
	for (const userId of mentions(message.text)) {
		const name = names.get(userId);
		if (name !== undefined) mentioned[userId] = name;
	}
	const record: JsonObject = {
		ts: message.ts,
		time: isoTime(message.ts),
		thread_ts: message.thread_ts,
		reply_count: message.reply_count,
		latest_reply: message.latest_reply,
		subtype: message.subtype,
		author_id: message.user || message.bot_id,
		author: names.get(message.user || "") || message.username,
		text: body,
		text_truncated: truncated,
		edited: message.edited !== null,
		mentioned,
		reactions: message.reactions.map((reaction) => ({ name: reaction.name, count: reaction.count })),
		files: message.files.map((file) => ({ id: file.id, name: file.name, title: file.title, mimetype: file.mimetype, size: file.size })),
	};
	// Attachments carry link previews and messages shared from other channels; Minerva leaves them out.
	if (message.attachments.length) record.attachments_not_shown = message.attachments.length;
	if (message.blocks.length && !message.text) record.content_not_shown = true;
	return record;
}

async function messageRecords(binding: Binding, resource: Resource, messages: readonly Message[]): Promise<ScopedRecord[]> {
	const names = await people(client(binding), messages);
	return messages.map((message) => ({ resource, data: messageData(message, names) }));
}

const ListChannels = z.strictObject({
	limit: z.int().min(1).max(200).default(100),
	cursor: Cursor().nullable().default(null),
});

const READ_NOTE =
	"Links to channels appear without the channel's name, and attachments (link previews, messages shared from other channels) are left out.";

const ReadChannel = z
	.strictObject({
		channel: ChannelName(),
		limit: z.int().min(1).max(100).default(20),
		after: Moment().nullable().default(null),
		before: Moment().nullable().default(null),
		cursor: Cursor().nullable().default(null),
	})
	.transform(withMoments);

const ReadThread = z.strictObject({
	channel: ChannelName(),
	thread: Ts().describe("The ts of the thread's first message, or of any reply in it."),
	limit: z.int().min(1).max(100).default(50),
	cursor: Cursor().nullable().default(null),
});

const WRITE_NOTE =
	"Text is shown literally: it cannot mention people or notify the channel, and may not link to Slack. Everyone in the channel sees it, posted as the Minerva app.";

const POST_CONSENT = [["chat:write"]];

function posted(resource: Resource, ts: string | null, threadTs: string | null): JsonObject {
	return { written: true, channel: resource.id, ts, time: isoTime(ts), thread_ts: threadTs };
}

const PostMessage = z.strictObject({ channel: ChannelName(), text: WrittenText() });

const Reply = z.strictObject({
	channel: ChannelName(),
	thread: Ts().describe("The ts of a message in this channel; replying to a reply joins its thread."),
	text: WrittenText(),
});

function listable(channel: Channel): boolean {
	return isConversationChannel(channel) && CHANNEL_ID.test(channel.id);
}

function item(channel: Channel): DiscoveryItem {
	let name = `#${channel.name}`;
	if (!channel.is_member) name += " (app not added)";
	return { id: channel.id, name };
}

/** The Slack connector; `limits` are for the tests, which shorten the search by name. */
export function slackConnector(options: Partial<SlackLimits> = {}): Connector<SlackClient> {
	const limits: SlackLimits = { resolvePages: MAX_RESOLVE_PAGES, resolvePage: RESOLVE_PAGE, ...options };
	return {
		slug: "slack",
		name: "Slack",
		kinds: [
			{
				id: CHANNEL,
				label: "Channel",
				actions: ["read", "reply", "post"],
				wildcard: true,
				note: "Minerva acts as the Slack app and reaches only channels the app has been added to in Slack (/invite and the app's name). Posting to channels shared with other organizations is refused.",
			},
		],
		actions: [
			{ id: "read", label: "Read messages" },
			{ id: "reply", label: "Reply in threads", requires: "read" },
			{ id: "post", label: "Post to the channel", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: "slack",
			authorizeUrl: "https://slack.com/oauth/v2/authorize",
			tokenUrl: "https://slack.com/api/oauth.v2.access",
			scopes: ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"],
			scopeSeparator: ",",
			clientAuth: "basic",
			// Slack treats an app that uses PKCE as a public client, without its secret.
			pkce: false,
		},
		operations: [
			defineOperation<z.output<typeof ListChannels>>({
				name: "list_channels",
				title: "List channels",
				description:
					"List the Slack channels the app is in that you may read. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
				input: ListChannels,
				needs: [[CHANNEL, "read"]],
				paginated: true,
				async prepare(binding, data): Promise<Prepared> {
					return {
						requirements: [{ enumerate: CHANNEL, action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const [channels, cursor] = await client(binding).memberChannels({ limit: data.limit, cursor: checkedCursor(data.cursor) });
							const records = channels
								.filter((channel) => isConversationChannel(channel) && channel.is_member !== false && CHANNEL_ID.test(channel.id))
								.map((channel) => ({ resource: binding.resource(CHANNEL, channel.id), data: channelData(channel) }));
							return { records, nextCursor: nextCursor(cursor) };
						},
					};
				},
			}),
			defineOperation<z.output<typeof ReadChannel>>({
				name: "read_channel",
				title: "Read a channel",
				description: `Read a channel's messages, newest first, optionally between two times. Replies in threads are not included; read_thread reads them. To get the next page, repeat the call with identical arguments plus the returned next_cursor. ${READ_NOTE}`,
				input: ReadChannel,
				needs: [[CHANNEL, "read"]],
				paginated: true,
				async prepare(binding, data): Promise<Prepared> {
					const resource = await resolve(binding, data.channel, limits);
					return {
						requirements: [{ need: resource, action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const [messages, cursor] = await client(binding).history(resource.id, {
								limit: data.limit,
								cursor: checkedCursor(data.cursor),
								oldest: data.after,
								latest: data.before,
							});
							return { records: await messageRecords(binding, resource, messages), nextCursor: nextCursor(cursor) };
						},
					};
				},
			}),
			defineOperation<z.output<typeof ReadThread>>({
				name: "read_thread",
				title: "Read a thread",
				description: `Read a thread in a channel, its first message first. To get the next page, repeat the call with identical arguments plus the returned next_cursor. ${READ_NOTE}`,
				input: ReadThread,
				needs: [[CHANNEL, "read"]],
				paginated: true,
				async prepare(binding, data): Promise<Prepared> {
					const resource = await resolve(binding, data.channel, limits);
					return {
						requirements: [{ need: resource, action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const [messages, cursor] = await client(binding).replies(resource.id, data.thread, { limit: data.limit, cursor: checkedCursor(data.cursor) });
							return { records: await messageRecords(binding, resource, messages), nextCursor: nextCursor(cursor) };
						},
					};
				},
			}),
			defineOperation<z.output<typeof PostMessage>>({
				name: "post_message",
				title: "Post to a channel",
				description: `Post a new message to a channel where you have post permission. ${WRITE_NOTE}`,
				input: PostMessage,
				needs: [[CHANNEL, "post"]],
				consent: POST_CONSENT,
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const resource = await resolve(binding, data.channel, limits);
					return {
						requirements: [{ need: resource, action: "post" }],
						async execute(): Promise<ProviderOutput> {
							await confirmForWriting(binding, resource);
							const answer = await client(binding).post(resource.id, escape(data.text), { threadTs: null });
							const ts = answer.ts && TS.test(answer.ts) ? answer.ts : null;
							return { records: [{ resource, data: posted(resource, ts, null) }] };
						},
					};
				},
			}),
			defineOperation<z.output<typeof Reply>>({
				name: "reply",
				title: "Reply in a thread",
				description: `Reply in a thread of a channel where you have reply permission; the reply is not sent to the channel itself. ${WRITE_NOTE}`,
				input: Reply,
				needs: [[CHANNEL, "reply"]],
				consent: POST_CONSENT,
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const resource = await resolve(binding, data.channel, limits);
					return {
						requirements: [{ need: resource, action: "reply" }],
						async execute(): Promise<ProviderOutput> {
							const slack = client(binding);
							const notHere = () => new OperationError("INVALID_ARGUMENTS", "thread must be a message in this channel.");
							let messages: Message[];
							try {
								[messages] = await slack.replies(resource.id, data.thread, { limit: 1, cursor: null });
							} catch (error) {
								if (error instanceof OperationError && error.code === "NOT_FOUND") throw notHere();
								throw error;
							}
							const parent = messages[0];
							if (parent === undefined) throw notHere();
							const threadTs = parent.thread_ts || parent.ts;
							if (!TS.test(threadTs)) throw slack.unexpected();
							// Last before the write, so the channel is checked as close to it as Slack allows.
							await confirmForWriting(binding, resource);
							const answer = await slack.post(resource.id, escape(data.text), { threadTs });
							const ts = answer.ts && TS.test(answer.ts) ? answer.ts : null;
							return { records: [{ resource, data: posted(resource, ts, threadTs) }] };
						},
					};
				},
			}),
		],
		client: (secret, io) => new SlackClient(secret, io),
		async account(slack): Promise<Account> {
			const identity = await slack.authTest();
			if (!slack.bot || identity.is_enterprise_install) {
				throw new OperationError(
					"UNSUPPORTED_ACCOUNT",
					"Connect Slack by installing the app into one workspace; organization-wide installs are not supported.",
				);
			}
			// The app's bot user, in this workspace: another app, even in the same workspace, is another account.
			const label = identity.user ? `${identity.user} (${identity.team})` : identity.team;
			return { id: `${identity.team_id}:${identity.user_id}`, label: label || identity.team_id };
		},
		async discover(slack, _kind, { query, cursor }): Promise<DiscoveryPage> {
			if (!query) {
				const [channels, after] = await slack.channels({ limit: limits.resolvePage, cursor: checkedCursor(cursor) });
				return { items: channels.filter(listable).map(item), nextCursor: nextCursor(after) };
			}
			const folded = (query.startsWith("#") ? query.slice(1) : query).toLowerCase();
			const matches: Channel[] = [];
			let after: string | null = null;
			for (let page = 0; page < limits.resolvePages; page++) {
				let channels: Channel[];
				[channels, after] = await slack.channels({ limit: limits.resolvePage, cursor: after });
				extend(matches, channels.filter((channel) => listable(channel) && channel.name.toLowerCase().includes(folded)));
				after = nextCursor(after);
				if (after === null) return { items: matches.map(item) };
			}
			throw new OperationError("PROVIDER_LIMIT", "There are more channels than Minerva can search.");
		},
		async describe(slack, _kind, ids): Promise<{ [id: string]: string }> {
			const wanted = ids.filter((id) => CHANNEL_ID.test(id)).slice(0, MAX_DESCRIBE);
			const names = await gathered(wanted, async (channelId): Promise<string | null> => {
				let channel: Channel;
				try {
					channel = await slack.channel(channelId);
				} catch (error) {
					if (hidden(error)) return null;
					throw error;
				}
				return channel.id === channelId && isConversationChannel(channel) ? `#${channel.name}` : null;
			});
			const out: { [id: string]: string } = {};
			wanted.forEach((channelId, index) => {
				const shown = names[index];
				if (shown) out[channelId] = shown;
			});
			return out;
		},
	};
}
