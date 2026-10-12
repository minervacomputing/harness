// backend/tests/test_executor.py, case by case, with the real Todoist connector (src/connectors/todoist/)
// and conftest.py's FakeTodoist (executor-fakes.ts) behind the injected fetch; and the Todoist cases of
// test_gateway.py and test_attempts.py that depend on the connector: the tools a run lists, their
// read-only hints and labels, a write whose attempt is replaced while Todoist applies it, and a task
// Todoist created in a project the run may not read.

import { describe, expect, test } from "vitest";
import type { ToolResult } from "../../src/contracts/executor.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { todoistConnector } from "../../src/connectors/todoist/connector.ts";
import { RESULT_SCHEMA, callToolResult } from "../../src/gateway/results.ts";
import { parseJson } from "../../src/lib/json.ts";
import { FakeTodoist, PROJECT, Scenario, TODOIST, jsonResponse, todoistConnection, userGrants } from "./executor-fakes.ts";

/** Starts and claims a run with the grants in place at that moment (test_executor.py `start`). */
function start(todoist: FakeTodoist, projects: { [id: string]: string[] }, ceiling: GrantRow[] = [], fetch: typeof globalThis.fetch = todoist.fetch): Promise<Scenario> {
	return Scenario.start({
		connectors: [todoistConnector()],
		connections: [todoistConnection()],
		user: userGrants(TODOIST, PROJECT, projects),
		ceiling,
		fetch,
	});
}

/** Python's RESULT_SCHEMA, checked by hand: required items and count, the optional keys' types, nothing else. */
function matchesResultSchema(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as { [key: string]: unknown };
	const allowed = new Set(Object.keys((RESULT_SCHEMA as { properties: object }).properties));
	if (Object.keys(result).some((key) => !allowed.has(key))) return false;
	if (!Array.isArray(result.items) || !result.items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return false;
	if (!Number.isInteger(result.count) || (result.count as number) < 0) return false;
	if ("incomplete" in result && result.incomplete !== true) return false;
	if ("next_cursor" in result && (typeof result.next_cursor !== "string" || result.next_cursor.length < 1)) return false;
	if ("outcome" in result && result.outcome !== "applied_without_result") return false;
	return true;
}

describe("test_executor.py with the Todoist connector", () => {
	test("the listing only returns allowed projects", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		const outcome = await run.ok("todoist_list_projects", {});
		expect(outcome.result.items).toEqual([{ id: "work", name: "Work" }]);
	});

	test("reads outside the grant are denied before the provider call", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		expect(await run.error("todoist_list_tasks", { project_id: "private" })).toEqual({
			code: "POLICY_DENIED",
			message: "This resource or action is not available under the current permissions.",
		});
		expect(todoist.count("GET", "/tasks")).toBe(0);
	});

	test("get_task resolves the real project before authorizing", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		const found = await run.ok("todoist_get_task", { task_id: "t1" });
		expect(found.result).toEqual({
			items: [{ id: "t1", project_id: "work", title: "Ship it", description: "", priority: 1, due: null, completed: false }],
			count: 1,
		});
		// A task in a project the run may not read, and a missing one, are refused alike.
		for (const taskId of ["t2", "missing"]) expect(await run.code("todoist_get_task", { task_id: taskId })).toBe("POLICY_DENIED");
		expect(todoist.count("GET", "/tasks/t2")).toBe(1);
	});

	test("strict arguments", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		expect(await run.error("todoist_list_tasks", { project_id: "work", connection_id: "other" })).toEqual({
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments. connection_id: Extra inputs are not permitted",
		});
		expect(await run.code("github_list_repos", {})).toBe("UNKNOWN_OPERATION");
		expect(todoist.calls).toEqual([]);
	});

	test("create needs create permission", async () => {
		const todoist = new FakeTodoist();
		expect((await start(todoist, { work: ["read"] })).tools).not.toContain("todoist_create_task");
		const run = await start(todoist, { work: ["read"], private: ["read", "create"] });
		expect(await run.code("todoist_create_task", { project_id: "work", title: "x" })).toBe("POLICY_DENIED");
		expect(todoist.count("POST", "/tasks")).toBe(0);
	});

	test("writes are deduplicated but not limited in number", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		run.runs.set(run.runId, { deadline: null });
		const first = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
		// Normalized before the key is computed: the same write, however it is spelled.
		const again = await run.ok("todoist_create_task", { title: " a ", project_id: "work " });
		expect(again.result).toEqual(first.result);
		expect(again.repeat).toBe(true);
		expect(todoist.count("POST", "/tasks")).toBe(1);
		for (const title of "bcdefghij") await run.ok("todoist_create_task", { project_id: "work", title });
		expect(todoist.count("POST", "/tasks")).toBe(10);
	});

	test("an uncertain write pauses further writes", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		todoist.failWrites = true;
		expect(await run.code("todoist_create_task", { project_id: "work", title: "a" })).toBe("WRITE_UNCERTAIN");
		todoist.failWrites = false;
		expect(await run.error("todoist_create_task", { project_id: "work", title: "other" })).toEqual({
			code: "WRITE_UNCERTAIN",
			message: "A previous write has an unknown outcome. Further writes in this run are paused.",
		});
		expect(todoist.count("POST", "/tasks")).toBe(1);
	});

	test("a revoked provider token marks the connection", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		todoist.revoked = true;
		expect(await run.error("todoist_create_task", { project_id: "work", title: "a" })).toEqual({
			code: "CONNECTION_UNAUTHORIZED",
			message: "The Todoist connection is no longer authorized.",
		});
		expect(run.paused()).toBe(false);
		expect(run.credentials.status(TODOIST)).toBe("error");
	});

	test("page tokens are opaque and bound to the query", async () => {
		const todoist = new FakeTodoist();
		todoist.tasks.push(...[0, 1, 2].map((i) => ({ id: `w${i}`, project_id: "work", content: `t${i}` })));
		todoist.pageSize = 2;
		const run = await start(todoist, { work: ["read"], private: ["read"] });
		const page = await run.ok("todoist_list_tasks", { project_id: "work", limit: 2 });
		const token = page.result.next_cursor as string;
		expect(["2", ""]).not.toContain(token);
		expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
		expect(matchesResultSchema(page.result)).toBe(true);
		const next = await run.ok("todoist_list_tasks", { project_id: "work", limit: 2, cursor: token });
		expect(next.result.count).toBe(2);
		// Todoist got its own cursor back, never the token.
		expect(todoist.calls.filter(([method, path]) => method === "GET" && path === "/tasks")).toHaveLength(2);
		expect(await run.error("todoist_list_tasks", { project_id: "private", limit: 2, cursor: token })).toEqual({
			code: "INVALID_CURSOR",
			message: "This page token is invalid or belongs to another request.",
		});
	});

	test("ended runs cannot call tools", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		run.runs.set(run.runId, { status: "cancelled" });
		const outcome = await run.call("todoist_list_projects", {});
		expect(outcome.ok ? null : outcome.error).toEqual({ code: "RUN_ENDED", message: "This run is no longer active." });
		expect(outcome.event).toBeNull();
	});

	test("a write applied before revocation is still recorded", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		// The run is revoked while the provider applies the write.
		todoist.onWrite = () => run.runs.set(run.runId, { revoked: true });
		expect(await run.code("todoist_create_task", { project_id: "work", title: "a" })).toBe("RUN_ENDED");
		const [write] = run.ledger.writes(run.runId);
		expect(write?.status).toBe("succeeded");
		expect((write?.result as ToolResult).count).toBe(1);
	});

	test("a revocation after reserving a write stops the provider call", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		const current = run.state.isCurrent.bind(run.state);
		run.state.isCurrent = (fence) => current(fence) && run.ledger.writes(run.runId).length === 0;
		expect(await run.code("todoist_create_task", { project_id: "work", title: "a" })).toBe("RUN_ENDED");
		expect(todoist.count("POST", "/tasks")).toBe(0);
		expect(run.writes()).toEqual([]);
	});

	test("required actions are enforced after layers intersect", async () => {
		const todoist = new FakeTodoist();
		const deny: GrantRow = { layer: "ceiling", subject: null, connectionId: TODOIST, kind: PROJECT, resourceId: "work", resourceName: "", actions: ["read"], effect: "deny" };
		const run = await start(todoist, { work: ["read", "create"], private: ["read", "create"] }, [deny]);
		expect(await run.code("todoist_create_task", { project_id: "work", title: "a" })).toBe("POLICY_DENIED");
		expect(todoist.count("POST", "/tasks")).toBe(0);
	});

	test("a revoked run's calls end (test_permission_changes_revoke_active_runs, as the executor sees it)", async () => {
		// Which runs a grant change revokes is the Workspace's; the executor's part is that a revoked run
		// starts nothing.
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		run.runs.set(run.runId, { revoked: true });
		expect(await run.code("todoist_list_projects", {})).toBe("RUN_ENDED");
		expect(todoist.calls).toEqual([]);
		expect(run.runs.toolCalls(run.runId)).toBe(0);
	});
});

describe("Todoist's tools in a run (test_gateway.py, test_attempts.py)", () => {
	test("tools are authorized and recorded, and only the usable ones are listed", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		const listed = run.executor.declarations();
		// Nothing allows creating, so the tool is not offered.
		expect(listed.map((tool) => tool.name)).toEqual(["todoist_list_projects", "todoist_list_tasks", "todoist_get_task"]);
		expect(listed.every((tool) => tool.outputSchema === RESULT_SCHEMA)).toBe(true);
		const allowed = callToolResult(await run.call("todoist_list_tasks", { project_id: "work" }));
		expect([allowed.isError, allowed.structuredContent?.count]).toEqual([false, 1]);
		expect(callToolResult(await run.call("todoist_list_tasks", { project_id: "private" })).isError).toBe(true);
		expect(run.events.map((event) => event.decision)).toEqual(["allowed", "denied"]);
		expect(run.events[0]?.label).toBe("Todoist: List tasks");
	});

	test("listed tools say whether they only read", async () => {
		const run = await start(new FakeTodoist(), { work: ["read", "create"] });
		expect(Object.fromEntries(run.executor.declarations().map((tool) => [tool.name, tool.annotations.readOnlyHint]))).toEqual({
			todoist_list_projects: true,
			todoist_list_tasks: true,
			todoist_get_task: true,
			todoist_create_task: false,
		});
	});

	test("a write in flight when its attempt is replaced is recorded and not repeated", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		// The worker dies and a new attempt takes over while the provider applies the write.
		todoist.onWrite = () => run.replace();
		const first = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
		expect(run.writes()).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
		// The new attempt's model asks for the same write; the recorded one answers it.
		const again = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
		expect(again.result).toEqual(first.result);
		expect(todoist.count("POST", "/tasks")).toBe(1);
		expect(run.events.map((event) => [event.decision, "repeat" in event ? event.repeat : undefined])).toEqual([
			["allowed", undefined],
			["allowed", true],
		]);
	});

	test("a task Todoist put in a project the run may not read: the write counts, the record is dropped", async () => {
		const todoist = new FakeTodoist();
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const response = await todoist.fetch(input, init);
			if (init?.method !== "POST") return response;
			const task = parseJson(await response.text()) as { [key: string]: string };
			return jsonResponse(200, { ...task, project_id: "private" });
		};
		const run = await start(todoist, { work: ["read", "create"] }, [], fetch);
		const created = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
		expect(created.result).toEqual({ items: [], count: 0 });
		expect(run.writes()).toEqual([expect.objectContaining({ status: "succeeded" })]);
		expect(todoist.count("POST", "/tasks")).toBe(1);
	});

	test("a search keeps to the project: the filter is account wide", async () => {
		const todoist = new FakeTodoist();
		const queries: (string | null)[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(new Request(input as RequestInfo, init as RequestInit).url);
			if (url.pathname !== "/api/v1/tasks/filter") return todoist.fetch(input, init);
			queries.push(url.searchParams.get("query"));
			return jsonResponse(200, { results: todoist.tasks, next_cursor: null });
		};
		const run = await start(todoist, { work: ["read"], private: ["read"] }, [], fetch);
		const found = await run.ok("todoist_list_tasks", { project_id: "work", search: " (Ship) & it! " });
		expect(found.result.items.map((item) => item.id)).toEqual(["t1"]);
		expect(queries).toEqual(["search: Ship    it"]);
	});
});
