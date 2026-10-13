// Run events and how runs end: their payloads, as the frontend reads them.
// Appending, with seq numbers and fences, is the store's (store.ts).

import type { NewRunEvent, PhaseText, StatusEventData } from "../contracts/events.ts";
import type { CancelReason, RunEnd, RunStatus } from "../contracts/runs.ts";
import { sliceText } from "../lib/text.ts";

/** `error_message` and a terminal status's `message` are cut to this many characters. */
export const ERROR_MESSAGE_CHARS = 500;
/** A phase's text is cut to this many characters (runs 4.5). */
export const PHASE_CHARS = 300;
/** A local tool card's summary and excerpt (files 8.4; harness 8.6). */
export const SUMMARY_CHARS = 300;
export const EXCERPT_CHARS = 2000;

export const ACTIVE: ReadonlySet<RunStatus> = new Set(["queued", "provisioning", "running"]);
/** The states in which a run's current attempt can act (runs 1.1, TOKEN_VALID). */
export const ACTING: ReadonlySet<RunStatus> = new Set(["provisioning", "running"]);

export const COMPLETED: RunEnd = { status: "completed", code: "", message: "" };
export const CANCELLED: RunEnd = { status: "cancelled", code: "cancelled", message: "Stopped." };
export const EMERGENCY_STOP: RunEnd = { status: "cancelled", code: "emergency_stop", message: "Stopped." };
export const TIMED_OUT: RunEnd = { status: "timed_out", code: "timed_out", message: "The run took too long." };
export const WORKER_EXITED: RunEnd = { status: "failed", code: "worker_exited", message: "The worker stopped unexpectedly." };
export const WORKER_FAILED: RunEnd = { status: "failed", code: "worker_failed", message: "The agent could not finish this run. Try again." };
export const START_EXPIRED: RunEnd = { status: "failed", code: "start_expired", message: "The agent could not finish this run. Try again." };

/** How a cancel from outside the object ends its run (plan: Strict revocation; runs 8). */
export function endFor(reason: CancelReason): RunEnd {
	if (reason === "cancelled") return CANCELLED;
	if (reason === "emergency_stop") return EMERGENCY_STOP;
	return { status: "cancelled", code: reason, message: "Stopped because permissions changed." };
}

/** `{status}`, with `message` cut to 500 characters only when the run has one; `completed` never does. */
export function terminalStatus(end: RunEnd): StatusEventData {
	if (end.status === "completed" || !end.message) return { status: end.status } as StatusEventData;
	return { status: end.status, message: sliceText(end.message, 0, ERROR_MESSAGE_CHARS) };
}

export function statusEvent(data: StatusEventData): NewRunEvent {
	return { type: "status", data };
}

export function phaseEvent(text: PhaseText | string): NewRunEvent {
	return { type: "phase", data: { text: sliceText(text, 0, PHASE_CHARS) } };
}

/**
 * The phase the chat shows while the loop runs, in the UI's order of precedence (harness 12.2): saving
 * files, then a script, then commands, then any tool, else thinking.
 */
export function phaseOf(saving: boolean, running: Iterable<string>): PhaseText {
	const names = [...running];
	if (saving) return "Saving files";
	if (names.includes("run_script")) return "Running a script";
	if (names.includes("bash")) return "Running commands";
	return names.length ? "Using tools" : "Thinking";
}

/** Storable text: NUL removed and lone surrogates replaced (harness 8.6). */
export function storable(text: string): string {
	return text.replaceAll("\u0000", "").toWellFormed();
}

/** At most `limit` characters: the first `limit - 1` and `…`, never ending in a lone high surrogate. */
export function head(text: string, limit: number): string {
	const points = Array.from(text);
	if (points.length <= limit) return text;
	return `${points.slice(0, limit - 1).join("")}…`;
}

/** At most `limit` characters: `…` and the last `limit - 1`, never starting with a lone low surrogate. */
export function tail(text: string, limit: number): string {
	const points = Array.from(text);
	if (points.length <= limit) return text;
	return `…${points.slice(points.length - (limit - 1)).join("")}`;
}

/** A local tool card (files 8.4): for steps 3 and 4, which run read, write, edit and bash. */
export function localToolEvent(tool: "read" | "write" | "edit" | "bash", summary: string, ok: boolean, excerpt: string): NewRunEvent {
	return {
		type: "local_tool",
		data: { tool, summary: head(storable(summary), SUMMARY_CHARS), ok, excerpt: tail(storable(excerpt), EXCERPT_CHARS) },
	};
}
