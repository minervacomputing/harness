// Real SQLite for unit tests: node:sqlite through lib/sql.ts's adapter, for the ledger, page tokens and the
// folder. The module is loaded with `process.getBuiltinModule`, since the unit tests are
// type-checked with the Worker's runtime types, which lack Node's.

import { HOLD_SCHEMA, LEDGER_NOTES_SCHEMA, LEDGER_SCHEMA } from "../../src/gateway/ledger.ts";
import { PAGE_TOKEN_SCHEMA } from "../../src/gateway/page-tokens.ts";
import { type Sql, type SqlValue, type SyncDatabase, applySchema, sqliteSql } from "../../src/lib/sql.ts";

interface Database extends SyncDatabase {
	close(): void;
}

interface NodeProcess {
	getBuiltinModule(id: "node:sqlite"): { DatabaseSync: new (path: string) => Database };
	getBuiltinModule(id: "node:fs"): { mkdtempSync(prefix: string): string; rmSync(path: string, options: { recursive: boolean; force: boolean }): void };
	getBuiltinModule(id: "node:os"): { tmpdir(): string };
}

const node = (globalThis as unknown as { process: NodeProcess }).process;

export function openDatabase(path = ":memory:"): Database {
	return new (node.getBuiltinModule("node:sqlite").DatabaseSync)(path);
}

/** The ledger's, its holds' and page tokens' tables, made if missing: a database reopened after a crash keeps its own. */
export function ledgerSql(db: Database = openDatabase()): Sql {
	const sql = sqliteSql(db);
	applySchema(sql, [...LEDGER_SCHEMA, ...PAGE_TOKEN_SCHEMA, ...HOLD_SCHEMA]);
	// The ledger's later columns, which (as ALTERs) cannot be made "if not exists".
	if (!sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('run_writes')").some((column) => column.name === "tool")) applySchema(sql, LEDGER_NOTES_SCHEMA);
	return sql;
}

/** A directory for a database file that outlives one connection, removed by `done()`. */
export function scratchDirectory(): { path: string; done(): void } {
	const fs = node.getBuiltinModule("node:fs");
	const path = fs.mkdtempSync(`${node.getBuiltinModule("node:os").tmpdir()}/minerva-ledger-`);
	return { path, done: () => fs.rmSync(path, { recursive: true, force: true }) };
}

/**
 * A Durable Object's storage over node:sqlite, as far as the Conversation's store and PiHarness's session store use it:
 * `sql.exec` with bindings, its cursor's `toArray`, `one` and `next`, `transactionSync`, and `transaction`, which holds a
 * transaction open across its callback's awaits (PiHarness's queue keeps every other statement out of it meanwhile).
 */
export function durableStorage(db: Database = openDatabase()): DurableObjectStorage {
	let depth = 0;
	const sql = {
		exec(query: string, ...bindings: SqlStorageValue[]) {
			const values = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
			const rows = db.prepare(query).all(...(values as SqlValue[]));
			let at = 0;
			return {
				toArray: () => rows,
				one: () => {
					if (rows.length !== 1) throw new Error(`Expected exactly one row, not ${rows.length}.`);
					return rows[0];
				},
				next: () => (at < rows.length ? { done: false, value: rows[at++] } : { done: true, value: undefined }),
			};
		},
	};
	const transaction = async <T>(change: () => Promise<T>): Promise<T> => {
		db.exec("BEGIN");
		try {
			const result = await change();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	const transactionSync = <T>(change: () => T): T => {
		const savepoint = `s${depth++}`;
		db.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = change();
			db.exec(`RELEASE ${savepoint}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO ${savepoint}`);
			db.exec(`RELEASE ${savepoint}`);
			throw error;
		} finally {
			depth--;
		}
	};
	return { sql, transactionSync, transaction } as unknown as DurableObjectStorage;
}
