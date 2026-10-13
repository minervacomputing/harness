// Microsoft Graph for Teams: the teams the account joined,
// their channels, and channel messages.
//
// Teams pages messages with a `$skiptoken` that is not always the URL-safe token other Graph lists use (it
// can be JSON), so this client keeps its own page cursor: the token itself, checked to be printable and short
// enough to store, and sent back as a query parameter on a request Minerva builds.

import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { API_URL, Graph, queryOf } from "../microsoft/index.ts";
import { type Reader, bool, dict, int, list, model, nullable, optional, required, str } from "../microsoft/model.ts";
import { extend } from "../../lib/arrays.ts";
import { segment } from "../../gateway/http.ts";

export const CHANNEL_FIELDS = "id,displayName,description,membershipType,webUrl";
/** Mutable so that tests can lower it. */
export const LIMITS = { maxPages: 10 };
/** What the run's page token table stores, less the prefix. */
const TOKEN = /^[\x21-\x7e]{1,990}$/;
export const PREFIX = "t:";

export const Team = model({
	id: required(str),
	display_name: optional(nullable(str), null),
	description: optional(nullable(str), null),
	is_archived: optional(nullable(bool), null),
});
export type Team = ReturnType<typeof Team>;

export const Channel = model({
	id: required(str),
	display_name: optional(nullable(str), null),
	description: optional(nullable(str), null),
	membership_type: optional(nullable(str), null),
	web_url: optional(nullable(str), null),
});
export type Channel = ReturnType<typeof Channel>;

const Identity = model({ id: optional(nullable(str), null), display_name: optional(nullable(str), null) });
const Sender = model({ user: optional(nullable(Identity), null), application: optional(nullable(Identity), null) });
const Body = model({ content_type: optional(nullable(str), null), content: optional(nullable(str), null) });
const ChannelIdentity = model({ team_id: optional(nullable(str), null), channel_id: optional(nullable(str), null) });
const Mentioned = model({
	user: optional(nullable(Identity), null),
	application: optional(nullable(Identity), null),
	conversation: optional(nullable(dict), null),
	tag: optional(nullable(dict), null),
});
export const Mention = model({ id: optional(nullable(int), null), mentioned: optional(nullable(Mentioned), null) });
export type Mention = ReturnType<typeof Mention>;
const Attachment = model({ content_type: optional(nullable(str), null), name: optional(nullable(str), null) });
const Reaction = model({ reaction_type: optional(nullable(str), null) });

export const Message = model({
	id: required(str),
	reply_to_id: optional(nullable(str), null),
	message_type: optional(nullable(str), null),
	created_date_time: optional(nullable(str), null),
	last_edited_date_time: optional(nullable(str), null),
	deleted_date_time: optional(nullable(str), null),
	subject: optional(nullable(str), null),
	importance: optional(nullable(str), null),
	web_url: optional(nullable(str), null),
	sender: optional(nullable(Sender), null, "from"),
	body: optional(nullable(Body), null),
	channel_identity: optional(nullable(ChannelIdentity), null),
	attachments: optional(list(Attachment), []),
	mentions: optional(list(Mention), []),
	reactions: optional(list(Reaction), []),
});
export type Message = ReturnType<typeof Message>;

/** The query parameters a cursor stands for, or INVALID_CURSOR. */
export function pageParams(cursor: string | null): { [name: string]: string } {
	if (cursor === null) return {};
	const token = cursor.startsWith(PREFIX) ? cursor.slice(PREFIX.length) : cursor;
	if (!cursor.startsWith(PREFIX) || !TOKEN.test(token)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return { $skiptoken: token };
}

/** The cursor for the next page, taken out of Graph's nextLink; the link itself is never requested. */
export function nextCursor(nextLink: unknown): string | null {
	if (nextLink === null || nextLink === undefined) return null;
	const unusable = new OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.");
	if (typeof nextLink !== "string" || nextLink.length > 4000) throw unusable;
	const token = queryOf(nextLink).getAll("$skiptoken");
	if (token.length !== 1 || !TOKEN.test(token[0] as string)) throw unusable;
	return `${PREFIX}${token[0]}`;
}

/** Thin client for the parts of Microsoft Graph Teams channels use. */
export class TeamsClient extends Graph {
	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		super("Microsoft Teams", accessToken, io, { baseUrl });
	}

	#list<T>(reader: Reader<T>, body: { [key: string]: Json }): [T[], string | null] {
		const items = Object.hasOwn(body, "value") ? body.value : undefined;
		if (!Array.isArray(items)) throw this.unexpected();
		return [items.map((item) => this.parse(reader, item)), nextCursor(Object.hasOwn(body, "@odata.nextLink") ? body["@odata.nextLink"] : null)];
	}

	/** Every page of a list, up to LIMITS.maxPages; more is PROVIDER_LIMIT rather than a partial answer. */
	async #all<T>(reader: Reader<T>, path: string, params: { [name: string]: string }): Promise<T[]> {
		const found: T[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < LIMITS.maxPages; page++) {
			let items: T[];
			[items, cursor] = this.#list(reader, await this.get(path, { params: { ...params, ...pageParams(cursor) } }));
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
		return this.#list(Message, body);
	}

	async message(teamId: string, channelId: string, messageId: string): Promise<Message> {
		return this.parse(Message, await this.get(`/teams/${segment(teamId)}/channels/${segment(channelId)}/messages/${segment(messageId)}`));
	}

	async replies(teamId: string, channelId: string, messageId: string, limit: number, cursor: string | null): Promise<[Message[], string | null]> {
		const body = await this.get(`/teams/${segment(teamId)}/channels/${segment(channelId)}/messages/${segment(messageId)}/replies`, {
			params: { $top: String(limit), ...pageParams(cursor) },
		});
		return this.#list(Message, body);
	}

	/** The one write of an operation: a new message in a channel, or a reply to one. */
	async post(teamId: string, channelId: string, html: string, replyTo: string | null): Promise<Message> {
		let path = `/teams/${segment(teamId)}/channels/${segment(channelId)}/messages`;
		if (replyTo !== null) path += `/${segment(replyTo)}/replies`;
		const body = await this.http.json({ method: "POST", path, json: { body: { contentType: "html", content: html } } });
		return this.parse(Message, body);
	}
}
