// The Slack connector against an in-memory Slack Web API behind an injected `fetch`, and runs through the
// executor (executor-fakes.ts `Scenario`); the text rules (`redact`, `writtenProblem`, `escape`, `judge`);
// and the registry accepting the declaration, whose fingerprints are printed and pinned.

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { SlackClient, judge } from "../../src/connectors/slack/client.ts";
import { CHANNEL, slackConnector } from "../../src/connectors/slack/connector.ts";
import { escape, redact, writtenProblem } from "../../src/connectors/slack/mrkdwn.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { EncryptionKeys } from "../../src/lib/encryption.ts";
import { WorkspaceCore } from "../../src/workspace/core.ts";
import { tokenBody, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";
import { ADA, FakeConversations, FakeObjects, FakeOAuth, FakeTimers, KEYS, SETTINGS, TokenEndpoint, USER, WORKSPACE, database, nodeSql, tokens } from "./workspace-support.ts";

const SECRET = "SECRET plans";
const GENERAL = "C0GENERAL1";
const RANDOM = "C0RANDOM01";
const PRIVATE = "G0PRIVATE1";
const HIDDEN = "C0HIDDEN01";
const PARTNER = "C0PARTNER1";
const OLD = "C0ARCHIVE1";
const THREAD = "1727780000.000100";
const REPLY = "1727780050.000300";
const SLACK = "0199a000-0000-7000-8000-000000000051";
const BASE_SCOPES = ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"];

type Params = { [name: string]: Json };
type FakeChannel = { [key: string]: Json };
type FakeMessage = { [key: string]: Json };

function channel(id: string, name: string, flags: FakeChannel = {}): FakeChannel {
	const isPrivate = id.startsWith("G") || flags.is_private === true;
	return {
		id,
		name,
		is_channel: !id.startsWith("G"),
		is_group: id.startsWith("G"),
		is_im: false,
		is_mpim: false,
		is_private: isPrivate,
		is_archived: false,
		is_member: true,
		is_ext_shared: false,
		topic: { value: "" },
		purpose: { value: "" },
		num_members: 3,
		...flags,
	};
}

function json(status: number, body: Json | unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Slack's Web API. Channels: #general and #random (public; the app is only in
 * #general), #private (private, the app is in it), #hidden (private, the app is not in it, so it does not
 * exist for the app), #partner (shared with another organization) and #old (archived).
 */
class FakeSlack {
	channels: { [id: string]: FakeChannel } = {
		[GENERAL]: channel(GENERAL, "general", { topic: { value: `Plans: <#${PRIVATE}|${SECRET}>` } }),
		[RANDOM]: channel(RANDOM, "random", { is_member: false }),
		[PRIVATE]: channel(PRIVATE, "private"),
		[HIDDEN]: channel(HIDDEN, "hidden", { is_private: true, is_member: false }),
		[PARTNER]: channel(PARTNER, "partner", { is_ext_shared: true }),
		[OLD]: channel(OLD, "old", { is_archived: true }),
	};
	messages: { [id: string]: FakeMessage[] } = {
		[GENERAL]: [
			{
				type: "message",
				ts: THREAD,
				thread_ts: THREAD,
				reply_count: 1,
				user: "U0ADA",
				text: `See <#${PRIVATE}|${SECRET}>, <https://acme.slack.com/archives/${PRIVATE}/p1|${SECRET}> and <https://example.com|the docs>; cc <@U0GRACE>`,
			},
			{ type: "message", ts: REPLY, thread_ts: THREAD, user: "U0GRACE", text: "On it &amp; more" },
			{
				type: "message",
				ts: "1727780100.000200",
				subtype: "bot_message",
				bot_id: "B0BOT",
				username: "helper",
				text: "",
				attachments: [{ is_share: true, text: SECRET, channel_id: PRIVATE }],
				files: [{ id: "F0FILE", name: "plan.pdf", title: "Plan", mimetype: "application/pdf", size: 10, channels: [PRIVATE], preview: SECRET }],
			},
		],
		[PRIVATE]: [{ type: "message", ts: "1727780000.000900", user: "U0ADA", text: SECRET }],
		[PARTNER]: [{ type: "message", ts: "1727780000.000500", user: "U0ADA", text: "hello" }],
		[OLD]: [],
		[RANDOM]: [{ type: "message", ts: "1727780000.000700", user: "U0ADA", text: "random" }],
		[HIDDEN]: [],
	};
	users: { [id: string]: Json } = {
		U0ADA: { id: "U0ADA", name: "ada", real_name: "Ada Lovelace", profile: { display_name: "ada" } },
		U0GRACE: { id: "U0GRACE", name: "grace", real_name: "Grace Hopper", profile: {} },
	};
	ops: [method: string, params: Params][] = [];
	writes: Params[] = [];
	/** Bearer tokens the requests carried. */
	tokens: string[] = [];
	hook: ((method: string, params: Params) => Response | null) | null = null;
	token = "xoxb-token";
	identity: JsonObject = {
		ok: true,
		team_id: "T0ACME",
		team: "Acme",
		user_id: "U0BOT",
		user: "minerva",
		bot_id: "B0MINERVA",
		is_enterprise_install: false,
	};

	visible(id: string): FakeChannel | null {
		const found = this.channels[id];
		if (found === undefined || (found.is_private && !found.is_member)) return null;
		return found;
	}

	static page(items: Json[], params: Params, key: string): JsonObject {
		const limit = Number(params.limit ?? 100);
		const start = typeof params.cursor === "string" && params.cursor ? Number(params.cursor.slice(1)) : 0;
		const more = start + limit < items.length;
		return { ok: true, [key]: items.slice(start, start + limit), response_metadata: { next_cursor: more ? `p${start + limit}` : "" } };
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		expect(url.origin).toBe("https://slack.com");
		const method = url.pathname.replace(/^\/api\//, "");
		this.tokens.push(request.headers.get("authorization") ?? "");
		const params: Params = request.method === "POST" ? (parseJson(await request.text()) as Params) : Object.fromEntries(url.searchParams);
		this.ops.push([method, params]);
		const hooked = this.hook?.(method, params) ?? null;
		if (hooked !== null) return hooked;
		return json(200, this.answer(method, params));
	};

	answer(method: string, params: Params): JsonObject {
		const notFound = { ok: false, error: "channel_not_found" };
		switch (method) {
			case "auth.test":
				return this.identity;
			case "conversations.info": {
				const found = this.visible(params.channel as string);
				return found ? { ok: true, channel: found } : notFound;
			}
			case "conversations.list":
				return FakeSlack.page(
					Object.values(this.channels).filter((item) => this.visible(item.id as string)),
					params,
					"channels",
				);
			case "users.conversations":
				return FakeSlack.page(
					Object.values(this.channels)
						.filter((item) => item.is_member && !item.is_archived)
						.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "is_member"))),
					params,
					"channels",
				);
			case "conversations.history": {
				const found = this.visible(params.channel as string);
				if (found === null) return notFound;
				if (!found.is_member) return { ok: false, error: "not_in_channel" };
				const top = (this.messages[found.id as string] ?? []).filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts);
				return FakeSlack.page([...top].reverse(), params, "messages");
			}
			case "conversations.replies": {
				const found = this.visible(params.channel as string);
				if (found === null) return notFound;
				const messages = this.messages[found.id as string] ?? [];
				const message = messages.find((m) => m.ts === params.ts);
				if (message === undefined) return { ok: false, error: "thread_not_found" };
				const root = message.thread_ts ?? message.ts;
				return FakeSlack.page(
					messages.filter((m) => m.ts === root || m.thread_ts === root),
					params,
					"messages",
				);
			}
			case "users.info": {
				const user = this.users[params.user as string];
				return user ? { ok: true, user } : { ok: false, error: "user_not_found" };
			}
			case "chat.postMessage":
				this.writes.push(params);
				return { ok: true, channel: params.channel as string, ts: "1727790000.000001", message: {} };
		}
		throw new Error(`Unexpected Slack method ${method}`);
	}

	names(): string[] {
		return this.ops.map(([name]) => name);
	}

	client(): SlackClient {
		return new SlackClient(this.token, settingsIo(this.fetch));
	}
}

/** Starts a run for an agent with the user's Slack connection, holding `grants` on channels. */
function start(slack: FakeSlack, grants: { [channel: string]: string[] }, connector = slackConnector()): Promise<Scenario> {
	return Scenario.start({
		connectors: [connector],
		connections: [{ id: SLACK, provider: "slack", payload: { kind: "oauth2", access_token: "xoxb-t", refresh_token: null, scopes: [...BASE_SCOPES, "chat:write"] } }],
		user: userGrants(SLACK, CHANNEL, grants),
		fetch: slack.fetch,
	});
}

function items(outcome: ToolCallOutcome): JsonObject[] {
	if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.result.items as JsonObject[];
}

/** The one item of a result; there must be exactly one. */
function only(outcome: ToolCallOutcome): JsonObject {
	const found = items(outcome);
	expect(found).toHaveLength(1);
	return found[0] as JsonObject;
}

async function failure(promise: Promise<unknown>): Promise<OperationError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error;
		throw error;
	}
	throw new Error("The call succeeded.");
}

describe("connecting", () => {
	test("account, discovery and names", async () => {
		const slack = new FakeSlack();
		const connector = slackConnector();
		const account = await connector.account(slack.client());
		expect([account.id, account.label]).toEqual(["T0ACME:U0BOT", "minerva (Acme)"]);
		let found = await connector.discover(slack.client(), "channel", { query: null, cursor: null });
		expect(found.items.map((item) => item.name)).toEqual(["#general", "#random (app not added)", "#private", "#partner", "#old"]);
		found = await connector.discover(slack.client(), "channel", { query: "#PRIV", cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([[PRIVATE, "#private"]]);
		const bad = await failure(connector.discover(slack.client(), "channel", { query: null, cursor: "not a cursor" }));
		expect(bad.code).toBe("INVALID_CURSOR");
		const names = await connector.describe(slack.client(), "channel", [GENERAL, HIDDEN, "*", "general"]);
		expect(names).toEqual({ [GENERAL]: "#general" });
	});

	test.each([["enterprise install"], ["user token"]])("only workspace bot installs connect: %s", async (change) => {
		const slack = new FakeSlack();
		if (change === "user token") slack.token = "xoxp-token";
		else slack.identity.is_enterprise_install = true;
		const refused = await failure(slackConnector().account(slack.client()));
		expect(refused.code).toBe("UNSUPPORTED_ACCOUNT");
		expect(refused.message).toBe("Connect Slack by installing the app into one workspace; organization-wide installs are not supported.");
	});

	test("Slack tokens carry their scopes", () => {
		// The code exchange's request and how Slack's answer is read.
		const auth = slackConnector().auth;
		if (auth.type !== "oauth2") throw new Error("Slack connects through OAuth.");
		expect([auth.tokenUrl, auth.clientAuth, auth.pkce]).toEqual(["https://slack.com/api/oauth.v2.access", "basic", false]);
		const request = tokenRequest(auth, { clientId: "id", clientSecret: "s", redirectUri: "https://minerva.example/cb" }, [
			["grant_type", "authorization_code"],
			["code", "c"],
		]);
		const headers = new Headers(request.headers);
		expect(headers.get("authorization")).toBe(`Basic ${btoa("id:s")}`);
		const fields = new URLSearchParams(request.body as string);
		expect(fields.has("client_secret") || fields.has("client_id") || fields.has("code_verifier")).toBe(false);
		const answer = tokenBody({ ok: true, access_token: "xoxb-a", token_type: "bot", scope: "channels:read,chat:write", team: { id: "T0ACME", name: "Acme" } });
		expect(answer).not.toBeNull();
		const tokens = tokenPayload(answer as JsonObject, Date.UTC(2026, 9, 11));
		expect(tokens.access_token).toBe("xoxb-a");
		expect(tokens.scopes).toEqual(["channels:read", "chat:write"]);
		expect("expires_at" in tokens).toBe(false);
		// Slack reports refusals with HTTP 200.
		expect(tokenBody({ ok: false, error: "invalid_code" })).toBeNull();
	});

	test("Slack scopes follow the allowed actions", () => {
		const connector = slackConnector();
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Slack connects through OAuth.");
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(BASE_SCOPES);
		const requested = requestedScopes(connector, new Set(["read", "reply"]));
		expect(requested).toEqual([...BASE_SCOPES, "chat:write"]);
		// The authorization URL's `scope` joins them with the separator; no PKCE challenge is sent.
		expect(auth.authorizeUrl).toBe("https://slack.com/oauth/v2/authorize");
		expect(requested.join(auth.scopeSeparator)).toBe(`${BASE_SCOPES.join(",")},chat:write`);
		expect(auth.pkce).toBe(false);
		expect(consentNeeded(connector, BASE_SCOPES, new Set(["read", "reply", "post"]))).toEqual(["reply", "post"]);
		expect(consentNeeded(connector, [...BASE_SCOPES, "chat:write"], new Set(["read", "reply", "post"]))).toEqual([]);
	});

	test("a refused Slack refresh needs reconnecting", async () => {
		// The Workspace's credential lease, with Slack registered.
		const timers = new FakeTimers();
		const oauth = new FakeOAuth();
		oauth.clients.set("slack", { clientId: "id", clientSecret: "s" });
		const endpoint = new TokenEndpoint();
		const core = new WorkspaceCore({
			sql: nodeSql(database()),
			timers,
			keys: await EncryptionKeys.parse(KEYS),
			registry: await Registry.create([slackConnector()]),
			settings: SETTINGS,
			conversations: new FakeConversations(),
			objects: new FakeObjects(),
			oauth,
			fetch: endpoint.fetch,
			log: () => {},
			wake: () => {},
		});
		await core.init({ workspace: { id: WORKSPACE, jurisdiction: null }, kind: "personal", ownerId: USER, createdAt: timers.now() });
		const saved = await core.saveConnection(ADA, {
			provider: "slack",
			account: { id: "T0ACME:U0BOT", label: "Acme" },
			credentials: { kind: "oauth2", access_token: "xoxe.xoxb-old", refresh_token: "xoxe-1-r1", scopes: [], expires_at: Math.floor(timers.now() / 1000) },
			connectionId: null,
		});
		if (!saved.ok) throw new Error(saved.refusal.detail);
		// Slack refuses with HTTP 200.
		endpoint.responses.push(tokens({ ok: false, error: "invalid_refresh_token" }));
		expect(await core.lease(saved.value.id, { settings: ADA })).toMatchObject({ refused: "CONNECTION_UNAUTHORIZED" });
		expect(endpoint.sent.map((request) => [request.url, request.headers.authorization, request.fields])).toEqual([
			["https://slack.com/api/oauth.v2.access", `Basic ${btoa("id:s")}`, { grant_type: "refresh_token", refresh_token: "xoxe-1-r1" }],
		]);
	});
});

describe("runs", () => {
	test("channels without a grant or out of reach look alike", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read"] });
		const general = only(await run.call("slack_list_channels", {}));
		expect(general.name).toBe("general");
		expect(JSON.stringify(general)).not.toContain(SECRET);
		expect(general.topic).toBe(`Plans: <#${PRIVATE}>`);
		expect(items(await run.call("slack_read_channel", { channel: "#General" })).length).toBeGreaterThan(0);
		expect(items(await run.call("slack_read_channel", { channel: GENERAL })).length).toBeGreaterThan(0);

		slack.ops = [];
		for (const name of ["#random", "#hidden", PRIVATE, HIDDEN, "#nope", "C0NOPE0000", "private", "D0DIRECT01"]) {
			expect(await run.code("slack_read_channel", { channel: name }), name).toBe("POLICY_DENIED");
		}
		// Nothing but where the channel is was asked for.
		expect(new Set(slack.names())).toEqual(new Set(["conversations.list", "conversations.info"]));
		for (const name of ["a.b", "general channel", "<#C0GENERAL1>", "#"]) {
			expect(await run.code("slack_read_channel", { channel: name }), name).toBe("INVALID_ARGUMENTS");
		}
	});

	test("a wildcard reaches only channels the app is in", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { "*": ["read"] });
		const channels = items(await run.call("slack_list_channels", {}));
		expect(channels.map((item) => item.name)).toEqual(["general", "private", "partner"]);
		expect(channels.map((item) => item.shared_with_other_organizations)).toEqual([false, false, true]);
		const secret = only(await run.call("slack_read_channel", { channel: "#private" }));
		expect(secret.text).toBe(SECRET);
		expect(await run.code("slack_read_channel", { channel: "#random" })).toBe("NOT_IN_CHANNEL");
		expect(await run.code("slack_read_channel", { channel: "#hidden" })).toBe("POLICY_DENIED");
	});

	test("reading hides other channels", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read"] });
		const messages = items(await run.call("slack_read_channel", { channel: "#general" }));
		expect(JSON.stringify(messages)).not.toContain(SECRET);
		expect(messages.map((message) => message.ts)).toEqual(["1727780100.000200", THREAD]);
		const [shared, first] = messages as [JsonObject, JsonObject];
		expect(shared.attachments_not_shown).toBe(1);
		expect(shared.author).toBe("helper");
		expect(shared.files).toEqual([{ id: "F0FILE", name: "plan.pdf", title: "Plan", mimetype: "application/pdf", size: 10 }]);
		expect(first.author).toBe("ada");
		expect(first.mentioned).toEqual({ U0GRACE: "Grace Hopper" });
		expect(String(first.text).startsWith(`See <#${PRIVATE}>, <https://acme.slack.com/archives/${PRIVATE}/p1> and `)).toBe(true);
		expect(first.time).toBe("2024-10-01T10:53:20.000100Z");
		expect(first.reply_count).toBe(1);

		const thread = items(await run.call("slack_read_thread", { channel: "#general", thread: REPLY }));
		expect(thread.map((message) => message.ts)).toEqual([THREAD, REPLY]);
		expect(thread[1]?.text).toBe("On it &amp; more");
		expect(thread[1]?.author).toBe("Grace Hopper");

		const page = await run.call("slack_read_channel", { channel: "#general", limit: 1 });
		expect(items(page).map((message) => message.ts)).toEqual(["1727780100.000200"]);
		slack.ops = [];
		await run.ok("slack_read_channel", { channel: "#general", after: "2024-10-01T10:50:00Z", before: "2024-10-01T12:00:00+02:00" });
		const history = slack.ops.filter(([name]) => name === "conversations.history");
		expect(history.map(([, params]) => [params.oldest, params.latest])).toEqual([["1727779800.000000", "1727776800.000000"]]);
	});

	test("posting and replying", async () => {
		const slack = new FakeSlack();
		let run = await start(slack, { [GENERAL]: ["read", "post"], [PARTNER]: ["read", "post", "reply"], [OLD]: ["read", "post"] });
		const posted = only(await run.call("slack_post_message", { channel: "#general", text: "Hi <!channel> & <@U0ADA>" }));
		expect(posted).toEqual({ written: true, channel: GENERAL, ts: "1727790000.000001", time: "2024-10-01T13:40:00.000001Z", thread_ts: null });
		expect(slack.writes.length).toBe(1);
		const sent = slack.writes[0] as Params;
		expect(sent.text).toBe("Hi &lt;!channel&gt; &amp; &lt;@U0ADA&gt;");
		expect(sent.channel).toBe(GENERAL);
		expect("thread_ts" in sent).toBe(false);
		expect([sent.parse, sent.link_names, sent.unfurl_links, sent.unfurl_media]).toEqual(["none", false, false, false]);
		// Replying is its own action.
		const reply = { channel: "#general", thread: THREAD, text: "ok" };
		expect(await run.code("slack_reply", reply)).toBe("POLICY_DENIED");
		expect(await run.code("slack_post_message", { channel: "#partner", text: "x" })).toBe("EXTERNAL_CHANNEL");
		expect(await run.code("slack_post_message", { channel: "#old", text: "x" })).toBe("CHANNEL_ARCHIVED");
		expect(await run.code("slack_post_message", { channel: "#general", text: "https://acme.slack.com/x" })).toBe("INVALID_ARGUMENTS");
		expect(slack.writes.length).toBe(1);

		slack.writes = [];
		run = await start(slack, { [GENERAL]: ["read", "reply"], [RANDOM]: ["read", "reply"] });
		const replied = only(await run.call("slack_reply", { channel: "#general", thread: REPLY, text: "ok" }));
		expect(replied.thread_ts).toBe(THREAD);
		expect(slack.writes.length).toBe(1);
		expect(slack.writes[0]?.thread_ts).toBe(THREAD);
		expect(slack.writes[0]?.reply_broadcast).toBe(false);
		// No channel allows posting, so the tool is not offered.
		expect(await run.code("slack_post_message", { channel: "#general", text: "x" })).toBe("UNKNOWN_OPERATION");
		const elsewhere = { channel: "#general", thread: "1727780000.000900", text: "x" };
		expect(await run.error("slack_reply", elsewhere)).toEqual({ code: "INVALID_ARGUMENTS", message: "thread must be a message in this channel." });
		expect(await run.code("slack_reply", { channel: "#random", thread: "1727780000.000700", text: "x" })).toBe("NOT_IN_CHANNEL");
		expect(slack.writes.length).toBe(1);
	});

	test("a channel that changed before the write is refused", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read", "reply"] });
		const args = { channel: GENERAL, thread: THREAD, text: "x" };
		const changedAfterResolving = (change: FakeChannel) => {
			let infos = 0;
			slack.hook = (method) => {
				if (method !== "conversations.info") return null;
				infos += 1;
				const general = slack.channels[GENERAL] as FakeChannel;
				return json(200, { ok: true, channel: infos === 1 ? general : { ...general, ...change } });
			};
		};
		changedAfterResolving({ is_ext_shared: true });
		expect(await run.code("slack_reply", args)).toBe("EXTERNAL_CHANNEL");
		changedAfterResolving({ is_pending_ext_shared: true });
		expect(await run.code("slack_reply", { ...args, text: "y" })).toBe("EXTERNAL_CHANNEL");
		changedAfterResolving({ id: "C0OTHER000" });
		expect(await run.code("slack_reply", { ...args, text: "z" })).toBe("CHANNEL_MOVED");
		changedAfterResolving({ is_member: false });
		expect(await run.code("slack_reply", { ...args, text: "w" })).toBe("NOT_IN_CHANNEL");
		expect(slack.writes).toEqual([]);
	});

	test("write outcomes follow what Slack confirmed", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read", "post"] });
		const args = { channel: "#general", text: "hi" };
		const answer = (body: Json, status = 200) => {
			slack.hook = (method) => (method === "chat.postMessage" ? json(status, body) : null);
		};
		answer({ ok: false, error: "ratelimited" }, 429);
		expect(await run.code("slack_post_message", { ...args, text: "a" })).toBe("PROVIDER_RATE_LIMITED");
		answer({ ok: false, error: "restricted_action" });
		expect(await run.code("slack_post_message", { ...args, text: "b" })).toBe("PROVIDER_FORBIDDEN");
		// Confirmed without the message: applied, with nothing more to show.
		answer({ ok: true });
		const written = only(await run.call("slack_post_message", { ...args, text: "c" }));
		expect(written.written).toBe(true);
		expect(written.ts).toBeNull();
		// An error after the post may have gone through: unknown, and further writes pause.
		answer({ ok: false, error: "internal_error" });
		expect(await run.code("slack_post_message", { ...args, text: "d" })).toBe("WRITE_UNCERTAIN");
		slack.hook = null;
		expect(await run.code("slack_post_message", { ...args, text: "e" })).toBe("WRITE_UNCERTAIN");
		// Writes Slack refused are forgotten, so they may be sent again.
		// The fake clock stands still, so they are listed in the order of their keys, which are hashes.
		expect(run.writes().map((write) => write.status).sort()).toEqual(["succeeded", "uncertain"]);
	});

	test("reads with errors or too much data are refused", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read"] });
		slack.hook = (method) => (method === "conversations.history" ? json(200, { ok: false, error: "missing_scope" }) : null);
		expect(await run.code("slack_read_channel", { channel: GENERAL })).toBe("PROVIDER_FORBIDDEN");
		const huge = { ok: true, messages: [{ ts: THREAD, text: "x".repeat(5 * 1024 * 1024) }] };
		slack.hook = (method) => (method === "conversations.history" ? json(200, huge) : null);
		expect(await run.code("slack_read_channel", { channel: GENERAL })).toBe("RESPONSE_TOO_LARGE");
		slack.hook = (method) => (method === "conversations.info" ? json(200, { ok: false, error: "token_revoked" }) : null);
		expect(await run.code("slack_read_channel", { channel: GENERAL })).toBe("CONNECTION_UNAUTHORIZED");
	});

	test("a name scan cut short reveals nothing", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { "*": ["read"] }, slackConnector({ resolvePage: 1, resolvePages: 2 }));
		// #general and #random are on the pages read, #private is not; all are refused alike.
		for (const name of ["#general", "#random", "#private", "#nope"]) {
			expect(await run.code("slack_read_channel", { channel: name }), name).toBe("PROVIDER_LIMIT");
		}
		const general = only(await run.call("slack_read_channel", { channel: GENERAL, limit: 1 }));
		expect(general.ts).toBe("1727780100.000200");
	});
});

describe("requests and arguments", () => {
	test("a post whose answer is not UTF-8 stays unknown", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read", "post"] });
		const bytes = new Uint8Array([...new TextEncoder().encode('{"ok": true, "ts": "1727790000.000001", "x": "'), 0xff, ...new TextEncoder().encode('"}')]);
		slack.hook = (method) => (method === "chat.postMessage" ? new Response(bytes, { status: 200 }) : null);
		expect(await run.code("slack_post_message", { channel: "#general", text: "hi" })).toBe("WRITE_UNCERTAIN");
		expect(run.writes().map((write) => write.status)).toEqual(["uncertain"]);
	});

	test("a post is sent as JSON, with the token", async () => {
		const slack = new FakeSlack();
		const bodies: string[] = [];
		const run = await Scenario.start({
			connectors: [slackConnector()],
			connections: [{ id: SLACK, provider: "slack", payload: { kind: "oauth2", access_token: "xoxb-t", refresh_token: null, scopes: null } }],
			user: userGrants(SLACK, CHANNEL, { [GENERAL]: ["read", "post"] }),
			fetch: async (input, init) => {
				const request = new Request(input as RequestInfo, init as RequestInit);
				if (request.method === "POST") bodies.push(await request.clone().text());
				return slack.fetch(request);
			},
		});
		await run.ok("slack_post_message", { channel: "#general", text: "  Caf\u00e9 \ud83e\udd89  " });
		expect(bodies).toEqual([
			'{"channel":"C0GENERAL1","text":"Caf\u00e9 \ud83e\udd89","mrkdwn":true,"parse":"none","link_names":false,"unfurl_links":false,"unfurl_media":false}',
		]);
		expect(new Set(slack.tokens)).toEqual(new Set(["Bearer xoxb-t"]));
		const [, params] = slack.ops.find(([name]) => name === "conversations.list") as [string, Params];
		expect(params).toEqual({ types: "public_channel,private_channel", exclude_archived: "false", limit: "200" });
	});

	test("arguments are refused with the field and the reason", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { [GENERAL]: ["read", "reply", "post"] });
		expect(await run.error("slack_read_channel", { channel: "a.b" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: 'Invalid arguments. channel: must be a channel name such as "#general", or a channel id such as "C0123ABCDEF"',
		});
		expect(await run.error("slack_read_channel", { channel: "#general", after: "yesterday" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. after: must be an ISO 8601 time such as 2026-10-01T09:00:00Z",
		});
		expect(await run.error("slack_reply", { channel: "#general", thread: "1727780000", text: "x" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: 'Invalid arguments. thread: must be a message ts such as "1727780000.123456"',
		});
		expect(await run.error("slack_post_message", { channel: "#general", text: "see slack.com" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. text: must not link to Slack: Slack would show the linked message, which may be in another channel",
		});
		expect(await run.error("slack_post_message", { channel: "#general", text: "bell\u0007" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. text: must not contain control characters other than tabs and newlines",
		});
		expect(await run.error("slack_post_message", { channel: "#general", text: "   " })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. text: Too small: expected string to have >=1 characters",
		});
		expect(await run.error("slack_list_channels", { limit: 201 })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. limit: Too big: expected number to be <=200",
		});
		expect(slack.writes).toEqual([]);
	});

	test("cursors: the provider's become page tokens, and a bad one from Slack is refused", async () => {
		const slack = new FakeSlack();
		const run = await start(slack, { "*": ["read"] });
		const first = await run.ok("slack_list_channels", { limit: 2 });
		expect(first.result.items.map((item) => (item as JsonObject).name)).toEqual(["general", "private"]);
		const next = first.result.next_cursor as string;
		expect(next).not.toBe("p2");
		const second = await run.ok("slack_list_channels", { limit: 2, cursor: next });
		expect(second.result.items.map((item) => (item as JsonObject).name)).toEqual(["partner"]);
		expect(second.result.next_cursor).toBeUndefined();
		expect(await run.code("slack_list_channels", { limit: 2, cursor: "p2" })).toBe("INVALID_CURSOR");
		slack.hook = (method) =>
			method === "users.conversations" ? json(200, { ok: true, channels: [], response_metadata: { next_cursor: "not a cursor" } }) : null;
		expect(await run.code("slack_list_channels", {})).toBe("PROVIDER_LIMIT");
	});

	test("names are looked up five at a time, and at most thirty", async () => {
		const slack = new FakeSlack();
		const people = Array.from({ length: 40 }, (_, index) => `U0P${String(index).padStart(3, "0")}`);
		for (const id of people) slack.users[id] = { id, name: id.toLowerCase(), real_name: `Person ${id}` };
		const mentions = people.map((id) => `<@${id}>`).join(" ");
		(slack.messages[GENERAL] as FakeMessage[]).push({ type: "message", ts: "1727780200.000000", user: "U0ADA", text: mentions });
		let open = 0;
		let most = 0;
		const fetch = slack.fetch;
		const run = await Scenario.start({
			connectors: [slackConnector()],
			connections: [{ id: SLACK, provider: "slack", payload: { kind: "oauth2", access_token: "xoxb-t", refresh_token: null, scopes: null } }],
			user: userGrants(SLACK, CHANNEL, { [GENERAL]: ["read"] }),
			fetch: async (input, init) => {
				open += 1;
				most = Math.max(most, open);
				await new Promise((resolve) => setTimeout(resolve, 1));
				try {
					return await fetch(input, init);
				} finally {
					open -= 1;
				}
			},
		});
		const latest = only(await run.call("slack_read_channel", { channel: GENERAL, limit: 1 }));
		expect(latest.ts).toBe("1727780200.000000");
		expect(latest.author).toBe("ada");
		expect(Object.keys(latest.mentioned as JsonObject).length).toBe(29);
		expect(slack.names().filter((name) => name === "users.info").length).toBe(30);
		expect(most).toBe(5);
	});

	test.each([
		["list_channels", {}, { limit: 100, cursor: null }],
		["list_channels", { cursor: "  p2  " }, { limit: 100, cursor: "p2" }],
		["read_channel", { channel: "  General  " }, { channel: "#general", limit: 20, after: null, before: null, cursor: null }],
		["read_channel", { channel: "#\u{1f989}" }, { channel: "#\u{1f989}", limit: 20, after: null, before: null, cursor: null }],
		[
			"read_channel",
			{ channel: GENERAL, after: "2024-10-01", before: " 2024-10-01T12:00:00+02:00 " },
			{ channel: GENERAL, limit: 20, after: "1727740800.000000", before: "1727776800.000000", cursor: null },
		],
		["read_thread", { channel: "#general", thread: " 1727780000.000100 " }, { channel: "#general", thread: "1727780000.000100", limit: 50, cursor: null }],
		["post_message", { channel: "#general", text: "  tab\tand\r\nnewline  " }, { channel: "#general", text: "tab\tand\r\nnewline" }],
		["reply", { channel: "#general", thread: REPLY, text: " ok " }, { channel: "#general", thread: REPLY, text: "ok" }],
	])("%s normalizes %j, which write keys and query hashes hash", async (name, input, expected) => {
		const op = slackConnector().operations.find((item) => item.name === name);
		expect(await validateInput(op?.input as z.ZodType, input)).toEqual({ ok: true, data: expected });
	});

	test.each([
		["list_channels", { limit: 1.5 }],
		["list_channels", { limit: "5" }],
		["list_channels", { cursor: "x".repeat(501) }],
		["read_channel", { channel: "x".repeat(82) }],
		["read_channel", { channel: "#gen\ud800" }],
		["read_channel", { channel: "#general", after: "" }],
		["read_channel", { channel: "#general", extra: 1 }],
		["read_thread", { channel: "#general", thread: "\u0661\u0667\u0662\u0667\u0667\u0668\u0660\u0660\u0660\u0660.\u0660\u0660\u0660\u0661\u0660\u0660" }],
		["read_thread", { channel: "#general", thread: "111111111111111111111" }],
		["post_message", { channel: "#general", text: "x".repeat(4_001) }],
		["post_message", { channel: "#general", text: "\u{1f989}".repeat(2_001) }],
		["reply", { channel: "#general", thread: REPLY, text: "ok", broadcast: true }],
	])("%s refuses case %#", async (name, input) => {
		const op = slackConnector().operations.find((item) => item.name === name);
		expect(await validateInput(op?.input as z.ZodType, input)).toMatchObject({ ok: false });
	});
});

describe("registry", () => {
	test("accepts the Slack declaration; its fingerprints", async () => {
		const connector = slackConnector();
		expect([connector.manageLink, connector.offered]).toEqual([undefined, undefined]);
		const registry = await Registry.create([connector]);
		const fingerprints = Object.fromEntries(registry.get("slack").operations.map((op) => [op.name, registry.contract("slack", op.name)]));
		console.info("slack fingerprints", fingerprints);
		expect(Object.values(fingerprints).every((value) => /^[0-9a-f]{16}$/.test(value))).toBe(true);
		// Pinned: a change here means running runs fail the tool with OPERATION_CHANGED, so it must be meant.
		expect(fingerprints).toEqual({
			list_channels: "073b3dba6945a9e7",
			read_channel: "281622e2b8560c6c",
			read_thread: "69abd44c841ffc16",
			post_message: "146ded8f64cd41e2",
			reply: "70f271cdd3eb2059",
		});
	});

	test("the Worker's registry serves Slack", async () => {
		expect(CONNECTORS.some((connector) => connector.slug === "slack")).toBe(true);
		const registry = await connectorRegistry();
		expect(registry.get("slack").name).toBe("Slack");
	});
});

describe("text and judging", () => {
	test("read text hides names of linked channels", () => {
		const shown = redact(
			`<#${PRIVATE}|${SECRET}> <https://acme.slack.com/archives/${PRIVATE}/p1|${SECRET}> ` +
				`<https://acme%2Eslack.com/x|${SECRET}> <https://acme.slack-gov.com/archives/${PRIVATE}/p1|${SECRET}> ` +
				`<slack://channel?team=T0ACME&id=${PRIVATE}|${SECRET}> ` +
				`<https://example.com|docs> <@U0ADA|ada> <#${GENERAL}>`,
		);
		expect(shown).not.toContain(SECRET);
		expect(shown).toContain(`<#${PRIVATE}>`);
		expect(shown).toContain(`<https://acme.slack.com/archives/${PRIVATE}/p1>`);
		for (const kept of ["<https://example.com|docs>", "<@U0ADA|ada>", `<#${GENERAL}>`]) expect(shown).toContain(kept);
	});

	test.each([
		"see https://acme.slack.com/archives/C0GENERAL1/p1727780000000100",
		"slack.com/archives/C1",
		"acme.slack%2Ecom/archives",
		"acme.slack&#46;com/archives",
		"acme.slack\uff0ecom/archives",
		"acme.slack\u200b.com",
		"acme.slack\\.com",
		"files.slack-files.com/x",
		"https://acme.slack-gov.com/archives/C0PRIVATE1/p1",
		"slack://channel?team=T0ACME&id=C0PRIVATE1",
		"SLACK.COM",
		"\u017flack.com",
		"slac\u212a.com",
		"acme.slack-f\u0131les.com",
		"ACME.SLACK-F\u0130LES.COM",
		"bell\x07",
	])("written text may not link to Slack: %j", (written) => {
		expect(writtenProblem(written)).not.toBeNull();
	});

	test("written text is escaped", () => {
		expect(writtenProblem("*Done* & <!channel> <@U0ADA> <https://x|y>\n- next")).toBeNull();
		expect(escape("a & <!here> <@U0ADA>")).toBe("a &amp; &lt;!here&gt; &lt;@U0ADA&gt;");
	});

	test("judge claims only what Slack confirms", () => {
		const response = (status: number, body: unknown): [Response, string, Uint8Array] => {
			const text = typeof body === "string" ? body : JSON.stringify(body);
			return [new Response([101, 103, 204, 205, 304].includes(status) ? null : text, { status }), text, new TextEncoder().encode(text)];
		};
		const judged = (status: number, body: unknown) => judge(...response(status, body));
		expect(judged(200, { ok: true, ts: "1.2" })).toBe("applied");
		for (const error of ["not_in_channel", "is_archived", "ratelimited", "invalid_auth", "msg_too_long", "accesslimited"]) {
			expect(judged(200, { ok: false, error })).toBe("not_applied");
		}
		for (const error of ["internal_error", "fatal_error", "request_timeout", "something_new", null]) {
			expect(judged(200, { ok: false, error })).toBe("unknown");
		}
		expect(judged(200, "<html>")).toBe("unknown");
		expect(judged(200, [1])).toBe("unknown");
		// The answer is UTF-8 JSON; a byte order mark is dropped.
		expect(judged(200, '\ufeff{"ok": true}')).toBe("applied");
		expect(judge(new Response("x"), "", Uint8Array.from([0x7b, 0xff, 0x7d]))).toBe("unknown");
		// Slack answers with 200; any other success status is judged by its body all the same.
		expect(judged(201, { ok: false, error: "not_in_channel" })).toBe("not_applied");
		expect(judged(204, "")).toBe("unknown");
		expect(judged(429, { ok: false, error: "ratelimited" })).toBeNull();
		expect(judged(500, "")).toBeNull();
	});
});
