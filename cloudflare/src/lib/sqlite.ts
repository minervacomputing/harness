// Schema steps for a Durable Object's SQLite storage. Two versions of the code run side by side after a
// deploy (a busy object keeps its old code; new objects may start on the previous version), so steps are
// additive only, never edited once deployed, and code accepts rows the previous and the next version write
// (plan: Spike results, Versions). A step this code does not know, applied by a newer version, is left as is.

export interface Migration {
	/** Ascending and unique; never reused. */
	id: number;
	/** One or more statements without bindings. */
	sql: string;
}

/** Applies the steps not yet applied, each in its own transaction. Returns the ids it applied. */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[]): number[] {
	const sql = storage.sql;
	sql.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
	const applied = new Set(sql.exec<{ id: number }>("SELECT id FROM _migrations").toArray().map((row) => row.id));
	const done: number[] = [];
	for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
		if (applied.has(migration.id)) continue;
		storage.transactionSync(() => {
			sql.exec(migration.sql);
			sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", migration.id, Date.now());
		});
		done.push(migration.id);
	}
	return done;
}

/** The ids of the steps applied so far, ascending. */
export function appliedMigrations(storage: DurableObjectStorage): number[] {
	return storage.sql
		.exec<{ id: number }>("SELECT id FROM _migrations ORDER BY id")
		.toArray()
		.map((row) => row.id);
}
