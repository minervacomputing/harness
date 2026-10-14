// Membership of the workspace in the URL, for every `/api/workspaces/{ws}/…` route (the contract's mount in
// api/orpc.ts, and the routes beside it), in this order: CSRF on unsafe methods (the router, before any route),
// then a session (401), then a membership row in D1 for (workspace, user) (401 as well, never 403 or 404, so a
// workspace that is not yours looks like one that does not exist), and only then the Workspace Durable Object.
// Its name comes from D1's row, never from the client (addressing.ts), and it is given the verified user and
// role as its `Caller`; it never takes a user from the request. Schema validation (422) comes after this.

import type { Context } from "hono";
import type { CurrentSession } from "../accounts/auth.ts";
import { type WorkspaceRow, ensureInitialized, workspaceOwner } from "../accounts/provision.ts";
import { workspaceObject } from "../addressing.ts";
import { HttpError, unauthorized } from "../http/errors.ts";
import type { AppEnv } from "../http/router.ts";
import type { Caller, Role, WorkspaceRef } from "../shared/rpc.ts";
import type { Workspace } from "../workspace/workspace.ts";

export interface Member {
	caller: Caller;
	workspace: WorkspaceRef;
	/** The workspace's object, named from D1's row. */
	object: DurableObjectStub<Workspace>;
	/** Better Auth's session id (`oauth_flows` are kept per session). */
	sessionId: string;
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
	// A workspace whose object a failure left uninitialized is initialized on first use (ARCHITECTURE.md: The web API).
	if (row.initialized_at === null) {
		const owner = await workspaceOwner(env.DB, row.id);
		if (owner === null) throw new Error(`Workspace ${row.id} has no owner to initialize it for`);
		await ensureInitialized(env, row, owner);
	}
	const workspace: WorkspaceRef = { id: row.id, jurisdiction: row.jurisdiction };
	return { caller: { userId: user.id, role: row.role }, workspace, object: workspaceObject(env, workspace), sessionId: session.sessionId };
}

/**
 * A change that stopped runs is answered only once every stop is acknowledged (ARCHITECTURE.md: Strict revocation).
 * When that takes more than 10 seconds the change stays saved, the runs stop shortly after, and the
 * request answers 503 `RUNS_STILL_STOPPING` with this (procedures.ts `checkStopped`).
 */
export const STILL_STOPPING = "Your change was saved, but some running chats have not stopped yet. They will stop shortly.";

