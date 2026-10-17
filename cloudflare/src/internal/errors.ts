// The internal API's errors as its handlers throw them (contract/src/internal/common.ts `INTERNAL_REFUSALS`).

import { INTERNAL_REFUSALS, type InternalRefusalCode } from "@minerva/contract/internal";
import { ORPCError } from "@orpc/server";
import type { InternalAnswer } from "../conversation/conversation.ts";

/** A refusal as the internal contract declares it, with the data its code declares. */
export function internalRefusal(code: InternalRefusalCode, message: string, data?: object): ORPCError<InternalRefusalCode, unknown> {
	return new ORPCError(code, { defined: true, status: INTERNAL_REFUSALS[code], message, ...(data === undefined ? {} : { data }) });
}

export const MISMATCH = "This conversation belongs to another organization or workspace.";

/** A Conversation's answer to a Laravel command: its value, or its refusal thrown as the contract declares it. */
export function answered<T>(answer: InternalAnswer<T>): T {
	if (answer.ok) return answer.value;
	if (answer.code === "FACTS_PRUNED") throw factsPruned(answer.floor);
	throw internalRefusal("SCOPE_MISMATCH", MISMATCH);
}

/** A replay from below `floor` less one: the facts Laravel lacks are deleted. */
export function factsPruned(floor: number): ORPCError<InternalRefusalCode, unknown> {
	return internalRefusal("FACTS_PRUNED", `This conversation's facts before ${floor} are no longer kept.`, { floor });
}
