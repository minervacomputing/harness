// Microsoft Graph for Teams: the teams the account joined,
// their channels, and channel messages.
//
// Teams pages messages with a `$skiptoken` that is not always the URL-safe token other Graph lists use (it
// can be JSON), so this client keeps its own page cursor: the token itself, checked to be printable and short
// enough to store, and sent back as a query parameter on a request Minerva builds.

import { z } from "zod";
import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { API_URL, Graph, queryOf } from "../microsoft/index.ts";
import { extend } from "../../lib/arrays.ts";
import { segment } from "../../gateway/http.ts";

export const CHANNEL_FIELDS = "id,displayName,description,membershipType,webUrl";
/** Mutable so that tests can lower it. */
export const LIMITS = { maxPages: 10 };
/** What the run's page token table stores, less the prefix. */
const TOKEN = /^[\x21-\x7e]{1,990}$/;
export const PREFIX = "t:";

export const Team = z.object({
	id: z.string(),
	displayName: z.string().nullable().default(null),
	description: z.string().nullable().default(null),
	isArchived: z.boolean().nullable().default(null),
});
export type Team = z.output<typeof Team>;

export const Channel = z.object({
	id: z.string(),
	displayName: z.string().nullable().default(null),
	description: z.string().nullable().default(null),
	membershipType: z.string().nullable().default(null),
	webUrl: z.string().nullable().default(null),
});
export type Channel = z.output<typeof Channel>;

const Identity = z.object({ id: z.string().nullable().default(null), displayName: z.string().nullable().default(null) });
const Sender = z.object({ user: Identity.nullable().default(null), application: Identity.nullable().default(null) });
const Body = z.object({ contentType: z.string().nullable().default(null), content: z.string().nullable().default(null) });
const ChannelIdentity = z.object({ teamId: z.string().nullable().default(null), channelId: z.string().nullable().default(null) });
const Mentioned = z.object({
	user: Identity.nullable().default(null),
	application: Identity.nullable().default(null),
	conversation: z.object({}).nullable().default(null),
	tag: z.object({}).nullable().default(null),
});
export const Mention = z.object({ id: z.number().int().nullable().default(null), mentioned: Mentioned.nullable().default(null) });
export type Mention = z.output<typeof Mention>;
const Attachment = z.object({ contentType: z.string().nullable().default(null), name: z.string().nullable().default(null) });
const Reaction = z.object({ reactionType: z.string().nullable().default(null) });

export const Message = z.object({
	id: z.string(),
	replyToId: z.string().nullable().default(null),
	messageType: z.string().nullable().default(null),
	createdDateTime: z.string().nullable().default(null),
	lastEditedDateTime: z.string().nullable().default(null),
	deletedDateTime: z.string().nullable().default(null),
	subject: z.string().nullable().default(null),
	importance: z.string().nullable().default(null),
	webUrl: z.string().nullable().default(null),
	from: Sender.nullable().default(null),
	body: Body.nullable().default(null),
	channelIdentity: ChannelIdentity.nullable().default(null),
	attachments: z.array(Attachment).default([]),
	mentions: z.array(Mention).default([]),
	reactions: z.array(Reaction).default([]),
});
export type Message = z.output<typeof Message>;

/** The query parameters a cursor stands for, or INVALID_CURSOR. */
export function pageParams(cursor: string | null): { [name: string]: string } {
	if (cursor === null) return {};
	const token = cursor.startsWith(PREFIX) ? cursor.slice(PREFIX.length) : cursor;
	if (!cursor.startsWith(PREFIX) || !TOKEN.test(token)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return { $skiptoken: token };
}

/** The cursor for the next page, taken out of Graph's nextLink; the link itself is never requested. */
export function nextCursor(nextLink: string | null): string | null {
	if (nextLink === null) return null;
	const unusable = new OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.");
	if (nextLink.length > 4000) throw unusable;
	const token = queryOf(nextLink).getAll("$skiptoken");
	if (token.length !== 1 || !TOKEN.test(token[0] as string)) throw unusable;
	return `${PREFIX}${token[0]}`;
}

/** Thin client for the parts of Microsoft Graph Teams channels use. */
export class TeamsClient extends Graph {
	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		super("Microsoft Teams", accessToken, io, { baseUrl });
	}

	/** Every page of a list, up to LIMITS.maxPages; more is PROVIDER_LIMIT rather than a partial answer. */
	async #all<T>(schema: z.ZodType<T>, path: string, params: { [name: string]: string }): Promise<T[]> {
		const found: T[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < LIMITS.maxPages; page++) {
			let items: T[];
			[items, cursor] = this.page(schema, await this.get(path, { params: { ...params, ...pageParams(cursor) } }), nextCursor);
			extend(found, items);
			if (cursor === null) return found;
		}
		throw new OperationError("PROVIDER_LIMIT", "Microsoft Teams returned more than Minerva reads.");
	}

	joinedTeams(): Promise<Team[]> {
		return this.#all(Team, "/me/joinedTeams", {});
	}

	/** The channels the team hosts that the account can see. */
	channels(teamId: string): Promise<Channel[]> {
		return this.#all(Channel, `/teams/${segment(teamId)}/channels`, { $select: CHANNEL_FIELDS });
	}

	/** A channel's messages that start threads (without their replies). */
	async messages(teamId: string, channelId: string, limit: number, cursor: string | null): Promise<[Message[], string | null]> {
		const body = await this.get(`/teams/${segment(teamId)}/channels/${segment(channelId)}/messages`, { params: { $top: String(limit), ...pageParams(cursor) } });
		return this.page(Message, body, nextCursor);
	}

	async message(teamId: string, channelId: string, messageId: string): Promise<Message> {
		return this.parse(Message, await this.get(`/teams/${segment(teamId)}/channels/${segment(channelId)}/messages/${segment(messageId)}`));
	}

	async replies(teamId: string, channelId: string, messageId: string, limit: number, cursor: string | null): Promise<[Message[], string | null]> {
		const body = await this.get(`/teams/${segment(teamId)}/channels/${segment(channelId)}/messages/${segment(messageId)}/replies`, {
			params: { $top: String(limit), ...pageParams(cursor) },
		});
		return this.page(Message, body, nextCursor);
	}

	/** The one write of an operation: a new message in a channel, or a reply to one. */
	async post(teamId: string, channelId: string, html: string, replyTo: string | null): Promise<Message> {
		let path = `/teams/${segment(teamId)}/channels/${segment(channelId)}/messages`;
		if (replyTo !== null) path += `/${segment(replyTo)}/replies`;
		const body = await this.http.json({ method: "POST", path, json: { body: { contentType: "html", content: html } } });
		return this.parse(Message, body);
	}
}
