// The attempt gate's rules (ARCHITECTURE.md: Attempts and recovery), as pure functions. The object
// applies the decision in one transaction, syncs storage, and only then lets pi open
// (conversation.ts, the harness factory).

import type { RunStatus } from "../shared/rpc.ts";
import { ACTIVE } from "./events.ts";

/** At most attempts 1, 2 and 3 exist (MAX_RESTARTS = 2). */
export const MAX_ATTEMPTS = 3;
/** No restart with less than this left before the deadline. */
export const RESTART_MIN_REMAINING_MS = 30_000;

/**
 * What pi holds for a run: no input yet (`not_submitted`), work in progress (its submission queued or
 * placed, or settled with a live task of its own left), or a settled submission with nothing of its own
 * left, which is reconciled from pi's record rather than restarted.
 */
export type PiWork = "not_submitted" | "in_progress" | "settled";

export type SubmissionStatus = "queued" | "placed" | "done" | "unanswered";

/**
 * The run's submission first: without one, whatever its session holds is another run's work. `ownLive` counts the run's
 * own live tasks (pi-work.ts `belongs`), which keep its work in progress after its submission settled.
 */
export function classifyWork(submission: SubmissionStatus | undefined, ownLive: number): PiWork {
	if (submission === undefined) return "not_submitted";
	if (submission === "queued" || submission === "placed") return "in_progress";
	return ownLive > 0 ? "in_progress" : "settled";
}

export interface GateRun {
	status: RunStatus;
	attempt: number;
	deadline: number | null;
	/** Its conversation has no organization: one the Workspace made, which runs nothing since chunk 13b. */
	inert: boolean;
}

export type GateDecision =
	/** Nothing to do: no active run, a queued one (recovery activates it), or one pi has no unsettled work for. */
	| { kind: "none" }
	/** The run of a conversation with no organization: `cancelled`, "Stopped.", whatever pi holds for it. */
	| { kind: "cancelled" }
	/** The deadline passed while the object was away: `timed_out`, "The run took too long." */
	| { kind: "timed_out" }
	/** Past the third attempt or within 30 s of the deadline: `worker_exited`. */
	| { kind: "worker_exited" }
	/** A new attempt: the attempt incremented and the marker `{status: "provisioning", attempt}` appended. */
	| { kind: "restart"; attempt: number };

/**
 * A restart is pi opening in a new instance while a `provisioning` or `running` run has unsettled pi work.
 * An inert conversation's run is cancelled first. Queued runs have no attempt yet: no marker. Expired runs end
 * as `timed_out` first, since the gate runs before any due job, the deadline's included (gate review, minor).
 */
export function decideGate(run: GateRun | null, work: PiWork | null, now: number): GateDecision {
	if (run === null || !ACTIVE.has(run.status)) return { kind: "none" };
	if (run.inert) return { kind: "cancelled" };
	if (run.deadline !== null && run.deadline <= now) return { kind: "timed_out" };
	if (run.status === "queued") return { kind: "none" };
	if (work !== "in_progress") return { kind: "none" };
	if (run.attempt >= MAX_ATTEMPTS) return { kind: "worker_exited" };
	if (run.deadline !== null && run.deadline - now < RESTART_MIN_REMAINING_MS) return { kind: "worker_exited" };
	return { kind: "restart", attempt: run.attempt + 1 };
}
