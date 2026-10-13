// Run events: what the chat folds into messages. They are appended to the
// Conversation Durable Object's `run_events` with dense per-run sequence numbers from 1; a refused
// (fenced) append takes no number. The stream sends each as `id: <seq>\nevent: <type>\ndata: <compact
// JSON on one line>\n\n`. Payloads are type aliases, not interfaces, so they stay
// assignable to the generated `EventOut`.

import type { Json } from "./common.ts";
import type { RunStatus } from "./runs.ts";

/**
 * `status`. The frontend relies on its order (ordering invariants):
 * - `queued` is always seq 1, when the message is posted;
 * - the first `provisioning` has no `attempt`;
 * - a restart marker carries `attempt` (n ≥ 2) and makes the chat drop the text and reasoning streamed
 *   before it: `{status: "running", attempt}` (plan: Attempts and recovery) or `{status: "provisioning",
 *   attempt}`, which shows "Restarting the agent";
 * - a terminal status has `message` (≤500 characters) only when the run has an error message; `completed`
 *   never does. The chat reads `run.error_message` after a refetch, never this `message`.
 */
export type StatusEventData =
	| { status: "queued" }
	| { status: "provisioning" }
	| { status: "running" }
	| { status: "provisioning" | "running"; attempt: number }
	| { status: "completed" }
	| { status: Exclude<TerminalStatus, "completed">; message?: string };

type TerminalStatus = Exclude<RunStatus, "queued" | "provisioning" | "running">;

/** `phase`: what the agent is doing, ≤300 characters, emitted only when it changes. */
export type PhaseEventData = {
	text: PhaseText | string;
};

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

/**
 * `text_delta` and `reasoning_delta`: what streamed since the last flush (every 0.25 s per model call).
 * `call` is 8 lowercase hex characters, fixed per model call and shared by its reasoning and text; the chat
 * joins deltas only within one call. Never stored for a replaced attempt.
 */
export type DeltaEventData = {
	text: string;
	call: string;
};

/**
 * `tool_call`: a connector tool call that **finished** (there is no "started" event), appended only while
 * the run is active, also for a call started by a replaced attempt, and never for `RUN_ENDED`.
 * The chat uses `tool`, `label`, `arguments`, `decision`, `message`, `write` and `repeat`.
 */
export type ToolCallEventData = ToolCallAllowed | ToolCallRefused;

type ToolCallBase = {
	/** The tool name cut to 64 characters, e.g. `todoist2_list_tasks`. */
	tool: string;
	/** `Todoist (2): List tasks`; the bare (cut) name for an unknown tool. */
	label: string;
	/** The arguments, or `{truncated: <first 2000 characters of their JSON>}` when their JSON is longer. */
	arguments: { [key: string]: Json } | { truncated: string };
};

export type ToolCallAllowed = ToolCallBase & {
	decision: "allowed";
	title: string;
	count: number | null;
	/** For a write: 32 hex, a keyed hash of (run, write key); the same for a write and its repeat, different across runs. */
	write?: string;
	/** The same write asked for again, answered from the run's record. */
	repeat?: true;
};

export type ToolCallRefused = ToolCallBase & {
	/** `denied` exactly for the codes in `DeniedCode` (executor.ts), `error` for every other failure. */
	decision: "denied" | "error";
	code: string;
	message: string;
};

/**
 * `local_tool`: a read, write, edit or bash call in the folder finished, reported after its result was
 * released by the checkpoint barrier; an aborted call is not reported. NUL removed, lone
 * surrogates replaced; `summary` is the command or path cut to 300 characters (299 plus `…`), `excerpt`
 * the end of the output or error cut to 2,000 (`…` plus the last 1,999), never splitting a surrogate pair.
 */
export type LocalToolEventData = {
	tool: "read" | "write" | "edit" | "bash";
	summary: string;
	ok: boolean;
	excerpt: string;
};

/** `message`: the final answer, always immediately followed by `status: completed`, committed together. */
export type MessageEventData = {
	/** The assistant message's id. */
	id: string;
	content: string;
};

export type RunEvent =
	| { seq: number; type: "status"; data: StatusEventData }
	| { seq: number; type: "phase"; data: PhaseEventData }
	| { seq: number; type: "text_delta"; data: DeltaEventData }
	| { seq: number; type: "reasoning_delta"; data: DeltaEventData }
	| { seq: number; type: "tool_call"; data: ToolCallEventData }
	| { seq: number; type: "local_tool"; data: LocalToolEventData }
	| { seq: number; type: "message"; data: MessageEventData };

export type RunEventType = RunEvent["type"];

/** An event before it is appended: the Conversation Durable Object assigns `seq`. */
export type NewRunEvent = RunEvent extends infer E ? (E extends { seq: number } ? Omit<E, "seq"> : never) : never;

/**
 * The stream's control frames besides events: a keepalive comment every 15 s of silence, and `end` once
 * the run is inactive and every event was sent (no `id:`). The relay may also send `retry:`.
 * Never an unnamed `data:` frame: the browser would dispatch it as `message` and settle the turn.
 */
export type StreamKeepalive = ": keepalive\n\n";
export type StreamEnd = "event: end\ndata: {}\n\n";
