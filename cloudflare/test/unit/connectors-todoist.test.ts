// The Todoist connector against scripted Todoist answers behind an injected `fetch`: the declaration and
// its pinned fingerprints, the inputs each tool accepts, the requests each call sends, what the model sees
// of Todoist's answers, how errors and write outcomes map, paging, discovery and describe, and the OAuth
// requests the declaration makes. Runs through the executor are in connectors-todoist-executor.test.ts.

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import type { TodoistClient } from "../../src/connectors/todoist/client.ts";
import { MAX_PROJECT_PAGES, TOO_MANY_PROJECTS, todoistConnector } from "../../src/connectors/todoist/connector.ts";
import { type Connector, OperationError, type ProviderOutput, type Requirement, binding, termsOf } from "../../src/gateway/connector.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { CallIo, settingsIo } from "../../src/gateway/http.ts";
import { Registry, inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { allowedOut, consentNeeded, kindsOut, requestedScopes } from "../../src/workspace/out.ts";
import { FakeTodoist, TODOIST } from "./executor-fakes.ts";

const TOKEN = "test-token";
const API = "https://api.todoist.com/api/v1";

/** An answer: a status and a body (JSON unless it is a string). */
type Answer = [status: number, body?: Json | string];

interface Sent {
	method: string;
	/** The address without its query. */
	url: string;
	query: [string, string][];
	authorization: string | null;
	contentType: string | null;
	body: Json | null;
}

/** Serves the answers in order and records what was sent. */
function scripted(...answers: Answer[]) {
	const queue = [...answers];
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		sent.push({
			method: request.method,
			url: `${url.origin}${url.pathname}`,
			query: [...url.searchParams],
			authorization: request.headers.get("authorization"),
			contentType: request.headers.get("content-type"),
			body: text ? (JSON.parse(text) as Json) : null,
		});
		const next = queue.shift();
		if (next === undefined) throw new Error("No answer left.");
		const [status, body = {}] = next;
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	};
	return { fetch, sent };
}

function project(id: string, name = id) {
	return { id, name };
}

function task(id: string, fields: { [key: string]: Json } = {}) {
	return { id, project_id: "work", content: `Task ${id}`, ...fields };
}

function projectPage(results: { [key: string]: Json }[], next_cursor: string | null = null) {
	return { results, next_cursor };
}

async function raised(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("Nothing was raised.");
}

function client(fetch: typeof globalThis.fetch): TodoistClient {
	return todoistConnector().client(TOKEN, settingsIo(fetch));
}

interface Called {
	requirements?: Requirement[];
	/** Requests sent before execute, by prepare. */
	prepared?: number;
	effect?: string;
	output?: ProviderOutput;
	error?: { code: string; message: string };
}

/** One operation, as the executor calls it: the input validated, prepare, then execute (in a write attempt when it mutates). */
async function call(name: string, args: Json, fetch: typeof globalThis.fetch): Promise<Called> {
	const connector = todoistConnector();
	const op = connector.operations.find((item) => item.name === name);
	if (op === undefined) throw new Error(`No operation ${name}`);
	const validated = await validateInput(op.input as never, args);
	if (!validated.ok) throw new Error(validated.message);
	let requests = 0;
	const counted: typeof globalThis.fetch = (input, init) => {
		requests++;
		return fetch(input, init);
	};
	const io = new CallIo({ fetch: counted, now: () => performance.now(), admits: () => true });
	const todoist = connector.client(TOKEN, io);
	const called: Called = {};
	try {
		const prepared = await op.prepare(binding(TODOIST, todoist), validated.data as never);
		called.requirements = prepared.requirements;
		called.prepared = requests;
		if (termsOf(op).mutates) {
			const attempt = io.openWrite(io.now() + 60_000);
			try {
				called.output = await prepared.execute();
			} finally {
				called.effect = attempt.outcome();
			}
		} else {
			called.output = await prepared.execute();
		}
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		called.error = { code: error.code, message: error.message };
	} finally {
		io.close();
		await todoist.close();
	}
	return called;
}

/** The records' data and the project each is filed under. */
function records(output: ProviderOutput | undefined): [string, { [key: string]: Json }][] {
	return (output?.records ?? []).map((record) => [record.resource.id, record.data]);
}

const UNEXPECTED = { code: "PROVIDER_FAILED", message: "Todoist returned an unexpected response." };
const DENIED = { code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." };

/** How Todoist's error statuses read. */
const ERRORS: [status: number, error: { code: string; message: string }][] = [
	[400, { code: "PROVIDER_REJECTED", message: "Todoist rejected this request." }],
	[401, { code: "CONNECTION_UNAUTHORIZED", message: "The Todoist connection is no longer authorized." }],
	[403, { code: "PROVIDER_FORBIDDEN", message: "Todoist refused this request for the connected account." }],
	[404, { code: "NOT_FOUND", message: "Todoist did not find this object." }],
	[429, { code: "PROVIDER_RATE_LIMITED", message: "Todoist is rate limiting requests. Try again later." }],
	[500, { code: "PROVIDER_FAILED", message: "Todoist could not complete this request." }],
	[302, { code: "PROVIDER_FAILED", message: "Todoist could not complete this request." }],
];

describe("the declaration", () => {
	test("one wildcard kind, projects, read and create, and OAuth with dynamic client registration", () => {
		const connector = todoistConnector();
		expect(kindsOut(connector)).toEqual([
			{ id: "project", label: "Project", actions: ["read", "create"], wildcard: true, hierarchical: false, note: null, listed: true, browsable: false },
		]);
		expect(connector.actions).toEqual([
			{ id: "read", label: "Read tasks" },
			{ id: "create", label: "Create tasks", requires: "read" },
		]);
		expect(connector.auth).toEqual({
			type: "oauth2",
			app: "todoist",
			authorizeUrl: "https://app.todoist.com/oauth/authorize",
			tokenUrl: "https://api.todoist.com/oauth/access_token",
			scopes: ["data:read_write"],
			registrationUrl: "https://api.todoist.com/oauth/register",
		});
		expect(connector.operations.map((op) => [op.name, termsOf(op).mutates, termsOf(op).paginated])).toEqual([
			["list_projects", false, false],
			["list_tasks", false, true],
			["get_task", false, false],
			["create_task", true, false],
		]);
	});

	test("the registry accepts it, and its fingerprints are pinned", async () => {
		const connector = todoistConnector();
		const registry = await Registry.create([connector]);
		const fingerprints = Object.fromEntries(connector.operations.map((op) => [op.name, registry.contract("todoist", op.name)]));
		console.log("todoist fingerprints", fingerprints);
		// A change here changes what running runs' tools mean (OPERATION_CHANGED): bump `revision` when the
		// meaning changed in a way the declaration does not show.
		expect(fingerprints).toEqual({
			list_projects: "8026cbf5f0ddf383",
			list_tasks: "e8de31e4a0c529ba",
			get_task: "3d832520b30d6475",
			create_task: "244c844d8ef572cd",
		});
	});

	test("it is registered, and the registered connectors validate together", async () => {
		const registry = await Registry.create(CONNECTORS);
		expect(registry.find("todoist")?.name).toBe("Todoist");
	});

	test("input schemas are zod's, without titles", () => {
		const schema = inputSchema(todoistConnector().operations[1] as never);
		expect(JSON.stringify(schema)).not.toContain('"title"');
		expect(Object.keys(schema.properties as object)).toEqual(["project_id", "search", "limit", "cursor"]);
		expect(schema.additionalProperties).toBe(false);
	});
});

describe("inputs", () => {
	async function accepted(name: string, args: Json): Promise<unknown> {
		const op = todoistConnector().operations.find((item) => item.name === name);
		const result = await validateInput(op?.input as never, args);
		return result.ok ? result.data : `refused: ${result.message}`;
	}

	test("ids, search text and titles are trimmed, and defaults filled in", async () => {
		expect(await accepted("list_tasks", { project_id: " work " })).toEqual({ project_id: "work", search: null, limit: 30, cursor: null });
		expect(await accepted("list_tasks", { project_id: "w_1-x", search: "  milk ", limit: 50, cursor: " c2 " })).toEqual({
			project_id: "w_1-x",
			search: "milk",
			limit: 50,
			cursor: "c2",
		});
		expect(await accepted("get_task", { task_id: "\tt1\n" })).toEqual({ task_id: "t1" });
		expect(await accepted("create_task", { project_id: "work", title: " Buy milk " })).toEqual({ project_id: "work", title: "Buy milk" });
		expect(await accepted("list_projects", {})).toEqual({});
	});

	test("what does not fit is refused", async () => {
		for (const [name, args] of [
			["list_projects", { extra: 1 }],
			["list_tasks", {}],
			["list_tasks", { project_id: "" }],
			["list_tasks", { project_id: "   " }],
			["list_tasks", { project_id: "a/b" }],
			["list_tasks", { project_id: "a b" }],
			["list_tasks", { project_id: "x".repeat(161) }],
			["list_tasks", { project_id: 12 }],
			["list_tasks", { project_id: "work", search: "  " }],
			["list_tasks", { project_id: "work", search: "x".repeat(201) }],
			["list_tasks", { project_id: "work", limit: 0 }],
			["list_tasks", { project_id: "work", limit: 51 }],
			["list_tasks", { project_id: "work", limit: 2.5 }],
			["list_tasks", { project_id: "work", limit: "5" }],
			["list_tasks", { project_id: "work", cursor: "c".repeat(301) }],
			["list_tasks", { project_id: "work", connection_id: "other" }],
			["get_task", { task_id: "../projects" }],
			["create_task", { project_id: "work" }],
			["create_task", { project_id: "work", title: " " }],
			["create_task", { project_id: "work", title: "x".repeat(301) }],
			["create_task", { project_id: "work", title: "x", due: "today" }],
		] as [string, Json][]) {
			expect(await accepted(name, args), JSON.stringify([name, args])).toMatch(/^refused: Invalid arguments\./);
		}
	});
});

describe("the account", () => {
	test("is Todoist's user id, labelled by the full name, else the email, else Todoist", async () => {
		const connector = todoistConnector();
		const script = scripted([200, { id: "u1", full_name: "Ada", email: "ada@example.com" }], [200, { id: "u1", full_name: "", email: "ada@example.com" }], [200, { id: "u1", full_name: null }], [200, { id: "u1" }]);
		const todoist = client(script.fetch);
		expect(await connector.account(todoist)).toEqual({ id: "u1", label: "Ada" });
		expect(await connector.account(todoist)).toEqual({ id: "u1", label: "ada@example.com" });
		expect(await connector.account(todoist)).toEqual({ id: "u1", label: "Todoist" });
		expect(await connector.account(todoist)).toEqual({ id: "u1", label: "Todoist" });
		expect(script.sent[0]).toEqual({ method: "GET", url: `${API}/user`, query: [], authorization: `Bearer ${TOKEN}`, contentType: null, body: null });
	});

	test("an answer of another shape is unexpected; a byte order mark is read", async () => {
		const connector = todoistConnector();
		for (const body of [{ id: 12, full_name: "Ada" }, { id: 1.5 }, { id: true }, { id: "u1", full_name: true }, { full_name: "Ada" }, [], "<html>"] as Json[]) {
			const script = scripted([200, body]);
			expect(await raised(connector.account(client(script.fetch))), JSON.stringify(body)).toEqual(UNEXPECTED);
		}
		const bom = scripted([200, '﻿{"id": "u1", "full_name": "Ada"}']);
		expect(await connector.account(client(bom.fetch))).toEqual({ id: "u1", label: "Ada" });
	});

	test("Todoist's error statuses", async () => {
		for (const [status, error] of ERRORS) {
			const script = scripted([status, { error: "x" }]);
			expect(await raised(todoistConnector().account(client(script.fetch))), String(status)).toEqual(error);
		}
	});
});

describe("discovery and describe", () => {
	test("without a search, Todoist's own pages, its cursor passed back as it is", async () => {
		const connector = todoistConnector();
		const script = scripted([200, projectPage([project("work", "Work"), { id: "home", name: "Home", color: "red", is_favorite: true }], "c2")], [200, projectPage([])], [200, projectPage([], "")]);
		const todoist = client(script.fetch);
		expect(await connector.discover(todoist, "project", { query: null, cursor: null })).toEqual({
			items: [
				{ id: "work", name: "Work" },
				{ id: "home", name: "Home" },
			],
			nextCursor: "c2",
		});
		expect(await connector.discover(todoist, "project", { query: null, cursor: "a b&c=d/é+~*" })).toEqual({ items: [], nextCursor: null });
		expect(await connector.discover(todoist, "project", { query: "", cursor: "" })).toEqual({ items: [], nextCursor: "" });
		expect(script.sent.map((sent) => [sent.url, sent.query])).toEqual([
			[`${API}/projects`, [["limit", "200"]]],
			[`${API}/projects`, [["limit", "200"], ["cursor", "a b&c=d/é+~*"]]],
			[`${API}/projects`, [["limit", "200"]]],
		]);
	});

	test("a search reads every page and matches names ignoring case; the cursor is ignored", async () => {
		const script = scripted([200, projectPage([project("w", "Work"), project("h", "Home")], "p2")], [200, projectPage([project("o", "Org chart"), project("x", "WORKSHOP")])]);
		const page = await todoistConnector().discover(client(script.fetch), "project", { query: "OR", cursor: "ignored" });
		expect(page).toEqual({
			items: [
				{ id: "w", name: "Work" },
				{ id: "o", name: "Org chart" },
				{ id: "x", name: "WORKSHOP" },
			],
			nextCursor: null,
		});
		expect(script.sent.map((sent) => sent.query)).toEqual([[["limit", "200"]], [["limit", "200"], ["cursor", "p2"]]]);
		// An empty cursor ends the listing.
		const ended = scripted([200, projectPage([project("w", "Work")], "")]);
		expect((await todoistConnector().discover(client(ended.fetch), "project", { query: "w", cursor: null })).items).toEqual([{ id: "w", name: "Work" }]);
	});

	test("an account with more projects than Minerva lists is refused, whatever reads them all", async () => {
		const pages = () => Array.from({ length: MAX_PROJECT_PAGES }, (_, i): Answer => [200, projectPage([project(`id${i}`)], `c${i + 1}`)]);
		const limit = { code: "PROVIDER_LIMIT", message: TOO_MANY_PROJECTS };
		const connector = todoistConnector();
		let script = scripted(...pages());
		expect(await raised(connector.discover(client(script.fetch), "project", { query: "id", cursor: null }))).toEqual(limit);
		expect(script.sent).toHaveLength(MAX_PROJECT_PAGES);
		script = scripted(...pages());
		expect(await raised(connector.describe(client(script.fetch), "project", ["id0"]))).toEqual(limit);
		expect((await call("list_projects", {}, scripted(...pages()).fetch)).error).toEqual(limit);
		// Twenty pages that end are read whole.
		const twenty = pages();
		twenty[MAX_PROJECT_PAGES - 1] = [200, projectPage([project("last")])];
		expect((await connector.discover(client(scripted(...twenty).fetch), "project", { query: "last", cursor: null })).items).toEqual([{ id: "last", name: "last" }]);
	});

	test("answers of another shape are unexpected, and errors keep their meaning", async () => {
		for (const body of [
			projectPage([{ id: 1, name: "Work" }]),
			projectPage([{ id: "w", name: "Work", parent_id: 7 }]),
			{ next_cursor: null },
			{ results: [], next_cursor: 3 },
		] as Json[]) {
			const script = scripted([200, body]);
			expect(await raised(todoistConnector().discover(client(script.fetch), "project", { query: null, cursor: null })), JSON.stringify(body)).toEqual(UNEXPECTED);
		}
		expect(await raised(todoistConnector().discover(client(scripted([403]).fetch), "project", { query: null, cursor: null }))).toMatchObject({ code: "PROVIDER_FORBIDDEN" });
		const failing = scripted([200, projectPage([project("w")], "c2")], [500]);
		expect(await raised(todoistConnector().discover(client(failing.fetch), "project", { query: "w", cursor: null }))).toMatchObject({ code: "PROVIDER_FAILED" });
	});

	test("describe names only the projects the account has, the last name of a repeated id, and keeps prototype names as keys", async () => {
		const connector = todoistConnector();
		const script = scripted([200, projectPage([project("work", "Work"), project("private", "Private")], "c2")], [200, projectPage([project("work", "Work, renamed")])]);
		expect(await connector.describe(client(script.fetch), "project", ["work", "missing"])).toEqual({ work: "Work, renamed" });
		const nothing = scripted([200, projectPage([project("work")])]);
		expect(await connector.describe(client(nothing.fetch), "project", [])).toEqual({});
		const proto = scripted([200, projectPage([project("__proto__", "Proto"), project("constructor", "Builder")])]);
		const names = await connector.describe(client(proto.fetch), "project", ["__proto__", "constructor"]);
		expect(Object.getPrototypeOf(names)).toBe(Object.prototype);
		expect(Object.hasOwn(names, "__proto__")).toBe(true);
		expect([names.__proto__, names.constructor]).toEqual(["Proto", "Builder"]);
	});
});

describe("list_projects", () => {
	test("enumerates the readable projects across Todoist's pages", async () => {
		const script = scripted([200, projectPage([project("work", "Work")], "c2")], [200, projectPage([project("home", "Home")])]);
		const called = await call("list_projects", {}, script.fetch);
		expect(called.requirements).toEqual([{ enumerate: "project", action: "read" }]);
		expect(called.prepared).toBe(0);
		expect(records(called.output)).toEqual([
			["work", { id: "work", name: "Work" }],
			["home", { id: "home", name: "Home" }],
		]);
		const unauthorized = await call("list_projects", {}, scripted([401]).fetch);
		expect(unauthorized.error?.code).toBe("CONNECTION_UNAUTHORIZED");
	});
});

describe("list_tasks", () => {
	test("reads one project's tasks after it is authorized, with Todoist's cursor", async () => {
		const answer = {
			results: [
				task("t1", { content: "Ship it", priority: 4, description: "Before Friday", checked: false }),
				task("t2", { due: { date: "2026-10-20", string: "every Tuesday" } }),
				task("t3", { due: { date: "2026-10-21", string: "" }, checked: true }),
				task("t4", { due: { date: "2026-10-22" }, unknown: [1] }),
			],
			next_cursor: "n2",
		};
		const script = scripted([200, answer], [200, { results: [] }]);
		const called = await call("list_tasks", { project_id: "work" }, script.fetch);
		expect(called.requirements).toEqual([{ need: expect.objectContaining({ kind: "project", id: "work" }), action: "read" }]);
		expect(called.prepared).toBe(0);
		expect(records(called.output)).toEqual([
			["work", { id: "t1", project_id: "work", title: "Ship it", description: "Before Friday", priority: 4, due: null, completed: false }],
			["work", { id: "t2", project_id: "work", title: "Task t2", description: "", priority: 1, due: "every Tuesday", completed: false }],
			["work", { id: "t3", project_id: "work", title: "Task t3", description: "", priority: 1, due: "2026-10-21", completed: true }],
			["work", { id: "t4", project_id: "work", title: "Task t4", description: "", priority: 1, due: "2026-10-22", completed: false }],
		]);
		expect(called.output?.nextCursor).toBe("n2");
		const next = await call("list_tasks", { project_id: "work", limit: 2, cursor: "n2" }, script.fetch);
		expect(next.output?.nextCursor).toBeNull();
		expect(script.sent.map((sent) => [sent.method, sent.url, sent.query])).toEqual([
			["GET", `${API}/tasks`, [["project_id", "work"], ["limit", "30"]]],
			["GET", `${API}/tasks`, [["project_id", "work"], ["limit", "2"], ["cursor", "n2"]]],
		]);
		expect(script.sent.every((sent) => sent.authorization === `Bearer ${TOKEN}`)).toBe(true);
	});

	test("a search uses Todoist's filter without its operators, and keeps to the project", async () => {
		const script = scripted(
			[200, { results: [task("t1", { content: "Ship it" }), task("t9", { project_id: "private", content: "Ship secretly" })], next_cursor: "f2" }],
			[200, { results: [] }],
			[200, { results: [] }],
		);
		const found = await call("list_tasks", { project_id: "work", search: "Ship & it (now)!" }, script.fetch);
		expect(records(found.output).map(([projectId, data]) => [projectId, data.id])).toEqual([["work", "t1"]]);
		expect(found.output?.nextCursor).toBe("f2");
		await call("list_tasks", { project_id: "work", search: "a&b|c!d(e)f#g@h,i\\j", limit: 5, cursor: "f2" }, script.fetch);
		await call("list_tasks", { project_id: "work", search: "  #@ " }, script.fetch);
		expect(script.sent.map((sent) => [sent.url, sent.query])).toEqual([
			[`${API}/tasks/filter`, [["query", "search: Ship   it  now"], ["limit", "30"]]],
			[`${API}/tasks/filter`, [["query", "search: a b c d e f g h i j"], ["limit", "5"], ["cursor", "f2"]]],
			[`${API}/tasks/filter`, [["query", "search: "], ["limit", "30"]]],
		]);
	});

	test("tasks of another shape make the answer unexpected", async () => {
		const { content: _, ...withoutContent } = task("t1");
		const odd: Json[] = [
			withoutContent,
			...([
				{ description: null },
				{ priority: 1.5 },
				{ priority: "4" },
				{ priority: 2.0, checked: 1 },
				{ checked: "true" },
				{ checked: 2 },
				{ due: "tomorrow" },
				{ due: { string: "tomorrow" } },
				{ id: 1 },
			] as { [key: string]: Json }[]).map((fields) => task("t1", fields)),
		];
		for (const answer of odd) {
			const script = scripted([200, { results: [answer] }]);
			expect((await call("list_tasks", { project_id: "work" }, script.fetch)).error, JSON.stringify(answer)).toEqual(UNEXPECTED);
		}
	});

	test("Todoist's errors keep their meaning", async () => {
		expect((await call("list_tasks", { project_id: "work" }, scripted([404]).fetch)).error?.code).toBe("NOT_FOUND");
		expect((await call("list_tasks", { project_id: "work" }, scripted([503]).fetch)).error?.code).toBe("PROVIDER_FAILED");
	});
});

describe("get_task", () => {
	test("fetches the task in prepare and needs its own project", async () => {
		const script = scripted([200, task("t2", { project_id: "private", content: "Secret" })]);
		const called = await call("get_task", { task_id: "t2" }, script.fetch);
		expect(called.prepared).toBe(1);
		expect(called.requirements).toEqual([{ need: expect.objectContaining({ kind: "project", id: "private" }), action: "read" }]);
		expect(records(called.output)).toEqual([["private", { id: "t2", project_id: "private", title: "Secret", description: "", priority: 1, due: null, completed: false }]]);
		expect(script.sent.map((sent) => [sent.method, sent.url])).toEqual([["GET", `${API}/tasks/t2`]]);
	});

	test("a missing or forbidden task, or an answer about another, is refused as an ungranted one", async () => {
		expect((await call("get_task", { task_id: "missing" }, scripted([404]).fetch)).error).toEqual(DENIED);
		expect((await call("get_task", { task_id: "t1" }, scripted([403]).fetch)).error).toEqual(DENIED);
		expect((await call("get_task", { task_id: "t1" }, scripted([200, task("t2")]).fetch)).error).toEqual(DENIED);
		// Other failures are what they are.
		for (const [status, code] of [
			[401, "CONNECTION_UNAUTHORIZED"],
			[429, "PROVIDER_RATE_LIMITED"],
			[500, "PROVIDER_FAILED"],
		] as const) {
			expect((await call("get_task", { task_id: "t1" }, scripted([status]).fetch)).error?.code, String(status)).toBe(code);
		}
		expect((await call("get_task", { task_id: "t1" }, scripted([200, { id: "t1" }]).fetch)).error).toEqual(UNEXPECTED);
	});
});

describe("create_task", () => {
	test("sends nothing in prepare and one POST in execute; the record carries the project Todoist used", async () => {
		const script = scripted([200, task("t9", { content: "Buy milk" })], [200, task("t10", { project_id: "inbox", content: "Buy milk" })], [200, task("t11", { content: 'Café ☕ 🎉 "q" \\' })]);
		const created = await call("create_task", { project_id: "work", title: "Buy milk" }, script.fetch);
		expect(created.prepared).toBe(0);
		expect(created.requirements).toEqual([{ need: expect.objectContaining({ kind: "project", id: "work" }), action: "create" }]);
		expect(created.effect).toBe("applied");
		expect(records(created.output)).toEqual([["work", { id: "t9", project_id: "work", title: "Buy milk", description: "", priority: 1, due: null, completed: false }]]);
		const elsewhere = await call("create_task", { project_id: "work", title: "Buy milk" }, script.fetch);
		expect(records(elsewhere.output).map(([projectId]) => projectId)).toEqual(["inbox"]);
		const unicode = await call("create_task", { project_id: "work", title: ' Café ☕ 🎉 "q" \\ ' }, script.fetch);
		expect(records(unicode.output)[0]?.[1].title).toBe('Café ☕ 🎉 "q" \\');
		expect(script.sent.map((sent) => [sent.method, sent.url, sent.body])).toEqual([
			["POST", `${API}/tasks`, { project_id: "work", content: "Buy milk" }],
			["POST", `${API}/tasks`, { project_id: "work", content: "Buy milk" }],
			["POST", `${API}/tasks`, { project_id: "work", content: 'Café ☕ 🎉 "q" \\' }],
		]);
		expect(script.sent.every((sent) => sent.authorization === `Bearer ${TOKEN}` && sent.contentType === "application/json")).toBe(true);
	});

	test("a refused write is not applied, a failed one is uncertain, and an applied one stays applied when its answer is odd", async () => {
		for (const [status, code, effect] of [
			[400, "PROVIDER_REJECTED", "not_applied"],
			[401, "CONNECTION_UNAUTHORIZED", "not_applied"],
			[403, "PROVIDER_FORBIDDEN", "not_applied"],
			[418, "PROVIDER_REJECTED", "unknown"],
			[500, "PROVIDER_FAILED", "unknown"],
		] as const) {
			const called = await call("create_task", { project_id: "work", title: "x" }, scripted([status, { error: "x" }]).fetch);
			expect([called.error?.code, called.effect], String(status)).toEqual([code, effect]);
		}
		for (const body of ["<html>", { id: "t9" }] as Json[]) {
			const called = await call("create_task", { project_id: "work", title: "x" }, scripted([200, body]).fetch);
			expect([called.error, called.effect], JSON.stringify(body)).toEqual([UNEXPECTED, "applied"]);
		}
	});

	test("a write outside execute is refused before it is sent", async () => {
		const script = scripted();
		await expect(client(script.fetch).createTask("work", "x")).rejects.toThrow("Provider writes are only allowed in the execute step of a mutating operation.");
		expect(script.sent).toEqual([]);
	});
});

describe("the settings page", () => {
	test("discovery of seen projects only, against the in-memory Todoist", async () => {
		const connector = todoistConnector();
		const todoist = new FakeTodoist();
		const settings = connector.client(TOKEN, settingsIo(todoist.fetch));
		expect(todoist.calls).toEqual([]);
		expect((await connector.discover(settings, "project", { query: null, cursor: null })).items[0]).toEqual({ id: "work", name: "Work" });
		// A grant on a project the account cannot see is refused: describe leaves it out.
		expect(await connector.describe(settings, "project", ["work", "elsewhere"])).toEqual({ work: "Work" });
	});

	test("connections summarize what the user allows", () => {
		const row = (resourceId: string, resourceName: string, actions: string[]): GrantRow => ({
			layer: "user",
			subject: "user",
			connectionId: TODOIST,
			kind: "project",
			resourceId,
			resourceName,
			actions,
			effect: "allow",
		});
		expect(allowedOut(todoistConnector(), [row("*", "", ["read"]), row("work", "Work", ["create", "read"])])).toEqual([
			{ kind: "project", kindLabel: "Project", action: "read", actionLabel: "Read tasks", all: true, count: 1, names: ["Work"] },
			{ kind: "project", kindLabel: "Project", action: "create", actionLabel: "Create tasks", all: false, count: 1, names: ["Work"] },
		]);
	});
});

describe("OAuth with the declaration's endpoints", () => {
	const connector: Connector = todoistConnector();
	const auth = connector.auth as Extract<Connector["auth"], { type: "oauth2" }>;

	test("its one scope is requested whatever is allowed, and no consent is ever missing", () => {
		expect(requestedScopes(connector, new Set(["read", "create"]))).toEqual(["data:read_write"]);
		expect(consentNeeded(connector, [], new Set(["read", "create"]))).toEqual([]);
	});

	test("token requests are forms with the client first in the body", async () => {
		const init = tokenRequest(auth, { clientId: "id", clientSecret: "secret", redirectUri: "https://minerva.example/api/oauth/todoist/callback" }, [
			["grant_type", "authorization_code"],
			["code", "c"],
		]);
		expect(init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
		expect(init.body).toBe("client_id=id&client_secret=secret&grant_type=authorization_code&code=c");
		expect(init.redirect).toBe("manual");
	});

	test("Todoist's token answers: no scopes, and the legacy ten-year expiry is no expiry", () => {
		const now = Date.UTC(2026, 9, 11);
		const noExpiry = { kind: "oauth2", access_token: "a", refresh_token: null, scopes: null };
		expect(tokenPayload({ access_token: "a", token_type: "Bearer" }, now)).toEqual(noExpiry);
		expect(tokenPayload({ access_token: "a", token_type: "Bearer", expires_in: 315_360_000 }, now)).toEqual(noExpiry);
		expect(tokenPayload({ access_token: "a", expires_in: 3600, scope: "data:read_write" }, now)).toEqual({
			kind: "oauth2",
			access_token: "a",
			refresh_token: null,
			scopes: ["data:read_write"],
			expires_at: now / 1000 + 3600,
		});
	});
});
