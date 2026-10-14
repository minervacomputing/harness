// The SQL every Durable Object's logic runs on (the Workspace's core, the write ledger and page tokens):
// one statement at a time with bindings and its rows, schema scripts, and synchronous transactions. Two
// adapters: a Durable Object's `ctx.storage.sql` with `transactionSync`, and node:sqlite's `DatabaseSync`
// for unit tests, so the same code is tested on real SQLite. Everything is synchronous on purpose: in a
// Durable Object, no other event runs between two statements without an await between them, which is what
// makes the checks and the claims they decide atomic (ARCHITECTURE.md: Starting a run, Writes).
//
// A statement that changes rows says which with RETURNING, rather than through a count: a Durable
// Object's `rowsWritten` counts index writes too.

export type SqlValue = string | number | null;
export type SqlRow = { [column: string]: SqlValue };

export interface Sql {
	/** Runs one statement with `?` bindings and returns its rows (none for a statement without RETURNING). */
	exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): T[];
	/** Runs one or more statements without bindings (schema steps). */
	script(statements: string): void;
	/** Runs `body` in one transaction, rolled back if it throws. Transactions nest. */
	transaction<T>(body: () => T): T;
}

/** The first row, or null. */
export function first<T extends SqlRow>(sql: Sql, query: string, ...bindings: SqlValue[]): T | null {
	return sql.exec<T>(query, ...bindings)[0] ?? null;
}

/** A Durable Object's SQLite storage: `transactionSync` is its only transaction (BEGIN is refused there). */
export function durableSql(storage: DurableObjectStorage): Sql {
	return {
		exec: <T extends SqlRow>(query: string, ...bindings: SqlValue[]): T[] => storage.sql.exec<T>(query, ...bindings).toArray(),
		script: (statements) => {
			storage.sql.exec(statements);
		},
		transaction: <T>(body: () => T): T => storage.transactionSync(body),
	};
}

/**
 * The part of node:sqlite's `DatabaseSync` the adapter uses, so this file needs no Node types (the Worker's
 * code is type-checked with the runtime's alone). Tests open one with `process.getBuiltinModule`.
 */
export interface SyncDatabase {
	exec(sql: string): void;
	prepare(sql: string): { all(...bindings: SqlValue[]): unknown[] };
}

/** node:sqlite, for unit tests. Transactions are savepoints, so they nest as `transactionSync` does. */
export function sqliteSql(db: SyncDatabase): Sql {
	let depth = 0;
	return {
		// node:sqlite's rows have no prototype; plain objects compare as the Durable Object's do.
		exec: <T extends SqlRow>(query: string, ...bindings: SqlValue[]): T[] => db.prepare(query).all(...bindings).map((row) => ({ ...(row as T) })),
		script: (statements) => db.exec(statements),
		transaction<T>(body: () => T): T {
			const name = `minerva_${++depth}`;
			db.exec(`SAVEPOINT ${name}`);
			try {
				const result = body();
				db.exec(`RELEASE ${name}`);
				return result;
			} catch (error) {
				db.exec(`ROLLBACK TO ${name}`);
				db.exec(`RELEASE ${name}`);
				throw error;
			} finally {
				depth--;
			}
		},
	};
}

/** Runs schema statements one at a time (each `exec` takes a single statement). */
export function applySchema(sql: Sql, statements: readonly string[]): void {
	sql.transaction(() => {
		for (const statement of statements) sql.exec(statement);
	});
}

/** lib/sqlite.ts's `Migration`: one or more statements without bindings, applied once. */
export interface SqlMigration {
	id: number;
	sql: string;
}

/**
 * lib/sqlite.ts's `migrate` over this interface, with the same `_migrations` table, so `appliedMigrations`
 * reads every object's steps alike: the steps not applied yet, each in its own transaction.
 */
export function migrate(sql: Sql, migrations: readonly SqlMigration[], now: number): number[] {
	sql.script("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
	const applied = new Set(sql.exec<{ id: number }>("SELECT id FROM _migrations").map((row) => row.id));
	const done: number[] = [];
	for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
		if (applied.has(migration.id)) continue;
		sql.transaction(() => {
			sql.script(migration.sql);
			sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", migration.id, now);
		});
		done.push(migration.id);
	}
	return done;
}
