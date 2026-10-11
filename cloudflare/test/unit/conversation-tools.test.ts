// The run's connector tools and their queue (harness 5, 6; runs 5.3), ported from worker/src/main.ts
// (`gatewayTool`, `gatewayCalls`) and the gateway's rendering of results, with the replay cap and the
// re-parse of argument text the runtime's JSON.parse would misread.

import { describe, expect, test } from "vitest";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { AttemptFence, Json } from "../../src/contracts/common.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../../src/contracts/executor.ts";
import { CALLS_AT_ONCE, ToolQueue, untilAborted } from "../../src/conversation/queue.ts";
import {
	argumentsOf,
	connectorTool,
	parametersOf,
	REPLAY_REFUSED,
	render,
	RUN_ENDED_MESSAGE,
	TOOL_RESULT_BYTES,
	type ToolHost,
} from "../../src/conversation/tools.ts";

const FENCE: AttemptFence = { runId: "0199a000-0000-7000-8000-000000000001", attempt: 1 };

function declaration(fields: Partial<ToolDeclaration> = {}): ToolDeclaration {
	return {
		name: "todoist_list_tasks",
		title: "List tasks",
		description: "Lists tasks.",
		inputSchema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false },
		outputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
		...fields,
	};
}

const ALLOWED: ToolCallOutcome = {
	ok: true,
	result: { items: [{ id: "1", content: "Café ☕" }], count: 1, next_cursor: "tok" },
	title: "List tasks",
	repeat: false,
	writeKey: null,
	event: { tool: "todoist_list_tasks", label: "Todoist: List tasks", arguments: {}, decision: "allowed", title: "List tasks", count: 1 },
};

interface Recorded {
	host: ToolHost;
	calls: { args: Json | undefined; signal: AbortSignal | undefined }[];
	phases: string[];
}

function host(fields: Partial<ToolHost> = {}, outcome: () => Promise<ToolCallOutcome> = async () => ALLOWED): Recorded {
	const recorded: Recorded = { calls: [], phases: [], host: undefined as unknown as ToolHost };
	recorded.host = {
		current: () => ({ fence: FENCE, deadline: null }),
		executions: () => 1,
		argumentText: () => null,
		invoke: (_fence, _declaration, args, signal) => {
			recorded.calls.push({ args, signal });
			return outcome();
		},
		started: (_runId, callId, name) => recorded.phases.push(`start ${callId} ${name}`),
		ended: (_runId, callId) => recorded.phases.push(`end ${callId}`),
		...fields,
	};
	return recorded;
}

function api(callId = "call-1"): ToolExecutionApi {
	return { conversationId: 7, callId } as unknown as ToolExecutionApi;
}

const BG = { abortSignal: undefined, value: () => undefined } as never;

describe("registration", () => {
	test("a read is replayed and runs in parallel; a write is not and makes its round sequential", () => {
		const read = connectorTool(declaration(), host().host);
		expect([read.replay, read.executionMode]).toEqual(["safe", "parallel"]);
		const write = connectorTool(declaration({ name: "todoist_create_task", annotations: { readOnlyHint: false } }), host().host);
		expect([write.replay, write.executionMode]).toEqual(["unsafe", "sequential"]);
		expect(read.outputLimits).toEqual({ maxBytes: TOOL_RESULT_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" });
		expect(TOOL_RESULT_BYTES).toBe(1024 * 1024);
	});

	test("the description falls back to the title, then the name; parameters are an object with properties", () => {
		expect(connectorTool(declaration({ description: "" }), host().host).description).toBe("List tasks");
		expect(connectorTool(declaration({ description: "", title: "" }), host().host).description).toBe("todoist_list_tasks");
		expect(parametersOf(declaration({ inputSchema: { additionalProperties: false } }))).toEqual({ additionalProperties: false, type: "object", properties: {} });
	});
});

describe("what the model sees", () => {
	test("a result is its JSON as Python's json.dumps writes it; an error is its message", () => {
		expect(render(ALLOWED)).toEqual({
			content: [{ type: "text", text: '{"items": [{"id": "1", "content": "Caf\\u00e9 \\u2615"}], "count": 1, "next_cursor": "tok"}' }],
			isError: false,
		});
		const denied: ToolCallOutcome = { ok: false, error: { code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." }, event: null };
		expect(render(denied)).toEqual({ content: [{ type: "text", text: "This resource or action is not available under the current permissions." }], isError: true });
	});

	test("a call runs through the host, with phases around it", async () => {
		const recorded = host();
		const tool = connectorTool(declaration(), recorded.host);
		const result = await tool.execute({ limit: 2 } as never, api(), BG);
		expect(result.isError).toBe(false);
		expect(recorded.calls.map((call) => call.args)).toEqual([{ limit: 2 }]);
		expect(recorded.phases).toEqual(["start call-1 todoist_list_tasks", "end call-1"]);
	});

	test("a call of a run that is no longer current is answered RUN_ENDED and never sent", async () => {
		const recorded = host({ current: () => null });
		const result = await connectorTool(declaration(), recorded.host).execute({} as never, api(), BG);
		expect(result).toEqual({ content: [{ type: "text", text: RUN_ENDED_MESSAGE }], isError: true });
		expect(recorded.calls).toEqual([]);
	});

	test("a safe call replayed more than twice is answered with an error instead of running again", async () => {
		for (const [executions, runs] of [
			[1, true],
			[3, true],
			[4, false],
		] as const) {
			const recorded = host({ executions: () => executions });
			const result = await connectorTool(declaration(), recorded.host).execute({} as never, api(), BG);
			expect(recorded.calls.length > 0).toBe(runs);
			if (!runs) expect(result).toEqual({ content: [{ type: "text", text: REPLAY_REFUSED }], isError: true });
		}
		// A write is never replayed by pi, so it is never counted.
		let counted = 0;
		const write = host({ executions: () => ++counted + 10 });
		await connectorTool(declaration({ annotations: { readOnlyHint: false } }), write.host).execute({} as never, api(), BG);
		expect([counted, write.calls.length]).toEqual([0, 1]);
	});

	test("a call still waiting at the deadline gives up with RUN_ENDED", async () => {
		const recorded = host({ current: () => ({ fence: FENCE, deadline: Date.now() + 20 }) }, () => new Promise(() => {}));
		const result = await connectorTool(declaration(), recorded.host).execute({} as never, api(), BG);
		expect(result).toEqual({ content: [{ type: "text", text: RUN_ENDED_MESSAGE }], isError: true });
	});

	test("a call whose turn is aborted stops waiting", async () => {
		const controller = new AbortController();
		const recorded = host({}, () => new Promise(() => {}));
		const pending = connectorTool(declaration(), recorded.host).execute({} as never, api(), { abortSignal: controller.signal, value: () => undefined } as never);
		controller.abort(new Error("Tool aborted"));
		await expect(pending).rejects.toThrow("Tool aborted");
		expect(recorded.phases).toEqual(["start call-1 todoist_list_tasks", "end call-1"]);
	});
});

describe("argument text", () => {
	const registration = connectorTool(declaration({ inputSchema: { type: "object" } }), host().host) as ToolRegistration;

	test("the model's text is parsed with parseJson, so an escaped key is the model's", () => {
		// What the runtime's JSON.parse returns once "\\" was parsed on the same shape (lib/json.ts).
		const misread = { "\\": 1 };
		expect(argumentsOf(registration, "c", misread, '{"\\n":1}')).toEqual({ "\n": 1 });
	});

	test("pi's own parse is used without text, or when the text does not parse (pi repaired it)", () => {
		expect(argumentsOf(registration, "c", { a: 1 }, null)).toEqual({ a: 1 });
		expect(argumentsOf(registration, "c", { a: 1 }, '{"a":1')).toEqual({ a: 1 });
	});

	test("the re-parse is validated and coerced as pi-ai does it", () => {
		const typed = connectorTool(declaration(), host().host) as ToolRegistration;
		expect(argumentsOf(typed, "c", {}, '{"limit":"5"}')).toEqual({ limit: 5 });
		expect(() => argumentsOf(typed, "c", {}, '{"limit":"many"}')).toThrow(/Validation failed for tool "todoist_list_tasks"/);
	});
});

describe("the queue", () => {
	test("at most four calls at once, the rest in order", async () => {
		const queue = new ToolQueue();
		let running = 0;
		let peak = 0;
		const gates = Array.from({ length: 6 }, () => Promise.withResolvers<void>());
		const order: number[] = [];
		const calls = gates.map((gate, index) =>
			queue.send(false, async () => {
				order.push(index);
				running++;
				peak = Math.max(peak, running);
				await gate.promise;
				running--;
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual([0, 1, 2, 3]);
		for (const gate of gates) gate.resolve();
		await Promise.all(calls);
		expect(order).toEqual([0, 1, 2, 3, 4, 5]);
		expect(peak).toBe(CALLS_AT_ONCE);
	});

	test("writes run one at a time, in the order they were asked for, beside reads", async () => {
		const queue = new ToolQueue();
		const log: string[] = [];
		const first = Promise.withResolvers<void>();
		const a = queue.send(true, async () => {
			log.push("write 1 start");
			await first.promise;
			log.push("write 1 end");
		});
		const b = queue.send(true, async () => {
			log.push("write 2 start");
		});
		const c = queue.send(false, async () => {
			log.push("read");
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The read does not wait for the writes; the second write waits for the first.
		expect([...log].sort()).toEqual(["read", "write 1 start"]);
		first.resolve();
		await Promise.all([a, b, c]);
		expect(log.filter((line) => line.startsWith("write"))).toEqual(["write 1 start", "write 1 end", "write 2 start"]);
	});

	test("the check runs in the slot, just before the call, and may drop it", async () => {
		const queue = new ToolQueue();
		let sent = false;
		await expect(
			queue.send(
				false,
				async () => {
					sent = true;
				},
				() => {
					throw new Error("aborted while waiting");
				},
			),
		).rejects.toThrow("aborted while waiting");
		expect(sent).toBe(false);
		// The slot is free again.
		await queue.send(false, async () => {});
	});

	test("untilAborted stops waiting, not the call", async () => {
		const controller = new AbortController();
		const call = Promise.withResolvers<string>();
		const waiting = untilAborted(call.promise, controller.signal);
		controller.abort(new Error("stop"));
		await expect(waiting).rejects.toThrow("stop");
		call.resolve("settled anyway");
		expect(await call.promise).toBe("settled anyway");
	});
});
