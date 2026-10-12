// Runs: states, attempts, how they end, and the snapshot a run starts with (runs 1 to 3; plan: Starting a
// run, Attempts and recovery). The Conversation Durable Object owns its runs; the Workspace Durable
// Object keeps a registry of active ones for revocation and for addressing `/runs/{run}` URLs.

import type { AttachmentOut, ConversationDetail, MessageOut, RunOut } from "./api.ts";
import type { AgentId, ConnectionId, ConversationId, EpochMs, RunId, UserId, VersionId, WorkspaceId } from "./common.ts";
import type { RunEvent } from "./events.ts";
import type { PolicySnapshot } from "./policy.ts";

/** `queued → provisioning → running → completed | failed | cancelled | timed_out` (runs 2.1). */
export type RunStatus = "queued" | "provisioning" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** At most one run per conversation is in one of these (runs 1.1). */
export type ActiveStatus = "queued" | "provisioning" | "running";

/**
 * The states in which a run's current attempt may still act: call tools and models, append fenced events,
 * checkpoint. An expired run (deadline passed) counts as inactive for every check before it is marked
 * `timed_out` (runs 2.5).
 */
export type ActingStatus = "provisioning" | "running";

export type TerminalStatus = Exclude<RunStatus, ActiveStatus>;

/**
 * Attempts (plan: Attempts and recovery). The first execution is attempt 1; there are at most 3. A
 * restart is PiHarness's harness factory running in a new instance while an activated `provisioning` or
 * `running` run has unsettled pi work (its submission queued or placed, or live tasks in its session);
 * hibernation between turns is not one, and queued runs belong to the start protocol. First in the
 * factory, before pi opens, the object ends the run as `timed_out` if its deadline passed, as
 * `worker_exited` if this would be attempt 4 or fewer than 30 s remain, and otherwise increments the
 * attempt and appends the restart marker `{status: "provisioning", attempt}`, then syncs storage. In the
 * same transaction it marks the run's writes still `dispatched` as uncertain: the instance that dispatched
 * them died and can never settle them.
 */
export type MaxAttempts = 3;
/** No restart with less than this left before the deadline. */
export type RestartMinRemainingMs = 30_000;

export interface AttemptRecord {
	runId: RunId;
	attempt: number;
	startedAt: EpochMs;
	endedAt: EpochMs | null;
	/** Why the attempt ended, for logs: `completed`, `restarted` (the object died), `failed`, `cancelled`. */
	ended: "completed" | "restarted" | "failed" | "cancelled" | null;
}

/**
 * Why a run ended (runs 2.3): the internal code, its status and the message users see (`RunOut.error_message`,
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
 * `folder_limit` messages, by limit (runs 2.3; `mib(n)` is `${n / 2**20:.0f} MiB` from 1 MiB, else
 * `${n} bytes`): `folder_bytes` "The agent's files grew past the {mib} a conversation can keep.";
 * `folder_entries` "The agent made more than the {n} files and folders a conversation can keep." (no
 * thousands separator); `run_uploads` "The agent saved more than the {mib} of files a turn may save.";
 * `workspace` "The workspace has used all of its storage for files."
 */
export type FolderLimitMessage = string;

/**
 * Strict revocation's reasons (connectors 4.6, runs 8): a user's grant change cancels all of that user's
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

/**
 * A tool as a run snapshots it, with today's field names (runs 3.3). `name` is `{alias}_{operation}`, the
 * alias numbering usable connections per provider in `created_at` order (`todoist`, `todoist2`). The
 * model never names a connection; the executor takes it from here. `contract` is the operation's
 * fingerprint: 16 hex of SHA-256 over the canonical JSON of its meaning (connectors 2.2;
 * gateway/registry.ts); a mismatch at call time is `OPERATION_CHANGED`. Built by gateway/tools.ts `toolsFor`.
 */
export interface ToolRef {
	name: string;
	connection_id: ConnectionId;
	provider: string;
	operation: string;
	contract: string;
}

/**
 * What the Workspace Durable Object's `beginRun` computes, in one synchronous step with registering the
 * run as active, so a grant change processed afterwards revokes it (plan: Starting a run; runs 3.2).
 */
export interface StartSnapshot {
	workspaceId: WorkspaceId;
	conversationId: ConversationId;
	userId: UserId;
	agentId: AgentId;
	/** Layers in the order ceiling, user, agent. */
	permissions: PolicySnapshot;
	tools: ToolRef[];
	/**
	 * `SAFETY_INSTRUCTIONS`, `The run started on {Monday, 2026-10-10 14:03} UTC.`, a blank line and the
	 * agent's instructions, stripped (runs 3.4). The folder paragraph is appended at turn start.
	 */
	instructions: string;
	/** Always `default` today (runs 1.7). */
	modelAlias: string;
	/** Fixed at start from MINERVA_RUN_TIMEOUT_SECONDS; never changes across attempts; null for none (runs 2.5). */
	deadline: EpochMs | null;
	createdAt: EpochMs;
	/** The connections the run's tools use, in tool order, for revocation by connection. */
	connectionIds: ConnectionId[];
}

/** The snapshot the Conversation Durable Object stores with the run: the start snapshot plus its folder. */
export interface RunSnapshot extends StartSnapshot {
	runId: RunId;
	/** The version the run starts from: the conversation's folder, or a new `base` with the attachments (files 10). */
	baseVersionId: VersionId | null;
	/** As added to the folder: final, possibly numbered names at the root, in upload order. */
	attachments: AttachmentOut[];
	limits: { folderBytes: number; folderEntries: number; runUploadBytes: number };
}

/** A run as the Conversation Durable Object keeps it (runs 1.1), apart from its events and writes. */
export interface RunRecord {
	id: RunId;
	status: RunStatus;
	attempt: number;
	attemptStartedAt: EpochMs;
	errorCode: string;
	/** ≤500 characters. */
	errorMessage: string;
	snapshot: RunSnapshot;
	/** Set by a revocation or emergency stop: the executor checks it synchronously before every provider request. */
	revoked: boolean;
	/**
	 * The Workspace answered `activate` (plan: Starting a run, step 5). Until then the object sends it again
	 * whenever it starts, and on an alarm set when the run is stored.
	 */
	activated: boolean;
	/** A write's outcome is unknown: every later write in the run is refused. */
	writesUncertain: boolean;
	checkpointVersionId: VersionId | null;
	resultVersionId: VersionId | null;
	/** Bytes the run has saved, failed and repeated uploads included (files 12.2). */
	uploadedBytes: number;
	usage: { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; unmeteredModelCalls: number };
	eventSeq: number;
	createdAt: EpochMs;
	startedAt: EpochMs | null;
	finishedAt: EpochMs | null;
}

/**
 * `RunOut` with its events typed. The API answers this shape; the type exists because RPC types cannot
 * carry the generated `EventOut`'s `unknown` data.
 */
export type RunView = Omit<RunOut, "events"> & { events: RunEvent[] };

export type ConversationView = Omit<ConversationDetail, "runs"> & { runs: RunView[] };

/**
 * A run as a Durable Object returns it: `RunView` without its events. A run's events have no size bound
 * (plan: open question 5) and Workers RPC refuses a result over 32 MiB, so the Worker pages through them
 * with `getRunEvents` up to `eventSeq` while it streams the response. `eventSeq` is read with the status in
 * one synchronous step, and events are append-only, so the body it assembles is consistent.
 */
export type RunHead = Omit<RunOut, "events"> & { eventSeq: number };

export type ConversationHead = Omit<ConversationDetail, "runs"> & { runs: RunHead[] };

export interface PostedView {
	message: MessageOut;
	run: RunView;
}
