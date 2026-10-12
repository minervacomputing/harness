// Slack's Web API, with a bot token, ported from backend/connectors/slack/client.py.
//
// Slack answers most failed requests with HTTP 200 and `{"ok": false, "error": "<code>"}`. Reads fail
// closed: any such answer refuses the call. A post counts as applied only when Slack answers `ok: true`, and
// as not applied only for the errors Slack raises when it refused the request before posting; anything else
// (`internal_error`, an unknown code, a response that is not JSON) leaves its outcome unknown, which pauses
// further writes. Slack's own error texts never reach the model.
//
// Answers are read as httpx's `response.json()` reads them: UTF-8, a byte order mark skipped. `judge` and
// `classify` get the body as text, decoded with replacement characters (gateway/http.ts), where Python's
// `json.loads` refuses invalid UTF-8; `post` therefore reads the bytes again and leaves a post whose answer
// is not UTF-8 unknown, as Python's `judge` does. What still differs, for bodies Slack does not send: a
// failed answer that is not UTF-8 may still be classified by its `error`, and `json.loads` reads UTF-16
// and UTF-32 bodies and NaN or Infinity, which are unexpected answers here (a post's outcome unknown).

import { z } from "zod";
import type { Effect, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, type JsonObject, parseJson, pythonDumps } from "../../lib/json.ts";
import { dict, laxBool, laxInt } from "../../lib/lax.ts";

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

/** The owned error for one of Slack's error codes (`error_for`). */
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

/** `_body` over text: a JSON object, or null. A leading byte order mark is skipped, as `json.loads` skips it in bytes. */
export function bodyOf(text: string): JsonObject | null {
	let body: Json;
	try {
		body = parseJson(text.startsWith("\ufeff") ? text.slice(1) : text);
	} catch {
		return null;
	}
	return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
}

/** The body as `json.loads` decodes bytes: UTF-8, or null for anything that is not. */
async function responseText(response: Response): Promise<string | null> {
	try {
		return fromUtf8Strict(new Uint8Array(await response.arrayBuffer()));
	} catch {
		return null;
	}
}

/** `_body` over a response's bytes, which must be UTF-8. */
async function responseBody(response: Response): Promise<JsonObject | null> {
	const text = await responseText(response);
	return text === null ? null : bodyOf(text);
}

function field(body: JsonObject, key: string): Json | undefined {
	return Object.hasOwn(body, key) ? body[key] : undefined;
}

/** Errors with a status other than 200; their status says enough except for authorization. */
export function classify(provider: string, _response: Response, text: string): OperationError | null {
	const body = bodyOf(text);
	const error = body === null ? undefined : field(body, "error");
	if (typeof error === "string" && UNAUTHORIZED.has(error)) return errorFor(provider, error);
	return null;
}

/**
 * What a post did. Only Slack's answer counts for a success status, whichever; other statuses are judged by
 * status: 429 was refused, 5xx is unknown.
 */
export function judge(response: Response, text: string): Effect | null {
	if (response.status < 200 || response.status >= 300) return null;
	const body = bodyOf(text);
	if (body === null) return "unknown";
	const ok = field(body, "ok");
	if (ok === true) return "applied";
	const error = field(body, "error");
	if (ok === false && typeof error === "string" && REFUSED_BEFORE_POSTING.has(error)) return "not_applied";
	return "unknown";
}

// The answers' models: Pydantic's lax mode, unknown fields ignored (lax.ts).

const str = () => z.string();
const optionalStr = () => z.string().nullable().default(null);

export const Identity = z.object({
	team_id: str(),
	team: str().default(""),
	user_id: str(),
	user: str().default(""),
	is_enterprise_install: laxBool().default(false),
});
export type Identity = z.output<typeof Identity>;

const Text = z.object({ value: str().default("") });

export const Channel = z.object({
	id: str(),
	name: str().default(""),
	is_channel: laxBool().default(false),
	is_group: laxBool().default(false),
	is_im: laxBool().default(false),
	is_mpim: laxBool().default(false),
	is_private: laxBool().default(false),
	is_archived: laxBool().default(false),
	// Left out by some methods; unknown counts as not a member.
	is_member: laxBool().nullable().default(null),
	is_ext_shared: laxBool().default(false),
	is_pending_ext_shared: laxBool().default(false),
	topic: Text.nullable().default(null),
	purpose: Text.nullable().default(null),
	num_members: laxInt().nullable().default(null),
});
export type Channel = z.output<typeof Channel>;

/** A public or private channel, not a direct or group message. */
export function isConversationChannel(channel: Channel): boolean {
	return (channel.is_channel || channel.is_group) && !channel.is_im && !channel.is_mpim;
}

const Reaction = z.object({ name: str().default(""), count: laxInt().default(0) });

const File = z.object({
	id: optionalStr(),
	name: optionalStr(),
	title: optionalStr(),
	mimetype: optionalStr(),
	size: laxInt().nullable().default(null),
});

export const Message = z.object({
	ts: str(),
	type: optionalStr(),
	subtype: optionalStr(),
	user: optionalStr(),
	bot_id: optionalStr(),
	username: optionalStr(),
	text: str().default(""),
	thread_ts: optionalStr(),
	reply_count: laxInt().nullable().default(null),
	latest_reply: optionalStr(),
	edited: dict().nullable().default(null),
	reactions: z.array(Reaction).default(() => []),
	files: z.array(File).default(() => []),
	attachments: z.array(dict()).default(() => []),
	blocks: z.array(dict()).default(() => []),
});
export type Message = z.output<typeof Message>;

const Profile = z.object({ display_name: str().default(""), real_name: str().default("") });

export const User = z.object({
	id: str(),
	name: str().default(""),
	real_name: str().default(""),
	deleted: laxBool().default(false),
	profile: Profile.nullable().default(null),
});
export type User = z.output<typeof User>;

/** The name Slack shows for a person. */
export function shownName(user: User): string {
	if (user.profile && user.profile.display_name) return user.profile.display_name;
	return user.real_name || (user.profile ? user.profile.real_name : "") || user.name;
}

export const Posted = z.object({ channel: optionalStr(), ts: optionalStr() });
export type Posted = z.output<typeof Posted>;

type Params = { [name: string]: string | number | null | undefined };

/** Thin client for Slack's Web API. Responses are validated before use. */
export class SlackClient implements ProviderClient {
	readonly bot: boolean;
	readonly #io: ProviderIo;
	readonly #http: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		this.bot = BOT_TOKEN_PREFIXES.some((prefix) => accessToken.startsWith(prefix));
		this.#io = io;
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
		// As Python sends it: `json.dumps(payload)`, ASCII with its default separators.
		const response = await this.#http.request({
			method: "POST",
			path: "/chat.postMessage",
			mutating: true,
			body: pythonDumps(payload),
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
		const answer = await responseText(response);
		if (answer === null) {
			// `judge` read the text with replacement characters; Python's read no answer in these bytes, so
			// what the post did stays unknown.
			const attempt = this.#io.currentWrite();
			if (attempt !== null && attempt.sent && !attempt.closed) attempt.effect = "unknown";
		}
		const body = answer === null ? null : bodyOf(answer);
		if (body === null) throw new OperationError("WRITE_UNCONFIRMED", "Slack did not confirm the message.");
		if (field(body, "ok") !== true) throw errorFor("Slack", field(body, "error"));
		const posted = Posted.safeParse(body);
		return posted.success ? posted.data : { channel: null, ts: null };
	}
}
