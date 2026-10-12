// The Sandbox's durable state: one row, written before every step it describes (plan: The sandbox
// lifecycle). It names the container's incarnation, the run and attempt that own it (the newest the object
// has seen, so an older attempt's call is refused), the hardening state, and a destroy still owed.

import type { RunId } from "../contracts/common.ts";
import type { SandboxSpec, SandboxState } from "../contracts/sandbox.ts";
import { parseJson } from "../lib/json.ts";
import { first, type Sql } from "../lib/sql.ts";
import type { Migration } from "../lib/sqlite.ts";

/** Additive only; see lib/sqlite.ts. */
export const SANDBOX_MIGRATIONS: Migration[] = [
	{
		id: 1,
		sql: `CREATE TABLE sandbox_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			state TEXT NOT NULL CHECK (state IN ('none', 'starting', 'hardening', 'verified', 'in_use', 'destroying')),
			incarnation TEXT,
			run_id TEXT,
			attempt INTEGER,
			spec TEXT,
			hardened INTEGER NOT NULL DEFAULT 0,
			started_at INTEGER,
			verified_at INTEGER,
			cleanup_pending INTEGER NOT NULL DEFAULT 0,
			cleanup_reason TEXT,
			lease_until INTEGER,
			updated_at INTEGER NOT NULL
		) STRICT`,
	},
];

export interface StateRow {
	state: SandboxState;
	incarnation: string | null;
	runId: RunId | null;
	attempt: number | null;
	spec: SandboxSpec | null;
	/** The hardening exec succeeded for this incarnation; verification may follow. */
	hardened: boolean;
	startedAt: number | null;
	verifiedAt: number | null;
	cleanupPending: boolean;
	cleanupReason: string | null;
	/** When the container is destroyed if nothing uses it. */
	leaseUntil: number | null;
}

type Raw = {
	state: string;
	incarnation: string | null;
	run_id: string | null;
	attempt: number | null;
	spec: string | null;
	hardened: number;
	started_at: number | null;
	verified_at: number | null;
	cleanup_pending: number;
	cleanup_reason: string | null;
	lease_until: number | null;
};

export const EMPTY: StateRow = {
	state: "none",
	incarnation: null,
	runId: null,
	attempt: null,
	spec: null,
	hardened: false,
	startedAt: null,
	verifiedAt: null,
	cleanupPending: false,
	cleanupReason: null,
	leaseUntil: null,
};

export function readState(sql: Sql): StateRow {
	const row = first<Raw>(sql, "SELECT * FROM sandbox_state WHERE id = 1");
	if (!row) return EMPTY;
	return {
		state: row.state as SandboxState,
		incarnation: row.incarnation,
		runId: row.run_id,
		attempt: row.attempt,
		spec: row.spec === null ? null : (parseJson(row.spec) as unknown as SandboxSpec),
		hardened: row.hardened === 1,
		startedAt: row.started_at,
		verifiedAt: row.verified_at,
		cleanupPending: row.cleanup_pending === 1,
		cleanupReason: row.cleanup_reason,
		leaseUntil: row.lease_until,
	};
}

export function writeState(sql: Sql, state: StateRow, now: number): void {
	sql.exec(
		`INSERT INTO sandbox_state (id, state, incarnation, run_id, attempt, spec, hardened, started_at, verified_at, cleanup_pending, cleanup_reason, lease_until, updated_at)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET state = excluded.state, incarnation = excluded.incarnation, run_id = excluded.run_id,
		   attempt = excluded.attempt, spec = excluded.spec, hardened = excluded.hardened, started_at = excluded.started_at,
		   verified_at = excluded.verified_at, cleanup_pending = excluded.cleanup_pending, cleanup_reason = excluded.cleanup_reason,
		   lease_until = excluded.lease_until, updated_at = excluded.updated_at`,
		state.state,
		state.incarnation,
		state.runId,
		state.attempt,
		state.spec === null ? null : JSON.stringify(state.spec),
		state.hardened ? 1 : 0,
		state.startedAt,
		state.verifiedAt,
		state.cleanupPending ? 1 : 0,
		state.cleanupReason,
		state.leaseUntil,
		now,
	);
}

/** Whether (runId, attempt) is older than the newest owner the object has seen: run ids are UUIDv7, in time order. */
export function olderThan(fence: { runId: RunId; attempt: number }, state: StateRow): boolean {
	if (state.runId === null || state.attempt === null) return false;
	if (fence.runId !== state.runId) return fence.runId < state.runId;
	return fence.attempt < state.attempt;
}
