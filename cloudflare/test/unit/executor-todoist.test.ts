// backend/tests/test_executor.py, case by case: the executor with the Todoist connector and its fake.

import { describe, expect, test } from "vitest";
import type { GrantRow } from "../../src/contracts/policy.ts";
import type { ToolResult } from "../../src/contracts/executor.ts";
import { FakeTodoist, PROJECT, Scenario, TODOIST, todoistConnection, todoistConnector, userGrants } from "./executor-fakes.ts";

/** Starts and claims a run with the grants in place at that moment (test_executor.py `start`). */
function start(todoist: FakeTodoist, projects: { [id: string]: string[] }, ceiling: GrantRow[] = []): Promise<Scenario> {
	return Scenario.start({
		connectors: [todoistConnector()],
		connections: [todoistConnection()],
		user: userGrants(TODOIST, PROJECT, projects),
		ceiling,
		fetch: todoist.fetch,
	});
}

/** Python's RESULT_SCHEMA, checked by hand: required items and count, the optional keys' types, nothing else. */
function matchesResultSchema(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as { [key: string]: unknown };
	const allowed = new Set(["items", "count", "incomplete", "next_cursor", "outcome"]);
	if (Object.keys(result).some((key) => !allowed.has(key))) return false;
	if (!Array.isArray(result.items) || !result.items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return false;
	if (!Number.isInteger(result.count) || (result.count as number) < 0) return false;
	if ("incomplete" in result && result.incomplete !== true) return false;
	if ("next_cursor" in result && (typeof result.next_cursor !== "string" || result.next_cursor.length < 1)) return false;
	if ("outcome" in result && result.outcome !== "applied_without_result") return false;
	return true;
}

describe("the executor with Todoist", () => {
	test("the listing only returns allowed projects", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		const outcome = await run.ok("todoist_list_projects", {});
		expect(outcome.result.items.map((item) => item.id)).toEqual(["work"]);
	});

	test("reads outside the grant are denied before the provider call", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		expect(await run.code("todoist_list_tasks", { project_id: "private" })).toBe("POLICY_DENIED");
		expect(todoist.count("GET", "/tasks")).toBe(0);
	});

	test("get_task resolves the real project before authorizing", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		expect((await run.ok("todoist_get_task", { task_id: "t1" })).result.count).toBe(1);
		for (const taskId of ["t2", "missing"]) expect(await run.code("todoist_get_task", { task_id: taskId })).toBe("POLICY_DENIED");
	});

	test("strict arguments", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		const invalid = await run.error("todoist_list_tasks", { project_id: "work", connection_id: "other" });
		expect(invalid).toEqual({ code: "INVALID_ARGUMENTS", message: 'Invalid arguments. input: Unrecognized key: "connection_id"' });
		expect(await run.code("github_list_repos", {})).toBe("UNKNOWN_OPERATION");
	});

	test("create needs create permission", async () => {
		const todoist = new FakeTodoist();
		expect((await start(todoist, { work: ["read"] })).tools).not.toContain("todoist_create_task");
		const run = await start(todoist, { work: ["read"], private: ["read", "create"] });
		expect(await run.code("todoist_create_task", { project_id: "work", title: "x" })).toBe("POLICY_DENIED");
	});

	test("writes are deduplicated but not limited in number", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		run.runs.set(run.runId, { deadline: null });
		const first = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
		const again = await run.ok("todoist_create_task", { project_id: "work", title: "a" });
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
		// Which runs a grant change revokes is the Workspace's (step 2b, workspace part); the executor's part
		// is that a revoked run starts nothing.
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read"] });
		run.runs.set(run.runId, { revoked: true });
		expect(await run.code("todoist_list_projects", {})).toBe("RUN_ENDED");
		expect(todoist.calls).toEqual([]);
		expect(run.runs.toolCalls(run.runId)).toBe(0);
	});
});
