// The executor: the permission pipeline every connector tool call goes through, in the Conversation
// Durable Object (connectors 7, runs 5; plan: What maps to what). It takes run state and credentials
// through the ports below, so it is tested in Node with fakes and an injected `fetch`.

import type { AttemptFence, ConnectionId, EpochMs, Json, RunId, UserId } from "./common.ts";
import type { CoreErrorCode, CredentialPayload, Effect, ErrorCode } from "./connectors.ts";
import type { ToolCallEventData } from "./events.ts";
import type { PolicySnapshot } from "./policy.ts";
import type { ToolRef } from "./runs.ts";

/**
 * Every tool's result, also declared to the model and to scripts as each tool's output schema, with
 * `additionalProperties: false`; `{items: [], count: 0, total: 3}` must fail it (connectors 6).
 */
export interface ToolResult {
	/** Records this run may see; their fields depend on the tool. */
	items: { [key: string]: Json }[];
	/** Items in this result after filtering, not a total across pages. */
	count: number;
	/** A provider or connector limit left something out. */
	incomplete?: true;
	/** An opaque, run-bound page token: repeat the call with the same arguments and this as `cursor`. */
	next_cursor?: string;
	/** The write took effect, but its result could not be read back. */
	outcome?: "applied_without_result";
}

/** A tool as the model sees it (runs 5.2): `readOnlyHint` false marks a write. */
export interface ToolDeclaration {
	name: string;
	title: string;
	description: string;
	inputSchema: { [key: string]: Json };
	outputSchema: { [key: string]: Json };
	annotations: { readOnlyHint: boolean };
}

/** The codes whose refusal is `denied` in the chat; every other failure is `error` (runs 5.3). */
export type DeniedCode = Extract<
	CoreErrorCode,
	"POLICY_DENIED" | "LIMIT_REACHED" | "WRITE_UNCERTAIN" | "WRITE_IN_PROGRESS" | "INVALID_CURSOR" | "CONSENT_REQUIRED" | "OPERATION_CHANGED"
>;

export interface ToolCallRequest {
	fence: AttemptFence;
	/** As the model named it. */
	name: string;
	/** As the model sent them; `null` or absent validate as `{}`. */
	arguments: Json | undefined;
	/**
	 * pi's abort for the call (`context.abortSignal`): the call answers at once and starts nothing more. A
	 * write already dispatched still settles, under the host's `waitUntil` (gateway/executor.ts).
	 */
	signal?: AbortSignal;
	/**
	 * Called once with the call's outcome when its pipeline finishes, also after the caller stopped waiting:
	 * a write already sent when the call was cancelled still gets its `tool_call` event from it.
	 */
	settled?: (outcome: ToolCallOutcome) => void;
}

/**
 * The outcome of `invoke` (connectors 7.1; runs 5.3). What the model sees stays today's: the result's
 * JSON as text plus the structured result, or the error's message with `isError`.
 */
export type ToolCallOutcome =
	| {
			ok: true;
			result: ToolResult;
			title: string;
			/** The same write was asked for earlier in this run and is answered from its record. */
			repeat: boolean;
			/** Set for a write; identical writes of a run share it. */
			writeKey: string | null;
			/** The event to append, or null when the run is no longer active. */
			event: ToolCallEventData | null;
	  }
	| {
			ok: false;
			error: { code: ErrorCode; message: string };
			/** Null for RUN_ENDED, which is never recorded. */
			event: ToolCallEventData | null;
	  };

/**
 * The pipeline, in order (connectors 7.1): current attempt (RUN_ENDED "This run is no longer active."),
 * tool lookup (UNKNOWN_OPERATION "This operation is not available.", OPERATION_CHANGED "This operation
 * changed after the run started. Send a new message to use it."), strict validation (INVALID_ARGUMENTS
 * "Invalid arguments. " plus up to 5 `loc: msg` joined by "; "), query hash, page token (INVALID_CURSOR
 * "This page token is invalid or belongs to another request."), write key and known write, open the
 * client (CONNECTION_UNAUTHORIZED "The connection expired. Reconnect it in Minerva."), consent
 * (CONSENT_REQUIRED, before prepare), prepare, authorize (declaration check, then policy), current attempt
 * again, execute or the write protocol, still active (the attempt is not compared), close the client,
 * page token issue (LIMIT_REACHED "This run has reached its pagination limit." after the provider call).
 *
 * Revocation: the executor checks the run's local `revoked` flag and its state synchronously, with no
 * await in between, immediately before it dispatches any provider request, and again before it returns
 * a result (plan: Strict revocation).
 */
export interface Executor {
	invoke(request: ToolCallRequest): Promise<ToolCallOutcome>;
	/** The tools whose contract still resolves, as the model sees them. */
	declarations(): ToolDeclaration[];
}

/** What the executor runs against: one run's snapshot and the ports. */
export interface ExecutorContext {
	runId: RunId;
	userId: UserId;
	permissions: PolicySnapshot;
	tools: ToolRef[];
	run: RunStatePort;
	credentials: CredentialPort;
	/** Injected in tests. */
	fetch: typeof fetch;
	/** The snapshot's deadline, which bounds a call's wait for one of the run's slots; null or absent for none. */
	deadline?: EpochMs | null;
}

// The write ledger (runs 5.6; plan: Writes): today's RunWrite in the Conversation Durable Object's SQLite.

export type WriteStatus = "dispatched" | "succeeded" | "uncertain";

export interface WriteRecord {
	runId: RunId;
	/** SHA-256 of the canonical JSON of the tool and its normalized fields, page token included (gateway/ledger.ts `writeKey`). */
	key: string;
	status: WriteStatus;
	/** For `succeeded`: what answers a repeat. */
	result: ToolResult | null;
	/** The attempt that dispatched it; a later attempt still settles it. */
	attempt: number;
	dispatchedAt: EpochMs;
	/** min(dispatch + 60 s, run deadline). An alarm marks writes still dispatched 30 s past it uncertain. */
	deadlineAt: EpochMs;
}

export type DispatchResult =
	/** Dispatched: send it, and settle it whatever happens. `deadline` is monotonic. */
	| { kind: "dispatched"; deadline: number }
	/** An identical write already succeeded: answer from its record, nothing is sent. */
	| { kind: "cached"; result: ToolResult }
	| { kind: "refused"; code: "RUN_ENDED" | "WRITE_UNCERTAIN" | "WRITE_IN_PROGRESS"; message: string };

export type Settlement =
	/** Forgotten: the row is deleted, so the same write may be tried again. */
	| { effect: Extract<Effect, "not_applied"> }
	/** `result` is APPLIED_WITHOUT_RESULT when the response was unusable. */
	| { effect: Extract<Effect, "applied">; result: ToolResult }
	/** Pauses every later write in the run. */
	| { effect: Extract<Effect, "unknown"> };

/**
 * Run state the executor needs. Synchronous methods are synchronous on purpose: the Conversation Durable
 * Object answers them from SQLite and memory with no await, which is what makes the revocation and
 * dispatch checks atomic (plan: Strict revocation, Writes).
 *
 * `dispatchWrite` and `settleWrite` may answer later: the Conversation Durable Object first waits until no
 * asynchronous transaction of pi's is open on its storage, since a claim or a settlement made inside one
 * would roll back with it (conversation/store.ts `outside`). The check and the claim still run in one
 * synchronous stretch, after that wait; the executor sends nothing until the claim has answered.
 */
export interface RunStatePort {
	/** Status acting, deadline not passed, attempt equal, not revoked. */
	isCurrent(fence: AttemptFence): boolean;
	/** Status acting, deadline not passed, not revoked; any attempt (for results and recording). */
	isActive(runId: RunId): boolean;
	/** Counts the call if the fence is current; false means RUN_ENDED, not counted. Calls are never limited. */
	countToolCall(fence: AttemptFence): boolean;
	knownWrite(runId: RunId, key: string): WriteRecord | null;
	/** One write dispatched at a time per run; refused when paused, in progress or not current (runs 5.6). */
	dispatchWrite(fence: AttemptFence, key: string): DispatchResult | Promise<DispatchResult>;
	/** Always recorded, even for an older attempt and even when the call that asked for it was cancelled (under waitUntil). */
	settleWrite(runId: RunId, key: string, settlement: Settlement): void | Promise<void>;
	/** The upstream cursor for a token issued to this run for the same tool and query hash, else null. */
	resolvePageToken(runId: RunId, token: string, tool: string, queryHash: string): string | null;
	/** A new opaque token (`tokenUrlsafe(18)`), or null when the run already holds 200. */
	issuePageToken(runId: RunId, tool: string, queryHash: string, upstreamCursor: string): string | null;
}

/** What the Workspace Durable Object lends for one provider call (plan: Credentials and refresh). */
export interface CredentialLease {
	connectionId: ConnectionId;
	provider: string;
	/** The credential generation; `markUnauthorized` compares it. */
	generation: number;
	/** Decrypted only by the caller, for this one call; never stored in pi's state, events or logs. */
	sealed: { ciphertext: string; version: string };
	/** The scopes of the current credentials, for consent checks; null when unknown. */
	scopes: string[] | null;
}

export interface CredentialPort {
	/**
	 * For the call's attempt: refused with RUN_ENDED when the fence is not current, before the Workspace is
	 * asked and again after it answers (it knows the run, not its attempts). Refreshes first when needed
	 * (single-flight per connection). Also refused: CONNECTION_UNAUTHORIZED or PROVIDER_UNAVAILABLE.
	 */
	lease(
		fence: AttemptFence,
		connectionId: ConnectionId,
	): Promise<CredentialLease | { refused: "RUN_ENDED" | "CONNECTION_UNAUTHORIZED" | "PROVIDER_UNAVAILABLE"; message: string }>;
	/** The provider rejected the token: mark the connection "Needs reconnecting" only if still active at this generation. */
	markUnauthorized(connectionId: ConnectionId, generation: number): Promise<void>;
	/** Decrypts a lease's payload with MINERVA_ENCRYPTION_KEYS. */
	open(lease: CredentialLease): Promise<CredentialPayload>;
}
