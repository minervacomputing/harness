// Run events and how runs end. Events are appended to the Conversation Durable Object's `run_events` with
// dense per-run sequence numbers from 1; a refused (fenced) append takes no number. Appending, with seq
// numbers and fences, is the store's (store.ts). The stream sends each as
// `id: <seq>\nevent: <type>\ndata: <compact JSON on one line>\n\n`.

import type { RunEvent, RunStatus, StatusEventData } from "@minerva/contract";
import { sliceText } from "../lib/text.ts";

// The payloads are the contract's (contract/src/conversations.ts), as the chat reads them.
export type {
	DeltaEventData,
	LocalToolEventData,
	MessageEventData,
	PhaseEventData,
	RunEvent,
	RunEventType,
	StatusEventData,
} from "@minerva/contract";

/** The phases the loop reports, in the UI's order of precedence after start-up. */
export type PhaseText =
	| "Starting the agent"
	| "Resuming the agent"
	| "Preparing files"
	| "Saving files"
	| "Running a script"
	| "Running commands"
	| "Using tools"
	| "Thinking";

/** An event before it is appended: the Conversation Durable Object assigns `seq`. */
export type NewRunEvent = RunEvent extends infer E ? (E extends { seq: number } ? Omit<E, "seq"> : never) : never;

/**
 * Why a run ended: the internal code, its status and the message users see (a run's `errorMessage`,
 * ≤500 characters). The worker's own failure text and provider diagnostics are only logged.
 */
export type RunEnd =
	| { status: "completed"; code: ""; message: "" }
	| { status: "cancelled"; code: "cancelled"; message: "Stopped." }
	| { status: "cancelled"; code: RevocationReason; message: "Stopped because permissions changed." }
	/** An operator's emergency stop (plan: Strict revocation, Emergency stop). */
	| { status: "cancelled"; code: "emergency_stop"; message: "Stopped." }
	| { status: "timed_out"; code: "timed_out"; message: "The run took too long." }
	| { status: "failed"; code: "sandbox_failed"; message: "The isolated worker could not start." }
	| { status: "failed"; code: "worker_silent"; message: "The worker did not start." }
	| { status: "failed"; code: "worker_exited"; message: "The worker stopped unexpectedly." }
	| { status: "failed"; code: "worker_failed"; message: "The agent could not finish this run. Try again." }
	/** The run was stored, but the Workspace expired its start before `activate` reached it (plan: Starting a run). */
	| { status: "failed"; code: "start_expired"; message: "The agent could not finish this run. Try again." }
	| { status: "failed"; code: "folder_limit"; message: string }
	| { status: "failed"; code: "state_too_large"; message: "This run's saved state grew too large." }
	| { status: "failed"; code: "state_unreadable"; message: "This run's saved state could not be read." };

/**
 * Strict revocation's reasons: a user's grant change cancels all of that user's
 * active runs, queued included; deleting a connection, the deleting user's; changing an agent's connection
 * set, that agent's. Deleting an agent or a conversation is a plain cancel ("Stopped.").
 */
export type RevocationReason = "permissions_changed" | "connection_removed" | "agent_connections_changed";

/**
 * Why a Conversation Durable Object is asked to stop a run from outside it, and so how the run ends:
 * `cancelled` (deleting an agent or a conversation) and `emergency_stop` with "Stopped.", a revocation
 * reason with "Stopped because permissions changed.", each with its own code (RunEnd).
 */
export type CancelReason = RevocationReason | "cancelled" | "emergency_stop";

/** A run's `errorMessage` and a terminal status's `message` are cut to this many characters. */
export const ERROR_MESSAGE_CHARS = 500;
/** A phase's text is cut to this many characters. */
export const PHASE_CHARS = 300;
/** A local tool card's summary and excerpt. */
export const SUMMARY_CHARS = 300;
export const EXCERPT_CHARS = 2000;

export const ACTIVE: ReadonlySet<RunStatus> = new Set(["queued", "provisioning", "running"]);
/** The states in which a run's current attempt can act (TOKEN_VALID). */
export const ACTING: ReadonlySet<RunStatus> = new Set(["provisioning", "running"]);

export const COMPLETED: RunEnd = { status: "completed", code: "", message: "" };
export const CANCELLED: RunEnd = { status: "cancelled", code: "cancelled", message: "Stopped." };
export const EMERGENCY_STOP: RunEnd = { status: "cancelled", code: "emergency_stop", message: "Stopped." };
export const TIMED_OUT: RunEnd = { status: "timed_out", code: "timed_out", message: "The run took too long." };
export const WORKER_EXITED: RunEnd = { status: "failed", code: "worker_exited", message: "The worker stopped unexpectedly." };
export const WORKER_FAILED: RunEnd = { status: "failed", code: "worker_failed", message: "The agent could not finish this run. Try again." };
export const START_EXPIRED: RunEnd = { status: "failed", code: "start_expired", message: "The agent could not finish this run. Try again." };

/** How a cancel from outside the object ends its run (plan: Strict revocation). */
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
 * The phase the chat shows while the loop runs, in the UI's order of precedence: saving
 * files, then a script, then commands, then any tool, else thinking.
 */
export function phaseOf(saving: boolean, running: Iterable<string>): PhaseText {
	const names = [...running];
	if (saving) return "Saving files";
	if (names.includes("run_script")) return "Running a script";
	if (names.includes("bash")) return "Running commands";
	return names.length ? "Using tools" : "Thinking";
}

/** Storable text: NUL removed and lone surrogates replaced. */
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

/** A local tool card, for read, write, edit and bash. */
export function localToolEvent(tool: "read" | "write" | "edit" | "bash", summary: string, ok: boolean, excerpt: string): NewRunEvent {
	return {
		type: "local_tool",
		data: { tool, summary: head(storable(summary), SUMMARY_CHARS), ok, excerpt: tail(storable(excerpt), EXCERPT_CHARS) },
	};
}
