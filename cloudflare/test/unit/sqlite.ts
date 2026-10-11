// Real SQLite for unit tests: node:sqlite through lib/sql.ts's adapter, for the ledger, page tokens and the
// Workspace's core. The module is loaded with `process.getBuiltinModule`, since the unit tests are
// type-checked with the Worker's runtime types, which lack Node's.

import { LEDGER_SCHEMA } from "../../src/gateway/ledger.ts";
import { PAGE_TOKEN_SCHEMA } from "../../src/gateway/page-tokens.ts";
import { type Sql, type SyncDatabase, applySchema, sqliteSql } from "../../src/lib/sql.ts";

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

/** The ledger's and page tokens' tables in a fresh database. */
export function ledgerSql(db: Database = openDatabase()): Sql {
	const sql = sqliteSql(db);
	applySchema(sql, [...LEDGER_SCHEMA, ...PAGE_TOKEN_SCHEMA]);
	return sql;
}

/** A directory for a database file that outlives one connection, removed by `done()`. */
export function scratchDirectory(): { path: string; done(): void } {
	const fs = node.getBuiltinModule("node:fs");
	const path = fs.mkdtempSync(`${node.getBuiltinModule("node:os").tmpdir()}/minerva-ledger-`);
	return { path, done: () => fs.rmSync(path, { recursive: true, force: true }) };
}
