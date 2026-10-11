// The Conversation Durable Object: one per chat, named by the conversation's id, in its workspace's
// jurisdiction (plan: Data placement). Authoritative for its owner, workspace and agent (fixed at
// creation), messages, runs and attempts, run events, the write ledger, page tokens, folder versions, the
// run's checkpoint, the script store, and pi's `pi_*` tables. It extends the Agents SDK's `Agent` and runs
// pi-durable through PiHarness (plan: The harness), and runs the executor.

import type { FolderOut, MessageIn } from "./api.ts";
import type { AgentId, Caller, ConversationId, EpochMs, Outcome, RunId, Sha256, UserId, VersionId, WorkspaceRef } from "./common.ts";
import type { NewRunEvent, RunEvent } from "./events.ts";
import type { CancelReason, ConversationHead, PostedView, RunHead } from "./runs.ts";

export interface ConversationInit {
	conversationId: ConversationId;
	workspace: WorkspaceRef;
	userId: UserId;
	agentId: AgentId;
	createdAt: EpochMs;
}

/** What a Conversation Durable Object answers to a cancel from outside: the acknowledgement the Workspace's outbox waits for. */
export interface CancelAck {
	runId: RunId;
	/**
	 * `stopping`: the run's local revoked flag is set and the run is being stopped. `tombstoned`: the run is
	 * not stored yet, so a start that is still in flight stores it as cancelled (plan: Strict revocation,
	 * step 4). `ended`: it had already ended.
	 */
	state: "stopping" | "tombstoned" | "ended";
}

/** A file a signed download link may name (plan: Files, Downloads). */
export interface DownloadTarget {
	versionId: VersionId;
	path: string;
	/** `blobs/<ws>/<conv>/<sha256>/<random>`. */
	key: string;
	sha256: Sha256;
	size: number;
}

/** A page of a run's events: seq above `after` and at most `upTo`, at most `limit` of them. */
export interface EventPage {
	after: number;
	upTo: number;
	/** At most 1,000; a page also stops at 4 MiB of JSON. */
	limit: number;
}

/**
 * Its RPC surface. Every method that takes a `Caller` answers "not found" (null, or a 404 refusal) for a
 * caller who is not the conversation's owner, so another user's chat looks like none (web-api 7).
 *
 * Workers RPC refuses an argument or result over 32 MiB, and a conversation's events grow without bound
 * (plan: open question 5), so no method returns more than one run's page of events: conversations and runs
 * come back as heads, and the Worker streams the API's body (frontend 4.1: each run with all its events by
 * seq), paging each run's events with `getRunEvents` up to its head's `eventSeq`.
 */
export interface ConversationApi {
	/** Fixes the owner, workspace and agent. Idempotent; refuses a different identity. */
	init(input: ConversationInit): Promise<void>;

	/** Messages by (created_at, id); runs by created_at, as heads (frontend 4.1). */
	getConversation(caller: Caller): Promise<ConversationHead | null>;
	/** One page of a run's events by seq; null for another user's run or an unknown one. */
	getRunEvents(caller: Caller, runId: RunId, page: EventPage): Promise<RunEvent[] | null>;

	/**
	 * Starts a turn (runs 3.1; plan: Starting a run): 404, 400 "Write a message or attach a file.", 409 "Wait
	 * for the current answer to finish, or stop it.", or the attachment refusals of `beginRun`. Every
	 * refusal leaves nothing behind (no message, no run, uploads untouched), which the composer relies on.
	 * Before its transaction it copies each reserved upload whose contents the conversation does not hold
	 * yet into a blob of its own (`blobs/<ws>/<conv>/<sha256>/<random>`, recorded as loose first, `get` then
	 * `put` with the upload's SHA-256, which R2 checks), so the folder never names an `uploads/` key: those
	 * expire a day after they were written. An upload gone by then is "An attached file is no longer
	 * available. Remove it and attach it again." Success stores the message, the run (`queued`, attempt 1,
	 * event seq 1 `status: queued`) and the base version together, and sets the title from the first message
	 * (`content[:80]`, else the attachment paths joined by ", "); then it calls `activate`.
	 */
	postMessage(caller: Caller, input: Required<MessageIn>): Promise<Outcome<PostedView>>;

	getRun(caller: Caller, runId: RunId): Promise<RunHead | null>;
	/** The user's stop: idempotent, a finished run stays as it was; the refreshed run (runs 8). */
	cancelRun(caller: Caller, runId: RunId): Promise<RunHead | null>;
	/**
	 * A cancel from the Workspace's outbox (revocation, deletion, emergency stop): sets the run's local
	 * revoked flag synchronously and stops it with the reason's code and message (CancelReason, RunEnd), or
	 * leaves a tombstone for a run not stored yet. Idempotent by run id. Returning is the acknowledgement.
	 */
	cancel(runId: RunId, reason: CancelReason, entryId: number): Promise<CancelAck>;

	/**
	 * The current folder (no version), or a non-checkpoint version of this conversation; null is 404.
	 * `{version_id: null, files: [], dirs: []}` when there is no folder yet (files 11.1).
	 */
	listFiles(caller: Caller, versionId: VersionId | null): Promise<FolderOut | null>;
	/** A file of a non-checkpoint version (or of the current folder), for a signed link; null is 404 (files 11.2). */
	resolveDownload(caller: Caller, versionId: VersionId | null, path: string): Promise<DownloadTarget | null>;

	/** Tombstone, cancel and wait, then delete storage and the R2 prefix (plan: Files, Deletion). Driven by the Workspace. */
	destroy(): Promise<{ done: boolean }>;
}

/**
 * The event stream (plan: Events and the stream; frontend 8). The Worker checks the session and the run's
 * owner, then opens a hibernatable WebSocket to the object with `fetch()` on this path. The object sends
 * the backlog after `after` and subscribes in one synchronous step, so no event falls between them, then
 * one text frame per event, and `StreamEndFrame` once the run is inactive and caught up. It drops a socket
 * whose buffered amount passes a limit; the browser reconnects with Last-Event-ID and loses nothing.
 */
export interface StreamRequest {
	path: "/stream";
	query: { run: RunId; after: number; user: UserId };
	headers: { Upgrade: "websocket" };
}

/** One WebSocket text frame per event: `JSON.stringify(event)`; the Worker writes it as an SSE frame. */
export type StreamEventFrame = RunEvent;
export type StreamEndFrame = { type: "end" };

/**
 * Appending an event (plan: Events and the stream): in the same storage transaction as the state change
 * it reports, with the next seq; a fenced append whose attempt is no longer current takes no seq and is
 * dropped. Internal to the object; listed because the executor, the model tap and the local tools all
 * append through it.
 */
export interface EventLog {
	append(runId: RunId, event: NewRunEvent, fence?: { attempt: number }): RunEvent | null;
}
