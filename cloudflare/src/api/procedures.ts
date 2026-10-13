// What the contract's procedures share (contract/, served by api/orpc.ts): their context, the implementer,
// refusals in the contract's shape, and the check that a procedure of a workspace is called on the workspace
// whose membership the mount checked.

import { REFUSALS, type RefusalCode, contract } from "@minerva/contract";
import { ORPCError, implement } from "@orpc/server";
import type { Outcome } from "../shared/rpc.ts";
import type { Revocation } from "../workspace/core.ts";
import { type Member, STILL_STOPPING } from "./members.ts";

export interface ApiContext {
	/** The request as it arrived. Its body is read only by api/orpc.ts's reader. */
	request: Request;
	/** The caller as a member of the path's workspace, which the mount checked; null outside /api/workspaces/{ws}. */
	member: Member | null;
}

export const api = implement(contract).$context<ApiContext>();

/** A refusal as the contract declares it (every code is declared, so it is `defined`). */
export function refusal(code: RefusalCode, message: string): ORPCError<RefusalCode, undefined> {
	return new ORPCError(code, { defined: true, status: REFUSALS[code], message });
}

/** The outcome's value, or its refusal thrown. */
export function unwrap<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw refusal(outcome.refusal.code, outcome.refusal.detail);
	return outcome.value;
}

/** A change that stopped runs answers once every stop is acknowledged, or 503 `RUNS_STILL_STOPPING` (api/members.ts). */
export function checkStopped(revocation: Revocation): void {
	if (revocation === "pending") throw refusal("RUNS_STILL_STOPPING", STILL_STOPPING);
}

/**
 * The procedures of a workspace: the input's workspace must be the path's, whose membership the mount checked
 * before the body was read. oRPC's input merges the body and query under the path's parameters, so they agree
 * unless a procedure takes its workspace from elsewhere; this makes sure. Runs before the input is validated.
 */
export const inWorkspace = api.middleware(async ({ context, next }, input: unknown) => {
	const workspaceId = (input as { workspaceId?: unknown } | undefined)?.workspaceId;
	if (context.member === null || workspaceId !== context.member.workspace.id) throw refusal("UNAUTHORIZED", "Unauthorized");
	return next({ context: { member: context.member } });
});
