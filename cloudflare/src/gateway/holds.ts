// A write the policy asks before, held for the user's approval (ARCHITECTURE.md: Writes): what the executor builds, the row
// the write ledger keeps of it in `run_holds`, the `run.held_call` fact told from either, and what the model reads.

import type { Fact } from "@minerva/contract/internal";
import type { ConnectionId, EpochMs, RunId, UserId } from "../shared/rpc.ts";

export type HeldCallData = Extract<Fact, { type: "run.held_call" }>["data"];
/** A resource and action the call needs, as a grant names them, with the labels, the provider's name and the effect. */
export type HeldRequirement = HeldCallData["requirements"][number];

/** Open until a later run uses it for its approval or closes it. */
export type HoldState = "open" | "used" | "closed";

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
	state: HoldState;
	createdAt: EpochMs;
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
} as const;
