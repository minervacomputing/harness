// The call wrapper around the pipeline: listing and calling tools across attempts, plus the event and
// result shapes the chat and the model read.

import { describe, expect, test } from "vitest";
import { inputSchema } from "../../src/gateway/registry.ts";
import {
	RESULT_SCHEMA,
	TOOL_RESULT_LIMITS,
	type ToolCallAllowed,
	argumentsSummary,
	callToolResult,
	modelContent,
	writeId,
} from "../../src/gateway/results.ts";
import { todoistConnector } from "../../src/connectors/todoist/connector.ts";
import { hmacSha256Hex } from "../../src/lib/hash.ts";
import { z } from "zod";
import { MAX_HELD_ARGUMENTS } from "@minerva/contract/internal";
import { type Connector, type Operation, OperationError, type Prepared, type ProviderOutput, defineOperation, inTenant } from "../../src/gateway/connector.ts";
import { visibleResult } from "../../src/gateway/executor.ts";
import { APPROVAL_MESSAGES, type ApprovedCall, type HeldRequirement } from "../../src/gateway/holds.ts";
import { WRITE_MESSAGES, writeKey } from "../../src/gateway/ledger.ts";
import { Layer, Policy } from "../../src/gateway/policy.ts";
import {
	FOLDER,
	FakeClock,
	FakeServer,
	FakeTodoist,
	Gate,
	MIXED,
	PROJECT,
	RUN,
	SECRET,
	Scenario,
	TODOIST,
	USER,
	askingGrants,
	mixedConnection,
	mixedConnector,
	todoistConnection,
	userGrants,
} from "./executor-fakes.ts";

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
	test("tools are authorized and recorded", async () => {
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

	test("a cursor that is not a page token's string is refused before the provider is asked", async () => {
		const server = new FakeServer();
		const base = mixedConnector(server);
		const list = base.operations[0] as (typeof base.operations)[number];
		const numbered = { ...list, paginated: true, input: z.strictObject({ cursor: z.number().int().nullable().default(null) }) } as unknown as typeof list;
		const run = await Scenario.start({
			connectors: [{ ...base, operations: [numbered] }],
			connections: [mixedConnection()],
			user: userGrants(MIXED, FOLDER, { inbox: ["read"] }),
			fetch: server.fetch,
		});
		expect(await run.code(`mixed_${list.name}`, { cursor: 42 })).toBe("INVALID_CURSOR");
		expect(await run.code(`mixed_${list.name}`, { cursor: 0 })).toBe("INVALID_CURSOR");
		expect(server.calls).toEqual([]);
	});
});


describe("a call the policy asks before", () => {
	const ASKED = { code: "APPROVAL_UNAVAILABLE", message: "This needs the user's approval, which nobody can give in this run. Do not retry. Say what you would do." };

	test("is refused APPROVAL_UNAVAILABLE after its lease and its prepare, with nothing claimed or sent; reads go on", async () => {
		const todoist = new FakeTodoist();
		const connector = todoistConnector();
		let prepared = 0;
		const counted: Connector = {
			...connector,
			operations: connector.operations.map((op) =>
				op.name !== "create_task"
					? op
					: {
							...op,
							async prepare(binding, data) {
								prepared += 1;
								return op.prepare(binding, data);
							},
						},
			),
		};
		const run = await Scenario.start({
			connectors: [counted],
			connections: [todoistConnection()],
			user: [...userGrants(TODOIST, PROJECT, { work: ["read"], private: ["read", "create"] }), ...askingGrants(TODOIST, PROJECT, { work: ["create"] })],
			fetch: todoist.fetch,
		});
		expect(run.tools).toContain("todoist_create_task");
		expect(await run.error("todoist_create_task", { project_id: "work", title: "a" })).toEqual(ASKED);
		expect(ASKED.message).toBe(APPROVAL_MESSAGES.unavailable);
		expect([run.credentials.leases, prepared]).toEqual([1, 1]);
		expect(run.writes()).toEqual([]);
		expect(todoist.count("POST", "/tasks")).toBe(0);
		expect(run.events).toEqual([{ tool: "todoist_create_task", label: "Todoist: Create a task", arguments: { project_id: "work", title: "a" }, decision: "denied", ...ASKED }]);
		// Nothing was recorded for it, so the same call asks again; a create the layer allows is sent.
		expect(await run.error("todoist_create_task", { project_id: "work", title: "a" })).toEqual(ASKED);
		expect((await run.ok("todoist_create_task", { project_id: "private", title: "b" })).result.count).toBe(1);
		expect(todoist.count("POST", "/tasks")).toBe(1);
		expect((await run.ok(...LIST_TASKS)).result.count).toBe(1);
	});

	test("is denied where any layer denies", async () => {
		const todoist = new FakeTodoist();
		const run = await Scenario.start({
			connectors: [todoistConnector()],
			connections: [todoistConnection()],
			user: [...userGrants(TODOIST, PROJECT, { work: ["read"], private: ["read"] }), ...askingGrants(TODOIST, PROJECT, { work: ["create"], private: ["create"] })],
			ceiling: [{ layer: "ceiling", subject: null, connectionId: TODOIST, kind: PROJECT, resourceId: "work", resourceName: "", actions: ["create"], effect: "deny" }],
			fetch: todoist.fetch,
		});
		expect(await run.error("todoist_create_task", { project_id: "work", title: "a" })).toEqual({ code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." });
		expect(await run.error("todoist_create_task", { project_id: "private", title: "a" })).toEqual(ASKED);
	});

	test("is refused for its tenant first", async () => {
		const server = new FakeServer();
		// Every folder of this connector is in the tenant acme.
		const base = mixedConnector(server);
		const tenanted: Connector = {
			...base,
			tenancy: { kind: "resource", label: "drive", tenants: async () => ({}) },
			operations: base.operations.map((op) =>
				op.name !== "copy_file"
					? op
					: {
							...op,
							async prepare(binding, data) {
								const prepared = await op.prepare(binding, data);
								return { ...prepared, requirements: prepared.requirements.map((item) => ("need" in item ? { ...item, need: inTenant(item.need, "acme") } : item)) };
							},
						},
			),
		};
		const user = [...userGrants(MIXED, FOLDER, { "*": ["read"] }), ...askingGrants(MIXED, FOLDER, { archive: ["create"] })];
		const under = (tenants: string[]) =>
			Scenario.start({ connectors: [tenanted], connections: [mixedConnection()], user, fetch: server.fetch, policy: { revision: 1, connectors: [{ provider: "mixed", tenants }] } });
		const copy = { source: "inbox", dest: "archive", name: "a" };
		expect(await (await under(["other"])).error("mixed_copy_file", copy)).toEqual({ code: "POLICY_DENIED", message: "Your organization does not allow this drive." });
		expect(await (await under(["acme"])).error("mixed_copy_file", copy)).toEqual(ASKED);
		expect(server.copies).toEqual([]);
	});
});

const BOARD = "0199a000-0000-7000-8000-0000000000e1";
const Post = z.strictObject({ board: z.string().min(1).max(300), text: z.string().max(2_000_000) });

/** A connector whose one write takes up to 2 MB of text on a board its input names: for a card's limits. */
function boardConnector(): Connector {
	return {
		slug: "board",
		name: "Board",
		kinds: [{ id: "board", label: "Board", actions: ["read", "create"], wildcard: true }],
		actions: [
			{ id: "read", label: "Read posts" },
			{ id: "create", label: "Post", requires: "read" },
		],
		tenancy: { kind: "unknown" },
		auth: { type: "api_key", label: "API key" },
		operations: [
			defineOperation<z.output<typeof Post>>({
				name: "post",
				title: "Post",
				description: "Posts text on a board.",
				input: Post,
				needs: [["board", "create"]],
				mutates: true,
				// Its records are filtered by the write's own action, as Gmail's send is.
				outputAction: "create",
				async prepare(binding, data): Promise<Prepared> {
					return {
						requirements: [{ need: binding.resource("board", data.board), action: "create" }],
						async execute(): Promise<ProviderOutput> {
							return { records: [{ resource: binding.resource("board", data.board), data: { board: data.board } }] };
						},
					};
				},
			}),
		],
		client: () => ({ close: async () => {} }),
		account: async () => ({ id: "account", label: "Account" }),
		discover: async () => ({ items: [] }),
		describe: async () => ({}),
	};
}

function boardRun() {
	return Scenario.start({
		connectors: [boardConnector()],
		connections: [{ id: BOARD, provider: "board", payload: { kind: "api_key", key: "test-key" } }],
		user: [...userGrants(BOARD, "board", { "*": ["read"] }), ...askingGrants(BOARD, "board", { "*": ["create"] })],
		fetch: async () => {
			throw new Error("The board sends nothing.");
		},
		attended: true,
	});
}

describe("an attended run holds a call the policy asks before", () => {
	const REQUIRED = {
		code: "APPROVAL_REQUIRED",
		message:
			"Minerva asked the user to approve this. It has not run. Do not call it again or try another way. Finish your turn by saying what waits for approval. The user approves or declines it with the buttons Minerva shows in the chat, so do not ask them to reply yes or no. The outcome comes in the next turn.",
	};
	const PENDING = { code: "APPROVAL_PENDING", message: "An earlier action waits for the user's approval. Make no more changes in this turn." };
	const TOO_LARGE = { code: "APPROVAL_TOO_LARGE", message: "This action is too large to show the user for approval. Split it into smaller ones." };
	const CREATE = "todoist_create_task";
	/** Reads on both projects, creates on `private`; `work` asks before a create. */
	const GRANTS = [...userGrants(TODOIST, PROJECT, { work: ["read"], private: ["read", "create"] }), ...askingGrants(TODOIST, PROJECT, { work: ["create"] })];

	function attended(todoist: FakeTodoist) {
		return Scenario.start({ connectors: [todoistConnector()], connections: [todoistConnection()], user: GRANTS, fetch: todoist.fetch, attended: true });
	}

	test("holds it at its lease and prepare, claiming nothing and sending nothing, named by the provider; a repeat holds nothing more and leases nothing", async () => {
		const todoist = new FakeTodoist();
		const run = await attended(todoist);
		const fields = { project_id: "work", title: "a" };
		expect(await run.error(CREATE, fields)).toEqual(REQUIRED);
		const key = await writeKey(CREATE, fields);
		const write = await writeId(SECRET, RUN, key);
		expect(run.ledger.holds(RUN)).toEqual([
			{
				runId: RUN,
				position: 1,
				key,
				write,
				userId: USER,
				tool: CREATE,
				label: "Todoist: Create a task",
				connection: TODOIST,
				provider: "todoist",
				operation: "create_task",
				contract: run.registry.contract("todoist", "create_task"),
				arguments: '{"project_id":"work","title":"a"}',
				requirements: [{ kind: PROJECT, kindLabel: "Project", resource: "work", name: "Work", action: "create", actionLabel: "Create tasks", effect: "ask", asked: ["user"] }],
				decision: { state: "open" },
				createdAt: run.clock.now(),
			},
		]);
		expect([run.credentials.leases, run.writes(), todoist.count("POST", "/tasks"), todoist.count("GET", "/projects")]).toEqual([1, [], 0, 1]);
		const row = { tool: CREATE, label: "Todoist: Create a task", arguments: fields, decision: "denied", ...REQUIRED, write };
		expect(run.events).toEqual([row]);
		expect(await run.error(CREATE, fields)).toEqual(REQUIRED);
		expect([run.ledger.holds(RUN).length, run.credentials.leases, todoist.count("GET", "/projects")]).toEqual([1, 1, 1]);
		expect(run.events).toEqual([row, row]);
	});

	test("stores every resource the call names with its effect, allowed ones too, and the provider's names cut to 300 characters", async () => {
		const server = new FakeServer();
		const connector = mixedConnector(server);
		const named: Connector = { ...connector, describe: async (_client, _kind, ids) => Object.fromEntries(ids.filter((id) => id !== "inbox").map((id) => [id, "A".repeat(400)])) };
		const failing: Connector = {
			...connector,
			describe: async () => {
				throw new OperationError("PROVIDER_UNAVAILABLE", "Down.");
			},
		};
		const user = [...userGrants(MIXED, FOLDER, { "*": ["read"] }), ...askingGrants(MIXED, FOLDER, { archive: ["create"] })];
		const copy = { source: "inbox", dest: "archive", name: "a" };
		const held = async (subject: Connector) => {
			const run = await Scenario.start({ connectors: [subject], connections: [mixedConnection()], user, fetch: server.fetch, attended: true });
			expect(await run.error("mixed_copy_file", copy)).toEqual(REQUIRED);
			return run.ledger.holds(RUN).map((hold) => hold.requirements);
		};
		const source = { kind: FOLDER, kindLabel: "Folder", resource: "inbox", action: "read", actionLabel: "Read", effect: "allow", asked: [] };
		const dest = { kind: FOLDER, kindLabel: "Folder", resource: "archive", action: "create", actionLabel: "Create", effect: "ask", asked: ["user"] };
		expect(await held(named)).toEqual([[source, { ...dest, name: "A".repeat(300) }]]);
		expect(await held(failing)).toEqual([[source, dest]]);
		expect(server.copies).toEqual([]);
	});

	test("holds ten; the eleventh is refused APPROVAL_PENDING and closes the run's writes, so the next is refused before its lease and a repeat still asks", async () => {
		const todoist = new FakeTodoist();
		const run = await attended(todoist);
		for (let n = 1; n <= 10; n++) expect(await run.error(CREATE, { project_id: "work", title: `t${n}` })).toEqual(REQUIRED);
		expect(await run.error(CREATE, { project_id: "work", title: "t11" })).toEqual(PENDING);
		expect(run.ledger.holds(RUN).map((hold) => [hold.position, JSON.parse(hold.arguments).title])).toEqual(Array.from({ length: 10 }, (_, i) => [i + 1, `t${i + 1}`]));
		expect([run.state.writesClosed(RUN), run.credentials.leases]).toEqual([true, 11]);
		expect(await run.error(CREATE, { project_id: "work", title: "t12" })).toEqual(PENDING);
		expect(await run.error(CREATE, { project_id: "work", title: "t3" })).toEqual(REQUIRED);
		expect([run.ledger.holds(RUN).length, run.credentials.leases, todoist.count("POST", "/tasks")]).toEqual([10, 11, 0]);
	});

	test("a write that does not ask is then refused APPROVAL_PENDING at its claim and closes writes; a later asking one is refused before its lease; reads go on", async () => {
		const todoist = new FakeTodoist();
		const run = await attended(todoist);
		expect(await run.error(CREATE, { project_id: "work", title: "a" })).toEqual(REQUIRED);
		expect(await run.error(CREATE, { project_id: "private", title: "b" })).toEqual(PENDING);
		expect([run.writes(), todoist.count("POST", "/tasks"), run.state.writesClosed(RUN)]).toEqual([[], 0, true]);
		const leases = run.credentials.leases;
		expect(await run.error(CREATE, { project_id: "work", title: "c" })).toEqual(PENDING);
		expect([run.credentials.leases, run.ledger.holds(RUN).length]).toEqual([leases, 1]);
		expect((await run.ok(...LIST_TASKS)).result.count).toBe(1);
		expect(run.events.map((event) => [event.decision, "code" in event ? event.code : null])).toEqual([
			["denied", "APPROVAL_REQUIRED"],
			["denied", "APPROVAL_PENDING"],
			["denied", "APPROVAL_PENDING"],
			["allowed", null],
		]);
	});

	test("a write refused before its claim ran nothing and closes nothing: a later asking write is held", async () => {
		const todoist = new FakeTodoist();
		const run = await attended(todoist);
		expect(await run.error(CREATE, { project_id: "work", title: "a" })).toEqual(REQUIRED);
		expect(await run.code(CREATE, { project_id: "elsewhere", title: "b" })).toBe("POLICY_DENIED");
		expect(await run.error(CREATE, { project_id: "work", title: "c" })).toEqual(REQUIRED);
		expect([run.ledger.holds(RUN).map((hold) => hold.position), run.state.writesClosed(RUN)]).toEqual([[1, 2], false]);
	});

	test("a run whose writes are paused by an uncertain write holds nothing", async () => {
		const todoist = new FakeTodoist();
		const run = await attended(todoist);
		todoist.failWrites = true;
		expect(await run.code(CREATE, { project_id: "private", title: "a" })).toBe("WRITE_UNCERTAIN");
		expect(await run.error(CREATE, { project_id: "work", title: "b" })).toEqual({ code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused });
		expect(run.ledger.holds(RUN)).toEqual([]);
	});

	test("one too large for its card is refused APPROVAL_TOO_LARGE, by its fields' 1.5 MiB or by its fact's row once escaped, holding nothing", async () => {
		const run = await boardRun();
		expect(await run.error("board_post", { board: "news", text: "a".repeat(MAX_HELD_ARGUMENTS) })).toEqual(TOO_LARGE);
		// Under the fields' limit, but each quote is escaped twice in the fact.
		expect(await run.error("board_post", { board: "news", text: '"'.repeat(700_000) })).toEqual(TOO_LARGE);
		expect(run.ledger.holds(RUN)).toEqual([]);
		expect(await run.error("board_post", { board: "news", text: "a".repeat(1_500_000) })).toEqual(REQUIRED);
		expect(run.ledger.holds(RUN).map((hold) => hold.arguments.length)).toEqual([1_500_000 + '{"board":"news","text":""}'.length]);
	});

	test("one whose fact Laravel would refuse is refused APPROVAL_UNAVAILABLE, saying it cannot be shown, holding nothing", async () => {
		const run = await boardRun();
		expect(await run.error("board_post", { board: "b".repeat(201), text: "hi" })).toEqual({
			code: "APPROVAL_UNAVAILABLE",
			message: "This needs the user's approval, but it cannot be shown to them. Do not retry. Say what you would do.",
		});
		expect(run.ledger.holds(RUN)).toEqual([]);
		expect(run.log.warnings).toEqual([`A held call of board.post in run ${RUN} cannot be shown: data.requirements.0.resource: Too big: expected string to have <=200 characters`]);
	});

	test("a write's records stay visible under an ask, so a send the user approved shows them", () => {
		const connector = boardConnector();
		const op = connector.operations[0] as Operation<never>;
		const ref = { connection_id: BOARD, provider: "board" };
		const record = { resource: { connectionId: BOARD, kind: "board", id: "news", within: [], partial: false }, data: { board: "news" } };
		const row = (actions: string[], effect: "allow" | "ask" | "deny") => ({ connectionId: BOARD, kind: "board", resourceId: "*", actions, effect });
		// As the compile makes an ask row on an enforceable kind: an allow that lets the restricted layer pass, and the ask.
		const policy = (effect: "ask" | "deny") =>
			new Policy([Layer.build("user", true, effect === "ask" ? [row(["read", "create"], "allow"), row(["create"], "ask")] : [row(["read"], "allow"), row(["create"], "deny")])]);
		expect(visibleResult(connector, op, ref, policy("ask"), { records: [record] })).toEqual({ result: { items: [{ board: "news" }], count: 1 }, images: [] });
		expect(visibleResult(connector, op, ref, policy("deny"), { records: [record] })).toEqual({ result: { items: [], count: 0 }, images: [] });
	});
});

describe("a continuation's approved call", () => {
	const CREATE = "todoist_create_task";
	const FIELDS = { project_id: "work", title: "a" };
	const HELD = "0199a000-0000-7000-8000-0000000000d1";
	const STALE = { code: "APPROVAL_STALE", message: "This changed since the user approved it, so it did not run." };
	const WORK: HeldRequirement = { kind: PROJECT, kindLabel: "Project", resource: "work", name: "Work", action: "create", actionLabel: "Create tasks", effect: "ask", asked: ["user"] };
	/** Reads on both projects, creates on `private`; `work` asks before a create, as when the call was held. */
	const ASKING = [...userGrants(TODOIST, PROJECT, { work: ["read"], private: ["read", "create"] }), ...askingGrants(TODOIST, PROJECT, { work: ["create"] })];

	/** The pass of the hold at position 2 of the held run, for these fields and what the user saw. */
	async function pass(fields: { [key: string]: unknown } = FIELDS, requirements: HeldRequirement[] = [WORK]): Promise<ApprovedCall> {
		return { run: HELD, position: 2, key: await writeKey(CREATE, fields), requirements };
	}

	function continuation(todoist: FakeTodoist, options: { user?: typeof ASKING; ceiling?: typeof ASKING; connector?: Connector } = {}) {
		const { user = ASKING, ceiling, connector = todoistConnector() } = options;
		return Scenario.start({ connectors: [connector], connections: [todoistConnection()], user, ...(ceiling ? { ceiling } : {}), fetch: todoist.fetch, attended: true });
	}

	test("runs under the ask it was held for, holding nothing, and its write names its hold; the model's same call is then answered from the record", async () => {
		const todoist = new FakeTodoist();
		const run = await continuation(todoist);
		expect((await run.ok(CREATE, FIELDS, { approved: await pass() })).result.count).toBe(1);
		expect([todoist.count("POST", "/tasks"), run.ledger.holds(RUN)]).toEqual([1, []]);
		expect(run.ledger.approvedWrite(RUN, HELD, 2)).toMatchObject({ key: await writeKey(CREATE, FIELDS), status: "succeeded" });
		expect((await run.ok(CREATE, FIELDS)).repeat).toBe(true);
		expect(todoist.count("POST", "/tasks")).toBe(1);
	});

	test("runs where the layers now allow it, and is POLICY_DENIED where one now denies it", async () => {
		const todoist = new FakeTodoist();
		const allowed = await continuation(todoist, { user: userGrants(TODOIST, PROJECT, { work: ["read", "create"] }) });
		expect((await allowed.ok(CREATE, FIELDS, { approved: await pass() })).result.count).toBe(1);
		const ceiling = [{ layer: "ceiling" as const, subject: null, connectionId: TODOIST, kind: PROJECT, resourceId: "work", resourceName: "", actions: ["create"], effect: "deny" as const }];
		const denied = await continuation(todoist, { ceiling });
		expect(await denied.error(CREATE, FIELDS, { approved: await pass() })).toEqual({ code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." });
		expect([todoist.count("POST", "/tasks"), denied.ledger.writes(RUN)]).toEqual([1, []]);
	});

	test("is APPROVAL_STALE, sending nothing, when its fields or destinations are not the ones the user approved, also when the new one is allowed", async () => {
		const todoist = new FakeTodoist();
		const run = await continuation(todoist);
		expect(await run.error(CREATE, FIELDS, { approved: await pass({ project_id: "work", title: "b" }) })).toEqual(STALE);
		// Approved only before a create in `work`, or before that and another one.
		expect(await run.error(CREATE, FIELDS, { approved: await pass(FIELDS, [{ ...WORK, resource: "private", name: "Private" }]) })).toEqual(STALE);
		expect(await run.error(CREATE, FIELDS, { approved: await pass(FIELDS, [WORK, { ...WORK, action: "read", actionLabel: "Read tasks" }]) })).toEqual(STALE);
		// The same fields now name another project, one the layers allow: still not what the user saw.
		const base = todoistConnector();
		const moved: Connector = {
			...base,
			operations: base.operations.map((op) => (op.name !== "create_task" ? op : { ...op, prepare: (binding, data) => op.prepare(binding, { ...(data as object), project_id: "private" } as never) })),
		};
		const elsewhere = await continuation(todoist, { connector: moved });
		expect(await elsewhere.error(CREATE, FIELDS, { approved: await pass() })).toEqual(STALE);
		expect([todoist.count("POST", "/tasks"), run.ledger.writes(RUN), run.ledger.holds(RUN), elsewhere.ledger.writes(RUN)]).toEqual([0, [], [], []]);
		expect(run.events.map((event) => [event.decision, (event as { code?: string }).code])).toEqual([
			["denied", "APPROVAL_STALE"],
			["denied", "APPROVAL_STALE"],
			["denied", "APPROVAL_STALE"],
		]);
	});
});

describe("attempts", () => {
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

	test("a refused call's event, denied for the eight codes and error otherwise", async () => {
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

	test("the write id is the run's keyed HMAC of the key, cut to 32 hex", async () => {
		const run = "0199a000-0000-7000-8000-000000000000";
		const id = await writeId("test-secret-not-a-real-key", run, "e".repeat(64));
		expect(id).toBe((await hmacSha256Hex("test-secret-not-a-real-key", `minerva.gateway.write\u0000${run}:${"e".repeat(64)}`)).slice(0, 32));
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await writeId("another-secret", run, "e".repeat(64))).not.toBe(id);
		expect(await writeId("test-secret-not-a-real-key", run, "f".repeat(64))).not.toBe(id);
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
