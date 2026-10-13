// The Sentry connector against an in-memory Sentry API (test/fixtures/connectors/sentry/fake.ts, behind an
// injected `fetch`), and runs through the executor. Also: the registry accepts the declaration, with its
// fingerprints printed and pinned, and the Worker serves it; describe reads the organisation once and at
// most eight projects at a time; the rules for inputs, Link headers and what an event shows.

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { Issue, Project, type SentryClient, linkCursor, nextCursor } from "../../src/connectors/sentry/client.ts";
import { requestAddress } from "../../src/connectors/sentry/address.ts";
import { CONCURRENCY, sentryConnector } from "../../src/connectors/sentry/connector.ts";
import { numberOf, short } from "../../src/connectors/sentry/reads.ts";
import { type Connector, OperationError, termsOf } from "../../src/gateway/connector.ts";
import type { ToolCallOutcome } from "../../src/gateway/executor.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { utf8 } from "../../src/lib/bytes.ts";
import type { Json } from "../../src/lib/json.ts";
import type { z } from "zod";
import type { ConnectionId } from "../../src/shared/rpc.ts";
import { tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { consentNeeded, kindsOut, requestedScopes } from "../../src/workspace/out.ts";
import { FakeSentry, LEAKS, PAYROLL, SCOPES, SECRET, type SentryObject, TOKEN, WEB, event } from "../fixtures/connectors/sentry/fake.ts";
import { Scenario, userGrants } from "./executor-fakes.ts";

const SENTRY: ConnectionId = "0199a000-0000-7000-8000-0000000000e1";
const registry = await Registry.create([sentryConnector()]);

type Ok = Extract<ToolCallOutcome, { ok: true }>;

/** Starts and claims a run with the user's grants ({project: actions}) on the Sentry connection. */
function start(sentry: FakeSentry, grants: { [project: string]: string[] }, ceiling: GrantRow[] = []): Promise<Scenario> {
	return Scenario.start({
		connectors: [sentryConnector()],
		registry,
		connections: [{ id: SENTRY, provider: "sentry", payload: { kind: "oauth2", access_token: TOKEN, refresh_token: null, scopes: SCOPES } }],
		user: userGrants(SENTRY, "project", grants),
		ceiling,
		fetch: sentry.fetch,
	});
}

/** A grant of the workspace ceiling on the Sentry connection. */
function ceiling(kind: string, resourceId: string, effect: GrantRow["effect"], actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: SENTRY, kind, resourceId, resourceName: "", actions, effect };
}

/** A client of the connector on the fake, as a connection's settings use it. */
function clientOf(sentry: FakeSentry): SentryClient {
	return sentryConnector().client(TOKEN, settingsIo(sentry.fetch));
}

function items(outcome: Ok): { [key: string]: Json }[] {
	return outcome.result.items;
}

async function raised(promise: Promise<unknown>): Promise<OperationError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error;
		throw error;
	}
	throw new Error("Nothing was raised.");
}

function sortedPairs(pairs: Iterable<[string, string]>): [string, string][] {
	return [...pairs].sort((a, b) => (a.join("=") < b.join("=") ? -1 : 1));
}

describe("the declaration", () => {
	test("the registry accepts it, and its fingerprints are pinned", async () => {
		expect(() => validate([sentryConnector()])).not.toThrow();
		const fingerprints = Object.fromEntries(sentryConnector().operations.map((op) => [op.name, registry.contract("sentry", op.name)]));
		console.log("sentry fingerprints", fingerprints);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		// Bump `revision` when the meaning changed in a way the declaration does not show.
		expect(fingerprints).toEqual({
			list_projects: "f7998df895acaf81",
			search_issues: "5749928219c1557e",
			get_issue: "438629c3b7a0dcf4",
			get_issue_event: "8e83f5f420b35434",
		});
	});

	test("the Worker's registry serves it", async () => {
		expect(CONNECTORS.map((connector) => connector.slug)).toContain("sentry");
		const served = await connectorRegistry();
		for (const op of served.get("sentry").operations) expect(served.contract("sentry", op.name)).toBe(registry.contract("sentry", op.name));
	});

	test("what Minerva may reach is managed in Sentry", () => {
		expect(sentryConnector().manageLink?.()).toEqual(["Sentry authorized applications", "https://sentry.io/settings/account/api/authorizations/"]);
	});

	test("reading needs the read scopes", () => {
		const connector = registry.get("sentry");
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Sentry connects through OAuth.");
		expect(auth.scopes).toEqual(["org:read", "project:read", "event:read"]);
		expect([auth.clientAuth ?? "post", auth.pkce ?? true]).toEqual(["post", true]);
		expect(connector.operations.every((op) => !termsOf(op).mutates)).toBe(true);
	});
});

// Connecting and discovery

describe("connecting and discovery", () => {
	test("the account is the user in the organisation", async () => {
		const sentry = new FakeSentry();
		const connector = sentryConnector();
		const account = await connector.account(clientOf(sentry));
		expect([account.id, account.label]).toEqual(["7:42", "Ada Lovelace (ada@example.com) \u00b7 Acme"]);
		sentry.user = { id: "42" };
		expect((await connector.account(clientOf(sentry))).label).toBe("Acme");
		sentry.user = { id: "42", name: "  \t " };
		expect((await connector.account(clientOf(sentry))).label).toBe("Acme");
		sentry.user = { id: "42", name: " Ada\n  Lovelace ", email: " ada@example.com" };
		expect((await connector.account(clientOf(sentry))).label).toBe("Ada Lovelace ( ada@example.com) \u00b7 Acme");
		sentry.user = { id: "042" };
		expect((await raised(connector.account(clientOf(sentry)))).code).toBe("PROVIDER_FAILED");
		sentry.user = { id: "42" };
		sentry.organisations = [...sentry.organisations, ...sentry.organisations];
		expect((await raised(connector.account(clientOf(sentry)))).code).toBe("UNSUPPORTED_ACCOUNT");
		expect((await raised(clientOf(sentry).projects())).code).toBe("PROVIDER_FAILED");
		expect(sentry.problems).toEqual([]);
	});

	test("calls go to the organisation's region or sentry.io", async () => {
		const sentry = new FakeSentry();
		const client = clientOf(sentry);
		await client.projects();
		await client.project(WEB);
		expect(sentry.requests.map((request) => request.url.hostname)).toEqual(["sentry.io", "de.sentry.io", "de.sentry.io"]);
		// A region Minerva does not know is not trusted with the token.
		for (const region of ["https://evil.example.com", "https://de.sentry.io.evil.example", "http://de.sentry.io", "https://de.sentry.io/", ""]) {
			((sentry.organisations[0] as SentryObject).links as SentryObject).regionUrl = region;
			sentry.requests = [];
			await clientOf(sentry).projects();
			expect(new Set(sentry.requests.map((request) => request.url.hostname))).toEqual(new Set(["sentry.io"]));
		}
		expect(sentry.problems).toEqual([]);
	});

	test("projects are discovered and described", async () => {
		const sentry = new FakeSentry();
		const connector = sentryConnector();
		const client = clientOf(sentry);
		let page = await connector.discover(client, "project", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[WEB, "Web (web)"],
			[PAYROLL, `${SECRET} (payroll)`],
		]);
		expect(page.nextCursor).toBeNull();
		page = await connector.discover(client, "project", { query: "pay", cursor: null });
		expect(page.items.map((item) => item.id)).toEqual([PAYROLL]);
		const sent = sentry.requests.length;
		for (const cursor of ["0:0:0 ", "../x"]) expect((await raised(connector.discover(client, "project", { query: null, cursor }))).code).toBe("INVALID_CURSOR");
		expect(sentry.requests.length).toBe(sent);
		const described = await connector.describe(client, "project", [WEB, WEB, "99", "web", "x/1"]);
		expect(described).toEqual({ [WEB]: "Web (web)" });
		// The organisation is read once per client.
		expect(sentry.requests.filter((request) => request.url.pathname === "/api/0/organizations/").length).toBe(1);
		expect(sentry.problems).toEqual([]);
	});

	test("describe reads the organisation once and at most eight projects at a time", async () => {
		const sentry = new FakeSentry();
		for (let n = 13; n <= 40; n++) sentry.projects.push({ id: String(n), slug: `p${n}` });
		let inFlight = 0;
		let most = 0;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			try {
				return await sentry.fetch(input, init);
			} finally {
				inFlight--;
			}
		};
		const connector = sentryConnector();
		const ids = Array.from({ length: 30 }, (_, n) => String(n + 11));
		const names = await connector.describe(connector.client(TOKEN, settingsIo(fetch)), "project", ids);
		expect(Object.keys(names).length).toBe(30);
		expect(most).toBe(CONCURRENCY);
		expect(sentry.requests.filter((request) => request.url.pathname === "/api/0/organizations/").length).toBe(1);
		expect(sentry.problems).toEqual([]);
	});

	test("only the cursor is taken from a link", () => {
		const link = (value: string) => new Response(null, { headers: { Link: value } });
		const previous = '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1"';
		const following = '<https://elsewhere.example.com/x>; rel="next"; results="true"; cursor="1727:100:0"';
		expect(nextCursor(link(`${previous}, ${following}`))).toBe("1727:100:0");
		expect(nextCursor(link(following.replace('"true"', '"false"')))).toBeNull();
		expect(nextCursor(new Response(null))).toBeNull();
		let caught: unknown = null;
		try {
			nextCursor(link(following.replace("1727:100:0", "x y")));
		} catch (error) {
			caught = error;
		}
		expect(caught instanceof OperationError && caught.code).toBe("PROVIDER_LIMIT");
	});

	test("ids with a final newline are refused", async () => {
		const sentry = new FakeSentry();
		(sentry.projects[0] as SentryObject).id = `${WEB}\n`;
		expect((await raised(clientOf(sentry).projects())).code).toBe("PROVIDER_FAILED");
	});
});

// Projects and issues

describe("projects and issues", () => {
	test("only granted projects are listed or read", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const outcome = await run.ok("sentry_list_projects", {});
		expect(items(outcome)).toEqual([{ id: WEB, slug: "web", name: "Web", platform: "python" }]);
		expect(JSON.stringify(outcome.result)).not.toContain(SECRET);

		sentry.requests = [];
		for (const project of [PAYROLL, "payroll", "missing", "99"]) expect(await run.code("sentry_search_issues", { project })).toBe("POLICY_DENIED");
		for (const issue of ["202", "PAYROLL-202", "999", "NOPE-1"]) {
			expect(await run.code("sentry_get_issue", { issue })).toBe("POLICY_DENIED");
			expect(await run.code("sentry_get_issue_event", { issue })).toBe("POLICY_DENIED");
		}
		expect(sentry.requests.filter((request) => request.url.pathname === "/api/0/organizations/acme/issues/")).toEqual([]);
		expect(sentry.requests.filter((request) => request.url.pathname.includes("/events/"))).toEqual([]);
		expect(sentry.problems).toEqual([]);
	});

	test("all projects respects the ceiling", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { "*": ["read"] }, [ceiling("project", PAYROLL, "deny")]);
		const outcome = await run.ok("sentry_list_projects", {});
		expect(items(outcome).map((project) => project.id)).toEqual([WEB]);
		expect(await run.code("sentry_get_issue", { issue: "202" })).toBe("POLICY_DENIED");
		expect(items(await run.ok("sentry_get_issue", { issue: "web-101" }))[0]?.id).toBe("101");
	});

	test("issues are searched in one project with a query built from fields", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const outcome = await run.ok("sentry_search_issues", { project: "WEB" });
		let params = (sentry.api("issues/").at(-1) as { url: URL }).url.searchParams;
		expect(sortedPairs(params)).toEqual(
			sortedPairs([
				["project", WEB],
				["query", "is:unresolved"],
				["statsPeriod", "14d"],
				["sort", "date"],
				["limit", "10"],
				["collapse", "stats"],
				["collapse", "unhandled"],
			]),
		);
		expect(items(outcome)[0]).toEqual({
			id: "101",
			short_id: "WEB-101",
			title: "ValueError: bad total",
			culprit: "app.views in checkout",
			level: "error",
			status: "unresolved",
			substatus: "ongoing",
			priority: "high",
			events: 150,
			users: 12,
			first_seen: "2026-09-01T10:00:00Z",
			last_seen: "2026-10-02T10:00:00Z",
			platform: "python",
			project: { id: WEB, slug: "web" },
			assignee: { type: "user", name: "Grace" },
			link: "https://acme.sentry.io/issues/101/",
		});

		const args = { project: WEB, text: "bad total", status: "any", level: "fatal", environment: "production", period: "90d", sort: "users", limit: 25 };
		await run.ok("sentry_search_issues", args);
		params = (sentry.api("issues/").at(-1) as { url: URL }).url.searchParams;
		expect(params.get("query")).toBe('level:fatal "bad total"');
		expect([params.get("environment"), params.get("statsPeriod"), params.get("sort")]).toEqual(["production", "90d", "user"]);
		await run.ok("sentry_search_issues", { project: WEB, status: "any" });
		expect((sentry.api("issues/").at(-1) as { url: URL }).url.searchParams.get("query")).toBe("");
		expect(String((sentry.api("issues/").at(-1) as { url: URL }).url)).not.toContain("shortIdLookup");

		const bad: { [key: string]: Json }[] = [
			{ text: 'x" project:payroll "' },
			{ text: "x\\" },
			{ text: "a\nb" },
			{ environment: "prod uction" },
			{ environment: "a/b" },
			{ status: "ignored" },
			{ period: "1y" },
			{ limit: 26 },
			{ query: "is:unresolved" },
			{ project: "../payroll" },
		];
		for (const args of bad) expect(await run.code("sentry_search_issues", { project: WEB, ...args }), JSON.stringify(args)).toBe("INVALID_ARGUMENTS");
		expect(sentry.problems).toEqual([]);
	});

	test("search pages and refuses issues from another project", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const first = await run.ok("sentry_search_issues", { project: WEB, limit: 1 });
		expect(items(first).map((issue) => issue.id)).toEqual(["101"]);
		const args = { project: WEB, limit: 1, cursor: first.result.next_cursor as string };
		const second = await run.ok("sentry_search_issues", args);
		expect(items(second).map((issue) => issue.id)).toEqual(["102"]);
		expect("next_cursor" in second.result).toBe(false);
		expect((sentry.api("issues/").at(-1) as { url: URL }).url.searchParams.get("cursor")).toBe("0:1:0");
		expect(await run.code("sentry_search_issues", { ...args, limit: 2 })).toBe("INVALID_CURSOR");

		sentry.hook = (request) => (request.url.pathname.endsWith("/issues/") ? Response.json({ detail: "Invalid cursor parameter." }, { status: 400 }) : null);
		expect(await run.code("sentry_search_issues", args)).toBe("INVALID_CURSOR");
		expect(await run.code("sentry_search_issues", { project: WEB })).toBe("INVALID_ARGUMENTS");

		// An issue of another project in the answer means it cannot be trusted.
		sentry.hook = (request) => (request.url.pathname.endsWith("/issues/") ? Response.json([sentry.issues[0], sentry.issues[2]]) : null);
		expect(await run.code("sentry_search_issues", { project: WEB })).toBe("PROVIDER_FAILED");
		expect(sentry.problems).toEqual([]);
	});

	test("an issue is read by id or short id", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const byId = await run.ok("sentry_get_issue", { issue: "101" });
		const byShort = await run.ok("sentry_get_issue", { issue: "web-101" });
		expect(items(byId)).toEqual(items(byShort));
		let issue = items(byId)[0] as { [key: string]: Json };
		expect([issue.comments, issue.tags]).toEqual([null, []]);
		expect(JSON.stringify(byId.result)).not.toContain("see PAYROLL");
		expect(JSON.stringify(byId.result)).not.toContain("grace@");

		Object.assign(sentry.issues[0] as SentryObject, {
			firstRelease: { version: "web@1.0" },
			lastRelease: null,
			tags: [
				{ key: "browser", name: "Browser", totalValues: 150 },
				{ key: "customer:ada@example.com", name: "Customer", totalValues: 1 },
			],
			numComments: 2,
			userReportCount: 1,
			permalink: "https://evil.example.com/issues/101/",
		});
		issue = items(await run.ok("sentry_get_issue", { issue: "101" }))[0] as { [key: string]: Json };
		expect([issue.first_release, issue.last_release, issue.comments, issue.user_reports]).toEqual(["web@1.0", null, 2, 1]);
		expect(issue.tags).toEqual([{ key: "browser", name: "Browser", events: 150 }]);
		expect(issue.link).toBeNull();

		for (const bad of ["WEB_101", "web 101", "0101", "-1", ""]) expect(await run.code("sentry_get_issue", { issue: bad }), bad).toBe("INVALID_ARGUMENTS");

		// An issue too large to read is refused like one the account cannot see.
		(sentry.issues[0] as SentryObject).title = "x".repeat(5 * 1024 * 1024);
		expect(await run.code("sentry_get_issue", { issue: "101" })).toBe("POLICY_DENIED");
		expect(sentry.problems).toEqual([]);
	});

	test("an event shows exceptions and leaves out what identifies people", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const outcome = await run.ok("sentry_get_issue_event", { issue: "WEB-101" });
		expect(sentry.requests.at(-1)?.url.pathname).toBe("/api/0/organizations/acme/issues/101/events/latest/");
		const found = items(outcome)[0] as { [key: string]: Json };
		const text = JSON.stringify(outcome.result);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
		expect(Object.fromEntries(["issue", "id", "release", "environment", "request", "contexts", "sdk"].map((key) => [key, found[key]]))).toEqual({
			issue: "101",
			id: "9fac2ceed9344f2bbfdd1fdacb0ed9b1",
			release: "web@1.4.2",
			environment: "production",
			request: { method: "POST", url: "https://shop.example.com:8443/cart" },
			contexts: {
				runtime: { name: "CPython", version: "3.14.0" },
				os: { name: "Linux", version: "6.1" },
			},
			sdk: { name: "sentry.python", version: "2.40.0" },
		});
		expect(found.tags).toEqual({ environment: "production", level: "error", runtime: "CPython 3.14" });
		const [cause, raisedOne] = found.exceptions as { [key: string]: Json }[];
		expect([cause?.type, raisedOne?.type, raisedOne?.value]).toEqual(["KeyError", "ValueError", "bad total"]);
		expect(raisedOne?.mechanism).toEqual({ type: "django", handled: false });
		const frames = raisedOne?.frames as { [key: string]: Json }[];
		expect([raisedOne?.frame_count, raisedOne?.frames_truncated, frames.length]).toEqual([45, true, 40]);
		expect(frames[0]?.function).toBe("fn5");
		expect(frames.at(-1)).toEqual({
			file: "app/f44.py",
			function: "fn44",
			module: "app.f44",
			line: 20,
			column: null,
			in_app: true,
			source: Array.from({ length: 7 }, (_, index) => ({ line: 17 + index, code: `line ${17 + index}`, code_truncated: false })),
		});

		for (const name of ["oldest", "recommended", "9FAC2CEE-D934-4F2B-BFDD-1FDACB0ED9B1"]) await run.ok("sentry_get_issue_event", { issue: "101", event: name });
		expect(sentry.requests.at(-1)?.url.pathname.endsWith("/events/9fac2ceed9344f2bbfdd1fdacb0ed9b1/")).toBe(true);
		// An event other than the one asked for is not shown.
		expect(await run.code("sentry_get_issue_event", { issue: "101", event: "a".repeat(32) })).toBe("NOT_FOUND");
		sentry.answer = "a".repeat(32);
		expect(await run.code("sentry_get_issue_event", { issue: "101", event: "a".repeat(32) })).toBe("PROVIDER_FAILED");
		for (const bad of ["newest", "9fac2cee", "../202"]) expect(await run.code("sentry_get_issue_event", { issue: "101", event: bad }), bad).toBe("INVALID_ARGUMENTS");

		// An event of another issue or project is not shown.
		const odds: SentryObject[] = [{ groupID: "202" }, { projectID: PAYROLL }, { eventID: "../x" }];
		for (const odd of odds) {
			sentry.events["101"] = event(sentry.issues[0] as SentryObject, odd);
			expect(await run.code("sentry_get_issue_event", { issue: "101" }), JSON.stringify(odd)).toBe("PROVIDER_FAILED");
		}
		delete sentry.events["101"];
		expect(await run.code("sentry_get_issue_event", { issue: "101" })).toBe("NOT_FOUND");
		expect(sentry.problems).toEqual([]);
	});

	test("an event of odd shape is shown in what parts fit", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		sentry.events["101"] = event(sentry.issues[0] as SentryObject, {
			entries: [{ type: "exception", data: { values: [{ type: 3, stacktrace: "x" }, "y"] } }, "z"],
			tags: [{ key: ["environment"], value: "x" }, "y"],
			contexts: [],
			sdk: null,
			release: null,
			message: "m".repeat(6000),
		});
		let found = items(await run.ok("sentry_get_issue_event", { issue: "101" }))[0] as { [key: string]: Json };
		expect(found.exceptions).toEqual([
			{ type: null, value: null, value_truncated: false, module: null, mechanism: null, frames: [], frame_count: 0, frames_truncated: false },
		]);
		expect([found.tags, found.contexts, found.release, found.request]).toEqual([{}, {}, null, null]);
		expect(found.message_truncated).toBe(true);
		expect((found.message as string).length).toBe(5000);

		const frames = [
			{ lineNo: 20, context: 42 },
			{ lineNo: 20, context: [...Array.from({ length: 1000 }, () => [20, "x"]), [19, "w"], ["21", "y"], [22, 5]] },
		];
		const exception = { type: "E", mechanism: { type: "generic", handled: { vars: { password: "hunter2" } } }, stacktrace: { frames } };
		const request = { method: "GET", url: "https://u:pw@[2001:db8::1]:8443/cart?token=abc" };
		sentry.events["101"] = event(sentry.issues[0] as SentryObject, {
			entries: [
				{ type: "exception", data: { values: [exception] } },
				{ type: "request", data: request },
			],
		});
		found = items(await run.ok("sentry_get_issue_event", { issue: "101" }))[0] as { [key: string]: Json };
		const shown = (found.exceptions as { [key: string]: Json }[])[0] as { [key: string]: Json };
		expect(shown.mechanism).toEqual({ type: "generic", handled: null });
		expect((shown.frames as { [key: string]: Json }[]).map((frame) => frame.source)).toEqual([
			[],
			[
				{ line: 19, code: "w", code_truncated: false },
				{ line: 20, code: "x", code_truncated: false },
				{ line: 21, code: "y", code_truncated: false },
			],
		]);
		expect((found.request as { [key: string]: Json }).url).toBe("https://[2001:db8::1]:8443/cart");
		expect(sentry.problems).toEqual([]);
	});

	test("an event is read up to 8 MiB, where other responses stop at 4 MiB", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { [WEB]: ["read"] });
		const issue = sentry.issues[0] as SentryObject;
		sentry.events["101"] = event(issue, { padding: "x".repeat(6 * 1024 * 1024) });
		expect(items(await run.ok("sentry_get_issue_event", { issue: "101" }))[0]?.id).toBe("9fac2ceed9344f2bbfdd1fdacb0ed9b1");
		sentry.events["101"] = event(issue, { padding: "x".repeat(9 * 1024 * 1024) });
		expect(await run.code("sentry_get_issue_event", { issue: "101" })).toBe("RESPONSE_TOO_LARGE");
		expect(sentry.problems).toEqual([]);
	});
});

// Rules

describe("rules", () => {
	const connector = sentryConnector();
	const op = (name: string) => connector.operations.find((item) => item.name === name)?.input as z.ZodType;
	const SEARCH = { text: null, status: "unresolved", level: null, environment: null, period: "14d", sort: "last_seen", limit: 10, cursor: null };

	test.each([
		["list_projects", null, { query: null, cursor: null }],
		["list_projects", { query: "  web  ", cursor: " c " }, { query: "web", cursor: "c" }],
		["search_issues", { project: " Web " }, { project: "web", ...SEARCH }],
		["search_issues", { project: "011" }, { project: "011", ...SEARCH }],
		["search_issues", { project: "\u212a" }, { project: "k", ...SEARCH }],
		["search_issues", { project: "web", text: "  it's  ", environment: " production " }, { project: "web", ...SEARCH, text: "it's", environment: "production" }],
		["get_issue", { issue: " web-101 " }, { issue: "WEB-101" }],
		["get_issue_event", { issue: "101" }, { issue: "101", event: "latest" }],
		["get_issue_event", { issue: "101", event: "9FAC2CEE-D934-4F2B-BFDD-1FDACB0ED9B1" }, { issue: "101", event: "9fac2ceed9344f2bbfdd1fdacb0ed9b1" }],
	])("%s normalizes %j, which page tokens' query hashes hash", async (name, input, expected) => {
		expect(await validateInput(op(name), input)).toEqual({ ok: true, data: expected });
	});

	test.each([
		["list_projects", { query: "a\tb" }],
		["list_projects", { cursor: "x".repeat(201) }],
		["list_projects", []],
		["search_issues", { project: "-web" }],
		["search_issues", { project: "\u0130" }],
		["search_issues", { project: "w\u00e9b" }],
		["search_issues", { project: "web", status: "ANY" }],
		["search_issues", { project: "web", environment: "a\ufeffb" }],
		["search_issues", { project: "web", environment: "a\u3000b" }],
		["search_issues", { project: "web", environment: "a\u001cb" }],
		["search_issues", { project: "web", limit: true }],
		["get_issue", { issue: "WEB-" }],
		["get_issue_event", { issue: "101", event: "../latest" }],
	])("%s refuses %j", async (name, input) => {
		expect(await validateInput(op(name), input)).toMatchObject({ ok: false });
	});

	test("the Link header: the first next page with results, its cursor checked", () => {
		const read = (link: string) => {
			try {
				return linkCursor(link);
			} catch (error) {
				if (error instanceof OperationError) return error.code;
				throw error;
			}
		};
		expect(read("")).toBeNull();
		expect(read('<x>;rel="next";results="true";cursor="a"')).toBe("a");
		expect(read('<x>\t;\trel="next"\t;\tresults="true"\t;\tcursor="a"')).toBe("a");
		expect(read('<x>; rel="next"; results="true"; cursor="a"; cursor="b"')).toBe("b");
		expect(read('<x>; rel="next"; results="false"; cursor="a", <y>; rel="next"; results="true"; cursor="b"')).toBe("b");
		expect(read('<x>; rel="next"; results="true"; cursor="a", <y>; rel="next"; results="true"; cursor="b"')).toBe("a");
		expect(read('<x>; rel="next"; results="true"; cursor="1727950000000:0:0"')).toBe("1727950000000:0:0");
		for (const link of ['<x>; REL="next"; results="true"; cursor="a"', '<x>; rel="Next"; results="true"; cursor="a"', '<x>; rel=next; results="true"; cursor="a"', 'rel="next"; results="true"; cursor="a"']) {
			expect(read(link), link).toBeNull();
		}
		for (const cursor of ['', ' cursor=""', ` cursor="${"c".repeat(201)}"`, ' cursor="a/b"', ' cursor="\u00e9"']) {
			expect(read(`<x>; rel="next"; results="true";${cursor}`), cursor).toBe("PROVIDER_LIMIT");
		}
	});

	test("answers that do not fit are unexpected", async () => {
		const base = { id: "101", project: { id: "11" } };
		expect(Issue.parse({ ...base, userCount: 12 }).userCount).toBe(12);
		for (const odd of [{ userCount: "12" }, { userCount: 12.5 }, { userCount: true }, { userCount: 2 ** 53 }, { title: 5 }, { project: { id: 11 } }, { project: null }]) {
			expect(Issue.safeParse({ ...base, ...odd }).success, JSON.stringify(odd)).toBe(false);
		}
		expect(Project.safeParse({ id: 11, slug: "web" }).success).toBe(false);
		const sentry = new FakeSentry();
		// A list sent as an object or a string, or not in UTF-8.
		for (const body of ["{}", '""', Uint8Array.from([0x5b, 0x22, 0xff, 0x22, 0x5d])]) {
			sentry.hook = (request) => (request.url.pathname === "/api/0/organizations/" ? new Response(body) : null);
			expect((await raised(clientOf(sentry).organisations())).code, String(body)).toBe("PROVIDER_FAILED");
		}
		// A byte order mark before the JSON is dropped.
		sentry.hook = (request) => (request.url.pathname === "/api/0/organizations/" ? new Response(utf8("\ufeff[]")) : null);
		expect(await clientOf(sentry).organisations()).toEqual([]);
	});

	test("answers naming another organisation, project or issue are refused", async () => {
		const sentry = new FakeSentry();
		const run = await start(sentry, { "*": ["read"] });
		const answer = (path: string, body: Json) => {
			sentry.hook = (request) => (request.url.pathname === path ? Response.json(body) : null);
		};
		answer("/api/0/organizations/acme/shortids/WEB-101/", { organizationSlug: "other", groupId: "101" });
		expect(await run.code("sentry_get_issue", { issue: "WEB-101" })).toBe("PROVIDER_FAILED");
		answer("/api/0/projects/acme/web/", sentry.projects[1] as Json);
		expect(await run.code("sentry_search_issues", { project: "web" })).toBe("PROVIDER_FAILED");
		answer(`/api/0/projects/acme/${WEB}/`, sentry.projects[1] as Json);
		expect(await run.code("sentry_search_issues", { project: WEB })).toBe("PROVIDER_FAILED");
		// Ids sent as integers count; a fraction does not.
		const issue = sentry.issues[0] as SentryObject;
		answer("/api/0/organizations/acme/issues/101/events/latest/", event(issue, { groupID: 101, projectID: 11 }));
		expect(items(await run.ok("sentry_get_issue_event", { issue: "101" }))[0]?.issue).toBe("101");
		answer("/api/0/organizations/acme/issues/101/events/latest/", event(issue, { groupID: 101.5 }));
		expect(await run.code("sentry_get_issue_event", { issue: "101" })).toBe("PROVIDER_FAILED");
		// An id merged into another issue is read as that issue, and authorized there.
		sentry.hook = (request) => (request.url.pathname === "/api/0/organizations/acme/issues/100/" ? Response.json(sentry.issues[2]) : null);
		const denied = await start(sentry, { [WEB]: ["read"] });
		expect(await denied.code("sentry_get_issue", { issue: "100" })).toBe("POLICY_DENIED");
		expect(sentry.problems).toEqual([]);
	});

	test("a request's address keeps no credentials, query or fragment", () => {
		expect(requestAddress("https://user:secret@Shop.Example.com:8443/cart/../pay?token=t#x")).toBe("https://shop.example.com:8443/pay");
		expect(requestAddress("http://[::1]:80/a b")).toBe("http://[::1]/a%20b");
		for (const value of ["ftp://example.com/", "/relative", "https://exa mple.com/", "https://example.com:99999/", 42, null]) {
			expect(requestAddress(value), JSON.stringify(value)).toBeNull();
		}
	});

	test("numbers and short texts in what Sentry sent", () => {
		for (const [value, number] of [
			[20, 20],
			[-1, -1],
			[9007199254740991, 9007199254740991],
			["020", 20],
			[1.5, null],
			[2 ** 53, null],
			[true, null],
			[" 20", null],
			["-20", null],
			["\u0663", null],
			["111111111111111111111111111111", null],
			[[20], null],
		] as [Json, number | null][]) {
			expect(numberOf(value), JSON.stringify(value)).toBe(number);
		}
		for (const [value, shown] of [
			[null, null],
			[5, null],
			[" \t\n", null],
			[" a  b\nc ", "a b c"],
			["a\ufeffb", "a b"],
		] as [Json, string | null][]) {
			expect(short(value), JSON.stringify(value)).toBe(shown);
		}
		expect(short("x".repeat(501))).toBe("x".repeat(500));
		expect(short("\u{1f600}".repeat(30), 20)).toBe("\u{1f600}".repeat(10));
	});

	test("the kind as the settings page shows it", () => {
		expect(kindsOut(sentryConnector())).toEqual([
			{
				id: "project",
				label: "Project",
				actions: ["read"],
				wildcard: true,
				hierarchical: false,
				note: "Agents read issues and events: stack traces, the source lines around them, and tags.",
				listed: true,
				browsable: false,
			},
		]);
	});
});

// OAuth

describe("OAuth with the declaration's endpoints", () => {
	const connector: Connector = sentryConnector();
	const auth = connector.auth as Extract<Connector["auth"], { type: "oauth2" }>;

	test("the read scopes are requested, joined by spaces, and no operation waits on consent", () => {
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(SCOPES);
		expect(auth.scopes.join(auth.scopeSeparator ?? " ")).toBe("org:read project:read event:read");
		expect(consentNeeded(connector, [], new Set(["read"]))).toEqual([]);
		expect(connector.operations.every((op) => termsOf(op).consent === null)).toBe(true);
	});

	test("token requests are forms with the client first in the body, never Basic", () => {
		const init = tokenRequest(auth, { clientId: "id", clientSecret: "secret", redirectUri: "https://minerva.example/api/oauth/sentry/callback" }, [
			["grant_type", "authorization_code"],
			["code", "c"],
			["code_verifier", "v"],
		]);
		expect(init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
		expect(init.body).toBe("client_id=id&client_secret=secret&grant_type=authorization_code&code=c&code_verifier=v");
	});

	test("Sentry's token answer: its scopes, its refresh token and an expiry from expires_in", () => {
		const now = Date.UTC(2026, 9, 11);
		const body = {
			access_token: "a",
			refresh_token: "r",
			expires_in: 2591999,
			expires_at: "2026-11-10T00:00:00.000000Z",
			token_type: "bearer",
			scope: "org:read project:read event:read",
			user: { id: "42", name: "Ada Lovelace", email: "ada@example.com" },
		};
		expect(tokenPayload(body, now)).toEqual({
			kind: "oauth2",
			access_token: "a",
			refresh_token: "r",
			scopes: ["event:read", "org:read", "project:read"],
			expires_at: now / 1000 + 2591999,
		});
	});
});
