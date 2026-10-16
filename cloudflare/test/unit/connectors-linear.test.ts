// The Linear connector against an in-memory Linear GraphQL API (test/fixtures/connectors/linear/fake.ts)
// behind the executor's injected `fetch`, with the real executor, ledger and page tokens (executor-fakes.ts
// `Scenario`); and its pure rules: the text agents read and write, the judge of writes, team ancestry.

import { describe, expect, test } from "vitest";
import { type LinearClient, MAX_TEAM_DEPTH, type TeamRef, judge } from "../../src/connectors/linear/client.ts";
import { DESCRIBE_BATCH, MAX_DISCOVERY_PAGES, linear } from "../../src/connectors/linear/connector.ts";
import { issueLinks, redact, writtenProblem } from "../../src/connectors/linear/markdown.ts";
import { TEAM, ancestry } from "../../src/connectors/linear/teams.ts";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { type JsonObject, parseJson } from "../../src/lib/json.ts";
import { FakeLinear, ID, NAME, SECRET, STATES } from "../fixtures/connectors/linear/fake.ts";
import { askedScopes, catalogEntry, uncovered } from "./catalog-support.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

const CONNECTION = "0199a000-0000-7000-8000-00000000001e";

/** A run for an agent with the user's Linear connection, holding `grants` on teams. */
function start(fake: FakeLinear, grants: { [team: string]: string[] }, ceiling: GrantRow[] = []): Promise<Scenario> {
	const teams = Object.fromEntries(Object.entries(grants).map(([name, actions]) => [ID[name] ?? name, actions]));
	return Scenario.start({
		connectors: [linear],
		connections: [{ id: CONNECTION, provider: "linear", payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: ["read", "write"] } }],
		user: userGrants(CONNECTION, TEAM, teams),
		ceiling,
		fetch: fake.fetch,
	});
}

/** A deny in the workspace ceiling, which stays unrestricted. */
function deny(team: string, actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: CONNECTION, kind: TEAM, resourceId: ID[team] as string, resourceName: "", actions, effect: "deny" };
}

async function items(run: Scenario, tool: string, args: JsonObject): Promise<JsonObject[]> {
	return (await run.ok(tool, args)).result.items;
}

async function identifiers(run: Scenario, tool: string, args: JsonObject): Promise<string[]> {
	return (await items(run, tool, args)).map((item) => item.identifier as string);
}

function client(fake: FakeLinear): LinearClient {
	return linear.client("token", settingsIo(fake.fetch));
}

describe("connecting", () => {
	test("account, discovery and names", async () => {
		const fake = new FakeLinear();
		const http = client(fake);
		const account = await linear.account(http);
		expect([account.id, account.label]).toEqual([ID.ada, "Ada Lovelace (Acme)"]);
		let found = await linear.discover(http, TEAM, { query: null, cursor: null });
		expect(found.items.map((item) => item.name)).toEqual(["Engineering (ENG)", "Web (WEB)", "Operations (OPS)", "Design (DES)"]);
		found = await linear.discover(http, TEAM, { query: "ops", cursor: null });
		expect(found.items.map((item) => [NAME[item.id], item.name])).toEqual([["ops", "Operations (OPS)"]]);
		await expect(linear.discover(http, TEAM, { query: null, cursor: "not a cursor" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
		const names = await linear.describe(http, TEAM, [ID.eng as string, ID.sec as string, "*", "ENG"]);
		expect(names).toEqual({ [ID.eng as string]: "Engineering (ENG)" });
		// Every request carried the connection's token, as a POST that is never redirected.
		expect(fake.requests.every((request) => request.headers.get("authorization") === "Bearer token")).toBe(true);
	});

	test("discovery matches names ignoring case, and stops at a cap", async () => {
		const fake = new FakeLinear();
		(fake.teams.ops as { name: string }).name = "Straße";
		const found = await linear.discover(client(fake), TEAM, { query: "STRAßE", cursor: null });
		expect(found.items.map((item) => item.name)).toEqual(["Straße (OPS)"]);
		// A search reads at most 10 pages of 100 teams.
		let pages = 0;
		const endless: typeof fetch = async () => {
			pages += 1;
			const page = { nodes: [], pageInfo: { hasNextPage: true, endCursor: `c${pages}` } };
			return new Response(JSON.stringify({ data: { teams: page } }), { status: 200 });
		};
		await expect(linear.discover(linear.client("token", settingsIo(endless)), TEAM, { query: "nothing", cursor: null })).rejects.toMatchObject({
			code: "PROVIDER_LIMIT",
			message: "There are more teams than Minerva can search.",
		});
		expect(pages).toBe(MAX_DISCOVERY_PAGES);
	});

	test("names are described in batches of 100, asked for at once", async () => {
		const asked: string[][] = [];
		const teams: typeof fetch = async (_input, init) => {
			const body = parseJson(String(init?.body)) as { variables: { first: number; filter: { id: { in: string[] } } } };
			const ids = body.variables.filter.id.in;
			asked.push(ids);
			expect(body.variables.first).toBe(DESCRIBE_BATCH);
			const nodes = ids.filter((_, index) => index % 2 === 0).map((id) => ({ id: id.toUpperCase(), key: "K", name: `Team ${id.slice(-3)}` }));
			return new Response(JSON.stringify({ data: { teams: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });
		};
		const ids = Array.from({ length: 250 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
		const names = await linear.describe(linear.client("token", settingsIo(teams)), TEAM, [...ids, "*", "not-an-id"]);
		expect(asked.map((batch) => batch.length)).toEqual([100, 100, 50]);
		expect(Object.keys(names).length).toBe(125);
		expect(names[ids[0] as string]).toBe("Team 000 (K)");
		expect(names[ids[1] as string]).toBeUndefined();
	});

	test("the catalog's OAuth: comma-joined scopes, PKCE, and token requests as forms with the client in the body", async () => {
		expect((await catalogEntry(linear)).auth).toMatchObject({
			authorizeUrl: "https://linear.app/oauth/authorize",
			tokenUrl: "https://api.linear.app/oauth/token",
			scopeSeparator: ",",
			clientAuth: "post",
			tokenBody: "form",
			pkce: true,
		});
	});

	test("the catalog asks for read, and each write for its own scope or write", async () => {
		const entry = await catalogEntry(linear);
		expect(entry.auth).toMatchObject({ scopes: ["read"] });
		expect(askedScopes(entry)).toEqual({ create_issue: ["issues:create"], add_comment: ["comments:create"], update_issue: ["write"] });
		expect(uncovered(entry, ["read", "write"])).toEqual([]);
		expect(uncovered(entry, ["issues:create", "read"])).toEqual(["add_comment", "update_issue"]);
	});

	test("the registry accepts the declaration; its fingerprints", async () => {
		expect(CONNECTORS).toContain(linear);
		const registry = await connectorRegistry();
		expect(registry.get("linear")).toBe(linear);
		const prints = Object.fromEntries(linear.operations.map((op) => [op.name, registry.contract("linear", op.name)]));
		console.log(`linear fingerprints: ${JSON.stringify(prints)}`);
		expect(Object.values(prints).every((print) => /^[0-9a-f]{16}$/.test(print))).toBe(true);
		expect(new Set(Object.values(prints)).size).toBe(linear.operations.length);
		// Stable across registries, as across the deploys of one version.
		const again = await Registry.create([linear]);
		for (const op of linear.operations) expect(again.contract("linear", op.name)).toBe(prints[op.name]);
		expect(prints).toEqual(FINGERPRINTS);
	});
});

/**
 * What each operation means, over zod's JSON Schema of its input. A change here makes running runs' tools fail with OPERATION_CHANGED: update it only with
 * a change of meaning, and bump `revision` when the declaration does not show one.
 */
const FINGERPRINTS: { [operation: string]: string } = {
	list_teams: "defe2daa8f3b2563",
	get_team: "be69dbdd0e224f1a",
	list_issues: "e422749f8096f060",
	search_issues: "886b85411bbf39fb",
	get_issue: "6ab0d963727c4a19",
	create_issue: "fc05a953958bec85",
	add_comment: "912669e9b6c9670b",
	update_issue: "a22a8b5f01a29996",
};

describe("runs", () => {
	test("a grant on a team covers its sub-teams", async () => {
		const fake = new FakeLinear();
		let run = await start(fake, { eng: ["read"] });
		expect((await items(run, "linear_list_teams", {})).map((item) => item.key)).toEqual(["ENG", "WEB"]);
		const [web] = await items(run, "linear_get_team", { team: "web" });
		expect(web?.parent_team_id).toBe(ID.eng);
		const [issue] = await items(run, "linear_get_issue", { issue: "web-1" });
		expect(issue?.title).toBe("Landing page");
		const [byId] = await items(run, "linear_get_issue", { issue: (ID["ENG-2"] as string).toUpperCase() });
		expect(byId?.identifier).toBe("ENG-2");

		fake.ops.length = 0;
		// Teams without a grant, teams the account cannot see, and missing issues look alike.
		for (const args of [{ issue: "OPS-1" }, { issue: "SEC-1" }, { issue: "ENG-999" }, { issue: "0199a000-0000-7000-8000-0000000000ff" }]) {
			expect(await run.code("linear_get_issue", args)).toBe("POLICY_DENIED");
		}
		for (const team of ["OPS", "sec", "NOPE", ID.sec as string]) expect(await run.code("linear_list_issues", { team })).toBe("POLICY_DENIED");
		// Nothing but where the issue or team sits was asked for.
		const places = new Set(["IssuePlace", "TeamByKey", "Team"]);
		expect(fake.names().filter((name) => !places.has(name))).toEqual([]);

		run = await start(fake, { web: ["read"] });
		expect(await run.code("linear_get_team", { team: "ENG" })).toBe("POLICY_DENIED");
		expect((await items(run, "linear_list_teams", {})).map((item) => item.key)).toEqual(["WEB"]);
	});

	test("a deny on a sub-team holds", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] }, [deny("web")]);
		expect(await run.code("linear_get_issue", { issue: "WEB-1" })).toBe("POLICY_DENIED");
		expect((await items(run, "linear_list_teams", {})).map((item) => item.key)).toEqual(["ENG"]);
		expect((await items(run, "linear_get_issue", { issue: "ENG-1" })).length).toBe(1);
	});

	test("cycles are partial", async () => {
		const fake = new FakeLinear();
		(fake.teams.eng as { parent: string | null }).parent = "web";
		const run = await start(fake, { "*": ["read"] }, [deny("ops")]);
		// A chain Linear cannot show in full could lead anywhere, the denied team included.
		for (const team of ["ENG", "WEB", "OPS"]) expect(await run.code("linear_get_team", { team })).toBe("POLICY_DENIED");
		expect((await items(run, "linear_get_team", { team: "DES" })).length).toBe(1);
	});

	test("reading an issue hides other teams", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		const [issue] = (await items(run, "linear_get_issue", { issue: "ENG-1" })) as [JsonObject];
		expect(JSON.stringify(issue)).not.toContain(SECRET);
		expect(issue.description).toContain("https://linear.app/acme/issue/OPS-1,");
		expect(issue.description).toContain("https://linear.app/acme/project/0a1b2c3d4e5f");
		expect(issue.description).not.toContain("hush");
		expect(issue.url).toBe("https://linear.app/acme/issue/ENG-1");
		expect((issue.sub_issues as JsonObject[]).map((child) => child.identifier)).toEqual(["ENG-2"]);
		expect(issue.sub_issues_in_other_teams).toBe(true);
		expect(issue.parent).toBeNull();
		// Hidden comments are left out; comments come oldest first.
		const comments = issue.comments as JsonObject[];
		expect(comments.map((comment) => comment.body)).toEqual(["First", "Reply about https://linear.app/acme/issue/OPS-1"]);
		expect(comments[1]?.reply_to).toBe(ID.c1);
		expect(comments[0]?.author).toBe("Grace");

		const [child] = await items(run, "linear_get_issue", { issue: "ENG-2" });
		expect(child?.parent).toEqual({ identifier: "ENG-1", title: "Launch plan" });
		const [other] = await items(run, "linear_get_issue", { issue: "ENG-3" });
		expect(other?.parent).toEqual({ in_another_team: true });
	});

	test("listing and searching issues", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		expect(await identifiers(run, "linear_list_issues", { team: "ENG" })).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
		expect(await identifiers(run, "linear_list_issues", { team: "ENG", state: "closed" })).toEqual(["ENG-4"]);
		expect(await identifiers(run, "linear_list_issues", { team: "ENG", assigned_to_me: true })).toEqual(["ENG-2"]);
		const first = await run.ok("linear_list_issues", { team: "ENG", state: "all", limit: 3 });
		expect(first.result.items.map((item) => item.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
		const rest = await run.ok("linear_list_issues", { team: "ENG", state: "all", limit: 3, cursor: first.result.next_cursor as string });
		expect(rest.result.items.map((item) => item.identifier)).toEqual(["ENG-4"]);
		expect(rest.result).not.toHaveProperty("next_cursor");
		// Issues of other teams are dropped even if Linear returned them.
		fake.stray = "OPS-1";
		expect(await identifiers(run, "linear_list_issues", { team: "ENG" })).not.toContain("OPS-1");
		fake.stray = null;

		expect(await identifiers(run, "linear_search_issues", { team: "ENG", query: "plan" })).toEqual(["ENG-1"]);
		expect(fake.lastFilter).toEqual({ and: [{ title: { containsIgnoreCase: "plan" } }] });
		expect(await identifiers(run, "linear_search_issues", { team: "ENG", query: "secret" })).toEqual([]);
		expect(await run.code("linear_search_issues", { team: "OPS", query: "secret" })).toBe("POLICY_DENIED");
	});

	test("a team lists what issues can use", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		const [team] = (await items(run, "linear_get_team", { team: "ENG" })) as [JsonObject];
		expect((team.states as JsonObject[]).map((state) => state.name)).toEqual(STATES.map(([name]) => name));
		expect(team.labels).toEqual([
			{ name: "Bug", group: null },
			{ name: "Frontend", group: "Area" },
			{ name: "Urgent", group: null },
		]);
		expect((team.members as JsonObject[]).map((member) => member.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);
		expect(team.truncated).toBe(false);
	});

	test("creating issues", async () => {
		const fake = new FakeLinear();
		let run = await start(fake, { eng: ["read", "create"] });
		const [created] = await items(run, "linear_create_issue", {
			team: "eng",
			title: "New thing",
			description: "Follows https://linear.app/acme/issue/ENG-2/write-docs",
			state: "todo",
			priority: 2,
			labels: ["bug", "area/frontend", "Urgent"],
			assignee: "Me",
			due_date: "2026-10-10",
		});
		expect([created?.identifier, created?.url]).toEqual(["ENG-9", "https://linear.app/acme/issue/ENG-9"]);
		expect(fake.writes).toEqual([
			[
				"IssueCreate",
				{
					teamId: ID.eng,
					title: "New thing",
					useDefaultTemplate: false,
					description: "Follows https://linear.app/acme/issue/ENG-2/write-docs",
					stateId: "eng-unstarted",
					priority: 2,
					labelIds: ["l-bug", "l-frontend", "l-urgent"],
					assigneeId: ID.ada,
					dueDate: "2026-10-10",
				},
			],
		]);

		const refusals: [JsonObject, string][] = [
			[{ description: "See https://linear.app/acme/issue/OPS-1" }, "LINK_NOT_ALLOWED"],
			[{ description: "See https://linear.app/acme/issue/WEB-1" }, "LINK_NOT_ALLOWED"],
			[{ description: "See https://linear.app/acme/issue/SEC-1" }, "LINK_NOT_ALLOWED"],
			[{ description: "See https://linear.app/acme/issue/ENG-404" }, "LINK_NOT_ALLOWED"],
			[{ description: "See https://linear.app/other/issue/ENG-1" }, "LINK_NOT_ALLOWED"],
			[{ description: "See https://linear.app/acme/project/x-0a1b2c3d4e5f" }, "INVALID_ARGUMENTS"],
			[{ labels: ["Area"] }, "INVALID_ARGUMENTS"],
			[{ labels: ["Nope"] }, "INVALID_ARGUMENTS"],
			[{ assignee: "old" }, "INVALID_ARGUMENTS"],
			[{ state: "Done" }, "INVALID_ARGUMENTS"],
			[{ due_date: "10/10/2026" }, "INVALID_ARGUMENTS"],
			[{ title: "two\nlines" }, "INVALID_ARGUMENTS"],
			[{ priority: 5 }, "INVALID_ARGUMENTS"],
		];
		for (const [extra, code] of refusals) expect(await run.code("linear_create_issue", { team: "ENG", title: "x", ...extra }), JSON.stringify(extra)).toBe(code);
		expect(fake.writes.length).toBe(1);
		// Refused messages are the same whatever the linked issue is.
		const messages = new Set<string>();
		for (const target of ["OPS-1", "SEC-1", "ENG-404"]) {
			messages.add((await run.error("linear_create_issue", { team: "ENG", title: "x", description: `https://linear.app/acme/issue/${target}` })).message);
		}
		expect(messages.size).toBe(1);
		expect((await run.error("linear_create_issue", { team: "ENG", title: "x", labels: ["Nope"] })).message).toBe(
			"No single label in this team has that name; get_team lists them.",
		);

		expect(await run.code("linear_create_issue", { team: "OPS", title: "x" })).toBe("POLICY_DENIED");
		run = await start(fake, { eng: ["read"] });
		expect(run.tools).not.toContain("linear_create_issue");
	});

	test("commenting", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read", "comment"] });
		const [comment] = await items(run, "linear_add_comment", { issue: "ENG-1", body: "Thanks" });
		expect([comment?.issue, comment?.reply_to]).toEqual(["ENG-1", null]);
		// A reply to a reply joins its thread.
		const [reply] = await items(run, "linear_add_comment", { issue: "ENG-1", body: "Agreed", reply_to: ID.c3 as string });
		expect(reply?.reply_to).toBe(ID.c1);
		expect(fake.writes).toEqual([
			["CommentCreate", { issueId: ID["ENG-1"], body: "Thanks" }],
			["CommentCreate", { issueId: ID["ENG-1"], body: "Agreed", parentId: ID.c1 }],
		]);
		for (const replyTo of [ID.c4 as string, ID.gone as string, "c1"]) {
			expect(await run.code("linear_add_comment", { issue: "ENG-1", body: "x", reply_to: replyTo })).toBe("INVALID_ARGUMENTS");
		}
		expect(await run.code("linear_add_comment", { issue: "ENG-1", body: "cc https://linear.app/acme/issue/OPS-2" })).toBe("LINK_NOT_ALLOWED");
		expect(await run.code("linear_add_comment", { issue: "OPS-1", body: "x" })).toBe("POLICY_DENIED");
		expect(fake.writes.length).toBe(2);
	});

	test("updating issues", async () => {
		const fake = new FakeLinear();
		let run = await start(fake, { eng: ["read", "edit"] });
		const [updated] = await items(run, "linear_update_issue", {
			issue: "ENG-2",
			title: "Write better docs",
			priority: 1,
			add_labels: ["Bug"],
			remove_labels: ["Frontend"],
			unassign: true,
			clear_due_date: true,
		});
		expect(updated?.title).toBe("Write better docs");
		expect(updated?.changed).toEqual(["addedLabelIds", "assigneeId", "dueDate", "priority", "removedLabelIds", "title"]);
		expect(fake.writes.at(-1)).toEqual([
			"IssueUpdate",
			{
				id: ID["ENG-2"],
				title: "Write better docs",
				priority: 1,
				addedLabelIds: ["l-bug"],
				removedLabelIds: ["l-frontend"],
				assigneeId: null,
				dueDate: null,
			},
		]);
		// A sub-issue whose parents are all in the team may change status.
		await run.ok("linear_update_issue", { issue: "ENG-2", state: "In progress" });
		expect(fake.writes.at(-1)?.[1]).toEqual({ id: ID["ENG-2"], stateId: "eng-started" });

		run = await start(fake, { eng: ["read", "edit"] });
		const writes = fake.writes.length;
		// Linear could close OPS-1 when its sub-issue ENG-3 closes, or reopen it.
		for (const state of ["Done", "Todo"]) expect(await run.code("linear_update_issue", { issue: "ENG-3", state })).toBe("STATUS_CHANGE_REFUSED");
		// Closing ENG-1 would close its open sub-issue OPS-2.
		for (const state of ["Done", "Canceled"]) expect(await run.code("linear_update_issue", { issue: "ENG-1", state })).toBe("STATUS_CHANGE_REFUSED");
		expect(fake.writes.length).toBe(writes);
		await run.ok("linear_update_issue", { issue: "ENG-1", state: "In Progress" });
		(fake.issues["OPS-2"] as { state: string }).state = "completed";
		await run.ok("linear_update_issue", { issue: "ENG-1", state: "Done" });
		expect(fake.writes.at(-1)?.[1]).toEqual({ id: ID["ENG-1"], stateId: "eng-completed" });

		run = await start(fake, { eng: ["read", "edit"] });
		const invalid: JsonObject[] = [
			{ issue: "ENG-1" },
			{ issue: "ENG-1", assignee: "grace", unassign: true },
			{ issue: "ENG-1", due_date: "2026-10-10", clear_due_date: true },
			{ issue: "ENG-1", add_labels: ["Bug"], remove_labels: ["bug"] },
		];
		for (const args of invalid) {
			expect(await run.code("linear_update_issue", args)).toBe("INVALID_ARGUMENTS");
		}
		expect(await run.code("linear_update_issue", { issue: "OPS-1", title: "x" })).toBe("POLICY_DENIED");
	});

	/** Applies `change` just before Linear answers the first `before` request. */
	function move(fake: FakeLinear, before: string, change: () => void): void {
		let done = false;
		fake.hook = (name) => {
			if (name === before && !done) {
				done = true;
				change();
			}
		};
	}

	test.each([
		["linear_get_issue", { issue: "ENG-1" }, "Issue", "ISSUE_MOVED"],
		["linear_add_comment", { issue: "ENG-1", body: "x" }, "IssuePlace", "ISSUE_MOVED"],
		["linear_update_issue", { issue: "ENG-1", title: "x" }, "IssueForUpdate", "ISSUE_MOVED"],
		["linear_create_issue", { team: "ENG", title: "x" }, "Team", "TEAM_MOVED"],
		// A move during the lookups that come before the write.
		["linear_update_issue", { issue: "ENG-1", add_labels: ["Bug"] }, "TeamLabels", "ISSUE_MOVED"],
		["linear_create_issue", { team: "ENG", title: "x", labels: ["Bug"] }, "TeamLabels", "TEAM_MOVED"],
		["linear_update_issue", { issue: "ENG-2", state: "Done" }, "OpenSubIssues", "ISSUE_MOVED"],
		["linear_list_issues", { team: "ENG" }, "TeamIssues", "TEAM_MOVED"],
		["linear_get_team", { team: "ENG" }, "Team", "TEAM_MOVED"],
	] as [string, JsonObject, string, string][])("an issue or team moved while %s %j runs, before %s, is refused with %s", async (tool, args, before, code) => {
		const fake = new FakeLinear();
		const run = await start(fake, { "*": ["read", "comment", "create", "edit"] });
		const change = () => {
			if (code === "ISSUE_MOVED") (fake.issues[(args.issue as string | undefined) ?? "ENG-1"] as { team: string }).team = "ops";
			else (fake.teams.eng as { parent: string | null }).parent = "ops";
		};
		if (tool === "linear_add_comment") {
			// The first IssuePlace resolves the issue; the move lands before the second.
			let seen = 0;
			fake.hook = (name) => {
				if (name === "IssuePlace" && ++seen === 2) change();
			};
		} else move(fake, before, change);
		expect(await run.code(tool, args)).toBe(code);
		expect(fake.writes).toEqual([]);
	});

	test("write outcomes follow what Linear confirmed", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read", "create"] });
		const answer = (body: JsonObject, status = 200) => {
			fake.hook = (name) => (name === "IssueCreate" ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) : null);
		};
		const limited = { message: "x", extensions: { type: "Ratelimited", code: "RATELIMITED" } };
		answer({ data: null, errors: [limited] }, 400);
		expect(await run.code("linear_create_issue", { team: "ENG", title: "a" })).toBe("PROVIDER_RATE_LIMITED");
		answer({ errors: [{ message: "bad", extensions: { type: "graphql error" } }] }, 400);
		expect(await run.code("linear_create_issue", { team: "ENG", title: "b" })).toBe("PROVIDER_REJECTED");
		expect(run.writes()).toEqual([]);
		// Confirmed without the issue: applied, with nothing more to show.
		answer({ data: { issueCreate: { success: true, issue: null } } });
		expect(await items(run, "linear_create_issue", { team: "ENG", title: "c" })).toEqual([{ written: true }]);
		// An error after the mutation may have run: unknown, and further writes pause.
		answer({ data: null, errors: [{ message: "boom", extensions: { type: "internal error" } }] });
		expect(await run.code("linear_create_issue", { team: "ENG", title: "d" })).toBe("WRITE_UNCERTAIN");
		fake.hook = null;
		expect(await run.code("linear_create_issue", { team: "ENG", title: "e" })).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
		expect(run.writes().map((write) => write.status).sort()).toEqual(["succeeded", "uncertain"]);
	});

	test("a write Linear answers without confirming is unconfirmed, and its outcome unknown", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read", "create"] });
		fake.hook = (name) => (name === "IssueCreate" ? new Response(JSON.stringify({ data: { issueCreate: { success: false } } }), { status: 200 }) : null);
		expect(await run.code("linear_create_issue", { team: "ENG", title: "a" })).toBe("WRITE_UNCERTAIN");
		expect(run.paused()).toBe(true);
	});

	test("a confirmation that is not UTF-8 JSON leaves the write unknown", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read", "create"] });
		const confirmed = new TextEncoder().encode('{"data": {"issueCreate": {"success": true, "issue": null}}, "x": "?"}');
		confirmed[confirmed.length - 3] = 0xff;
		fake.hook = (name) => (name === "IssueCreate" ? new Response(confirmed, { status: 200 }) : null);
		expect(await run.code("linear_create_issue", { team: "ENG", title: "a" })).toBe("WRITE_UNCERTAIN");
		expect(run.writes().map((write) => write.status)).toEqual(["uncertain"]);
		// A refusal in UTF-16 is not read either: the write may have run.
		const fresh = new FakeLinear();
		const other = await start(fresh, { eng: ["read", "create"] });
		const refusal = JSON.stringify({ errors: [{ extensions: { type: "graphql error", code: "GRAPHQL_VALIDATION_FAILED" } }] });
		const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Uint16Array.from(refusal, (char) => char.charCodeAt(0)).buffer)]);
		fresh.hook = (name) => (name === "IssueCreate" ? new Response(utf16, { status: 400 }) : null);
		expect(await other.code("linear_create_issue", { team: "ENG", title: "a" })).toBe("WRITE_UNCERTAIN");
		expect(other.writes().map((write) => write.status)).toEqual(["uncertain"]);
		// An error status whose body is not UTF-8 is named by the status.
		const refused = new TextEncoder().encode('{"errors": [{"extensions": {"type": "forbidden"}}], "x": "?"}');
		refused[refused.length - 3] = 0xff;
		fake.hook = (name) => (name === "Issue" ? new Response(refused, { status: 404 }) : null);
		expect(await run.code("linear_get_issue", { issue: "ENG-1" })).toBe("NOT_FOUND");
	});

	test("reads with errors or too much data are refused", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		const forbidden = { message: "no", extensions: { type: "forbidden" } };
		fake.hook = (name) => (name === "Issue" ? new Response(JSON.stringify({ data: { issue: null }, errors: [forbidden] }), { status: 200 }) : null);
		expect(await run.code("linear_get_issue", { issue: "ENG-1" })).toBe("PROVIDER_FORBIDDEN");
		const huge = JSON.stringify({ data: { issue: { description: "x".repeat(5 * 1024 * 1024) } } });
		fake.hook = (name) => (name === "Issue" ? new Response(huge, { status: 200 }) : null);
		expect(await run.error("linear_get_issue", { issue: "ENG-1" })).toEqual({ code: "RESPONSE_TOO_LARGE", message: "Linear returned more than Minerva reads." });
		// A body that is not JSON, or JSON without data, is an unexpected response.
		fake.hook = (name) => (name === "Issue" ? new Response("<html>", { status: 200 }) : null);
		expect(await run.error("linear_get_issue", { issue: "ENG-1" })).toEqual({ code: "PROVIDER_FAILED", message: "Linear returned an unexpected response." });
		fake.hook = (name) => (name === "Issue" ? new Response(JSON.stringify({ data: { issue: { id: 5 } } }), { status: 200 }) : null);
		expect(await run.code("linear_get_issue", { issue: "ENG-1" })).toBe("PROVIDER_FAILED");
		// An error status is named from its GraphQL errors.
		fake.hook = (name) => (name === "Issue" ? new Response(JSON.stringify({ errors: [{ extensions: { type: "authentication error" } }] }), { status: 400 }) : null);
		expect(await run.code("linear_get_issue", { issue: "ENG-1" })).toBe("CONNECTION_UNAUTHORIZED");
		expect(run.credentials.status(CONNECTION)).toBe("error");
	});

	test("page tokens are run-bound, and Linear's cursors are checked", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		expect(await run.code("linear_list_issues", { team: "ENG", cursor: "c1" })).toBe("INVALID_CURSOR");
		const first = await run.ok("linear_list_issues", { team: "ENG", state: "all", limit: 1 });
		expect(first.result.next_cursor).not.toBe("c1");
		// The token belongs to the query it was issued for.
		expect(await run.code("linear_list_issues", { team: "ENG", state: "open", limit: 1, cursor: first.result.next_cursor as string })).toBe("INVALID_CURSOR");
		// A cursor Linear returns that Minerva cannot pass back is refused.
		fake.hook = (name) =>
			name === "Teams" ? new Response(JSON.stringify({ data: { teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "has space" } } } }), { status: 200 }) : null;
		expect(await run.error("linear_list_teams", {})).toEqual({ code: "PROVIDER_LIMIT", message: "Linear returned a page token Minerva cannot use." });
	});

	test("Linear's own messages never reach the model", async () => {
		const fake = new FakeLinear();
		const run = await start(fake, { eng: ["read"] });
		fake.hook = (name) =>
			name === "Issue" ? new Response(JSON.stringify({ errors: [{ message: "internal detail 42", extensions: { type: "internal" } }] }), { status: 200 }) : null;
		expect(await run.error("linear_get_issue", { issue: "ENG-1" })).toEqual({ code: "PROVIDER_FAILED", message: "Linear could not complete this request." });
		expect(JSON.stringify(run.events)).not.toContain("internal detail");
	});
});

/** A UUID with the number `n` in its last digits. */
function uuid(n: number): string {
	const hex = n.toString(16).padStart(32, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function response(status: number, body: unknown): [Response, string] {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return [new Response(text, { status }), text];
}

function judged(status: number, body: unknown): string | null {
	const [res, text] = response(status, body);
	return judge(res, text);
}

describe("text, judging and ancestry", () => {
	test("read text hides titles of linked objects", () => {
		const SECRET = "Secret ops thing";
		const shown = redact(
			`[${SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing) and ` +
				"https://linear.app/Acme/issue/ops-2/other-title, " +
				"https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f/overview, " +
				"linear.app/acme/view/hush-hush, https://linear.app/acme, " +
				"![shot](https://uploads.linear.app/a/b.png), " +
				`[\\[SEC\\] ${SECRET} \\[x\\]](https://linear.app/acme/issue/OPS-1/x), ` +
				`[[${SECRET}]](https://linear.app/acme/issue/OPS-1 'tip'), ` +
				`![${SECRET}](https://linear.app/acme/issue/OPS-1 (${SECRET})), ` +
				`[${SECRET}](https://linear.app/acme/issue/OPS-1 "a \\"quote\\"")`,
		);
		for (const hidden of ["ecret", "other-title", "roadmap", "hush"]) expect(shown).not.toContain(hidden);
		expect(shown).toContain("https://linear.app/acme/issue/OPS-1 and");
		expect(shown).toContain("https://linear.app/Acme/issue/OPS-2,");
		expect(shown).toContain("https://linear.app/acme/project/0a1b2c3d4e5f,");
		expect(shown).toContain("https://linear.app/acme/view,");
		expect(shown).toContain("![shot](https://uploads.linear.app/a/b.png)");
		expect(shown).not.toContain("SEC");
		expect(redact(null)).toBeNull();
		// Lookalike letters and any case: the dotted capital I and the dotless i count as "i".
		for (const host of ["lınear.app", "l\u0130near.app", "LINEAR.APP"]) {
			expect(redact(`https://${host}/acme/project/secret-roadmap-0a1b2c3d4e5f`), host).toBe("https://linear.app/acme/project/0a1b2c3d4e5f");
			expect(redact(`https://${host}/acmeı/issue/ENG-1/secret-title`), host).not.toContain("secret");
		}
	});

	test.each([
		"![x](https://evil.example/p.png)",
		"<img src=https://evil.example/p.png>",
		'<a href="https://evil.example">x</a>',
		"<iframe>",
		"https://linear.app/acme/project/roadmap-0a1b2c3d4e5f",
		"linear.app/acme/issue/ENG-1",
		"https://\nlinear.app/acme/issue/ENG-1",
		"https://linear.app/acme/issue/ENG-1.evil",
		"[x](https://linear.app/acme/issue/ENG-1/../../issue/OPS-1)",
		"[x](https://linear.app/acme/issue/ENG-1/x_/../../OPS-1)",
		"[x](https://linear.app/acme/issue/ENG-1'/../OPS-1)",
		"https://linear.app/acme/issue/ENG-1)/../OPS-1",
		"https://linear.app/acme/issue/ENG-1\\)/../OPS-1",
		"https://linear.app/acme/issue/ENG-1/%2e%2e",
		"https://linear.app/acme/issue/ENG-1?x=1",
		"https://linear.app/acme/issue/ENG-1#top",
		"[x](https://linear%2eapp/acme/issue/OPS-1)",
		"[x](https://linear&#46;app/acme/issue/OPS-1)",
		"[x](https://linear\\.app/acme/issue/OPS-1)",
		"[x](https://linear。app/acme/issue/OPS-1)",
		"[x](https://ｌｉｎｅａｒ.app/acme/issue/OPS-1)",
		"[x](https://linear​.app/acme/issue/OPS-1)",
		"[x](https://lınear.app/acme/project/roadmap-0a1b2c3d4e5f)",
		"[x](https://l\u0130near.app/acme/view/x)",
		"[x](HTTPS://LINEAR.APP/acme/team/ENG)",
		'<a actıon="https://evil.example">',
		'<a act\u0130on="https://evil.example">',
		"https://linear.app/acme/settings/api",
		"[ENG-1](https://linear.app/acme/team/ENG)",
		"nul\x00",
		Array.from({ length: 11 }, (_, n) => `https://linear.app/acme/issue/ENG-${n + 1}`).join(" "),
	])("written text may only add words: %j", (written) => {
		expect(writtenProblem(written)).not.toBeNull();
	});

	test("written text allows markdown, uploads and issue links", () => {
		const written =
			"Plain **markdown** with [a link](https://example.com), <br>, " +
			"![shot](https://uploads.linear.app/a/b.png), [docs](https://linear.app/Acme/issue/eng-2/write-docs) " +
			"and https://linear.app/acme/issue/ENG-2. (https://linear.app/acme/issue/ENG-2), 100% sure, " +
			"**https://linear.app/acme/issue/ENG-2**, <https://linear.app/acme/issue/ENG-2/>";
		expect(writtenProblem(written)).toBeNull();
		expect(issueLinks(written)).toEqual([["acme", "ENG-2"]]);
	});

	test("judge claims only what Linear confirms", () => {
		const error = { message: "x", extensions: { type: "internal error" } };
		expect(judged(200, { data: { issueCreate: { success: true } } })).toBe("applied");
		// Errors raised before anything ran.
		const malformed = { message: "x", extensions: { type: "graphql error", code: "GRAPHQL_VALIDATION_FAILED" } };
		expect(judged(400, { errors: [malformed] })).toBe("not_applied");
		const limited = { message: "x", extensions: { type: "Ratelimited", code: "RATELIMITED" } };
		expect(judged(400, { data: null, errors: [limited] })).toBe("not_applied");
		// Anything else may have been applied.
		expect(judged(400, { errors: [error] })).toBe("unknown");
		expect(judged(200, { data: null, errors: [malformed] })).toBe("unknown");
		expect(judged(200, { data: null, errors: [error] })).toBe("unknown");
		expect(judged(200, { data: { issueCreate: { success: false } } })).toBe("unknown");
		// A body that is not a JSON object says nothing: only authentication and rate limits refuse before running.
		expect(judged(200, "<html>")).toBe("unknown");
		expect(judged(400, "<html>")).toBe("unknown");
		expect(judged(502, "<html>")).toBe("unknown");
		expect(judged(400, "[]")).toBe("unknown");
		expect(judged(401, "<html>")).toBe("not_applied");
		expect(judged(429, "")).toBe("not_applied");
	});

	test("team chains beyond the limit are partial", () => {
		const chain = (levels: number): TeamRef => {
			let team: TeamRef = { id: uuid(1000), parent: null };
			for (let n = 0; n < levels; n++) team = { id: uuid(n + 1), parent: team };
			return team;
		};
		let [within, partial] = ancestry(chain(MAX_TEAM_DEPTH));
		expect([within.length, partial]).toEqual([MAX_TEAM_DEPTH, false]);
		[within, partial] = ancestry(chain(MAX_TEAM_DEPTH + 1));
		expect([within.length, partial]).toEqual([MAX_TEAM_DEPTH, true]);
		// A cycle, or a parent that is not a team id, ends the chain as partial.
		const loop: TeamRef = { id: uuid(1), parent: { id: uuid(2), parent: { id: uuid(1).toUpperCase(), parent: null } } };
		expect(ancestry(loop)).toEqual([[uuid(2)], true]);
		expect(ancestry({ id: uuid(1), parent: { id: "not-a-team", parent: null } })).toEqual([[], true]);
	});
});
