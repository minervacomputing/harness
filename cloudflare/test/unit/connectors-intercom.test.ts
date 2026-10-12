// backend/tests/test_intercom.py, case by case: the Intercom connector against an in-memory Intercom API
// (test/fixtures/connectors/intercom/fake.ts) behind the executor's injected `fetch`, with the real executor,
// ledger and page tokens (executor-fakes.ts `Scenario`). The text case and the comparisons with Python's
// vectors are in connectors-intercom-text.test.ts.

import { describe, expect, test } from "vitest";
import { type IntercomClient, MAX_RESPONSE, Conversation as ConversationSchema, classify, cursor } from "../../src/connectors/intercom/client.ts";
import { intercom } from "../../src/connectors/intercom/connector.ts";
import { INBOX } from "../../src/connectors/intercom/inboxes.ts";
import { MAX_MESSAGES, messages } from "../../src/connectors/intercom/reads.ts";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import type { JsonObject } from "../../src/lib/json.ts";
import { type OAuth2, tokenBody, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import {
	ADA,
	ADMIN,
	BILLING,
	FakeIntercom,
	SECRET,
	SUPPORT,
	TOKEN,
	conversation,
	copy,
	error,
	json,
	part,
} from "../fixtures/connectors/intercom/fake.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

const CONNECTION = "0199a000-0000-7000-8000-00000000002a";

/** A run for an agent with the user's Intercom connection, holding `grants` ({inbox: actions}) (test_intercom.py `start`). */
function start(fake: FakeIntercom, grants: { [inbox: string]: string[] }, ceiling: GrantRow[] = []): Promise<Scenario> {
	return Scenario.start({
		connectors: [intercom],
		connections: [{ id: CONNECTION, provider: "intercom", payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: [] } }],
		user: userGrants(CONNECTION, INBOX, grants),
		ceiling,
		fetch: fake.fetch,
	});
}

/** A deny in the workspace ceiling, which stays unrestricted (connector_runs.py `ceiling`). */
function deny(inbox: string, actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: CONNECTION, kind: INBOX, resourceId: inbox, resourceName: "", actions, effect: "deny" };
}

async function items(run: Scenario, tool: string, args: JsonObject): Promise<JsonObject[]> {
	return (await run.ok(tool, args)).result.items;
}

function client(fake: FakeIntercom): IntercomClient {
	return intercom.client("token", settingsIo(fake.fetch));
}

describe("connecting and discovery", () => {
	test("the account is one teammate in one workspace", async () => {
		const fake = new FakeIntercom();
		const account = await intercom.account(client(fake));
		expect([account.id, account.label]).toEqual(["abc123:991", "Ada (ada@example.com) · Acme"]);
		delete fake.me.app;
		await expect(intercom.account(client(fake))).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		fake.me = { id: "x1", app: { id_code: "abc123" } };
		await expect(intercom.account(client(fake))).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		// The other labels: a name or an email alone, neither, and a workspace without a name.
		fake.me = { id: ADMIN, email: "ada@example.com", app: { id_code: "abc123" } };
		expect((await intercom.account(client(fake))).label).toBe("ada@example.com");
		fake.me = { id: ADMIN, name: null, app: { id_code: "abc123", name: "" } };
		expect((await intercom.account(client(fake))).label).toBe("Intercom");
		fake.me = { id: ADMIN, app: { id_code: "" } };
		await expect(intercom.account(client(fake))).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		expect(fake.problems).toEqual([]);
	});

	test("inboxes are the teams and no team", async () => {
		const fake = new FakeIntercom();
		const http = client(fake);
		let page = await intercom.discover(http, INBOX, { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[SUPPORT, "Support"],
			[BILLING, SECRET],
			["none", "No team"],
		]);
		expect(page.nextCursor ?? null).toBeNull();
		page = await intercom.discover(http, INBOX, { query: "sup", cursor: null });
		expect(page.items.map((item) => item.id)).toEqual([SUPPORT]);
		await expect(intercom.discover(http, INBOX, { query: null, cursor: "x" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		const described = await intercom.describe(http, INBOX, [SUPPORT, "none", "3", "01", "x"]);
		expect(described).toEqual({ [SUPPORT]: "Support", none: "No team" });
		expect(await intercom.describe(http, INBOX, ["x"])).toEqual({});
	});

	test("names are matched case-folded, and a team without a name is named by its id", async () => {
		const fake = new FakeIntercom();
		(fake.teams[0] as JsonObject).name = "Straße";
		(fake.teams[1] as JsonObject).name = null;
		const page = await intercom.discover(client(fake), INBOX, { query: "STRASSE", cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([[SUPPORT, "Straße"]]);
		expect(await intercom.describe(client(fake), INBOX, [BILLING])).toEqual({ [BILLING]: "Team 2" });
		// An empty query lists everything.
		expect((await intercom.discover(client(fake), INBOX, { query: "", cursor: null })).items).toHaveLength(3);
	});

	test("ids with a final newline are refused", async () => {
		const fake = new FakeIntercom();
		(fake.teams[1] as JsonObject).id = `${BILLING}\n`;
		const page = await intercom.discover(client(fake), INBOX, { query: null, cursor: null });
		expect(page.items.map((item) => item.id)).toEqual([SUPPORT, "none"]);
	});

	test("more teams than Minerva reads", async () => {
		const fake = new FakeIntercom();
		fake.teams = Array.from({ length: 501 }, (_, n) => ({ id: String(n + 1), name: `T${n}` }));
		await expect(intercom.discover(client(fake), INBOX, { query: null, cursor: null })).rejects.toMatchObject({
			code: "PROVIDER_LIMIT",
			message: "This workspace has more teams than Minerva reads.",
		});
	});

	test("Intercom has no scopes to ask for", async () => {
		const registry = await connectorRegistry();
		const connector = registry.get("intercom");
		const oauth = connector.auth as OAuth2;
		expect([oauth.scopes, oauth.pkce]).toEqual([[], false]);
		expect(connector.operations.every((op) => !op.consent)).toBe(true);
		const all = new Set(["read", "note", "reply"]);
		expect(requestedScopes(connector, all)).toEqual([]);
		expect(consentNeeded(connector, [], all)).toEqual([]);
		// The endpoints, and the client in the body of a form, as the default `post`.
		expect([oauth.app, oauth.authorizeUrl, oauth.tokenUrl]).toEqual(["intercom", "https://app.intercom.com/oauth", "https://api.intercom.io/auth/eagle/token"]);
		expect([oauth.clientAuth ?? "post", oauth.jsonBody ?? false, oauth.registrationUrl ?? null, oauth.loginHint ?? false]).toEqual(["post", false, null, false]);
		const exchange = tokenRequest(oauth, { clientId: "id", clientSecret: "secret", redirectUri: "https://minerva.example/api/oauth/intercom/callback" }, [
			["code", "c"],
			["redirect_uri", "https://minerva.example/api/oauth/intercom/callback"],
			["grant_type", "authorization_code"],
		]);
		expect([...new URLSearchParams(exchange.body as string).keys()]).toEqual(["client_id", "client_secret", "code", "redirect_uri", "grant_type"]);
		// Intercom's token answer carries no scopes and no expiry: the scopes are unknown, the token lasts.
		const body = tokenBody(JSON.stringify({ token_type: "Bearer", token: "t", access_token: "t" })) as JsonObject;
		expect(tokenPayload(body, Date.UTC(2026, 9, 12))).toEqual({ kind: "oauth2", access_token: "t", refresh_token: null, scopes: null });
		expect([intercom.offered, intercom.manageLink, intercom.children, intercom.browsable]).toEqual([undefined, undefined, undefined, undefined]);
	});

	test("errors are named without Intercom's message", () => {
		const classified = (status: number, content: string) => classify("Intercom", new Response(content, { status }), content);
		const plan = classified(403, '{"type":"error.list","errors":[{"code":"api_plan_restricted","message":"x"}]}');
		expect([plan?.code, plan?.message]).toEqual(["PROVIDER_FORBIDDEN", "This Intercom workspace's plan does not include this."]);
		const other = classified(403, '{"errors":[{"code":"forbidden","message":"SECRET"}]}');
		expect(other?.code).toBe("PROVIDER_FORBIDDEN");
		expect(other?.message).not.toContain("SECRET");
		expect(classified(403, "[1]")?.code).toBe("PROVIDER_FORBIDDEN");
		expect(classified(403, "not json")?.code).toBe("PROVIDER_FORBIDDEN");
		expect(classified(404, "{}")).toBeNull();
	});

	test("cursors are checked", () => {
		expect(cursor(TOKEN)).toBe(TOKEN);
		for (const value of ["", "a b", "é", "a".repeat(901)]) expect(() => cursor(value)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
	});

	test("the registry accepts the declaration; its fingerprints", async () => {
		expect(CONNECTORS).toContain(intercom);
		const registry = await connectorRegistry();
		expect(registry.get("intercom")).toBe(intercom);
		const prints = Object.fromEntries(intercom.operations.map((op) => [op.name, registry.contract("intercom", op.name)]));
		console.log(`intercom fingerprints: ${JSON.stringify(prints)}`);
		expect(Object.values(prints).every((print) => /^[0-9a-f]{16}$/.test(print))).toBe(true);
		expect(new Set(Object.values(prints)).size).toBe(intercom.operations.length);
		// Stable across registries, as across the deploys of one version.
		const again = await Registry.create([intercom]);
		for (const op of intercom.operations) expect(again.contract("intercom", op.name)).toBe(prints[op.name]);
		expect(prints).toEqual(FINGERPRINTS);
	});
});

/** What each operation means today; a change here makes running runs' tools fail with OPERATION_CHANGED. */
const FINGERPRINTS: { [operation: string]: string } = {
	list_inboxes: "f89c46badcadeeb6",
	search_conversations: "f50eefa83a6a818e",
	get_conversation: "034870bbe3c6c7c9",
	add_note: "9dd0683b88f7d80d",
	reply: "d31ec2a5bc7e59c4",
};

describe("reading", () => {
	test("inbox grants decide what is listed and read", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read"], none: ["read"] });
		const outcome = await run.ok("intercom_list_inboxes", {});
		expect(outcome.result.items).toEqual([
			{ id: SUPPORT, name: "Support", teammates: 2 },
			{ id: "none", name: "No team", teammates: null },
		]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		let found: JsonObject[] = [];
		for (const conversationId of ["100", "102", "103"]) {
			found = await items(run, "intercom_get_conversation", { conversation: conversationId });
			expect(found[0]?.id).toBe(conversationId);
		}
		expect(found[0]?.inbox).toBe("none");
		// Another inbox, and conversations the account cannot see, are refused alike.
		for (const conversationId of ["101", "404"]) expect(await run.code("intercom_get_conversation", { conversation: conversationId })).toBe("POLICY_DENIED");
		for (const conversationId of ["0100", "x", "1 OR 1", "1".repeat(21)]) {
			expect(await run.code("intercom_get_conversation", { conversation: conversationId })).toBe("INVALID_ARGUMENTS");
		}
		expect(fake.problems).toEqual([]);
	});

	test("a workspace grant holds denies inside it", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { "*": ["read"] }, [deny(BILLING)]);
		expect((await items(run, "intercom_list_inboxes", {})).map((item) => item.id)).toEqual([SUPPORT, "none"]);
		expect(await run.code("intercom_get_conversation", { conversation: "101" })).toBe("POLICY_DENIED");
		expect(await run.code("intercom_search_conversations", { inbox: BILLING })).toBe("POLICY_DENIED");
	});

	test("a conversation shows its messages without other inboxes", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read"] });
		const outcome = await run.ok("intercom_get_conversation", { conversation: "100" });
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		const [found] = outcome.result.items as JsonObject[];
		const { messages: shown, ...rest } = found as JsonObject;
		expect(rest).toEqual({
			id: "100",
			inbox: SUPPORT,
			title: "Login issue",
			subject: null,
			state: "open",
			priority: "not_priority",
			created: "2026-09-21T14:13:20Z",
			updated: "2026-09-21T15:13:20Z",
			waiting_since: null,
			contact: { name: "Carol", email: "carol@example.com" },
			more_messages: false,
		});
		const list = shown as JsonObject[];
		expect(list.map((message) => [message.id, message.type, (message.author as JsonObject).type, message.text])).toEqual([
			["s100", "first", "user", "Hi, see [Intercom link] and docs (https://example.com/docs)\n[image]"],
			["200", "comment", "user", "Still broken"],
			["202", "note", "admin", "Checking & logs"],
			["203", "comment", "other", "From the team"],
			["205", "comment", "user", "[redacted]"],
			["206", "comment", "bot", "Bot"],
		]);
		expect(list[3]?.author).toEqual({ type: "other", name: null, email: null });
		expect(list[1]?.created).toBe("2026-09-21T14:15:00Z");
		expect(list[5]?.attachments).toEqual(["log.txt"]);
		// One read decides where the conversation is and what is shown.
		expect(fake.reads("/conversations/100")).toHaveLength(1);
	});

	test("long conversations show their latest messages", async () => {
		const fake = new FakeIntercom();
		// test_intercom.py patches MAX_MESSAGES to 2; here the same conversation is shown with that limit.
		const read = ConversationSchema.parse(copy(fake.conversations["100"] as JsonObject));
		const [shown, more] = messages(read, 2);
		expect(shown.map((message) => message.id)).toEqual(["s100", "205", "206"]);
		expect(more).toBe(true);
		// And through a run, with more message parts than are shown.
		const parts = Array.from({ length: MAX_MESSAGES + 3 }, (_, n) => part(String(400 + n), "comment", ADA, `<p>${n}</p>`));
		fake.conversations["104"] = conversation("104", 1, "Long", "<p>first</p>", parts);
		const run = await start(fake, { [SUPPORT]: ["read"] });
		const [long] = await items(run, "intercom_get_conversation", { conversation: "104" });
		const ids = (long?.messages as JsonObject[]).map((message) => message.id);
		expect(ids).toHaveLength(MAX_MESSAGES + 1);
		expect([ids[0], ids[1], ids[ids.length - 1]]).toEqual(["s104", "403", "452"]);
		expect(long?.more_messages).toBe(true);
		// Intercom counts more parts than it sent.
		((fake.conversations["100"] as JsonObject).conversation_parts as JsonObject).total_count = 600;
		const [counted] = await items(run, "intercom_get_conversation", { conversation: "100" });
		expect(counted?.more_messages).toBe(true);
	});

	test("a conversation without its team field is not guessed at", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { "*": ["read"] });
		const refund = fake.conversations["102"] as JsonObject;
		delete refund.team_assignee_id;
		expect(await run.code("intercom_get_conversation", { conversation: "102" })).toBe("PROVIDER_FAILED");
		refund.team_assignee_id = -1;
		expect(await run.code("intercom_get_conversation", { conversation: "102" })).toBe("PROVIDER_FAILED");
		refund.team_assignee_id = 0;
		refund.id = "100";
		expect(await run.code("intercom_get_conversation", { conversation: "102" })).toBe("PROVIDER_FAILED");
	});

	test("a team id beyond what a JavaScript number holds is not guessed at", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { "*": ["read"] });
		// Python would place it in team 12345678901234567890; a number would round it to another team.
		fake.hook = (method, path) =>
			method === "GET" && path === "/conversations/102"
				? new Response(JSON.stringify(fake.conversations["102"]).replace('"team_assignee_id":0', '"team_assignee_id":12345678901234567890'), { status: 200 })
				: null;
		expect(await run.code("intercom_get_conversation", { conversation: "102" })).toBe("PROVIDER_FAILED");
		// A search of such a team sends its id with every digit.
		fake.teams.push({ type: "team", id: "12345678901234567890", name: "Big", admin_ids: [] });
		await run.ok("intercom_search_conversations", { inbox: "12345678901234567890" });
		const sent = fake.requests.filter((request) => request.path === "/conversations/search").pop();
		expect(sent?.text).toContain('{"field":"team_assignee_id","operator":"=","value":12345678901234567890}');
	});

	test("search names one inbox and reads results again", async () => {
		const fake = new FakeIntercom();
		fake.stale = { "101": 1, "999": 1 };
		const run = await start(fake, { [SUPPORT]: ["read"] });
		const args = { inbox: SUPPORT, state: "open", text: 'see "docs" x', updated_after: "2026-09-21T15:13:20+00:00" };
		let outcome = await run.ok("intercom_search_conversations", args);
		expect(outcome.result.items.map((item) => item.id)).toEqual(["100"]);
		expect(fake.searches[fake.searches.length - 1]).toEqual({
			query: {
				operator: "AND",
				value: [
					{ field: "team_assignee_id", operator: "=", value: 1 },
					{ field: "state", operator: "=", value: "open" },
					{ field: "updated_at", operator: ">", value: 1790000000 + 3600 },
					{ field: "source.body", operator: "~", value: "see" },
					{ field: "source.body", operator: "~", value: "docs" },
					{ field: "source.body", operator: "~", value: "x" },
				],
			},
			pagination: { per_page: 10 },
		});
		// 101 is in Billing now, though the index still has it in Support; 999 is gone.
		outcome = await run.ok("intercom_search_conversations", { inbox: SUPPORT });
		expect(outcome.result.items.map((item) => item.id)).toEqual(["100"]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(outcome.result.items[0]?.preview).toBe("Hi, see [Intercom link] and docs (https://example.com/docs)\n[image]");
		expect(fake.reads("/conversations/101").length > 0 && fake.reads("/conversations/999").length > 0).toBe(true);
		// Teams the workspace does not have are refused like ungranted ones; names are refused before asking.
		expect(await run.code("intercom_search_conversations", { inbox: "3" })).toBe("POLICY_DENIED");
		for (const inbox of ["Support", "01", "None"]) expect(await run.code("intercom_search_conversations", { inbox })).toBe("INVALID_ARGUMENTS");
		const extras: JsonObject[] = [{ text: "?!" }, { updated_after: "yesterday" }, { updated_after: "1900-01-01" }];
		for (const extra of extras) {
			expect(await run.code("intercom_search_conversations", { inbox: SUPPORT, ...extra })).toBe("INVALID_ARGUMENTS");
		}
		expect(fake.problems).toEqual([]);
	});

	test("search words must be in the message as shown", async () => {
		// Intercom matches the raw body, where 100 holds a hidden link label.
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read"] });
		let outcome = await run.ok("intercom_search_conversations", { inbox: SUPPORT, text: "merger" });
		expect(fake.searches.length > 0 && outcome.result.items.length === 0).toBe(true);
		outcome = await run.ok("intercom_search_conversations", { inbox: SUPPORT, text: "DOCS" });
		expect(outcome.result.items.map((item) => item.id)).toEqual(["100"]);
	});

	test("a conversation too large to read is refused like an unseen one", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read"] });
		fake.hook = (method, path) => (method === "GET" && path === "/conversations/100" ? new Response("x".repeat(MAX_RESPONSE + 1), { status: 200 }) : null);
		expect(await run.code("intercom_get_conversation", { conversation: "100" })).toBe("POLICY_DENIED");
		const outcome = await run.ok("intercom_search_conversations", { inbox: SUPPORT });
		expect(outcome.result.items).toEqual([]);
	});

	test("the no team inbox searches for team zero", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { none: ["read"] });
		const outcome = await run.ok("intercom_search_conversations", { inbox: "none", updated_after: "2026-09-21" });
		expect(outcome.result.items.map((item) => item.id)).toEqual(["102", "103"]);
		// A date without a zone is midnight UTC.
		expect((fake.searches[fake.searches.length - 1]?.query as JsonObject).value).toEqual([
			{ field: "team_assignee_id", operator: "=", value: 0 },
			{ field: "updated_at", operator: ">", value: 1789948800 },
		]);
		expect(outcome.result.items[0]?.state).toBe("closed");
	});

	test("search pages are run bound", async () => {
		const fake = new FakeIntercom();
		for (let n = 104; n < 108; n++) fake.conversations[String(n)] = conversation(String(n), 1, `Case ${n}`, "<p>case</p>");
		const run = await start(fake, { [SUPPORT]: ["read"] });
		const first = await run.ok("intercom_search_conversations", { inbox: SUPPORT, limit: 3 });
		expect(first.result.items.map((item) => item.id)).toEqual(["100", "104", "105"]);
		const args = { inbox: SUPPORT, limit: 3, cursor: first.result.next_cursor as string };
		const second = await run.ok("intercom_search_conversations", args);
		expect(second.result.items.map((item) => item.id)).toEqual(["106", "107"]);
		expect("next_cursor" in second.result).toBe(false);
		expect(fake.searches[fake.searches.length - 1]?.pagination).toEqual({ per_page: 3, starting_after: `${TOKEN}3` });
		expect(await run.code("intercom_search_conversations", { ...args, state: "open" })).toBe("INVALID_CURSOR");

		// A cursor Intercom no longer takes.
		fake.hook = (_method, path, body) =>
			path.endsWith("/search") && Object.hasOwn((body as JsonObject).pagination as JsonObject, "starting_after") ? error(400, "parameter_invalid") : null;
		expect(await run.code("intercom_search_conversations", args)).toBe("INVALID_CURSOR");
		fake.hook = (_method, path) => (path.endsWith("/search") ? error(400, "parameter_invalid") : null);
		expect(await run.code("intercom_search_conversations", { inbox: SUPPORT })).toBe("INVALID_ARGUMENTS");
	});

	test("answers are read as Pydantic reads them", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { "*": ["read"] });
		const raw = (text: string) => {
			fake.hook = (method, path) => (method === "GET" && path === "/conversations/102" ? new Response(text, { status: 200 }) : null);
		};
		const refund = JSON.stringify(fake.conversations["102"]);
		// Pydantic's JSON parser refuses an escaped lone surrogate anywhere, a byte order mark and trailing text.
		for (const text of [refund.replace('"Refund"', '"\\ud800"'), refund.replace('"type":"conversation"', '"\\udfff":1'), `﻿${refund}`, `${refund} x`]) {
			raw(text);
			expect(await run.code("intercom_get_conversation", { conversation: "102" })).toBe("PROVIDER_FAILED");
		}
		// A surrogate pair, whitespace around the document, and lax ints, bools and nulls are read.
		raw(` ${refund.replace('"Refund"', '"\\ud83d\\ude00"').replace('"created_at":1790000000', '"created_at":"1790000000"').replace('"redacted":false', '"redacted":0')}\n`);
		const [found] = await items(run, "intercom_get_conversation", { conversation: "102" });
		expect([found?.title, found?.created]).toEqual(["\u{1f600}", "2026-09-21T14:13:20Z"]);
		// A reply's answer is read as json.loads reads it, which keeps a lone surrogate.
		const writer = await start(fake, { [SUPPORT]: ["read", "note"] });
		fake.hook = (method, path) =>
			method === "POST" && path.endsWith("/reply") ? new Response(JSON.stringify(fake.conversations["100"]).replace('"Login issue"', '"\\ud800"'), { status: 200 }) : null;
		const [note] = (await writer.ok("intercom_add_note", { conversation: "100", text: "x" })).result.items;
		expect([note?.written, note?.inbox]).toEqual([true, SUPPORT]);
	});

	test("search answers are checked", async () => {
		const fake = new FakeIntercom();
		const answer = (page: JsonObject) => {
			fake.hook = (_method, path) => (path.endsWith("/search") ? json(200, page) : null);
		};
		const http = client(fake);
		answer({ conversations: [{ id: "1" }], pages: { next: { starting_after: "a b" } } });
		await expect(http.search({}, 1, null)).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
		answer({ conversations: [{ id: "../me" }] });
		await expect(http.search({}, 1, null)).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
		// An empty page token is refused as well, and a page without one is the last.
		answer({ conversations: [{ id: "1" }], pages: { next: { starting_after: "" } } });
		await expect(http.search({}, 1, null)).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
		answer({ conversations: [{ id: "1" }, { id: "1" }], pages: null });
		expect(await http.search({}, 1, null)).toEqual([["1", "1"], null]);
	});
});

describe("writing", () => {
	test("notes and replies are escaped and sent as the teammate", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note", "reply"] });
		let outcome = await run.ok("intercom_add_note", { conversation: "100", text: "Looked at <b>logs</b>.\nAll fine.\n\nNext: deploy" });
		expect(outcome.result.items).toEqual([{ written: true, conversation_id: "100", inbox: SUPPORT, part_id: "301", created: "2026-09-21T17:03:20Z" }]);
		outcome = await run.ok("intercom_reply", { conversation: "100", text: "Fixed, thanks!" });
		expect(outcome.result.items[0]?.part_id).toBe("302");
		expect(fake.writes).toEqual([
			["100", { message_type: "note", type: "admin", admin_id: ADMIN, body: "<p>Looked at &lt;b&gt;logs&lt;/b&gt;.<br>All fine.</p><p>Next: deploy</p>" }],
			["100", { message_type: "comment", type: "admin", admin_id: ADMIN, body: "<p>Fixed, thanks!</p>" }],
		]);
		for (const text of ["see https://app.intercom.com/a/inbox/x/conversation/101", "APP%2EINTERCOM%2ECOM/x", "intercom:x", "bell \x07"]) {
			expect(await run.code("intercom_reply", { conversation: "100", text })).toBe("INVALID_ARGUMENTS");
		}
		expect(await run.code("intercom_add_note", { conversation: "101", text: "x" })).toBe("POLICY_DENIED");
		expect(fake.writes).toHaveLength(2);
		expect(fake.problems).toEqual([]);
	});

	test("replying and noting are separate permissions", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note"], none: ["read", "reply"] });
		expect(new Set(run.tools.filter((tool) => tool.startsWith("intercom_")))).toEqual(
			new Set(["intercom_list_inboxes", "intercom_search_conversations", "intercom_get_conversation", "intercom_add_note", "intercom_reply"]),
		);
		expect(await run.code("intercom_reply", { conversation: "100", text: "x" })).toBe("POLICY_DENIED");
		expect(await run.code("intercom_add_note", { conversation: "102", text: "x" })).toBe("POLICY_DENIED");
		await run.ok("intercom_add_note", { conversation: "100", text: "x" });
		await run.ok("intercom_reply", { conversation: "102", text: "x" });
		expect(fake.writes.map(([conversationId, body]) => [conversationId, body.message_type])).toEqual([
			["100", "note"],
			["102", "comment"],
		]);
	});

	test("a conversation reassigned after authorizing is refused", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note", "reply"] });
		const moving = fake.conversations["100"] as JsonObject;
		// Intercom answers the read that authorizes, then the conversation moves to Billing.
		fake.hook = (method, path) => {
			if (method === "GET" && path.endsWith("/conversations/100") && moving.team_assignee_id === 1) {
				const response = json(200, copy(moving));
				moving.team_assignee_id = 2;
				return response;
			}
			return null;
		};
		expect(await run.code("intercom_reply", { conversation: "100", text: "x" })).toBe("CONVERSATION_MOVED");
		moving.team_assignee_id = 1;

		// Intercom answers the read that authorizes, then access to the conversation is lost.
		let authorized = false;
		fake.hook = (method, path) => {
			if (method === "GET" && path.endsWith("/conversations/100")) {
				if (authorized) return error(403, "forbidden");
				authorized = true;
			}
			return null;
		};
		expect(await run.code("intercom_add_note", { conversation: "100", text: "x" })).toBe("CONVERSATION_MOVED");
		expect(fake.writes).toEqual([]);
		// Nothing was sent, so the same write may be tried again.
		expect(run.writes()).toEqual([]);
	});

	test("a write names the inbox the conversation is in afterwards", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note"] });
		// An assignment rule moves the conversation to Billing as the note lands.
		fake.hook = (method, path, body) => {
			if (method === "POST" && path.endsWith("/reply")) {
				fake.writes.push(["100", body as JsonObject]);
				return json(200, { ...copy(fake.conversations["100"] as JsonObject), team_assignee_id: 2, title: SECRET });
			}
			return null;
		};
		const outcome = await run.ok("intercom_add_note", { conversation: "100", text: "x" });
		expect(outcome.result.items).toEqual([]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);
		expect(fake.writes).toHaveLength(1);
	});

	test("a reply without the new part still counts", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "reply"] });
		fake.hook = (method, path, body) => {
			if (method === "POST" && path.endsWith("/reply")) {
				fake.writes.push(["100", body as JsonObject]);
				return json(200, { ...copy(fake.conversations["100"] as JsonObject), conversation_parts: { conversation_parts: [], total_count: 0 } });
			}
			return null;
		};
		let outcome = await run.ok("intercom_reply", { conversation: "100", text: "x" });
		expect(outcome.result.items[0]?.part_id).toBeNull();

		fake.hook = (method, path, body) => {
			if (method === "POST" && path.endsWith("/reply")) {
				fake.writes.push(["100", body as JsonObject]);
				return json(200, { type: "conversation" });
			}
			return null;
		};
		outcome = await run.ok("intercom_reply", { conversation: "100", text: "y" });
		expect(outcome.result.outcome).toBe("applied_without_result");
	});

	test("an earlier part is not taken for the one written", async () => {
		// Intercom answers with parts from before the write only: Ada's earlier note 202 is not the new one.
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note"] });
		fake.hook = (method, path, body) => {
			if (method === "POST" && path.endsWith("/reply")) {
				fake.writes.push(["100", body as JsonObject]);
				return json(200, fake.conversations["100"]);
			}
			return null;
		};
		let outcome = await run.ok("intercom_add_note", { conversation: "100", text: "x" });
		expect([outcome.result.items[0]?.part_id, outcome.result.items[0]?.created]).toEqual([null, null]);

		fake.hook = (method, path, body) => {
			if (method === "POST" && path.endsWith("/reply")) {
				fake.writes.push(["100", body as JsonObject]);
				const found = copy(fake.conversations["100"] as JsonObject);
				const listed = (found.conversation_parts as JsonObject).conversation_parts as JsonObject[];
				listed.push(part("310", "note", ADA, "<p>x</p>"), part("311", "note", ADA, "<p>other</p>"));
				return json(200, found);
			}
			return null;
		};
		outcome = await run.ok("intercom_add_note", { conversation: "100", text: "y" });
		expect(outcome.result.items[0]?.part_id).toBeNull();
	});

	test("a write reads where the conversation is and who is writing before authorizing, and again before sending", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note"] });
		const sent = () => fake.requests.map((request) => `${request.method} ${request.path}`);
		await run.ok("intercom_add_note", { conversation: "100", text: "x" });
		expect(sent()).toEqual(["GET /conversations/100", "GET /me", "GET /conversations/100", "POST /conversations/100/reply"]);
		// Refused by the policy: only what authorizing needed was read.
		fake.requests.length = 0;
		expect(await run.code("intercom_add_note", { conversation: "101", text: "x" })).toBe("POLICY_DENIED");
		expect(sent()).toEqual(["GET /conversations/101", "GET /me"]);
		// The teammate cannot be read: nothing is written.
		fake.requests.length = 0;
		fake.hook = (method, path) => (method === "GET" && path === "/me" ? json(200, { id: "x" }) : null);
		expect(await run.code("intercom_add_note", { conversation: "100", text: "z" })).toBe("PROVIDER_FAILED");
		expect(sent()).toEqual(["GET /conversations/100", "GET /me"]);
		expect(fake.writes).toHaveLength(1);
	});

	test("an identical write is answered from the run's record", async () => {
		const fake = new FakeIntercom();
		const run = await start(fake, { [SUPPORT]: ["read", "note"] });
		const first = await run.ok("intercom_add_note", { conversation: "100", text: "  same  " });
		// Stripped, the text is the same write.
		const again = await run.ok("intercom_add_note", { conversation: "100", text: "same" });
		expect(again.repeat).toBe(true);
		expect(again.result).toEqual(first.result);
		expect(fake.writes).toHaveLength(1);
	});
});
