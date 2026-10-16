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
	{
		// One span per container incarnation, opened and closed with the state row (store.ts writeState); the
		// runs whose starts are refused; and when spans began to be kept: 0 for an object that never wrote its
		// state before, else the last time an older version did, since that version kept no spans.
		id: 2,
		sql: `CREATE TABLE container_spans (
			incarnation TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			attempt INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			lease_until INTEGER NOT NULL,
			ended_at INTEGER,
			ended TEXT CHECK (ended IN ('destroyed', 'gone')),
			CHECK ((ended_at IS NULL) = (ended IS NULL))
		) STRICT;
		CREATE INDEX container_spans_run ON container_spans (run_id);
		CREATE TABLE sealed_runs (
			run_id TEXT PRIMARY KEY,
			sealed_at INTEGER NOT NULL
		) STRICT;
		CREATE TABLE spans_since (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			at INTEGER NOT NULL
		) STRICT;
		INSERT INTO spans_since (id, at) SELECT 1, COALESCE(MAX(updated_at), 0) FROM sandbox_state`,
	},
];
