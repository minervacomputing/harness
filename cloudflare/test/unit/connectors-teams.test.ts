// The Microsoft Teams connector against an in-memory Microsoft Graph behind an injected `fetch`, and runs through
// the executor; how message text is read and what agents may write. The OAuth flow itself (the authorize URL, the
// token exchange) belongs to the Worker; the scopes a connector asks for and the consent it needs are tested here.

import { afterEach, describe, expect, test } from "vitest";
import { LIMITS as CLIENT_LIMITS, Mention, nextCursor, pageParams } from "../../src/connectors/teams/client.ts";
import { LIMITS, teamsConnector } from "../../src/connectors/teams/connector.ts";
import { TEAMS, checkWritten, read, redact, toTeams, written } from "../../src/connectors/teams/html.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { TextError } from "../../src/lib/text.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { type Received, received } from "../fixtures/connectors/microsoft/fake.ts";
import { ceilingRow, startRun, validated } from "./connector-runs.ts";
import { jsonResponse } from "./executor-fakes.ts";

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
 * Microsoft Graph's Teams API. Engineering hosts General, Private (private) and Shared
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
	test("only work and school accounts connect", async () => {
		const graph = new FakeGraph();
		const connector = teamsConnector();
		const account = await connector.account(graph.client());
		expect([account.id, account.label]).toEqual([USER_ID, "me@contoso.com"]);
		graph.user.id = "abcdef0123456789";
		await expect(connector.account(graph.client())).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT" });
	});

	test("discovery lists whole teams and names only canonical ids", async () => {
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

	test("channel listings follow Teams' page tokens up to a cap", async () => {
		const graph = new FakeGraph();
		graph.pageSize = 2;
		const page = await teamsConnector().discover(graph.client(), "channel", { query: null, cursor: null });
		expect(page.items.map((item) => item.id)).toContain(SHARED);
		expect(graph.reads(`/teams/${ENG}/channels`).map((request) => request.params.$skiptoken)).toEqual([undefined, `${TOKEN}2`]);
		CLIENT_LIMITS.maxPages = 1;
		await expect(teamsConnector().discover(graph.client(), "channel", { query: null, cursor: null })).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
	});

	test("cursors are checked", () => {
		expect(pageParams(`t:${TOKEN}`)).toEqual({ $skiptoken: TOKEN });
		for (const cursor of ["token:abc", "t:", "t:a b", `t:${"a".repeat(991)}`, "t:\u00e9"]) {
			expect(() => pageParams(cursor), cursor).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		}
		expect(nextCursor(null)).toBeNull();
		for (const link of ["https://graph.microsoft.com/v1.0/x?$skip=2", "https://x/?$skiptoken=a%20b"]) {
			expect(() => nextCursor(link)).toThrow(expect.objectContaining({ code: "PROVIDER_LIMIT" }));
		}
	});

	test("scopes follow the allowed actions", () => {
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
	test("a team grant covers its channels", async () => {
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

	test("a channel is reached only through the team hosting it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read"] });
		// Graph would answer for a channel under any team; Minerva asks only teams that host it.
		expect(await run.code("teams_read_channel", { team_id: FIN, channel_id: GENERAL })).toBe("POLICY_DENIED");
		expect(graph.reads("/messages")).toEqual([]);
	});

	test("denies hold inside an allowed team and under any case", async () => {
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

	test("messages leave out events, strays and deleted text", async () => {
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

	test("channel pages are run bound", async () => {
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

	test("threads start with their root and keep only its replies", async () => {
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

	test("text hides channels, Teams links and quotes", () => {
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

	test("hidden elements hide what they nest and what is never closed", () => {
		const nested = `<a href="https://teams.microsoft.com/x"><a href="https://example.com">${SECRET}</a>${SECRET}</a> after`;
		expect(read(nested, "html", [])).toBe("[Teams link] after");
		expect(read(`before <at id="9">${SECRET}`, "html", [])).toBe("before @[channel]");
		expect(read(`<at id="0">x</at><at id="0"><at>${SECRET}</at></at>`, "html", mentions([0, {}]))).toBe("@[channel]@[channel]");
		expect(read(`start <blockquote itemid="5">${SECRET}<p>${SECRET}`, "html", [])).toBe("start\n[quoted message]");
		expect(read('<a href="https://example.com">open', "html", [])).toBe("open");
	});

	test("text hides repeated attributes, plain quotes and bare Teams addresses", () => {
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

	test("malformed markup hides more, never less (adversarial)", () => {
		const shown = mentions([0, { user: { id: "u", displayName: "Ada" } }], [9, { conversation: { id: "19:x@thread.tacv2" } }]);
		const hidden = (html: string) => expect(read(html, "html", shown), html).not.toContain("SECRET");
		// Unclosed, self-closing, nested and uppercase elements.
		for (const html of [
			`<at id="9">${SECRET}`,
			`<at id="9"/>${SECRET}`,
			`<AT ID="9">${SECRET}</AT>`,
			`<At id="0" ID="9">${SECRET}</at>`,
			`<at id="9"><at id="0">x</at>${SECRET}</at>`,
			`<a href="https://teams.microsoft.com/l/x"/>${SECRET}`,
			`<A HREF="https://TEAMS.microsoft.com/l/x">${SECRET}</A>`,
			`<a href="https://example.com/"><a href="https://teams.microsoft.com/l/x">${SECRET}</a></a>`,
			`<a href="https://example.com/" HREF="https://teams.microsoft.com/l/${SECRET}">x</a>`,
			`<blockquote/>${SECRET}`,
			`<blockquote><p>${SECRET}</blockquote`,
			`<script>${SECRET}</script`,
			`<script/>${SECRET}</script>`,
			`<at id="9">${SECRET}</at ${SECRET}`,
			`<blockquote>${SECRET}</blockquote ${SECRET}`,
		])
			hidden(html);
		// References in addresses, which browsers decode, and invisible characters inside them.
		for (const href of ["https://&#x74;eams.microsoft.com/l/x", "https&#58;//teams.microsoft.com/l/x", "https://teams.micro&#1;soft.com/x", "https://teams.micro&#xFDD0;soft.com/x"]) {
			expect(read(`<a href="${href}">${SECRET}</a>`, "html", [])).toBe("[Teams link]");
		}
		expect(read("see teams.micro&#1;soft.com/l/x", "html", [])).toBe("see [Teams link]");
		// Comments, CDATA and raw text hold no markup; what browsers might read as markup in raw text is hidden.
		expect(read(`a<!-- <at id="0"> -->b<![CDATA[x]]>c`, "html", shown)).toBe("abc");
		hidden(`<![CDATA[><blockquote>]]>${SECRET}</blockquote>`);
		hidden(`<script><!--<script></script>${SECRET}</script>`);
		// End tags browsers ignore: a blockquote's inside a table, a mention's inside a div.
		expect(read(`<blockquote><table></blockquote>${SECRET}</table></blockquote>after`, "html", shown)).toBe("[quoted message]\nafter");
		hidden(`<at id="9"><div>${SECRET}</at>${SECRET}</div>`);
		hidden(`<blockquote><noscript></blockquote>${SECRET}</noscript>`);
		for (const element of ["textarea", "xmp", "iframe", "noembed", "noframes", "plaintext", "title"]) {
			hidden(`<${element}><at id="9">${SECRET}</at></${element}>`);
		}
		// An end tag with a quote ends the text: browsers read a quoted ">" inside it as part of the tag.
		expect(read(`a</p x="><xmp>"><at id="9">${SECRET}</at>`, "html", shown)).toBe("a");
		expect(read(`a</p x="><a href='"><at id="9">${SECRET}</at>'>x</a>`, "html", shown)).toBe("a");
		// Escaped markup is text, and a tag may span lines.
		expect(read('&lt;at id="9"&gt;x&lt;/at&gt;', "html", shown)).toBe('<at id="9">x</at>');
		expect(read('<at\nid="9"\n>x</at\n>y', "html", shown)).toBe("@[channel]y");
	});
});

describe("writing", () => {
	test("posts are escaped and never mention or link to Teams", async () => {
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

	test("replies go only to live thread roots in the channel", async () => {
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

	test("tools are offered with their consent", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] }, { scopes: ["ChannelMessage.Send", "User.Read"] });
		// Reading and replying need ChannelMessage.Read.All; listing and posting do not.
		expect(new Set(run.tools.filter((tool) => tool.startsWith("teams_")))).toEqual(new Set(["teams_list_teams", "teams_list_channels", "teams_post_message"]));
		await run.ok("teams_post_message", { team_id: ENG, channel_id: GENERAL, text: "hello" });
		expect(graph.writes).toHaveLength(1);
	});

	test("shared and unknown channels are not written to", async () => {
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

	test("channels are checked again just before writing", async () => {
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

	test("a channel denied read is not written to", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [ENG]: ["read", "post", "reply"] }, { ceiling: [ceilingRow("channel", GENERAL, "deny", ["read"])] });
		expect(await ids(run, "teams_list_channels", {})).toEqual([PRIVATE, SHARED]);
		// Posting and replying require read on the same channel.
		const args = { team_id: ENG, channel_id: GENERAL, text: "hello" };
		expect(await run.code("teams_post_message", args)).toBe("POLICY_DENIED");
		expect(await run.code("teams_reply", { ...args, message_id: "1001" })).toBe("POLICY_DENIED");
		expect(graph.writes).toEqual([]);
	});

	test("a post Graph places elsewhere counts without a result", async () => {
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

// Addresses to Teams: a Teams link the agent cannot see behind may show a message or channel it may not read.
const REPLACED: [string, string][] = [
	["teams.microsoft.com", "[Teams link]"],
	["TEAMS.MICROSOFT.COM", "[Teams link]"],
	["Teams.Microsoft.Com", "[Teams link]"],
	["teams.microsoft.us", "[Teams link]"],
	["teams.live.com", "[Teams link]"],
	["teams.cloud.microsoft", "[Teams link]"],
	["teams.microsoftonline.cn", "[Teams link]"],
	["teams.office.com", "[Teams link]"],
	["msteams:", "[Teams link]"],
	["MSTEAMS:", "[Teams link]"],
	["msteams://x", "[Teams link]"],
	["xteams.microsoft.com", "[Teams link]"],
	["teams.microsoft.comx", "[Teams link]"],
	["teams.microsoft.com.evil.example", "[Teams link]"],
	["teams.microsoft\\.com", "[Teams link]"],
	["teams\\.microsoft.com", "[Teams link]"],
	["teams%2Emicrosoft%2Ecom", "[Teams link]"],
	["teams%2emicrosoft%2ecom", "[Teams link]"],
	["teams%252Emicrosoft%252Ecom", "[Teams link]"],
	["teams%25252Emicrosoft%25252Ecom", "[Teams link]"],
	["%74eams.microsoft.com", "[Teams link]"],
	["%54EAMS.microsoft.com", "[Teams link]"],
	["teams.microsoft.%63om", "[Teams link]"],
	["teams.microsoft.c%6fm", "[Teams link]"],
	["msteams%3A", "[Teams link]"],
	["msteams%3a//x", "[Teams link]"],
	["msteams%253A", "[Teams link]"],
	["teams&#46;microsoft&#46;com", "[Teams link]"],
	["teams&#x2E;microsoft&#x2E;com", "[Teams link]"],
	["teams&period;microsoft&period;com", "[Teams link]"],
	["teams&amp;#46;microsoft&amp;#46;com", "[Teams link]"],
	["te&#97;ms.microsoft.com", "[Teams link]"],
	["teams&NewLine;.microsoft.com", "[Teams link]"],
	["teams.microsoft.com&nbsp;x", "[Teams link]"],
	["mste&#97;ms:", "[Teams link]"],
	["&#109;steams:", "[Teams link]"],
	["teams\uff0emicrosoft\uff0ecom", "[Teams link]"],
	["teams\u3002microsoft\u3002com", "[Teams link]"],
	["teams\uff61microsoft\uff61com", "[Teams link]"],
	["teams\uff0emicrosoft.com", "[Teams link]"],
	["\uff54\uff45\uff41\uff4d\uff53.microsoft.com", "[Teams link]"],
	["\u{1d42d}\u{1d41e}\u{1d41a}\u{1d426}\u{1d42c}.microsoft.com", "[Teams link]"],
	["teams.microsoft.\u{1d41c}\u{1d428}\u{1d426}", "[Teams link]"],
	["te\u200bams.microsoft.com", "[Teams link]"],
	["te\u200cams.microsoft.com", "[Teams link]"],
	["te\u200dams.microsoft.com", "[Teams link]"],
	["te\u00adams.microsoft.com", "[Teams link]"],
	["te\u2060ams.microsoft.com", "[Teams link]"],
	["te\ufeffams.microsoft.com", "[Teams link]"],
	["te\u202eams.microsoft.com", "[Teams link]"],
	["te\u{e0041}ams.microsoft.com", "[Teams link]"],
	["te\\ams.microsoft.com", "[Teams link]"],
	["te%09ams.microsoft.com", "[Teams link]"],
	["te%0Aams.microsoft.com", "[Teams link]"],
	["te%0dams.microsoft.com", "[Teams link]"],
	["te&#9;ams.microsoft.com", "[Teams link]"],
	["te&#10;ams.microsoft.com", "[Teams link]"],
	["te&Tab;ams.microsoft.com", "[Teams link]"],
	["te%2509ams.microsoft.com", "[Teams link]"],
	["TEAM\u017f.microsoft.com", "[Teams link]"],
	["teams.m\u0130crosoft.com", "[Teams link]"],
	["teams.m\u0131crosoft.com", "[Teams link]"],
	["teams.mIcrosoft.com", "[Teams link]"],
	["teams.m\uff49crosoft.com", "[Teams link]"],
	["teams.m\u2170crosoft.com", "[Teams link]"],
	["teams.m\u2148crosoft.com", "[Teams link]"],
	["teams.m\u{1d422}crosoft.com", "[Teams link]"],
	["\ufb06eams.microsoft.com", "[Teams link]"],
	["\ufb05eams.microsoft.com", "[Teams link]"],
	["teams.microsoft\u2024com", "[Teams link]"],
	["teams.microsoft\ufe52com", "[Teams link]"],
	["teams.microsoft.c\uff4fm", "[Teams link]"],
	["teams.microsoft.\u24d2om", "[Teams link]"],
	["teams.microsoft.com\uff0f", "[Teams link]"],
	["teams.microsoft.com/l/channel/19%3aabc@thread.tacv2", "[Teams link]"],
	["https://teams.microsoft.com/l/channel/x", "[Teams link]"],
	["https://dod.teams.microsoft.us/l/x", "[Teams link]"],
	["https://teams.microsoftonline.cn/l/x", "[Teams link]"],
	["https://TEAMS.LIVE.COM/x", "[Teams link]"],
	["http://teams.microsoft.com", "[Teams link]"],
	["//teams.microsoft.com", "[Teams link]"],
	["teams.microsoft.com:443/x", "[Teams link]"],
	["user@teams.microsoft.com", "[Teams link]"],
	["https://user:pw@teams.microsoft.com/x", "[Teams link]"],
	["?u=teams.microsoft.com", "[Teams link]"],
	["#teams.microsoft.com", "[Teams link]"],
	["x.y/teams.microsoft.com", "[Teams link]"],
	["msteams:x:y", "[Teams link]"],
	["teamsmsteams:", "[Teams link]"],
	["teams.microsoft.com\u0300", "[Teams link]"],
	["teams.microsoft.com\u200b", "[Teams link]"],
	["\u{1f600}teams.microsoft.com\u{1f600}", "[Teams link]"],
	["see teams.microsoft.com ok", "see [Teams link] ok"],
	["see MSTEAMS: ok", "see [Teams link] ok"],
	["see teams%25252Emicrosoft%25252Ecom ok", "see [Teams link] ok"],
	["see teams.microsoft.com, ok", "see [Teams link] ok"],
	["see MSTEAMS:, ok", "see [Teams link] ok"],
	["see teams%25252Emicrosoft%25252Ecom, ok", "see [Teams link] ok"],
	["see (teams.microsoft.com) ok", "see [Teams link] ok"],
	["see (MSTEAMS:) ok", "see [Teams link] ok"],
	["see (teams%25252Emicrosoft%25252Ecom) ok", "see [Teams link] ok"],
	["xMSTEAMS:", "[Teams link]"],
	["xteams%25252Emicrosoft%25252Ecom", "[Teams link]"],
	["MSTEAMS:x", "[Teams link]"],
	["teams%25252Emicrosoft%25252Ecomx", "[Teams link]"],
	["a teams.microsoft.com b teams.microsoft.com c", "a [Teams link] b [Teams link] c"],
	["a MSTEAMS: b MSTEAMS: c", "a [Teams link] b [Teams link] c"],
	["a teams%25252Emicrosoft%25252Ecom b teams%25252Emicrosoft%25252Ecom c", "a [Teams link] b [Teams link] c"],
	["line one\nteams.microsoft.com\nline three", "line one\n[Teams link]\nline three"],
	["line one\nMSTEAMS:\nline three", "line one\n[Teams link]\nline three"],
	["line one\nteams%25252Emicrosoft%25252Ecom\nline three", "line one\n[Teams link]\nline three"],
	["teams.microsoft.com\tteams.microsoft.com", "[Teams link]\t[Teams link]"],
	["MSTEAMS:\tMSTEAMS:", "[Teams link]\t[Teams link]"],
	["teams%25252Emicrosoft%25252Ecom\tteams%25252Emicrosoft%25252Ecom", "[Teams link]\t[Teams link]"],
	["a\u00a0teams.microsoft.com\u00a0b", "a\u00a0[Teams link]\u00a0b"],
	["a\u00a0MSTEAMS:\u00a0b", "a\u00a0[Teams link]\u00a0b"],
	["a\u00a0teams%25252Emicrosoft%25252Ecom\u00a0b", "a\u00a0[Teams link]\u00a0b"],
	["  teams.microsoft.com  ", "  [Teams link]  "],
	["  MSTEAMS:  ", "  [Teams link]  "],
	["  teams%25252Emicrosoft%25252Ecom  ", "  [Teams link]  "],
	["a teams.microsoft.com\r\nb", "a [Teams link]\r\nb"],
	["a MSTEAMS:\r\nb", "a [Teams link]\r\nb"],
	["a teams%25252Emicrosoft%25252Ecom\r\nb", "a [Teams link]\r\nb"],
	["a  teams.microsoft.com  b", "a  [Teams link]  b"],
	["a  MSTEAMS:  b", "a  [Teams link]  b"],
	["a  teams%25252Emicrosoft%25252Ecom  b", "a  [Teams link]  b"],
	["(a)teams.microsoft.com(b)", "[Teams link]"],
	["(a)MSTEAMS:(b)", "[Teams link]"],
	["(a)teams%25252Emicrosoft%25252Ecom(b)", "[Teams link]"],
	["a\u2003teams.microsoft.com\u2003b", "a\u2003[Teams link]\u2003b"],
	["a\u2003MSTEAMS:\u2003b", "a\u2003[Teams link]\u2003b"],
	["a\u2003teams%25252Emicrosoft%25252Ecom\u2003b", "a\u2003[Teams link]\u2003b"],
	["see teams.microsoft.com and plain words and msteams: here", "see [Teams link] and plain words and [Teams link] here"],
	["\ufeff teams.microsoft.com", "\ufeff [Teams link]"],
	["x\u200bteams.microsoft.com", "[Teams link]"],
	["word\u200bword teams.microsoft.com", "word\u200bword [Teams link]"],
	["line one\nteams.m\uff49croso\u200bft.com\nline three", "line one\n[Teams link]\nline three"],
	["http s://dod.teams.microsoft.us/l/x\thttp s://dod.teams.microsoft.us/l/x", "http [Teams link]\thttp [Teams link]"],
	["line one\nmsteams:/\u00ad/x\nline three", "line one\n[Teams link]\nline three"],
	["see \u00adteams%252Emicrosoft%252Ecom, ok", "see [Teams link] ok"],
	["(a)teams.microsoft.com/l/channe\tl/19%3aabc@thread.tacv2(b)", "[Teams link]\tl/19%3aabc@thread.tacv2(b)"],
	["xT&#10;eams.Microsoft.Com", "[Teams link]"],
	["a teams\uff61\u200bmicrosoft\uff61com\r\nb", "a [Teams link]\r\nb"],
	["see teams\uff0emi\u00adcrosoft.com ok", "see [Teams link] ok"],
	["https\uff0e://TEAMS.LIVE.COM/xx", "[Teams link]"],
	["see (te\u00adams.micros\u200boft.com) ok", "see [Teams link] ok"],
	["a te\u00ad\u{e0041}ams.microsoft.com b te\u00ad\u{e0041}ams.microsoft.com c", "a [Teams link] b [Teams link] c"],
	["&#10;teams.m\u2170crosoft.com\t&#10;teams.m\u2170crosoft.com", "[Teams link]\t[Teams link]"],
	["see teams.microsoft.c\\om:443/x, ok", "see [Teams link] ok"],
	["a \nmsteams%253A b \nmsteams%253A c", "a \n[Teams link] b \n[Teams link] c"],
	["a\u00a0&#10;te\u00adams.microsoft.com\u00a0b", "a\u00a0[Teams link]\u00a0b"],
	["line one\nteams.microsoftonline.\u00adcn\nline three", "line one\n[Teams link]\nline three"],
	["a\u2003teams%2Emi\u200bcrosoft%2Ecom\u2003b", "a\u2003[Teams link]\u2003b"],
	["a\u2003teams&#46;micros\\oft&#46;com\u2003b", "a\u2003[Teams link]\u2003b"],
	["http:/%25/teams.microsoft.com", "[Teams link]"],
	["xte\u{e0041}ams.mi\u00adcrosoft.com", "[Teams link]"],
	["a \uff54\uff45\uff41\uff4d\uff53.microsoft.com%\r\nb", "a [Teams link]\r\nb"],
	["a  teams\u00ad.microsoft.us  b", "a  [Teams link]  b"],
	["teams%252Emicrosof&#10;t%252Ecom", "[Teams link]"],
	["te\ufeff&#10;ams.microsoft.com", "[Teams link]"],
	["user@teams.microsoft.co\u200bm", "[Teams link]"],
];

/** Addresses broken across lines: hidden by nothing, but refused in what agents write. */
const SPLIT = [
	"te\tams.microsoft.com",
	"te\nams.microsoft.com",
	"te\rams.microsoft.com",
	"te\r\nams.microsoft.com",
	"teams.m\uff49cros\noft.comx",
	"a\u00a0te\ram\ns.microsoft.com\u00a0b",
	"a \ufb06eams.\nmicrosoft.com\r\nb",
	"see xteams.micro\rsoft.com ok",
	"a  x.y/teams.micro\nsoft.com  b",
	"TEAMS.M\nICROSOFT.COMx",
	"line one\nte\u2060ams.mic\trosoft.com\nline three",
	"a\u2003team\ts.live.com\u2003b",
	"te&#9;ams.micr\nosoft.com\tte&#9;ams.micr\nosoft.com",
	"a %54EAMS\r.microsoft.com\r\nb",
];

/** Text that is no address to Teams. */
const KEPT = [
	"teams.microsoft.org",
	"teams.microsoftonline.com",
	"teams.microsoft",
	"teams.microsof",
	"eams.microsoft.com",
	"teams microsoft com",
	"teams-microsoft.com",
	"teams_microsoft.com",
	"teamsXmicrosoft.com",
	"msteams",
	"msteams;",
	"ms-teams:",
	"msteam:",
	"teams%2525252Emicrosoft%2525252Ecom",
	"te\u00a0ams.microsoft.com",
	"te\u2028ams.microsoft.com",
	"te ams.microsoft.com",
	"te%0009ams.microsoft.com",
	"\u212aams.microsoft.com",
	"teams.\u212aicrosoft.com",
	"teams.mi\u212arosoft.com",
	"\u017feams.microsoft.com",
	"te\ufb06.microsoft.com",
	"teams.microsoft\u2025com",
	"teams.micro\ufb06.com",
	"\u212b",
	"\u2126",
	"mi\u{1d4e2}rosoft",
	"teams.microsoft.\u33c7m",
	"example.com",
	"https://example.com/a?b=c",
	"plain",
	"",
	" ",
	"see",
	"ms",
	"teams",
	"microsoft",
	"com",
	".",
	":",
	"t.e.a.m.s",
	"caf\u00e9",
	"%",
	"%%",
	"%2",
	"%2E",
	"%zz",
	"%e0%a4%a",
	"%ff%fe",
	"&",
	"&#",
	"&#x;",
	"&#9999999999;",
	"&bogus;",
	"&amp",
	"&amp;amp;amp;amp;",
	"%2525252525252E",
	"see teams_microsoft.com ok",
	"see ms-teams: ok",
	"see teams_microsoft.com, ok",
	"see ms-teams:, ok",
	"see (teams_microsoft.com) ok",
	"see (ms-teams:) ok",
	"xteams_microsoft.com",
	"xms-teams:",
	"teams_microsoft.comx",
	"ms-teams:x",
	"a teams_microsoft.com b teams_microsoft.com c",
	"a ms-teams: b ms-teams: c",
	"line one\nteams_microsoft.com\nline three",
	"line one\nms-teams:\nline three",
	"teams_microsoft.com\tteams_microsoft.com",
	"ms-teams:\tms-teams:",
	"a\u00a0teams_microsoft.com\u00a0b",
	"a\u00a0ms-teams:\u00a0b",
	"  teams_microsoft.com  ",
	"  ms-teams:  ",
	"a teams_microsoft.com\r\nb",
	"a ms-teams:\r\nb",
	"a  teams_microsoft.com  b",
	"a  ms-teams:  b",
	"(a)teams_microsoft.com(b)",
	"(a)ms-teams:(b)",
	"a\u2003teams_microsoft.com\u2003b",
	"a\u2003ms-teams:\u2003b",
	"\u180e x",
	"a\u180eb",
	"a\u1680b",
	"a\u205fb",
	"a\u3000b",
	"a\u202fb",
	"a\u200ab",
	"a\u2007b",
	"a\u00a0b",
	"a\u00a0te ams.m\ticrosoft.com\u00a0b",
	"line one\n&;#109;steams:\nline three",
	"  #teams.microsof#t.com  ",
	"tea%25ms.mIcrosoft.com\ttea%25ms.mIcrosoft.com",
	"xteams.microsof\uff0et.comx",
	"see (%25ms) ok",
	"te\u00a0ams#.microsoft.comx",
	"tea\u00adms microsoft comx",
	"a\u2003 \n\u2003b",
	"(a)ms-teams\t:(b)",
	"microsof&tx",
	"teamsXmicroso\rft.com\tteamsXmicroso\rft.com",
	" teams.micro\ufb06.com\t teams.micro\ufb06.com",
	"a\u2003teamxs.microsoft\u2024com\u2003b",
	"see example.co%0am, ok",
	"a t%eams.mIcrosoft.com\r\nb",
	"a teams.mIcrosoft.#com\r\nb",
	"a\u00a0te%0Aams.microsoft.co;m\u00a0b",
	"xteamsXmicro%0asoft.com",
	"MSTEA%MS:",
	"line one\nte%&0dams.microsoft.com\nline three",
	"a  Teams.%Microsoft.Com  b",
	"xs\uff0eee",
	"see  &#10;, ok",
	"see teams.micros\uff0eoft.org ok",
	"(a)te\r%\nams.microsoft.com(b)",
	"teams.m\u0131cxrosoft.com",
	"a Teams.Microsoft.Co%m b Teams.Microsoft.Co%m c",
	"x\ufb06eams.microsoft.cxom",
	"see teams.clo&ud.microsoft ok",
	"a team%25s.microsoft.com/l/channel/19%3aabc@thread.tacv2\r\nb",
	"mi\u{1d4e2}roso\\ftx",
	"see (t eams.mIcrosoft.com) ok",
	"xte#\rams.microsoft.com",
	"(a)teams &#x2E;microsoft&#x2E;com(b)",
	"(a)teams%25(b)",
	"a  https://user:pw@teams.microsoft.c\uff0eom/x  b",
	"xcom&#10;",
	"line one\nte\u200dam.s.microsoft.com\nline three",
	"see (tex\u00a0ams.microsoft.com) ok",
	"a te\u2060am;s.microsoft.com b te\u2060am;s.microsoft.com c",
	"(a)Teams.Micr.osoft.Com(b)",
	"see (teams&period;microsof&t&period;com) ok",
	"see teams&%#46;microsoft&#46;com ok",
	"see te\u2028ams.micr\\osoft.com ok",
	"see https://teams.microsoft.co.m/l/channel/x ok",
	"a teams%2&#10;Emicrosoft%2Ecom\r\nb",
	"see msteams%25.3A ok",
	"line one\nteams.m#icrosoft.%63om\nline three",
	"m%icrosoft",
	"  c\\om  ",
	"a teams microsoft com\u200b\r\nb",
	"a teams.mx\u{1d422}crosoft.com b teams.mx\u{1d422}crosoft.com c",
	"a te%ams.microsoft.com&nbsp;x\r\nb",
	"see msteams\u00ad, ok",
	"a  tea#ms  b",
	"a\u00a0ht#tps://example.com/a?b=c\u00a0b",
	"see (teams.%25microsoft.\u33c7m) ok",
	"see (te%0xAams.microsoft.com) ok",
	"line one\nteams&#46;m icrosoft&#46;com\nline three",
	"line one\nteams.m%icrosoft\nline three",
	"  \u212b   ",
	"a teams.micro%25softonline.cn\r\nb",
	"xmi\u200b\u{1d4e2}rosoft",
	"tea&ms.m\uff49crosoft.comx",
];

/** Control characters other than tab and line breaks, which checkWritten refuses first. */
const CONTROLS = /[\0-\x08\v\f\x0e-\x1f\x7f]/;

describe("addresses to Teams", () => {
	test("are replaced in any spelling browsers, Teams or decoders read as one", () => {
		expect(REPLACED.filter(([text, shown]) => redact(text) !== shown || !toTeams(text))).toEqual([]);
		// Long text around them, and many of them.
		const address = "teams.microsoft.com";
		for (const text of [address.repeat(100), `${"x".repeat(10_000)}${address}`, `${address}${"x".repeat(10_000)}`]) expect(redact(text)).toBe("[Teams link]");
	});

	test("broken across lines, count as addresses but are left as they are", () => {
		expect(SPLIT.filter((text) => redact(text) !== text || !toTeams(text))).toEqual([]);
	});

	test("other text is left alone", () => {
		expect(KEPT.filter((text) => redact(text) !== text || toTeams(text))).toEqual([]);
		expect(redact("%25".repeat(2000))).toBe("%25".repeat(2000));
	});

	test("each letter of an address matches itself in either case, ſ for s (Unicode folds it), and İ and ı for i (which readers may take for it)", () => {
		const extra: { [letter: string]: number[] } = { i: [0x130, 0x131], s: [0x17f] };
		const wrong: string[] = [];
		for (const address of ["msteams:", "teams.cloud.microsoft", "teams.live.com", "teams.microsoft.com", "teams.microsoftonline.cn", "teams.office.com"]) {
			for (let at = 0; at < address.length; at++) {
				const letter = address.charAt(at);
				const expected = new Set([letter.toLowerCase(), letter.toUpperCase()].map((char) => char.codePointAt(0) as number).concat(extra[letter] ?? []));
				for (let point = 0; point < 0x30000; point++) {
					if (point >= 0xd800 && point <= 0xdfff) continue;
					const matched = TEAMS.test(address.slice(0, at) + String.fromCodePoint(point) + address.slice(at + 1));
					if (matched !== expected.has(point)) wrong.push(`${address}[${at}] U+${point.toString(16)}`);
				}
			}
		}
		expect(wrong).toEqual([]);
	});
});

describe("text agents write", () => {
	const LINK = "must not link to Teams: Teams may show the linked message or channel, which may be one you may not read";
	const CONTROL = "must not contain control characters other than tabs and newlines";
	const checked = (text: string) => {
		try {
			return checkWritten(text);
		} catch (error) {
			if (error instanceof TextError) return error.message;
			throw error;
		}
	};

	test("refuses every address to Teams, split ones included, and control characters other than tabs and line breaks", () => {
		const addresses = [...REPLACED.map(([text]) => text), ...SPLIT].filter((text) => !CONTROLS.test(text));
		expect(addresses.filter((text) => checked(text) !== LINK)).toEqual([]);
		for (const text of ["\0", "\x01", "\x07", "\b", "\v", "\f", "\x0e", "\x1f", "\x7f", "bell \x07", "teams.microsoft.com\x07"]) expect(checked(text), JSON.stringify(text)).toBe(CONTROL);
	});

	test("accepts the rest as it is", () => {
		const accepted = [
			...KEPT.filter((text) => !CONTROLS.test(text)),
			"",
			"a & b",
			'<at id="0">x</at>',
			"'single' \"double\"",
			"line one\r\nline two\rthree\n",
			"tab\tchar",
			"\u0080\u0085 ​ \u{1f600}",
			"&amp;&lt;&#65;",
			"te ams.microsoft.com",
			"x".repeat(4001),
		];
		expect(accepted.filter((text) => checked(text) !== text)).toEqual([]);
	});

	test("is sent as HTML: escaped, with line breaks as <br>", () => {
		const cases: [string, string][] = [
			["a & b", "a &amp; b"],
			['<at id="0">x</at>', "&lt;at id=&quot;0&quot;&gt;x&lt;/at&gt;"],
			["'single' \"double\"", "&#x27;single&#x27; &quot;double&quot;"],
			["line one\nline two", "line one<br>line two"],
			["a\r\n\r\nb", "a<br><br>b"],
			["a\rb\tc", "a\rb\tc"],
			["&amp; &#65; &", "&amp;amp; &amp;#65; &amp;"],
			["t\te\na\rm\ts.microsoft.com", "t\te<br>a\rm\ts.microsoft.com"],
			["<".repeat(4000), "&lt;".repeat(4000)],
			["café \u{1f600}", "café \u{1f600}"],
		];
		expect(cases.map(([text]) => [text, written(text)])).toEqual(cases);
	});
});

describe("tool inputs", () => {
	const THREAD = { team_id: ENG, channel_id: GENERAL };

	test("team ids are GUIDs, read in lower case", async () => {
		for (const team_id of [ENG, ENG.toUpperCase(), ` ${ENG} `, `${ENG}\n`]) {
			expect(await validated(teamsConnector(), "list_channels", { team_id })).toEqual({ ok: { team_id: ENG } });
		}
		expect(await validated(teamsConnector(), "list_channels", {})).toEqual({ ok: { team_id: null } });
		expect(await validated(teamsConnector(), "list_channels", { team_id: "AAAAAAAA-0000-0000-0000-00000000000A" })).toEqual({ ok: { team_id: "aaaaaaaa-0000-0000-0000-00000000000a" } });
		for (const team_id of [
			"",
			"eng",
			ENG.slice(0, -1),
			`${ENG}0`,
			ENG.replaceAll("-", ""),
			"gggggggg-0000-0000-0000-000000000001",
			`${ENG.slice(0, -1)}١`,
			`ａ${ENG.slice(1)}`,
			`K${ENG.slice(1)}`,
			`А${ENG.slice(1).toUpperCase()}`,
			"a".repeat(36),
			"-".repeat(36),
			" ".repeat(36),
			5,
		]) {
			expect(await validated(teamsConnector(), "list_channels", { team_id }), JSON.stringify(team_id)).toEqual({ refused: expect.stringContaining("team_id") });
		}
	});

	test("channel ids are Teams' 19:…@thread ids, as given", async () => {
		for (const channel_id of [GENERAL, "19:GENERAL0001@thread.tacv2", "19:x@thread.tacv2", "19:a@thread.x", "19:a@thread.tacv2x", "19:a.b_c=d+e-f@thread.skype", "19:a@thread.v2"]) {
			expect(await validated(teamsConnector(), "read_channel", { team_id: ENG, channel_id }), channel_id).toEqual({ ok: { team_id: ENG, channel_id, limit: 20, cursor: null } });
		}
		expect(await validated(teamsConnector(), "read_channel", { team_id: ENG, channel_id: ` ${GENERAL}\n` })).toEqual({ ok: { team_id: ENG, channel_id: GENERAL, limit: 20, cursor: null } });
		for (const channel_id of [
			"",
			"bad",
			"General",
			"19:GENERAL0001@THREAD.TACV2",
			"19:@thread.tacv2",
			"19:a@thread.",
			"19:a@thread.TACV2",
			"19:a@thread.tac_v2",
			"19:a b@thread.tacv2",
			"19:aé@thread.tacv2",
			"18:a@thread.tacv2",
			"19:a%40thread.tacv2",
			"19:a@Thread.tacv2",
			"19:a@thread.١",
			null,
			5,
		]) {
			expect(await validated(teamsConnector(), "read_channel", { team_id: ENG, channel_id }), JSON.stringify(channel_id)).toEqual({ refused: expect.stringContaining("channel_id") });
		}
	});

	test("limits, cursors and message ids", async () => {
		const thread = (args: { [key: string]: Json }) => validated(teamsConnector(), "read_thread", { ...THREAD, message_id: "1001", ...args });
		expect(await thread({ limit: 50, cursor: " t:abc " })).toEqual({ ok: { ...THREAD, message_id: "1001", limit: 50, cursor: "t:abc" } });
		expect(await thread({ cursor: `t:${"a".repeat(990)}` })).toEqual({ ok: { ...THREAD, message_id: "1001", limit: 20, cursor: `t:${"a".repeat(990)}` } });
		expect(await thread({ message_id: "1".repeat(20) })).toEqual({ ok: { ...THREAD, message_id: "1".repeat(20), limit: 20, cursor: null } });
		for (const limit of [0, 51, -1, null, "5", 5.5, true, [], {}]) expect(await thread({ limit }), JSON.stringify(limit)).toEqual({ refused: expect.stringContaining("limit") });
		for (const cursor of ["x".repeat(1001), 5, {}]) expect(await thread({ cursor }), JSON.stringify(cursor)).toEqual({ refused: expect.stringContaining("cursor") });
		for (const message_id of ["", " ", "1".repeat(21), "abc", "-1", "+1", "1.5", "1e3", "1 2", "1_0", "1²", "١", "0x10", null, 1001, true]) {
			expect(await thread({ message_id }), JSON.stringify(message_id)).toEqual({ refused: expect.stringContaining("message_id") });
		}
		expect(await thread({ extra: 1 })).toEqual({ refused: expect.stringContaining("extra") });
		expect(await validated(teamsConnector(), "list_teams", [])).toEqual({ refused: expect.stringContaining("input") });
	});

	test("posts are trimmed, at most 4000 UTF-16 units, and checked as written text", async () => {
		const post = (text: Json) => validated(teamsConnector(), "post_message", { ...THREAD, text });
		expect(await post(" hello ")).toEqual({ ok: { ...THREAD, text: "hello" } });
		for (const text of ["a\nb", "a\tb", "a\rb", "<b>x</b>", "x".repeat(4000), "\u{1f600}".repeat(2000)]) expect(await post(text)).toEqual({ ok: { ...THREAD, text } });
		for (const text of ["", " ", "x".repeat(4001), "\u{1f600}".repeat(2001), "a\u0000b", "a\u001bb", "a\vb", "see teams.microsoft.com/x", "msteams://x", 5]) {
			expect(await post(text), JSON.stringify(text).slice(0, 40)).toEqual({ refused: expect.stringContaining("text") });
		}
		expect(await validated(teamsConnector(), "reply", { ...THREAD, message_id: "1001", text: "see TEAMS.LIVE.COM/x" })).toEqual({ refused: expect.stringContaining("must not link to Teams") });
	});
});

describe("bounds", () => {
	test("a link never closed around two hundred thousand pieces of text is shown", () => {
		// Before: the label's pieces were spread into push(), and that many arguments overflow the stack.
		const text = read(`<a href="https://example.com/">${"y<br>".repeat(200_000)}`, "html", []);
		expect(text.startsWith("y\ny\n")).toBe(true);
	});

	test("nested links show each address after its label, in about linear time", () => {
		const H = "https://example.com/";
		expect(read(`<a href=" ${H} ">a<a href="${H}b">  b <b>c</b>  </a>  </a>tail`, "html", [])).toBe(`ab c (${H}b) ( ${H} )tail`);
		expect(read(`<a href="">  </a>q<a href="${H}"> </a>`, "html", [])).toBe(`q${H}`);
		// Before: each closing link joined its whole label again, so the text was copied once per level.
		const depth = 100_000;
		const started = performance.now();
		const text = read(`${`<a href="${H}">`.repeat(depth)}x${"</a>".repeat(depth)}`, "html", []);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(text === `x${` (${H})`.repeat(depth)}`).toBe(true);
	});
});
