// backend/tests/test_teams.py, case by case: the Microsoft Teams connector against an in-memory Microsoft Graph
// behind an injected `fetch`, and runs through the executor. Text, addresses and tool inputs are compared with
// vectors from today's Python in connectors-teams-vectors.test.ts (test/fixtures/connectors/teams/generate.py).
// The OAuth flow itself (the authorize URL, the token exchange) belongs to the Worker; the scopes a connector asks
// for and the consent it needs are tested here as test_scopes_follow_the_allowed_actions tests them.

import { afterEach, describe, expect, test } from "vitest";
import { LIMITS as CLIENT_LIMITS, Mention, nextCursor, pageParams } from "../../src/connectors/teams/client.ts";
import { LIMITS, teamsConnector } from "../../src/connectors/teams/connector.ts";
import { read } from "../../src/connectors/teams/html.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { ceilingRow, jsonResponse, received, startRun, type Received } from "../fixtures/connectors/microsoft/runs.ts";

type JsonObject = { [key: string]: Json };

const SECRET = "SECRET merger";
const USER_ID = "00000000-0000-0000-0000-00000000c0c0";
const ENG = "aaaaaaaa-0000-0000-0000-000000000001";
const FIN = "bbbbbbbb-0000-0000-0000-000000000002";
const GENERAL = "19:general0001@thread.tacv2";
const PRIVATE = "19:private0001@thread.tacv2";
const SHARED = "19:shared00001@thread.tacv2";
const BUDGET = "19:budget00001@thread.tacv2";
const SCOPES = ["ChannelMessage.Read.All", "ChannelMessage.Send", "User.Read", "openid", "profile"];
// Teams' skiptokens are not always URL-safe.
const TOKEN = '{"page":2,"x":"a+b/c"}';

function message(id: string, channel: string, content: string, team: string = ENG, fields: JsonObject = {}): JsonObject {
	return {
		id,
		replyToId: null,
		messageType: "message",
		createdDateTime: "2026-10-01T09:00:00Z",
		lastEditedDateTime: null,
		deletedDateTime: null,
		subject: null,
		importance: "normal",
		webUrl: `https://teams.microsoft.com/l/message/${id}`,
		from: { user: { id: USER_ID, displayName: "Ada" }, application: null },
		body: { contentType: "html", content },
		channelIdentity: { teamId: team.toUpperCase(), channelId: channel },
		attachments: [],
		mentions: [],
		reactions: [],
		...fields,
	};
}

type Hook = (method: string, path: string, params: { [name: string]: string }) => Response | null;

/**
 * Microsoft Graph's Teams API (test_teams.py `FakeGraph`). Engineering hosts General, Private (private) and Shared
 * (shared); Finance hosts Budget. Graph spells Engineering's id in upper case in some answers.
 */
class FakeGraph {
	user: JsonObject = { id: USER_ID, displayName: "Me", mail: "me@contoso.com" };
	teams: JsonObject[] = [
		{ id: FIN, displayName: "Finance", description: null, isArchived: false },
		{ id: ENG.toUpperCase(), displayName: "Engineering", description: "Builds", isArchived: false },
	];
	channels: { [team: string]: JsonObject[] } = {
		[ENG]: [
			{ id: GENERAL, displayName: "General", membershipType: "standard" },
			{ id: PRIVATE, displayName: "Private", membershipType: "private" },
			{ id: SHARED, displayName: "Shared", membershipType: "shared" },
		],
		[FIN]: [{ id: BUDGET, displayName: SECRET, membershipType: "standard" }],
	};
	messages: { [channel: string]: JsonObject[] } = {
		[GENERAL]: [
			message("1001", GENERAL, "<p>Hello <b>team</b></p>"),
			message("1002", GENERAL, "", ENG, { messageType: "systemEventMessage" }),
			// Graph returns a message of another channel: it is dropped.
			message("1003", BUDGET, SECRET, FIN),
			message("1004", GENERAL, SECRET, ENG, { deletedDateTime: "2026-10-01T10:00:00Z", subject: SECRET }),
		],
		[PRIVATE]: [message("2001", PRIVATE, "private news")],
		[SHARED]: [message("3001", SHARED, "shared news")],
		[BUDGET]: [message("4001", BUDGET, SECRET, FIN)],
	};
	replies: { [root: string]: JsonObject[] } = {
		"1001": [
			message("1101", GENERAL, "first reply", ENG, { replyToId: "1001" }),
			message("1102", GENERAL, SECRET, ENG, { replyToId: "9999" }),
			message("1103", BUDGET, SECRET, FIN, { replyToId: "1001" }),
			message("1104", GENERAL, "second reply", ENG, { replyToId: "1001" }),
		],
	};
	pageSize: number | null = null;
	requests: Received[] = [];
	writes: [string, JsonObject][] = [];
	hook: Hook | null = null;

	#notFound(): Response {
		return jsonResponse(404, { error: { code: "NotFound", message: SECRET } });
	}

	#page(path: string, items: JsonObject[], params: { [name: string]: string }): Response {
		const top = this.pageSize ?? Number(params.$top ?? 100);
		let start = 0;
		if ("$skiptoken" in params) {
			expect(params.$skiptoken?.startsWith(TOKEN)).toBe(true);
			start = Number((params.$skiptoken as string).slice(TOKEN.length));
		}
		const body: JsonObject = { value: items.slice(start, start + top) };
		if (start + top < items.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0${path}?$skiptoken=${encodeURIComponent(`${TOKEN}${start + top}`)}`;
		return jsonResponse(200, body);
	}

	#find(channelId: string, messageId: string): JsonObject | undefined {
		const everything = [...(this.messages[channelId] ?? []), ...(this.replies[messageId] ?? []), ...Object.values(this.replies).flat()];
		return everything.find((item) => item.id === messageId);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = await received(input, init);
		this.requests.push(request);
		const path = request.path;
		const hooked = this.hook?.(request.method, path, request.params) ?? null;
		if (hooked !== null) return hooked;
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (parts.length > 1 && parts[0] === "teams") {
			parts[1] = (parts[1] as string).toLowerCase();
			if (!Object.hasOwn(this.channels, parts[1])) return this.#notFound();
		}
		if (request.method === "POST") {
			const sent = JSON.parse(request.body) as { body: { content: string } };
			this.writes.push([path, sent as unknown as JsonObject]);
			if (parts.length === 5 && parts[0] === "teams" && parts[2] === "channels" && parts[4] === "messages") {
				return jsonResponse(201, message("5001", parts[3] as string, sent.body.content, parts[1]));
			}
			if (parts.length === 7 && parts[0] === "teams" && parts[2] === "channels" && parts[4] === "messages" && parts[6] === "replies") {
				return jsonResponse(201, message("5002", parts[3] as string, sent.body.content, parts[1], { replyToId: parts[5] as string }));
			}
			throw new Error(path);
		}
		const [a, b, c, d, e, f, g] = parts;
		if (a === "me" && parts.length === 1) return jsonResponse(200, this.user);
		if (a === "me" && b === "joinedTeams" && parts.length === 2) return jsonResponse(200, { value: this.teams });
		if (a === "teams" && c === "channels" && parts.length === 3) {
			expect(request.params.$select).toBe("id,displayName,description,membershipType,webUrl");
			return this.#page(path, this.channels[b as string] as JsonObject[], request.params);
		}
		if (a === "teams" && c === "channels" && e === "messages" && parts.length === 5) {
			if (!Object.hasOwn(this.messages, d as string)) return this.#notFound();
			return this.#page(path, this.messages[d as string] as JsonObject[], request.params);
		}
		if (a === "teams" && c === "channels" && e === "messages" && parts.length === 6) {
			const found = this.#find(d as string, f as string);
			return found ? jsonResponse(200, found) : this.#notFound();
		}
		if (a === "teams" && c === "channels" && e === "messages" && g === "replies" && parts.length === 7) {
			if (!Object.hasOwn(this.replies, f as string)) return this.#notFound();
			return this.#page(path, this.replies[f as string] as JsonObject[], request.params);
		}
		throw new Error(path);
	};

	reads(suffix: string): Received[] {
		return this.requests.filter((request) => request.method === "GET" && request.path.endsWith(suffix));
	}

	client() {
		return teamsConnector().client("token", settingsIo(this.fetch));
	}
}

/** Starts a run with the user's Teams connection, holding `grants` ({team or channel: actions}). */
function start(graph: FakeGraph, grants: { [channel: string]: string[] }, options: { scopes?: string[]; ceiling?: ReturnType<typeof ceilingRow>[] } = {}) {
	const rows = Object.fromEntries(Object.entries(grants).map(([id, actions]) => [`channel:${id}`, actions]));
	return startRun(teamsConnector(), graph.fetch, { scopes: options.scopes ?? SCOPES, grants: rows, ceiling: options.ceiling ?? [] });
}

type Run = Awaited<ReturnType<typeof start>>;
type Item = { [key: string]: Json };

async function items(run: Run, tool: string, args: Json): Promise<Item[]> {
	return (await run.ok(tool, args)).result.items as Item[];
}

async function ids(run: Run, tool: string, args: Json): Promise<string[]> {
	return (await items(run, tool, args)).map((item) => item.id as string);
}

const mentions = (...found: [number, Json][]): readonly Mention[] => found.map(([id, mentioned]) => Mention.parse({ id, mentioned }));

test("a mention's id is Graph's integer", () => {
	expect(Mention.parse({ id: 0 }).id).toBe(0);
	for (const id of ["0", 1.5, true]) expect(Mention.safeParse({ id }).success, JSON.stringify(id)).toBe(false);
});

afterEach(() => {
	LIMITS.discoveryPage = 10;
	CLIENT_LIMITS.maxPages = 10;
});

describe("connecting and discovery", () => {
	test("test_only_work_and_school_accounts_connect", async () => {
		const graph = new FakeGraph();
		const connector = teamsConnector();
		const account = await connector.account(graph.client());
		expect([account.id, account.label]).toEqual([USER_ID, "me@contoso.com"]);
		graph.user.id = "abcdef0123456789";
		await expect(connector.account(graph.client())).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT" });
	});

	test("test_discovery_lists_whole_teams_and_names_only_canonical_ids", async () => {
		const graph = new FakeGraph();
		const connector = teamsConnector();
		const client = graph.client();
		const page = await connector.discover(client, "channel", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[ENG, "Engineering"],
			[GENERAL, "Engineering / General"],
			[PRIVATE, "Engineering / Private"],
			[SHARED, "Engineering / Shared"],
			[FIN, "Finance"],
			[BUDGET, `Finance / ${SECRET}`],
		]);
		expect(page.nextCursor).toBeNull();
		let found = await connector.discover(client, "channel", { query: "priv", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([PRIVATE]);
		const described = await connector.describe(client, "channel", [ENG, ENG.toUpperCase(), GENERAL, GENERAL.toUpperCase(), "19:nosuch@thread.tacv2", "x"]);
		expect(described).toEqual({ [ENG]: "Engineering", [GENERAL]: "Engineering / General" });
		LIMITS.discoveryPage = 1;
		const first = await connector.discover(client, "channel", { query: null, cursor: null });
		expect(first.items.map((item) => item.id)).toEqual([ENG, GENERAL, PRIVATE, SHARED]);
		const second = await connector.discover(client, "channel", { query: null, cursor: first.nextCursor ?? null });
		expect([second.items.map((item) => item.id), second.nextCursor]).toEqual([[FIN, BUDGET], null]);
		// A search scans on until something matches, and stops there.
		found = await connector.discover(client, "channel", { query: "general", cursor: null });
		expect([found.items.map((item) => item.id), found.nextCursor]).toEqual([[GENERAL], "1"]);
		// A team's channels are found under its name too.
		found = await connector.discover(client, "channel", { query: "fin", cursor: null });
		expect([found.items.map((item) => item.id), found.nextCursor]).toEqual([[FIN, BUDGET], null]);
		found = await connector.discover(client, "channel", { query: "nothing", cursor: null });
		expect([found.items.map((item) => item.id), found.nextCursor]).toEqual([[], null]);
		for (const cursor of ["x", "-1", "99999"]) {
			await expect(connector.discover(client, "channel", { query: null, cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		}
	});

	test("test_channel_listings_follow_teams_page_tokens_up_to_a_cap", async () => {
		const graph = new FakeGraph();
		graph.pageSize = 2;
		const page = await teamsConnector().discover(graph.client(), "channel", { query: null, cursor: null });
		expect(page.items.map((item) => item.id)).toContain(SHARED);
		expect(graph.reads(`/teams/${ENG}/channels`).map((request) => request.params.$skiptoken)).toEqual([undefined, `${TOKEN}2`]);
		CLIENT_LIMITS.maxPages = 1;
		await expect(teamsConnector().discover(graph.client(), "channel", { query: null, cursor: null })).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
	});

	test("test_cursors_are_checked", () => {
		expect(pageParams(`t:${TOKEN}`)).toEqual({ $skiptoken: TOKEN });
		for (const cursor of ["token:abc", "t:", "t:a b", `t:${"a".repeat(991)}`, "t:\u00e9"]) {
			expect(() => pageParams(cursor), cursor).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		}
		expect(nextCursor(null)).toBeNull();
		for (const link of ["https://graph.microsoft.com/v1.0/x?$skip=2", "https://x/?$skiptoken=a%20b"]) {
			expect(() => nextCursor(link)).toThrow(expect.objectContaining({ code: "PROVIDER_LIMIT" }));
		}
	});

	test("test_scopes_follow_the_allowed_actions", () => {
		const connector = teamsConnector();
		const base = ["offline_access", "User.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All"];
		expect(requestedScopes(connector, new Set(["read"]))).toEqual([...base, "ChannelMessage.Read.All"]);
		expect(requestedScopes(connector, new Set(["read", "reply"]))).toEqual([...base, "ChannelMessage.Read.All", "ChannelMessage.Send"]);
		const granted = ["https://graph.microsoft.com/channelmessage.read.all", "ChannelMessage.Send"];
		expect(consentNeeded(connector, granted, new Set(["read", "reply", "post"]))).toEqual([]);
		// Replying reads the message replied to.
		expect(consentNeeded(connector, ["ChannelMessage.Send"], new Set(["reply", "post"]))).toEqual(["reply"]);
	});
});

describe("reading", () => {
	test("test_a_team_grant_covers_its_channels", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read"] });
		expect(await ids(run, "teams_list_teams", {})).toEqual([ENG]);
		const channels = await items(run, "teams_list_channels", {});
		expect(channels.map((channel) => channel.id)).toEqual([GENERAL, PRIVATE, SHARED]);
		expect(channels[0]).toEqual({ id: GENERAL, team_id: ENG, name: "General", description: null, membership: "standard", link: null });
		expect(await ids(run, "teams_list_channels", { team_id: FIN })).toEqual([]);
		expect(await ids(run, "teams_list_channels", { team_id: ENG.toUpperCase() })).toEqual([GENERAL, PRIVATE, SHARED]);
		expect(await ids(run, "teams_read_channel", { team_id: ENG.toUpperCase(), channel_id: PRIVATE })).toEqual(["2001"]);
		expect(await run.code("teams_read_channel", { team_id: FIN, channel_id: BUDGET })).toBe("POLICY_DENIED");
		expect(graph.reads("/messages").slice(1)).toEqual([]);
		for (const [teamId, channelId] of [
			["cccccccc-0000-0000-0000-000000000003", GENERAL],
			[ENG, "19:nosuch0001@thread.tacv2"],
			[ENG, GENERAL.replace("general", "GENERAL")],
		] as const) {
			expect(await run.code("teams_read_channel", { team_id: teamId, channel_id: channelId })).toBe("POLICY_DENIED");
		}
		for (const args of [
			{ team_id: "eng", channel_id: GENERAL },
			{ team_id: ENG, channel_id: "General" },
		]) {
			expect(await run.code("teams_read_channel", args)).toBe("INVALID_ARGUMENTS");
		}
	});

	test("test_a_channel_is_reached_only_through_the_team_hosting_it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] });
		// Graph would answer for a channel under any team; Minerva asks only teams that host it.
		expect(await run.code("teams_read_channel", { team_id: FIN, channel_id: GENERAL })).toBe("POLICY_DENIED");
		expect(graph.reads("/messages")).toEqual([]);
	});

	test("test_denies_hold_inside_an_allowed_team_and_under_any_case", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] }, { ceiling: [ceilingRow("channel", PRIVATE, "deny"), ceilingRow("channel", FIN, "deny")] });
		expect(await ids(run, "teams_list_teams", {})).toEqual([ENG]);
		expect(await ids(run, "teams_list_channels", {})).toEqual([GENERAL, SHARED]);
		for (const [teamId, channelId] of [
			[ENG, PRIVATE],
			[FIN, BUDGET],
			[FIN.toUpperCase(), BUDGET],
		] as const) {
			expect(await run.code("teams_read_channel", { team_id: teamId, channel_id: channelId })).toBe("POLICY_DENIED");
		}
		expect(graph.reads("/messages")).toEqual([]);
	});

	test("test_messages_leave_out_events_strays_and_deleted_text", async () => {
		const graph = new FakeGraph();
		const first = graph.messages[GENERAL]?.[0] as JsonObject;
		first.attachments = [
			{ contentType: "reference", name: "plan.docx", contentUrl: SECRET },
			{ contentType: "messageReference", name: null, content: SECRET },
		];
		first.reactions = [{ reactionType: "like" }, { reactionType: "like" }];
		first.subject = "Plans";
		const run = await start(graph, { [ENG]: ["read"] });
		const outcome = await run.ok("teams_read_channel", { team_id: ENG, channel_id: GENERAL });
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		const [shown, deleted] = outcome.result.items as Item[];
		expect(shown).toEqual({
			id: "1001",
			team_id: ENG,
			channel_id: GENERAL,
			reply_to_id: null,
			created_time: "2026-10-01T09:00:00Z",
			edited_time: null,
			deleted: false,
			author: "Ada",
			author_id: USER_ID,
			importance: "normal",
			link: "https://teams.microsoft.com/l/message/1001",
			subject: "Plans",
			text: "Hello team",
			text_truncated: false,
			reactions: [{ type: "like", count: 2 }],
			files: [{ name: "plan.docx" }],
			attachments_not_shown: 1,
		});
		expect([deleted?.id, deleted?.deleted, deleted?.text, deleted?.subject]).toEqual(["1004", true, "", null]);
		expect(graph.reads("/messages").at(-1)?.params.$top).toBe("20");
	});

	test("test_channel_pages_are_run_bound", async () => {
		const graph = new FakeGraph();
		graph.pageSize = 1;
		const run = await start(graph, { [ENG]: ["read"] });
		const args = { team_id: ENG, channel_id: GENERAL };
		const first = await run.ok("teams_read_channel", args);
		expect((first.result.items as Item[]).map((item) => item.id)).toEqual(["1001"]);
		const second = await run.ok("teams_read_channel", { ...args, cursor: first.result.next_cursor as string });
		expect(second.result.items).toEqual([]);
		expect(graph.reads(`${GENERAL}/messages`).at(-1)?.params.$skiptoken).toBe(`${TOKEN}1`);
		const other = { team_id: ENG, channel_id: PRIVATE, cursor: first.result.next_cursor as string };
		expect(await run.code("teams_read_channel", other)).toBe("INVALID_CURSOR");
	});

	test("test_threads_start_with_their_root_and_keep_only_its_replies", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read"] });
		const args = { team_id: ENG, channel_id: GENERAL, message_id: "1001" };
		const outcome = await run.ok("teams_read_thread", args);
		expect((outcome.result.items as Item[]).map((item) => item.id)).toEqual(["1001", "1101", "1104"]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		graph.pageSize = 1;
		const first = await run.ok("teams_read_thread", { ...args, limit: 1 });
		expect((first.result.items as Item[]).map((item) => item.id)).toEqual(["1001", "1101"]);
		const second = await run.ok("teams_read_thread", { ...args, limit: 1, cursor: first.result.next_cursor as string });
		expect(second.result.items).toEqual([]);
		for (const messageId of ["1101", "4001", "77"]) {
			expect(await run.code("teams_read_thread", { team_id: ENG, channel_id: GENERAL, message_id: messageId })).toBe("INVALID_ARGUMENTS");
		}
	});

	// Beyond test_teams.py: these pin what the Python code does and its tests leave to chance.
	test("a message Graph puts in another team's channel of the same id, a channel with an id Teams does not use, and a reaction without a type are left out", async () => {
		const graph = new FakeGraph();
		(graph.messages[GENERAL] as JsonObject[]).push(message("1005", GENERAL, SECRET, FIN), message("1006", GENERAL, "kept"));
		(graph.channels[ENG] as JsonObject[]).push({ id: "General", displayName: SECRET, membershipType: "standard" }, { id: "19:odd id@thread.tacv2", displayName: SECRET, membershipType: "standard" });
		(graph.messages[GENERAL] as JsonObject[])[0] = message("1001", GENERAL, "<p>Hello</p>", ENG, { reactions: [{ reactionType: null }, { reactionType: "" }, { reactionType: "heart" }] });
		const run = await start(graph, { [ENG]: ["read"] });
		const listed = await run.ok("teams_read_channel", { team_id: ENG, channel_id: GENERAL });
		const found = listed.result.items as Item[];
		expect(found.map((item) => item.id)).toEqual(["1001", "1004", "1006"]);
		expect(found[0]?.reactions).toEqual([{ type: "heart", count: 1 }]);
		expect(JSON.stringify(listed.result)).not.toContain(SECRET);
		expect(await ids(run, "teams_list_channels", {})).toEqual([GENERAL, PRIVATE, SHARED]);
		const page = await teamsConnector().discover(graph.client(), "channel", { query: null, cursor: null });
		expect(page.items.map((item) => item.id)).toEqual([ENG, GENERAL, PRIVATE, SHARED, FIN, BUDGET]);
	});

	test("test_text_hides_channels_teams_links_and_quotes", () => {
		const found = mentions(
			[0, { user: { id: "u", displayName: "Ada" } }],
			[1, { conversation: { id: "19:x@thread.tacv2", displayName: SECRET } }],
			[2, { tag: { id: "t", displayName: "Oncall" } }],
		);
		const content =
			`<div><p>Hi <at id="0">Ada</at> and <at id="2">Oncall</at>, see <at id="1">${SECRET}</at>.</p>` +
			`<p><a href="https://teams.microsoft.com/l/channel/19%3ax/${SECRET}">${SECRET}</a> ` +
			`<a href="https://teams%2Emicrosoft.com/x">${SECRET}</a> <a href="https://example.com/a">docs</a> ` +
			'<a href="https://example.com/b">https://example.com/b</a></p>' +
			'<blockquote itemtype="http://schema.skype.com/Reply" itemid="1101"><strong>Bob</strong>' +
			`<blockquote>${SECRET}</blockquote></blockquote>` +
			'<ul><li>one</li><li>two&nbsp;&amp; three</li></ul><img src="x"> <emoji alt="\u{1F600}">:)</emoji>' +
			`<attachment id="a1">${SECRET}</attachment><script>${SECRET}</script>` +
			"<p>a<br>b</p><p>&lt;b&gt;</p></div>";
		expect(read(content, "html", found)).toBe(
			"Hi @Ada and @Oncall, see @[channel].\n" +
				"[Teams link] [Teams link] docs (https://example.com/a) https://example.com/b\n" +
				"[quoted message]\n" +
				"- one\n" +
				"- two & three\n" +
				"[image] \u{1F600}\n" +
				"a\nb\n" +
				"<b>",
		);
		expect(read("  plain <b>text</b> ", "text", [])).toBe("plain <b>text</b>");
		expect(read(null, "html", [])).toBe("");
	});

	test("test_hidden_elements_hide_what_they_nest_and_what_is_never_closed", () => {
		const nested = `<a href="https://teams.microsoft.com/x"><a href="https://example.com">${SECRET}</a>${SECRET}</a> after`;
		expect(read(nested, "html", [])).toBe("[Teams link] after");
		expect(read(`before <at id="9">${SECRET}`, "html", [])).toBe("before @[channel]");
		expect(read(`<at id="0">x</at><at id="0"><at>${SECRET}</at></at>`, "html", mentions([0, {}]))).toBe("@[channel]@[channel]");
		expect(read(`start <blockquote itemid="5">${SECRET}<p>${SECRET}`, "html", [])).toBe("start\n[quoted message]");
		expect(read('<a href="https://example.com">open', "html", [])).toBe("open");
	});

	test("test_text_hides_repeated_attributes_plain_quotes_and_bare_teams_addresses", () => {
		const shown = mentions([0, { user: { id: "u", displayName: "Ada" } }]);
		// Readers disagree on which of two values counts, so neither does.
		expect(read(`<at id="0" id="1">${SECRET}</at>`, "html", shown)).toBe("@[channel]");
		const twice = `<a href="https://example.com" href="https://teams.microsoft.com/x">${SECRET}</a>`;
		expect(read(twice, "html", [])).toBe("[Teams link]");
		expect(read(`<p>said</p><blockquote>${SECRET}</blockquote>`, "html", [])).toBe("said\n[quoted message]");
		// A mention id the list also gives to a channel is a channel's.
		const both = mentions([0, { user: { id: "u" } }], [0, { conversation: { id: "19:x@thread.tacv2" } }]);
		expect(read(`<at id="0">${SECRET}</at>`, "html", both)).toBe("@[channel]");
		// Browsers read these as open elements.
		for (const opened of ["<blockquote/>", '<at id="9"/>', '<a href="https://teams.microsoft.com/x"/>', "<script/>"]) {
			expect(read(`${opened}${SECRET}</x> after`, "html", shown)).not.toContain(SECRET);
		}
		expect(read('a <emoji alt="\u{1F600}"/> b<br/>c', "html", [])).toBe("a \u{1F600} b\nc");
		// Browsers drop tabs and newlines inside addresses.
		for (const href of ["https://teams.micro&#10;soft.com/l/x", "ms&#9;teams:/l/x", "https://teams%2Emicro%0Dsoft.com/x"]) {
			expect(read(`<a href="${href}">${SECRET}</a>`, "html", [])).toBe("[Teams link]");
		}
		for (const address of [
			"https://teams.microsoft.com/l/channel/x",
			"teams%2Emicrosoft%2Ecom/x",
			"https://teams.microsoftonline.cn/l/x",
			"https://dod.teams.microsoft.us/l/x",
			"msteams://x",
			// U+FEFF is whitespace to JavaScript but invisible, so it does not split an address into harmless words.
			"https://te\ufeffams.microsoft.com/l/x",
		]) {
			expect(read(`<p>see ${address}, ok</p>`, "html", [])).toBe("see [Teams link] ok");
			expect(read(`see ${address}`, "text", [])).toBe("see [Teams link]");
		}
	});
});

describe("writing", () => {
	test("test_posts_are_escaped_and_never_mention_or_link_to_teams", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] });
		const outcome = await items(run, "teams_post_message", { team_id: ENG, channel_id: GENERAL, text: '<at id="0">x</at> & <b>bold</b>\nnext' });
		expect(outcome).toEqual([
			{
				written: true,
				id: "5001",
				team_id: ENG,
				channel_id: GENERAL,
				reply_to_id: null,
				created_time: "2026-10-01T09:00:00Z",
				link: "https://teams.microsoft.com/l/message/5001",
			},
		]);
		expect(graph.writes).toEqual([
			[
				`/teams/${ENG}/channels/${GENERAL}/messages`,
				{ body: { contentType: "html", content: "&lt;at id=&quot;0&quot;&gt;x&lt;/at&gt; &amp; &lt;b&gt;bold&lt;/b&gt;<br>next" } },
			],
		]);
		for (const text of ["see https://teams.microsoft.com/l/channel/x", "see https%3A%2F%2Fteams%2Emicrosoft%2Ecom/x", "open msteams://x", "TEAMS.LIVE.COM/x", "bell \x07"]) {
			expect(await run.code("teams_post_message", { team_id: ENG, channel_id: GENERAL, text })).toBe("INVALID_ARGUMENTS");
		}
		expect(graph.writes).toHaveLength(1);
	});

	test("test_replies_go_only_to_live_thread_roots_in_the_channel", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "reply"] });
		const args = { team_id: ENG, channel_id: GENERAL, message_id: "1001", text: "thanks" };
		const outcome = await items(run, "teams_reply", args);
		expect(outcome[0]?.reply_to_id).toBe("1001");
		expect(graph.writes).toEqual([[`/teams/${ENG}/channels/${GENERAL}/messages/1001/replies`, { body: { contentType: "html", content: "thanks" } }]]);
		// A reply, a deleted message, an event, a message of another channel, and an unknown id.
		for (const messageId of ["1101", "1004", "1002", "4001", "123"]) {
			expect(await run.code("teams_reply", { ...args, message_id: messageId, text: `to ${messageId}` })).toBe("INVALID_ARGUMENTS");
		}
		// Replying does not allow posting: the tool is not offered.
		expect(await run.code("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "new" })).toBe("UNKNOWN_OPERATION");
		expect(graph.writes).toHaveLength(1);
	});

	test("test_tools_are_offered_with_their_consent", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] }, { scopes: ["ChannelMessage.Send", "User.Read"] });
		// Reading and replying need ChannelMessage.Read.All; listing and posting do not.
		expect(new Set(run.tools.filter((tool) => tool.startsWith("teams_")))).toEqual(new Set(["teams_list_teams", "teams_list_channels", "teams_post_message"]));
		await run.ok("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "hello" });
		expect(graph.writes).toHaveLength(1);
	});

	test("test_shared_and_unknown_channels_are_not_written_to", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] });
		expect(await run.code("teams_post_message", { team_id: ENG, channel_id: SHARED, text: "hello" })).toBe("EXTERNAL_CHANNEL");
		const general = graph.channels[ENG]?.[0] as JsonObject;
		general.membershipType = "unknownFutureValue";
		expect(await run.code("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "hello" })).toBe("EXTERNAL_CHANNEL");
		delete general.membershipType;
		expect(await run.code("teams_reply", { team_id: ENG, channel_id: GENERAL, message_id: "1001", text: "hi" })).toBe("EXTERNAL_CHANNEL");
		expect(graph.writes).toEqual([]);
	});

	test("test_channels_are_checked_again_just_before_writing", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] });
		let listings = 0;
		const change = (update: () => void): Hook => (method, path) => {
			if (method === "GET" && path.toLowerCase() === `/teams/${ENG}/channels`) {
				listings += 1;
				// The first listing authorizes the call; the second is the check before the write.
				if (listings % 2 === 0) update();
			}
			return null;
		};
		const general = graph.channels[ENG]?.[0] as JsonObject;
		graph.hook = change(() => {
			general.membershipType = "shared";
		});
		expect(await run.code("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "hello" })).toBe("EXTERNAL_CHANNEL");
		general.membershipType = "standard";
		graph.hook = change(() => {
			graph.channels[ENG] = (graph.channels[ENG] as JsonObject[]).slice(1);
		});
		expect(await run.code("teams_reply", { team_id: ENG, channel_id: GENERAL, message_id: "1001", text: "hi" })).toBe("CHANNEL_MOVED");
		expect(graph.writes).toEqual([]);
	});

	test("test_a_channel_denied_read_is_not_written_to", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] }, { ceiling: [ceilingRow("channel", GENERAL, "deny", ["read"])] });
		expect(await ids(run, "teams_list_channels", {})).toEqual([PRIVATE, SHARED]);
		// Posting and replying require read on the same channel.
		const args = { team_id: ENG, channel_id: GENERAL, text: "hello" };
		expect(await run.code("teams_post_message", args)).toBe("POLICY_DENIED");
		expect(await run.code("teams_reply", { ...args, message_id: "1001" })).toBe("POLICY_DENIED");
		expect(graph.writes).toEqual([]);
	});

	test("test_a_post_graph_places_elsewhere_counts_without_a_result", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post"] });
		graph.hook = (method, path) => {
			if (method !== "POST") return null;
			graph.writes.push([path, {}]);
			return jsonResponse(201, message("5001", BUDGET, "x", FIN));
		};
		const outcome = await run.ok("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "a" });
		expect(outcome.result.outcome).toBe("applied_without_result");
		expect(outcome.result.items).toEqual([]);
		expect(graph.writes).toHaveLength(1);
	});
});
