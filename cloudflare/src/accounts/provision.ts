// Provisioning: every user gets a personal organization they own and our row for its personal workspace,
// with both memberships, and the workspace's Durable Object is initialized (plan: The
// web API). Better Auth creates the user; this runs after, from its hooks (auth-options.ts), for every way
// a user is created (sign-up, an email code, the admin plugin, seed).
//
// D1 has no interactive transactions and the user already exists when this runs, so provisioning is a
// protocol that recovers rather than one transaction:
//   1. One D1 batch inserts the organization, its member, the workspace and its membership, each with
//      ON CONFLICT DO NOTHING and each later row selected from the earlier one, so a retry completes what
//      is missing and never makes a second one (the organization's `personalOwner` and the workspace's
//      `personal_owner` are unique).
//   2. The Workspace object is initialized (idempotent) and `workspaces.initialized_at` set.
//   3. `user.provisionedAt` is set. Until then the user is pending.
// A crash or failure anywhere leaves `provisionedAt` null, and the next session created for the user (a
// sign-in) and the next `/api/me` run all three steps again (`ensureProvisioned`). `/api/me` lists only
// initialized workspaces, so a half-made one is never shown.

import { workspaceObject } from "../addressing.ts";
import type { WorkspaceRef } from "../contracts/common.ts";
import { uuid7 } from "../lib/random.ts";

export interface WorkspaceRow {
	id: string;
	kind: "personal" | "team";
	name: string;
	jurisdiction: "eu" | null;
	created_at: number;
	initialized_at: number | null;
}

const WORKSPACE_COLUMNS = "w.id, w.kind, w.name, w.jurisdiction, w.created_at, w.initialized_at";

/** Runs all of provisioning for the user (above); safe to repeat and to run concurrently. */
export async function provision(env: Env, userId: string, now = Date.now()): Promise<WorkspaceRow> {
	const db = env.DB;
	const at = new Date(now).toISOString();
	// The slug is the organization's own id: nobody can claim it ahead of the user.
	const organizationId = uuid7(now);
	const results = await db.batch([
		db
			.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt", "personalOwner") VALUES (?, 'Personal', ?, ?, ?) ON CONFLICT DO NOTHING`)
			.bind(organizationId, organizationId, at, userId),
		db
			.prepare(
				`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") SELECT ?, o.id, ?, 'owner', ? FROM "organization" o WHERE o."personalOwner" = ? ON CONFLICT DO NOTHING`,
			)
			.bind(uuid7(now), userId, at, userId),
		db
			.prepare(
				"INSERT INTO workspaces (id, organization_id, kind, name, personal_owner, created_at) " +
					`SELECT ?, o.id, 'personal', 'Personal', ?, ? FROM "organization" o WHERE o."personalOwner" = ? ON CONFLICT DO NOTHING`,
			)
			.bind(uuid7(now), userId, now, userId),
		db
			.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) SELECT w.id, ?, 'owner', ? FROM workspaces w WHERE w.personal_owner = ? ON CONFLICT DO NOTHING")
			.bind(userId, now, userId),
		db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces w WHERE w.personal_owner = ?`).bind(userId),
	]);
	const workspace = results[4]?.results[0] as WorkspaceRow | undefined;
	if (!workspace) throw new Error(`Provisioning made no workspace for user ${userId}`);
	await ensureInitialized(env, workspace, userId);
	await db.prepare(`UPDATE "user" SET "provisionedAt" = ? WHERE id = ? AND "provisionedAt" IS NULL`).bind(new Date().toISOString(), userId).run();
	return workspace;
}

/** Provisions the user if it is still pending; a failure is logged and left for the next try. */
export async function ensureProvisioned(env: Env, userId: string): Promise<void> {
	try {
		const row = await env.DB.prepare(`SELECT "provisionedAt" AS at FROM "user" WHERE id = ?`).bind(userId).first<{ at: string | null }>();
		if (row && row.at === null) await provision(env, userId);
	} catch (error) {
		console.error("Provisioning failed; it is retried on the next sign-in or /api/me", userId, error);
	}
}

const INIT_ATTEMPTS = 3;

/** Initializes the workspace's Durable Object (idempotent) and records it in D1; throws after the last attempt. */
export async function ensureInitialized(env: Env, workspace: WorkspaceRow, ownerId: string): Promise<void> {
	if (workspace.initialized_at !== null) return;
	const ref: WorkspaceRef = { id: workspace.id, jurisdiction: workspace.jurisdiction };
	let failure: unknown;
	for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
		try {
			await workspaceObject(env, ref).init({ workspace: ref, kind: workspace.kind, ownerId, createdAt: workspace.created_at });
			const now = Date.now();
			await env.DB.prepare("UPDATE workspaces SET initialized_at = ? WHERE id = ? AND initialized_at IS NULL").bind(now, workspace.id).run();
			workspace.initialized_at = now;
			return;
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}

/** The workspace's creator, who owns its object: the personal owner, or for a team its first owner. */
export async function workspaceOwner(db: D1Database, workspaceId: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT COALESCE(w.personal_owner, (SELECT m.user_id FROM memberships m WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.created_at, m.user_id LIMIT 1)) AS owner " +
				"FROM workspaces w WHERE w.id = ?",
		)
		.bind(workspaceId)
		.first<{ owner: string | null }>();
	return row?.owner ?? null;
}

export interface MembershipOut {
	id: string;
	name: string;
	kind: "personal" | "team";
	role: "owner" | "admin" | "member";
}

/**
 * Every workspace the user belongs to, personal before team, then by creation. One whose
 * object cannot be initialized yet is left out until it can.
 */
export async function listWorkspaces(env: Env, userId: string): Promise<MembershipOut[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${WORKSPACE_COLUMNS}, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id ` +
			"WHERE m.user_id = ? ORDER BY w.kind ASC, w.created_at ASC, w.id ASC",
	)
		.bind(userId)
		.all<WorkspaceRow & { role: MembershipOut["role"] }>();
	const out: MembershipOut[] = [];
	for (const row of results) {
		if (row.initialized_at === null) {
			const owner = await workspaceOwner(env.DB, row.id);
			if (owner === null) continue;
			try {
				await ensureInitialized(env, row, owner);
			} catch (error) {
				console.error("Workspace initialization failed", row.id, error);
				continue;
			}
		}
		out.push({ id: row.id, name: row.name, kind: row.kind, role: row.role });
	}
	return out;
}
