// A Laravel conversation's facts, their pure parts (docs/plans/credentials-and-facts.md): a tool call's arguments as its fact
// shows them, and how a delivery reads Laravel's answers.

import { Fact, MAX_ARGUMENTS } from "@minerva/contract/internal";
import type { ToolCallEventData } from "@minerva/contract";
import { describe, expect, test } from "vitest";
import { FACT_DELIVERY, acknowledgement, backoffMs, gap, toolCallFact } from "../../src/conversation/facts.ts";

const EVENT = { decision: "allowed", tool: "todoist_list_tasks", label: "Todoist: List tasks", title: "List tasks", count: null, arguments: { truncated: true } } as unknown as ToolCallEventData;

describe("a tool call's fact", () => {
	test("carries the call's own arguments as JSON, not the event's", () => {
		const fact = toolCallFact(EVENT, { truncated: true, filter: "today" });
		expect(fact).toEqual({
			type: "run.tool_call",
			data: { decision: "allowed", tool: "todoist_list_tasks", label: "Todoist: List tasks", title: "List tasks", count: null, arguments: '{"truncated":true,"filter":"today"}', truncated: false },
		});
		expect(toolCallFact(EVENT, undefined).data).toMatchObject({ arguments: "{}", truncated: false });
	});

	test("cuts long arguments to their first 2000 characters, never inside a surrogate pair", () => {
		const long = toolCallFact(EVENT, { text: "a".repeat(5000) }).data as { arguments: string; truncated: boolean };
		expect(long.arguments).toHaveLength(MAX_ARGUMENTS);
		expect(long.truncated).toBe(true);
		// `{"text":"` is 9 characters: a pair starting at 1999 would be cut in two.
		const emoji = toolCallFact(EVENT, { text: `${"a".repeat(MAX_ARGUMENTS - 10)}😀😀` }).data as { arguments: string; truncated: boolean };
		expect(emoji.arguments).toHaveLength(MAX_ARGUMENTS - 1);
		expect(emoji.arguments.isWellFormed()).toBe(true);
		expect(emoji.truncated).toBe(true);
		const exact = toolCallFact(EVENT, { text: "a".repeat(MAX_ARGUMENTS - 11) }).data as { arguments: string; truncated: boolean };
		expect(exact).toMatchObject({ truncated: false });
		expect(exact.arguments).toHaveLength(MAX_ARGUMENTS);
	});
});

describe("a fact's charge", () => {
	const head = { seq: 1, run: "0199e000-0000-7000-8000-0000000000a1", at: "2026-10-16T12:00:00.000Z" };
	const usage = { call: "0a1b2c3d", model: "@cf/zai-org/glm-5.3-flash", inputTokens: 1200, outputTokens: 80, cachedTokens: 0, reasoningTokens: 0 };
	const refused = { call: "0a1b2c3d", provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", cause: "refused", inputTokens: 0, outputTokens: 0, estimated: false };
	const settled = {
		...{ modelCalls: 1, refusedCalls: 0, unmeteredCalls: 0, inputTokens: 1200, outputTokens: 80, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
		...{ estimatedInputTokens: 0, estimatedOutputTokens: 0, containers: 0, containerMs: 0, containerEstimated: false, scripts: 0, scriptMs: 0, scriptEstimated: false },
	};
	const money = { prices: "5e0c2a7d91b4f368", modelMicros: 220, containerMicros: 0, scriptMicros: 0, chargedMicros: 220 };
	const valid = (type: string, data: object) => Fact.safeParse({ ...head, type, data }).success;

	test("a call's cost comes with the version of the prices it was charged at, or neither does", () => {
		expect(valid("run.usage", usage)).toBe(true);
		expect(valid("run.usage", { ...usage, costMicros: 220, prices: money.prices })).toBe(true);
		expect(valid("run.usage", { ...usage, costMicros: 220 })).toBe(false);
		expect(valid("run.unmetered", { ...refused, prices: money.prices })).toBe(false);
	});

	test("a refused call costs nothing", () => {
		expect(valid("run.unmetered", { ...refused, costMicros: 0, prices: money.prices })).toBe(true);
		expect(valid("run.unmetered", { ...refused, costMicros: 1, prices: money.prices })).toBe(false);
	});

	test("a run's charge has every field or none", () => {
		expect(valid("run.settled", settled)).toBe(true);
		expect(valid("run.settled", { ...settled, ...money })).toBe(true);
		expect(valid("run.settled", { ...settled, chargedMicros: 220 })).toBe(false);
		expect(valid("run.settled", { ...settled, ...money, prices: undefined })).toBe(false);
	});
});

describe("Laravel's answers", () => {
	test("an acknowledgement holds at least the batch and no more than was written", () => {
		expect(acknowledgement(10, 10, 12)).toEqual({ kind: "acknowledged", acknowledged: 10 });
		expect(acknowledgement(12, 10, 12)).toEqual({ kind: "acknowledged", acknowledged: 12 });
		for (const acknowledged of [9, 13, 10.5, Number.NaN]) expect(acknowledgement(acknowledged, 10, 12), String(acknowledged)).toMatchObject({ kind: "failed", error: true });
	});

	test("a gap's watermark may be below the last acknowledgement, never above what was written", () => {
		expect(gap(0, 12, 1)).toEqual({ kind: "gap", acknowledged: 0 });
		expect(gap(12, 12, 1)).toEqual({ kind: "gap", acknowledged: 12 });
		for (const acknowledged of [-1, 13, 1.5, "3", undefined, null]) expect(gap(acknowledged, 12, 1), String(acknowledged)).toMatchObject({ kind: "failed", error: true });
	});

	test("a gap below the floor less one is facts the engine no longer holds; from the floor less one it is sent again", () => {
		expect([0, 4, 5, 6, 12].map((acknowledged) => gap(acknowledged, 12, 6))).toEqual([
			{ kind: "pruned", acknowledged: 0, floor: 6 },
			{ kind: "pruned", acknowledged: 4, floor: 6 },
			{ kind: "gap", acknowledged: 5 },
			{ kind: "gap", acknowledged: 6 },
			{ kind: "gap", acknowledged: 12 },
		]);
		expect(gap(13, 12, 6)).toMatchObject({ kind: "failed", error: true });
	});

	test("a failure backs off 2^n seconds, at most five minutes", () => {
		expect(FACT_DELIVERY.backoffMs).toBe(1000);
		expect([1, 2, 3, 8, 9, 100].map(backoffMs)).toEqual([2000, 4000, 8000, 256_000, 300_000, 300_000]);
	});
});
