// The Conversation Durable Object's records: the conversation, its runs, attempts, run events and facts, and
// Laravel's starts and tombstones, over the object's SQLite. Every method is synchronous:
// the checks the executor and the model wrapper make (`isCurrent`, `isActive`) and the appends they ask for
// read and write SQLite with no await in between, which is what makes the revocation, dispatch and fencing
// checks atomic (ARCHITECTURE.md: Strict revocation, Attempts and recovery).
//
// `write` runs a change in one transaction; the events it appended and the runs it ended are handed to the
// listeners only after it commits, so a stream never sees an event that was rolled back.
//
// pi commits with the storage's asynchronous `transaction()` on the same connection, and a statement of ours
// that runs while one is open joins it and rolls back with it (`watchTransactions`). A change that someone
// acts on once it is made must therefore never run inside one: a write's claim or settlement, a model call's
// record or settlement, a script's record and its end, a revocation, a cancel, a start, a run's end, the attempt
// gate's decision, a call's `tool_call` event, the replay cap's count. Those go through `outside`, which waits until no
// such transaction is open and then makes the change with no await between that check and the change, so it commits on
// its own. What only shows progress (text and reasoning deltas, phases) may still run inside pi's transaction; rolled
// back with it, it was never announced either.

import type { StartSnapshot } from "../gateway/tools.ts";
import type { Preparation } from "../internal/start.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { VALUE_PART, sliceText, splitParts } from "../lib/text.ts";
import { isoTime } from "../lib/dates.ts";
import type { Attachment, FolderChanges, FolderWarnings, Run, ToolCallEventData } from "@minerva/contract";
import type { Fact, StartRunResult } from "@minerva/contract/internal";
import { type Prices, type TokenRates, callCharge, callPrice, containerTimeCharge, scriptCharge } from "../budget/prices.ts";
import type { SettledWrite } from "../gateway/ledger.ts";
import type { CallRequest, CallSettlement } from "../model/provider.ts";
import type { Tokens } from "../model/tap.ts";
import type { ContainerCharge } from "../sandbox/store.ts";
import type { ScriptFence } from "../scripts/scripts.ts";
import { tokenHex } from "../lib/random.ts";
import { utf8 } from "../lib/bytes.ts";
import { FACT_PAGE_BYTES, type NewFact, callFact, toolCallFact } from "./facts.ts";
import type { AttemptFence, ConversationId, EpochMs, RunId, RunStatus, VersionId, WorkspaceRef } from "../shared/rpc.ts";
import {
	ACTIVE,
	BUDGET_REACHED,
	type CancelReason,
	ERROR_MESSAGE_CHARS,
	type NewRunEvent,
	type RunEnd,
	type RunEvent,
	type RunEventType,
	statusEvent,
	terminalStatus,
} from "./events.ts";
import type { Replayed } from "./history.ts";
import { deletePiSession, orphanPiSession, type PiStep } from "./pi-tables.ts";

/** A page of a run's events: seq above `after` and at most `upTo`, at most `limit` of them. */
export interface EventPage {
	after: number;
	upTo: number;
	/** At most 1,000; a page also stops at 4 MiB of JSON. */
	limit: number;
}

/** The snapshot the Conversation Durable Object stores with the run: the start snapshot plus its folder. */
export interface RunSnapshot extends StartSnapshot {
	runId: RunId;
	/** The version the run starts from: the conversation's folder, or a new `base` with the attachments. */
	baseVersionId: VersionId | null;
	/** As added to the folder: final, possibly numbered names at the root, in upload order. */
	attachments: Attachment[];
	limits: { folderBytes: number; folderEntries: number; runUploadBytes: number };
	/**
	 * The run's turn as its start sent it (docs/plans/start-and-cancel.md): the history its pi session is seeded with,
	 * selected and clipped, and its prompt.
	 */
	turn: { history: Replayed[]; prompt: string };
}

/**
 * A run as the test build's view returns it (src/faults/ `faultView`): the contract's `Run` without its events, which have
 * no size bound, so a reader pages through them up to `eventSeq`. `eventSeq` is read with the status in one synchronous step,
 * and events are append-only, so the pages it joins are consistent.
 */
export type RunHead = Omit<Run, "events"> & { eventSeq: number };

/** A page of events stops at this much JSON, whatever its limit (`EventPage`). */
export const PAGE_BYTES = 4 * 1024 * 1024;
export const PAGE_LIMIT = 1000;

/** A deleted conversation's purge, as `RunStore.deletion` reads it. */
export interface Deletion {
	deletedAt: EpochMs;
	unacknowledged: number;
	purgeable: boolean;
}

export interface ConversationRow {
	id: string;
	workspace_id: string;
	jurisdiction: string | null;
	user_id: string;
	agent_id: string;
	title: string;
	folder_version_id: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	/** The organization of a conversation Laravel's commands made; null for the Workspace's. */
	organization_id: string | null;
	[key: string]: SqlStorageValue;
}

/** What binds a Laravel conversation: the scope of the first command that named it, and where its objects live. */
export interface ConversationBinding {
	conversationId: ConversationId;
	organization: string;
	workspace: WorkspaceRef;
	createdAt: EpochMs;
}

export interface RunRow {
	id: string;
	status: RunStatus;
	attempt: number;
	attempt_started_at: number;
	error_code: string;
	error_message: string;
	deadline: number | null;
	revoked: number;
	activated: number;
	released: number;
	writes_uncertain: number;
	session: string | null;
	provider_session: string | null;
	base_version_id: string | null;
	checkpoint_version_id: string | null;
	result_version_id: string | null;
	folder_changes: string | null;
	folder_warnings: string | null;
	uploaded_bytes: number;
	model_calls: number;
	tool_calls: number;
	input_tokens: number;
	output_tokens: number;
	unmetered_model_calls: number;
	event_seq: number;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	/** 1 for a run this version started: it owes a `run.settled` once it ended. */
	metered: number;
	settled_at: number | null;
	/** µ$ Laravel allows the run; null when it sent none. */
	allowance: number | null;
	/** µ$ its settled calls and ended scripts were charged. */
	spent: number;
	/** When it may first have had a container; null before. */
	container_since: number | null;
	/** Its retention state (`RunPrune`); null while its records are kept. */
	prune: RunPrune | null;
	/** When its prune started. */
	pruned_at: number | null;
	[key: string]: SqlStorageValue;
}

/**
 * How far a run's prune went (docs/plans/chunk-15a-design.md, A run's retention state): its own records are being deleted,
 * its snapshot already emptied; only its pi session's rows are left; nothing is left but its row.
 */
export type RunPrune = "records" | "pi" | "done";

/** A run whose prune is due, as retention reads it. */
export type PrunableRun = Pick<RunRow, "id" | "session" | "prune">;

/**
 * A run's own records: every table keyed or indexed by `run_id`, in the order a prune deletes them, each with the column
 * whose order its rows go in. `run_writes` and `page_tokens` are the write ledger's and the page tokens' (gateway/).
 */
const RUN_RECORDS = [
	["run_events", "seq"],
	["run_snapshots", "part"],
	["attempts", "attempt"],
	["tool_executions", "call_id"],
	["tool_arguments", "call_id"],
	["call_records", "call"],
	["script_records", "script_id"],
	["run_writes", "key"],
	["page_tokens", "token"],
] as const;

/**
 * Where a run's `run.settled` stands: owed by none (settled already, started by an older version, or not ended); waiting
 * for a call or script record of the run still open, which the instance that made it settles; or due, once its
 * container time is known.
 */
export type RunSettlement = { state: "none" } | { state: "open" } | { state: "due"; createdAt: EpochMs };

export interface TombstoneRow {
	run_id: string;
	reason: CancelReason;
	entry_id: number;
	created_at: number;
	[key: string]: SqlStorageValue;
}

/** A counted model call (migration 9): open until `outcome` is set, once. */
interface CallRecordRow {
	run_id: string;
	call: string;
	attempt: number;
	instance: string;
	provider: string;
	model: string;
	reserved_input: number;
	reserved_output: number;
	request_bytes: number | null;
	created_at: number;
	outcome: CallSettlement["outcome"] | null;
	cause: Extract<CallSettlement, { outcome: "unmetered" }>["cause"] | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cached_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	settled_at: number | null;
	/** The rates (`TokenRates` as JSON) and the price table's version it was admitted at; null when its route had no price. */
	rates: string | null;
	prices: string | null;
	/** Its charge in µ$ once settled, at `rates`; null while open or unpriced. */
	cost_micros: number | null;
	[key: string]: SqlStorageValue;
}

/** The tokens a settled call is counted at: as reported, none when refused, its reservation when unmetered. */
function settledTokens(record: Pick<CallRecordRow, "reserved_input" | "reserved_output">, settlement: CallSettlement): Tokens {
	switch (settlement.outcome) {
		case "reported":
			return settlement.tokens;
		case "refused":
			return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
		case "unmetered":
			return { input: record.reserved_input, output: record.reserved_output, cached: 0, cacheWrite: 0, reasoning: 0 };
	}
}

/** A run's totals, as its `run.settled` fact carries them. */
type Settled = Extract<Fact, { type: "run.settled" }>["data"];

/** Which check an append passes first: none (the object's own events), the run being active, or the attempt being current. */
export type AppendFence = AttemptFence | "active" | null;

export interface StoreListeners {
	/** After commit, for each event appended, in order. */
	appended(runId: RunId, event: RunEvent): void;
	/** After commit, for each run that reached a terminal state. */
	ended(runId: RunId): void;
	/**
	 * Inside the transaction that wrote a fact, so what it schedules commits with it: the delivery is due at `at` (now, or
	 * later while it backs off).
	 */
	factWritten(at: EpochMs): void;
	/** Inside `finish`'s transaction, for a metered run: its settlement (`settleRun`) is scheduled with its end. */
	settling(runId: RunId): void;
}

/** The delivery of a Laravel conversation's facts (docs/plans/credentials-and-facts.md, Delivered in order). */
export interface DeliveryRow {
	/** The last sequence written. */
	written: number;
	/** The highest Laravel holds, as it last said. */
	acknowledged: number;
	/** The highest raised in the recovery index. */
	indexed: number;
	/** Deliveries failed in a row, for the backoff. */
	failures: number;
	/** No delivery before this. */
	next_at: number;
	/** Why delivery waits for the operator, or null. */
	stopped: string | null;
	/** The lowest sequence still held: every fact below it is deleted, every one from it to `written` held. Never falls. */
	floor: number;
	[key: string]: SqlStorageValue;
}

/** A page of facts as stored: each one's JSON, as delivered. */
export interface FactPage {
	facts: { seq: number; json: string }[];
	/** Whether facts follow the page. */
	more: boolean;
}

/** How a write settled, as its fact says (conversation/ports.ts `WriteOutcome`). */
type WriteOutcome = "done" | "failed" | "uncertain";

export interface FinishOptions {
	/** Only if this attempt is still the run's. */
	attempt?: number;
	/** Only if the run is in this state. */
	fromStatus?: RunStatus;
	/** How the attempt ended, for its record. */
	attemptEnded?: "completed" | "restarted" | "failed" | "cancelled";
	/** A completed run's answer, for its `run.finished` fact. */
	answer?: { id: string; content: string };
}

/** What the folder's publishing returns: the run's result version, what changed, and what the conversation keeps. */
export interface Published {
	resultVersionId: VersionId | null;
	changes: { [key: string]: unknown } | null;
	storedBytes?: number;
}

/** What `finish` asks the folder, inside its transaction. */
export type Publish = (run: RunRow) => Published;

const ACTIVE_SQL = "('queued', 'provisioning', 'running')";
const ACTING_SQL = "('provisioning', 'running')";
/** Every column of a run but its snapshot, which only `snapshot()` reads (a unit test checks it against the table). */
export const RUN_COLUMNS = [
	"id",
	"status",
	"attempt",
	"attempt_started_at",
	"error_code",
	"error_message",
	"deadline",
	"revoked",
	"activated",
	"released",
	"writes_uncertain",
	"session",
	"provider_session",
	"base_version_id",
	"checkpoint_version_id",
	"result_version_id",
	"folder_changes",
	"folder_warnings",
	"uploaded_bytes",
	"model_calls",
	"tool_calls",
	"input_tokens",
	"output_tokens",
	"unmetered_model_calls",
	"event_seq",
	"created_at",
	"started_at",
	"finished_at",
	"metered",
	"settled_at",
	"allowance",
	"spent",
	"container_since",
	"prune",
	"pruned_at",
].join(", ");

export class RunStore {
	readonly #storage: DurableObjectStorage;
	readonly #sql: SqlStorage;
	#listeners: StoreListeners | null = null;
	#publish: Publish | null = null;
	#depth = 0;
	#appended: [RunId, RunEvent][] = [];
	#ended: RunId[] = [];
	/** Asynchronous transactions open on this connection (pi's), and what waits for them to commit. */
	#outer = 0;
	#parked: { appended: [RunId, RunEvent][]; ended: RunId[] } = { appended: [], ended: [] };
	/** Resolved, and cleared, when the last asynchronous transaction settles (`outside`). */
	#drained: PromiseWithResolvers<void> | null = null;
	readonly now: () => EpochMs;
	/** This object instance: the calls it records are its own to settle (`settleLost`), and its stream's sockets are tagged with it. */
	readonly instance = crypto.randomUUID();

	constructor(storage: DurableObjectStorage, now: () => EpochMs = Date.now) {
		this.#storage = storage;
		this.#sql = storage.sql;
		this.now = now;
	}

	listen(listeners: StoreListeners, publish: Publish): void {
		this.#listeners = listeners;
		this.#publish = publish;
	}

	/**
	 * pi commits with the storage's asynchronous `transaction()` on this same connection (PiHarness's
	 * session store), and its callback awaits between statements. A change of ours that runs meanwhile joins
	 * pi's transaction and would roll back with it. Counting those transactions lets `write` hold its
	 * notifications until the outermost one settles: delivered once it commits, dropped if it rolls back, so
	 * a stream never sees an event, nor a run its end, that storage does not keep; and lets `outside` keep
	 * the changes that must not roll back out of them altogether.
	 *
	 * The count goes up before the storage's `transaction()` is called and down only once its promise has
	 * settled, so it covers at least the time the transaction is open.
	 */
	watchTransactions(): void {
		const storage = this.#storage;
		const original = storage.transaction.bind(storage);
		const wrapped = (<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> => {
			this.#outer++;
			let running: Promise<T>;
			try {
				running = original(closure);
			} catch (error) {
				this.#settled(false);
				throw error;
			}
			return running.then(
				(value) => {
					this.#settled(true);
					return value;
				},
				(error: unknown) => {
					this.#settled(false);
					throw error;
				},
			);
		}) as DurableObjectStorage["transaction"];
		Object.defineProperty(storage, "transaction", { value: wrapped, configurable: true, writable: true });
	}

	#settled(committed: boolean): void {
		this.#outer--;
		if (!committed) this.#parked = { appended: [], ended: [] };
		if (this.#outer > 0) return;
		const { appended, ended } = this.#parked;
		this.#parked = { appended: [], ended: [] };
		const drained = this.#drained;
		this.#drained = null;
		try {
			this.#notify(appended, ended);
		} finally {
			drained?.resolve();
		}
	}

	/**
	 * Makes `change` once no asynchronous transaction is open, so it commits on its own and no rollback of
	 * pi's can take it back. The last check and the change run in one synchronous stretch: a transaction
	 * that opens while this waits is waited for too. Never call it from inside such a transaction's callback,
	 * which would wait for itself; pi calls ours (tools, the model, commit publications) outside them.
	 */
	async outside<T>(change: () => T): Promise<T> {
		while (this.#outer > 0) {
			this.#drained ??= Promise.withResolvers<void>();
			await this.#drained.promise;
		}
		return change();
	}

	#notify(appended: [RunId, RunEvent][], ended: RunId[]): void {
		for (const [runId, event] of appended) this.#listeners?.appended(runId, event);
		for (const runId of ended) this.#listeners?.ended(runId);
	}

	/** One transaction; listeners hear of its events and ended runs after it commits. Nested calls join it. */
	write<T>(change: () => T): T {
		if (this.#depth > 0) return change();
		this.#depth++;
		let result: T;
		try {
			result = this.#storage.transactionSync(change);
		} catch (error) {
			this.#appended = [];
			this.#ended = [];
			throw error;
		} finally {
			this.#depth--;
		}
		const appended = this.#appended;
		const ended = this.#ended;
		this.#appended = [];
		this.#ended = [];
		if (this.#outer > 0) {
			this.#parked.appended.push(...appended);
			this.#parked.ended.push(...ended);
		} else this.#notify(appended, ended);
		return result;
	}

	// The conversation.

	conversation(): ConversationRow | null {
		return this.#sql.exec<ConversationRow>("SELECT * FROM conversation WHERE singleton = 1").toArray()[0] ?? null;
	}

	/**
	 * Binds a Laravel conversation on first use; false when the row is bound to another organization, workspace or
	 * jurisdiction, or is a Workspace conversation. Its user and agent stay empty: each run's snapshot names its own.
	 */
	bind(binding: ConversationBinding): boolean {
		return this.write(() => {
			const existing = this.conversation();
			if (existing) {
				return (
					existing.id === binding.conversationId &&
					existing.organization_id === binding.organization &&
					existing.workspace_id === binding.workspace.id &&
					existing.jurisdiction === binding.workspace.jurisdiction
				);
			}
			this.#sql.exec(
				"INSERT INTO conversation (singleton, id, workspace_id, jurisdiction, user_id, agent_id, organization_id, created_at, updated_at) VALUES (1, ?, ?, ?, '', '', ?, ?, ?)",
				binding.conversationId,
				binding.workspace.id,
				binding.workspace.jurisdiction,
				binding.organization,
				binding.createdAt,
				binding.createdAt,
			);
			return true;
		});
	}

	workspaceRef(row: ConversationRow): WorkspaceRef {
		return { id: row.workspace_id, jurisdiction: row.jurisdiction === "eu" ? "eu" : null };
	}

	touch(change: { folderVersionId?: VersionId | null }): void {
		const now = this.now();
		if (change.folderVersionId !== undefined) this.#sql.exec("UPDATE conversation SET folder_version_id = ? WHERE singleton = 1", change.folderVersionId);
		this.#sql.exec("UPDATE conversation SET updated_at = ? WHERE singleton = 1", now);
	}

	markDeleted(): void {
		this.#sql.exec("UPDATE conversation SET deleted_at = coalesce(deleted_at, ?) WHERE singleton = 1", this.now());
	}

	// Runs.

	/**
	 * The run with its snapshot: in `runs.snapshot` when it fits in one value, else in `run_snapshots`'
	 * parts with the column empty. A snapshot holds every grant of the user, so it can pass the 2 MB a
	 * string or a row may have without any API limit being broken.
	 */
	insertRun(run: { id: RunId; snapshot: RunSnapshot; deadline: EpochMs | null; baseVersionId: VersionId | null; createdAt: EpochMs; allowance: number | null }): void {
		const parts = splitParts(JSON.stringify(run.snapshot), VALUE_PART);
		this.#sql.exec(
			"INSERT INTO runs (id, status, attempt, attempt_started_at, snapshot, deadline, base_version_id, created_at, metered, allowance) VALUES (?, 'queued', 1, ?, ?, ?, ?, ?, 1, ?)",
			run.id,
			run.createdAt,
			parts.length === 1 ? (parts[0] as string) : "",
			run.deadline,
			run.baseVersionId,
			run.createdAt,
			run.allowance,
		);
		if (parts.length > 1) parts.forEach((text, part) => this.#sql.exec("INSERT INTO run_snapshots (run_id, part, text) VALUES (?, ?, ?)", run.id, part, text));
		this.#sql.exec("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, 1, ?)", run.id, run.createdAt);
	}

	run(id: RunId): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id).toArray()[0] ?? null;
	}

	/** At most one run is queued, provisioning or running. */
	activeRun(): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ${ACTIVE_SQL} ORDER BY created_at DESC LIMIT 1`).toArray()[0] ?? null;
	}

	runs(): RunRow[] {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at, id`).toArray();
	}

	/** Throws once the run's prune started: its inputs are deleted, and only an active run reads them. */
	snapshot(run: Pick<RunRow, "id">): RunSnapshot {
		const row = this.#sql.exec<{ snapshot: string; prune: RunPrune | null }>("SELECT snapshot, prune FROM runs WHERE id = ?", run.id).toArray()[0];
		if (row?.prune != null) throw new Error("The run's inputs were deleted after it ended.");
		const whole = row?.snapshot ?? "";
		if (whole !== "") return parseJson(whole) as unknown as RunSnapshot;
		const parts = this.#sql.exec<{ text: string }>("SELECT text FROM run_snapshots WHERE run_id = ? ORDER BY part", run.id).toArray();
		return parseJson(parts.map((part) => part.text).join("")) as unknown as RunSnapshot;
	}

	/** Only what the checks read: they run before every provider request and append. */
	#checked(runId: RunId): Pick<RunRow, "status" | "attempt" | "revoked" | "deadline"> | null {
		return this.#sql.exec<RunRow>("SELECT status, attempt, revoked, deadline FROM runs WHERE id = ?", runId).toArray()[0] ?? null;
	}

	/** Status acting, deadline not passed, attempt equal, not revoked. */
	isCurrent(fence: AttemptFence): boolean {
		const run = this.#checked(fence.runId);
		return run !== null && run.attempt === fence.attempt && this.#acting(run);
	}

	/** Status acting, deadline not passed, not revoked; any attempt. */
	isActive(runId: RunId): boolean {
		const run = this.#checked(runId);
		return run !== null && this.#acting(run);
	}

	#acting(run: Pick<RunRow, "status" | "revoked" | "deadline">): boolean {
		return (run.status === "provisioning" || run.status === "running") && run.revoked === 0 && (run.deadline === null || run.deadline > this.now());
	}

	update(runId: RunId, fields: Partial<Pick<RunRow, "session" | "provider_session" | "checkpoint_version_id" | "uploaded_bytes">>): void {
		const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
		if (!entries.length) return;
		this.#sql.exec(`UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, value]) => value), runId);
	}

	/** Sets the session once; another one already set wins and is returned. */
	claimSession(runId: RunId, session: string, providerSession: string | null): string | null {
		this.#sql.exec("UPDATE runs SET session = ?, provider_session = ? WHERE id = ? AND session IS NULL", session, providerSession, runId);
		return this.run(runId)?.session ?? null;
	}

	/** The revoked flag the executor checks before every provider request (ARCHITECTURE.md: Strict revocation). */
	revoke(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET revoked = 1 WHERE id = ?", runId);
	}

	/** The run may have a container from now on, if it had none before: admission counts its time from here. */
	containerStarting(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET container_since = ? WHERE id = ? AND container_since IS NULL", this.now(), runId);
	}

	setWritesUncertain(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET writes_uncertain = 1 WHERE id = ?", runId);
	}

	/**
	 * queued → provisioning, with `{status: "provisioning"}` (no attempt). `activated` is still set: the previous version's
	 * code runs only an activated run, and may run beside this one or after a rollback (chunk-13b-design.md).
	 */
	activate(runId: RunId): boolean {
		return this.write(() => {
			const changed = this.#sql.exec("UPDATE runs SET activated = 1, status = 'provisioning' WHERE id = ? AND status = 'queued' RETURNING id", runId).toArray();
			if (!changed.length) return false;
			this.append(runId, statusEvent({ status: "provisioning" }));
			return true;
		});
	}

	/** provisioning → running, once per attempt, keeping the run's first start time. */
	startAttempt(fence: AttemptFence): boolean {
		return this.write(() => {
			const changed = this.#sql
				.exec(
					"UPDATE runs SET status = 'running', started_at = coalesce(started_at, ?) WHERE id = ? AND attempt = ? AND status = 'provisioning' RETURNING id",
					this.now(),
					fence.runId,
					fence.attempt,
				)
				.toArray();
			if (!changed.length) return false;
			this.append(fence.runId, statusEvent({ status: "running" }));
			return true;
		});
	}

	/** The gate's new attempt: attempt + 1 and the restart marker, the deadline unchanged. */
	restart(runId: RunId, attempt: number): void {
		const now = this.now();
		this.#sql.exec("UPDATE runs SET attempt = ?, attempt_started_at = ?, status = 'provisioning' WHERE id = ?", attempt, now, runId);
		this.#sql.exec("UPDATE attempts SET ended_at = ?, ended = 'restarted' WHERE run_id = ? AND attempt = ?", now, runId, attempt - 1);
		this.#sql.exec("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", runId, attempt, now);
		this.append(runId, statusEvent({ status: "provisioning", attempt }));
	}

	/**
	 * The one way a run ends, once, from an active state: status, code, message cut to 500, the
	 * folder published, and the terminal status event, in one transaction.
	 */
	finish(runId: RunId, end: RunEnd, options: FinishOptions = {}): boolean {
		return this.write(() => {
			const now = this.now();
			let query = `UPDATE runs SET status = ?, error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND status IN ${ACTIVE_SQL}`;
			const params: SqlStorageValue[] = [end.status, end.code, sliceText(end.message, 0, ERROR_MESSAGE_CHARS), now, runId];
			if (options.attempt !== undefined) {
				query += " AND attempt = ?";
				params.push(options.attempt);
			}
			if (options.fromStatus !== undefined) {
				query += " AND status = ?";
				params.push(options.fromStatus);
			}
			const row = this.#sql.exec<RunRow>(`${query} RETURNING ${RUN_COLUMNS}`, ...params).toArray()[0];
			if (!row) return false;
			const published = this.#publish?.(row) ?? { resultVersionId: row.checkpoint_version_id ?? row.base_version_id, changes: null };
			this.#sql.exec(
				"UPDATE runs SET result_version_id = ?, folder_changes = ? WHERE id = ?",
				published.resultVersionId,
				published.changes === null ? null : JSON.stringify(published.changes),
				runId,
			);
			const ended = options.attemptEnded ?? (end.status === "completed" ? "completed" : end.status === "cancelled" ? "cancelled" : "failed");
			this.#sql.exec("UPDATE attempts SET ended_at = ?, ended = ? WHERE run_id = ? AND attempt = ? AND ended_at IS NULL", now, ended, runId, row.attempt);
			this.touch({ folderVersionId: published.resultVersionId });
			this.append(runId, statusEvent(terminalStatus(end)));
			this.#finishedFact(row, end, published, options.answer ?? null);
			if (row.metered === 1) this.#listeners?.settling(runId);
			this.#ended.push(runId);
			return true;
		});
	}

	// Usage.

	/** Counts a tool call if the fence is current; false means RUN_ENDED, not counted. */
	countToolCall(fence: AttemptFence): boolean {
		if (!this.isCurrent(fence)) return false;
		this.#sql.exec("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?", fence.runId);
		return true;
	}

	/**
	 * Records a model call about to be sent and counts it (`model_calls`), in one change with the fence check and its
	 * admission: null, with nothing recorded, when the attempt can no longer act, or when the run's spend so far reached its
	 * allowance, which ends the run with BUDGET_REACHED in the same change. The record keeps its route's rates in `prices`
	 * (none when the table has no price for it), which its settlement charges. Answers the call's id, 8 hex drawn again on a
	 * collision within the run. Made outside pi's transactions, so a call that was sent stays recorded.
	 */
	recordModelCall(fence: AttemptFence, request: CallRequest, prices: Prices): string | null {
		return this.write(() => {
			if (!this.isCurrent(fence)) return null;
			if (this.#budgetReached(fence.runId, prices)) {
				this.finish(fence.runId, BUDGET_REACHED, { attempt: fence.attempt });
				return null;
			}
			const price = callPrice(prices, request.provider, request.model);
			for (;;) {
				const inserted = this.#sql
					.exec<{ call: string }>(
						`INSERT INTO call_records (run_id, call, attempt, instance, provider, model, reserved_input, reserved_output, created_at, rates, prices)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING call`,
						fence.runId,
						tokenHex(4),
						fence.attempt,
						this.instance,
						request.provider,
						request.model,
						request.reserved.input,
						request.reserved.output,
						this.now(),
						price === null ? null : JSON.stringify(price.rates),
						price?.version ?? null,
					)
					.toArray()[0];
				if (!inserted) continue;
				this.#sql.exec("UPDATE runs SET model_calls = model_calls + 1 WHERE id = ?", fence.runId);
				return inserted.call;
			}
		});
	}

	/**
	 * Whether the run's spend so far reached its allowance (docs/plans/chunk-14b-design.md, Admission at the call record):
	 * its settled calls and ended scripts (`spent`), its open scripts and its container time until now, each at `prices`.
	 * What a gone instance left open is settled first (the restart rule, `settleLost`), so an attempt that resumed before
	 * the object's recovery ran sees its charge. A run Laravel gave no allowance never reaches it.
	 */
	#budgetReached(runId: RunId, prices: Prices): boolean {
		const { allowance } = this.#sql.exec<Pick<RunRow, "allowance">>("SELECT allowance FROM runs WHERE id = ?", runId).one();
		if (allowance === null) return false;
		this.settleLost(prices);
		const run = this.#sql.exec<Pick<RunRow, "spent" | "container_since">>("SELECT spent, container_since FROM runs WHERE id = ?", runId).one();
		const now = this.now();
		let total = run.spent;
		const open = this.#sql.exec<{ started_at: number }>("SELECT started_at FROM script_records WHERE run_id = ? AND ended_at IS NULL", runId).toArray();
		for (const { started_at } of open) total += scriptCharge(prices.table.script, Math.max(0, now - started_at));
		if (run.container_since !== null) total += containerTimeCharge(prices.table.container, Math.max(0, now - run.container_since));
		return total >= allowance;
	}

	/**
	 * Settles a recorded call, once: a call already settled changes nothing and writes no fact. Not fenced: a call is
	 * settled whichever attempt made it. The run's sums follow in the same change (`input_tokens` and `output_tokens` for a
	 * reported call, `unmetered_model_calls` for an unmetered one, `spent` for a priced one), with the call's `run.usage` or
	 * `run.unmetered` fact. An unmetered call is counted, and charged, at its reservation; a refused one is charged nothing.
	 * Made outside pi's transactions: a provider call's cost does not roll back.
	 */
	settleModelCall(runId: RunId, call: string, settlement: CallSettlement): void {
		this.write(() => {
			const record = this.#sql.exec<CallRecordRow>("SELECT * FROM call_records WHERE run_id = ? AND call = ? AND outcome IS NULL", runId, call).toArray()[0];
			if (!record) return;
			const tokens = settledTokens(record, settlement);
			const charge = record.rates === null || record.prices === null ? null : { costMicros: callCharge(parseJson(record.rates) as unknown as TokenRates, tokens), prices: record.prices };
			this.#sql.exec(
				`UPDATE call_records SET outcome = ?, cause = ?, request_bytes = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
					cache_write_tokens = ?, reasoning_tokens = ?, settled_at = ?, cost_micros = ? WHERE run_id = ? AND call = ?`,
				settlement.outcome,
				settlement.outcome === "unmetered" ? settlement.cause : null,
				settlement.requestBytes,
				tokens.input,
				tokens.output,
				tokens.cached,
				tokens.cacheWrite,
				tokens.reasoning,
				this.now(),
				charge?.costMicros ?? null,
				runId,
				call,
			);
			if (settlement.outcome === "reported") this.#sql.exec("UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?", tokens.input, tokens.output, runId);
			else if (settlement.outcome === "unmetered") this.#sql.exec("UPDATE runs SET unmetered_model_calls = unmetered_model_calls + 1 WHERE id = ?", runId);
			if (charge !== null) this.#sql.exec("UPDATE runs SET spent = spent + ? WHERE id = ?", charge.costMicros, runId);
			this.#fact(runId, callFact(record, settlement, tokens, charge));
		});
	}

	/**
	 * Records a script about to run, in one change with the fence check: false, with nothing recorded, when the attempt can
	 * no longer act. `timeoutMs` is its clock, the bound of a record its instance never ends. Made outside pi's transactions.
	 */
	recordScript(script: ScriptFence, timeoutMs: number): boolean {
		return this.write(() => {
			if (!this.isCurrent(script)) return false;
			this.#sql.exec(
				"INSERT INTO script_records (script_id, run_id, instance, started_at, timeout_ms) VALUES (?, ?, ?, ?, ?)",
				script.scriptId,
				script.runId,
				this.instance,
				this.now(),
				timeoutMs,
			);
			return true;
		});
	}

	/**
	 * Ends a script's record at `at`, when it answered, once, charged at `prices` and added to its run's `spent` in the same
	 * change. Not fenced: the script ran whichever way the run went.
	 */
	endScript(scriptId: string, at: EpochMs, prices: Prices): void {
		this.write(() => {
			const open = this.#sql.exec<{ started_at: number }>("SELECT started_at FROM script_records WHERE script_id = ? AND ended_at IS NULL", scriptId).toArray()[0];
			if (open) this.#endScript(scriptId, open.started_at, at, prices);
		});
	}

	/** In the caller's change: the open script ends at `at`, charged for its time since `startedAt`. */
	#endScript(scriptId: string, startedAt: EpochMs, at: EpochMs, prices: Prices, estimated = false): void {
		const cost = scriptCharge(prices.table.script, Math.max(0, at - startedAt));
		const { run_id } = this.#sql
			.exec<{ run_id: RunId }>(
				"UPDATE script_records SET ended_at = ?, estimated = ?, prices = ?, cost_micros = ? WHERE script_id = ? RETURNING run_id",
				at,
				estimated ? 1 : 0,
				prices.version,
				cost,
				scriptId,
			)
			.one();
		this.#sql.exec("UPDATE runs SET spent = spent + ? WHERE id = ?", cost, run_id);
	}

	/**
	 * The restart rule: every call record another instance left open settles unmetered, cause `lost`, at its reservation,
	 * and every script record it left open ends at its clock's bound, or now if that is sooner, `estimated`. That instance
	 * is gone (a Durable Object has one live instance, and a reset ends the old one's work), so nothing else would settle
	 * them; this instance's own records are its streams' and scripts' to settle. Each is charged as it settles, a script at
	 * `prices`. Answers how many records it settled.
	 */
	settleLost(prices: Prices): number {
		return this.write(() => {
			const open = this.#sql.exec<{ run_id: RunId; call: string }>("SELECT run_id, call FROM call_records WHERE outcome IS NULL AND instance != ?", this.instance).toArray();
			for (const { run_id, call } of open) this.settleModelCall(run_id, call, { outcome: "unmetered", cause: "lost", requestBytes: null });
			const now = this.now();
			const scripts = this.#sql
				.exec<{ script_id: string; started_at: number; timeout_ms: number }>("SELECT script_id, started_at, timeout_ms FROM script_records WHERE ended_at IS NULL AND instance != ?", this.instance)
				.toArray();
			for (const script of scripts) this.#endScript(script.script_id, script.started_at, Math.min(now, script.started_at + script.timeout_ms), prices, true);
			return open.length + scripts.length;
		});
	}

	/** Where the run's `run.settled` stands (`RunSettlement`). */
	settlement(runId: RunId): RunSettlement {
		const run = this.#sql.exec<Pick<RunRow, "status" | "created_at">>("SELECT status, created_at FROM runs WHERE id = ? AND metered = 1 AND settled_at IS NULL", runId).toArray()[0];
		if (!run || ACTIVE.has(run.status)) return { state: "none" };
		const open = this.#sql
			.exec("SELECT 1 FROM call_records WHERE run_id = ?1 AND outcome IS NULL UNION ALL SELECT 1 FROM script_records WHERE run_id = ?1 AND ended_at IS NULL LIMIT 1", runId)
			.toArray().length;
		return open ? { state: "open" } : { state: "due", createdAt: run.created_at };
	}

	/** The runs that owe a `run.settled` still: metered, ended, not settled. */
	unsettledRuns(): RunId[] {
		return this.#sql
			.exec<{ id: RunId }>(`SELECT id FROM runs WHERE metered = 1 AND settled_at IS NULL AND status NOT IN ${ACTIVE_SQL}`)
			.toArray()
			.map((row) => row.id);
	}

	/**
	 * Writes the run's `run.settled` once, when its settlement is due: the totals of its call records (reported tokens apart
	 * from the reservations unmetered calls are counted at) and of its script records, with its container time, and
	 * `settled_at`, in one change. When every record of the run was charged, it carries the run's charge too: its calls' and
	 * scripts', and its container time at `prices`. False, writing nothing, otherwise. Made outside pi's transactions.
	 */
	settleRun(runId: RunId, containers: ContainerCharge, prices: Prices): boolean {
		return this.write(() => {
			if (this.settlement(runId).state !== "due") return false;
			const calls = this.#sql
				.exec<Omit<Settled, keyof ContainerCharge | "scripts" | "scriptMs" | "scriptEstimated">>(
					`SELECT count(*) AS modelCalls,
						count(*) FILTER (WHERE outcome = 'refused') AS refusedCalls,
						count(*) FILTER (WHERE outcome = 'unmetered') AS unmeteredCalls,
						coalesce(sum(input_tokens) FILTER (WHERE outcome = 'reported'), 0) AS inputTokens,
						coalesce(sum(output_tokens) FILTER (WHERE outcome = 'reported'), 0) AS outputTokens,
						coalesce(sum(cached_tokens) FILTER (WHERE outcome = 'reported'), 0) AS cachedTokens,
						coalesce(sum(cache_write_tokens) FILTER (WHERE outcome = 'reported'), 0) AS cacheWriteTokens,
						coalesce(sum(reasoning_tokens) FILTER (WHERE outcome = 'reported'), 0) AS reasoningTokens,
						coalesce(sum(input_tokens) FILTER (WHERE outcome = 'unmetered'), 0) AS estimatedInputTokens,
						coalesce(sum(output_tokens) FILTER (WHERE outcome = 'unmetered'), 0) AS estimatedOutputTokens
					FROM call_records WHERE run_id = ?`,
					runId,
				)
				.one();
			const scripts = this.#sql
				.exec<{ scripts: number; scriptMs: number; scriptEstimated: number }>(
					"SELECT count(*) AS scripts, coalesce(sum(ended_at - started_at), 0) AS scriptMs, coalesce(max(estimated), 0) AS scriptEstimated FROM script_records WHERE run_id = ?",
					runId,
				)
				.one();
			const charged = this.#sql
				.exec<{ unpriced: number; modelMicros: number; scriptMicros: number }>(
					`SELECT (SELECT count(*) FROM call_records WHERE run_id = ?1 AND cost_micros IS NULL)
							+ (SELECT count(*) FROM script_records WHERE run_id = ?1 AND cost_micros IS NULL) AS unpriced,
						(SELECT coalesce(sum(cost_micros), 0) FROM call_records WHERE run_id = ?1) AS modelMicros,
						(SELECT coalesce(sum(cost_micros), 0) FROM script_records WHERE run_id = ?1) AS scriptMicros`,
					runId,
				)
				.one();
			const containerMicros = containerTimeCharge(prices.table.container, containers.containerMs);
			const money =
				charged.unpriced > 0
					? {}
					: { prices: prices.version, modelMicros: charged.modelMicros, containerMicros, scriptMicros: charged.scriptMicros, chargedMicros: charged.modelMicros + containerMicros + charged.scriptMicros };
			this.#sql.exec("UPDATE runs SET settled_at = ? WHERE id = ?", this.now(), runId);
			this.#fact(runId, { type: "run.settled", data: { ...calls, ...containers, scripts: scripts.scripts, scriptMs: scripts.scriptMs, scriptEstimated: scripts.scriptEstimated === 1, ...money } });
			return true;
		});
	}

	// Runs' retention (docs/plans/chunk-15a-design.md, A run's steps).

	/** When the oldest run that ended and is not yet pruned to its row ended, or null when there is none. */
	oldestUnpruned(): EpochMs | null {
		return this.#sql.exec<{ at: number | null }>("SELECT min(finished_at) AS at FROM runs WHERE finished_at IS NOT NULL AND (prune IS NULL OR prune != 'done')").one().at;
	}

	/**
	 * The oldest run due for a step of its prune: it ended at or before `ripe`, is not done, is settled (or owes no
	 * settlement) and has no write still dispatched, whose settlement is a fact still to write; not one whose session is in
	 * `skipped`, nor one in its pi stage unless `pi` holds.
	 */
	prunableRun(ripe: EpochMs, skipped: readonly number[], pi: boolean): PrunableRun | null {
		return (
			this.#sql
				.exec<PrunableRun>(
					`SELECT id, session, prune FROM runs
					WHERE finished_at IS NOT NULL AND (prune IS NULL OR prune != 'done') AND finished_at <= ?1
						AND (metered = 0 OR settled_at IS NOT NULL)
						AND NOT EXISTS (SELECT 1 FROM run_writes WHERE run_writes.run_id = runs.id AND status = 'dispatched')
						AND (?2 = 1 OR prune IS NULL OR prune = 'records')
						AND (session IS NULL OR CAST(session AS INTEGER) NOT IN (SELECT value FROM json_each(?3)))
					ORDER BY finished_at LIMIT 1`,
					ripe,
					pi ? 1 : 0,
					JSON.stringify(skipped),
				)
				.toArray()[0] ?? null
		);
	}

	/**
	 * One step of a run's own records' deletion, at most `limit` rows in RUN_RECORDS' order. The first empties its snapshot
	 * and sets it `records`; the step that finds fewer than `limit` left has deleted the last, and moves it to `pi`, or
	 * `done` when it has no pi session.
	 */
	pruneRecords(runId: RunId, limit: number): void {
		this.write(() => {
			this.#sql.exec("UPDATE runs SET prune = 'records', pruned_at = ?, snapshot = '' WHERE id = ? AND prune IS NULL", this.now(), runId);
			let left = limit;
			for (const [table, key] of RUN_RECORDS) {
				if (left <= 0) break;
				const query = `DELETE FROM ${table} WHERE run_id = ?1 AND ${key} IN (SELECT ${key} FROM ${table} WHERE run_id = ?1 ORDER BY ${key} LIMIT ?2) RETURNING 1`;
				left -= this.#sql.exec(query, runId, left).toArray().length;
			}
			if (left > 0) this.#sql.exec("UPDATE runs SET prune = CASE WHEN session IS NULL THEN 'done' ELSE 'pi' END WHERE id = ? AND prune = 'records'", runId);
		});
	}

	/** One step of the deletion of a run's pi session (pi-tables.ts); the step that finds nothing left sets the run `done`. */
	prunePi(runId: RunId, session: number, limit: number): PiStep {
		return this.write(() => {
			const step = deletePiSession(this.#sql, session, limit);
			if (step.kind === "gone") this.#sql.exec("UPDATE runs SET prune = 'done' WHERE id = ? AND prune = 'pi'", runId);
			return step;
		});
	}

	/**
	 * One step of the deletion of the first pi session no run names, but those in `skipped`; null when there is none. Only
	 * while no run is active (pi-tables.ts `orphanPiSession`), which the caller checks in the same synchronous step.
	 */
	pruneOrphan(skipped: readonly number[], limit: number): { session: number; step: PiStep } | null {
		return this.write(() => {
			const session = orphanPiSession(this.#sql, skipped);
			return session === null ? null : { session, step: deletePiSession(this.#sql, session, limit) };
		});
	}

	// A deleted conversation's purge (docs/plans/chunk-15a-design.md, Physical deletion).

	/**
	 * Where a deleted Laravel conversation's purge stands, or null for any other: when it was deleted, how many facts Laravel
	 * has not acknowledged, and whether the purge would lose nothing: every metered run settled, no write still dispatched
	 * (its settlement is a fact still to write), every fact acknowledged and pruned. No run active and no start prepared
	 * is the caller's check, in the same synchronous step.
	 */
	deletion(): Deletion | null {
		const conversation = this.conversation();
		if (conversation?.organization_id == null || conversation.deleted_at === null) return null;
		const { written, acknowledged } = this.delivery();
		const left = this.#sql
			.exec(
				`SELECT 1 FROM facts
				UNION ALL SELECT 1 FROM run_writes WHERE status = 'dispatched'
				UNION ALL SELECT 1 FROM runs WHERE metered = 1 AND settled_at IS NULL
				LIMIT 1`,
			)
			.toArray().length;
		return { deletedAt: conversation.deleted_at, unacknowledged: written - acknowledged, purgeable: left === 0 && acknowledged === written };
	}

	/** How often pi has executed this call, this execution included (the replay cap, ARCHITECTURE.md: Attempts and recovery). */
	countExecution(runId: RunId, callId: string): number {
		return this.#sql
			.exec<{ executions: number }>(
				"INSERT INTO tool_executions (run_id, call_id, executions) VALUES (?, ?, 1) ON CONFLICT (run_id, call_id) DO UPDATE SET executions = executions + 1 RETURNING executions",
				runId,
				callId,
			)
			.one().executions;
	}

	saveArgumentText(runId: RunId, callId: string, text: string): void {
		this.#sql.exec("INSERT INTO tool_arguments (run_id, call_id, text) VALUES (?, ?, ?) ON CONFLICT (run_id, call_id) DO UPDATE SET text = excluded.text", runId, callId, text);
	}

	argumentText(runId: RunId, callId: string): string | null {
		return this.#sql.exec<{ text: string }>("SELECT text FROM tool_arguments WHERE run_id = ? AND call_id = ?", runId, callId).toArray()[0]?.text ?? null;
	}

	// Events.

	/**
	 * Appends with the next seq. A fenced append whose attempt is no longer current, or an `active` one
	 * whose run is no longer active, takes no seq and returns null.
	 */
	append(runId: RunId, event: NewRunEvent, fence: AppendFence = null): RunEvent | null {
		return this.write(() => {
			let query = "UPDATE runs SET event_seq = event_seq + 1 WHERE id = ?";
			const params: SqlStorageValue[] = [runId];
			if (fence !== null) {
				query += ` AND status IN ${ACTING_SQL} AND revoked = 0 AND (deadline IS NULL OR deadline > ?)`;
				params.push(this.now());
				if (fence !== "active") {
					if (fence.runId !== runId) return null;
					query += " AND attempt = ?";
					params.push(fence.attempt);
				}
			}
			const row = this.#sql.exec<{ event_seq: number }>(`${query} RETURNING event_seq`, ...params).toArray()[0];
			if (!row) return null;
			const stored = { seq: row.event_seq, ...event } as RunEvent;
			this.#sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)", runId, stored.seq, stored.type, JSON.stringify(stored.data), this.now());
			this.#appended.push([runId, stored]);
			// The events that are also facts, but for `tool_call` (appendToolCall) and the terminal status (`finish`).
			if (stored.type === "local_tool") this.#fact(runId, { type: "run.local_tool", data: stored.data });
			else if (stored.type === "status" && (stored.data.status === "provisioning" || stored.data.status === "running")) {
				const attempt = this.#sql.exec<{ attempt: number }>("SELECT attempt FROM runs WHERE id = ?", runId).one().attempt;
				this.#fact(runId, { type: "run.status", data: { status: stored.data.status, attempt } });
			}
			return stored;
		});
	}

	/** A `tool_call` event while the run is active, with its fact made from the call's own arguments (facts.ts `toolCallFact`). */
	appendToolCall(runId: RunId, data: ToolCallEventData, args: Json | undefined): RunEvent | null {
		return this.write(() => {
			const appended = this.append(runId, { type: "tool_call", data }, "active");
			if (appended) this.#fact(runId, toolCallFact(data, args));
			return appended;
		});
	}

	events(runId: RunId, page: EventPage): RunEvent[] {
		const limit = Math.min(Math.max(1, Math.floor(page.limit)), PAGE_LIMIT);
		const rows = this.#sql
			.exec<{ seq: number; type: RunEventType; data: string }>(
				"SELECT seq, type, data FROM run_events WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
				runId,
				page.after,
				page.upTo,
				limit,
			)
			.toArray();
		const out: RunEvent[] = [];
		let bytes = 0;
		for (const row of rows) {
			bytes += row.data.length;
			if (out.length && bytes > PAGE_BYTES) break;
			out.push({ seq: row.seq, type: row.type, data: parseJson(row.data) } as RunEvent);
		}
		return out;
	}

	/** Events after `after` for a stream, in pages, as raw JSON frames. */
	*eventFrames(runId: RunId, after: number): Generator<{ seq: number; frame: string }> {
		let cursor = after;
		for (;;) {
			const rows = this.#sql
				.exec<{ seq: number; type: string; data: string }>("SELECT seq, type, data FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 500", runId, cursor)
				.toArray();
			for (const row of rows) {
				cursor = row.seq;
				yield { seq: row.seq, frame: `{"seq":${row.seq},"type":${JSON.stringify(row.type)},"data":${row.data}}` };
			}
			if (rows.length < 500) return;
		}
	}

	// A Laravel start's preparation and answer (docs/plans/start-and-cancel.md, startRun).

	/** The start's preparation, kept from its first try until it is answered; in parts, like a run's snapshot. */
	preparation(runId: RunId): Preparation | null {
		const parts = this.#sql.exec<{ text: string }>("SELECT text FROM internal_starts WHERE run_id = ? ORDER BY part", runId).toArray();
		return parts.length ? (parseJson(parts.map((part) => part.text).join("")) as unknown as Preparation) : null;
	}

	addPreparation(runId: RunId, preparation: Preparation): void {
		splitParts(JSON.stringify(preparation), VALUE_PART).forEach((text, part) => {
			this.#sql.exec("INSERT INTO internal_starts (run_id, part, text) VALUES (?, ?, ?)", runId, part, text);
		});
	}

	deletePreparation(runId: RunId): void {
		this.#sql.exec("DELETE FROM internal_starts WHERE run_id = ?", runId);
	}

	/** The runs whose start is prepared and not yet answered. */
	preparedRuns(): RunId[] {
		return this.#sql.exec<{ run_id: RunId }>("SELECT DISTINCT run_id FROM internal_starts").toArray().map((row) => row.run_id);
	}

	/** Whether another run's start is prepared and not yet answered: the conversation is busy for any other. */
	preparedOther(runId: RunId): boolean {
		return this.#sql.exec("SELECT 1 FROM internal_starts WHERE run_id != ? LIMIT 1", runId).toArray().length > 0;
	}

	/** The start's answer, as it was first given. */
	answer(runId: RunId): StartRunResult | null {
		const row = this.#sql.exec<{ answer: string }>("SELECT answer FROM internal_answers WHERE run_id = ?", runId).toArray()[0];
		return row ? (parseJson(row.answer) as unknown as StartRunResult) : null;
	}

	/** Stores the start's answer once; its preparation is no longer needed. */
	addAnswer(runId: RunId, answer: StartRunResult): void {
		this.#sql.exec("INSERT INTO internal_answers (run_id, answer, created_at) VALUES (?, ?, ?)", runId, JSON.stringify(answer), this.now());
		this.deletePreparation(runId);
	}

	tombstone(runId: RunId): TombstoneRow | null {
		return this.#sql.exec<TombstoneRow>("SELECT * FROM tombstones WHERE run_id = ?", runId).toArray()[0] ?? null;
	}

	addTombstone(runId: RunId, reason: CancelReason, entryId: number): void {
		this.#sql.exec("INSERT INTO tombstones (run_id, reason, entry_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", runId, reason, entryId, this.now());
	}

	// Facts (docs/plans/credentials-and-facts.md, The outbox of facts): a Laravel conversation's only.

	/** Whether this conversation's runs write facts: Laravel's do, the Workspace's do not. Fixed once the row is made. */
	#factsOn: boolean | null = null;

	#writesFacts(): boolean {
		if (this.#factsOn === null) {
			const conversation = this.conversation();
			if (conversation === null) return false;
			this.#factsOn = conversation.organization_id !== null;
		}
		return this.#factsOn;
	}

	/** The delivery's row, made on first use. */
	delivery(): DeliveryRow {
		this.#sql.exec("INSERT INTO fact_delivery (singleton) VALUES (1) ON CONFLICT DO NOTHING");
		return this.#sql.exec<DeliveryRow>("SELECT * FROM fact_delivery WHERE singleton = 1").one();
	}

	/**
	 * Laravel holds every fact up to `acknowledged`, as of now: stored with the delivery's failures cleared, and marked with
	 * its time, which the facts' retention counts from. A mark already there keeps its earlier time.
	 */
	acknowledge(acknowledged: number): void {
		this.write(() => {
			this.updateDelivery({ acknowledged, failures: 0, next_at: 0, stopped: null });
			this.#sql.exec("INSERT INTO fact_acknowledgements (seq, at) VALUES (?, ?) ON CONFLICT DO NOTHING", acknowledged, this.now());
		});
	}

	/** Laravel holds facts up to `acknowledged` and no further (it was restored): stored, and the marks above it go. */
	acknowledgeGap(acknowledged: number): void {
		this.write(() => {
			this.updateDelivery({ acknowledged });
			this.forgetAcknowledgements(acknowledged);
		});
	}

	/** The marks above `held` go: Laravel no longer holds what they say it acknowledged, so retention keeps those facts. */
	forgetAcknowledgements(held: number): void {
		this.#sql.exec("DELETE FROM fact_acknowledgements WHERE seq > ?", held);
	}

	/** The time of the oldest acknowledgement mark still kept, or null when none is. */
	oldestAcknowledgement(): EpochMs | null {
		return this.#sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM fact_acknowledgements").one().at;
	}

	/**
	 * One step of the facts' retention (docs/plans/chunk-15a-design.md, Facts and the floor): the facts from the floor up to
	 * the cut, at most `limit` of them, deleted in one transaction that raises the floor past them and deletes the marks
	 * below it. The cut is the highest mark acknowledged at or before `ripe`, never above what Laravel holds, so every fact
	 * deleted was acknowledged at or before then. Returns how far it raised the floor: 0 when nothing was due.
	 */
	pruneFacts(ripe: EpochMs, limit: number): number {
		return this.write(() => {
			const { floor, acknowledged } = this.delivery();
			const mark = this.#sql.exec<{ seq: number | null }>("SELECT max(seq) AS seq FROM fact_acknowledgements WHERE at <= ?", ripe).one().seq;
			const cut = Math.min(acknowledged, mark ?? 0, floor + limit - 1);
			if (cut < floor) return 0;
			this.#sql.exec("DELETE FROM facts WHERE seq <= ?", cut);
			this.#sql.exec("UPDATE fact_delivery SET floor = ? WHERE singleton = 1", cut + 1);
			this.#sql.exec("DELETE FROM fact_acknowledgements WHERE seq <= ?", cut);
			return cut + 1 - floor;
		});
	}

	/** Changes the delivery's state (each change its own transaction, made outside pi's by the caller). */
	updateDelivery(fields: Partial<Pick<DeliveryRow, "acknowledged" | "indexed" | "failures" | "next_at" | "stopped">>): void {
		const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
		if (!entries.length) return;
		this.write(() => {
			this.delivery();
			this.#sql.exec(`UPDATE fact_delivery SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE singleton = 1`, ...entries.map(([, value]) => value as SqlStorageValue));
		});
	}

	/** The fact with the next sequence, in the caller's transaction; the delivery is scheduled in it too. */
	#fact(runId: RunId, fact: NewFact): void {
		if (!this.#writesFacts()) return;
		this.write(() => {
			const delivery = this.delivery();
			const seq = delivery.written + 1;
			const now = this.now();
			const whole = { seq, run: runId, at: isoTime(now), ...fact } as Fact;
			this.#sql.exec("UPDATE fact_delivery SET written = ? WHERE singleton = 1", seq);
			this.#sql.exec("INSERT INTO facts (seq, run_id, fact, created_at) VALUES (?, ?, ?, ?)", seq, runId, JSON.stringify(whole), now);
			this.#listeners?.factWritten(Math.max(now, delivery.next_at));
		});
	}

	/** The run's terminal fact, in `finish`'s transaction: its status, error, answer, folder and what the conversation keeps. */
	#finishedFact(row: RunRow, end: RunEnd, { resultVersionId, storedBytes }: Published, answer: { id: string; content: string } | null): void {
		if (!this.#writesFacts()) return;
		const current = this.#sql.exec<Pick<RunRow, "folder_changes" | "folder_warnings">>("SELECT folder_changes, folder_warnings FROM runs WHERE id = ?", row.id).one();
		const folder =
			row.base_version_id === null && resultVersionId === null
				? null
				: {
						base: row.base_version_id,
						result: resultVersionId,
						changes: current.folder_changes === null ? null : (parseJson(current.folder_changes) as unknown as FolderChanges),
						warnings: current.folder_warnings === null ? null : (parseJson(current.folder_warnings) as unknown as FolderWarnings),
					};
		const data = {
			status: end.status,
			code: end.code,
			error: end.status === "completed" ? "" : sliceText(end.message, 0, ERROR_MESSAGE_CHARS),
			message: answer,
			folder,
			...(storedBytes === undefined ? {} : { storedBytes }),
		};
		this.#fact(row.id, { type: "run.finished", data });
	}

	/** A write's settlement (the ledger's `LedgerRuns.writeSettled`), in its transaction; `afterCancel` when the run had ended or was revoked. */
	writeSettled(write: SettledWrite, outcome: WriteOutcome): void {
		const run = this.#checked(write.runId);
		const afterCancel = run === null || run.revoked === 1 || !ACTIVE.has(run.status);
		this.#fact(write.runId, { type: "run.write", data: { write: write.write, tool: write.tool, connection: write.connection, outcome, afterCancel } });
	}

	/** Facts after `after`, in order: at most `limit` and FACT_PAGE_BYTES of JSON, at least one. Read outside pi's transactions. */
	factPage(after: number, limit: number): FactPage {
		const rows = this.#sql.exec<{ seq: number; fact: string }>("SELECT seq, fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?", after, limit + 1).toArray();
		const facts: FactPage["facts"] = [];
		let bytes = 0;
		for (const row of rows.slice(0, limit)) {
			bytes += utf8(row.fact).byteLength;
			if (facts.length && bytes > FACT_PAGE_BYTES) return { facts, more: true };
			facts.push({ seq: row.seq, json: row.fact });
		}
		return { facts, more: rows.length > limit };
	}

	/** Facts written and not acknowledged. */
	backlog(): number {
		const delivery = this.delivery();
		return delivery.written - delivery.acknowledged;
	}

	// The run's head, for the test build's view.

	runHead(row: RunRow): RunHead {
		return {
			id: row.id,
			status: row.status,
			errorMessage: row.error_message,
			createdAt: isoTime(row.created_at),
			finishedAt: row.finished_at === null ? null : isoTime(row.finished_at),
			baseVersionId: row.base_version_id,
			resultVersionId: row.result_version_id,
			folderChanges: row.folder_changes === null ? null : (parseJson(row.folder_changes) as unknown as FolderChanges),
			folderWarnings: row.folder_warnings === null ? null : (parseJson(row.folder_warnings) as unknown as FolderWarnings),
			eventSeq: row.event_seq,
		};
	}
}
