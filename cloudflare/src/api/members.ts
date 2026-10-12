// Membership of the workspace in the URL (web-api 7), for every `/api/workspaces/{ws}/…` JSON route, in
// Ninja's `WorkspaceMember` order: CSRF on unsafe methods (the router, before any route), then a session
// (401), then a membership row in D1 for (workspace, user) (401 as well, never 403 or 404, so a workspace
// that is not yours looks like one that does not exist), and only then the Workspace Durable Object. Its
// name comes from D1's row, never from the client (addressing.ts), and it is given the verified user and
// role as its `Caller`; it never takes a user from the request. Schema validation (422) comes after this,
// in the route.

import type { Context } from "hono";
import { type CurrentSession, currentSession, withSessionCookies } from "../accounts/auth.ts";
import { type WorkspaceRow, ensureInitialized, workspaceOwner } from "../accounts/provision.ts";
import { workspaceObject } from "../addressing.ts";
import type { Caller, Outcome, Refusal, Revocation, Role, WorkspaceRef } from "../contracts/common.ts";
import { HttpError, detail, unauthorized } from "../http/errors.ts";
import type { AppEnv } from "../http/router.ts";
import type { Workspace } from "../workspace/workspace.ts";

export interface Member {
	caller: Caller;
	workspace: WorkspaceRef;
	/** The workspace's object, named from D1's row. */
	object: DurableObjectStub<Workspace>;
	/** Better Auth's session id (`oauth_flows` are kept per session). */
	sessionId: string;
}

export type MemberHandler = (c: Context<AppEnv>, member: Member) => Promise<Response>;

/**
 * A route of the workspace named by its `:workspace` parameter. Better Auth's cookies from reading the
 * session (a refresh, or clearing a stale cookie) go on whatever the route answers, refusals included.
 */
export function memberRoute(handler: MemberHandler): (c: Context<AppEnv>) => Promise<Response> {
	return async (c) => {
		const session = await currentSession(c.env, c.req.raw);
		let response: Response;
		try {
			response = await handler(c, await member(c.env, session, param(c, "workspace")));
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;
			response = error.response;
		}
		return withSessionCookies(response, session);
	};
}

/** A parameter of the route's path, which its pattern guarantees. */
export function param(c: Context<AppEnv>, name: string): string {
	const value = c.req.param(name);
	if (value === undefined) throw new Error(`The route has no parameter ${name}`);
	return value;
}

/** The caller as a member of the workspace, or 401 `Unauthorized`. */
export async function member(env: Env, session: CurrentSession, workspaceId: string): Promise<Member> {
	const user = session.user;
	if (!user || !session.sessionId) throw new HttpError(unauthorized());
	const row = await env.DB.prepare(
		"SELECT w.id, w.kind, w.name, w.jurisdiction, w.created_at, w.initialized_at, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id " +
			"WHERE m.workspace_id = ? AND m.user_id = ?",
	)
		.bind(workspaceId, user.id)
		.first<WorkspaceRow & { role: Role }>();
	if (!row) throw new HttpError(unauthorized());
	// A workspace whose object a failure left uninitialized is initialized on first use (plan: The web API).
	if (row.initialized_at === null) {
		const owner = await workspaceOwner(env.DB, row.id);
		if (owner === null) throw new Error(`Workspace ${row.id} has no owner to initialize it for`);
		await ensureInitialized(env, row, owner);
	}
	const workspace: WorkspaceRef = { id: row.id, jurisdiction: row.jurisdiction };
	return { caller: { userId: user.id, role: row.role }, workspace, object: workspaceObject(env, workspace), sessionId: session.sessionId };
}

/** A Durable Object's refusal as Ninja's `HttpError`: `{"detail": …}` with its status. */
export function refused(refusal: Refusal): Response {
	return detail(refusal.status, refusal.detail);
}

/** The value of an outcome, or its refusal thrown as the answer. */
export function valueOf<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new HttpError(refused(outcome.refusal));
	return outcome.value;
}

/**
 * A change that stopped runs is answered only once every stop is acknowledged (plan: Strict revocation).
 * When that takes more than 10 seconds the change stays saved, the runs stop shortly after, and the
 * request answers 503 with this.
 */
export const STILL_STOPPING = "Your change was saved, but some running chats have not stopped yet. They will stop shortly.";

export function afterRevocation(revocation: Revocation, response: Response): Response {
	return revocation === "pending" ? detail(503, STILL_STOPPING) : response;
}
