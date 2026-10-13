// Slack's Web API, with a bot token.
//
// Slack answers most failed requests with HTTP 200 and `{"ok": false, "error": "<code>"}`. Reads fail
// closed: any such answer refuses the call. A post counts as applied only when Slack answers `ok: true`, and
// as not applied only for the errors Slack raises when it refused the request before posting; anything else
// (`internal_error`, an unknown code, a response that is not a UTF-8 JSON object) leaves its outcome unknown,
// which pauses further writes. Slack's own error texts never reach the model.

import { z } from "zod";
import type { Effect, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { isDict, type Json, type JsonObject, parseJson } from "../../lib/json.ts";

export const API_URL = "https://slack.com/api";
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BOT_TOKEN_PREFIXES = ["xoxb-", "xoxe.xoxb-"] as const;

export const UNAUTHORIZED: ReadonlySet<string> = new Set([
	"invalid_auth",
	"not_authed",
	"token_revoked",
	"token_expired",
	"account_inactive",
	"org_login_required",
]);
export const RATE_LIMITED: ReadonlySet<string> = new Set(["ratelimited", "rate_limited", "message_limit_exceeded"]);
export const FORBIDDEN: ReadonlySet<string> = new Set([
	"missing_scope",
	"no_permission",
	"app_access_restricted",
	"accesslimited",
	"access_denied",
	"not_allowed_token_type",
	"ekm_access_denied",
	"team_access_not_granted",
	"enterprise_is_restricted",
	"two_factor_setup_required",
	"restricted_action",
	"restricted_action_read_only_channel",
	"restricted_action_thread_only_channel",
	"restricted_action_non_threadable_channel",
	"restricted_action_thread_locked",
]);
export const NOT_FOUND: ReadonlySet<string> = new Set(["channel_not_found", "thread_not_found", "message_not_found", "user_not_found"]);
export const REJECTED: ReadonlySet<string> = new Set([
	"invalid_arguments",
	"invalid_arg_name",
	"invalid_array_arg",
	"invalid_charset",
	"invalid_form_data",
	"invalid_post_type",
	"missing_post_type",
	"invalid_ts_latest",
	"invalid_ts_oldest",
	"invalid_limit",
	"no_text",
	"msg_too_long",
	"invalid_blocks",
	"invalid_blocks_format",
	"too_many_attachments",
	"cannot_reply_to_message",
	"messages_tab_disabled",
	"as_user_not_supported",
	"method_deprecated",
	"deprecated_endpoint",
]);
/**
 * chat.postMessage errors for requests Slack refused before posting. Errors outside this list, such as
 * internal_error, fatal_error, request_timeout or service_unavailable, may follow a post that went through.
 */
export const REFUSED_BEFORE_POSTING: ReadonlySet<string> = new Set([
	...UNAUTHORIZED,
	...RATE_LIMITED,
	...FORBIDDEN,
	...REJECTED,
	"channel_not_found",
	"not_in_channel",
	"is_archived",
]);

export const NOT_IN_CHANNEL_MESSAGE = "The Slack app is not a member of this channel. Someone in the channel can add it (/invite and the app's name).";

/** The owned error for one of Slack's error codes. */
export function errorFor(provider: string, error: Json | undefined): OperationError {
	const code = typeof error === "string" ? error : "";
	if (UNAUTHORIZED.has(code)) return new OperationError("CONNECTION_UNAUTHORIZED", `The ${provider} connection is no longer authorized.`);
	if (RATE_LIMITED.has(code)) return new OperationError("PROVIDER_RATE_LIMITED", `${provider} is rate limiting requests. Try again later.`);
	if (code === "not_in_channel") {
		return new OperationError(
			"NOT_IN_CHANNEL",
			`The ${provider} app is not a member of this channel. Someone in the channel can add it (/invite and the app's name).`,
		);
	}
	if (code === "is_archived") return new OperationError("CHANNEL_ARCHIVED", "This channel is archived.");
	if (FORBIDDEN.has(code)) return new OperationError("PROVIDER_FORBIDDEN", `${provider} refused this request for the connected app.`);
	if (NOT_FOUND.has(code)) return new OperationError("NOT_FOUND", `${provider} did not find this object.`);
	if (code === "invalid_cursor") return new OperationError("INVALID_CURSOR", "This page token is invalid.");
	if (REJECTED.has(code)) return new OperationError("PROVIDER_REJECTED", `${provider} rejected this request.`);
	return new OperationError("PROVIDER_FAILED", `${provider} could not complete this request.`);
}

/** A response body that is a UTF-8 JSON object (a byte order mark dropped), or null. */
export function bodyOf(bytes: Uint8Array): JsonObject | null {
	let body: Json;
	try {
		body = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return null;
	}
	return isDict(body) ? body : null;
}

async function responseBody(response: Response): Promise<JsonObject | null> {
	return bodyOf(new Uint8Array(await response.arrayBuffer()));
}

function field(body: JsonObject, key: string): Json | undefined {
	return Object.hasOwn(body, key) ? body[key] : undefined;
}

/** Errors with a status other than 200; their status says enough except for authorization. */
export function classify(provider: string, _response: Response, _text: string, bytes: Uint8Array): OperationError | null {
	const body = bodyOf(bytes);
	const error = body === null ? undefined : field(body, "error");
	if (typeof error === "string" && UNAUTHORIZED.has(error)) return errorFor(provider, error);
	return null;
}

/**
 * What a post did. Only Slack's answer counts for a success status, whichever; other statuses are judged by
 * status: 429 was refused, 5xx is unknown.
 */
export function judge(response: Response, _text: string, bytes: Uint8Array): Effect | null {
	if (response.status < 200 || response.status >= 300) return null;
	const body = bodyOf(bytes);
	if (body === null) return "unknown";
	const ok = field(body, "ok");
	if (ok === true) return "applied";
	const error = field(body, "error");
	if (ok === false && typeof error === "string" && REFUSED_BEFORE_POSTING.has(error)) return "not_applied";
	return "unknown";
}

// What Slack answers, unknown fields dropped.

const optionalText = () => z.string().nullable().default(null);
/** A JSON object, whatever it holds. */
const object = () => z.custom<JsonObject>(isDict);

export const Identity = z.object({
	team_id: z.string(),
	team: z.string().default(""),
	user_id: z.string(),
	user: z.string().default(""),
	is_enterprise_install: z.boolean().default(false),
});
export type Identity = z.output<typeof Identity>;

const Text = z.object({ value: z.string().default("") });

export const Channel = z.object({
	id: z.string(),
	name: z.string().default(""),
	is_channel: z.boolean().default(false),
	is_group: z.boolean().default(false),
	is_im: z.boolean().default(false),
	is_mpim: z.boolean().default(false),
	is_private: z.boolean().default(false),
	is_archived: z.boolean().default(false),
	// Left out by some methods; unknown counts as not a member.
	is_member: z.boolean().nullable().default(null),
	is_ext_shared: z.boolean().default(false),
	is_pending_ext_shared: z.boolean().default(false),
	topic: Text.nullable().default(null),
	purpose: Text.nullable().default(null),
	num_members: z.number().int().nullable().default(null),
});
export type Channel = z.output<typeof Channel>;

/** A public or private channel, not a direct or group message. */
export function isConversationChannel(channel: Channel): boolean {
	return (channel.is_channel || channel.is_group) && !channel.is_im && !channel.is_mpim;
}

const Reaction = z.object({ name: z.string().default(""), count: z.number().int().default(0) });

const File = z.object({
	id: optionalText(),
	name: optionalText(),
	title: optionalText(),
	mimetype: optionalText(),
	size: z.number().int().nullable().default(null),
});

export const Message = z.object({
	ts: z.string(),
	type: optionalText(),
	subtype: optionalText(),
	user: optionalText(),
	bot_id: optionalText(),
	username: optionalText(),
	text: z.string().default(""),
	thread_ts: optionalText(),
	reply_count: z.number().int().nullable().default(null),
	latest_reply: optionalText(),
	edited: object().nullable().default(null),
	reactions: z.array(Reaction).default(() => []),
	files: z.array(File).default(() => []),
	attachments: z.array(object()).default(() => []),
	blocks: z.array(object()).default(() => []),
});
export type Message = z.output<typeof Message>;

const Profile = z.object({ display_name: z.string().default(""), real_name: z.string().default("") });

export const User = z.object({
	id: z.string(),
	name: z.string().default(""),
	real_name: z.string().default(""),
	deleted: z.boolean().default(false),
	profile: Profile.nullable().default(null),
});
export type User = z.output<typeof User>;

/** The name Slack shows for a person. */
export function shownName(user: User): string {
	if (user.profile && user.profile.display_name) return user.profile.display_name;
	return user.real_name || (user.profile ? user.profile.real_name : "") || user.name;
}

export const Posted = z.object({ channel: optionalText(), ts: optionalText() });
export type Posted = z.output<typeof Posted>;

type Params = { [name: string]: string | number | null | undefined };

/** Thin client for Slack's Web API. Responses are validated before use. */
export class SlackClient implements ProviderClient {
	readonly bot: boolean;
	readonly #http: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		this.bot = BOT_TOKEN_PREFIXES.some((prefix) => accessToken.startsWith(prefix));
		this.#http = new ProviderHTTP(io, {
			provider: "Slack",
			baseUrl,
			headers: { Authorization: `Bearer ${accessToken}` },
			classify,
			judge,
		});
	}

	async close(): Promise<void> {
		await this.#http.close();
	}

	unexpected(): OperationError {
		return this.#http.unexpected();
	}

	/** A read. An answer that is not `ok` refuses the call. */
	async call(method: string, params: Params = {}): Promise<JsonObject> {
		const query: { [name: string]: string | number } = {};
		for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) query[name] = value;
		const response = await this.#http.bounded(
			{ method: "GET", path: `/${method}`, query },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", "Slack returned more than Minerva reads."),
		);
		const body = await responseBody(response);
		if (body === null) throw this.unexpected();
		if (field(body, "ok") !== true) throw errorFor("Slack", field(body, "error"));
		return body;
	}

	#parse<S extends z.ZodType>(schema: S, value: Json | undefined): z.output<S> {
		const parsed = schema.safeParse(value);
		if (!parsed.success) throw this.unexpected();
		return parsed.data;
	}

	#list<S extends z.ZodType>(schema: S, value: Json | undefined): z.output<S>[] {
		if (!Array.isArray(value)) throw this.unexpected();
		return value.map((item) => this.#parse(schema, item));
	}

	static #next(body: JsonObject): string | null {
		const metadata = field(body, "response_metadata");
		const cursor = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? field(metadata, "next_cursor") : undefined;
		return typeof cursor === "string" && cursor ? cursor : null;
	}

	async authTest(): Promise<Identity> {
		return this.#parse(Identity, await this.call("auth.test"));
	}

	async channel(channelId: string): Promise<Channel> {
		const body = await this.call("conversations.info", { channel: channelId });
		return this.#parse(Channel, field(body, "channel"));
	}

	/** Public channels, and private channels the app is a member of. */
	async channels(options: { limit: number; cursor: string | null }): Promise<[Channel[], string | null]> {
		const body = await this.call("conversations.list", {
			types: "public_channel,private_channel",
			exclude_archived: "false",
			limit: options.limit,
			cursor: options.cursor,
		});
		return [this.#list(Channel, field(body, "channels")), SlackClient.#next(body)];
	}

	/** Channels the app is a member of. */
	async memberChannels(options: { limit: number; cursor: string | null }): Promise<[Channel[], string | null]> {
		const body = await this.call("users.conversations", {
			types: "public_channel,private_channel",
			exclude_archived: "true",
			limit: options.limit,
			cursor: options.cursor,
		});
		return [this.#list(Channel, field(body, "channels")), SlackClient.#next(body)];
	}

	async history(
		channelId: string,
		options: { limit: number; cursor: string | null; oldest: string | null; latest: string | null },
	): Promise<[Message[], string | null]> {
		const body = await this.call("conversations.history", {
			channel: channelId,
			limit: options.limit,
			cursor: options.cursor,
			oldest: options.oldest,
			latest: options.latest,
			inclusive: "false",
		});
		return [this.#list(Message, field(body, "messages")), SlackClient.#next(body)];
	}

	/** A thread, its parent message first. `ts` may be the parent or any reply. */
	async replies(channelId: string, ts: string, options: { limit: number; cursor: string | null }): Promise<[Message[], string | null]> {
		const body = await this.call("conversations.replies", { channel: channelId, ts, limit: options.limit, cursor: options.cursor });
		return [this.#list(Message, field(body, "messages")), SlackClient.#next(body)];
	}

	async user(userId: string): Promise<User> {
		return this.#parse(User, field(await this.call("users.info", { user: userId }), "user"));
	}

	/**
	 * The one write of an operation. Its outcome is judged by `judge`. `text` must already be escaped: it is
	 * sent with every Slack feature that could turn it into more than a message switched off.
	 */
	async post(channelId: string, text: string, options: { threadTs: string | null }): Promise<Posted> {
		const payload: JsonObject = {
			channel: channelId,
			text,
			mrkdwn: true,
			parse: "none",
			link_names: false,
			unfurl_links: false,
			unfurl_media: false,
		};
		if (options.threadTs !== null) {
			payload.thread_ts = options.threadTs;
			payload.reply_broadcast = false;
		}
		const response = await this.#http.request({
			method: "POST",
			path: "/chat.postMessage",
			mutating: true,
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
		// `judge` read the same bytes: a body that is not a JSON object left the outcome unknown.
		const body = await responseBody(response);
		if (body === null) throw new OperationError("WRITE_UNCONFIRMED", "Slack did not confirm the message.");
		if (field(body, "ok") !== true) throw errorFor("Slack", field(body, "error"));
		const posted = Posted.safeParse(body);
		return posted.success ? posted.data : { channel: null, ts: null };
	}
}
