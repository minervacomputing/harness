// The Sandbox's durable state: one row, written before every step it describes (ARCHITECTURE.md: The sandbox
// lifecycle). It names the container's incarnation, the run and attempt that own it (the newest the object
// has seen, so an older attempt's call is refused), the hardening state, and a destroy still owed. Each
// incarnation's span (when it started, its last lease, when and how it ended) changes with the row, in the
// same transaction, and is what the run's container time is charged from.

import { parseJson } from "../lib/json.ts";
import { first, type Sql } from "../lib/sql.ts";
import type { EpochMs, RunId } from "../shared/rpc.ts";
import { HARD_GRACE_MS, type SandboxSpec } from "./constants.ts";

/**
 * `starting → hardening → verified → in_use → destroying`. Before `verified` no agent command or file
 * operation is admitted. A Sandbox Durable Object that restarts never reuses a running container it did
 * not verify in its current incarnation: it destroys it first. A failed `destroy()` leaves `cleanupPending`
 * and is retried by an alarm.
 */
export type SandboxState = "none" | "starting" | "hardening" | "verified" | "in_use" | "destroying";

// The table's schema steps are in schema.ts, apart so the account tests (Node) can read their ids.
export { SANDBOX_MIGRATIONS } from "./schema.ts";

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

/**
 * How an incarnation went away: `destroyed` when a destroy answered; `gone` when the object found the
 * container already stopped, which it learns only when it looks, so the span's end is when it noticed.
 */
export type SpanEnd = "destroyed" | "gone";

export type SpanChange =
	| { kind: "open"; incarnation: string; runId: RunId; attempt: number; startedAt: EpochMs; leaseUntil: EpochMs }
	| { kind: "lease"; incarnation: string; leaseUntil: EpochMs }
	| { kind: "close"; incarnation: string; endedAt: EpochMs; ended: SpanEnd };

/** What the state going from `previous` to `next` at `now` does to the spans; `ended` says why an incarnation went away. */
export function spanChange(previous: StateRow, next: StateRow, now: EpochMs, ended: SpanEnd | null): SpanChange[] {
	const changes: SpanChange[] = [];
	if (previous.incarnation !== null && previous.incarnation !== next.incarnation) {
		if (ended === null) throw new Error(`The incarnation ${previous.incarnation} went away without saying how.`);
		changes.push({ kind: "close", incarnation: previous.incarnation, endedAt: now, ended });
	}
	if (next.incarnation === null) return changes;
	if (next.incarnation !== previous.incarnation) {
		const { runId, attempt, startedAt, leaseUntil } = next;
		if (runId === null || attempt === null || startedAt === null || leaseUntil === null) throw new Error(`The incarnation ${next.incarnation} has no run, start or lease.`);
		changes.push({ kind: "open", incarnation: next.incarnation, runId, attempt, startedAt, leaseUntil });
	} else if (next.leaseUntil !== null && next.leaseUntil !== previous.leaseUntil) {
		changes.push({ kind: "lease", incarnation: next.incarnation, leaseUntil: next.leaseUntil });
	}
	return changes;
}

/** Writes the state row and its span changes in one transaction. `ended` is required when the incarnation goes away. */
export function writeState(sql: Sql, state: StateRow, now: number, ended: SpanEnd | null = null): void {
	sql.transaction(() => {
		const changes = spanChange(readState(sql), state, now, ended);
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
		for (const change of changes) {
			if (change.kind === "open") {
				sql.exec(
					"INSERT INTO container_spans (incarnation, run_id, attempt, started_at, lease_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (incarnation) DO NOTHING",
					change.incarnation,
					change.runId,
					change.attempt,
					change.startedAt,
					change.leaseUntil,
				);
			} else if (change.kind === "lease") {
				sql.exec("UPDATE container_spans SET lease_until = ? WHERE incarnation = ? AND ended_at IS NULL", change.leaseUntil, change.incarnation);
			} else {
				sql.exec("UPDATE container_spans SET ended_at = ?, ended = ? WHERE incarnation = ? AND ended_at IS NULL", change.endedAt, change.ended, change.incarnation);
			}
		}
	});
}

/** One container incarnation of a run: open until it ends. */
export type ContainerSpan = { startedAt: EpochMs; leaseUntil: EpochMs } & ({ endedAt: null; ended: null } | { endedAt: EpochMs; ended: SpanEnd });

/**
 * What `seal` answers: the run's spans, and since when the object keeps them. A run created before `since`
 * may have had a container an older version started, which has no span.
 */
export interface SealedSpans {
	since: EpochMs;
	spans: ContainerSpan[];
}

/** Refuses the run's later starts. Idempotent. */
export function sealRun(sql: Sql, runId: RunId, now: EpochMs): void {
	sql.exec("INSERT INTO sealed_runs (run_id, sealed_at) VALUES (?, ?) ON CONFLICT (run_id) DO NOTHING", runId, now);
}

export function isSealed(sql: Sql, runId: RunId): boolean {
	return first(sql, "SELECT 1 AS sealed FROM sealed_runs WHERE run_id = ?", runId) !== null;
}

export function readSpans(sql: Sql, runId: RunId): SealedSpans {
	const since = first<{ at: number }>(sql, "SELECT at FROM spans_since WHERE id = 1");
	if (!since) throw new Error("The Sandbox's spans are not kept: migration 2 is missing.");
	const rows = sql.exec<{ started_at: number; lease_until: number; ended_at: number | null; ended: string | null }>(
		"SELECT started_at, lease_until, ended_at, ended FROM container_spans WHERE run_id = ? ORDER BY started_at, incarnation",
		runId,
	);
	const spans = rows.map((row): ContainerSpan => {
		const base = { startedAt: row.started_at, leaseUntil: row.lease_until };
		// The table's CHECKs hold `ended_at` and `ended` both set or both null, and `ended` one of SpanEnd.
		return row.ended_at === null ? { ...base, endedAt: null, ended: null } : { ...base, endedAt: row.ended_at, ended: row.ended as SpanEnd };
	});
	return { since: since.at, spans };
}

/** A run's container time as `run.settled` reports it. */
export interface ContainerCharge {
	containers: number;
	containerMs: number;
	containerEstimated: boolean;
}

/**
 * Each span is charged from its start to the earlier of its end and its lease plus HARD_GRACE_MS, by which
 * the alarm has destroyed it; an open span counts to that cutoff. The cutoff is a charging rule, not proof the
 * container stopped, so the charge is estimated when a span is open, `gone` (its end is when the object
 * noticed), or ended past the cutoff, and when the run was created before the object kept spans (or at that
 * same millisecond).
 */
export function containerCharge(sealed: SealedSpans, runCreatedAt: EpochMs): ContainerCharge {
	let containerMs = 0;
	let containerEstimated = runCreatedAt <= sealed.since;
	for (const span of sealed.spans) {
		const cutoff = span.leaseUntil + HARD_GRACE_MS;
		const end = span.endedAt === null ? cutoff : Math.min(span.endedAt, cutoff);
		containerMs += Math.max(0, end - span.startedAt);
		if (span.ended !== "destroyed" || span.endedAt > cutoff) containerEstimated = true;
	}
	return { containers: sealed.spans.length, containerMs, containerEstimated };
}

/** Whether (runId, attempt) is older than the newest owner the object has seen: run ids are UUIDv7, in time order. */
export function olderThan(fence: { runId: RunId; attempt: number }, state: StateRow): boolean {
	if (state.runId === null || state.attempt === null) return false;
	if (fence.runId !== state.runId) return fence.runId < state.runId;
	return fence.attempt < state.attempt;
}
