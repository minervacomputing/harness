// Event payloads and how runs end (runs 2.3, 6.2; frontend 4.4; harness 8.6, 12.2), ported from
// backend/runs/services.py (`finish`), gateway/views.py (worker events) and the worker's chat cards.

import { describe, expect, test } from "vitest";
import {
	CANCELLED,
	COMPLETED,
	EMERGENCY_STOP,
	endFor,
	head,
	localToolEvent,
	phaseEvent,
	phaseOf,
	START_EXPIRED,
	storable,
	tail,
	terminalStatus,
	TIMED_OUT,
	WORKER_EXITED,
	WORKER_FAILED,
} from "../../src/conversation/events.ts";

describe("how runs end", () => {
	test("codes and messages are today's", () => {
		expect(COMPLETED).toEqual({ status: "completed", code: "", message: "" });
		expect(CANCELLED).toEqual({ status: "cancelled", code: "cancelled", message: "Stopped." });
		expect(EMERGENCY_STOP).toEqual({ status: "cancelled", code: "emergency_stop", message: "Stopped." });
		expect(TIMED_OUT).toEqual({ status: "timed_out", code: "timed_out", message: "The run took too long." });
		expect(WORKER_EXITED).toEqual({ status: "failed", code: "worker_exited", message: "The worker stopped unexpectedly." });
		expect(WORKER_FAILED).toEqual({ status: "failed", code: "worker_failed", message: "The agent could not finish this run. Try again." });
		expect(START_EXPIRED).toEqual({ status: "failed", code: "start_expired", message: "The agent could not finish this run. Try again." });
	});

	test("a cancel from outside ends with its reason's code", () => {
		expect(endFor("cancelled")).toBe(CANCELLED);
		expect(endFor("emergency_stop")).toBe(EMERGENCY_STOP);
		for (const reason of ["permissions_changed", "connection_removed", "agent_connections_changed"] as const) {
			expect(endFor(reason)).toEqual({ status: "cancelled", code: reason, message: "Stopped because permissions changed." });
		}
	});

	test("a terminal status carries its message only when there is one, cut to 500 characters", () => {
		expect(terminalStatus(COMPLETED)).toEqual({ status: "completed" });
		expect(terminalStatus(CANCELLED)).toEqual({ status: "cancelled", message: "Stopped." });
		expect(terminalStatus({ status: "failed", code: "folder_limit", message: "" })).toEqual({ status: "failed" });
		const long = terminalStatus({ status: "failed", code: "folder_limit", message: `${"é".repeat(499)}😀😀` });
		expect(long).toEqual({ status: "failed", message: `${"é".repeat(499)}😀` });
	});
});

describe("phases", () => {
	test("in the UI's order of precedence", () => {
		expect(phaseOf(true, ["run_script", "bash"])).toBe("Saving files");
		expect(phaseOf(false, ["todoist_list_tasks", "run_script", "bash"])).toBe("Running a script");
		expect(phaseOf(false, ["read", "bash"])).toBe("Running commands");
		expect(phaseOf(false, ["todoist_list_tasks"])).toBe("Using tools");
		expect(phaseOf(false, [])).toBe("Thinking");
	});

	test("a phase's text is cut to 300 characters", () => {
		expect(phaseEvent("Thinking")).toEqual({ type: "phase", data: { text: "Thinking" } });
		expect(phaseEvent(`${"x".repeat(299)}😀😀`)).toEqual({ type: "phase", data: { text: `${"x".repeat(299)}😀` } });
	});
});

describe("local tool cards", () => {
	test("a summary over 300 characters is 299 and an ellipsis, NUL removed, a lone surrogate replaced", () => {
		const event = localToolEvent("bash", `\u0000${"a".repeat(400)}`, true, "ok");
		expect(event).toEqual({ type: "local_tool", data: { tool: "bash", summary: `${"a".repeat(299)}…`, ok: true, excerpt: "ok" } });
		expect(storable("a\ud800b\u0000")).toBe("a�b");
	});

	test("an excerpt keeps its end: an ellipsis and the last 1,999 characters", () => {
		const event = localToolEvent("bash", "exit 3", false, `${"a".repeat(5000)}END`);
		const excerpt = (event.data as { excerpt: string }).excerpt;
		expect(excerpt).toHaveLength(2000);
		expect(excerpt.startsWith("…a")).toBe(true);
		expect(excerpt.endsWith("aEND")).toBe(true);
		expect(localToolEvent("bash", "exit 3", false, "Command exited with code 3").data).toEqual({ tool: "bash", summary: "exit 3", ok: false, excerpt: "Command exited with code 3" });
	});

	test("cutting never splits a surrogate pair", () => {
		expect(head(`${"a".repeat(298)}😀😀😀`, 300)).toBe(`${"a".repeat(298)}😀…`);
		expect(tail(`😀😀😀${"a".repeat(1998)}`, 2000)).toBe(`…😀${"a".repeat(1998)}`);
	});
});
