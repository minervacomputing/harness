// The Sandbox Durable Object's SQLite (store.ts): its one row of durable state. Additive only; see
// lib/sqlite.ts.

/** lib/sqlite.ts `Migration`, written out so the account tests (Node) can read the ids without the Worker's types. */
interface Migration {
	id: number;
	sql: string;
}

export const SANDBOX_MIGRATIONS: Migration[] = [
	{
		id: 1,
		sql: `CREATE TABLE sandbox_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			state TEXT NOT NULL CHECK (state IN ('none', 'starting', 'hardening', 'verified', 'in_use', 'destroying')),
			incarnation TEXT,
			run_id TEXT,
			attempt INTEGER,
			spec TEXT,
			hardened INTEGER NOT NULL DEFAULT 0,
			started_at INTEGER,
			verified_at INTEGER,
			cleanup_pending INTEGER NOT NULL DEFAULT 0,
			cleanup_reason TEXT,
			lease_until INTEGER,
			updated_at INTEGER NOT NULL
		) STRICT`,
	},
];
