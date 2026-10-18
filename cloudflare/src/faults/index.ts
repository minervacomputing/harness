// The test build's Worker (cloudflare.config.ts, modes `faults` and `test`): the same Worker as src/index.ts, plus the fake
// Notes connector and its provider (connector.ts, provider.ts), which also hosts the fake Laravel the engine calls
// (laravel.ts, settings.ts), fault points in the Conversation's ports (ports.ts, plan.ts), and a
// token-gated driver at /api/faults/ for the account tests (routes.ts). It is deployed only as a test instance; the
// production build's entry is src/index.ts, which imports nothing from here (a unit test checks it), so none of this is in
// production.

import type { RunEvent } from "@minerva/contract";
import { createLocalJWKSet } from "jose";
import worker from "../index.ts";
import { PRICE_SOURCE } from "../budget/prices.ts";
import { CONNECTOR_SOURCE, servedConnectors } from "../connectors/index.ts";
import { Conversation as BaseConversation } from "../conversation/conversation.ts";
import { defaultPorts, PORTS } from "../conversation/ports.ts";
import { RETAIN_JOB, RETENTION, type RetentionPeriods } from "../conversation/retention.ts";
import { PAGE_LIMIT, type RunHead, RunStore } from "../conversation/store.ts";
import type { RunId } from "../shared/rpc.ts";
import { ACCESS_KEYS } from "../internal/access.ts";
import { PROVIDER_NETWORK } from "../internal/providers.ts";
import { LARAVEL_NETWORK } from "../laravel/client.ts";
import { notesConnector } from "./connector.ts";
import { hostedToken } from "./laravel.ts";
import { type Fault, type Fired, planOf } from "./plan.ts";
import { type CallMarks, type Calibration, executorContextOf, faultConversationPorts, laravelFetch, marksOf, providerFetch } from "./ports.ts";
import { faultPriceTable } from "./prices.ts";
import { faultRoutes } from "./routes.ts";
import { FAULTS_SETTINGS } from "./settings.ts";

CONNECTOR_SOURCE.connectors = async () => [...(await servedConnectors()), notesConnector()];
PORTS.factory = () => faultConversationPorts(defaultPorts);
// The fake model is charged too, and time at round numbers (prices.ts).
PRICE_SOURCE.table = faultPriceTable;
// The settings calls' provider requests (src/internal/providers.ts) reach the fake provider too, and nothing else.
PROVIDER_NETWORK.fetch = (env, workspace) => providerFetch(env, workspace.id);
// The default Access issuer is a placeholder (settings.ts): its keys are never fetched, so every assertion is refused.
const accessKeys = ACCESS_KEYS.of;
ACCESS_KEYS.of = (issuer) => (issuer === FAULTS_SETTINGS.MINERVA_ACCESS_ISSUER ? createLocalJWKSet({ keys: [] }) : accessKeys(issuer));
// Laravel is the fake each workspace's FaultProvider hosts (laravel.ts), reached with a token it checks.
LARAVEL_NETWORK.fetch = laravelFetch;
LARAVEL_NETWORK.token = hostedToken;

/** A reset the object asked for (`ctx.abort()`): the engine's or a fault's. */
export interface Abort {
	at: number;
	reason: string;
}

/**
 * Each object's resets asked for by its instances in this isolate, by the object's id. Kept in the isolate, which a reset
 * leaves, as plan.ts keeps its unsynced counts; the platform's own replacement of an instance asks for none.
 */
const aborts = new Map<string, Abort[]>();

/** What a test reads of a run besides its API view: attempts, the ledger and pi's executions. */
export interface RunInternals {
	run: { [column: string]: SqlStorageValue } | null;
	attempts: { attempt: number; ended: string | null }[];
	/** Each counted model call's attempt and the instance that made it (store.ts `RunStore.instance`), in the order they were made. */
	calls: { attempt: number; instance: string }[];
	writes: { key: string; status: string; attempt: number }[];
	executions: { call_id: string; executions: number }[];
	/** The tools the run's snapshot offers. */
	tools: string[];
	/** The model calls and tool executions pi started for the run, counted before any check. */
	entered: { model: number; tool: number };
	/** Each model call's marks, as this instance took them (ports.ts, `CallMarks`). */
	marks: CallMarks[];
	/**
	 * The tasks of the run's pi session in id order, none before it has one: whether pi marked each for abort, and pi's own
	 * `Date.now()` stamps of its first change to `running` and of its end, null until then.
	 */
	piTasks: { id: number; kind: string; status: string; abortRequested: boolean; startedAt: number | null; endedAt: number | null }[];
}

/**
 * A run as a test reads it: its head (null before it is stored), its internals, the points that fired, the resets its object
 * asked for, and one page of its events, bounded as RunStore's pages are, so no answer nears Workers RPC's limit.
 */
export interface RunView {
	head: RunHead | null;
	events: RunEvent[];
	internals: RunInternals;
	fired: Fired[];
	aborts: Abort[];
}

/** An object's storage: its size, each table's rows and the bytes of its TEXT and BLOB columns, and its alarm. */
export interface StorageView {
	databaseSize: number;
	tables: { [table: string]: { rows: number; bytes: number } };
	alarm: number | null;
}

/**
 * A plan's periods: each a finite number of milliseconds, none negative, and at least 2 rows a step, since pi's deletion takes
 * a record with its `pi_record_ids` row and a step of 1 would delete nothing.
 */
function checkPeriods(periods: Partial<RetentionPeriods>): void {
	for (const [name, value] of Object.entries(periods)) {
		if (!(name in RETENTION) || typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`fault: retention's ${name} is not a period.`);
	}
	if (periods.rowsPerStep !== undefined && (!Number.isInteger(periods.rowsPerStep) || periods.rowsPerStep < 2)) throw new Error("fault: retention's rowsPerStep is a whole number, at least 2.");
}

/** The Conversation with a fault plan, a record of the resets it asks for and a view of its tables for the tests. */
export class Conversation extends BaseConversation {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const abort = ctx.abort.bind(ctx);
		ctx.abort = (reason?: string) => {
			const id = ctx.id.toString();
			aborts.set(id, [...(aborts.get(id) ?? []), { at: Date.now(), reason: reason ?? "" }]);
			abort(reason);
		};
	}

	faultPlan(
		faults: Fault[],
		config: { model?: string | null; runTimeoutMs?: number | null; calibrate?: Calibration | null; retention?: Partial<RetentionPeriods> | null } = {},
	): void {
		const plan = planOf(this.ctx);
		plan.set(faults);
		if (config.model !== undefined) plan.setConfig("model", config.model);
		if (config.calibrate !== undefined) plan.setConfig("calibrate", config.calibrate === null ? null : JSON.stringify(config.calibrate));
		if (config.runTimeoutMs !== undefined) plan.setConfig("run_timeout_ms", config.runTimeoutMs === null ? null : String(config.runTimeoutMs));
		if (config.retention) checkPeriods(config.retention);
		if (config.retention !== undefined) plan.setConfig("retention", config.retention === null ? null : JSON.stringify(config.retention));
	}

	/**
	 * The perf probe's start of retention (docs/plans/chunk-15a-design.md, Perf probe and rule): the plan's faults and periods
	 * replaced, and the `retain` job made due now.
	 */
	async faultRetainNow(faults: Fault[], retention: Partial<RetentionPeriods>): Promise<void> {
		this.faultPlan(faults, { retention });
		await this.lifecycle.jobs.push({ id: RETAIN_JOB, fn: RETAIN_JOB, time: Date.now() });
	}

	faultFired(): Fired[] {
		return planOf(this.ctx).fired();
	}

	faultRelease(point: string): void {
		planOf(this.ctx).release(point);
	}

	/**
	 * A late call from `attempt`, through the ports this object built for the run's executor (its own
	 * RunStatePort and CredentialPort): a write claim, a tool call's count and a credential lease.
	 */
	async faultLateCall(runId: RunId, attempt: number, connectionId: string): Promise<{ dispatch: unknown; counted: boolean; lease: unknown }> {
		const run = executorContextOf(this.ctx, runId);
		if (!run) throw new Error("This instance built no executor for the run.");
		const fence = { runId, attempt };
		return { dispatch: await run.run.dispatchWrite(fence, "k".repeat(64)), counted: run.run.countToolCall(fence), lease: await run.credentials.lease(fence, connectionId) };
	}

	/** A credential lease for `attempt`, through the object's own CredentialPort for the run. */
	async faultLease(runId: RunId, attempt: number, connectionId: string): Promise<unknown> {
		const run = executorContextOf(this.ctx, runId);
		if (!run) throw new Error("This instance built no executor for the run.");
		const lease = await run.credentials.lease({ runId, attempt }, connectionId);
		return "refused" in lease ? lease : { connectionId: lease.connectionId, generation: lease.generation };
	}

	/** The object's scheduled host jobs (the Agents SDK's queue), by id. */
	faultJobs(): { id: string; fn: string }[] {
		return this.ctx.storage.sql.exec<{ id: string; fn: string }>("SELECT id, fn FROM cf_agents_jobs ORDER BY id").toArray();
	}

	/**
	 * Appends `count` text deltas of 100 characters to an ended run's events, as a long streamed answer would leave them: the
	 * perf probe's turn of about 10,000 events, which the stream would take about 40 minutes to write (one event per 250 ms flush).
	 */
	faultEvents(runId: RunId, count: number): { eventSeq: number } {
		if (!Number.isInteger(count) || count < 1) throw new Error("fault: count is a whole number of events, at least 1.");
		const sql = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			const { event_seq } = sql.exec<{ event_seq: number }>("SELECT event_seq FROM runs WHERE id = ? AND finished_at IS NOT NULL", runId).one();
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO run_events (run_id, seq, type, data, created_at) SELECT ?, ? + i, 'text_delta', json_object('text', substr(hex(randomblob(50)), 1, 100), 'call', '0000abcd'), 0 FROM n`,
				count,
				runId,
				event_seq,
			);
			sql.exec("UPDATE runs SET event_seq = event_seq + ? WHERE id = ?", count, runId);
		});
		return sql.exec<{ eventSeq: number }>("SELECT event_seq AS eventSeq FROM runs WHERE id = ?", runId).one();
	}

	/** The facts the object holds: how many, the lowest and the highest sequence, and the delivery's watermarks (null before any). */
	faultFacts(): { count: number; lowest: number | null; highest: number | null; delivery: { written: number; acknowledged: number; floor: number } | null } {
		const sql = this.ctx.storage.sql;
		const held = sql.exec<{ count: number; lowest: number | null; highest: number | null }>("SELECT count(*) AS count, min(seq) AS lowest, max(seq) AS highest FROM facts").one();
		const delivery = sql.exec<{ written: number; acknowledged: number; floor: number }>("SELECT written, acknowledged, floor FROM fact_delivery").toArray()[0] ?? null;
		return { ...held, delivery };
	}

	/**
	 * The run with its events after `after`, up to `upTo`: the head's `eventSeq` when null. A reader passes the `eventSeq` of
	 * its first page to the next ones, so the pages it joins end where that head did.
	 */
	faultView(runId: RunId, after = 0, upTo: number | null = null): RunView {
		const store = new RunStore(this.ctx.storage);
		const row = store.run(runId);
		const head = row ? store.runHead(row) : null;
		const events = head ? store.events(runId, { after, upTo: upTo ?? head.eventSeq, limit: PAGE_LIMIT }) : [];
		return { head, events, internals: this.faultRun(runId), fired: this.faultFired(), aborts: aborts.get(this.ctx.id.toString()) ?? [] };
	}

	/**
	 * The object's storage, as the retention probe reads it (docs/plans/chunk-15a-design.md, The measurement): `databaseSize`,
	 * and per table its rows and the summed length in bytes of its TEXT and BLOB columns, by their declared types. The
	 * platform's own `_cf_` tables cannot be read.
	 */
	async faultStorage(): Promise<StorageView> {
		const sql = this.ctx.storage.sql;
		const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND substr(name, 1, 4) != '_cf_' ORDER BY name").toArray();
		const tables: StorageView["tables"] = {};
		for (const { name } of names) {
			const columns = sql
				.exec<{ name: string; type: string }>(`PRAGMA table_info("${name}")`)
				.toArray()
				.filter((column) => /TEXT|BLOB|CHAR|CLOB/i.test(column.type) || column.type === "");
			const bytes = columns.length ? columns.map((column) => `total(length(CAST("${column.name}" AS BLOB)))`).join(" + ") : "0";
			const row = sql.exec<{ rows: number; bytes: number }>(`SELECT count(*) AS rows, ${bytes} AS bytes FROM "${name}"`).one();
			tables[name] = { rows: row.rows, bytes: row.bytes };
		}
		return { databaseSize: sql.databaseSize, tables, alarm: await this.ctx.storage.getAlarm() };
	}

	/**
	 * A table of the test build's own beside the conversation's, to see whether deleted rows give their pages back without
	 * VACUUM: `fill` writes 200 rows of 100,000 random bytes, `trim` deletes nine rows in ten, `drop` drops the table.
	 * Answers `databaseSize` after the step.
	 */
	faultScratch(step: "fill" | "trim" | "drop"): { databaseSize: number } {
		const sql = this.ctx.storage.sql;
		if (step === "fill") {
			sql.exec("CREATE TABLE IF NOT EXISTS fault_scratch (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
			for (let row = 0; row < 200; row++) sql.exec("INSERT INTO fault_scratch (data) VALUES (randomblob(100000))");
		} else if (step === "trim") sql.exec("DELETE FROM fault_scratch WHERE id % 10 != 0");
		else sql.exec("DROP TABLE IF EXISTS fault_scratch");
		return { databaseSize: sql.databaseSize };
	}

	faultRun(runId: RunId): RunInternals {
		const sql = this.ctx.storage.sql;
		const kept = sql.exec("SELECT 1 FROM runs WHERE id = ? AND prune IS NULL", runId).toArray().length > 0;
		const tools = kept ? new RunStore(this.ctx.storage).snapshot({ id: runId }).tools.map((tool) => tool.name) : [];
		// A run without a session has no tasks, and pi's tables exist only once pi was opened. pi's `kind` column holds the kind
		// JSON-encoded, so it is read from the record.
		const session = sql.exec<{ session: string | null }>("SELECT session FROM runs WHERE id = ?", runId).toArray()[0]?.session ?? null;
		const piTasks =
			session === null
				? []
				: sql
						.exec<{ id: number; kind: string; status: string; abortRequested: number; startedAt: number | null; endedAt: number | null }>(
								"SELECT id, json_extract(record, '$.kind') AS kind, status, abort_requested AS abortRequested, json_extract(record, '$.startedAt') AS startedAt, json_extract(record, '$.endedAt') AS endedAt FROM pi_tasks WHERE conversation_id = ? ORDER BY id",
								Number(session),
							)
						.toArray()
						.map((task) => ({ ...task, abortRequested: task.abortRequested === 1 }));
		return {
			tools,
			entered: planOf(this.ctx).entered(runId),
			marks: marksOf(this.ctx, runId),
			piTasks,
			run: sql.exec("SELECT id, status, attempt, error_code, error_message, revoked, activated, writes_uncertain, tool_calls, model_calls, allowance, prune, created_at FROM runs WHERE id = ?", runId).toArray()[0] ?? null,
			attempts: sql.exec<{ attempt: number; ended: string | null }>("SELECT attempt, ended FROM attempts WHERE run_id = ? ORDER BY attempt", runId).toArray(),
			calls: sql.exec<{ attempt: number; instance: string }>("SELECT attempt, instance FROM call_records WHERE run_id = ? ORDER BY attempt, created_at", runId).toArray(),
			writes: sql.exec<{ key: string; status: string; attempt: number }>("SELECT key, status, attempt FROM run_writes WHERE run_id = ? ORDER BY dispatched_at", runId).toArray(),
			executions: sql.exec<{ call_id: string; executions: number }>("SELECT call_id, executions FROM tool_executions WHERE run_id = ? ORDER BY call_id", runId).toArray(),
		};
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return (await faultRoutes(request, env, ctx)) ?? worker.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { FaultProvider } from "./provider.ts";
// The Sandbox with the fault seams of the Sandbox row of ARCHITECTURE.md's Testing table (sandbox.ts), under production's export name.
export { FaultSandbox as Sandbox } from "./sandbox.ts";
export { Scripts } from "../scripts/scripts.ts";
