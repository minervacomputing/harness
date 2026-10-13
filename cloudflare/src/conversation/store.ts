// The Conversation Durable Object's records: the conversation, its messages, runs, attempts and run events,
// and the start protocol's markers and tombstones, over the object's SQLite. Every method is synchronous:
// the checks the executor and the model wrapper make (`isCurrent`, `isActive`) and the appends they ask for
// read and write SQLite with no await in between, which is what makes the revocation, dispatch and fencing
// checks atomic (plan: Strict revocation, Attempts and recovery).
//
// `write` runs a change in one transaction; the events it appended and the runs it ended are handed to the
// listeners only after it commits, so a stream never sees an event that was rolled back.
//
// pi commits with the storage's asynchronous `transaction()` on the same connection, and a statement of ours
// that runs while one is open joins it and rolls back with it (`watchTransactions`). A change that someone
// acts on once it is made must therefore never run inside one: a write's claim or settlement, a revocation, a
// cancel, a start, a run's end, the attempt gate's decision, a call's `tool_call` event, the replay cap's
// count. Those go through `outside`, which waits until no such transaction is open and then makes the change
// with no await between that check and the change, so it commits on its own. What only shows progress (text
// and reasoning deltas, phases, usage counts) may still run inside pi's transaction; rolled back with it, it
// was never announced either.

import type { AttachmentOut, FolderChangesOut, FolderWarningsOut, MessageOut } from "../contracts/api.ts";
import type { AttemptFence, EpochMs, RunId, UserId, VersionId, WorkspaceRef } from "../contracts/common.ts";
import type { ConversationInit, EventPage } from "../contracts/conversation.ts";
import type { NewRunEvent, RunEvent, RunEventType } from "../contracts/events.ts";
import type { CancelReason, ConversationHead, RunEnd, RunHead, RunSnapshot, RunStatus } from "../contracts/runs.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { VALUE_PART, sliceText, splitParts } from "../lib/text.ts";
import { isoTime } from "../lib/dates.ts";
import { ACTIVE, ERROR_MESSAGE_CHARS, statusEvent, terminalStatus } from "./events.ts";
import type { StoredMessage } from "./history.ts";

/** A page of events stops at this much JSON, whatever its limit (contracts/conversation.ts, EventPage). */
export const PAGE_BYTES = 4 * 1024 * 1024;
export const PAGE_LIMIT = 1000;

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
	[key: string]: SqlStorageValue;
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
	[key: string]: SqlStorageValue;
}

interface MessageRow {
	id: string;
	role: "user" | "assistant";
	content: string;
	attachments: string;
	run_id: string | null;
	created_at: number;
	[key: string]: SqlStorageValue;
}

export interface StartRow {
	run_id: string;
	user_id: string;
	content: string;
	upload_ids: string;
	created_at: number;
	[key: string]: SqlStorageValue;
}

export interface TombstoneRow {
	run_id: string;
	reason: CancelReason;
	entry_id: number;
	created_at: number;
	[key: string]: SqlStorageValue;
}

/** Which check an append passes first: none (the object's own events), the run being active, or the attempt being current. */
export type AppendFence = AttemptFence | "active" | null;

export interface StoreListeners {
	/** After commit, for each event appended, in order. */
	appended(runId: RunId, event: RunEvent): void;
	/** After commit, for each run that reached a terminal state. */
	ended(runId: RunId): void;
}

export interface FinishOptions {
	/** Only if this attempt is still the run's (runs 2.2). */
	attempt?: number;
	/** Only if the run is in this state. */
	fromStatus?: RunStatus;
	/** How the attempt ended, for its record. */
	attemptEnded?: "completed" | "restarted" | "failed" | "cancelled";
}

/** What `finish` asks the folder, inside its transaction. */
export type Publish = (run: RunRow) => { resultVersionId: VersionId | null; changes: { [key: string]: unknown } | null };

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

	/** Fixes the identity once; false when another identity is already stored. */
	init(input: ConversationInit): boolean {
		return this.write(() => {
			const existing = this.conversation();
			if (existing) {
				return (
					existing.id === input.conversationId &&
					existing.workspace_id === input.workspace.id &&
					existing.jurisdiction === input.workspace.jurisdiction &&
					existing.user_id === input.userId &&
					existing.agent_id === input.agentId
				);
			}
			this.#sql.exec(
				"INSERT INTO conversation (singleton, id, workspace_id, jurisdiction, user_id, agent_id, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
				input.conversationId,
				input.workspace.id,
				input.workspace.jurisdiction,
				input.userId,
				input.agentId,
				input.createdAt,
				input.createdAt,
			);
			return true;
		});
	}

	workspaceRef(row: ConversationRow): WorkspaceRef {
		return { id: row.workspace_id, jurisdiction: row.jurisdiction === "eu" ? "eu" : null };
	}

	touch(change: { title?: string; folderVersionId?: VersionId | null }): void {
		const now = this.now();
		if (change.title !== undefined) this.#sql.exec("UPDATE conversation SET title = ? WHERE singleton = 1", change.title);
		if (change.folderVersionId !== undefined) this.#sql.exec("UPDATE conversation SET folder_version_id = ? WHERE singleton = 1", change.folderVersionId);
		this.#sql.exec("UPDATE conversation SET updated_at = ? WHERE singleton = 1", now);
	}

	markDeleted(): void {
		this.#sql.exec("UPDATE conversation SET deleted_at = coalesce(deleted_at, ?) WHERE singleton = 1", this.now());
	}

	// Messages.

	insertMessage(message: { id: string; role: "user" | "assistant"; content: string; attachments: AttachmentOut[]; runId: RunId | null; createdAt: EpochMs }): void {
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, attachments, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			message.id,
			message.role,
			message.content,
			JSON.stringify(message.attachments),
			message.runId,
			message.createdAt,
		);
	}

	messages(): MessageOut[] {
		return this.#sql
			.exec<MessageRow>("SELECT * FROM messages ORDER BY created_at, id")
			.toArray()
			.map((row) => messageOut(row));
	}

	/** The user message that started a run. */
	runMessage(runId: RunId): MessageOut | null {
		const row = this.#sql.exec<MessageRow>("SELECT * FROM messages WHERE run_id = ? AND role = 'user' ORDER BY created_at, id LIMIT 1", runId).toArray()[0];
		return row ? messageOut(row) : null;
	}

	message(id: string): MessageOut | null {
		const row = this.#sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
		return row ? messageOut(row) : null;
	}

	/**
	 * What history replay reads for a run (history.ts): its own user message and the newest `limit` others,
	 * with each assistant message's folder changes; not the whole conversation.
	 */
	storedMessages(runId: RunId, limit: number): StoredMessage[] {
		const select = "SELECT m.*, r.folder_changes AS folder_changes FROM messages m LEFT JOIN runs r ON r.id = m.run_id";
		const own = this.#sql.exec<MessageRow & { folder_changes: string | null }>(`${select} WHERE m.run_id = ? AND m.role = 'user'`, runId).toArray();
		const others = this.#sql
			.exec<MessageRow & { folder_changes: string | null }>(
				`${select} WHERE NOT (m.run_id IS ? AND m.role = 'user') ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
				runId,
				limit,
			)
			.toArray();
		return [...own, ...others].map((row) => ({
			id: row.id,
			role: row.role,
			content: row.content,
			attachments: parseJson(row.attachments) as unknown as AttachmentOut[],
			runId: row.run_id,
			createdAt: row.created_at,
			changes: row.role === "assistant" && row.folder_changes ? (parseJson(row.folder_changes) as unknown as FolderChangesOut) : null,
		}));
	}

	// Runs.

	/**
	 * The run with its snapshot: in `runs.snapshot` when it fits in one value, else in `run_snapshots`'
	 * parts with the column empty. A snapshot holds every grant of the user, so it can pass the 2 MB a
	 * string or a row may have without any API limit being broken.
	 */
	insertRun(run: { id: RunId; snapshot: RunSnapshot; deadline: EpochMs | null; baseVersionId: VersionId | null; createdAt: EpochMs }): void {
		const parts = splitParts(JSON.stringify(run.snapshot), VALUE_PART);
		this.#sql.exec(
			"INSERT INTO runs (id, status, attempt, attempt_started_at, snapshot, deadline, base_version_id, created_at) VALUES (?, 'queued', 1, ?, ?, ?, ?, ?)",
			run.id,
			run.createdAt,
			parts.length === 1 ? (parts[0] as string) : "",
			run.deadline,
			run.baseVersionId,
			run.createdAt,
		);
		if (parts.length > 1) parts.forEach((text, part) => this.#sql.exec("INSERT INTO run_snapshots (run_id, part, text) VALUES (?, ?, ?)", run.id, part, text));
		this.#sql.exec("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, 1, ?)", run.id, run.createdAt);
	}

	run(id: RunId): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id).toArray()[0] ?? null;
	}

	/** At most one run is queued, provisioning or running (runs 1.1). */
	activeRun(): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ${ACTIVE_SQL} ORDER BY created_at DESC LIMIT 1`).toArray()[0] ?? null;
	}

	runBySession(session: string): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE session = ?`, session).toArray()[0] ?? null;
	}

	runByProviderSession(providerSession: string): RunRow | null {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE provider_session = ?`, providerSession).toArray()[0] ?? null;
	}

	/** Every pi session a run owns, with whether the run is still active. */
	sessions(): Map<string, boolean> {
		const rows = this.#sql.exec<{ session: string; status: RunStatus }>("SELECT session, status FROM runs WHERE session IS NOT NULL").toArray();
		return new Map(rows.map((row) => [row.session, ACTIVE.has(row.status)]));
	}

	runs(): RunRow[] {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at, id`).toArray();
	}

	/** Terminal runs whose end the Workspace has not heard yet. */
	unreleased(): RunRow[] {
		return this.#sql.exec<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE released = 0 AND status NOT IN ${ACTIVE_SQL}`).toArray();
	}

	snapshot(run: Pick<RunRow, "id">): RunSnapshot {
		const whole = this.#sql.exec<{ snapshot: string }>("SELECT snapshot FROM runs WHERE id = ?", run.id).toArray()[0]?.snapshot ?? "";
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

	update(runId: RunId, fields: Partial<Pick<RunRow, "session" | "provider_session" | "activated" | "released" | "checkpoint_version_id" | "uploaded_bytes">>): void {
		const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
		if (!entries.length) return;
		this.#sql.exec(`UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, value]) => value), runId);
	}

	/** Sets the session once; another one already set wins and is returned. */
	claimSession(runId: RunId, session: string, providerSession: string | null): string | null {
		this.#sql.exec("UPDATE runs SET session = ?, provider_session = ? WHERE id = ? AND session IS NULL", session, providerSession, runId);
		return this.run(runId)?.session ?? null;
	}

	/** The revoked flag the executor checks before every provider request (plan: Strict revocation). */
	revoke(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET revoked = 1 WHERE id = ?", runId);
	}

	setWritesUncertain(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET writes_uncertain = 1 WHERE id = ?", runId);
	}

	/** queued → provisioning, with `{status: "provisioning"}` (no attempt): the Workspace activated the run. */
	activate(runId: RunId): boolean {
		return this.write(() => {
			const changed = this.#sql.exec("UPDATE runs SET activated = 1, status = 'provisioning' WHERE id = ? AND status = 'queued' RETURNING id", runId).toArray();
			if (!changed.length) {
				this.#sql.exec("UPDATE runs SET activated = 1 WHERE id = ?", runId);
				return false;
			}
			this.append(runId, statusEvent({ status: "provisioning" }));
			return true;
		});
	}

	/** provisioning → running, once per attempt, keeping the run's first start time (runs 2.1). */
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

	/** The gate's new attempt: attempt + 1 and the restart marker, the deadline unchanged (runs 2.4). */
	restart(runId: RunId, attempt: number): void {
		const now = this.now();
		this.#sql.exec("UPDATE runs SET attempt = ?, attempt_started_at = ?, status = 'provisioning' WHERE id = ?", attempt, now, runId);
		this.#sql.exec("UPDATE attempts SET ended_at = ?, ended = 'restarted' WHERE run_id = ? AND attempt = ?", now, runId, attempt - 1);
		this.#sql.exec("INSERT INTO attempts (run_id, attempt, started_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", runId, attempt, now);
		this.append(runId, statusEvent({ status: "provisioning", attempt }));
	}

	/**
	 * The one way a run ends, once, from an active state (runs 2.2): status, code, message cut to 500, the
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
			this.#ended.push(runId);
			return true;
		});
	}

	// Usage (runs 7.6).

	/** Counts a tool call if the fence is current; false means RUN_ENDED, not counted. */
	countToolCall(fence: AttemptFence): boolean {
		if (!this.isCurrent(fence)) return false;
		this.#sql.exec("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?", fence.runId);
		return true;
	}

	countModelCall(runId: RunId): void {
		this.#sql.exec("UPDATE runs SET model_calls = model_calls + 1 WHERE id = ?", runId);
	}

	/** Not fenced: the last usage report of a settled call, or one unmetered call. */
	settleModelCall(runId: RunId, usage: { input: number; output: number } | null): void {
		if (usage) this.#sql.exec("UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?", usage.input, usage.output, runId);
		else this.#sql.exec("UPDATE runs SET unmetered_model_calls = unmetered_model_calls + 1 WHERE id = ?", runId);
	}

	/** How often pi has executed this call, this execution included (the replay cap, plan: Attempts and recovery). */
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

	// Events (runs 6.1).

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
			return stored;
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

	// The start protocol (plan: Starting a run).

	addStart(start: { runId: RunId; userId: UserId; content: string; uploadIds: string[]; createdAt: EpochMs }): void {
		this.#sql.exec(
			"INSERT INTO starts (run_id, user_id, content, upload_ids, created_at) VALUES (?, ?, ?, ?, ?)",
			start.runId,
			start.userId,
			start.content,
			JSON.stringify(start.uploadIds),
			start.createdAt,
		);
	}

	starts(): StartRow[] {
		return this.#sql.exec<StartRow>("SELECT * FROM starts ORDER BY created_at").toArray();
	}

	start(runId: RunId): StartRow | null {
		return this.#sql.exec<StartRow>("SELECT * FROM starts WHERE run_id = ?", runId).toArray()[0] ?? null;
	}

	deleteStart(runId: RunId): void {
		this.#sql.exec("DELETE FROM starts WHERE run_id = ?", runId);
	}

	/** A client's key for a start (`postMessage`): the run it named, if it is younger than `since`. */
	startKey(key: string, since: EpochMs): { run_id: string; digest: string } | null {
		this.#sql.exec("DELETE FROM start_keys WHERE created_at < ?", since);
		return this.#sql.exec<{ run_id: string; digest: string }>("SELECT run_id, digest FROM start_keys WHERE key = ?", key).toArray()[0] ?? null;
	}

	addStartKey(key: string, runId: RunId, digest: string): void {
		this.#sql.exec("INSERT INTO start_keys (key, run_id, digest, created_at) VALUES (?, ?, ?, ?)", key, runId, digest, this.now());
	}

	/** A refused start's key: the same message may be sent again with it. */
	deleteStartKeys(runId: RunId): void {
		this.#sql.exec("DELETE FROM start_keys WHERE run_id = ?", runId);
	}

	/** A start refused after `beginRun` registered it: the Workspace must hear of it, until it has. */
	addRelease(runId: RunId): void {
		this.#sql.exec("INSERT INTO releases (run_id, status, created_at) VALUES (?, 'refused', ?) ON CONFLICT DO NOTHING", runId, this.now());
	}

	releases(): RunId[] {
		return this.#sql
			.exec<{ run_id: string }>("SELECT run_id FROM releases ORDER BY created_at")
			.toArray()
			.map((row) => row.run_id);
	}

	deleteRelease(runId: RunId): void {
		this.#sql.exec("DELETE FROM releases WHERE run_id = ?", runId);
	}

	tombstone(runId: RunId): TombstoneRow | null {
		return this.#sql.exec<TombstoneRow>("SELECT * FROM tombstones WHERE run_id = ?", runId).toArray()[0] ?? null;
	}

	addTombstone(runId: RunId, reason: CancelReason, entryId: number): void {
		this.#sql.exec("INSERT INTO tombstones (run_id, reason, entry_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", runId, reason, entryId, this.now());
	}

	// The API's shapes.

	runHead(row: RunRow): RunHead {
		return {
			id: row.id,
			status: row.status,
			error_message: row.error_message,
			created_at: isoTime(row.created_at),
			finished_at: row.finished_at === null ? null : isoTime(row.finished_at),
			base_version_id: row.base_version_id,
			result_version_id: row.result_version_id,
			folder_changes: row.folder_changes === null ? null : (parseJson(row.folder_changes) as unknown as FolderChangesOut),
			folder_warnings: row.folder_warnings === null ? null : (parseJson(row.folder_warnings) as unknown as FolderWarningsOut),
			eventSeq: row.event_seq,
		};
	}

	conversationHead(row: ConversationRow): ConversationHead {
		return {
			id: row.id,
			agent_id: row.agent_id,
			title: row.title,
			updated_at: isoTime(row.updated_at),
			messages: this.messages(),
			runs: this.runs().map((run) => this.runHead(run)),
		};
	}
}

function messageOut(row: MessageRow): MessageOut {
	return {
		id: row.id,
		role: row.role,
		content: row.content,
		attachments: parseJson(row.attachments) as unknown as AttachmentOut[],
		run_id: row.run_id,
		created_at: isoTime(row.created_at),
	};
}

/** For tests and logs. */
export function eventData(event: RunEvent): Json {
	return event.data as unknown as Json;
}
