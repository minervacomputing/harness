// The internal API's errors as its handlers throw them (contract/src/internal/common.ts `INTERNAL_REFUSALS`).

import { INTERNAL_REFUSALS, type InternalRefusalCode } from "@minerva/contract/internal";
import { ORPCError } from "@orpc/server";

/** A refusal as the internal contract declares it. */
export function internalRefusal(code: InternalRefusalCode, message: string): ORPCError<InternalRefusalCode, undefined> {
	return new ORPCError(code, { defined: true, status: INTERNAL_REFUSALS[code], message });
}
