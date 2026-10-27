// The write ledger, in the Conversation Durable Object's SQLite (ARCHITECTURE.md: Writes). A write is claimed by its key before anything is sent; one write is
// dispatched at a time per run, with its deadline fixed at dispatch; a write the provider refused is
// forgotten (deleted) so it can be tried again; an applied one is recorded and answers repeats; one whose
// outcome is unknown is uncertain, which pauses every later write in the run for good.
//
// The pause is not a column of its own: a run is paused exactly when it has an uncertain write, since
// uncertain rows are never deleted or changed (a late settle only touches `dispatched` rows). The
// Conversation mirrors it in its run's `writes_uncertain` (conversation/ports.ts `gatewayLedger`).
//
// It also keeps the run's holds (holds.ts), calls the policy asks before, held for the user's approval and claimed nothing
// here. While a run holds one, a write that does not ask is refused APPROVAL_PENDING, the pause's second reason, and the
// refusal closes the run's writes for good (`ClosedWrites`), so a later asking write is refused too rather than held: nothing
// runs out of the model's order. A paused run holds nothing. A continuation's write names the hold it carries out
// (`WriteNote.approved`), and its settlement stores the hold's outcome in the same transaction, whenever it comes.
//
// Every method is synchronous and each is atomic: run it in the same synchronous stretch as the run-state
// check it depends on (gateway/run-state.ts), with no await between.

import { MAX_HOLDS } from "@minerva/contract/internal";
import { utf8 } from "../lib/bytes.ts";
import { sha256Hex } from "../lib/hash.ts";
import { hashInput } from "../lib/canonical.ts";
import { parseJson } from "../lib/json.ts";
import type { Sql } from "../lib/sql.ts";
import { sliceText } from "../lib/text.ts";
import type { AttemptFence, EpochMs, RunId } from "../shared/rpc.ts";
import type { Clock } from "./clock.ts";
import { APPROVAL_MESSAGES, type HeldCall, type HeldRequirement, type Hold, type HoldDecision, type HoldOutcome, MAX_OUTCOME_RESULT } from "./holds.ts";
import type { Effect } from "./http.ts";
import type { ToolResult } from "./results.ts";

export type WriteStatus = "dispatched" | "succeeded" | "uncertain";

export interface WriteRecord {
	runId: RunId;
	/** SHA-256 of the canonical JSON of the tool and its normalized fields, page token included (`writeKey`). */
	key: string;
	status: WriteStatus;
	/** For `succeeded`: what answers a repeat. */
	result: ToolResult | null;
	/** The attempt that dispatched it; a later attempt still settles it. */
	attempt: number;
	dispatchedAt: EpochMs;
	/** min(dispatch + 60 s, run deadline). An alarm marks writes still dispatched 30 s past it uncertain. */
	deadlineAt: EpochMs;
	/** The keyed hash its `tool_call` event shows (`writeId`), stored at dispatch; null for a row written before it was. */
	write: string | null;
}

/**
 * What a write's settlement reports (a Laravel run's `run.write` fact): its tool, connection and keyed hash, fixed at dispatch,
 * and for a continuation's approved call, the hold it carries out.
 */
export interface WriteNote {
	tool: string;
	connection: string;
	write: string;
	approved?: { run: RunId; position: number };
}

/** A write that settled, with what its dispatch noted. */
export interface SettledWrite extends WriteNote {
	runId: RunId;
}

export type DispatchResult =
	/** Dispatched: send it, and settle it whatever happens. `deadline` is monotonic. */
	| { kind: "dispatched"; deadline: number }
	/** An identical write already succeeded: answer from its record, nothing is sent. */
	| { kind: "cached"; result: ToolResult }
	| { kind: "refused"; code: "RUN_ENDED" | "WRITE_UNCERTAIN" | "WRITE_IN_PROGRESS" | "APPROVAL_PENDING"; message: string };

export type HoldResult =
	| { kind: "held"; call: HeldCall }
	/** APPROVAL_PENDING when the run's writes are closed or it holds MAX_HOLDS calls, which closes them. */
	| { kind: "refused"; code: "RUN_ENDED" | "WRITE_UNCERTAIN" | "APPROVAL_PENDING"; message: string };

/** Where the ledger keeps whether a run's writes are closed (the Conversation's `runs.writes_closed`), read and set in its transactions. */
export interface ClosedWrites {
	closed(runId: RunId): boolean;
	close(runId: RunId): void;
}

export type Settlement =
	/**
	 * Forgotten: the row is deleted, so the same write may be tried again. `message`: what its call answers, which an approved
	 * call's hold keeps as its failure; absent for a write that was never sent.
	 */
	| { effect: Extract<Effect, "not_applied">; message?: string }
	/** `result` is APPLIED_WITHOUT_RESULT when the response was unusable. */
	| { effect: Extract<Effect, "applied">; result: ToolResult }
	/** Pauses every later write in the run. */
	| { effect: Extract<Effect, "unknown"> };

/** How long one write may take; the run's own deadline shortens it. */
export const WRITE_WINDOW_MS = 60_000;
/** A dispatched write that has not settled this long after its deadline is assumed lost. */
export const LOST_WRITE_GRACE_MS = 30_000;

export const RUN_ENDED_MESSAGE = "This run is no longer active.";
/**
 * A result larger than this (as UTF-8 JSON) is stored as applied_without_result, so a repeat still learns
 * that the write took effect: a Durable Object's SQLite holds at most 2 MB in a string or a row, and the
 * model reads at most 1 MiB of a result anyway.
 */
export const MAX_STORED_RESULT_BYTES = 1024 * 1024;
const APPLIED_WITHOUT_RESULT = JSON.stringify({ items: [], count: 0, outcome: "applied_without_result" });

/** The ledger's three distinct refusals. */
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

/** The run_writes and run_holds tables, steps of the Conversation Durable Object's migrations (conversation/schema.ts). */
export { HOLD_SCHEMA, LEDGER_NOTES_SCHEMA, LEDGER_SCHEMA } from "./schema.ts";

/**
 * A write's identity within its run: SHA-256 over `minerva:write-key:` and the canonical JSON
 * (lib/canonical.ts) of the tool name and the validated, normalized arguments with their defaults, the page
 * token included (risk 2). Deduplication is by key, so it also catches a model that
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
	tool: string;
	connection_id: string;
	write_id: string;
	approved_run: string;
	approved_position: number;
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
		write: row.write_id === "" ? null : row.write_id,
	};
}

function settledOf(row: Pick<WriteRow, "run_id" | "tool" | "connection_id" | "write_id" | "approved_run" | "approved_position">): SettledWrite {
	const settled: SettledWrite = { runId: row.run_id, tool: row.tool, connection: row.connection_id, write: row.write_id };
	if (row.approved_run !== "") settled.approved = { run: row.approved_run, position: row.approved_position };
	return settled;
}

const SETTLED = "RETURNING run_id, key, tool, connection_id, write_id, approved_run, approved_position";

/** An approved call's outcome as its write settled; null for a write never sent, which leaves the hold to its continuation. */
function settledOutcome(settlement: Settlement, stored: string): HoldOutcome | null {
	if (settlement.effect === "applied") return { kind: "ran", result: sliceText(stored, 0, MAX_OUTCOME_RESULT) };
	if (settlement.effect === "unknown") return { kind: "unknown" };
	return settlement.message === undefined ? null : { kind: "failed", message: settlement.message };
}

export interface HoldRow {
	[column: string]: string | number | null;
	run_id: string;
	position: number;
	key: string;
	write_id: string;
	user_id: string;
	tool: string;
	label: string;
	connection_id: string;
	provider: string;
	operation: string;
	contract: string;
	arguments: string;
	requirements: string;
	state: string;
	created_at: number;
	decided_by: string | null;
	approve: number | null;
	outcome: string | null;
}

function decisionOf(row: HoldRow): HoldDecision {
	if (row.state === "open" || row.decided_by === null) return { state: "open" };
	if (row.state === "closed") return { state: "closed", by: row.decided_by };
	if (row.approve !== 1) return { state: "used", by: row.decided_by, approve: false };
	return { state: "used", by: row.decided_by, approve: true, outcome: row.outcome === null ? null : (parseJson(row.outcome) as unknown as HoldOutcome) };
}

/** A `run_holds` row as the call it holds and how it was decided (`SELECT *`). */
export function heldCall(row: HoldRow): HeldCall {
	return {
		runId: row.run_id,
		position: row.position,
		key: row.key,
		write: row.write_id,
		userId: row.user_id,
		tool: row.tool,
		label: row.label,
		connection: row.connection_id,
		provider: row.provider,
		operation: row.operation,
		contract: row.contract,
		arguments: row.arguments,
		requirements: parseJson(row.requirements) as unknown as HeldRequirement[],
		decision: decisionOf(row),
		createdAt: row.created_at,
	};
}

/** How a known write answers the same write again: its result, or one of the two refusals. */
export function knownAnswer(known: WriteRecord): Extract<DispatchResult, { kind: "cached" | "refused" }> {
	if (known.status === "succeeded") return { kind: "cached", result: known.result as ToolResult };
	if (known.status === "uncertain") return { kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.identicalUncertain };
	return { kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.identicalInProgress };
}

/** A write the sweep or the restart gate made uncertain. */
export interface LostWrite extends SettledWrite {
	key: string;
}

export class WriteLedger {
	readonly #sql: Sql;
	readonly #clock: Clock;
	readonly #closed: ClosedWrites;

	constructor(sql: Sql, clock: Clock, closed: ClosedWrites) {
		this.#sql = sql;
		this.#clock = clock;
		this.#closed = closed;
	}

	known(runId: RunId, key: string): WriteRecord | null {
		const [row] = this.#sql.exec<WriteRow>("SELECT * FROM run_writes WHERE run_id = ? AND key = ?", runId, key);
		return row === undefined ? null : record(row);
	}

	/** The write a continuation made for an approved hold, if it made one: the hold's outcome while none is stored. */
	approvedWrite(runId: RunId, heldRun: RunId, position: number): WriteRecord | null {
		const [row] = this.#sql.exec<WriteRow>("SELECT * FROM run_writes WHERE run_id = ? AND approved_run = ? AND approved_position = ?", runId, heldRun, position);
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

	/** The run's hold of this write, if it holds one. */
	held(runId: RunId, key: string): HeldCall | null {
		const [row] = this.#sql.exec<HoldRow>("SELECT * FROM run_holds WHERE run_id = ? AND key = ?", runId, key);
		return row === undefined ? null : heldCall(row);
	}

	/** The run's holds, in the order it held them. */
	holds(runId: RunId): HeldCall[] {
		return this.#sql.exec<HoldRow>("SELECT * FROM run_holds WHERE run_id = ? ORDER BY position", runId).map(heldCall);
	}

	/** Every open hold of the conversation, of whichever run, in the order they were held. */
	openHolds(): HeldCall[] {
		return this.#sql.exec<HoldRow>("SELECT * FROM run_holds WHERE state = 'open' ORDER BY created_at, run_id, position").map(heldCall);
	}

	/** A continuation's start uses the held run's holds, each with its decision, in its caller's transaction. */
	use(by: RunId, heldRun: RunId, decisions: readonly { position: number; approve: boolean }[]): void {
		for (const { position, approve } of decisions) {
			this.#sql.exec("UPDATE run_holds SET state = 'used', decided_by = ?, approve = ? WHERE run_id = ? AND position = ? AND state = 'open'", by, approve ? 1 : 0, heldRun, position);
		}
	}

	/** A start without an approval closes these holds once its prompt is committed, those still open, in its caller's transaction. */
	close(by: RunId, holds: readonly { run: RunId; position: number }[]): void {
		for (const { run, position } of holds) {
			this.#sql.exec("UPDATE run_holds SET state = 'closed', decided_by = ? WHERE run_id = ? AND position = ? AND state = 'open'", by, run, position);
		}
	}

	/** Whether a write was refused APPROVAL_PENDING in the run, which refuses every later one. */
	closed(runId: RunId): boolean {
		return this.#closed.closed(runId);
	}

	/** Whether the run holds a call, which refuses every later write that does not ask. */
	holding(runId: RunId): boolean {
		return this.#sql.exec("SELECT 1 AS holding FROM run_holds WHERE run_id = ? LIMIT 1", runId).length > 0;
	}

	/** Refuses the write APPROVAL_PENDING and closes the run's writes, in the caller's transaction. */
	#pending(runId: RunId): { kind: "refused"; code: "APPROVAL_PENDING"; message: string } {
		this.#closed.close(runId);
		return { kind: "refused", code: "APPROVAL_PENDING", message: APPROVAL_MESSAGES.pending };
	}

	/**
	 * Holds a call the policy asks before, at the next position, claiming nothing. The caller has checked, in the same
	 * synchronous stretch, that the fence is current, and that the run holds nothing under this key. A paused run holds
	 * nothing; a run whose writes are closed, or that holds MAX_HOLDS calls, is refused APPROVAL_PENDING.
	 */
	hold(runId: RunId, hold: Hold): HoldResult {
		return this.#sql.transaction((): HoldResult => {
			if (this.paused(runId)) return { kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused };
			const held = this.#sql.exec<{ count: number }>("SELECT count(*) AS count FROM run_holds WHERE run_id = ?", runId)[0]?.count ?? 0;
			if (this.#closed.closed(runId) || held >= MAX_HOLDS) return this.#pending(runId);
			const call: HeldCall = { ...hold, runId, position: held + 1, decision: { state: "open" }, createdAt: this.#clock.now() };
			this.#sql.exec(
				"INSERT INTO run_holds (run_id, position, key, write_id, user_id, tool, label, connection_id, provider, operation, contract, arguments, requirements, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				runId,
				call.position,
				call.key,
				call.write,
				call.userId,
				call.tool,
				call.label,
				call.connection,
				call.provider,
				call.operation,
				call.contract,
				call.arguments,
				JSON.stringify(call.requirements),
				call.decision.state,
				call.createdAt,
			);
			return { kind: "held", call };
		});
	}

	/**
	 * Claims a write before anything is sent. The caller has checked, in the same
	 * synchronous stretch, that the fence is the run's current attempt (else RUN_ENDED). The same key
	 * answers from its record; a paused run, one whose writes are closed or that holds a call, and one with another
	 * write dispatched are refused; otherwise the write is dispatched with `deadline_at = min(now + 60 s, run deadline)`,
	 * returned as a monotonic instant so that every later wait counts against it. `note` is kept for the settlement's report.
	 */
	dispatch(fence: AttemptFence, key: string, runDeadline: EpochMs | null, note: WriteNote | null = null): DispatchResult {
		return this.#sql.transaction((): DispatchResult => {
			const now = this.#clock.now();
			const clock = this.#clock.monotonic();
			const known = this.known(fence.runId, key);
			if (known !== null) return knownAnswer(known);
			if (this.paused(fence.runId)) return { kind: "refused", code: "WRITE_UNCERTAIN", message: WRITE_MESSAGES.paused };
			if (this.#closed.closed(fence.runId) || this.holding(fence.runId)) return this.#pending(fence.runId);
			const inFlight = this.#sql.exec("SELECT 1 AS busy FROM run_writes WHERE run_id = ? AND status = 'dispatched' LIMIT 1", fence.runId);
			if (inFlight.length > 0) return { kind: "refused", code: "WRITE_IN_PROGRESS", message: WRITE_MESSAGES.otherInProgress };
			const deadlineAt = runDeadline === null ? now + WRITE_WINDOW_MS : Math.min(now + WRITE_WINDOW_MS, runDeadline);
			this.#sql.exec(
				"INSERT INTO run_writes (run_id, key, status, result, attempt, dispatched_at, deadline_at, tool, connection_id, write_id, approved_run, approved_position) VALUES (?, ?, 'dispatched', NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
				fence.runId,
				key,
				fence.attempt,
				now,
				deadlineAt,
				note?.tool ?? "",
				note?.connection ?? "",
				note?.write ?? "",
				note?.approved?.run ?? "",
				note?.approved?.position ?? 0,
			);
			return { kind: "dispatched", deadline: clock + (deadlineAt - now) };
		});
	}

	/**
	 * Records how a dispatched write ended, whichever attempt dispatched it: not
	 * applied deletes the row, so the same write may be tried again; applied stores the result that answers
	 * repeats; unknown makes it uncertain, which pauses the run. Only a row still `dispatched` changes, so a
	 * write the sweep or the restart gate already judged uncertain stays uncertain. Returns the write that was
	 * settled, or null when none was dispatched. A continuation's write stores its hold's outcome too.
	 */
	settle(runId: RunId, key: string, settlement: Settlement): SettledWrite | null {
		const where = `WHERE run_id = ? AND key = ? AND status = 'dispatched' ${SETTLED}`;
		let rows: WriteRow[];
		let stored = "";
		if (settlement.effect === "not_applied") rows = this.#sql.exec<WriteRow>(`DELETE FROM run_writes ${where}`, runId, key);
		else if (settlement.effect === "applied") {
			const text = JSON.stringify(settlement.result);
			stored = utf8(text).byteLength > MAX_STORED_RESULT_BYTES ? APPLIED_WITHOUT_RESULT : text;
			rows = this.#sql.exec<WriteRow>(`UPDATE run_writes SET status = 'succeeded', result = ? ${where}`, stored, runId, key);
		} else rows = this.#sql.exec<WriteRow>(`UPDATE run_writes SET status = 'uncertain' ${where}`, runId, key);
		const [row] = rows;
		if (row === undefined) return null;
		const settled = settledOf(row);
		const outcome = settledOutcome(settlement, stored);
		if (settled.approved && outcome !== null) this.answer(settled.approved.run, settled.approved.position, outcome);
		return settled;
	}

	/**
	 * Stores an approved hold's outcome unless it has one: the first to know it, its write's settlement or its continuation's
	 * carry-out, decides. Nothing changes for a hold that is not approved, or no longer held.
	 */
	answer(heldRun: RunId, position: number, outcome: HoldOutcome): void {
		this.#sql.exec(
			"UPDATE run_holds SET outcome = ? WHERE run_id = ? AND position = ? AND state = 'used' AND approve = 1 AND outcome IS NULL",
			JSON.stringify(outcome),
			heldRun,
			position,
		);
	}

	/** Writes made uncertain by the sweep or the gate: their holds' outcomes are unknown. */
	#lost(rows: WriteRow[]): LostWrite[] {
		return rows.map((row) => {
			const lost: LostWrite = { ...settledOf(row), key: row.key };
			if (lost.approved) this.answer(lost.approved.run, lost.approved.position, { kind: "unknown" });
			return lost;
		});
	}

	/**
	 * Marks writes still dispatched 30 s past their deadline uncertain, pausing their runs: their
	 * settle was lost. The Conversation Durable Object runs it from an alarm at
	 * `nextSweepAt()` and when it starts.
	 */
	sweep(now: EpochMs = this.#clock.now()): LostWrite[] {
		return this.#lost(this.#sql.exec<WriteRow>(`UPDATE run_writes SET status = 'uncertain' WHERE status = 'dispatched' AND deadline_at < ? ${SETTLED}`, now - LOST_WRITE_GRACE_MS));
	}

	/** When the sweep next has something to do: the earliest dispatched write's deadline plus the grace, or null. */
	nextSweepAt(): EpochMs | null {
		const [row] = this.#sql.exec<{ deadline_at: number | null }>("SELECT MIN(deadline_at) AS deadline_at FROM run_writes WHERE status = 'dispatched'");
		return row?.deadline_at === null || row?.deadline_at === undefined ? null : row.deadline_at + LOST_WRITE_GRACE_MS;
	}

	/**
	 * For the restart gate, in the transaction of its decision (ARCHITECTURE.md: Attempts and recovery, Writes): every
	 * write of the run still dispatched becomes uncertain, since the instance that dispatched it died and can
	 * never settle it.
	 */
	markDispatchedUncertain(runId: RunId): LostWrite[] {
		return this.#lost(this.#sql.exec<WriteRow>(`UPDATE run_writes SET status = 'uncertain' WHERE run_id = ? AND status = 'dispatched' ${SETTLED}`, runId));
	}

	/** Drops a run's writes and holds, for retention once the run has ended. */
	forget(runId: RunId): void {
		this.#sql.exec("DELETE FROM run_writes WHERE run_id = ?", runId);
		this.#sql.exec("DELETE FROM run_holds WHERE run_id = ?", runId);
	}
}
