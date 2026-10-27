// A write the policy asks before, held for the user's approval (ARCHITECTURE.md: Writes): what the executor builds, the row
// the write ledger keeps of it in `run_holds` and how a later run decides it, the `run.held_call` fact told from either, and
// what the model reads.

import type { Fact } from "@minerva/contract/internal";
import type { ConnectionId, EpochMs, RunId, UserId } from "../shared/rpc.ts";

export type HeldCallData = Extract<Fact, { type: "run.held_call" }>["data"];
/** A resource and action the call needs, as a grant names them, with the labels, the provider's name and the effect. */
export type HeldRequirement = HeldCallData["requirements"][number];

/**
 * What an approved call came to in the continuation that carried it out: it ran, with its result's JSON cut to
 * MAX_OUTCOME_RESULT characters; it failed, with the message its call answered; it did not run, because its tool is not
 * available any more, changed since the user approved it, or an approved call before it did not succeed; or nobody knows.
 */
export type HoldOutcome =
	| { kind: "ran"; result: string }
	| { kind: "failed"; message: string }
	| { kind: "not_run"; reason: "unavailable" | "changed" | "earlier" }
	| { kind: "unknown" };

/** A ran outcome's result is cut to this many characters, in the hold and in the note. */
export const MAX_OUTCOME_RESULT = 4000;

/**
 * Open until a later run decides it: a continuation uses it, approved or declined, or a start without an approval closes
 * it. An approved one gets its `outcome` once known; its continuation's write, if it made one, names the hold
 * (`WriteNote.approved`), so the ledger answers for it while the outcome is not stored.
 */
export type HoldDecision =
	| { state: "open" }
	| { state: "closed"; by: RunId }
	| { state: "used"; by: RunId; approve: false }
	| { state: "used"; by: RunId; approve: true; outcome: HoldOutcome | null };

/** A call held for approval, as the executor builds it. */
export interface Hold {
	/** Its write key in the held run (ledger.ts `writeKey`). */
	key: string;
	/** The keyed hash its `tool_call` rows show (results.ts `writeId`). */
	write: string;
	userId: UserId;
	tool: string;
	/** `Gmail: Send mail`. */
	label: string;
	connection: ConnectionId;
	provider: string;
	operation: string;
	/** The operation's fingerprint when it was held (registry.ts). */
	contract: string;
	/** The validated fields' canonical JSON, never cut. */
	arguments: string;
	requirements: HeldRequirement[];
}

/** A hold as `run_holds` keeps it. */
export interface HeldCall extends Hold {
	runId: RunId;
	/** 1 to MAX_HOLDS, in the order the run held them. */
	position: number;
	decision: HoldDecision;
	createdAt: EpochMs;
}

/** A continuation's held call, as its snapshot copies it whole: the user's decision, and what the call was. */
export type DecidedHold = Hold & { runId: RunId; position: number; approve: boolean };

/** The held run a continuation answers and its decided holds, in position order (`StartSnapshot.approval`). */
export interface Approval {
	run: RunId;
	holds: DecidedHold[];
}

/** A hold a start without an approval closes once its prompt is committed (`RunSnapshot.closed`), with what the note names. */
export interface ClosedHold {
	run: RunId;
	position: number;
	label: string;
}

/** The pass an approved call carries into the executor: its hold, the key it must have, and the requirements the user saw. */
export interface ApprovedCall {
	run: RunId;
	position: number;
	key: string;
	requirements: readonly HeldRequirement[];
}

/** The `run.held_call` fact's data: the hold at its position. */
export function heldCallData(hold: Hold, position: number): HeldCallData {
	return {
		position,
		tool: hold.tool,
		label: hold.label,
		connection: hold.connection,
		provider: hold.provider,
		operation: hold.operation,
		requirements: hold.requirements,
		arguments: hold.arguments,
		write: hold.write,
	};
}

/** What the model reads for each refusal around a hold. */
export const APPROVAL_MESSAGES = {
	/** The call is held. It tells the model to stop and point the user at the card, not to ask for a typed yes. */
	required:
		"Minerva asked the user to approve this. It has not run. Do not call it again or try another way. Finish your turn by saying what waits for approval. The user approves or declines it with the buttons Minerva shows in the chat, so do not ask them to reply yes or no. The outcome comes in the next turn.",
	/** A write after the run held one, which would otherwise run out of the model's order. */
	pending: "An earlier action waits for the user's approval. Make no more changes in this turn.",
	tooLarge: "This action is too large to show the user for approval. Split it into smaller ones.",
	/** The run was not attended, so nobody can answer a card. */
	unavailable: "This needs the user's approval, which nobody can give in this run. Do not retry. Say what you would do.",
	/** Its fact would not parse, so Laravel could not show it. */
	unshown: "This needs the user's approval, but it cannot be shown to them. Do not retry. Say what you would do.",
	/** An approved call whose tool the continuation does not have. */
	gone: "This is not available any more, so it did not run.",
	/** An approved call whose tool, fields or destinations differ from what the user approved. */
	changed: "This changed since the user approved it, so it did not run.",
} as const;
