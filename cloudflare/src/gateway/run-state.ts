// The executor's run-state port over the Conversation Durable Object's own state: its runs (read through
// `RunTable`, which the object implements over its runs table and memory), the write ledger and page
// tokens. Every method is synchronous, so a check and the claim or answer that depends on it happen with
// no await between them (plan: Strict revocation, Writes; runs 5.1).

import type { AttemptFence, EpochMs, RunId } from "../contracts/common.ts";
import type { DispatchResult, RunStatePort, Settlement, WriteRecord } from "../contracts/executor.ts";
import type { ActingStatus, RunStatus } from "../contracts/runs.ts";
import type { Clock } from "./clock.ts";
import { RUN_ENDED_MESSAGE, type WriteLedger } from "./ledger.ts";
import type { PageTokens } from "./page-tokens.ts";

/** What the checks read of a run, synchronously. */
export interface RunState {
	status: RunStatus;
	attempt: number;
	/** Fixed at start; null for none. */
	deadline: EpochMs | null;
	/** Set synchronously by a revocation or an emergency stop (plan: Strict revocation). */
	revoked: boolean;
}

export interface RunTable {
	/** The run's state now, or null for a run this object does not hold. */
	get(runId: RunId): RunState | null;
	/** Adds one to the run's `tool_calls` (usage); called only for a current fence. */
	countToolCall(runId: RunId): void;
}

const ACTING: ReadonlySet<RunStatus> = new Set<ActingStatus>(["provisioning", "running"]);

/** An expired run counts as inactive for every check before it is marked timed_out (runs 2.5). */
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

	dispatchWrite(fence: AttemptFence, key: string): DispatchResult {
		const run = this.#runs.get(fence.runId);
		if (!this.isCurrent(fence) || run === null) return { kind: "refused", code: "RUN_ENDED", message: RUN_ENDED_MESSAGE };
		return this.#ledger.dispatch(fence, key, run.deadline);
	}

	settleWrite(runId: RunId, key: string, settlement: Settlement): void {
		this.#ledger.settle(runId, key, settlement);
	}

	resolvePageToken(runId: RunId, token: string, tool: string, queryHash: string): string | null {
		return this.#tokens.resolve(runId, token, tool, queryHash);
	}

	issuePageToken(runId: RunId, tool: string, queryHash: string, upstreamCursor: string): string | null {
		return this.#tokens.issue(runId, tool, queryHash, upstreamCursor);
	}
}
