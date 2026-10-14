// A Laravel conversation's facts, their pure parts (docs/plans/credentials-and-facts.md): a tool call's arguments as its fact
// shows them, and how a delivery reads Laravel's answers.

import { MAX_ARGUMENTS } from "@minerva/contract/internal";
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

describe("Laravel's answers", () => {
	test("an acknowledgement holds at least the batch and no more than was written", () => {
		expect(acknowledgement(10, 10, 12)).toEqual({ kind: "acknowledged", acknowledged: 10 });
		expect(acknowledgement(12, 10, 12)).toEqual({ kind: "acknowledged", acknowledged: 12 });
		for (const acknowledged of [9, 13, 10.5, Number.NaN]) expect(acknowledgement(acknowledged, 10, 12), String(acknowledged)).toMatchObject({ kind: "failed", error: true });
	});

	test("a gap's watermark may be below the last acknowledgement, never above what was written", () => {
		expect(gap(0, 12)).toEqual({ kind: "gap", acknowledged: 0 });
		expect(gap(12, 12)).toEqual({ kind: "gap", acknowledged: 12 });
		for (const acknowledged of [-1, 13, 1.5, "3", undefined, null]) expect(gap(acknowledged, 12), String(acknowledged)).toMatchObject({ kind: "failed", error: true });
	});

	test("a failure backs off 2^n seconds, at most five minutes", () => {
		expect(FACT_DELIVERY.backoffMs).toBe(1000);
		expect([1, 2, 3, 8, 9, 100].map(backoffMs)).toEqual([2000, 4000, 8000, 256_000, 300_000, 300_000]);
	});
});
