// What the contract's procedures share (contract/, served by api/orpc.ts): their context, the implementer,
// refusals in the contract's shape, and the checks that a procedure is called by whom the mount admitted: a
// signed-in user, an instance admin, or a member of the path's workspace.

import { REFUSALS, type RefusalCode, contract } from "@minerva/contract";
import { ORPCError, implement } from "@orpc/server";
import type { SessionUser } from "../accounts/auth.ts";
import { ADMINS_ONLY } from "../accounts/instance.ts";
import type { Outcome } from "../shared/rpc.ts";
import type { Revocation } from "../workspace/core.ts";
import { type Member, STILL_STOPPING } from "./members.ts";

export interface ApiContext {
	/** The request as it arrived. Its body is read only by api/orpc.ts's reader. */
	request: Request;
	env: Env;
	/** The signed-in user; null only on a public route (api/orpc.ts `PUBLIC`) called without a session. */
	user: SessionUser | null;
	/** The caller as a member of the path's workspace, which the mount checked; null outside /api/workspaces/{ws}. */
	member: Member | null;
	/** Whether the mount found the caller an instance admin in D1; only under /api/instance. */
	admin: boolean;
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
 * unless a procedure takes its workspace from elsewhere; this makes sure. Runs before the input is validated. A
 * procedure whose input is detailed (`{params, headers, body}`, for a header) has the path's parameters apart.
 */
export const inWorkspace = api.middleware(async ({ context, next, procedure }, input: unknown) => {
	const detailed = procedure["~orpc"].route.inputStructure === "detailed";
	const fields = (detailed ? (input as { params?: unknown } | undefined)?.params : input) as { workspaceId?: unknown } | undefined;
	const workspaceId = fields?.workspaceId;
	if (context.member === null || workspaceId !== context.member.workspace.id) throw refusal("UNAUTHORIZED", "Unauthorized");
	return next({ context: { member: context.member } });
});

/** The procedures for a signed-in user. The mount refused a visitor before the body was read; this makes sure. */
export const signedIn = api.middleware(async ({ context, next }) => {
	if (context.user === null) throw refusal("UNAUTHORIZED", "Unauthorized");
	return next({ context: { user: context.user } });
});

/**
 * The instance admin's procedures. The mount read the caller's role from D1 before the body; every change also requires it again in
 * its own statement (api/accounts.ts), so a role removed meanwhile counts.
 */
export const instanceAdmin = api.middleware(async ({ context, next }) => {
	if (context.user === null) throw refusal("UNAUTHORIZED", "Unauthorized");
	if (!context.admin) throw refusal("INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
	return next({ context: { user: context.user } });
});
