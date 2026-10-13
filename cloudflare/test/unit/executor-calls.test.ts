// The call wrapper around the pipeline: listing and calling tools across attempts, plus the event and
// result shapes the chat and the model read.

import { describe, expect, test } from "vitest";
import type { ToolCallAllowed } from "../../src/contracts/events.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import {
	RESULT_SCHEMA,
	TOOL_RESULT_LIMITS,
	argumentsSummary,
	callToolResult,
	modelContent,
	writeId,
} from "../../src/gateway/results.ts";
import vectors from "./vectors.ts";
import { FakeClock, FakeTodoist, Gate, PROJECT, Scenario, TODOIST, todoistConnection, todoistConnector, userGrants } from "./executor-fakes.ts";

function start(todoist: FakeTodoist, projects: { [id: string]: string[] } = { work: ["read"] }, options: { concurrency?: number; deadline?: number | null } = {}) {
	return Scenario.start({
		connectors: [todoistConnector()],
		connections: [todoistConnection()],
		user: userGrants(TODOIST, PROJECT, projects),
		fetch: todoist.fetch,
		...options,
	});
}

const LIST_TASKS: [string, { project_id: string }] = ["todoist_list_tasks", { project_id: "work" }];

/** A Todoist whose reads wait on a gate, counting how many run at once. */
function heldTodoist(todoist: FakeTodoist) {
	const held = { running: 0, peak: 0, gate: null as Gate | null, arrived: new Gate() };
	const fetch = todoist.fetch;
	const wrapped: typeof globalThis.fetch = async (input, init) => {
		held.running += 1;
		held.peak = Math.max(held.peak, held.running);
		held.arrived.resolve();
		try {
			if (held.gate !== null) await held.gate.promise;
			else await new Promise((resolve) => setTimeout(resolve, 20));
			return await fetch(input, init);
		} finally {
			held.running -= 1;
		}
	};
	return { held, fetch: wrapped };
}

describe("tools/list", () => {
	test("tools are authorized and recorded (test_mcp_tools_are_authorized_and_recorded)", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		const listed = run.executor.declarations();
		// Nothing allows creating, so the tool is not offered.
		expect(listed.map((tool) => tool.name)).toEqual(["todoist_list_projects", "todoist_list_tasks", "todoist_get_task"]);
		// Scripts get typed results from it.
		expect(listed.every((tool) => tool.outputSchema === RESULT_SCHEMA)).toBe(true);
		const allowed = await run.call(...LIST_TASKS);
		const result = callToolResult(allowed);
		expect([result.isError, result.structuredContent?.count]).toEqual([false, 1]);
		const denied = callToolResult(await run.call("todoist_list_tasks", { project_id: "private" }));
		expect(denied.isError).toBe(true);
		expect(run.events.map((event) => event.decision)).toEqual(["allowed", "denied"]);
		expect(run.events[0]?.label).toBe("Todoist: List tasks");
	});

	test("listed tools say whether they only read, with the input schema and description", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		const listed = run.executor.declarations();
		expect(Object.fromEntries(listed.map((tool) => [tool.name, tool.annotations.readOnlyHint]))).toEqual({
			todoist_list_projects: true,
			todoist_list_tasks: true,
			todoist_get_task: true,
			todoist_create_task: false,
		});
		const create = listed.find((tool) => tool.name === "todoist_create_task");
		const op = run.registry.get("todoist").operations.find((item) => item.name === "create_task");
		expect(create).toEqual({
			name: "todoist_create_task",
			title: "Create a task",
			description: "Create one task in a project where you have create permission. Give an explicit project_id and title.",
			inputSchema: inputSchema(op as never),
			outputSchema: RESULT_SCHEMA,
			annotations: { readOnlyHint: false },
		});
	});
});

describe("tools/call", () => {
	test("an unknown tool is recorded by the start of its name", async () => {
		const run = await start(new FakeTodoist());
		const outcome = await run.call("x".repeat(10_000), {});
		expect(callToolResult(outcome)).toEqual({ content: [{ type: "text", text: "This operation is not available." }], isError: true });
		expect(run.events).toEqual([{ tool: "x".repeat(64), label: "x".repeat(64), arguments: {}, decision: "error", code: "UNKNOWN_OPERATION", message: "This operation is not available." }]);
	});

	test("a name is cut at 64 units, never inside a surrogate pair", async () => {
		const run = await start(new FakeTodoist());
		await run.call(`a${"\u{1f600}".repeat(40)}`, {});
		expect(run.events[0]?.tool).toBe(`a${"\u{1f600}".repeat(31)}`);
	});

	test("tool calls are counted but not limited", async () => {
		const run = await start(new FakeTodoist());
		run.runs.set(run.runId, { toolCalls: 1000 });
		for (let i = 0; i < 3; i++) expect((await run.call(...LIST_TASKS)).ok).toBe(true);
		expect(run.runs.toolCalls(run.runId)).toBe(1003);
	});

	test("a run without a deadline can call tools", async () => {
		const run = await start(new FakeTodoist(), { work: ["read"] }, { deadline: null });
		expect((await run.call(...LIST_TASKS)).ok).toBe(true);
	});

	test("tool calls of one run wait for a free slot", async () => {
		const todoist = new FakeTodoist();
		const { held, fetch } = heldTodoist(todoist);
		const run = await Scenario.start({
			connectors: [todoistConnector()],
			connections: [todoistConnection()],
			user: userGrants(TODOIST, PROJECT, { work: ["read"] }),
			fetch,
			concurrency: 2,
		});
		const outcomes = await Promise.all([0, 1, 2, 3, 4].map(() => run.call(...LIST_TASKS)));
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
		expect(held.peak).toBe(2);
	});

	test("a call waiting for a slot when the run stops does nothing", async () => {
		const todoist = new FakeTodoist();
		const { held, fetch } = heldTodoist(todoist);
		held.gate = new Gate();
		const run = await Scenario.start({
			connectors: [todoistConnector()],
			connections: [todoistConnection()],
			user: userGrants(TODOIST, PROJECT, { work: ["read"] }),
			fetch,
			concurrency: 1,
		});
		const first = run.call(...LIST_TASKS);
		await held.arrived.promise;
		const waiting = run.call(...LIST_TASKS);
		run.runs.set(run.runId, { status: "cancelled" });
		held.gate.resolve();
		expect(callToolResult(await waiting)).toEqual({ content: [{ type: "text", text: "This run is no longer active." }], isError: true });
		await first;
		// The held call had already been admitted to the provider; the waiting one made no request.
		expect(todoist.count("GET", "/tasks")).toBe(1);
		expect(run.events).toEqual([]);
	});

	test("a call waiting for a slot gives up at the deadline", async () => {
		const todoist = new FakeTodoist();
		const { held, fetch } = heldTodoist(todoist);
		held.gate = new Gate();
		const clock = new FakeClock();
		const run = await Scenario.start({
			connectors: [todoistConnector()],
			connections: [todoistConnection()],
			user: userGrants(TODOIST, PROJECT, { work: ["read"] }),
			fetch,
			concurrency: 1,
			clock,
			deadline: clock.now() + 50,
		});
		const first = run.call(...LIST_TASKS);
		await held.arrived.promise;
		expect(callToolResult(await run.call(...LIST_TASKS)).content).toEqual([{ type: "text", text: "This run is no longer active." }]);
		held.gate.resolve();
		await first;
	});

	test("tool calls of an ended run are not counted", async () => {
		const run = await start(new FakeTodoist());
		run.runs.set(run.runId, { status: "cancelled" });
		expect(callToolResult(await run.call(...LIST_TASKS)).content).toEqual([{ type: "text", text: "This run is no longer active." }]);
		expect(run.runs.toolCalls(run.runId)).toBe(0);
	});

	test("a call already cancelled does nothing and is not counted", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		const abort = new AbortController();
		abort.abort(new Error("stopped"));
		await expect(run.call(...LIST_TASKS, { signal: abort.signal })).rejects.toThrow("stopped");
		expect([run.runs.toolCalls(run.runId), todoist.calls.length, run.events.length]).toEqual([0, 0, 0]);
	});

	test("a run revoked while the call closes its client gets no result, and nothing is recorded", async () => {
		const todoist = new FakeTodoist();
		const connector = todoistConnector();
		const client = connector.client;
		let run: Scenario | null = null;
		connector.client = (secret, io) => {
			const http = client(secret, io);
			const close = http.close.bind(http);
			http.close = async () => {
				run?.runs.set(run.runId, { revoked: true });
				await close();
			};
			return http;
		};
		run = await Scenario.start({ connectors: [connector], connections: [todoistConnection()], user: userGrants(TODOIST, PROJECT, { work: ["read"] }), fetch: todoist.fetch });
		const outcome = await run.call(...LIST_TASKS);
		expect(outcome).toEqual({ ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null });
	});

	test("a cancelled read stops its request in flight", async () => {
		const todoist = new FakeTodoist();
		let signal: AbortSignal | null | undefined;
		const arrived = new Gate();
		const fetch: typeof globalThis.fetch = (_, init) => {
			signal = init?.signal;
			arrived.resolve();
			return new Promise<Response>((__, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
		};
		const run = await Scenario.start({ connectors: [todoistConnector()], connections: [todoistConnection()], user: userGrants(TODOIST, PROJECT, { work: ["read"] }), fetch });
		const abort = new AbortController();
		const outcome = run.call(...LIST_TASKS, { signal: abort.signal });
		await arrived.promise;
		abort.abort(new Error("stopped"));
		await expect(outcome).rejects.toThrow("stopped");
		expect(signal?.aborted).toBe(true);
		expect([run.events, run.waits]).toEqual([[], []]);
		expect(todoist.calls).toEqual([]);
	});

	test("a page past the run's 200 tokens is LIMIT_REACHED, after the provider was called", async () => {
		const todoist = new FakeTodoist();
		todoist.tasks.push({ id: "w1", project_id: "work", content: "a" }, { id: "w2", project_id: "work", content: "b" });
		todoist.pageSize = 1;
		const run = await start(todoist);
		for (let i = 0; i < 200; i++) run.tokens.issue(run.runId, "other_tool", "h", String(i));
		expect(await run.error("todoist_list_tasks", { project_id: "work", limit: 1 })).toEqual({ code: "LIMIT_REACHED", message: "This run has reached its pagination limit." });
		expect(todoist.count("GET", "/tasks")).toBe(1);
		expect(run.events.map((event) => event.decision)).toEqual(["denied"]);
	});
});

describe("attempts (test_attempts.py)", () => {
	test("a replaced attempt cannot call tools", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		run.replace();
		const stale = await run.executor.invoke({ fence: run.fence(1), name: LIST_TASKS[0], arguments: LIST_TASKS[1] });
		expect(callToolResult(stale).content).toEqual([{ type: "text", text: "This run is no longer active." }]);
		expect(stale.event).toBeNull();
		expect(run.runs.toolCalls(run.runId)).toBe(0);
		expect(todoist.count("GET", "/tasks")).toBe(0);
		// The current attempt can.
		expect((await run.call(...LIST_TASKS)).ok).toBe(true);
	});

	test("a replaced attempt's queued call does nothing and is not shown", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		const current = run.state.countToolCall.bind(run.state);
		// The call was counted, then its attempt was replaced while it waited for a slot.
		run.state.countToolCall = (fence) => {
			const counted = current(fence);
			run.replace();
			return counted;
		};
		for (const tool of ["todoist_list_tasks", "no_such_tool"]) {
			run.attempt = 1;
			run.runs.set(run.runId, { attempt: 1 });
			const outcome = await run.call(tool, { project_id: "work" });
			expect(outcome.ok ? null : outcome.error.code).toBe("RUN_ENDED");
		}
		expect(run.events).toEqual([]);
		expect(todoist.count("GET", "/tasks")).toBe(0);
	});

	test("a lease is fenced: an attempt replaced while it is asked for gets RUN_ENDED and sends nothing", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		const lease = run.credentials.lease.bind(run.credentials);
		run.credentials.lease = async (fence, id) => {
			const answer = await lease(fence, id);
			run.replace();
			return answer;
		};
		expect(await run.code(...LIST_TASKS)).toBe("RUN_ENDED");
		expect(todoist.calls).toEqual([]);
	});

	test("a write in flight when its attempt is replaced is recorded and not repeated", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		// The instance's attempt is replaced while the provider applies the write.
		todoist.onWrite = () => run.replace();
		const first = await run.executor.invoke({ fence: run.fence(1), name: "todoist_create_task", arguments: { project_id: "work", title: "a" } });
		if (first.event !== null) run.events.push(first.event);
		expect(first.ok).toBe(true);
		const [write] = run.ledger.writes(run.runId);
		expect([write?.status, write?.attempt]).toEqual(["succeeded", 1]);
		todoist.onWrite = null;
		// The new attempt's model asks for the same write; the recorded one answers it.
		const again = await run.call("todoist_create_task", { project_id: "work", title: "a" });
		expect(again.ok).toBe(true);
		expect(callToolResult(again).structuredContent).toEqual(callToolResult(first).structuredContent);
		expect(todoist.count("POST", "/tasks")).toBe(1);
		const events = run.events as ToolCallAllowed[];
		expect(events.map((event) => [event.decision, event.repeat])).toEqual([
			["allowed", undefined],
			["allowed", true],
		]);
		expect(events[0]?.write).toBe(events[1]?.write);
		expect(events[0]?.write).not.toBe(write?.key);
		expect(events[0]?.write).toBe(await writeId("test-secret-not-a-real-key", run.runId, write?.key as string));
	});
});

describe("what the chat and the model read", () => {
	test("an allowed call's event: tool, label, arguments, decision, title, count, write, repeat", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist, { work: ["read", "create"] });
		await run.call("todoist_create_task", { project_id: "work", title: "a" });
		await run.call("todoist_create_task", { project_id: "work", title: "a" });
		await run.call(...LIST_TASKS);
		const [created, repeated, listed] = run.events as ToolCallAllowed[];
		expect(Object.keys(created as object)).toEqual(["tool", "label", "arguments", "decision", "title", "count", "write"]);
		expect(created).toMatchObject({ tool: "todoist_create_task", label: "Todoist: Create a task", arguments: { project_id: "work", title: "a" }, decision: "allowed", title: "Create a task", count: 1 });
		expect(created?.write).toMatch(/^[0-9a-f]{32}$/);
		expect(Object.keys(repeated as object)).toEqual(["tool", "label", "arguments", "decision", "title", "count", "write", "repeat"]);
		expect(listed).toEqual({ tool: "todoist_list_tasks", label: "Todoist: List tasks", arguments: { project_id: "work" }, decision: "allowed", title: "List tasks", count: 2 });
	});

	test("a refused call's event, denied for the seven codes and error otherwise", async () => {
		const todoist = new FakeTodoist();
		const run = await start(todoist);
		await run.call("todoist_list_tasks", { project_id: "private" });
		await run.call("todoist_list_tasks", { project_id: "work", extra: 1 });
		expect(run.events).toEqual([
			{
				tool: "todoist_list_tasks",
				label: "Todoist: List tasks",
				arguments: { project_id: "private" },
				decision: "denied",
				code: "POLICY_DENIED",
				message: "This resource or action is not available under the current permissions.",
			},
			{
				tool: "todoist_list_tasks",
				label: "Todoist: List tasks",
				arguments: { project_id: "work", extra: 1 },
				decision: "error",
				code: "INVALID_ARGUMENTS",
				message: 'Invalid arguments. input: Unrecognized key: "extra"',
			},
		]);
	});

	test("arguments are recorded whole up to 2000 characters of their JSON, else cut", () => {
		const short = { title: "a".repeat(1980) };
		expect(JSON.stringify(short).length).toBeLessThanOrEqual(2000);
		expect(argumentsSummary(short)).toBe(short);
		const long = { title: "\u{1f600}".repeat(1000) };
		// Cut at 2000 UTF-16 units, never inside a surrogate pair.
		expect(argumentsSummary(long)).toEqual({ truncated: `{"title":"${"\u{1f600}".repeat(995)}` });
		expect(argumentsSummary({ title: `x${"\u{1f600}".repeat(1000)}` })).toEqual({ truncated: `{"title":"x${"\u{1f600}".repeat(994)}` });
		expect((argumentsSummary(long) as { truncated: string }).truncated.isWellFormed()).toBe(true);
		expect(argumentsSummary(undefined)).toEqual({});
		expect(argumentsSummary(null)).toEqual({});
	});

	test("the write id is Django's salted_hmac, cut to 32 hex", async () => {
		for (const vector of vectors.salted_hmac.slice(0, 3)) {
			const [run, key] = vector.value.split(":") as [string, string];
			expect(await writeId(vector.secret, run, key)).toBe(vector.sha1.slice(0, 32));
		}
	});

	test("the model reads the result as its JSON, or the error's message", async () => {
		const run = await start(new FakeTodoist());
		const outcome = await run.call("todoist_list_projects", {});
		expect(callToolResult(outcome)).toEqual({
			content: [{ type: "text", text: '{"items":[{"id":"work","name":"Work"}],"count":1}' }],
			structuredContent: { items: [{ id: "work", name: "Work" }], count: 1 },
			isError: false,
		});
		expect(modelContent(callToolResult(outcome))).toEqual([{ type: "text", text: '{"items":[{"id":"work","name":"Work"}],"count":1}' }]);
		expect(modelContent({ content: [{ type: "image" }, { type: "text", text: "t" }], isError: false })).toEqual([
			{ type: "text", text: "[image content omitted]" },
			{ type: "text", text: "t" },
		]);
		expect(modelContent({ content: [], structuredContent: { items: [], count: 0 }, isError: false })).toEqual([{ type: "text", text: '{\n  "items": [],\n  "count": 0\n}' }]);
		// pi keeps a result whole up to 1 MiB, so the paging fields at its end are not cut off.
		expect(TOOL_RESULT_LIMITS).toEqual({ maxBytes: 1048576, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" });
	});
});
