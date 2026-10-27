// The executor's run-state port over the Conversation Durable Object's own state: its runs (read through
// `RunTable`, which the object implements over its runs table and memory), the write ledger and page
// tokens. Every method is synchronous, so a check and the claim or answer that depends on it happen with
// no await between them (ARCHITECTURE.md: Strict revocation, Writes).

import type { AttemptFence, EpochMs, RunId, RunStatus } from "../shared/rpc.ts";
import type { Clock } from "./clock.ts";
import type { HeldCall, Hold } from "./holds.ts";
import { type DispatchResult, type HoldResult, RUN_ENDED_MESSAGE, type Settlement, type WriteLedger, type WriteNote, type WriteRecord } from "./ledger.ts";
import type { PageTokens } from "./page-tokens.ts";

/**
 * Run state the executor needs. Synchronous methods are synchronous on purpose: the Conversation Durable
 * Object answers them from SQLite and memory with no await, which is what makes the revocation and
 * dispatch checks atomic (ARCHITECTURE.md: Strict revocation, Writes).
 *
 * `dispatchWrite`, `holdCall` and `settleWrite` may answer later: the Conversation Durable Object first waits until no
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
	/**
	 * One write dispatched at a time per run; refused when paused, in progress or not current. `note` is what its settlement
	 * reports: the tool, the connection and the keyed hash its `tool_call` event shows.
	 */
	dispatchWrite(fence: AttemptFence, key: string, note?: WriteNote): DispatchResult | Promise<DispatchResult>;
	/** Always recorded, even for an older attempt and even when the call that asked for it was cancelled (under waitUntil). */
	settleWrite(runId: RunId, key: string, settlement: Settlement): void | Promise<void>;
	/** The run's hold of this write, which a repeat answers from (holds.ts). */
	heldCall(runId: RunId, key: string): HeldCall | null;
	/** Whether a write was refused APPROVAL_PENDING in the run, which refuses every later one. */
	writesClosed(runId: RunId): boolean;
	/**
	 * Holds a call the policy asks before, with its `run.held_call` fact in the same write, before the model hears of it.
	 * Refused when not current, when the run's writes are paused, and when they are closed or it holds MAX_HOLDS calls.
	 */
	holdCall(fence: AttemptFence, hold: Hold): HoldResult | Promise<HoldResult>;
	/** The upstream cursor for a token issued to this run for the same tool and query hash, else null. */
	resolvePageToken(runId: RunId, token: string, tool: string, queryHash: string): string | null;
	/** A new opaque token (`tokenUrlsafe(18)`), or null when the run already holds 200. */
	issuePageToken(runId: RunId, tool: string, queryHash: string, upstreamCursor: string): string | null;
}

/**
 * The states in which a run's current attempt may still act: call tools and models, append fenced events,
 * checkpoint. An expired run (deadline passed) counts as inactive for every check before it is marked
 * `timed_out`.
 */
export type ActingStatus = "provisioning" | "running";

/** What the checks read of a run, synchronously. */
export interface RunState {
	status: RunStatus;
	attempt: number;
	/** Fixed at start; null for none. */
	deadline: EpochMs | null;
	/** Set synchronously by a revocation or an emergency stop (ARCHITECTURE.md: Strict revocation). */
	revoked: boolean;
}

export interface RunTable {
	/** The run's state now, or null for a run this object does not hold. */
	get(runId: RunId): RunState | null;
	/** Adds one to the run's `tool_calls` (usage); called only for a current fence. */
	countToolCall(runId: RunId): void;
}

const ACTING: ReadonlySet<RunStatus> = new Set<ActingStatus>(["provisioning", "running"]);

/** An expired run counts as inactive for every check before it is marked timed_out. */
export function canAct(run: RunState | null, now: EpochMs): run is RunState {
	return run !== null && ACTING.has(run.status) && !run.revoked && (run.deadline === null || run.deadline > now);
}

export class LedgerRunState implements RunStatePort {
	readonly #runs: RunTable;
	readonly #ledger: WriteLedger;
	readonly #tokens: PageTokens;
	readonly #clock: Clock;

	constructor(runs: RunTable, ledger: WriteLedger, tokens: PageTokens, clock: Clock) {
		this.#runs = runs;
		this.#ledger = ledger;
		this.#tokens = tokens;
		this.#clock = clock;
	}

	isCurrent(fence: AttemptFence): boolean {
		const run = this.#runs.get(fence.runId);
		return canAct(run, this.#clock.now()) && run.attempt === fence.attempt;
	}

	isActive(runId: RunId): boolean {
		return canAct(this.#runs.get(runId), this.#clock.now());
	}

	countToolCall(fence: AttemptFence): boolean {
		if (!this.isCurrent(fence)) return false;
		this.#runs.countToolCall(fence.runId);
		return true;
	}

	knownWrite(runId: RunId, key: string): WriteRecord | null {
		return this.#ledger.known(runId, key);
	}

	dispatchWrite(fence: AttemptFence, key: string, note?: WriteNote): DispatchResult {
		const run = this.#runs.get(fence.runId);
		if (!this.isCurrent(fence) || run === null) return { kind: "refused", code: "RUN_ENDED", message: RUN_ENDED_MESSAGE };
		return this.#ledger.dispatch(fence, key, run.deadline, note);
	}

	settleWrite(runId: RunId, key: string, settlement: Settlement): void {
		this.#ledger.settle(runId, key, settlement);
	}

	heldCall(runId: RunId, key: string): HeldCall | null {
		return this.#ledger.held(runId, key);
	}

	writesClosed(runId: RunId): boolean {
		return this.#ledger.closed(runId);
	}

	holdCall(fence: AttemptFence, hold: Hold): HoldResult {
		if (!this.isCurrent(fence)) return { kind: "refused", code: "RUN_ENDED", message: RUN_ENDED_MESSAGE };
		return this.#ledger.hold(fence.runId, hold);
	}

	resolvePageToken(runId: RunId, token: string, tool: string, queryHash: string): string | null {
		return this.#tokens.resolve(runId, token, tool, queryHash);
	}

	issuePageToken(runId: RunId, tool: string, queryHash: string, upstreamCursor: string): string | null {
		return this.#tokens.issue(runId, tool, queryHash, upstreamCursor);
	}
}
