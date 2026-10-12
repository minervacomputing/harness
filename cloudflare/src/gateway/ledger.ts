// The write ledger: today's RunWrite protocol (backend/connectors/executor.py `_dispatch`, `_settle`,
// backend/runs/services.py `sweep_lost_writes`; runs 5.6, connectors 7.5), in the Conversation Durable
// Object's SQLite (plan: Writes). A write is claimed by its key before anything is sent; one write is
// dispatched at a time per run, with its deadline fixed at dispatch; a write the provider refused is
// forgotten (deleted) so it can be tried again; an applied one is recorded and answers repeats; one whose
// outcome is unknown is uncertain, which pauses every later write in the run for good.
//
// The pause is not a column of its own: a run is paused exactly when it has an uncertain write, since
// uncertain rows are never deleted or changed (a late settle only touches `dispatched` rows). Today's
// `Run.writes_uncertain` is set at the same moments, so the two cannot differ. `RunRecord.writesUncertain`
// reads `paused()`.
//
// Every method is synchronous and each is atomic: run it in the same synchronous stretch as the run-state
// check it depends on (gateway/run-state.ts), with no await between.

import type { AttemptFence, EpochMs, RunId } from "../contracts/common.ts";
import type { DispatchResult, Settlement, ToolResult, WriteRecord, WriteStatus } from "../contracts/executor.ts";
import { utf8 } from "../lib/bytes.ts";
import { sha256Hex } from "../lib/hash.ts";
import { hashInput } from "../lib/canonical.ts";
import { parseJson } from "../lib/json.ts";
import type { Sql } from "../lib/sql.ts";
import type { Clock } from "./clock.ts";

/** How long one write may take; the run's own deadline shortens it (executor.py WRITE_WINDOW). */
export const WRITE_WINDOW_MS = 60_000;
/** A dispatched write that has not settled this long after its deadline is assumed lost (services.py LOST_WRITE_GRACE). */
export const LOST_WRITE_GRACE_MS = 30_000;

export const RUN_ENDED_MESSAGE = "This run is no longer active.";
/**
 * A result larger than this (as UTF-8 JSON) is stored as applied_without_result, so a repeat still learns
 * that the write took effect: a Durable Object's SQLite holds at most 2 MB in a string or a row, and the
 * model reads at most 1 MiB of a result anyway.
 */
export const MAX_STORED_RESULT_BYTES = 1024 * 1024;
const APPLIED_WITHOUT_RESULT = JSON.stringify({ items: [], count: 0, outcome: "applied_without_result" });

/** The ledger's refusals, with today's words (runs 5.6; connectors risk 1: three distinct refusals). */
export const WRITE_MESSAGES = {
	/** The same write is already known and its outcome is unknown. */
	identicalUncertain: "This write has an unknown outcome. Check the provider before retrying.",
	/** The same write is dispatched and has not settled. */
	identicalInProgress: "An identical write is already in progress.",
	/** Any other write while the run is paused. */
	paused: "A previous write has an unknown outcome. Further writes in this run are paused.",
	/** Any other write while one is dispatched. */
	otherInProgress: "Another write in this run is still in progress.",
	/** What the call that made the write uncertain answers. */
	unknown: "The write outcome is unknown. Check the provider; further writes in this run are paused.",
} as const;

/** The run_writes table, a step of the Conversation Durable Object's migrations (conversation/schema.ts). */
export { LEDGER_SCHEMA } from "./schema.ts";

/**
 * A write's identity within its run: SHA-256 over `minerva:write-key:` and the canonical JSON
 * (lib/canonical.ts) of the tool name and the validated, normalized arguments with their defaults, the page
 * token included (connectors 7.1 step 6, risk 2). Deduplication is by key, so it also catches a model that
 * retries a write under a new call id.
 */
export async function writeKey(tool: string, fields: { [key: string]: unknown }): Promise<string> {
	return sha256Hex(hashInput("write-key", { tool, arguments: fields }));
}

interface WriteRow {
	[column: string]: string | number | null;
	run_id: string;
	key: string;
	status: string;
	result: string | null;
	attempt: number;
	dispatched_at: number;
	deadline_at: number;
}

function record(row: WriteRow): WriteRecord {
	return {
		runId: row.run_id,
		key: row.key,
		status: row.status as WriteStatus,
		result: row.result === null ? null : (parseJson(row.result) as unknown as ToolResult),
		attempt: row.attempt,
		dispatchedAt: row.dispatched_at,
		deadlineAt: row.deadline_at,
	};
}

/** How a known write answers the same write again: its result, or one of the two refusals (executor.py `_known_write`). */
export function knownAnswer(known: WriteRecord): Extract<DispatchResult, { kind: "cached" | "refused" }> {
	if (known.status === "succeeded") return { kind: "cached", result: known.result as ToolResult };
	if (known.status === "uncertain") return { kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain };
	return { kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.identicalInProgress };
}

/** A write the sweep or the restart gate made uncertain. */
export interface LostWrite {
	runId: RunId;
	key: string;
}

export class WriteLedger {
	readonly #sql: Sql;
	readonly #clock: Clock;

	constructor(sql: Sql, clock: Clock) {
		this.#sql = sql;
		this.#clock = clock;
	}

	known(runId: RunId, key: string): WriteRecord | null {
		const [row] = this.#sql.exec<WriteRow>("SELECT * FROM run_writes WHERE run_id = ? AND key = ?", runId, key);
		return row === undefined ? null : record(row);
	}

	/** Every write of the run, in no particular order (tests and diagnostics). */
	writes(runId: RunId): WriteRecord[] {
		return this.#sql.exec<WriteRow>("SELECT * FROM run_writes WHERE run_id = ? ORDER BY dispatched_at, key", runId).map(record);
	}

	/** Whether a write of the run has an unknown outcome, which refuses every later write (`writes_uncertain`). */
	paused(runId: RunId): boolean {
		return this.#sql.exec("SELECT 1 AS paused FROM run_writes WHERE run_id = ? AND status = 'uncertain' LIMIT 1", runId).length > 0;
	}

	/**
	 * Claims a write before anything is sent (executor.py `_dispatch`). The caller has checked, in the same
	 * synchronous stretch, that the fence is the run's current attempt (else RUN_ENDED). The same key
	 * answers from its record; a paused run, or one with another write dispatched, is refused; otherwise
	 * the write is dispatched with `deadline_at = min(now + 60 s, run deadline)`, returned as a monotonic
	 * instant so that every later wait counts against it.
	 */
	dispatch(fence: AttemptFence, key: string, runDeadline: EpochMs | null): DispatchResult {
		return this.#sql.transaction((): DispatchResult => {
			const now = this.#clock.now();
			const clock = this.#clock.monotonic();
			const known = this.known(fence.runId, key);
			if (known !== null) return knownAnswer(known);
			if (this.paused(fence.runId)) return { kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused };
			const inFlight = this.#sql.exec("SELECT 1 AS busy FROM run_writes WHERE run_id = ? AND status = 'dispatched' LIMIT 1", fence.runId);
			if (inFlight.length > 0) return { kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress };
			const deadlineAt = runDeadline === null ? now + WRITE_WINDOW_MS : Math.min(now + WRITE_WINDOW_MS, runDeadline);
			this.#sql.exec(
				"INSERT INTO run_writes (run_id, key, status, result, attempt, dispatched_at, deadline_at) VALUES (?, ?, 'dispatched', NULL, ?, ?, ?)",
				fence.runId,
				key,
				fence.attempt,
				now,
				deadlineAt,
			);
			return { kind: "dispatched", deadline: clock + (deadlineAt - now) };
		});
	}

	/**
	 * Records how a dispatched write ended (executor.py `_settle`), whichever attempt dispatched it: not
	 * applied deletes the row, so the same write may be tried again; applied stores the result that answers
	 * repeats; unknown makes it uncertain, which pauses the run. Only a row still `dispatched` changes, so a
	 * write the sweep or the restart gate already judged uncertain stays uncertain. Returns whether a
	 * dispatched write was settled.
	 */
	settle(runId: RunId, key: string, settlement: Settlement): boolean {
		const where = "WHERE run_id = ? AND key = ? AND status = 'dispatched' RETURNING key";
		if (settlement.effect === "not_applied") return this.#sql.exec(`DELETE FROM run_writes ${where}`, runId, key).length > 0;
		if (settlement.effect === "applied") {
			const text = JSON.stringify(settlement.result);
			const stored = utf8(text).byteLength > MAX_STORED_RESULT_BYTES ? APPLIED_WITHOUT_RESULT : text;
			return this.#sql.exec(`UPDATE run_writes SET status = 'succeeded', result = ? ${where}`, stored, runId, key).length > 0;
		}
		return this.#sql.exec(`UPDATE run_writes SET status = 'uncertain' ${where}`, runId, key).length > 0;
	}

	/**
	 * Marks writes still dispatched 30 s past their deadline uncertain, pausing their runs (services.py
	 * `sweep_lost_writes`): their settle was lost. The Conversation Durable Object runs it from an alarm at
	 * `nextSweepAt()` and when it starts.
	 */
	sweep(now: EpochMs = this.#clock.now()): LostWrite[] {
		return this.#sql
			.exec<{ run_id: string; key: string }>(
				"UPDATE run_writes SET status = 'uncertain' WHERE status = 'dispatched' AND deadline_at < ? RETURNING run_id, key",
				now - LOST_WRITE_GRACE_MS,
			)
			.map((row) => ({ runId: row.run_id, key: row.key }));
	}

	/** When the sweep next has something to do: the earliest dispatched write's deadline plus the grace, or null. */
	nextSweepAt(): EpochMs | null {
		const [row] = this.#sql.exec<{ deadline_at: number | null }>("SELECT MIN(deadline_at) AS deadline_at FROM run_writes WHERE status = 'dispatched'");
		return row?.deadline_at === null || row?.deadline_at === undefined ? null : row.deadline_at + LOST_WRITE_GRACE_MS;
	}

	/**
	 * For the restart gate, in the transaction of its decision (plan: Attempts and recovery, Writes): every
	 * write of the run still dispatched becomes uncertain, since the instance that dispatched it died and can
	 * never settle it. Today a restart waits while a write is dispatched; here nothing could settle it.
	 */
	markDispatchedUncertain(runId: RunId): LostWrite[] {
		return this.#sql
			.exec<{ run_id: string; key: string }>("UPDATE run_writes SET status = 'uncertain' WHERE run_id = ? AND status = 'dispatched' RETURNING run_id, key", runId)
			.map((row) => ({ runId: row.run_id, key: row.key }));
	}

	/** Drops a run's writes, for retention once the run has ended (plan: open question 5). */
	forget(runId: RunId): void {
		this.#sql.exec("DELETE FROM run_writes WHERE run_id = ?", runId);
	}
}
