// Fault injection for the test build (src/faults/): a plan of faults kept in the Durable Object's own
// SQLite, so it survives the crashes it causes, and fired at named points in the object's ports. A fault
// fires `times` times (once by default); firing records it, commits, waits for the write to be durable,
// then acts (an `unsynced` one does neither, below):
//
// - `abort`: `ctx.abort()`, the platform's reset of the object (what a crash, a deploy's reset or an
//   eviction mid-turn looks like to the next instance);
// - `oom`: allocates until the isolate passes its memory limit and is reset, which takes every object in
//   the isolate with it;
// - `throw`: the point throws;
// - `lose`: the point tells its caller to lose the answer (a provider that applied a write whose response
//   never arrives);
// - `hold`: waits until a test releases it (`FaultPlan.release`, over the object's RPC), polling its own
//   SQLite: a promise made in one object's context cannot be settled from another's;
// - `note`: only records that the point was reached.
//
// An `unsynced` fault crashes without first making anything durable, so the crash also loses every write
// the object has not synced, its own count included: its count is kept in the isolate's memory instead,
// which a `ctx.abort()` leaves (a memory reset does not, so there it fires again in the next isolate).
//
// Never part of the production Worker: only src/faults/index.ts and the tests import this.

export type FaultMode = "abort" | "oom" | "throw" | "lose" | "hold" | "note";

export interface Fault {
	point: string;
	mode: FaultMode;
	/** How many times it fires; default 1. */
	times?: number;
	/** Only for this tool (tool points) or this model step and delta (model points). */
	tool?: string;
	step?: number;
	delta?: number;
	/** Crash (`abort` or `oom`) without syncing first; counted in memory. */
	unsynced?: boolean;
}

export interface Fired {
	point: string;
	mode: FaultMode;
	at: number;
	detail: string;
}

/** Where a point is reached: its filters' values, and what the log keeps of it. */
export interface Where {
	tool?: string;
	step?: number;
	delta?: number;
	detail?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fault_plan (
	id INTEGER PRIMARY KEY,
	point TEXT NOT NULL,
	mode TEXT NOT NULL,
	remaining INTEGER NOT NULL,
	tool TEXT,
	step INTEGER,
	delta INTEGER,
	unsynced INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS fault_log (
	seq INTEGER PRIMARY KEY,
	point TEXT NOT NULL,
	mode TEXT NOT NULL,
	at INTEGER NOT NULL,
	detail TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fault_config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fault_ballast (
	id INTEGER PRIMARY KEY,
	data BLOB NOT NULL,
	writes INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fault_entered (
	run_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (run_id, kind)
) STRICT;
`;

/** Grows memory until the isolate is reset for passing its limit. */
function exhaustMemory(): never {
	const kept: Uint8Array[] = [];
	for (;;) {
		const chunk = new Uint8Array(16 * 1024 * 1024);
		chunk.fill(1);
		kept.push(chunk);
	}
}

export class FaultPlan {
	readonly #ctx: DurableObjectState;
	#ready = false;

	constructor(ctx: DurableObjectState) {
		this.#ctx = ctx;
	}

	#sql(): SqlStorage {
		if (!this.#ready) {
			const sql = this.#ctx.storage.sql;
			sql.exec(SCHEMA);
			// A plan table from before `unsynced` (CREATE TABLE IF NOT EXISTS leaves it as it was).
			if (!sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('fault_plan')").toArray().some((column) => column.name === "unsynced")) {
				sql.exec("ALTER TABLE fault_plan ADD COLUMN unsynced INTEGER NOT NULL DEFAULT 0");
			}
			this.#ready = true;
		}
		return this.#ctx.storage.sql;
	}

	/** Replaces the plan. */
	set(faults: readonly Fault[]): void {
		const sql = this.#sql();
		if (faults.some((fault) => fault.unsynced && fault.mode !== "abort" && fault.mode !== "oom")) throw new Error("fault: only a crash can be unsynced.");
		const object = `${this.#ctx.id.toString()}:`;
		for (const key of [...unsyncedLeft.keys()]) if (key.startsWith(object)) unsyncedLeft.delete(key);
		this.#ctx.storage.transactionSync(() => {
			sql.exec("DELETE FROM fault_plan");
			for (const fault of faults) {
				sql.exec(
					"INSERT INTO fault_plan (point, mode, remaining, tool, step, delta, unsynced) VALUES (?, ?, ?, ?, ?, ?, ?)",
					fault.point,
					fault.mode,
					fault.times ?? 1,
					fault.tool ?? null,
					fault.step ?? null,
					fault.delta ?? null,
					fault.unsynced ? 1 : 0,
				);
			}
		});
	}

	fired(): Fired[] {
		return this.#sql().exec<{ point: string; mode: FaultMode; at: number; detail: string }>("SELECT point, mode, at, detail FROM fault_log ORDER BY seq").toArray();
	}

	config(key: string): string | null {
		return this.#sql().exec<{ value: string }>("SELECT value FROM fault_config WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	setConfig(key: string, value: string | null): void {
		const sql = this.#sql();
		if (value === null) sql.exec("DELETE FROM fault_config WHERE key = ?", key);
		else sql.exec("INSERT INTO fault_config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	/** Counts a model call or a tool execution pi started for a run (ConversationPorts.entered). */
	enter(runId: string, kind: "model" | "tool"): void {
		this.#sql().exec("INSERT INTO fault_entered (run_id, kind, count) VALUES (?, ?, 1) ON CONFLICT (run_id, kind) DO UPDATE SET count = count + 1", runId, kind);
	}

	entered(runId: string): { model: number; tool: number } {
		const rows = this.#sql().exec<{ kind: "model" | "tool"; count: number }>("SELECT kind, count FROM fault_entered WHERE run_id = ?", runId).toArray();
		return { model: rows.find((row) => row.kind === "model")?.count ?? 0, tool: rows.find((row) => row.kind === "tool")?.count ?? 0 };
	}

	/**
	 * The perf probe's calibration: `bytes` of random data written over the last ballast, so each write is a new one, or with
	 * `write` false only generated, the control that costs the same CPU and writes nothing.
	 */
	ballast(bytes: number, write: boolean): void {
		const sql = this.#sql();
		if (!write) sql.exec("SELECT length(randomblob(?))", bytes).toArray();
		else sql.exec("INSERT INTO fault_ballast (id, data, writes) VALUES (1, randomblob(?), 1) ON CONFLICT (id) DO UPDATE SET data = excluded.data, writes = writes + 1", bytes);
	}

	/** Lets every object waiting at `point` go on, and every later arrival pass. */
	release(point: string): void {
		this.setConfig(`released:${point}`, "1");
	}

	/**
	 * The fault due at this point, taken (counted down and logged) in one transaction; null when none is due.
	 * An unsynced fault is counted in memory and not logged: its count must not depend on SQLite.
	 */
	#take(point: string, where: Where, only: readonly FaultMode[] | undefined): { mode: FaultMode; unsynced: boolean } | null {
		const sql = this.#sql();
		const rows = sql
			.exec<{ id: number; mode: FaultMode; remaining: number; unsynced: number }>(
				`SELECT id, mode, remaining, unsynced FROM fault_plan WHERE point = ? AND remaining > 0
					AND (tool IS NULL OR tool = ?) AND (step IS NULL OR step = ?) AND (delta IS NULL OR delta = ?)
				ORDER BY id`,
				point,
				where.tool ?? null,
				where.step ?? null,
				where.delta ?? null,
			)
			.toArray();
		for (const row of rows) {
			if (only && !only.includes(row.mode)) throw new Error(`fault: ${point} takes ${only.join(" or ")}, not ${row.mode}`);
			if (row.unsynced) {
				const key = `${this.#ctx.id.toString()}:${row.id}`;
				const left = unsyncedLeft.get(key) ?? row.remaining;
				if (left <= 0) continue;
				unsyncedLeft.set(key, left - 1);
				return { mode: row.mode, unsynced: true };
			}
			this.#ctx.storage.transactionSync(() => {
				sql.exec("UPDATE fault_plan SET remaining = remaining - 1 WHERE id = ?", row.id);
				sql.exec("INSERT INTO fault_log (point, mode, at, detail) VALUES (?, ?, ?, ?)", point, row.mode, Date.now(), where.detail ?? where.tool ?? "");
			});
			return { mode: row.mode, unsynced: false };
		}
		return null;
	}

	/**
	 * Fires the fault due at `point`, if any. Returns `lose` for a `lose` fault (the caller loses its answer)
	 * and null otherwise; `abort`, `oom` and `throw` do not return. `only` limits the modes a point takes.
	 */
	async at(point: string, where: Where = {}, only?: readonly FaultMode[]): Promise<"lose" | null> {
		const taken = this.#take(point, where, only);
		if (taken === null) return null;
		const { mode } = taken;
		if (taken.unsynced) {
			if (mode === "oom") exhaustMemory();
			this.#ctx.abort(`fault: ${point}`);
			throw new Error(`fault: ${point} aborted the object`);
		}
		if (mode === "note") return null;
		// The count must outlive the reset it causes.
		await this.#ctx.storage.sync();
		if (mode === "abort") {
			this.#ctx.abort(`fault: ${point}`);
			throw new Error(`fault: ${point} aborted the object`);
		}
		if (mode === "oom") exhaustMemory();
		if (mode === "throw") throw new Error(`fault: ${point}`);
		if (mode === "hold") {
			while (this.config(`released:${point}`) === null) await new Promise((resolve) => setTimeout(resolve, 20));
			return null;
		}
		return "lose";
	}
}

const plans = new WeakMap<DurableObjectState, FaultPlan>();
/** What is left of each unsynced fault, by object and plan row: in the isolate, not in SQLite. */
const unsyncedLeft = new Map<string, number>();

/** The plan of the object `ctx` belongs to. */
export function planOf(ctx: DurableObjectState): FaultPlan {
	let plan = plans.get(ctx);
	if (!plan) plans.set(ctx, (plan = new FaultPlan(ctx)));
	return plan;
}
