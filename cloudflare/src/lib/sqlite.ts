// Schema steps for a Durable Object's SQLite storage. Two versions of the code run side by side after a
// deploy (a busy object keeps its old code; new objects may start on the previous version), so steps are
// additive only, never edited once deployed, and code accepts rows the previous and the next version write
// (ARCHITECTURE.md: Spike results, Versions). A step this code does not know, applied by a newer version, is left as is.

import { durableSql, migrate as migrateSql } from "./sql.ts";

export interface Migration {
	/** Ascending and unique; never reused. */
	id: number;
	/** One or more statements without bindings. */
	sql: string;
}

/** Applies the steps not yet applied, each in its own transaction. Returns the ids it applied (lib/sql.ts). */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[]): number[] {
	return migrateSql(durableSql(storage), migrations, Date.now());
}

/** The ids of the steps applied so far, ascending. */
export function appliedMigrations(storage: DurableObjectStorage): number[] {
	return storage.sql
		.exec<{ id: number }>("SELECT id FROM _migrations ORDER BY id")
		.toArray()
		.map((row) => row.id);
}
